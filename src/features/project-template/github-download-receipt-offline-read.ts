import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { types } from 'node:util';
import { inspectTaktpack } from './archive-inspector.js';
import {
  DEFAULT_TAKTPACK_LIMITS,
  type DeepReadonly,
  type TaktpackInspectResult,
} from './archive-types.js';
import {
  isProjectTemplatePrivateDirectoryMode,
  isProjectTemplatePrivateFileMode,
} from './control-root-contract.js';
import { TaktpackError } from './errors.js';
import {
  requireGithubTemplateDownloadReceiptArtifactBinding,
  snapshotGithubTemplateDownloadReceiptInspection,
} from './github-download-receipt-artifact-binding.js';
import {
  deriveGithubTemplateDownloadArtifactPaths,
  deriveGithubTemplateDownloadReceiptLocatorPaths,
} from './github-download-receipt-paths.js';
import {
  claimStoredGithubTemplateDownloadReceiptForOfflineRead,
  consumeStoredGithubTemplateDownloadReceiptOfflineReadClaim,
  type ClaimedStoredGithubTemplateDownloadReceipt,
  type GithubTemplateDownloadReceiptVerifier,
  type StoredGithubTemplateDownloadReceipt,
} from './github-download-receipt-storage.js';
import {
  calculateGithubTemplateDownloadReceiptKey,
  createGithubTemplateDownloadReceiptAuthenticationInput,
  MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES,
  parseGithubTemplateDownloadReceipt,
  type GithubTemplateDownloadReceiptV1,
} from './github-download-receipt.js';

const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const DIRECTORY_FLAG = process.platform === 'win32' ? 0 : constants.O_DIRECTORY;
const HASH_BUFFER_BYTES = 64 * 1024;
const VERIFIED_RECEIPT_APPLY_CLAIM_BRAND: unique symbol =
  Symbol('verified-github-template-download-receipt-apply-claim');

export type GithubTemplateDownloadReceiptOfflineReadErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_AUTHORITY'
  | 'RECEIPT_MISSING'
  | 'RECEIPT_INVALID'
  | 'AUTHENTICATION_FAILED'
  | 'KEY_UNAVAILABLE'
  | 'CACHE_MISSING'
  | 'CACHE_INVALID'
  | 'LIMIT_EXCEEDED'
  | 'IO_FAILURE';

export class GithubTemplateDownloadReceiptOfflineReadError extends Error {
  constructor(
    public readonly code: GithubTemplateDownloadReceiptOfflineReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GithubTemplateDownloadReceiptOfflineReadError';
  }
}

export type GithubTemplateDownloadReceiptOfflineReadPhase =
  | 'before-receipt-read'
  | 'before-receipt-authentication'
  | 'before-artifact-open'
  | 'before-artifact-inspect'
  | 'before-final-preflight';

