import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { inspectTaktpack } from './archive-inspector.js';
import {
  DEFAULT_TAKTPACK_LIMITS,
  type DeepReadonly,
  type TaktpackInspectResult,
} from './archive-types.js';
import {
  isProjectTemplatePrivateDirectoryMode,
  isProjectTemplatePrivateFileMode,
  PROJECT_TEMPLATE_CONTROL_DIRECTORY,
} from './control-root-contract.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength',
)!.get!;

export type GithubTemplateDownloadStorageErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_AUTHORITY'
  | 'CACHE_MISS'
  | 'CACHE_INVALID'
  | 'CLEANUP_FAILED'
  | 'UNSAFE_STAGING'
  | 'ABORTED'
  | 'INVALID_CHUNK'
  | 'LIMIT_EXCEEDED'
  | 'SIZE_MISMATCH'
  | 'HASH_MISMATCH'
  | 'STREAM_FAILED'
  | 'INSPECTION_FAILED'
  | 'IO_FAILURE';

export class GithubTemplateDownloadStorageError extends Error {
  constructor(
    public readonly code: GithubTemplateDownloadStorageErrorCode,
    message: string,
    public readonly artifactState?:
      | 'none'
      | 'staging-only'
      | 'cache-published',
  ) {
    super(message);
    this.name = 'GithubTemplateDownloadStorageError';
  }
}

const INTERNAL_STORAGE_ERRORS = new WeakSet<object>();
const STAGED_DOWNLOAD_AUTHORITIES = new WeakMap<
  object,
  StagedGithubTemplateDownloadAuthority
>();
// Receipt creation will accept only results produced and retained by this
// process; structural equality cannot prove a cache entry was fully verified.
const MATERIALIZED_CACHE_RESULTS = new WeakSet<object>();
const STAGING_DIRECTORY_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type GithubTemplateDownloadStoragePhase =
  | 'ingress-created'
  | 'file-fsynced'
  | 'before-staging-root-parent-fsync'
  | 'before-staging-reinspect'
  | 'before-staging-verify-close'
  | 'before-cleanup';

export interface GithubTemplateDownloadStorageIoSeam {
  onPhase?(
    phase: GithubTemplateDownloadStoragePhase,
    path: string,
  ): void;
  write?(
    fd: number,
    chunk: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
}

export interface StageGithubTemplateDownloadOptions {
  readonly projectRoot: string;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
  readonly ioSeam?: GithubTemplateDownloadStorageIoSeam;
}

export interface StagedGithubTemplateDownload {
  readonly stagingPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly inspection: DeepReadonly<TaktpackInspectResult>;
}

export type GithubTemplateCachePhase =
  | 'before-cache-directory-parent-fsync'
  | 'before-cache-final-inspect'
  | 'before-cache-hit-parent-fsync'
  | 'before-staging-cleanup';

export interface GithubTemplateCacheIoSeam {
  onCachePhase?(phase: GithubTemplateCachePhase, path: string): void;
  cacheWrite?(
    fd: number,
    chunk: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
}

export interface MaterializeGithubTemplateCacheOptions {
  readonly staged: StagedGithubTemplateDownload;
  readonly cacheRoot?: string;
  readonly ioSeam?: GithubTemplateCacheIoSeam;
}

export interface MaterializedGithubTemplateCache {
  readonly cachePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly status: 'cache-hit' | 'cache-published';
  readonly artifactState: 'cache-published';
  readonly inspection: DeepReadonly<TaktpackInspectResult>;
}

interface ClaimedCacheMaterialization {
  readonly authority: StagedGithubTemplateDownloadAuthority;
  readonly cacheRoot?: string;
  readonly ioSeam?: GithubTemplateCacheIoSeam;
}

interface StagedGithubTemplateDownloadAuthority {
  readonly result: StagedGithubTemplateDownload;
  readonly projectRoot: string;
  readonly stagingRoot: string;
  readonly stagingDirectory: string;
  readonly stagingPath: string;
  readonly projectDevice: number;
  readonly projectInode: number;
  readonly stagingDevice: number;
  readonly stagingInode: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly ioSeam?: GithubTemplateDownloadStorageIoSeam;
  state: 'active' | 'consuming' | 'consumed';
}

interface StageGithubTemplateDownloadSnapshot {
  readonly projectRoot: string;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
  readonly ioSeam?: GithubTemplateDownloadStorageIoSeam;
}

function storageError(
  code: GithubTemplateDownloadStorageErrorCode,
  message: string,
  artifactState?: 'none' | 'staging-only' | 'cache-published',
): GithubTemplateDownloadStorageError {
  const error = new GithubTemplateDownloadStorageError(
    code,
    message,
    artifactState,
  );
  Object.freeze(error);
  INTERNAL_STORAGE_ERRORS.add(error);
  return error;
}

function isInternalStorageError(
  error: unknown,
): error is GithubTemplateDownloadStorageError {
  return typeof error === 'object'
    && error !== null
    && INTERNAL_STORAGE_ERRORS.has(error);
}

function runIoSeamPhase(
  ioSeam: GithubTemplateDownloadStorageIoSeam | undefined,
  phase: GithubTemplateDownloadStoragePhase,
  path: string,
): void {
  try {
    ioSeam?.onPhase?.(phase, path);
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template download storage hook failed',
    );
  }
}

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (typeof value !== 'object' || value === null) {
    return value as DeepReadonly<Value>;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value) as DeepReadonly<Value>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  let aborted = false;
  try {
    aborted = signal?.aborted === true;
  } catch {
    aborted = true;
  }
  if (aborted) {
    throw storageError('ABORTED', 'GitHub template download was cancelled');
  }
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function requirePrivateDirectory(
  path: string,
  expectedDevice: number,
): void {
  let stat: ReturnType<typeof lstatSync>;
  let canonicalPath: string;
  try {
    stat = lstatSync(path);
    canonicalPath = realpathSync.native(path);
  } catch {
    throw storageError(
      'UNSAFE_STAGING',
      'GitHub template download staging is unavailable',
    );
  }
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.dev !== expectedDevice
    || !isProjectTemplatePrivateDirectoryMode(stat.mode)
    || canonicalPath !== path
  ) {
    throw storageError(
      'UNSAFE_STAGING',
      'GitHub template download staging is unsafe',
    );
  }
}

