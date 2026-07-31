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
  renameSync,
  writeFileSync,
  type BigIntStats,
  type Stats,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const COORDINATION_DIRECTORY_NAME = '.takt-repertoire-coordination';
const READERS_DIRECTORY_NAME = 'readers';
const RELEASED_DIRECTORY_NAME = 'released';
const WRITER_INTENT_FILENAME = 'writer.intent';
const LEASE_VERSION = 1;
const MAX_LEASE_BYTES = 4_096;
const MAX_READER_CLAIMS = 4_096;
const TOMBSTONE_SOFT_LIMIT = 2_048;
const TOMBSTONE_HARD_LIMIT = 4_096;
const RETRY_DELAY_MS = 10;
const MAX_SNAPSHOT_ATTEMPTS = 8;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`);
const READER_FILENAME_PATTERN = new RegExp(`^(\\d+)\\.(${UUID_PATTERN})\\.lease$`);
const RELEASED_FILENAME_PATTERN = new RegExp(
  `^(\\d+)\\.(${UUID_PATTERN})\\.(read|write)\\.released$`,
);

// Filesystem coordination is security-sensitive and may run beside plugins.
// Capture security-critical mutable intrinsics before post-initialization
// monkey-patching can redirect validation or leak filesystem details.
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeArrayIsArray = Array.isArray.bind(Array);
const safeArraySortMethod = Array.prototype.sort;
const safeArraySort = <T>(value: T[]): T[] => (
  safeReflectApply(safeArraySortMethod, value, []) as T[]
);
const safeBufferAlloc = Buffer.alloc.bind(Buffer);
const safeDateNow = Date.now.bind(Date);
const SafeDate = Date;
const safeJsonParse = JSON.parse.bind(JSON);
const safeJsonStringify = JSON.stringify.bind(JSON);
const safeObjectDefineProperty = Object.defineProperty.bind(Object);
const safeObjectFreeze = Object.freeze.bind(Object);
const safeObjectKeys = Object.keys.bind(Object);
const safeRegExpExecMethod = RegExp.prototype.exec;
const safeRegExpExec = (
  expression: RegExp,
  value: string,
): RegExpExecArray | null => safeReflectApply(safeRegExpExecMethod, expression, [value]);
const safeRegExpTestMethod = RegExp.prototype.test;
const safeRegExpTest = (
  expression: RegExp,
  value: string,
): boolean => safeReflectApply(safeRegExpTestMethod, expression, [value]);
const safeGetUid = typeof process.getuid === 'function'
  ? process.getuid.bind(process)
  : undefined;

export const REPERTOIRE_COORDINATION_LOCK_ORDER = safeObjectFreeze([
  'global-repertoire',
  'project-template',
] as const);

export type RepertoireCoordinationMode = 'read' | 'write';

export type RepertoireCoordinationErrorCode =
  | 'ABORTED'
  | 'MAINTENANCE_REQUIRED'
  | 'RECOVERY_REQUIRED'
  | 'TIMEOUT'
  | 'UNSAFE_STATE'
  | 'WRITER_PENDING';

export class RepertoireCoordinationError extends Error {
  readonly code: RepertoireCoordinationErrorCode;

  constructor(code: RepertoireCoordinationErrorCode) {
    super(messageForCode(code));
    safeObjectDefineProperty(this, 'name', {
      configurable: true,
      value: 'RepertoireCoordinationError',
    });
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

type FileIdentity = {
  dev: number;
  ino: number;
};

type LeaseEvidence = {
  record: LeaseRecord;
  identity: FileIdentity;
  digest: string;
};

type CoordinationPaths = {
  root: string;
  readers: string;
  released: string;
  writerIntent: string;
};

type CoordinationSnapshot = {
  digest: string;
  readers: LeaseEvidence[];
  writer: LeaseEvidence | undefined;
  releasedCount: number;
};

const SNAPSHOT_CHANGED = Symbol('repertoire-coordination-snapshot-changed');

/**
 * Acquires a process-wide lease for the global repertoire.
 *
 * The filesystem is the arbitration authority because TaktDesk instances can
 * run in unrelated processes. Dead or old-looking claims and release
 * tombstones are deliberately never reclaimed here: PID reuse, clock drift,
 * and check-then-delete races make automatic recovery unsafe.
 */
export async function acquireRepertoireCoordinationLease(
  options: AcquireRepertoireCoordinationLeaseOptions,
): Promise<RepertoireCoordinationLease> {
  try {
    validateOptions(options);
    throwIfAborted(options.signal);
    const paths = prepareCoordinationPaths(options.globalConfigDir);
    const deadline = safeDateNow() + (options.timeoutMs ?? 5_000);
    const initial = scanStableState(paths);
    enforceTombstoneLimits(initial.releasedCount, options.mode);

    return options.mode === 'read'
      ? acquireReadLease(paths, options.signal)
      : await acquireWriteLease(paths, deadline, options.signal);
  } catch (error) {
    throw normalizeCoordinationError(error);
  }
}

function acquireReadLease(
  paths: CoordinationPaths,
  signal: AbortSignal | undefined,
): RepertoireCoordinationLease {
  const before = scanStableState(paths);
  enforceTombstoneLimits(before.releasedCount, 'read');
  if (before.writer !== undefined) {
    throw new RepertoireCoordinationError('WRITER_PENDING');
  }

  throwIfAborted(signal);
  const record = createLeaseRecord('read');
  const claimPath = join(paths.readers, `${record.pid}.${record.token}.lease`);
  const identity = createLeaseFile(claimPath, record, paths.readers);

  try {
    throwIfAborted(signal);
    const after = scanStableState(paths);
    enforceTombstoneLimits(after.releasedCount, 'read');
    assertPublishedLease(after.readers, record, identity);
    if (after.writer !== undefined) {
      releaseOwnedLease(paths, claimPath, record, identity, paths.readers);
      throw new RepertoireCoordinationError('WRITER_PENDING');
    }
  } catch (error) {
    retireAfterFailedAcquire(paths, claimPath, record, identity, paths.readers);
    throw error;
  }

  return leaseHandle(paths, 'read', claimPath, record, identity, paths.readers);
}

async function acquireWriteLease(
  paths: CoordinationPaths,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<RepertoireCoordinationLease> {
  const record = createLeaseRecord('write');
  let identity: FileIdentity;

  while (true) {
    throwIfAborted(signal);
    const state = scanStableState(paths);
    enforceTombstoneLimits(state.releasedCount, 'write');
    try {
      identity = createLeaseFile(paths.writerIntent, record, paths.root);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      await waitForRetry(deadline, signal);
    }
  }

  try {
    while (true) {
      const state = scanStableState(paths);
      enforceTombstoneLimits(state.releasedCount, 'write');
      assertPublishedLease(
        state.writer === undefined ? [] : [state.writer],
        record,
        identity,
      );
      if (state.readers.length === 0) break;
      await waitForRetry(deadline, signal);
    }
  } catch (error) {
    retireAfterFailedAcquire(paths, paths.writerIntent, record, identity, paths.root);
    throw error;
  }

  return leaseHandle(paths, 'write', paths.writerIntent, record, identity, paths.root);
}

function leaseHandle(
  paths: CoordinationPaths,
  mode: RepertoireCoordinationMode,
  path: string,
  record: LeaseRecord,
  identity: FileIdentity,
  parentDirectory: string,
): RepertoireCoordinationLease {
  let released = false;
  return safeObjectFreeze({
    mode,
    release(): void {
      if (released) return;
      try {
        releaseOwnedLease(paths, path, record, identity, parentDirectory);
        released = true;
      } catch (error) {
        throw normalizeCoordinationError(error);
      }
    },
  });
}

function prepareCoordinationPaths(globalConfigDir: string): CoordinationPaths {
  assertPrivateDirectory(globalConfigDir);
  const root = join(globalConfigDir, COORDINATION_DIRECTORY_NAME);
  const readers = join(root, READERS_DIRECTORY_NAME);
  const released = join(root, RELEASED_DIRECTORY_NAME);
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(readers);
  ensurePrivateDirectory(released);
  const paths = {
    root,
    readers,
    released,
    writerIntent: join(root, WRITER_INTENT_FILENAME),
  };
  assertCoordinationDirectories(paths);
  return paths;
}

function assertCoordinationDirectories(paths: CoordinationPaths): void {
  assertPrivateDirectory(paths.root);
  assertPrivateDirectory(paths.readers);
  assertPrivateDirectory(paths.released);
}

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
    enforcePrivateDirectoryMode(path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  assertPrivateDirectory(path);
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
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
    createdAt: new SafeDate(safeDateNow()).toISOString(),
  };
}

function createLeaseFile(
  path: string,
  record: LeaseRecord,
  parentDirectory: string,
): FileIdentity {
  assertPrivateDirectory(parentDirectory);
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    fchmodSync(fd, PRIVATE_FILE_MODE);
    writeFileSync(fd, `${safeJsonStringify(record)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  syncDirectory(parentDirectory);
  const published = readExactPrivateLease(path, record.mode);
  assertSameOwner(published.record, record);
  return published.identity;
}