export interface GithubTemplateDownloadReceiptOfflineReadIo {
  onPhase?(
    phase: GithubTemplateDownloadReceiptOfflineReadPhase,
    path: string,
  ): void;
  read?(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  close?(
    fd: number,
    kind: 'artifact' | 'receipt' | 'directory',
  ): void;
}

export interface ReadGithubTemplateDownloadReceiptByReceiptKeyOptions {
  readonly cacheRoot: string;
  readonly receiptKey: string;
  readonly verifier: GithubTemplateDownloadReceiptVerifier;
  readonly io?: GithubTemplateDownloadReceiptOfflineReadIo;
}

export interface ReadGithubTemplateDownloadReceiptStoredOptions {
  readonly cacheRoot: string;
  readonly stored: StoredGithubTemplateDownloadReceipt;
  readonly verifier: GithubTemplateDownloadReceiptVerifier;
  readonly io?: GithubTemplateDownloadReceiptOfflineReadIo;
}

/**
 * Deep-frozen verification evidence, not a live file authority, approval, or
 * lock. The apply bridge trusts only the process-local WeakMap identity.
 */
export interface VerifiedGithubTemplateDownloadReceipt {
  readonly receiptKey: string;
  readonly artifactSha256: string;
  readonly bytes: number;
  readonly receipt: GithubTemplateDownloadReceiptV1;
  readonly inspection: DeepReadonly<TaktpackInspectResult>;
}

export interface ClaimedVerifiedGithubTemplateDownloadReceiptForApply {
  readonly verified: VerifiedGithubTemplateDownloadReceipt;
  readonly [VERIFIED_RECEIPT_APPLY_CLAIM_BRAND]: true;
}

interface VerifierSnapshot {
  readonly receiver: object;
  readonly verify: GithubTemplateDownloadReceiptVerifier['verify'];
}

interface IoSnapshot {
  readonly receiver: object;
  readonly onPhase?: GithubTemplateDownloadReceiptOfflineReadIo['onPhase'];
  readonly read?: GithubTemplateDownloadReceiptOfflineReadIo['read'];
  readonly close?: GithubTemplateDownloadReceiptOfflineReadIo['close'];
}

interface DirectoryAuthority {
  readonly path: string;
  readonly fd: number;
  readonly device: number;
  readonly inode: number;
}

interface FileAuthority {
  readonly path: string;
  readonly fd: number;
  readonly device: number;
  readonly inode: number;
  readonly bytes: number;
}

interface ReadContext {
  readonly directories: DirectoryAuthority[];
  receipt?: FileAuthority;
  artifact?: FileAuthority;
}

interface ExpectedStored {
  readonly receiptKey: string;
  readonly artifactSha256: string;
  readonly bytes: number;
  readonly status: 'stored' | 'existing';
}

interface CoreOptions {
  readonly cacheRoot: string;
  readonly receiptKey: string;
  readonly verifier: VerifierSnapshot;
  readonly io?: IoSnapshot;
  readonly expectedStored?: ExpectedStored;
}

interface ApplyAuthority {
  readonly cacheRoot: string;
  readonly receiptKey: string;
  readonly artifactSha256: string;
  state: 'active' | 'consuming' | 'consumed';
}

const VERIFIED_RECEIPT_APPLY_AUTHORITIES = new WeakMap<
  object,
  ApplyAuthority
>();
const VERIFIED_RECEIPT_APPLY_CLAIMS = new WeakMap<
  object,
  {
    readonly verified: VerifiedGithubTemplateDownloadReceipt;
    readonly authority: ApplyAuthority;
  }
>();

function offlineError(
  code: GithubTemplateDownloadReceiptOfflineReadErrorCode,
  message: string,
): GithubTemplateDownloadReceiptOfflineReadError {
  return Object.freeze(
    new GithubTemplateDownloadReceiptOfflineReadError(code, message),
  );
}

function ownDataRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    // Why: no caller-controlled trap may run while snapshotting trust inputs.
    || types.isProxy(value)
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || !allowed.includes(key),
    )
    || Object.values(descriptors).some(
      (descriptor) => !('value' in descriptor),
    )
  ) throw new Error();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function optionalMethod<T>(
  record: Record<string, unknown>,
  key: string,
): T | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'function') throw new Error();
  return value as T;
}

function snapshotVerifier(value: unknown): VerifierSnapshot {
  const verifier = ownDataRecord(value, ['verify']);
  if (typeof verifier['verify'] !== 'function') throw new Error();
  return Object.freeze({
    receiver: value as object,
    verify: verifier['verify'] as GithubTemplateDownloadReceiptVerifier['verify'],
  });
}

function snapshotIo(value: unknown): IoSnapshot | undefined {
  if (value === undefined) return undefined;
  const io = ownDataRecord(value, ['onPhase', 'read', 'close']);
  return Object.freeze({
    receiver: value as object,
    onPhase: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptOfflineReadIo['onPhase']>
    >(io, 'onPhase'),
    read: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptOfflineReadIo['read']>
    >(io, 'read'),
    close: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptOfflineReadIo['close']>
    >(io, 'close'),
  });
}

function snapshotByKeyOptions(
  value: unknown,
): CoreOptions {
  try {
    const options = ownDataRecord(
      value,
      ['cacheRoot', 'receiptKey', 'verifier', 'io'],
    );
    if (
      typeof options['cacheRoot'] !== 'string'
      || options['cacheRoot'].length === 0
      || typeof options['receiptKey'] !== 'string'
    ) throw new Error();
    deriveGithubTemplateDownloadReceiptLocatorPaths({
      cacheRoot: options['cacheRoot'],
      receiptKey: options['receiptKey'],
    });
    return Object.freeze({
      cacheRoot: options['cacheRoot'],
      receiptKey: options['receiptKey'],
      verifier: snapshotVerifier(options['verifier']),
      io: snapshotIo(options['io']),
    });
  } catch {
    throw offlineError(
      'INVALID_ARGUMENT',
      'GitHub template offline receipt read options are invalid',
    );
  }
}

function snapshotStoredOptions(value: unknown): {
  readonly cacheRoot: string;
  readonly stored: unknown;
  readonly verifier: VerifierSnapshot;
  readonly io?: IoSnapshot;
} {
  try {
    const options = ownDataRecord(
      value,
      ['cacheRoot', 'stored', 'verifier', 'io'],
    );
    if (
      typeof options['cacheRoot'] !== 'string'
      || options['cacheRoot'].length === 0
    ) throw new Error();
    deriveGithubTemplateDownloadReceiptLocatorPaths({
      cacheRoot: options['cacheRoot'],
      receiptKey: '0'.repeat(64),
    });
    return Object.freeze({
      cacheRoot: options['cacheRoot'],
      stored: options['stored'],
      verifier: snapshotVerifier(options['verifier']),
      io: snapshotIo(options['io']),
    });
  } catch {
    throw offlineError(
      'INVALID_ARGUMENT',
      'GitHub template stored receipt read options are invalid',
    );
  }
}