function ensurePrivateDirectory(
  path: string,
  expectedDevice: number,
  parentPath: string,
  ioSeam?: GithubTemplateDownloadStorageIoSeam,
): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Re-sync on EEXIST too: a prior process may have stopped after mkdir but
  // before the parent entry became durable.
  runIoSeamPhase(
    ioSeam,
    'before-staging-root-parent-fsync',
    parentPath,
  );
  syncDirectory(parentPath);
  requirePrivateDirectory(path, expectedDevice);
}

function snapshotOptions(
  value: StageGithubTemplateDownloadOptions,
): StageGithubTemplateDownloadSnapshot {
  try {
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new Error();
    }
    const allowed = new Set([
      'projectRoot',
      'expectedBytes',
      'expectedSha256',
      'chunks',
      'signal',
      'ioSeam',
    ]);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(value).some(
        (key) => typeof key !== 'string' || !allowed.has(key),
      )
      || Object.values(descriptors).some(
        (descriptor) => !('value' in descriptor),
      )
    ) {
      throw new Error();
    }
    const projectRoot = descriptors['projectRoot']?.value;
    const expectedBytes = descriptors['expectedBytes']?.value;
    const expectedSha256 = descriptors['expectedSha256']?.value;
    const chunks = descriptors['chunks']?.value;
    const signal = descriptors['signal']?.value;
    const ioSeam = descriptors['ioSeam']?.value;
    if (
      typeof projectRoot !== 'string'
      || typeof expectedBytes !== 'number'
      || !Number.isSafeInteger(expectedBytes)
      || expectedBytes <= 0
      || expectedBytes > DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes
      || typeof expectedSha256 !== 'string'
      || !SHA256_PATTERN.test(expectedSha256)
      || (
        (typeof chunks !== 'object' || chunks === null)
        && typeof chunks !== 'function'
      )
    ) {
      throw new Error();
    }
    return {
      projectRoot,
      expectedBytes,
      expectedSha256,
      chunks: chunks as AsyncIterable<Uint8Array>,
      ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
      ...(ioSeam === undefined
        ? {}
        : { ioSeam: ioSeam as GithubTemplateDownloadStorageIoSeam }),
    };
  } catch {
    throw storageError(
      'INVALID_ARGUMENT',
      'GitHub template download options are invalid',
    );
  }
}

function getDownloadIterator(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterator<unknown> {
  try {
    const createIterator = chunks[Symbol.asyncIterator];
    if (typeof createIterator !== 'function') throw new Error();
    const iterator = createIterator.call(chunks) as AsyncIterator<unknown>;
    if (
      (typeof iterator !== 'object' || iterator === null)
      && typeof iterator !== 'function'
    ) {
      throw new Error();
    }
    if (typeof iterator.next !== 'function') throw new Error();
    return iterator;
  } catch {
    throw storageError(
      'STREAM_FAILED',
      'GitHub template download stream failed',
    );
  }
}

async function readDownloadChunk(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal | undefined,
): Promise<{ done: boolean; value: unknown }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      action: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      try {
        signal?.removeEventListener('abort', onAbort);
      } catch {
        // Listener cleanup cannot change the already selected outcome.
      }
      action();
    };
    const onAbort = (): void => {
      finish(() => reject(storageError(
        'ABORTED',
        'GitHub template download was cancelled',
      )));
    };
    try {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (settled) return;
      Promise.resolve(iterator.next()).then(
        (result) => {
          if (settled) return;
          try {
            if (typeof result !== 'object' || result === null) {
              throw new Error();
            }
            const done = result.done === true;
            // A completed iterator's value is intentionally never observed.
            const value = done ? undefined : result.value;
            finish(() => resolve({ done, value }));
          } catch {
            finish(() => reject(storageError(
              'STREAM_FAILED',
              'GitHub template download stream failed',
            )));
          }
        },
        () => finish(() => reject(storageError(
          'STREAM_FAILED',
          'GitHub template download stream failed',
        ))),
      );
    } catch {
      finish(() => reject(storageError(
        'STREAM_FAILED',
        'GitHub template download stream failed',
      )));
    }
  });
}