function readExactPrivateLease(
  path: string,
  expectedMode: RepertoireCoordinationMode,
): LeaseEvidence {
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
    const record = parseLeaseRecord(raw, expectedMode);
    const identity = { dev: opened.dev, ino: opened.ino };
    return { record, identity, digest: `${fileIdentityDigest(opened)}:${raw}` };
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
    value = safeJsonParse(raw);
  } catch {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  if (!isRecord(value)) throw new RepertoireCoordinationError('UNSAFE_STATE');

  const keys = safeArraySort(safeObjectKeys(value));
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
    || !safeRegExpTest(UUID_REGEX, token)
    || (uid !== null && (!Number.isSafeInteger(uid) || (uid as number) < 0))
    || uid !== currentUid()
    || typeof createdAt !== 'string'
    || !isCanonicalTimestamp(createdAt)
  ) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }

  return value as LeaseRecord;
}

function scanStableState(paths: CoordinationPaths): CoordinationSnapshot {
  let previous: CoordinationSnapshot | undefined;
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const current = scanStateOnce(paths);
      if (previous?.digest === current.digest) return current;
      previous = current;
    } catch (error) {
      if (error !== SNAPSHOT_CHANGED) throw error;
      previous = undefined;
    }
  }
  throw new RepertoireCoordinationError('UNSAFE_STATE');
}

