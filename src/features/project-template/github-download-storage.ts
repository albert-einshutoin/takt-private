import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inspectTaktpack } from './archive-inspector.js';
import {
  DEFAULT_TAKTPACK_LIMITS,
  type TaktpackInspectResult,
} from './archive-types.js';
import {
  isProjectTemplatePrivateDirectoryMode,
  isProjectTemplatePrivateFileMode,
  PROJECT_TEMPLATE_CONTROL_DIRECTORY,
} from './control-root-contract.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type GithubTemplateDownloadStorageErrorCode =
  | 'INVALID_ARGUMENT'
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

export type GithubTemplateDownloadStoragePhase =
  | 'ingress-created'
  | 'file-fsynced'
  | 'before-staging-root-parent-fsync'
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
  readonly inspection: TaktpackInspectResult;
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
  return new GithubTemplateDownloadStorageError(code, message);
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
  ioSeam?.onPhase?.('before-staging-root-parent-fsync', parentPath);
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
): Promise<{ done: boolean; value: unknown }> {
  try {
    const result = await iterator.next();
    if (typeof result !== 'object' || result === null) throw new Error();
    return {
      done: result.done === true,
      value: result.value,
    };
  } catch {
    throw storageError(
      'STREAM_FAILED',
      'GitHub template download stream failed',
    );
  }
}

function cleanupOwnedStaging(
  stagingDirectory: string,
  stagingPath: string,
  expectedDevice: number,
  ioSeam: GithubTemplateDownloadStorageIoSeam | undefined,
): void {
  ioSeam?.onPhase?.('before-cleanup', stagingPath);
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
    if (error instanceof GithubTemplateDownloadStorageError) throw error;
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
    snapshot.ioSeam?.onPhase?.('ingress-created', stagingPath);

    const digest = createHash('sha256');
    let received = 0;
    const iterator = getDownloadIterator(snapshot.chunks);
    while (true) {
      throwIfAborted(snapshot.signal);
      const next = await readDownloadChunk(iterator);
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        throw storageError(
          'INVALID_CHUNK',
          'GitHub template download yielded an invalid chunk',
        );
      }
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
        const bytesWritten = snapshot.ioSeam?.write?.(
          fd,
          chunk,
          offset,
          chunk.byteLength - offset,
          received + offset,
        ) ?? writeSync(
          fd,
          chunk,
          offset,
          chunk.byteLength - offset,
          received + offset,
        );
        if (bytesWritten <= 0) {
          throw storageError(
            'IO_FAILURE',
            'GitHub template download write made no progress',
          );
        }
        offset += bytesWritten;
      }
      digest.update(chunk);
      received += chunk.byteLength;
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
    snapshot.ioSeam?.onPhase?.('file-fsynced', stagingPath);
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
    return Object.freeze({
      stagingPath,
      bytes: received,
      sha256: actualSha256,
      inspection,
    });
  } catch (error) {
    primaryError = error;
    if (error instanceof GithubTemplateDownloadStorageError) throw error;
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