function closeDownloadIterator(
  iterator: AsyncIterator<unknown>,
): void {
  try {
    const close = iterator.return;
    if (typeof close === 'function') {
      void Promise.resolve(close.call(iterator)).catch(() => undefined);
    }
  } catch {
    // Iterator cleanup is best effort and never replaces the primary error.
  }
}

function snapshotDownloadChunk(value: unknown): Uint8Array {
  try {
    if (typeof value !== 'object' || value === null) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Uint8Array.prototype
      && prototype !== Buffer.prototype
    ) {
      throw new Error();
    }
    const byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
    const snapshot = new Uint8Array(byteLength);
    Uint8Array.prototype.set.call(snapshot, value as Uint8Array);
    return snapshot;
  } catch {
    throw storageError(
      'INVALID_CHUNK',
      'GitHub template download yielded an invalid chunk',
    );
  }
}

function writeDownloadChunk(
  fd: number,
  chunk: Uint8Array,
  offset: number,
  length: number,
  position: number,
  ioSeam: GithubTemplateDownloadStorageIoSeam | undefined,
): number {
  let written: number;
  try {
    written = ioSeam?.write?.(
      fd,
      chunk,
      offset,
      length,
      position,
    ) ?? writeSync(fd, chunk, offset, length, position);
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template download write failed',
    );
  }
  if (
    !Number.isSafeInteger(written)
    || written <= 0
    || written > length
  ) {
    throw storageError(
      'IO_FAILURE',
      'GitHub template download write made invalid progress',
    );
  }
  return written;
}