function scanStateOnce(paths: CoordinationPaths): CoordinationSnapshot {
  const rootBefore = readDirectoryIdentity(paths.root);
  const rootEntries = sortedDirectoryEntries(paths.root);
  for (const entry of rootEntries) {
    if (
      entry !== READERS_DIRECTORY_NAME
      && entry !== RELEASED_DIRECTORY_NAME
      && entry !== WRITER_INTENT_FILENAME
    ) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
  }
  if (!rootEntries.includes(READERS_DIRECTORY_NAME) || !rootEntries.includes(RELEASED_DIRECTORY_NAME)) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }

  const readers = scanReaders(paths.readers);
  const released = scanReleased(paths.released);
  const writer = rootEntries.includes(WRITER_INTENT_FILENAME)
    ? readListedLease(paths.writerIntent, 'write')
    : undefined;
  const rootAfter = readDirectoryIdentity(paths.root);
  if (rootBefore !== rootAfter) throw SNAPSHOT_CHANGED;

  const digest = [
    rootBefore,
    rootEntries.join(','),
    readers.digest,
    released.digest,
    writer?.digest ?? '-',
  ].join('|');
  return {
    digest,
    readers: readers.evidence,
    writer,
    releasedCount: released.count,
  };
}

function scanReaders(directory: string): { digest: string; evidence: LeaseEvidence[] } {
  const before = readDirectoryIdentity(directory);
  const entries = sortedDirectoryEntries(directory);
  if (entries.length > MAX_READER_CLAIMS) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  const evidence: LeaseEvidence[] = [];
  const digests: string[] = [];
  for (const filename of entries) {
    const match = safeRegExpExec(READER_FILENAME_PATTERN, filename);
    if (!match) throw new RepertoireCoordinationError('UNSAFE_STATE');
    const lease = readListedLease(join(directory, filename), 'read');
    if (`${lease.record.pid}` !== match[1] || lease.record.token !== match[2]) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
    evidence.push(lease);
    digests.push(`${filename}:${lease.digest}`);
  }
  const after = readDirectoryIdentity(directory);
  if (before !== after) throw SNAPSHOT_CHANGED;
  return { digest: `${before}:${digests.join(',')}`, evidence };
}

