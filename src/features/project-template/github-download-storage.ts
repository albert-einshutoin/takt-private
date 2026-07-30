import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { types } from 'node:util';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import {
  inspectTaktpack,
  inspectTaktpackCachePublicationAlias,
} from './archive-inspector.js';
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
const MAX_DOWNLOAD_CHUNK_BYTES = 1024 * 1024;
// This bounds Promise/callback churn while still allowing an average chunk
// size of only 5 KiB at the 40 MiB archive ceiling.
const MAX_DOWNLOAD_CHUNKS = 8_192;
const MAX_EMPTY_DOWNLOAD_CHUNKS = 1_024;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength',
)!.get!;

export type GithubTemplateDownloadStorageErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_AUTHORITY'
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
const MATERIALIZED_CACHE_RECEIPT_AUTHORITIES = new WeakMap<
  object,
  { state: 'active' | 'consuming' | 'consumed' }
>();
const MATERIALIZED_CACHE_RECEIPT_CLAIMS = new WeakSet<object>();
const STAGING_DIRECTORY_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CACHE_TEMP_NAME_PATTERN =
  /^\.tmp\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-f0-9]{64}$/;
const CACHE_TEMP_PARSE_PATTERN =
  /^\.tmp\.([1-9]\d*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([a-f0-9]{64})$/;
const CACHE_RECLAIM_SCAN_LIMIT = 8192;
const CACHE_RECLAIM_DELETE_LIMIT = 32;
const NATIVE_PROCESS_KILL = process.kill.bind(process);

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
  | 'before-cache-temp-fsync'
  | 'before-cache-link'
  | 'before-cache-publish-parent-fsync'
  | 'before-cache-temp-unlink'
  | 'before-cache-temp-unlink-parent-fsync'
  | 'before-cache-reclaim-unlink'
  | 'after-cache-reclaim-unlink'
  | 'before-cache-reclaim-fsync'
  | 'before-staging-cleanup';

export interface GithubTemplateCacheIoSeam {
  onCachePhase?(phase: GithubTemplateCachePhase, path: string): void;
  cacheFsync?(fd: number): void;
  cacheRead?(
    fd: number,
    chunk: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  cacheLink?(tempPath: string, finalPath: string): void;
  cacheUnlink?(path: string): void;
  cacheClose?(
    fd: number,
    kind: 'temporary' | 'final' | 'directory',
  ): void;
  cacheProcessProbe?(
    pid: number,
  ): 'alive' | 'missing' | 'inaccessible';
  cacheReclaimClose?(kind: 'directory-stream'): void;
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

export interface ClaimedMaterializedGithubTemplateCache {
  readonly materialized: MaterializedGithubTemplateCache;
}

export function claimMaterializedGithubTemplateCacheForReceipt(
  value: unknown,
): ClaimedMaterializedGithubTemplateCache {
  const authority = (
    typeof value === 'object' && value !== null
      ? MATERIALIZED_CACHE_RECEIPT_AUTHORITIES.get(value)
      : undefined
  );
  if (
    authority === undefined
    || !MATERIALIZED_CACHE_RESULTS.has(value as object)
    || authority.state !== 'active'
  ) {
    throw storageError(
      'INVALID_AUTHORITY',
      'GitHub template materialized cache authority is invalid',
    );
  }
  authority.state = 'consuming';
  const claim = Object.freeze({
    materialized: value as MaterializedGithubTemplateCache,
  });
  MATERIALIZED_CACHE_RECEIPT_CLAIMS.add(claim);
  return claim;
}

export function consumeMaterializedGithubTemplateCacheReceiptClaim(
  claim: ClaimedMaterializedGithubTemplateCache,
): void {
  const isOriginalClaim = (
    typeof claim === 'object'
    && claim !== null
    && MATERIALIZED_CACHE_RECEIPT_CLAIMS.has(claim)
  );
  const materialized = isOriginalClaim ? claim.materialized : undefined;
  const authority = materialized === undefined
    ? undefined
    : MATERIALIZED_CACHE_RECEIPT_AUTHORITIES.get(materialized);
  if (authority === undefined || authority.state !== 'consuming') {
    throw storageError(
      'INVALID_AUTHORITY',
      'GitHub template materialized cache claim is invalid',
    );
  }
  MATERIALIZED_CACHE_RECEIPT_CLAIMS.delete(claim);
  authority.state = 'consumed';
}

export interface ReclaimGithubTemplateCacheTempsOptions {
  readonly cacheRoot?: string;
  readonly ioSeam?: GithubTemplateCacheIoSeam;
}

export interface ReclaimedGithubTemplateCacheTemps {
  readonly scanned: number;
  readonly matched: number;
  readonly deadCandidates: number;
  readonly reclaimed: number;
  readonly skipped: number;
  readonly unsafeRetained: number;
  readonly truncated: boolean;
  readonly status:
    | 'complete'
    | 'scan-limit'
    | 'delete-limit'
    | 'unsafe-retained';
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
  readonly ioSeam?: DownloadStorageIoSnapshot;
  state: 'active' | 'consuming' | 'consumed';
}

interface StageGithubTemplateDownloadSnapshot {
  readonly projectRoot: string;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignalSnapshot;
  readonly ioSeam?: DownloadStorageIoSnapshot;
}

interface DownloadStorageIoSnapshot {
  readonly receiver: GithubTemplateDownloadStorageIoSeam;
  readonly onPhase?: GithubTemplateDownloadStorageIoSeam['onPhase'];
  readonly write?: GithubTemplateDownloadStorageIoSeam['write'];
}

interface AbortSignalSnapshot {
  readonly aborted: () => boolean;
  readonly addAbortListener: (listener: () => void) => void;
  readonly removeAbortListener: (listener: () => void) => void;
}

interface DownloadIteratorSnapshot {
  readonly receiver: AsyncIterator<unknown>;
  readonly next: AsyncIterator<unknown>['next'];
  readonly close?: AsyncIterator<unknown>['return'];
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
  ioSeam: DownloadStorageIoSnapshot | undefined,
  phase: GithubTemplateDownloadStoragePhase,
  path: string,
): void {
  try {
    if (ioSeam?.onPhase !== undefined) {
      Reflect.apply(ioSeam.onPhase, ioSeam.receiver, [phase, path]);
    }
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

function throwIfAborted(signal: AbortSignalSnapshot | undefined): void {
  let aborted = false;
  try {
    aborted = signal?.aborted() === true;
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
  ioSeam?: DownloadStorageIoSnapshot,
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

function snapshotIoSeam(
  value: unknown,
): DownloadStorageIoSnapshot | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = ['onPhase', 'write'];
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || !allowed.includes(key),
    )
    || Object.entries(descriptors).some(
      ([key, descriptor]) => (
        !('value' in descriptor)
        || typeof descriptor.value !== 'function'
        || !allowed.includes(key)
      ),
    )
  ) throw new Error();
  return Object.freeze({
    receiver: value,
    ...(descriptors['onPhase'] === undefined
      ? {}
      : {
        onPhase: descriptors['onPhase'].value as
          GithubTemplateDownloadStorageIoSeam['onPhase'],
      }),
    ...(descriptors['write'] === undefined
      ? {}
      : {
        write: descriptors['write'].value as
          GithubTemplateDownloadStorageIoSeam['write'],
      }),
  });
}

function snapshotAbortSignal(
  value: unknown,
): AbortSignalSnapshot | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || types.isProxy(value)) {
    throw new Error();
  }
  const abortedGetter = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    'aborted',
  )?.get;
  if (abortedGetter !== undefined) {
    try {
      Reflect.apply(abortedGetter, value, []);
      return Object.freeze({
        aborted: () => Reflect.apply(abortedGetter, value, []) as boolean,
        addAbortListener: (listener: () => void) => {
          Reflect.apply(EventTarget.prototype.addEventListener, value, [
            'abort',
            listener,
            { once: true },
          ]);
        },
        removeAbortListener: (listener: () => void) => {
          Reflect.apply(EventTarget.prototype.removeEventListener, value, [
            'abort',
            listener,
          ]);
        },
      });
    } catch {
      // Test doubles are accepted only as exact plain data records below.
    }
  }
  if (
    Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== 3
    || !('value' in descriptors['aborted']!)
    || typeof descriptors['aborted']!.value !== 'boolean'
    || !('value' in descriptors['addEventListener']!)
    || typeof descriptors['addEventListener']!.value !== 'function'
    || !('value' in descriptors['removeEventListener']!)
    || typeof descriptors['removeEventListener']!.value !== 'function'
  ) throw new Error();
  const receiver = value as AbortSignal;
  const aborted = descriptors['aborted']!.value as boolean;
  const add = descriptors['addEventListener']!.value as
    AbortSignal['addEventListener'];
  const remove = descriptors['removeEventListener']!.value as
    AbortSignal['removeEventListener'];
  return Object.freeze({
    aborted: () => aborted,
    addAbortListener: (listener: () => void) => {
      Reflect.apply(add, receiver, ['abort', listener, { once: true }]);
    },
    removeAbortListener: (listener: () => void) => {
      Reflect.apply(remove, receiver, ['abort', listener]);
    },
  });
}

function snapshotOptions(
  value: StageGithubTemplateDownloadOptions,
): StageGithubTemplateDownloadSnapshot {
  try {
    if (
      typeof value !== 'object'
      || value === null
      || types.isProxy(value)
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
      || types.isProxy(chunks)
    ) {
      throw new Error();
    }
    const signalSnapshot = snapshotAbortSignal(signal);
    const ioSnapshot = snapshotIoSeam(ioSeam);
    return {
      projectRoot,
      expectedBytes,
      expectedSha256,
      chunks: chunks as AsyncIterable<Uint8Array>,
      ...(signalSnapshot === undefined ? {} : { signal: signalSnapshot }),
      ...(ioSnapshot === undefined ? {} : { ioSeam: ioSnapshot }),
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
): DownloadIteratorSnapshot {
  try {
    if (types.isProxy(chunks)) throw new Error();
    const createIterator = chunks[Symbol.asyncIterator];
    if (typeof createIterator !== 'function') throw new Error();
    const iterator = createIterator.call(chunks) as AsyncIterator<unknown>;
    if (
      (typeof iterator !== 'object' || iterator === null)
      && typeof iterator !== 'function'
    ) {
      throw new Error();
    }
    if (types.isProxy(iterator)) throw new Error();
    const next = iterator.next;
    const close = iterator.return;
    if (
      typeof next !== 'function'
      || (close !== undefined && typeof close !== 'function')
    ) throw new Error();
    return Object.freeze({
      receiver: iterator,
      next,
      ...(close === undefined ? {} : { close }),
    });
  } catch {
    throw storageError(
      'STREAM_FAILED',
      'GitHub template download stream failed',
    );
  }
}

async function readDownloadChunk(
  iterator: DownloadIteratorSnapshot,
  signal: AbortSignalSnapshot | undefined,
): Promise<{ done: boolean; value: unknown }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      action: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      try {
        signal?.removeAbortListener(onAbort);
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
      if (signal?.aborted()) {
        onAbort();
        return;
      }
      signal?.addAbortListener(onAbort);
      if (settled) return;
      const pending = Reflect.apply(
        iterator.next,
        iterator.receiver,
        [],
      );
      if (
        (typeof pending === 'object' && pending !== null)
        || typeof pending === 'function'
      ) {
        if (types.isProxy(pending)) throw new Error();
      }
      Promise.resolve(pending).then(
        (result) => {
          if (settled) return;
          try {
            if (
              typeof result !== 'object'
              || result === null
              || types.isProxy(result)
              || Object.getPrototypeOf(result) !== Object.prototype
            ) {
              throw new Error();
            }
            const descriptors = Object.getOwnPropertyDescriptors(result);
            if (
              Reflect.ownKeys(result).some(
                (key) => key !== 'done' && key !== 'value',
              )
              || Object.values(descriptors).some(
                (descriptor) => !('value' in descriptor),
              )
            ) throw new Error();
            const doneDescriptor = descriptors['done'];
            if (
              doneDescriptor === undefined
              || !('value' in doneDescriptor)
              || typeof doneDescriptor.value !== 'boolean'
            ) throw new Error();
            const done = doneDescriptor.value;
            // A completed iterator's value is intentionally never observed.
            const valueDescriptor = descriptors['value'];
            if (
              !done
              && (
                valueDescriptor === undefined
                || !('value' in valueDescriptor)
              )
            ) throw new Error();
            const value = done ? undefined : valueDescriptor!.value;
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
  iterator: DownloadIteratorSnapshot,
): void {
  try {
    const close = iterator.close;
    if (typeof close === 'function') {
      void Promise.resolve(Reflect.apply(
        close,
        iterator.receiver,
        [],
      )).catch(() => undefined);
    }
  } catch {
    // Iterator cleanup is best effort and never replaces the primary error.
  }
}

function snapshotDownloadChunk(
  value: unknown,
  remaining: number,
): Uint8Array {
  try {
    if (
      typeof value !== 'object'
      || value === null
      || types.isProxy(value)
    ) throw new Error();
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
    if (
      !Number.isSafeInteger(byteLength)
      || byteLength < 0
    ) throw new Error();
    if (
      byteLength > MAX_DOWNLOAD_CHUNK_BYTES
      || byteLength > remaining
    ) {
      throw storageError(
        'LIMIT_EXCEEDED',
        'GitHub template download exceeded its byte limit',
      );
    }
    const snapshot = new Uint8Array(byteLength);
    Uint8Array.prototype.set.call(snapshot, value as Uint8Array);
    if (
      Reflect.apply(
        TYPED_ARRAY_BYTE_LENGTH_GETTER,
        value,
        [],
      ) !== byteLength
    ) throw new Error();
    return snapshot;
  } catch (error) {
    if (isInternalStorageError(error)) throw error;
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
  ioSeam: DownloadStorageIoSnapshot | undefined,
): number {
  let written: number;
  try {
    written = ioSeam?.write === undefined
      ? writeSync(fd, chunk, offset, length, position)
      : Reflect.apply(ioSeam.write, ioSeam.receiver, [
        fd,
        chunk,
        offset,
        length,
        position,
      ]);
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
  ioSeam: DownloadStorageIoSnapshot | undefined,
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

function syncCacheDirectoryDescriptor(
  fd: number,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): void {
  if (process.platform === 'win32') return;
  try {
    // This seam keeps the real fsync failure contract deterministic in tests;
    // production always takes the native branch.
    if (ioSeam?.cacheFsync !== undefined) {
      ioSeam.cacheFsync(fd);
    } else {
      fsyncSync(fd);
    }
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache directory sync failed',
      'cache-published',
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

interface PreparedCacheDirectory {
  readonly shaRoot: string;
  readonly device: number;
  readonly shaRootFd: number;
  readonly shaRootInode: number;
}

interface ReclaimCandidateAuthority {
  readonly path: string;
  readonly finalPath?: string;
  readonly fd: number;
  readonly finalFd?: number;
  readonly inode: number;
  readonly bytes: number;
  readonly links: 1 | 2;
  readonly sha256: string;
}

function cacheOwnerState(
  pid: number,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): 'alive' | 'missing' | 'inaccessible' {
  if (pid === process.pid) return 'alive';
  let seamProbe: GithubTemplateCacheIoSeam['cacheProcessProbe'];
  try {
    seamProbe = ioSeam?.cacheProcessProbe;
  } catch {
    return 'inaccessible';
  }
  if (seamProbe !== undefined) {
    try {
      const result = Reflect.apply(seamProbe, ioSeam, [pid]) as unknown;
      return (
        result === 'alive'
        || result === 'missing'
        || result === 'inaccessible'
      )
        ? result
        : 'inaccessible';
    } catch {
      // A seam exception is untrusted input, not native ESRCH evidence.
      return 'inaccessible';
    }
  }
  try {
    NATIVE_PROCESS_KILL(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? 'missing' : 'inaccessible';
  }
}

function cachePathIsAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function isOwnedPrivateCacheFile(
  stat: Stats,
  expectedDevice: number,
  expectedLinks: 1 | 2,
): boolean {
  const expectedUid = typeof process.getuid === 'function'
    ? process.getuid()
    : undefined;
  return (
    stat.isFile()
    && stat.dev === expectedDevice
    && stat.nlink === expectedLinks
    && stat.size <= DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes
    && isProjectTemplatePrivateFileMode(stat.mode)
    && (expectedUid === undefined || stat.uid === expectedUid)
  );
}

async function openReclaimCandidate(
  cache: PreparedCacheDirectory,
  name: string,
  sha256: string,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): Promise<ReclaimCandidateAuthority | undefined> {
  const path = join(cache.shaRoot, name);
  const finalPath = join(cache.shaRoot, `${sha256}.taktpack`);
  let fd: number | undefined;
  let finalFd: number | undefined;
  let candidate: ReclaimCandidateAuthority | undefined;
  let closeError: GithubTemplateDownloadStorageError | undefined;
  const unsafeCandidate = Symbol('unsafe cache reclaim candidate');
  try {
    const pathStat = lstatSync(path);
    if (
      pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || (pathStat.nlink !== 1 && pathStat.nlink !== 2)
      || realpathSync.native(path) !== path
    ) throw unsafeCandidate;
    const links = pathStat.nlink;
    if (!isOwnedPrivateCacheFile(pathStat, cache.device, links)) {
      throw unsafeCandidate;
    }
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (
      !isOwnedPrivateCacheFile(opened, cache.device, links)
      || opened.dev !== pathStat.dev
      || opened.ino !== pathStat.ino
      || opened.size !== pathStat.size
    ) throw unsafeCandidate;

    if (links === 1) {
      // A sole temporary inode is reclaimable only when no canonical entry
      // exists; otherwise an interrupted replacement cannot be distinguished.
      if (!cachePathIsAbsent(finalPath)) throw unsafeCandidate;
    } else {
      const finalStat = lstatSync(finalPath);
      if (
        finalStat.isSymbolicLink()
        || realpathSync.native(finalPath) !== finalPath
        || !isOwnedPrivateCacheFile(finalStat, cache.device, 2)
        || finalStat.ino !== opened.ino
        || finalStat.size !== opened.size
      ) throw unsafeCandidate;
      finalFd = openSync(finalPath, constants.O_RDONLY | noFollow);
      const finalOpened = fstatSync(finalFd);
      if (
        !isOwnedPrivateCacheFile(finalOpened, cache.device, 2)
        || finalOpened.ino !== opened.ino
        || finalOpened.size !== opened.size
        || hashCacheDescriptor(finalFd, finalOpened.size) !== sha256
      ) throw unsafeCandidate;
      let inspection: TaktpackInspectResult;
      try {
        inspection = await inspectTaktpackCachePublicationAlias(finalPath, {
          limits: {
            maxArchiveBytes: DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes,
          },
        });
      } catch {
        throw unsafeCandidate;
      }
      const afterTemp = lstatSync(path);
      const afterFinal = lstatSync(finalPath);
      const afterTempFd = fstatSync(fd);
      const afterFinalFd = fstatSync(finalFd);
      if (
        inspection.archiveSha256 !== sha256
        || !isOwnedPrivateCacheFile(afterTemp, cache.device, 2)
        || !isOwnedPrivateCacheFile(afterFinal, cache.device, 2)
        || !isOwnedPrivateCacheFile(afterTempFd, cache.device, 2)
        || !isOwnedPrivateCacheFile(afterFinalFd, cache.device, 2)
        || [
          afterTemp.ino,
          afterFinal.ino,
          afterTempFd.ino,
          afterFinalFd.ino,
        ].some((inode) => inode !== opened.ino)
        || [
          afterTemp.size,
          afterFinal.size,
          afterTempFd.size,
          afterFinalFd.size,
        ].some((bytes) => bytes !== opened.size)
        || hashCacheDescriptor(fd, opened.size) !== sha256
      ) throw unsafeCandidate;
    }

    const retainedFd = fd;
    fd = undefined;
    const retainedFinalFd = finalFd;
    finalFd = undefined;
    candidate = {
      path,
      ...(links === 2 ? { finalPath } : {}),
      fd: retainedFd,
      ...(retainedFinalFd === undefined
        ? {}
        : { finalFd: retainedFinalFd }),
      inode: opened.ino,
      bytes: opened.size,
      links,
      sha256,
    };
  } catch {
    candidate = undefined;
  } finally {
    if (finalFd !== undefined) {
      closeError = closeReclaimDescriptor(finalFd, 'final', ioSeam);
    }
    if (fd !== undefined) {
      const tempCloseError = closeReclaimDescriptor(
        fd,
        'temporary',
        ioSeam,
      );
      closeError ??= tempCloseError;
    }
  }
  if (closeError !== undefined) throw closeError;
  return candidate;
}

function revalidateReclaimCandidate(
  candidate: ReclaimCandidateAuthority,
  cache: PreparedCacheDirectory,
): boolean {
  try {
    requireOwnedCacheTemp(
      candidate.path,
      candidate.fd,
      cache.device,
      candidate.inode,
      candidate.bytes,
      candidate.links,
    );
    if (candidate.links === 1) {
      return cachePathIsAbsent(
        join(cache.shaRoot, `${basename(candidate.path).slice(-64)}.taktpack`),
      );
    }
    if (candidate.finalPath === undefined || candidate.finalFd === undefined) {
      return false;
    }
    const finalStat = lstatSync(candidate.finalPath);
    const finalOpened = fstatSync(candidate.finalFd);
    return (
      !finalStat.isSymbolicLink()
      && isOwnedPrivateCacheFile(finalStat, cache.device, 2)
      && isOwnedPrivateCacheFile(finalOpened, cache.device, 2)
      && finalStat.ino === candidate.inode
      && finalOpened.ino === candidate.inode
      && finalStat.size === candidate.bytes
      && finalOpened.size === candidate.bytes
      && realpathSync.native(candidate.finalPath) === candidate.finalPath
      && hashCacheDescriptor(candidate.fd, candidate.bytes)
        === candidate.sha256
      && hashCacheDescriptor(candidate.finalFd, candidate.bytes)
        === candidate.sha256
    );
  } catch {
    return false;
  }
}

function revalidateReclaimedFinal(
  candidate: ReclaimCandidateAuthority,
  cache: PreparedCacheDirectory,
): void {
  try {
    if (
      candidate.links !== 2
      || candidate.finalPath === undefined
      || candidate.finalFd === undefined
    ) throw new Error();
    const finalStat = lstatSync(candidate.finalPath);
    const finalOpened = fstatSync(candidate.finalFd);
    const tempOpened = fstatSync(candidate.fd);
    if (
      finalStat.isSymbolicLink()
      || !isOwnedPrivateCacheFile(finalStat, cache.device, 1)
      || !isOwnedPrivateCacheFile(finalOpened, cache.device, 1)
      || !isOwnedPrivateCacheFile(tempOpened, cache.device, 1)
      || finalStat.ino !== candidate.inode
      || finalOpened.ino !== candidate.inode
      || tempOpened.ino !== candidate.inode
      || finalStat.size !== candidate.bytes
      || finalOpened.size !== candidate.bytes
      || tempOpened.size !== candidate.bytes
      || realpathSync.native(candidate.finalPath) !== candidate.finalPath
      || hashCacheDescriptor(candidate.finalFd, candidate.bytes)
        !== candidate.sha256
      || hashCacheDescriptor(candidate.fd, candidate.bytes)
        !== candidate.sha256
    ) throw new Error();
  } catch {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache reclaimed final changed',
      'cache-published',
    );
  }
}

function closeReclaimDescriptor(
  fd: number,
  kind: 'temporary' | 'final' | 'directory',
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): GithubTemplateDownloadStorageError | undefined {
  let failed = false;
  try {
    ioSeam?.cacheClose?.(fd, kind);
  } catch {
    failed = true;
  }
  try {
    closeSync(fd);
  } catch {
    failed = true;
  }
  return failed
    ? storageError(
      'IO_FAILURE',
      'GitHub template cache reclaim descriptor close failed',
    )
    : undefined;
}

function closeReclaimDirectoryStream(
  directory: ReturnType<typeof opendirSync>,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): GithubTemplateDownloadStorageError | undefined {
  let failed = false;
  try {
    ioSeam?.cacheReclaimClose?.('directory-stream');
  } catch {
    failed = true;
  }
  try {
    directory.closeSync();
  } catch {
    failed = true;
  }
  return failed
    ? storageError(
      'IO_FAILURE',
      'GitHub template cache reclaim directory close failed',
    )
    : undefined;
}

async function reclaimPreparedGithubTemplateCacheTemps(
  cache: PreparedCacheDirectory,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): Promise<ReclaimedGithubTemplateCacheTemps> {
  let scanned = 0;
  let matched = 0;
  let deadCandidates = 0;
  let reclaimed = 0;
  let skipped = 0;
  let unsafeRetained = 0;
  let truncated = false;
  let status: ReclaimedGithubTemplateCacheTemps['status'] = 'complete';
  let directory: ReturnType<typeof opendirSync> | undefined;
  let deletedAny = false;
  let primaryError: GithubTemplateDownloadStorageError | undefined;
  const retainedCandidates = new Set<ReclaimCandidateAuthority>();
  const reclaimedLinkedCandidates: ReclaimCandidateAuthority[] = [];

  const rememberError = (error: unknown): void => {
    if (primaryError !== undefined) return;
    primaryError = isInternalStorageError(error)
      ? error
      : storageError(
        'IO_FAILURE',
        'GitHub template cache reclaim failed',
      );
  };
  const closeCandidate = (
    candidate: ReclaimCandidateAuthority,
  ): GithubTemplateDownloadStorageError | undefined => {
    retainedCandidates.delete(candidate);
    let closeError: GithubTemplateDownloadStorageError | undefined;
    if (candidate.finalFd !== undefined) {
      closeError = closeReclaimDescriptor(
        candidate.finalFd,
        'final',
        ioSeam,
      );
    }
    const tempCloseError = closeReclaimDescriptor(
      candidate.fd,
      'temporary',
      ioSeam,
    );
    return closeError ?? tempCloseError;
  };

  try {
    assertCacheDirectoryAuthority(
      cache.shaRoot,
      cache.shaRootFd,
      cache.device,
      cache.shaRootInode,
    );
    directory = opendirSync(cache.shaRoot);
    while (scanned < CACHE_RECLAIM_SCAN_LIMIT) {
      if (reclaimed >= CACHE_RECLAIM_DELETE_LIMIT) {
        truncated = true;
        status = 'delete-limit';
        break;
      }
      const entry = directory.readSync();
      if (entry === null) break;
      scanned += 1;
      const match = CACHE_TEMP_PARSE_PATTERN.exec(entry.name);
      if (match === null) continue;
      matched += 1;
      const pid = Number(match[1]);
      if (
        !Number.isSafeInteger(pid)
        || cacheOwnerState(pid, ioSeam) !== 'missing'
      ) {
        skipped += 1;
        continue;
      }
      deadCandidates += 1;
      assertCacheDirectoryAuthority(
        cache.shaRoot,
        cache.shaRootFd,
        cache.device,
        cache.shaRootInode,
      );
      const candidate = await openReclaimCandidate(
        cache,
        entry.name,
        match[3]!,
        ioSeam,
      );
      assertCacheDirectoryAuthority(
        cache.shaRoot,
        cache.shaRootFd,
        cache.device,
        cache.shaRootInode,
      );
      if (candidate === undefined) {
        skipped += 1;
        unsafeRetained += 1;
        continue;
      }
      retainedCandidates.add(candidate);
      runCachePhase(
        ioSeam,
        'before-cache-reclaim-unlink',
        candidate.path,
      );
      assertCacheDirectoryAuthority(
        cache.shaRoot,
        cache.shaRootFd,
        cache.device,
        cache.shaRootInode,
      );
      // The untrusted probe runs before the final synchronous path/FD/hash
      // validation. No seam executes between that validation and unlink.
      const ownerStillMissing = cacheOwnerState(pid, ioSeam) === 'missing';
      const reclaimable = (
        ownerStillMissing
        && revalidateReclaimCandidate(candidate, cache)
      );
      if (!reclaimable) {
        skipped += 1;
        unsafeRetained += 1;
        const closeError = closeCandidate(candidate);
        if (closeError !== undefined) throw closeError;
        continue;
      }
      try {
        unlinkOwnedCacheTemp(
          candidate.path,
          cache.device,
          candidate.inode,
          candidate.links,
        );
      } catch (error) {
        if (isInternalStorageError(error)) throw error;
        throw storageError(
          'IO_FAILURE',
          'GitHub template cache reclaim unlink failed',
        );
      }
      reclaimed += 1;
      deletedAny = true;
      if (candidate.links === 2) {
        reclaimedLinkedCandidates.push(candidate);
      }
      runCachePhase(
        ioSeam,
        'after-cache-reclaim-unlink',
        candidate.path,
      );
      if (candidate.links === 2) {
        revalidateReclaimedFinal(candidate, cache);
      } else {
        const closeError = closeCandidate(candidate);
        if (closeError !== undefined) throw closeError;
      }
    }
    if (scanned === CACHE_RECLAIM_SCAN_LIMIT && status === 'complete') {
      truncated = true;
      status = 'scan-limit';
    }
  } catch (error) {
    rememberError(error);
  } finally {
    if (directory !== undefined) {
      const closeError = closeReclaimDirectoryStream(directory, ioSeam);
      if (closeError !== undefined) rememberError(closeError);
    }

    if (deletedAny && process.platform !== 'win32') {
      try {
        runCachePhase(ioSeam, 'before-cache-reclaim-fsync', cache.shaRoot);
        assertCacheDirectoryAuthority(
          cache.shaRoot,
          cache.shaRootFd,
          cache.device,
          cache.shaRootInode,
        );
        syncCacheDirectoryDescriptor(cache.shaRootFd, ioSeam);
      } catch (error) {
        rememberError(error);
      }
    }
    try {
      assertCacheDirectoryAuthority(
        cache.shaRoot,
        cache.shaRootFd,
        cache.device,
        cache.shaRootInode,
      );
    } catch (error) {
      rememberError(error);
    }
    for (const candidate of reclaimedLinkedCandidates) {
      try {
        revalidateReclaimedFinal(candidate, cache);
      } catch (error) {
        rememberError(error);
      }
    }
    for (const candidate of [...retainedCandidates]) {
      const closeError = closeCandidate(candidate);
      if (closeError !== undefined) rememberError(closeError);
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (status === 'complete' && unsafeRetained > 0) {
    status = 'unsafe-retained';
  }
  return Object.freeze({
    scanned,
    matched,
    deadCandidates,
    reclaimed,
    skipped,
    unsafeRetained,
    truncated,
    status,
  });
}

function snapshotReclaimOptions(
  value: ReclaimGithubTemplateCacheTempsOptions,
): ReclaimGithubTemplateCacheTempsOptions {
  try {
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) throw new Error();
    const allowed = new Set(['cacheRoot', 'ioSeam']);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(value).some(
        (key) => typeof key !== 'string' || !allowed.has(key),
      )
      || Object.values(descriptors).some(
        (descriptor) => !('value' in descriptor),
      )
    ) throw new Error();
    const cacheRoot = descriptors['cacheRoot']?.value as unknown;
    const ioSeam = descriptors['ioSeam']?.value as unknown;
    if (
      (cacheRoot !== undefined && typeof cacheRoot !== 'string')
      || (
        ioSeam !== undefined
        && (typeof ioSeam !== 'object' || ioSeam === null)
      )
    ) throw new Error();
    return Object.freeze({
      ...(cacheRoot === undefined ? {} : { cacheRoot }),
      ...(ioSeam === undefined
        ? {}
        : { ioSeam: ioSeam as GithubTemplateCacheIoSeam }),
    });
  } catch {
    throw storageError(
      'INVALID_ARGUMENT',
      'GitHub template cache reclaim options are invalid',
    );
  }
}

export async function reclaimGithubTemplateCacheTemps(
  value: ReclaimGithubTemplateCacheTempsOptions = {},
): Promise<ReclaimedGithubTemplateCacheTemps> {
  const options = snapshotReclaimOptions(value);
  const cache = prepareCacheDirectories(options.cacheRoot, options.ioSeam);
  let result: ReclaimedGithubTemplateCacheTemps | undefined;
  let primaryError: unknown;
  try {
    result = await reclaimPreparedGithubTemplateCacheTemps(
      cache,
      options.ioSeam,
    );
  } catch (error) {
    primaryError = error;
  }
  const closeError = closeReclaimDescriptor(
    cache.shaRootFd,
    'directory',
    options.ioSeam,
  );
  if (primaryError !== undefined) throw primaryError;
  if (closeError !== undefined) throw closeError;
  return result!;
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
): Promise<{
  readonly fd: number;
  readonly inode: number;
  readonly inspection: TaktpackInspectResult;
}> {
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
    const retainedFd = fd;
    fd = undefined;
    return {
      fd: retainedFd,
      inode: opened.ino,
      inspection,
    };
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

function assertCacheFinalAuthority(
  path: string,
  fd: number,
  expectedDevice: number,
  expectedInode: number,
  authority: StagedGithubTemplateDownloadAuthority,
): void {
  try {
    const pathStat = lstatSync(path);
    const opened = fstatSync(fd);
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(path) !== path
    ) throw new Error();
    requireCacheFileIdentity(pathStat, expectedDevice, authority.bytes);
    requireCacheFileIdentity(opened, expectedDevice, authority.bytes);
    if (
      pathStat.ino !== expectedInode
      || opened.ino !== expectedInode
      || hashCacheDescriptor(fd, authority.bytes) !== authority.sha256
    ) throw new Error();
  } catch {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache file authority changed',
      'cache-published',
    );
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

function storageArtifactExists(path: string | undefined): boolean {
  if (path === undefined) return false;
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function classifyMaterializationArtifacts(
  authority: StagedGithubTemplateDownloadAuthority,
  artifacts: CachePublicationArtifacts,
): 'none' | 'staging-only' | 'cache-published' {
  if (storageArtifactExists(artifacts.finalPath)) {
    return 'cache-published';
  }
  if (
    storageArtifactExists(artifacts.tempPath)
    || storageArtifactExists(authority.stagingPath)
  ) {
    return 'staging-only';
  }
  return 'none';
}

function syncCacheFileDescriptor(
  fd: number,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): void {
  try {
    if (ioSeam?.cacheFsync !== undefined) {
      ioSeam.cacheFsync(fd);
    } else {
      fsyncSync(fd);
    }
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache file sync failed',
      'staging-only',
    );
  }
}

function closeCacheDescriptor(
  fd: number,
  kind: 'temporary' | 'final' | 'directory',
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): void {
  try {
    ioSeam?.cacheClose?.(fd, kind);
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache close hook failed',
      'cache-published',
    );
  }
  closeSync(fd);
}

function readCacheCopyChunk(
  fd: number,
  buffer: Uint8Array,
  length: number,
  position: number,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): number {
  let bytesRead: number;
  try {
    bytesRead = ioSeam?.cacheRead?.(
      fd,
      buffer,
      0,
      length,
      position,
    ) ?? readSync(fd, buffer, 0, length, position);
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache source read failed',
      'staging-only',
    );
  }
  if (
    !Number.isSafeInteger(bytesRead)
    || bytesRead <= 0
    || bytesRead > length
  ) {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache source read made invalid progress',
      'staging-only',
    );
  }
  return bytesRead;
}

function writeCacheCopyChunk(
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
): number {
  let written: number;
  try {
    written = ioSeam?.cacheWrite?.(
      fd,
      buffer,
      offset,
      length,
      position,
    ) ?? writeSync(fd, buffer, offset, length, position);
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache write failed',
      'staging-only',
    );
  }
  if (
    !Number.isSafeInteger(written)
    || written <= 0
    || written > length
  ) {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache write made invalid progress',
      'staging-only',
    );
  }
  return written;
}

function requireOwnedCacheTemp(
  path: string,
  fd: number,
  expectedDevice: number,
  expectedInode: number,
  expectedBytes: number,
  expectedLinks: 1 | 2,
): void {
  try {
    const pathStat = lstatSync(path);
    const opened = fstatSync(fd);
    if (
      pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || !opened.isFile()
      || pathStat.dev !== expectedDevice
      || opened.dev !== expectedDevice
      || pathStat.ino !== expectedInode
      || opened.ino !== expectedInode
      || pathStat.nlink !== expectedLinks
      || opened.nlink !== expectedLinks
      || pathStat.size !== expectedBytes
      || opened.size !== expectedBytes
      || !isProjectTemplatePrivateFileMode(pathStat.mode)
      || !isProjectTemplatePrivateFileMode(opened.mode)
      || realpathSync.native(path) !== path
    ) throw new Error();
  } catch {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache temporary file changed',
      expectedLinks === 2 ? 'cache-published' : 'staging-only',
    );
  }
}

function unlinkOwnedCacheTemp(
  path: string,
  expectedDevice: number,
  expectedInode: number,
  expectedLinks: 1 | 2,
): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.dev !== expectedDevice
    || stat.ino !== expectedInode
    || stat.nlink !== expectedLinks
    || !isProjectTemplatePrivateFileMode(stat.mode)
    || realpathSync.native(path) !== path
  ) {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache temporary cleanup target changed',
    );
  }
  unlinkSync(path);
}

function requirePublishedTempAlias(
  tempPath: string,
  tempFd: number,
  finalPath: string,
  expectedDevice: number,
  expectedInode: number,
  expectedBytes: number,
): void {
  requireOwnedCacheTemp(
    tempPath,
    tempFd,
    expectedDevice,
    expectedInode,
    expectedBytes,
    2,
  );
  try {
    const finalStat = lstatSync(finalPath);
    if (
      finalStat.isSymbolicLink()
      || !finalStat.isFile()
      || finalStat.dev !== expectedDevice
      || finalStat.ino !== expectedInode
      || finalStat.nlink !== 2
      || finalStat.size !== expectedBytes
      || !isProjectTemplatePrivateFileMode(finalStat.mode)
      || realpathSync.native(finalPath) !== finalPath
    ) throw new Error();
  } catch {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache final alias changed',
      'staging-only',
    );
  }
}

function runCacheLinkSeam(
  ioSeam: GithubTemplateCacheIoSeam | undefined,
  tempPath: string,
  finalPath: string,
): void {
  try {
    ioSeam?.cacheLink?.(tempPath, finalPath);
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache link hook failed',
      'staging-only',
    );
  }
}

function runCacheUnlinkSeam(
  ioSeam: GithubTemplateCacheIoSeam | undefined,
  path: string,
): void {
  try {
    ioSeam?.cacheUnlink?.(path);
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache unlink hook failed',
      'cache-published',
    );
  }
}