function snapshotExpectedStored(
  claim: ClaimedStoredGithubTemplateDownloadReceipt,
): ExpectedStored {
  try {
    const stored = ownDataRecord(claim.stored, [
      'receiptKey',
      'artifactSha256',
      'bytes',
      'status',
      'directoryDurability',
    ]);
    if (
      typeof stored['receiptKey'] !== 'string'
      || typeof stored['artifactSha256'] !== 'string'
      || !Number.isSafeInteger(stored['bytes'])
      || (stored['bytes'] as number) <= 0
      || (
        stored['status'] !== 'stored'
        && stored['status'] !== 'existing'
      )
      || (
        stored['directoryDurability'] !== 'synced'
        && stored['directoryDurability'] !== 'unsupported'
      )
    ) throw new Error();
    deriveGithubTemplateDownloadReceiptLocatorPaths({
      cacheRoot: resolve('/private/takt-offline-validation'),
      receiptKey: stored['receiptKey'],
    });
    deriveGithubTemplateDownloadArtifactPaths({
      cacheRoot: resolve('/private/takt-offline-validation'),
      archiveSha256: stored['artifactSha256'],
    });
    return Object.freeze({
      receiptKey: stored['receiptKey'],
      artifactSha256: stored['artifactSha256'],
      bytes: stored['bytes'],
      status: stored['status'],
    }) as ExpectedStored;
  } catch {
    throw offlineError(
      'INVALID_AUTHORITY',
      'stored GitHub template receipt authority is invalid',
    );
  }
}

function runPhase(
  io: IoSnapshot | undefined,
  phase: GithubTemplateDownloadReceiptOfflineReadPhase,
  path: string,
): void {
  try {
    if (io?.onPhase !== undefined) {
      Reflect.apply(io.onPhase, io.receiver, [phase, path]);
    }
  } catch {
    throw offlineError(
      'IO_FAILURE',
      'GitHub template offline receipt phase failed',
    );
  }
}

function requireDirectoryStat(stat: Stats, expectedDevice?: number): void {
  if (
    !stat.isDirectory()
    || !isProjectTemplatePrivateDirectoryMode(stat.mode)
    || (
      process.platform !== 'win32'
      && typeof process.getuid === 'function'
      && stat.uid !== process.getuid()
    )
    || (expectedDevice !== undefined && stat.dev !== expectedDevice)
  ) throw new Error();
}

function requireFileStat(
  stat: Stats,
  expectedDevice: number,
  expectedBytes: number,
): void {
  if (
    !stat.isFile()
    || stat.dev !== expectedDevice
    || stat.nlink !== 1
    || stat.size !== expectedBytes
    || !isProjectTemplatePrivateFileMode(stat.mode)
    || (
      process.platform !== 'win32'
      && typeof process.getuid === 'function'
      && stat.uid !== process.getuid()
    )
  ) throw new Error();
}

function filesystemFailure(
  error: unknown,
  missingCode: 'RECEIPT_MISSING' | 'CACHE_MISSING',
  unsafeMessage: string,
): GithubTemplateDownloadReceiptOfflineReadError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return offlineError(missingCode, (
      missingCode === 'RECEIPT_MISSING'
        ? 'GitHub template offline receipt is missing'
        : 'GitHub template offline cache entry is missing'
    ));
  }
  if (
    typeof code === 'string'
    && code !== 'ELOOP'
    && code !== 'ENOTDIR'
  ) {
    return offlineError(
      'IO_FAILURE',
      'GitHub template offline cache filesystem operation failed',
    );
  }
  return offlineError('CACHE_INVALID', unsafeMessage);
}

function openDirectory(
  path: string,
  expectedDevice?: number,
  missingCode: 'RECEIPT_MISSING' | 'CACHE_MISSING' = 'CACHE_MISSING',
): DirectoryAuthority {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(path) !== path
    ) throw new Error();
    requireDirectoryStat(pathStat, expectedDevice);
    fd = openSync(path, constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW);
    const opened = fstatSync(fd);
    requireDirectoryStat(opened, expectedDevice);
    if (opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) {
      throw new Error();
    }
    const authority = Object.freeze({
      path,
      fd,
      device: opened.dev,
      inode: opened.ino,
    });
    fd = undefined;
    return authority;
  } catch (error) {
    if (error instanceof GithubTemplateDownloadReceiptOfflineReadError) {
      throw error;
    }
    throw filesystemFailure(
      error,
      missingCode,
      'GitHub template offline receipt directory is unsafe',
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The rejected descriptor grants no authority.
      }
    }
  }
}