function cleanupOwnedStaging(
  stagingDirectory: string,
  stagingPath: string,
  expectedDevice: number,
  ioSeam: GithubTemplateDownloadStorageIoSeam | undefined,
): void {
  runIoSeamPhase(ioSeam, 'before-cleanup', stagingPath);
  try {
    const stat = lstatSync(stagingPath);
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.nlink !== 1
      || stat.dev !== expectedDevice
    ) {
      throw storageError(
        'UNSAFE_STAGING',
        'GitHub template download cleanup target is unsafe',
      );
    }
    unlinkSync(stagingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    rmdirSync(stagingDirectory);
    syncDirectory(dirname(stagingDirectory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function requireSealedStagingFile(
  authority: StagedGithubTemplateDownloadAuthority,
): Stats {
  const stat = lstatSync(authority.stagingPath);
  const canonicalPath = realpathSync.native(authority.stagingPath);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.dev !== authority.stagingDevice
    || stat.ino !== authority.stagingInode
    || stat.nlink !== 1
    || stat.size !== authority.bytes
    || !isProjectTemplatePrivateFileMode(stat.mode)
    || canonicalPath !== authority.stagingPath
  ) {
    throw storageError(
      'UNSAFE_STAGING',
      'GitHub template staged download authority changed',
    );
  }
  return stat;
}

function requireSealedDescriptor(
  stat: Stats,
  authority: StagedGithubTemplateDownloadAuthority,
): void {
  if (
    !stat.isFile()
    || stat.dev !== authority.stagingDevice
    || stat.ino !== authority.stagingInode
    || stat.nlink !== 1
    || stat.size !== authority.bytes
    || !isProjectTemplatePrivateFileMode(stat.mode)
  ) {
    throw storageError(
      'UNSAFE_STAGING',
      'GitHub template staged download descriptor changed',
    );
  }
}

function hashStagedDescriptor(
  fd: number,
  expectedBytes: number,
): string {
  const digest = createHash('sha256');
  let position = 0;
  while (position < expectedBytes) {
    const length = Math.min(64 * 1024, expectedBytes - position);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, position);
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) {
      throw storageError(
        'UNSAFE_STAGING',
        'GitHub template staged download read was incomplete',
      );
    }
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if (readSync(fd, extra, 0, 1, position) !== 0) {
    throw storageError(
      'UNSAFE_STAGING',
      'GitHub template staged download size changed',
    );
  }
  return digest.digest('hex');
}

/**
 * Reopens and fully verifies a staged download using authority held only by
 * this process. A frozen structural clone is insufficient because it cannot
 * prove which inode was originally inspected.
 */
interface OpenVerifiedStaging {
  readonly fd: number;
  readonly inspection: TaktpackInspectResult;
}

async function openVerifiedStagingAuthority(
  authority: StagedGithubTemplateDownloadAuthority,
  expectedState: 'active' | 'consuming',
): Promise<OpenVerifiedStaging> {
  if (authority.state !== expectedState) {
    throw storageError(
      'INVALID_AUTHORITY',
      'GitHub template staged download authority is invalid',
    );
  }
  let fd: number | undefined;
  try {
    const projectStat = lstatSync(authority.projectRoot);
    if (
      projectStat.isSymbolicLink()
      || !projectStat.isDirectory()
      || projectStat.dev !== authority.projectDevice
      || projectStat.ino !== authority.projectInode
      || realpathSync.native(authority.projectRoot) !== authority.projectRoot
    ) {
      throw storageError(
        'UNSAFE_STAGING',
        'GitHub template staged download project root changed',
      );
    }
    const expectedStagingRoot = join(
      authority.projectRoot,
      PROJECT_TEMPLATE_CONTROL_DIRECTORY,
      'download-staging',
    );
    const stagingDirectoryName = basename(authority.stagingDirectory);
    if (
      authority.stagingRoot !== expectedStagingRoot
      || !STAGING_DIRECTORY_NAME_PATTERN.test(stagingDirectoryName)
      || authority.stagingDirectory
        !== join(expectedStagingRoot, stagingDirectoryName)
      || authority.stagingPath
        !== join(authority.stagingDirectory, 'asset.partial')
    ) {
      throw storageError(
        'UNSAFE_STAGING',
        'GitHub template staged download path escaped containment',
      );
    }
    requirePrivateDirectory(authority.stagingRoot, authority.stagingDevice);
    requirePrivateDirectory(
      authority.stagingDirectory,
      authority.stagingDevice,
    );
    requireSealedStagingFile(authority);

    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    fd = openSync(authority.stagingPath, constants.O_RDONLY | noFollow);
    requireSealedDescriptor(fstatSync(fd), authority);
    const actualSha256 = hashStagedDescriptor(fd, authority.bytes);
    requireSealedDescriptor(fstatSync(fd), authority);
    requireSealedStagingFile(authority);
    if (actualSha256 !== authority.sha256) {
      throw storageError(
        'HASH_MISMATCH',
        'GitHub template staged download digest changed',
      );
    }

    runIoSeamPhase(
      authority.ioSeam,
      'before-staging-reinspect',
      authority.stagingPath,
    );
    let inspection: TaktpackInspectResult;
    try {
      inspection = await inspectTaktpack(authority.stagingPath, {
        limits: {
          maxArchiveBytes: DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes,
        },
      });
    } catch {
      throw storageError(
        'INSPECTION_FAILED',
        'GitHub template staged download inspection failed',
      );
    }
    requireSealedDescriptor(fstatSync(fd), authority);
    requireSealedStagingFile(authority);
    if (inspection.archiveSha256 !== authority.sha256) {
      throw storageError(
        'HASH_MISMATCH',
        'GitHub template staged inspection digest changed',
      );
    }
    const retainedFd = fd;
    fd = undefined;
    return { fd: retainedFd, inspection };
  } catch (error) {
    if (isInternalStorageError(error)) throw error;
    throw storageError(
      'UNSAFE_STAGING',
      'GitHub template staged download verification failed',
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Verification failure already selected its stable outcome.
      }
    }
  }
}

export async function verifyGithubTemplateDownloadStaging(
  staged: StagedGithubTemplateDownload,
): Promise<StagedGithubTemplateDownload> {
  const authority = (
    (typeof staged === 'object' && staged !== null)
      ? STAGED_DOWNLOAD_AUTHORITIES.get(staged)
      : undefined
  );
  if (authority === undefined || authority.result !== staged) {
    throw storageError(
      'INVALID_AUTHORITY',
      'GitHub template staged download authority is invalid',
    );
  }

  const opened = await openVerifiedStagingAuthority(authority, 'active');
  let fd: number | undefined = opened.fd;
  try {
    runIoSeamPhase(
      authority.ioSeam,
      'before-staging-verify-close',
      authority.stagingPath,
    );
    closeSync(fd);
    fd = undefined;
    // B1b claims active -> consuming -> consumed before verification and
    // retains its verified FD through cache materialization.
    return authority.result;
  } catch (error) {
    if (isInternalStorageError(error)) throw error;
    throw storageError(
      'UNSAFE_STAGING',
      'GitHub template staged download close failed',
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A close failure must never be reported as successful verification.
      }
    }
  }
}