function scanReleased(directory: string): { digest: string; count: number } {
  const before = readDirectoryIdentity(directory);
  const entries = sortedDirectoryEntries(directory);
  const digests: string[] = [];
  for (const filename of entries) {
    const match = safeRegExpExec(RELEASED_FILENAME_PATTERN, filename);
    if (!match) throw new RepertoireCoordinationError('UNSAFE_STATE');
    const mode = match[3] as RepertoireCoordinationMode;
    const lease = readListedLease(join(directory, filename), mode);
    if (`${lease.record.pid}` !== match[1] || lease.record.token !== match[2]) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
    digests.push(`${filename}:${lease.digest}`);
  }
  const after = readDirectoryIdentity(directory);
  if (before !== after) throw SNAPSHOT_CHANGED;
  return { digest: `${before}:${digests.join(',')}`, count: entries.length };
}

function readListedLease(path: string, mode: RepertoireCoordinationMode): LeaseEvidence {
  try {
    return readExactPrivateLease(path, mode);
  } catch (error) {
    if (isMissingError(error)) throw SNAPSHOT_CHANGED;
    throw error;
  }
}

function sortedDirectoryEntries(path: string): string[] {
  return safeArraySort(readdirSync(path));
}

function readDirectoryIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  assertPrivateBigIntDirectory(stat);
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

function assertPrivateBigIntDirectory(stat: BigIntStats): void {
  const expectedUid = currentUid();
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777n) !== BigInt(PRIVATE_DIRECTORY_MODE)
    || (expectedUid !== null && stat.uid !== BigInt(expectedUid))
  ) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
}

function assertPublishedLease(
  leases: LeaseEvidence[],
  record: LeaseRecord,
  identity: FileIdentity,
): void {
  const own = leases.find((lease) => sameOwnerAndIdentity(lease, record, identity));
  if (own === undefined) throw new RepertoireCoordinationError('UNSAFE_STATE');
}

function retireAfterFailedAcquire(
  paths: CoordinationPaths,
  path: string,
  record: LeaseRecord,
  identity: FileIdentity,
  parentDirectory: string,
): void {
  try {
    releaseOwnedLease(paths, path, record, identity, parentDirectory);
  } catch {
    // The original acquisition failure is already fail-closed. A failed
    // retirement must not replace it with lower-fidelity filesystem details.
  }
}