function assertDirectory(authority: DirectoryAuthority): void {
  try {
    const pathStat = lstatSync(authority.path);
    const opened = fstatSync(authority.fd);
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(authority.path) !== authority.path
    ) throw new Error();
    requireDirectoryStat(pathStat, authority.device);
    requireDirectoryStat(opened, authority.device);
    if (
      pathStat.ino !== authority.inode
      || opened.ino !== authority.inode
    ) throw new Error();
  } catch {
    throw offlineError(
      'CACHE_INVALID',
      'GitHub template offline receipt directory authority changed',
    );
  }
}

function openChildDirectory(
  parent: DirectoryAuthority,
  path: string,
  missingCode: 'RECEIPT_MISSING' | 'CACHE_MISSING',
  context: ReadContext,
): DirectoryAuthority {
  if (dirname(path) !== parent.path) {
    throw offlineError(
      'CACHE_INVALID',
      'GitHub template offline receipt directory path is invalid',
    );
  }
  assertDirectory(parent);
  const child = openDirectory(path, parent.device, missingCode);
  // Register immediately: a failure in the parent recheck must still run the
  // close hook and native close for the newly acquired child descriptor.
  context.directories.push(child);
  assertDirectory(parent);
  return child;
}

function openFile(
  path: string,
  expectedDevice: number,
  minimumBytes: number,
  maximumBytes: number,
  exactBytes?: number,
  missingCode: 'RECEIPT_MISSING' | 'CACHE_MISSING' = 'CACHE_MISSING',
  emptyCode: 'RECEIPT_INVALID' | 'CACHE_INVALID' = 'CACHE_INVALID',
): FileAuthority {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (pathStat.size > maximumBytes) {
      throw offlineError(
        'LIMIT_EXCEEDED',
        'GitHub template offline cache entry exceeds its size limit',
      );
    }
    if (pathStat.size < minimumBytes) {
      throw offlineError(
        emptyCode,
        'GitHub template offline cache entry is empty',
      );
    }
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(path) !== path
      || (exactBytes !== undefined && pathStat.size !== exactBytes)
    ) throw new Error();
    requireFileStat(pathStat, expectedDevice, pathStat.size);
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    requireFileStat(opened, expectedDevice, pathStat.size);
    if (opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) {
      throw new Error();
    }
    const authority = Object.freeze({
      path,
      fd,
      device: opened.dev,
      inode: opened.ino,
      bytes: opened.size,
    });
    fd = undefined;
    return authority;
  } catch (error) {
    if (error instanceof GithubTemplateDownloadReceiptOfflineReadError) {
      throw error;
    }
    throw filesystemFailure(
      error,
      missingCode,
      'GitHub template offline receipt file is unsafe',
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The rejected descriptor grants no authority.
      }
    }
  }
}

function assertFile(authority: FileAuthority): void {
  try {
    const pathStat = lstatSync(authority.path);
    const opened = fstatSync(authority.fd);
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(authority.path) !== authority.path
    ) throw new Error();
    requireFileStat(pathStat, authority.device, authority.bytes);
    requireFileStat(opened, authority.device, authority.bytes);
    if (
      pathStat.ino !== authority.inode
      || opened.ino !== authority.inode
    ) throw new Error();
  } catch {
    throw offlineError(
      'CACHE_INVALID',
      'GitHub template offline receipt file authority changed',
    );
  }
}

function readChunk(
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
  io: IoSnapshot | undefined,
): number {
  let count: unknown;
  try {
    count = io?.read === undefined
      ? readSync(fd, buffer, offset, length, position)
      : Reflect.apply(io.read, io.receiver, [
        fd,
        buffer,
        offset,
        length,
        position,
      ]);
  } catch {
    throw offlineError(
      'IO_FAILURE',
      'GitHub template offline receipt read failed',
    );
  }
  if (
    !Number.isSafeInteger(count)
    || (count as number) <= 0
    || (count as number) > length
  ) {
    throw offlineError(
      'IO_FAILURE',
      'GitHub template offline receipt read made invalid progress',
    );
  }
  return count as number;
}