function claimCacheMaterialization(
  value: MaterializeGithubTemplateCacheOptions,
): ClaimedCacheMaterialization {
  let staged: unknown;
  let cacheRoot: unknown;
  let ioSeam: unknown;
  try {
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set(['staged', 'cacheRoot', 'ioSeam']);
    if (
      Reflect.ownKeys(value).some(
        (key) => typeof key !== 'string' || !allowed.has(key),
      )
      || Object.values(descriptors).some(
        (descriptor) => !('value' in descriptor),
      )
    ) throw new Error();
    staged = descriptors['staged']?.value;
    cacheRoot = descriptors['cacheRoot']?.value;
    ioSeam = descriptors['ioSeam']?.value;
  } catch {
    throw storageError(
      'INVALID_ARGUMENT',
      'GitHub template cache options are invalid',
    );
  }
  const authority = (
    (typeof staged === 'object' && staged !== null)
      ? STAGED_DOWNLOAD_AUTHORITIES.get(staged)
      : undefined
  );
  if (
    authority === undefined
    || authority.result !== staged
    || authority.state !== 'active'
  ) {
    throw storageError(
      'INVALID_AUTHORITY',
      'GitHub template staged download authority is invalid',
    );
  }
  if (
    (cacheRoot !== undefined && typeof cacheRoot !== 'string')
    || (
      ioSeam !== undefined
      && (typeof ioSeam !== 'object' || ioSeam === null)
    )
  ) {
    throw storageError(
      'INVALID_ARGUMENT',
      'GitHub template cache options are invalid',
    );
  }
  // All option validation precedes the synchronous claim so invalid optional
  // fields cannot strand a valid authority in the consuming state.
  authority.state = 'consuming';
  return {
    authority,
    ...(cacheRoot === undefined ? {} : { cacheRoot }),
    ...(ioSeam === undefined
      ? {}
      : { ioSeam: ioSeam as GithubTemplateCacheIoSeam }),
  };
}

function runCachePhase(
  ioSeam: GithubTemplateCacheIoSeam | undefined,
  phase: GithubTemplateCachePhase,
  path: string,
): void {
  try {
    ioSeam?.onCachePhase?.(phase, path);
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache storage hook failed',
    );
  }
}

function requirePrivateCacheDirectory(
  path: string,
  expectedDevice?: number,
): Stats {
  try {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || (
        expectedDevice !== undefined
        && stat.dev !== expectedDevice
      )
      || !isProjectTemplatePrivateDirectoryMode(stat.mode)
      || realpathSync.native(path) !== path
    ) throw new Error();
    return stat;
  } catch {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache directory is unsafe',
      'staging-only',
    );
  }
}

function ensurePrivateCacheDirectory(
  path: string,
  parentPath: string,
  expectedDevice?: number,
  ioSeam?: GithubTemplateCacheIoSeam,
): Stats {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template cache directory is unavailable',
        'staging-only',
      );
    }
  }
  runCachePhase(
    ioSeam,
    'before-cache-directory-parent-fsync',
    parentPath,
  );
  try {
    // EEXIST is also synced because a previous process may have stopped
    // between mkdir and durable publication of the directory entry.
    syncDirectory(parentPath);
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache parent sync failed',
      'staging-only',
    );
  }
  return requirePrivateCacheDirectory(path, expectedDevice);
}

function prepareCacheDirectories(
  cacheRootOverride: string | undefined,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): {
  shaRoot: string;
  device: number;
  shaRootFd: number;
  shaRootInode: number;
} {
  let cacheRoot: string;
  let cacheStat: Stats;
  if (cacheRootOverride !== undefined) {
    const requestedRoot = resolve(cacheRootOverride);
    try {
      if (
        cacheRootOverride !== requestedRoot
        || lstatSync(requestedRoot).isSymbolicLink()
      ) throw new Error();
      cacheRoot = realpathSync.native(requestedRoot);
      if (cacheRoot !== requestedRoot) throw new Error();
    } catch {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template cache directory is unsafe',
        'staging-only',
      );
    }
    cacheStat = requirePrivateCacheDirectory(cacheRoot);
  } else {
    const globalRoot = resolve(getGlobalConfigDir());
    const globalStat = ensurePrivateCacheDirectory(
      globalRoot,
      dirname(globalRoot),
      undefined,
      ioSeam,
    );
    const cacheDirectory = join(globalRoot, 'cache');
    const cacheDirectoryStat = ensurePrivateCacheDirectory(
      cacheDirectory,
      globalRoot,
      globalStat.dev,
      ioSeam,
    );
    cacheRoot = join(cacheDirectory, 'project-templates');
    cacheStat = ensurePrivateCacheDirectory(
      cacheRoot,
      cacheDirectory,
      cacheDirectoryStat.dev,
      ioSeam,
    );
  }
  const shaRoot = join(cacheRoot, 'sha256');
  const shaRootStat = ensurePrivateCacheDirectory(
    shaRoot,
    cacheRoot,
    cacheStat.dev,
    ioSeam,
  );
  let shaRootFd: number | undefined;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const directoryOnly = process.platform === 'win32'
      ? 0
      : constants.O_DIRECTORY;
    shaRootFd = openSync(
      shaRoot,
      constants.O_RDONLY | noFollow | directoryOnly,
    );
    const opened = fstatSync(shaRootFd);
    if (
      !opened.isDirectory()
      || opened.dev !== shaRootStat.dev
      || opened.ino !== shaRootStat.ino
      || !isProjectTemplatePrivateDirectoryMode(opened.mode)
    ) throw new Error();
    return {
      shaRoot,
      device: cacheStat.dev,
      shaRootFd,
      shaRootInode: opened.ino,
    };
  } catch {
    if (shaRootFd !== undefined) {
      try {
        closeSync(shaRootFd);
      } catch {
        // Directory authority was never published to the caller.
      }
    }
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache directory is unsafe',
      'staging-only',
    );
  }
}

