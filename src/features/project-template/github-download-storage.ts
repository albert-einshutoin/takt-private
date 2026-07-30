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
const STAGING_DIRECTORY_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type GithubTemplateDownloadStoragePhase =
  | 'ingress-created'
  | 'file-fsynced'
  | 'before-staging-root-parent-fsync'
  | 'before-staging-reinspect'
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

export type VerifiedStagedGithubTemplateDownload =
  StagedGithubTemplateDownload;

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
  state: 'active' | 'consumed';
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
): GithubTemplateDownloadStorageError {
  const error = new GithubTemplateDownloadStorageError(code, message);
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
export async function verifyGithubTemplateDownloadStaging(
  staged: StagedGithubTemplateDownload,
): Promise<VerifiedStagedGithubTemplateDownload> {
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
    requirePrivateDirectory(
      authority.stagingRoot,
      authority.stagingDevice,
    );
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
    return Object.freeze({
      stagingPath: authority.stagingPath,
      bytes: authority.bytes,
      sha256: authority.sha256,
      inspection: deepFreeze(inspection),
    });
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
        // Verification has already selected its stable outcome.
      }
    }
  }
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