function readExact(
  authority: FileAuthority,
  io: IoSnapshot | undefined,
): Buffer {
  const result = Buffer.allocUnsafe(authority.bytes);
  let position = 0;
  while (position < authority.bytes) {
    position += readChunk(
      authority.fd,
      result,
      position,
      authority.bytes - position,
      position,
      io,
    );
  }
  let eof: unknown;
  try {
    const extra = Buffer.allocUnsafe(1);
    eof = io?.read === undefined
      ? readSync(authority.fd, extra, 0, 1, authority.bytes)
      : Reflect.apply(io.read, io.receiver, [
        authority.fd,
        extra,
        0,
        1,
        authority.bytes,
      ]);
  } catch {
    throw offlineError(
      'IO_FAILURE',
      'GitHub template offline receipt EOF check failed',
    );
  }
  if (eof !== 0) {
    throw offlineError(
      'IO_FAILURE',
      'GitHub template offline receipt EOF check failed',
    );
  }
  return result;
}

function hashFile(
  authority: FileAuthority,
  io: IoSnapshot | undefined,
): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(
    Math.min(HASH_BUFFER_BYTES, authority.bytes),
  );
  let position = 0;
  while (position < authority.bytes) {
    const length = Math.min(buffer.byteLength, authority.bytes - position);
    const count = readChunk(
      authority.fd,
      buffer,
      0,
      length,
      position,
      io,
    );
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  let eof: unknown;
  try {
    const extra = Buffer.allocUnsafe(1);
    eof = io?.read === undefined
      ? readSync(authority.fd, extra, 0, 1, authority.bytes)
      : Reflect.apply(io.read, io.receiver, [
        authority.fd,
        extra,
        0,
        1,
        authority.bytes,
      ]);
  } catch {
    throw offlineError(
      'IO_FAILURE',
      'GitHub template offline artifact EOF check failed',
    );
  }
  if (eof !== 0) {
    throw offlineError(
      'IO_FAILURE',
      'GitHub template offline artifact EOF check failed',
    );
  }
  return hash.digest('hex');
}

async function verifyAuthentication(
  receipt: GithubTemplateDownloadReceiptV1,
  verifier: VerifierSnapshot,
): Promise<void> {
  try {
    const request = Object.freeze({
      keyId: receipt.authentication.keyId,
      input: createGithubTemplateDownloadReceiptAuthenticationInput(receipt),
      tag: receipt.authentication.tag,
    });
    let result: unknown;
    try {
      result = await Reflect.apply(
        verifier.verify,
        verifier.receiver,
        [request],
      );
    } catch {
      throw offlineError(
        'KEY_UNAVAILABLE',
        'GitHub template offline receipt verification key is unavailable',
      );
    }
    if (result === 'unavailable') {
      throw offlineError(
        'KEY_UNAVAILABLE',
        'GitHub template offline receipt verification key is unavailable',
      );
    }
    if (result !== 'valid') {
      throw offlineError(
        'AUTHENTICATION_FAILED',
        'GitHub template offline receipt authentication failed',
      );
    }
  } catch (error) {
    if (error instanceof GithubTemplateDownloadReceiptOfflineReadError) {
      throw error;
    }
    throw offlineError(
      'AUTHENTICATION_FAILED',
      'GitHub template offline receipt authentication failed',
    );
  }
}

function contextDescriptors(
  context: ReadContext,
): ReadonlyArray<readonly [
  number,
  'artifact' | 'receipt' | 'directory',
]> {
  const descriptors: Array<readonly [
    number,
    'artifact' | 'receipt' | 'directory',
  ]> = [];
  if (context.artifact !== undefined) {
    descriptors.push([context.artifact.fd, 'artifact']);
  }
  if (context.receipt !== undefined) {
    descriptors.push([context.receipt.fd, 'receipt']);
  }
  for (const directory of [...context.directories].reverse()) {
    descriptors.push([directory.fd, 'directory']);
  }
  return descriptors;
}

function runCloseHooks(
  context: ReadContext,
  io: IoSnapshot | undefined,
): GithubTemplateDownloadReceiptOfflineReadError | undefined {
  let failure: GithubTemplateDownloadReceiptOfflineReadError | undefined;
  for (const [fd, kind] of contextDescriptors(context)) {
    try {
      if (io?.close !== undefined) {
        Reflect.apply(io.close, io.receiver, [fd, kind]);
      }
    } catch {
      failure ??= offlineError(
        'IO_FAILURE',
        'GitHub template offline receipt close hook failed',
      );
    }
  }
  return failure;
}

function closeDescriptors(
  context: ReadContext,
): GithubTemplateDownloadReceiptOfflineReadError | undefined {
  let failure: GithubTemplateDownloadReceiptOfflineReadError | undefined;
  for (const [fd] of contextDescriptors(context)) {
    try {
      closeSync(fd);
    } catch {
      failure ??= offlineError(
        'IO_FAILURE',
        'GitHub template offline receipt close failed',
      );
    }
  }
  return failure;
}