function assertCacheDirectoryAuthority(
  path: string,
  fd: number,
  expectedDevice: number,
  expectedInode: number,
): void {
  try {
    const pathStat = lstatSync(path);
    const opened = fstatSync(fd);
    if (
      pathStat.isSymbolicLink()
      || !pathStat.isDirectory()
      || !opened.isDirectory()
      || pathStat.dev !== expectedDevice
      || opened.dev !== expectedDevice
      || pathStat.ino !== expectedInode
      || opened.ino !== expectedInode
      || !isProjectTemplatePrivateDirectoryMode(pathStat.mode)
      || !isProjectTemplatePrivateDirectoryMode(opened.mode)
      || realpathSync.native(path) !== path
    ) throw new Error();
  } catch {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache directory authority changed',
      'cache-published',
    );
  }
}

function requireCacheFileIdentity(
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
  ) {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache file is unsafe',
      'cache-published',
    );
  }
}

function hashCacheDescriptor(fd: number, expectedBytes: number): string {
  const digest = createHash('sha256');
  let position = 0;
  while (position < expectedBytes) {
    const length = Math.min(64 * 1024, expectedBytes - position);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, position);
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template cache read was incomplete',
        'cache-published',
      );
    }
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, position) !== 0) {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache size changed',
      'cache-published',
    );
  }
  return digest.digest('hex');
}

async function verifyExistingCacheFinal(
  path: string,
  expectedDevice: number,
  authority: StagedGithubTemplateDownloadAuthority,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): Promise<TaktpackInspectResult> {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(path) !== path
    ) {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template cache file is unsafe',
        'cache-published',
      );
    }
    requireCacheFileIdentity(pathStat, expectedDevice, authority.bytes);
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    requireCacheFileIdentity(opened, expectedDevice, authority.bytes);
    if (
      opened.dev !== pathStat.dev
      || opened.ino !== pathStat.ino
      || hashCacheDescriptor(fd, authority.bytes) !== authority.sha256
    ) {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template cache digest is invalid',
        'cache-published',
      );
    }
    runCachePhase(ioSeam, 'before-cache-final-inspect', path);
    let inspection: TaktpackInspectResult;
    try {
      inspection = await inspectTaktpack(path, {
        limits: {
          maxArchiveBytes: DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes,
        },
      });
    } catch {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template cache archive is invalid',
        'cache-published',
      );
    }
    const afterPath = lstatSync(path);
    const afterFd = fstatSync(fd);
    requireCacheFileIdentity(afterPath, expectedDevice, authority.bytes);
    requireCacheFileIdentity(afterFd, expectedDevice, authority.bytes);
    if (
      afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino
      || afterFd.dev !== opened.dev
      || afterFd.ino !== opened.ino
      || inspection.archiveSha256 !== authority.sha256
    ) {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template cache changed during verification',
        'cache-published',
      );
    }
    closeSync(fd);
    fd = undefined;
    return inspection;
  } catch (error) {
    if (isInternalStorageError(error)) throw error;
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache verification failed',
      'cache-published',
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Cache verification has already failed closed.
      }
    }
  }
}

function cleanupConsumedStaging(
  authority: StagedGithubTemplateDownloadAuthority,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): void {
  runCachePhase(ioSeam, 'before-staging-cleanup', authority.stagingPath);
  const stat = lstatSync(authority.stagingPath);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.dev !== authority.stagingDevice
    || stat.ino !== authority.stagingInode
    || stat.nlink !== 1
    || stat.size !== authority.bytes
    || !isProjectTemplatePrivateFileMode(stat.mode)
    || realpathSync.native(authority.stagingPath) !== authority.stagingPath
  ) {
    throw storageError(
      'CLEANUP_FAILED',
      'GitHub template staging cleanup authority changed',
    );
  }
  unlinkSync(authority.stagingPath);
  rmdirSync(authority.stagingDirectory);
  syncDirectory(authority.stagingRoot);
}