function releaseOwnedLease(
  paths: CoordinationPaths,
  path: string,
  expected: LeaseRecord,
  identity: FileIdentity,
  parentDirectory: string,
): void {
  const releasedPath = join(
    paths.released,
    `${expected.pid}.${expected.token}.${expected.mode}.released`,
  );
  // rename is the release linearization point. There is intentionally no
  // ownership check before it: a check-then-unlink sequence can delete a
  // foreign claim installed between those operations.
  renameSync(path, releasedPath);
  syncDirectory(parentDirectory);
  if (parentDirectory !== paths.released) syncDirectory(paths.released);

  const released = readExactPrivateLease(releasedPath, expected.mode);
  if (!sameOwnerAndIdentity(released, expected, identity)) {
    // A mismatching tombstone is permanent evidence of an unsafe race. Never
    // delete it here; all future acquisitions will fail closed while scanning.
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
}

function sameOwnerAndIdentity(
  evidence: LeaseEvidence,
  expected: LeaseRecord,
  identity: FileIdentity,
): boolean {
  return evidence.identity.dev === identity.dev
    && evidence.identity.ino === identity.ino
    && sameOwner(evidence.record, expected);
}

function assertSameOwner(actual: LeaseRecord, expected: LeaseRecord): void {
  if (!sameOwner(actual, expected)) throw new RepertoireCoordinationError('UNSAFE_STATE');
}

function sameOwner(actual: LeaseRecord, expected: LeaseRecord): boolean {
  return actual.mode === expected.mode
    && actual.token === expected.token
    && actual.pid === expected.pid
    && actual.uid === expected.uid
    && actual.createdAt === expected.createdAt;
}

function enforceTombstoneLimits(
  count: number,
  mode: RepertoireCoordinationMode,
): void {
  if (count > TOMBSTONE_HARD_LIMIT) {
    throw new RepertoireCoordinationError('RECOVERY_REQUIRED');
  }
  if (mode === 'read' && count >= TOMBSTONE_SOFT_LIMIT) {
    throw new RepertoireCoordinationError('MAINTENANCE_REQUIRED');
  }
}

function readStableBoundedFile(fd: number, opened: Stats, path: string): string {
  const buffer = safeBufferAlloc(Number(opened.size) + 1);
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

function fileIdentityDigest(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.mtimeMs, stat.ctimeMs].join(':');
}

async function waitForRetry(deadline: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  const remaining = deadline - safeDateNow();
  if (remaining <= 0) throw new RepertoireCoordinationError('TIMEOUT');
  try {
    await delay(Math.min(RETRY_DELAY_MS, remaining), undefined, { signal });
  } catch {
    if (signal?.aborted) throw new RepertoireCoordinationError('ABORTED');
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  throwIfAborted(signal);
  if (safeDateNow() >= deadline) throw new RepertoireCoordinationError('TIMEOUT');
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function enforcePrivateDirectoryMode(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fchmodSync(fd, PRIVATE_DIRECTORY_MODE);
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
  return safeGetUid?.() ?? null;
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new SafeDate(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !safeArrayIsArray(value);
}

function isAlreadyExistsError(error: unknown): boolean {
  return errnoCode(error) === 'EEXIST';
}

function isMissingError(error: unknown): boolean {
  return errnoCode(error) === 'ENOENT';
}

function errnoCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    return (error as { code?: unknown }).code;
  } catch {
    return undefined;
  }
}

function normalizeCoordinationError(error: unknown): RepertoireCoordinationError {
  return error instanceof RepertoireCoordinationError
    ? error
    : new RepertoireCoordinationError('UNSAFE_STATE');
}

function messageForCode(code: RepertoireCoordinationErrorCode): string {
  switch (code) {
    case 'ABORTED':
      return 'repertoire coordination was aborted';
    case 'MAINTENANCE_REQUIRED':
      return 'repertoire coordination maintenance is required before new readers can acquire';
    case 'RECOVERY_REQUIRED':
      return 'repertoire coordination requires operator recovery before acquisition can continue';
    case 'TIMEOUT':
      return 'repertoire coordination timed out';
    case 'UNSAFE_STATE':
      return 'repertoire coordination state cannot be proven safe';
    case 'WRITER_PENDING':
      return 'repertoire writer intent is pending';
  }
}