function assertAllAuthorities(context: ReadContext): void {
  for (const directory of context.directories) assertDirectory(directory);
  if (context.receipt === undefined || context.artifact === undefined) {
    throw offlineError(
      'CACHE_INVALID',
      'GitHub template offline receipt authority is incomplete',
    );
  }
  assertFile(context.receipt);
  assertFile(context.artifact);
}

async function verifyAsyncPreflight(
  context: ReadContext,
  serialized: string,
  receiptKey: string,
  receipt: GithubTemplateDownloadReceiptV1,
  verifier: VerifierSnapshot,
  io: IoSnapshot | undefined,
): Promise<void> {
  try {
    assertAllAuthorities(context);
    const receiptBytes = readExact(context.receipt!, io);
    const reparsed = parseGithubTemplateDownloadReceipt(receiptBytes);
    const rereadSerialized = receiptBytes.toString('utf8');
    if (
      rereadSerialized !== serialized
      || calculateGithubTemplateDownloadReceiptKey(rereadSerialized)
        !== receiptKey
    ) throw new Error();
    await verifyAuthentication(reparsed, verifier);
    if (hashFile(context.artifact!, io) !== receipt.payload.archive.sha256) {
      throw new Error();
    }
    const inspection = snapshotGithubTemplateDownloadReceiptInspection(
      await inspectTaktpack(context.artifact!.path, {
        limits: {
          maxArchiveBytes: DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes,
        },
      }),
    );
    requireGithubTemplateDownloadReceiptArtifactBinding(
      reparsed,
      inspection,
      context.artifact!.bytes,
    );
    assertFile(context.artifact!);
    if (hashFile(context.artifact!, io) !== receipt.payload.archive.sha256) {
      throw new Error();
    }
  } catch (error) {
    if (
      error instanceof GithubTemplateDownloadReceiptOfflineReadError
      && (
        error.code === 'AUTHENTICATION_FAILED'
        || error.code === 'KEY_UNAVAILABLE'
      )
    ) throw error;
    throw offlineError(
      'CACHE_INVALID',
      'GitHub template offline receipt final preflight failed',
    );
  }
}

function verifyAndCloseSynchronously(
  context: ReadContext,
  serialized: string,
  receiptKey: string,
  artifactSha256: string,
): GithubTemplateDownloadReceiptOfflineReadError | undefined {
  let failure: GithubTemplateDownloadReceiptOfflineReadError | undefined;
  try {
    assertAllAuthorities(context);
    const receiptBytes = readExact(context.receipt!, undefined);
    const finalSerialized = receiptBytes.toString('utf8');
    if (
      finalSerialized !== serialized
      || calculateGithubTemplateDownloadReceiptKey(finalSerialized)
        !== receiptKey
      || hashFile(context.artifact!, undefined) !== artifactSha256
    ) throw new Error();
    // Why: native exact reads, path↔FD identity checks, and every native close
    // share one synchronous stack. No callback or microtask can swap authority.
    assertAllAuthorities(context);
  } catch {
    failure = offlineError(
      'CACHE_INVALID',
      'GitHub template offline receipt authority changed before close',
    );
  }
  return failure ?? closeDescriptors(context);
}

function normalizeFailure(
  error: unknown,
): GithubTemplateDownloadReceiptOfflineReadError {
  if (error instanceof GithubTemplateDownloadReceiptOfflineReadError) {
    return error;
  }
  return offlineError(
    'CACHE_INVALID',
    'GitHub template offline receipt verification failed',
  );
}

