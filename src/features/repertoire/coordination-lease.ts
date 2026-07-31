import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const COORDINATION_DIRECTORY_NAME = '.takt-repertoire-coordination';
const READERS_DIRECTORY_NAME = 'readers';
const WRITER_INTENT_FILENAME = 'writer.intent';
const LEASE_VERSION = 1;
const MAX_LEASE_BYTES = 4_096;
const MAX_READER_CLAIMS = 4_096;
const RETRY_DELAY_MS = 10;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`);
const READER_FILENAME_PATTERN = new RegExp(`^(\\d+)\\.(${UUID_PATTERN})\\.lease$`);

export const REPERTOIRE_COORDINATION_LOCK_ORDER = Object.freeze([
  'global-repertoire',
  'project-template',
] as const);

export type RepertoireCoordinationMode = 'read' | 'write';

export type RepertoireCoordinationErrorCode =
  | 'ABORTED'
  | 'TIMEOUT'
  | 'UNSAFE_STATE'
  | 'WRITER_PENDING';

export class RepertoireCoordinationError extends Error {
  readonly code: RepertoireCoordinationErrorCode;

  constructor(code: RepertoireCoordinationErrorCode, cause?: unknown) {
    super(messageForCode(code), { cause });
    this.name = 'RepertoireCoordinationError';
    this.code = code;
  }
}

export type RepertoireCoordinationLease = {
  readonly mode: RepertoireCoordinationMode;
  release(): void;
};

export type AcquireRepertoireCoordinationLeaseOptions = {
  globalConfigDir: string;
  mode: RepertoireCoordinationMode;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type LeaseRecord = {
  version: 1;
  mode: RepertoireCoordinationMode;
  token: string;
  pid: number;
  uid: number | null;
  createdAt: string;
};

type CoordinationPaths = {
  root: string;
  readers: string;
  writerIntent: string;
};

/**
 * Acquires a process-wide lease for the global repertoire.
 *
 * The filesystem is the arbitration authority because TaktDesk instances can
 * run in unrelated processes. Dead or old-looking claims are deliberately not
 * reclaimed here: PID reuse and clock drift make automatic recovery unsafe.
 */
export async function acquireRepertoireCoordinationLease(
  options: AcquireRepertoireCoordinationLeaseOptions,
): Promise<RepertoireCoordinationLease> {
  validateOptions(options);
  throwIfAborted(options.signal);
  const paths = prepareCoordinationPaths(options.globalConfigDir);
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);

  return options.mode === 'read'
    ? acquireReadLease(paths, options.signal)
    : acquireWriteLease(paths, deadline, options.signal);
}

function acquireReadLease(
  paths: CoordinationPaths,
  signal: AbortSignal | undefined,
): RepertoireCoordinationLease {
  listReaderClaims(paths);
  // A first check avoids needless claims in the common writer-present case.
  // The second check after O_EXCL publication closes the reader/writer race.
  if (inspectLease(paths.writerIntent, 'write') !== undefined) {
    throw new RepertoireCoordinationError('WRITER_PENDING');
  }

  throwIfAborted(signal);
  const record = createLeaseRecord('read');
  const claimPath = join(paths.readers, `${record.pid}.${record.token}.lease`);
  createLeaseFile(claimPath, record, paths.readers);

  try {
    throwIfAborted(signal);
    if (inspectLease(paths.writerIntent, 'write') !== undefined) {
      releaseOwnedLease(claimPath, record, paths.readers);
      throw new RepertoireCoordinationError('WRITER_PENDING');
    }
  } catch (error) {
    if (isOwnedLease(claimPath, record)) {
      releaseOwnedLease(claimPath, record, paths.readers);
    }
    throw error;
  }

  return leaseHandle('read', claimPath, record, paths.readers);
}

async function acquireWriteLease(
  paths: CoordinationPaths,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<RepertoireCoordinationLease> {
  const record = createLeaseRecord('write');

  while (true) {
    throwIfAborted(signal);
    assertCoordinationDirectories(paths);
    try {
      createLeaseFile(paths.writerIntent, record, paths.root);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw asUnsafeState(error);
      // Existing intent is never stolen, even when its owner appears dead.
      // An exact safe read distinguishes ordinary contention from corruption.
      if (inspectLease(paths.writerIntent, 'write') === undefined) continue;
      await waitForRetry(deadline, signal);
    }
  }

  try {
    while (listReaderClaims(paths).length > 0) {
      await waitForRetry(deadline, signal);
    }
  } catch (error) {
    releaseOwnedLease(paths.writerIntent, record, paths.root);
    throw error;
  }

  return leaseHandle('write', paths.writerIntent, record, paths.root);
}

function leaseHandle(
  mode: RepertoireCoordinationMode,
  path: string,
  record: LeaseRecord,
  parentDirectory: string,
): RepertoireCoordinationLease {
  let released = false;
  return Object.freeze({
    mode,
    release(): void {
      if (released) return;
      releaseOwnedLease(path, record, parentDirectory);
      released = true;
    },
  });
}

function prepareCoordinationPaths(globalConfigDir: string): CoordinationPaths {
  assertPrivateDirectory(globalConfigDir);
  const root = join(globalConfigDir, COORDINATION_DIRECTORY_NAME);
  const readers = join(root, READERS_DIRECTORY_NAME);
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(readers);
  const paths = { root, readers, writerIntent: join(root, WRITER_INTENT_FILENAME) };
  assertCoordinationDirectories(paths);
  return paths;
}

function assertCoordinationDirectories(paths: CoordinationPaths): void {
  assertPrivateDirectory(paths.root);
  assertPrivateDirectory(paths.readers);
  assertControlRootEntries(paths);
}

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
    enforcePrivateDirectoryMode(path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw asUnsafeState(error);
  }
  assertPrivateDirectory(path);
}

function assertPrivateDirectory(path: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw asUnsafeState(error);
  }
  const expectedUid = currentUid();
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    || (expectedUid !== null && stat.uid !== expectedUid)
  ) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
}

function createLeaseRecord(mode: RepertoireCoordinationMode): LeaseRecord {
  return {
    version: LEASE_VERSION,
    mode,
    token: randomUUID(),
    pid: process.pid,
    uid: currentUid(),
    createdAt: new Date().toISOString(),
  };
}

function createLeaseFile(path: string, record: LeaseRecord, parentDirectory: string): void {
  assertPrivateDirectory(parentDirectory);
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    // fchmod makes the contract independent of a caller's unusually strict
    // umask while the O_EXCL descriptor prevents exposing a wider mode first.
    fchmodSync(fd, PRIVATE_FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  syncDirectory(parentDirectory);
  const published = readExactPrivateLease(path, record.mode);
  if (
    published.token !== record.token
    || published.pid !== record.pid
    || published.uid !== record.uid
  ) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
}

function inspectLease(
  path: string,
  expectedMode: RepertoireCoordinationMode,
): LeaseRecord | undefined {
  try {
    return readExactPrivateLease(path, expectedMode);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw asUnsafeState(error);
  }
}

function readExactPrivateLease(
  path: string,
  expectedMode: RepertoireCoordinationMode,
): LeaseRecord {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const after = lstatSync(path);
    assertSamePrivateFile(before, opened, after);
    if (opened.size <= 0 || opened.size > MAX_LEASE_BYTES) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
    const raw = readStableBoundedFile(fd, opened, path);
    return parseLeaseRecord(raw, expectedMode);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertSamePrivateFile(before: Stats, opened: Stats, after: Stats): void {
  const expectedUid = currentUid();
  if (
    !before.isFile()
    || !opened.isFile()
    || !after.isFile()
    || before.isSymbolicLink()
    || after.isSymbolicLink()
    || before.dev !== opened.dev
    || before.ino !== opened.ino
    || after.dev !== opened.dev
    || after.ino !== opened.ino
    || opened.nlink !== 1
    || (opened.mode & 0o777) !== PRIVATE_FILE_MODE
    || (expectedUid !== null && opened.uid !== expectedUid)
  ) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
}

function parseLeaseRecord(raw: string, expectedMode: RepertoireCoordinationMode): LeaseRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new RepertoireCoordinationError('UNSAFE_STATE', error);
  }
  if (!isRecord(value)) throw new RepertoireCoordinationError('UNSAFE_STATE');

  const keys = Object.keys(value).sort();
  const expectedKeys = ['createdAt', 'mode', 'pid', 'token', 'uid', 'version'];
  const createdAt = value['createdAt'];
  const token = value['token'];
  const uid = value['uid'];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || value['version'] !== LEASE_VERSION
    || value['mode'] !== expectedMode
    || !Number.isSafeInteger(value['pid'])
    || (value['pid'] as number) <= 0
    || typeof token !== 'string'
    || !UUID_REGEX.test(token)
    || (uid !== null && (!Number.isSafeInteger(uid) || (uid as number) < 0))
    || uid !== currentUid()
    || typeof createdAt !== 'string'
    || !isCanonicalTimestamp(createdAt)
  ) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }

  return value as LeaseRecord;
}

function listReaderClaims(paths: CoordinationPaths): LeaseRecord[] {
  assertCoordinationDirectories(paths);
  let before: Stats;
  let after: Stats;
  let entries: string[];
  try {
    before = lstatSync(paths.readers);
    entries = readdirSync(paths.readers);
    after = lstatSync(paths.readers);
  } catch (error) {
    throw asUnsafeState(error);
  }
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  if (entries.length > MAX_READER_CLAIMS) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }

  const claims: LeaseRecord[] = [];
  for (const filename of entries) {
    const match = READER_FILENAME_PATTERN.exec(filename);
    if (!match) throw new RepertoireCoordinationError('UNSAFE_STATE');
    // A reader can release after readdir. Missing is an ordinary completed
    // lease; every artifact that still exists must pass the exact safe read.
    const record = inspectLease(join(paths.readers, filename), 'read');
    if (!record) continue;
    if (`${record.pid}` !== match[1] || record.token !== match[2]) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
    claims.push(record);
  }
  return claims;
}

function assertControlRootEntries(paths: CoordinationPaths): void {
  let entries: string[];
  let before: Stats;
  let after: Stats;
  try {
    before = lstatSync(paths.root);
    entries = readdirSync(paths.root);
    after = lstatSync(paths.root);
  } catch (error) {
    throw asUnsafeState(error);
  }
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  for (const entry of entries) {
    if (entry !== READERS_DIRECTORY_NAME && entry !== WRITER_INTENT_FILENAME) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
  }
}

function readStableBoundedFile(fd: number, opened: Stats, path: string): string {
  const buffer = Buffer.alloc(Number(opened.size) + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const final = fstatSync(fd);
  const pathAfterRead = lstatSync(path);
  if (
    offset !== opened.size
    || final.size !== opened.size
    || final.dev !== opened.dev
    || final.ino !== opened.ino
    || final.mtimeMs !== opened.mtimeMs
    || final.ctimeMs !== opened.ctimeMs
    || pathAfterRead.dev !== opened.dev
    || pathAfterRead.ino !== opened.ino
  ) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  return buffer.subarray(0, offset).toString('utf8');
}

function isOwnedLease(path: string, expected: LeaseRecord): boolean {
  try {
    const actual = readExactPrivateLease(path, expected.mode);
    return actual.token === expected.token
      && actual.pid === expected.pid
      && actual.uid === expected.uid;
  } catch (error) {
    if (isMissingError(error)) return false;
    throw asUnsafeState(error);
  }
}

function releaseOwnedLease(path: string, expected: LeaseRecord, parentDirectory: string): void {
  if (!isOwnedLease(path, expected)) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  try {
    unlinkSync(path);
    syncDirectory(parentDirectory);
  } catch (error) {
    throw asUnsafeState(error);
  }
}

async function waitForRetry(deadline: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new RepertoireCoordinationError('TIMEOUT');
  try {
    await delay(Math.min(RETRY_DELAY_MS, remaining), undefined, { signal });
  } catch (error) {
    if (signal?.aborted) throw new RepertoireCoordinationError('ABORTED', error);
    throw error;
  }
  throwIfAborted(signal);
  if (Date.now() >= deadline) throw new RepertoireCoordinationError('TIMEOUT');
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(fd);
  } catch (error) {
    throw asUnsafeState(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function enforcePrivateDirectoryMode(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fchmodSync(fd, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    throw asUnsafeState(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function validateOptions(options: AcquireRepertoireCoordinationLeaseOptions): void {
  if (!isAbsolute(options.globalConfigDir)) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  if (options.mode !== 'read' && options.mode !== 'write') {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  if (
    options.timeoutMs !== undefined
    && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
  ) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RepertoireCoordinationError('ABORTED');
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAlreadyExistsError(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'EEXIST';
}

function isMissingError(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT';
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function asUnsafeState(error: unknown): RepertoireCoordinationError {
  return error instanceof RepertoireCoordinationError
    ? error
    : new RepertoireCoordinationError('UNSAFE_STATE', error);
}

function messageForCode(code: RepertoireCoordinationErrorCode): string {
  switch (code) {
    case 'ABORTED':
      return 'repertoire coordination was aborted';
    case 'TIMEOUT':
      return 'repertoire coordination timed out';
    case 'UNSAFE_STATE':
      return 'repertoire coordination state cannot be proven safe';
    case 'WRITER_PENDING':
      return 'repertoire writer intent is pending';
  }
}