export async function materializeGithubTemplateCache(
  options: MaterializeGithubTemplateCacheOptions,
): Promise<MaterializedGithubTemplateCache> {
  const claim = claimCacheMaterialization(options);
  const { authority } = claim;
  let stagingFd: number | undefined;
  let result: MaterializedGithubTemplateCache | undefined;
  let primaryError: unknown;
  let cacheAvailable = false;
  let cacheDirectoryFd: number | undefined;
  try {
    const opened = await openVerifiedStagingAuthority(authority, 'consuming');
    stagingFd = opened.fd;
    const cache = prepareCacheDirectories(claim.cacheRoot, claim.ioSeam);
    cacheDirectoryFd = cache.shaRootFd;
    const cachePath = join(
      cache.shaRoot,
      `${authority.sha256}.taktpack`,
    );
    try {
      lstatSync(cachePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw storageError(
          'CACHE_MISS',
          'GitHub template cache entry is not available',
          'staging-only',
        );
      }
      throw storageError(
        'CACHE_INVALID',
        'GitHub template cache entry is unavailable',
        'cache-published',
      );
    }
    const inspection = await verifyExistingCacheFinal(
      cachePath,
      cache.device,
      authority,
      claim.ioSeam,
    );
    cacheAvailable = true;
    runCachePhase(
      claim.ioSeam,
      'before-cache-hit-parent-fsync',
      cache.shaRoot,
    );
    try {
      // The retained directory descriptor prevents a path swap from turning
      // durability repair into authority for a different cache directory.
      assertCacheDirectoryAuthority(
        cache.shaRoot,
        cache.shaRootFd,
        cache.device,
        cache.shaRootInode,
      );
      if (process.platform !== 'win32') fsyncSync(cache.shaRootFd);
      assertCacheDirectoryAuthority(
        cache.shaRoot,
        cache.shaRootFd,
        cache.device,
        cache.shaRootInode,
      );
    } catch {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template cache directory authority changed',
        'cache-published',
      );
    }
    closeSync(stagingFd);
    stagingFd = undefined;
    result = Object.freeze({
      cachePath,
      bytes: authority.bytes,
      sha256: authority.sha256,
      status: 'cache-hit',
      artifactState: 'cache-published',
      inspection: deepFreeze(inspection),
    });
  } catch (error) {
    primaryError = isInternalStorageError(error)
      ? error
      : storageError(
        'IO_FAILURE',
        'GitHub template cache materialization failed',
        cacheAvailable ? 'cache-published' : 'staging-only',
      );
  } finally {
    if (cacheDirectoryFd !== undefined) {
      try {
        closeSync(cacheDirectoryFd);
      } catch {
        if (primaryError === undefined) {
          primaryError = storageError(
            'IO_FAILURE',
            'GitHub template cache directory close failed',
            cacheAvailable ? 'cache-published' : 'staging-only',
          );
        }
      }
    }
    if (stagingFd !== undefined) {
      try {
        closeSync(stagingFd);
      } catch {
        // Preserve the primary result while consuming the authority.
      }
    }
    authority.state = 'consumed';
    try {
      cleanupConsumedStaging(authority, claim.ioSeam);
    } catch {
      if (primaryError === undefined) {
        primaryError = storageError(
          'CLEANUP_FAILED',
          'GitHub template staging cleanup failed',
          cacheAvailable ? 'cache-published' : 'staging-only',
        );
      }
    }
  }
  if (primaryError !== undefined) {
    if (isInternalStorageError(primaryError) && !cacheAvailable) {
      let artifactState: 'none' | 'staging-only' = 'staging-only';
      try {
        lstatSync(authority.stagingPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          artifactState = 'none';
        }
      }
      if (primaryError.artifactState !== artifactState) {
        primaryError = storageError(
          primaryError.code,
          primaryError.message,
          artifactState,
        );
      }
    }
    throw primaryError;
  }
  if (result === undefined) {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache materialization failed',
    );
  }
  MATERIALIZED_CACHE_RESULTS.add(result);
  return result;
}

/**
 * Stages untrusted online bytes only. The caller must already hold the shared
 * download mutation lease and have passed the owned apply guard. This function
 * creates no journal, backup, receipt, or recovery marker.
 */