async function readOfflineCore(
  options: CoreOptions,
): Promise<VerifiedGithubTemplateDownloadReceipt> {
  const context: ReadContext = { directories: [] };
  let failure: GithubTemplateDownloadReceiptOfflineReadError | undefined;
  let serialized: string | undefined;
  let receipt: GithubTemplateDownloadReceiptV1 | undefined;
  let inspection: DeepReadonly<TaktpackInspectResult> | undefined;
  try {
    const requestedRoot = resolve(options.cacheRoot);
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync.native(requestedRoot);
    } catch (error) {
      throw filesystemFailure(
        error,
        'CACHE_MISSING',
        'GitHub template offline receipt cache root is unsafe',
      );
    }
    if (
      requestedRoot !== options.cacheRoot
      || canonicalRoot !== requestedRoot
    ) {
      throw offlineError(
        'CACHE_INVALID',
        'GitHub template offline receipt cache root is not canonical',
      );
    }
    const receiptPaths = deriveGithubTemplateDownloadReceiptLocatorPaths({
      cacheRoot: requestedRoot,
      receiptKey: options.receiptKey,
    });
    const cacheRoot = openDirectory(requestedRoot);
    context.directories.push(cacheRoot);
    let parent = cacheRoot;
    for (const path of receiptPaths.receiptAncestors) {
      parent = openChildDirectory(
        parent,
        path,
        'RECEIPT_MISSING',
        context,
      );
    }
    if (dirname(receiptPaths.receiptPath) !== parent.path) throw new Error();
    context.receipt = openFile(
      receiptPaths.receiptPath,
      parent.device,
      1,
      MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES,
      undefined,
      'RECEIPT_MISSING',
      'RECEIPT_INVALID',
    );
    runPhase(options.io, 'before-receipt-read', context.receipt.path);
    const receiptBytes = readExact(context.receipt, options.io);
    serialized = receiptBytes.toString('utf8');
    try {
      receipt = parseGithubTemplateDownloadReceipt(receiptBytes);
    } catch {
      throw offlineError(
        'RECEIPT_INVALID',
        'GitHub template offline receipt bytes are invalid',
      );
    }
    if (
      calculateGithubTemplateDownloadReceiptKey(serialized)
        !== options.receiptKey
    ) {
      throw offlineError(
        'RECEIPT_INVALID',
        'GitHub template offline receipt key does not match',
      );
    }
    runPhase(
      options.io,
      'before-receipt-authentication',
      context.receipt.path,
    );
    await verifyAuthentication(receipt, options.verifier);

    // Why: the receipt key locates only authenticated provenance. Artifact
    // authority is derived from the archive digest only after HMAC succeeds.
    const artifactPaths = deriveGithubTemplateDownloadArtifactPaths({
      cacheRoot: requestedRoot,
      archiveSha256: receipt.payload.archive.sha256,
    });
    runPhase(options.io, 'before-artifact-open', artifactPaths.artifactPath);
    const artifactDirectory = openChildDirectory(
      cacheRoot,
      artifactPaths.artifactDirectory,
      'CACHE_MISSING',
      context,
    );
    if (dirname(artifactPaths.artifactPath) !== artifactDirectory.path) {
      throw new Error();
    }
    if (
      receipt.payload.archive.bytes <= 0
      || receipt.payload.archive.bytes
        > DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes
    ) throw new Error();
    context.artifact = openFile(
      artifactPaths.artifactPath,
      artifactDirectory.device,
      1,
      DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes,
      receipt.payload.archive.bytes,
      'CACHE_MISSING',
      'CACHE_INVALID',
    );
    if (
      hashFile(context.artifact, options.io)
        !== receipt.payload.archive.sha256
    ) throw new Error();
    runPhase(
      options.io,
      'before-artifact-inspect',
      context.artifact.path,
    );
    try {
      inspection = snapshotGithubTemplateDownloadReceiptInspection(
        await inspectTaktpack(context.artifact.path, {
          limits: {
            maxArchiveBytes: DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes,
          },
        }),
      );
    } catch (error) {
      if (
        error instanceof TaktpackError
        && error.code === 'ARCHIVE_LIMIT_EXCEEDED'
      ) {
        throw offlineError(
          'LIMIT_EXCEEDED',
          'GitHub template offline artifact exceeds inspection limits',
        );
      }
      throw offlineError(
        'CACHE_INVALID',
        'GitHub template offline artifact inspection failed',
      );
    }
    requireGithubTemplateDownloadReceiptArtifactBinding(
      receipt,
      inspection,
      context.artifact.bytes,
    );
    assertFile(context.artifact);
    if (
      hashFile(context.artifact, options.io)
        !== receipt.payload.archive.sha256
    ) throw new Error();
    if (
      options.expectedStored !== undefined
      && (
        options.expectedStored.receiptKey !== options.receiptKey
        || options.expectedStored.artifactSha256
          !== receipt.payload.archive.sha256
        || options.expectedStored.bytes !== context.receipt.bytes
        || (
          options.expectedStored.status !== 'stored'
          && options.expectedStored.status !== 'existing'
        )
      )
    ) {
      throw offlineError(
        'INVALID_AUTHORITY',
        'stored GitHub template receipt does not match disk',
      );
    }
  } catch (error) {
    failure = normalizeFailure(error);
  }

  const closeHookFailure = runCloseHooks(context, options.io);
  if (failure === undefined) failure = closeHookFailure;
  let closedSynchronously = false;
  if (
    failure === undefined
    && serialized !== undefined
    && receipt !== undefined
    && inspection !== undefined
  ) {
    try {
      runPhase(
        options.io,
        'before-final-preflight',
        context.receipt!.path,
      );
      await verifyAsyncPreflight(
        context,
        serialized,
        options.receiptKey,
        receipt,
        options.verifier,
        options.io,
      );
    } catch (error) {
      failure = normalizeFailure(error);
    }
    if (failure === undefined) {
      failure = verifyAndCloseSynchronously(
        context,
        serialized,
        options.receiptKey,
        receipt.payload.archive.sha256,
      );
      closedSynchronously = true;
    }
  }
  if (!closedSynchronously) {
    const closeFailure = closeDescriptors(context);
    if (failure === undefined) failure = closeFailure;
  }
  if (failure !== undefined) throw failure;
  return Object.freeze({
    receiptKey: options.receiptKey,
    artifactSha256: receipt!.payload.archive.sha256,
    bytes: Buffer.byteLength(serialized!, 'utf8'),
    receipt: receipt!,
    inspection: inspection!,
  });
}