interface CachePublicationArtifacts {
  cachePublished: boolean;
  tempPresent: boolean;
  tempPath?: string;
  finalPath?: string;
}

async function publishCacheMiss(
  cache: {
    shaRoot: string;
    device: number;
    shaRootFd: number;
    shaRootInode: number;
  },
  cachePath: string,
  stagingFd: number,
  authority: StagedGithubTemplateDownloadAuthority,
  ioSeam: GithubTemplateCacheIoSeam | undefined,
  artifactTracker: CachePublicationArtifacts,
): Promise<{
  readonly status: 'cache-hit' | 'cache-published';
  readonly verified: Awaited<ReturnType<typeof verifyExistingCacheFinal>>;
}> {
  const tempPath = join(
    cache.shaRoot,
    `.tmp.${process.pid}.${randomUUID()}.${authority.sha256}`,
  );
  if (
    dirname(tempPath) !== cache.shaRoot
    || !CACHE_TEMP_NAME_PATTERN.test(basename(tempPath))
  ) {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template cache temporary path is invalid',
      'staging-only',
    );
  }
  let tempFd: number | undefined;
  let tempInode: number | undefined;
  let tempExists = false;
  let linked = false;
  try {
    assertCacheDirectoryAuthority(
      cache.shaRoot,
      cache.shaRootFd,
      cache.device,
      cache.shaRootInode,
    );
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    tempFd = openSync(
      tempPath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | noFollow,
      0o600,
    );
    tempExists = true;
    artifactTracker.tempPresent = true;
    artifactTracker.tempPath = tempPath;
    const created = fstatSync(tempFd);
    tempInode = created.ino;
    if (
      !created.isFile()
      || created.dev !== cache.device
      || created.nlink !== 1
      || created.size !== 0
      || !isProjectTemplatePrivateFileMode(created.mode)
    ) {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template cache temporary file is unsafe',
        'staging-only',
      );
    }
    assertCacheDirectoryAuthority(
      cache.shaRoot,
      cache.shaRootFd,
      cache.device,
      cache.shaRootInode,
    );

    const digest = createHash('sha256');
    let position = 0;
    while (position < authority.bytes) {
      const length = Math.min(64 * 1024, authority.bytes - position);
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = readCacheCopyChunk(
        stagingFd,
        buffer,
        length,
        position,
        ioSeam,
      );
      let offset = 0;
      while (offset < bytesRead) {
        offset += writeCacheCopyChunk(
          tempFd,
          buffer,
          offset,
          bytesRead - offset,
          position + offset,
          ioSeam,
        );
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (
      readSync(stagingFd, Buffer.allocUnsafe(1), 0, 1, position) !== 0
      || digest.digest('hex') !== authority.sha256
    ) {
      throw storageError(
        'HASH_MISMATCH',
        'GitHub template cache copy digest changed',
        'staging-only',
      );
    }
    requireSealedDescriptor(fstatSync(stagingFd), authority);
    runCachePhase(ioSeam, 'before-cache-temp-fsync', tempPath);
    syncCacheFileDescriptor(tempFd, ioSeam);
    requireOwnedCacheTemp(
      tempPath,
      tempFd,
      cache.device,
      tempInode,
      authority.bytes,
      1,
    );
    let tempSha256: string;
    try {
      tempSha256 = hashCacheDescriptor(tempFd, authority.bytes);
    } catch {
      throw storageError(
        'IO_FAILURE',
        'GitHub template cache temporary verification failed',
        'staging-only',
      );
    }
    if (tempSha256 !== authority.sha256) {
      throw storageError(
        'HASH_MISMATCH',
        'GitHub template cache temporary digest changed',
        'staging-only',
      );
    }
    try {
      const inspection = await inspectTaktpack(tempPath, {
        limits: {
          maxArchiveBytes: DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes,
        },
      });
      if (inspection.archiveSha256 !== authority.sha256) throw new Error();
    } catch {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template cache temporary archive is invalid',
        'staging-only',
      );
    }
    requireOwnedCacheTemp(
      tempPath,
      tempFd,
      cache.device,
      tempInode,
      authority.bytes,
      1,
    );
    let inspectedTempSha256: string;
    try {
      inspectedTempSha256 = hashCacheDescriptor(tempFd, authority.bytes);
    } catch {
      throw storageError(
        'IO_FAILURE',
        'GitHub template cache temporary verification failed',
        'staging-only',
      );
    }
    if (inspectedTempSha256 !== authority.sha256) {
      throw storageError(
        'HASH_MISMATCH',
        'GitHub template cache temporary digest changed',
        'staging-only',
      );
    }

    assertCacheDirectoryAuthority(
      cache.shaRoot,
      cache.shaRootFd,
      cache.device,
      cache.shaRootInode,
    );
    runCachePhase(ioSeam, 'before-cache-link', tempPath);
    runCacheLinkSeam(ioSeam, tempPath, cachePath);
    try {
      linkSync(tempPath, cachePath);
      linked = true;
      artifactTracker.cachePublished = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A competing final is still a published artifact even before its
      // validity is known; never downgrade later failures to staging-only.
      artifactTracker.cachePublished = true;
    }

    if (linked) {
      requireOwnedCacheTemp(
        tempPath,
        tempFd,
        cache.device,
        tempInode,
        authority.bytes,
        2,
      );
      const finalBefore = lstatSync(cachePath);
      if (
        finalBefore.dev !== cache.device
        || finalBefore.ino !== tempInode
        || finalBefore.nlink !== 2
      ) {
        throw storageError(
          'CACHE_INVALID',
          'GitHub template cache hard-link publication changed',
          'cache-published',
        );
      }
      runCachePhase(
        ioSeam,
        'before-cache-publish-parent-fsync',
        cache.shaRoot,
      );
      assertCacheDirectoryAuthority(
        cache.shaRoot,
        cache.shaRootFd,
        cache.device,
        cache.shaRootInode,
      );
      syncCacheDirectoryDescriptor(cache.shaRootFd, ioSeam);
    }

    runCachePhase(ioSeam, 'before-cache-temp-unlink', tempPath);
    if (linked) {
      requirePublishedTempAlias(
        tempPath,
        tempFd,
        cachePath,
        cache.device,
        tempInode,
        authority.bytes,
      );
    }
    runCacheUnlinkSeam(ioSeam, tempPath);
    unlinkOwnedCacheTemp(
      tempPath,
      cache.device,
      tempInode,
      linked ? 2 : 1,
    );
    tempExists = false;
    artifactTracker.tempPresent = false;
    runCachePhase(
      ioSeam,
      'before-cache-temp-unlink-parent-fsync',
      cache.shaRoot,
    );
    assertCacheDirectoryAuthority(
      cache.shaRoot,
      cache.shaRootFd,
      cache.device,
      cache.shaRootInode,
    );
    syncCacheDirectoryDescriptor(cache.shaRootFd, ioSeam);
    assertCacheDirectoryAuthority(
      cache.shaRoot,
      cache.shaRootFd,
      cache.device,
      cache.shaRootInode,
    );
    closeCacheDescriptor(tempFd, 'temporary', ioSeam);
    tempFd = undefined;

    return {
      status: linked ? 'cache-published' : 'cache-hit',
      verified: await verifyExistingCacheFinal(
        cachePath,
        cache.device,
        authority,
        ioSeam,
      ),
    };
  } catch (error) {
    if (linked && isInternalStorageError(error)) throw error;
    if (isInternalStorageError(error)) throw error;
    throw storageError(
      'IO_FAILURE',
      'GitHub template cache publication failed',
      linked ? 'cache-published' : 'staging-only',
    );
  } finally {
    if (tempExists && tempInode !== undefined) {
      try {
        if (!linked || tempFd !== undefined) {
          if (linked && tempFd !== undefined) {
            requirePublishedTempAlias(
              tempPath,
              tempFd,
              cachePath,
              cache.device,
              tempInode,
              authority.bytes,
            );
          }
          unlinkOwnedCacheTemp(
            tempPath,
            cache.device,
            tempInode,
            linked ? 2 : 1,
          );
          artifactTracker.tempPresent = false;
          syncCacheDirectoryDescriptor(cache.shaRootFd, undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          artifactTracker.tempPresent = false;
        }
        // Never unlink a path whose sealed inode authority was lost.
      }
    }
    if (tempFd !== undefined) {
      try {
        closeSync(tempFd);
      } catch {
        // Preserve the publication outcome after owned path cleanup.
      }
    }
  }
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
  let cacheDirectoryPath: string | undefined;
  let cacheDirectoryDevice: number | undefined;
  let cacheDirectoryInode: number | undefined;
  let cacheFinalFd: number | undefined;
  let cacheFinalPath: string | undefined;
  let cacheFinalInode: number | undefined;
  const publicationArtifacts: CachePublicationArtifacts = {
    cachePublished: false,
    tempPresent: false,
  };
  try {
    const opened = await openVerifiedStagingAuthority(authority, 'consuming');
    stagingFd = opened.fd;
    const cache = prepareCacheDirectories(claim.cacheRoot, claim.ioSeam);
    cacheDirectoryFd = cache.shaRootFd;
    cacheDirectoryPath = cache.shaRoot;
    cacheDirectoryDevice = cache.device;
    cacheDirectoryInode = cache.shaRootInode;
    // Reclaim runs under the same retained directory descriptor as the
    // publication that follows, so a path swap cannot redirect either step.
    await reclaimPreparedGithubTemplateCacheTemps(cache, claim.ioSeam);
    const cachePath = join(
      cache.shaRoot,
      `${authority.sha256}.taktpack`,
    );
    publicationArtifacts.finalPath = cachePath;
    let cacheExists = true;
    try {
      lstatSync(cachePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        cacheExists = false;
      } else {
        throw storageError(
          'CACHE_INVALID',
          'GitHub template cache entry is unavailable',
          'cache-published',
        );
      }
    }
    let status: 'cache-hit' | 'cache-published';
    let verified: Awaited<ReturnType<typeof verifyExistingCacheFinal>>;
    if (cacheExists) {
      status = 'cache-hit';
      verified = await verifyExistingCacheFinal(
        cachePath,
        cache.device,
        authority,
        claim.ioSeam,
      );
    } else {
      const published = await publishCacheMiss(
        cache,
        cachePath,
        stagingFd,
        authority,
        claim.ioSeam,
        publicationArtifacts,
      );
      status = published.status;
      verified = published.verified;
    }
    cacheFinalFd = verified.fd;
    cacheFinalPath = cachePath;
    cacheFinalInode = verified.inode;
    cacheAvailable = true;
    runCachePhase(
      claim.ioSeam,
      'before-cache-hit-parent-fsync',
      cache.shaRoot,
    );
    // The retained directory descriptor prevents a path swap from turning
    // durability repair into authority for a different cache directory.
    assertCacheDirectoryAuthority(
      cache.shaRoot,
      cache.shaRootFd,
      cache.device,
      cache.shaRootInode,
    );
    syncCacheDirectoryDescriptor(cache.shaRootFd, claim.ioSeam);
    assertCacheDirectoryAuthority(
      cache.shaRoot,
      cache.shaRootFd,
      cache.device,
      cache.shaRootInode,
    );
    assertCacheFinalAuthority(
      cachePath,
      verified.fd,
      cache.device,
      verified.inode,
      authority,
    );
    closeSync(stagingFd);
    stagingFd = undefined;
    result = Object.freeze({
      cachePath,
      bytes: authority.bytes,
      sha256: authority.sha256,
      status,
      artifactState: 'cache-published',
      inspection: deepFreeze(verified.inspection),
    });
  } catch (error) {
    cacheAvailable ||= publicationArtifacts.cachePublished;
    if (isInternalStorageError(error)) {
      primaryError = (
        cacheAvailable
        && error.artifactState !== 'cache-published'
      )
        ? storageError(error.code, error.message, 'cache-published')
        : error;
    } else {
      primaryError = storageError(
        'IO_FAILURE',
        'GitHub template cache materialization failed',
        cacheAvailable ? 'cache-published' : 'staging-only',
      );
    }
  } finally {
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
    if (
      primaryError === undefined
      && result !== undefined
      && cacheDirectoryFd !== undefined
      && cacheDirectoryPath !== undefined
      && cacheDirectoryDevice !== undefined
      && cacheDirectoryInode !== undefined
      && cacheFinalFd !== undefined
      && cacheFinalPath !== undefined
      && cacheFinalInode !== undefined
    ) {
      try {
        // Cleanup hooks are still untrusted code. Revalidate both retained
        // authorities immediately before publishing the sealed result.
        assertCacheDirectoryAuthority(
          cacheDirectoryPath,
          cacheDirectoryFd,
          cacheDirectoryDevice,
          cacheDirectoryInode,
        );
        assertCacheFinalAuthority(
          cacheFinalPath,
          cacheFinalFd,
          cacheDirectoryDevice,
          cacheFinalInode,
          authority,
        );
      } catch {
        primaryError = storageError(
          'CACHE_INVALID',
          'GitHub template cache authority changed',
          'cache-published',
        );
      }
    }
    if (cacheFinalFd !== undefined) {
      try {
        closeCacheDescriptor(cacheFinalFd, 'final', claim.ioSeam);
        cacheFinalFd = undefined;
      } catch {
        try {
          if (cacheFinalFd !== undefined) {
            closeSync(cacheFinalFd);
            cacheFinalFd = undefined;
          }
        } catch {
          // The stable close failure below remains primary.
        }
        if (primaryError === undefined) {
          primaryError = storageError(
            'IO_FAILURE',
            'GitHub template cache file close failed',
            'cache-published',
          );
        }
      }
    }
    if (cacheDirectoryFd !== undefined) {
      try {
        closeCacheDescriptor(
          cacheDirectoryFd,
          'directory',
          claim.ioSeam,
        );
        cacheDirectoryFd = undefined;
      } catch {
        try {
          if (cacheDirectoryFd !== undefined) {
            closeSync(cacheDirectoryFd);
            cacheDirectoryFd = undefined;
          }
        } catch {
          // The stable close failure below remains primary.
        }
        if (primaryError === undefined) {
          primaryError = storageError(
            'IO_FAILURE',
            'GitHub template cache directory close failed',
            cacheAvailable ? 'cache-published' : 'staging-only',
          );
        }
      }
    }
  }
  if (primaryError !== undefined) {
    if (isInternalStorageError(primaryError)) {
      const artifactState = classifyMaterializationArtifacts(
        authority,
        publicationArtifacts,
      );
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
  MATERIALIZED_CACHE_RECEIPT_AUTHORITIES.set(result, { state: 'active' });
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
    let chunkCount = 0;
    let emptyChunkCount = 0;
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
        chunkCount += 1;
        if (chunkCount > MAX_DOWNLOAD_CHUNKS) {
          throw storageError(
            'LIMIT_EXCEEDED',
            'GitHub template download exceeded its chunk limit',
          );
        }
        const chunk = snapshotDownloadChunk(
          next.value,
          snapshot.expectedBytes - received,
        );
        if (chunk.byteLength === 0) {
          emptyChunkCount += 1;
          if (emptyChunkCount > MAX_EMPTY_DOWNLOAD_CHUNKS) {
            throw storageError(
              'LIMIT_EXCEEDED',
              'GitHub template download exceeded its empty chunk limit',
            );
          }
          continue;
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