export async function stageGithubTemplateDownload(
  options: StageGithubTemplateDownloadOptions,
): Promise<StagedGithubTemplateDownload> {
  const snapshot = snapshotOptions(options);
  throwIfAborted(snapshot.signal);

  const requestedProjectRoot = resolve(snapshot.projectRoot);
  let projectRoot: string;
  try {
    projectRoot = realpathSync.native(requestedProjectRoot);
  } catch {
    throw storageError('UNSAFE_STAGING', 'project root is unavailable');
  }
  let projectStat: ReturnType<typeof lstatSync>;
  try {
    projectStat = lstatSync(projectRoot);
  } catch {
    throw storageError('UNSAFE_STAGING', 'project root is unavailable');
  }
  if (
    projectStat.isSymbolicLink()
    || !projectStat.isDirectory()
  ) {
    throw storageError('UNSAFE_STAGING', 'project root is unsafe');
  }

  const controlRoot = join(projectRoot, PROJECT_TEMPLATE_CONTROL_DIRECTORY);
  requirePrivateDirectory(controlRoot, projectStat.dev);
  const stagingRoot = join(controlRoot, 'download-staging');
  try {
    ensurePrivateDirectory(
      stagingRoot,
      projectStat.dev,
      controlRoot,
      snapshot.ioSeam,
    );
  } catch (error) {
    if (isInternalStorageError(error)) throw error;
    throw storageError(
      'UNSAFE_STAGING',
      'GitHub template download staging is unavailable',
    );
  }

  const stagingDirectory = join(stagingRoot, randomUUID());
  const stagingPath = join(stagingDirectory, 'asset.partial');
  let fd: number | undefined;
  let ownsStaging = false;
  let primaryError: unknown;
  try {
    mkdirSync(stagingDirectory, { mode: 0o700 });
    ownsStaging = true;
    syncDirectory(stagingRoot);
    requirePrivateDirectory(stagingDirectory, projectStat.dev);
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    fd = openSync(
      stagingPath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | noFollow,
      0o600,
    );
    runIoSeamPhase(snapshot.ioSeam, 'ingress-created', stagingPath);

    const digest = createHash('sha256');
    let received = 0;
    const iterator = getDownloadIterator(snapshot.chunks);
    let iteratorDone = false;
    try {
      while (true) {
        throwIfAborted(snapshot.signal);
        const next = await readDownloadChunk(iterator, snapshot.signal);
        if (next.done) {
          iteratorDone = true;
          break;
        }
        throwIfAborted(snapshot.signal);
        const chunk = snapshotDownloadChunk(next.value);
        if (chunk.byteLength === 0) continue;
        if (
          chunk.byteLength > snapshot.expectedBytes - received
          || received + chunk.byteLength
            > DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes
        ) {
          throw storageError(
            'LIMIT_EXCEEDED',
            'GitHub template download exceeded its byte limit',
          );
        }
        let offset = 0;
        while (offset < chunk.byteLength) {
          offset += writeDownloadChunk(
            fd,
            chunk,
            offset,
            chunk.byteLength - offset,
            received + offset,
            snapshot.ioSeam,
          );
        }
        digest.update(chunk);
        received += chunk.byteLength;
      }
    } catch (error) {
      if (!iteratorDone) closeDownloadIterator(iterator);
      throw error;
    }
    throwIfAborted(snapshot.signal);
    if (received !== snapshot.expectedBytes) {
      throw storageError(
        'SIZE_MISMATCH',
        'GitHub template download size did not match',
      );
    }
    const actualSha256 = digest.digest('hex');
    if (actualSha256 !== snapshot.expectedSha256) {
      throw storageError(
        'HASH_MISMATCH',
        'GitHub template download digest did not match',
      );
    }
    fsyncSync(fd);
    runIoSeamPhase(snapshot.ioSeam, 'file-fsynced', stagingPath);
    closeSync(fd);
    fd = undefined;
    syncDirectory(stagingDirectory);

    const stagedStat = lstatSync(stagingPath);
    if (
      stagedStat.isSymbolicLink()
      || !stagedStat.isFile()
      || stagedStat.nlink !== 1
      || stagedStat.dev !== projectStat.dev
      || stagedStat.size !== snapshot.expectedBytes
      || !isProjectTemplatePrivateFileMode(stagedStat.mode)
    ) {
      throw storageError(
        'UNSAFE_STAGING',
        'GitHub template download file is unsafe',
      );
    }

    let inspection: TaktpackInspectResult;
    try {
      inspection = await inspectTaktpack(stagingPath, {
        limits: {
          maxArchiveBytes: DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes,
        },
      });
    } catch {
      throw storageError(
        'INSPECTION_FAILED',
        'GitHub template archive inspection failed',
      );
    }
    if (inspection.archiveSha256 !== snapshot.expectedSha256) {
      throw storageError(
        'HASH_MISMATCH',
        'GitHub template inspected digest did not match',
      );
    }
    const finalStat = lstatSync(stagingPath);
    if (
      finalStat.isSymbolicLink()
      || !finalStat.isFile()
      || finalStat.dev !== stagedStat.dev
      || finalStat.ino !== stagedStat.ino
      || finalStat.nlink !== 1
      || finalStat.size !== snapshot.expectedBytes
      || !isProjectTemplatePrivateFileMode(finalStat.mode)
    ) {
      throw storageError(
        'UNSAFE_STAGING',
        'GitHub template download file changed during inspection',
      );
    }
    const result = Object.freeze({
      stagingPath,
      bytes: received,
      sha256: actualSha256,
      inspection: deepFreeze(inspection),
    });
    STAGED_DOWNLOAD_AUTHORITIES.set(result, {
      result,
      projectRoot,
      stagingRoot,
      stagingDirectory,
      stagingPath,
      projectDevice: projectStat.dev,
      projectInode: projectStat.ino,
      stagingDevice: finalStat.dev,
      stagingInode: finalStat.ino,
      bytes: received,
      sha256: actualSha256,
      ioSeam: snapshot.ioSeam,
      state: 'active',
    });
    return result;
  } catch (error) {
    primaryError = error;
    if (isInternalStorageError(error)) throw error;
    throw storageError('IO_FAILURE', 'GitHub template download storage failed');
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the primary stable error below.
      }
    }
    if (primaryError !== undefined && ownsStaging) {
      try {
        cleanupOwnedStaging(
          stagingDirectory,
          stagingPath,
          projectStat.dev,
          snapshot.ioSeam,
        );
      } catch {
        // Cleanup is best effort and must never replace the primary error.
      }
    }
  }
}