function registerApplyHandoff(
  verified: VerifiedGithubTemplateDownloadReceipt,
  cacheRoot: string,
): VerifiedGithubTemplateDownloadReceipt {
  // Why: this is disk-verification evidence, not approval or a filesystem
  // lock. Apply must reopen immediately before mutation and repeat canonical
  // receipt parsing, HMAC, artifact hashing, inspection, and path identity.
  VERIFIED_RECEIPT_APPLY_AUTHORITIES.set(verified, {
    cacheRoot,
    receiptKey: verified.receiptKey,
    artifactSha256: verified.artifactSha256,
    state: 'active',
  });
  return verified;
}

export async function readGithubTemplateDownloadReceiptByReceiptKey(
  value: ReadGithubTemplateDownloadReceiptByReceiptKeyOptions,
): Promise<VerifiedGithubTemplateDownloadReceipt> {
  const options = snapshotByKeyOptions(value);
  const verified = await readOfflineCore(options);
  return registerApplyHandoff(verified, options.cacheRoot);
}

export async function readGithubTemplateDownloadReceiptStored(
  value: ReadGithubTemplateDownloadReceiptStoredOptions,
): Promise<VerifiedGithubTemplateDownloadReceipt> {
  const options = snapshotStoredOptions(value);
  let claim: ClaimedStoredGithubTemplateDownloadReceipt;
  try {
    // Claim before the first await so clone/double/concurrent use fails closed.
    claim = claimStoredGithubTemplateDownloadReceiptForOfflineRead(
      options.stored,
    );
  } catch {
    throw offlineError(
      'INVALID_AUTHORITY',
      'stored GitHub template receipt authority is invalid',
    );
  }
  let failure: GithubTemplateDownloadReceiptOfflineReadError | undefined;
  let verified: VerifiedGithubTemplateDownloadReceipt | undefined;
  try {
    const expectedStored = snapshotExpectedStored(claim);
    verified = await readOfflineCore(Object.freeze({
      cacheRoot: options.cacheRoot,
      receiptKey: expectedStored.receiptKey,
      verifier: options.verifier,
      io: options.io,
      expectedStored,
    }));
  } catch (error) {
    failure = normalizeFailure(error);
  }
  try {
    // Every claimed result, including verifier/IO/cache failures, is consumed.
    consumeStoredGithubTemplateDownloadReceiptOfflineReadClaim(claim);
  } catch {
    if (failure === undefined) {
      failure = offlineError(
        'INVALID_AUTHORITY',
        'stored GitHub template receipt claim consumption failed',
      );
    }
  }
  if (failure !== undefined) throw failure;
  return registerApplyHandoff(verified!, options.cacheRoot);
}

export function claimVerifiedGithubTemplateDownloadReceiptForApply(
  value: unknown,
): ClaimedVerifiedGithubTemplateDownloadReceiptForApply {
  const authority = (
    typeof value === 'object' && value !== null
      ? VERIFIED_RECEIPT_APPLY_AUTHORITIES.get(value)
      : undefined
  );
  if (authority === undefined || authority.state !== 'active') {
    throw offlineError(
      'INVALID_AUTHORITY',
      'verified GitHub template receipt apply authority is invalid',
    );
  }
  authority.state = 'consuming';
  const verified = value as VerifiedGithubTemplateDownloadReceipt;
  const claim = Object.freeze({
    verified,
    [VERIFIED_RECEIPT_APPLY_CLAIM_BRAND]: true as const,
  });
  VERIFIED_RECEIPT_APPLY_CLAIMS.set(claim, { verified, authority });
  return claim;
}

export function consumeVerifiedGithubTemplateDownloadReceiptApplyClaim(
  value: ClaimedVerifiedGithubTemplateDownloadReceiptForApply,
): void {
  const claim = (
    typeof value === 'object' && value !== null
      ? VERIFIED_RECEIPT_APPLY_CLAIMS.get(value)
      : undefined
  );
  if (
    claim === undefined
    || claim.authority.state !== 'consuming'
    || value.verified !== claim.verified
  ) {
    throw offlineError(
      'INVALID_AUTHORITY',
      'verified GitHub template receipt apply claim is invalid',
    );
  }
  VERIFIED_RECEIPT_APPLY_CLAIMS.delete(value);
  claim.authority.state = 'consumed';
}
