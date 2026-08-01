import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import { canonicalizeTaktpackJson } from './canonical-json.js';
import {
  isProjectTemplatePrivateDirectoryMode,
  isProjectTemplatePrivateFileMode,
  PROJECT_TEMPLATE_CONTROL_DIRECTORY,
  PROJECT_TEMPLATE_CONTROL_GITIGNORE_TEXT,
} from './control-root-contract.js';
import {
  areProjectTemplateFileStatsEqual,
  readBoundedProjectTemplateFile,
} from './bounded-file-read.js';
import {
  areProjectTemplateDirectorySnapshotsStable,
} from './filesystem-scan.js';
import { parsePortablePath } from './validation.js';
import {
  PROJECT_TEMPLATE_ENTRY_OPERATION_PREFIX,
  PROJECT_TEMPLATE_TRANSACTION_LIMITS,
  projectTemplateTransactionTargetByteLimit,
} from './transaction-limits.js';
import {
  PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
} from './repertoire-dependency-lock.js';
import {
  PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
} from './source-provenance.js';

export { PROJECT_TEMPLATE_CONTROL_DIRECTORY } from './control-root-contract.js';
export const DEFAULT_PROJECT_TEMPLATE_BACKUP_GENERATIONS = 5;
export const MAX_PROJECT_TEMPLATE_LISTED_BACKUPS = 32;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_CONTROL_DIRECTORY_ENTRIES = 8_192;
const MAX_CONTROL_TREE_DEPTH = 16;
const MAX_APPROVAL_BYTES = 64 * 1024;
const CONTROL_GITIGNORE_CONTENT = Buffer.from(PROJECT_TEMPLATE_CONTROL_GITIGNORE_TEXT);
const CAPTURED_JSON_PARSE = JSON.parse;
const CAPTURED_JSON_RECEIVER = JSON;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const APPROVAL_UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});
const CAPTURED_TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const APPROVAL_UTF8_ENCODER = new TextEncoder();
const CAPTURED_TEXT_ENCODER_ENCODE = TextEncoder.prototype.encode;

export type ProjectTemplateApplyStorageIoOperation =
  | 'lstat'
  | 'stat'
  | 'realpath'
  | 'mkdir'
  | 'readdir'
  | 'read'
  | 'write'
  | 'chmod'
  | 'file-fsync'
  | 'directory-fsync'
  | 'link'
  | 'rename'
  | 'unlink'
  | 'rmdir';

export type ProjectTemplateApplyStorageErrorCode =
  | 'UNSAFE_REPOSITORY'
  | 'UNSAFE_PATH'
  | 'UNSAFE_CONTROL_ROOT'
  | 'UNSAFE_TARGET'
  | 'DEVICE_MISMATCH'
  | 'HASH_MISMATCH'
  | 'MODE_MISMATCH'
  | 'LIMIT_EXCEEDED'
  | 'ALREADY_EXISTS'
  | 'INVALID_MANIFEST'
  | 'INVALID_JOURNAL'
  | 'IO_FAILURE';

export type ProjectTemplateApplyStorageArtifactState =
  | 'not-published'
  | 'published';

export class ProjectTemplateApplyStorageError extends Error {
  constructor(
    public readonly code: ProjectTemplateApplyStorageErrorCode,
    message: string,
    public readonly operation?: ProjectTemplateApplyStorageIoOperation,
    public readonly artifactState: ProjectTemplateApplyStorageArtifactState = 'not-published',
  ) {
    super(message);
    this.name = 'ProjectTemplateApplyStorageError';
  }
}

class ProjectTemplateApplyStorageIoError extends Error {
  public readonly code: string | undefined;

  constructor(
    public readonly operation: ProjectTemplateApplyStorageIoOperation,
    public readonly path: string,
    cause: unknown,
  ) {
    // Absolute repository paths can contain account names or workspace
    // details. Keep the path for internal recovery only, never in the public
    // error message consumed by CLI/desktop clients.
    super(`project template storage ${operation} failed`, { cause });
    this.name = 'ProjectTemplateApplyStorageIoError';
    this.code = errorCode(cause);
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    && typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

export interface ProjectTemplateApplyStorageFaultHooks {
  before?: (
    operation: ProjectTemplateApplyStorageIoOperation,
    path: string,
  ) => void;
  after?: (
    operation: ProjectTemplateApplyStorageIoOperation,
    path: string,
  ) => void;
}

export interface ProjectTemplateApplyStorageIo {
  lstat(path: string): Promise<Stats>;
  stat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, mode: number): Promise<void>;
  readdir(path: string, maxEntries: number): Promise<Dirent[]>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  readPrivateFile(path: string, maxBytes: number, expectedDevice: number): Promise<Buffer>;
  writeExclusive(path: string, content: Uint8Array, mode: number): Promise<void>;
  writePreparedExclusive(
    path: string,
    content: Uint8Array,
    mode: number,
    expectedDevice: number,
  ): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  fsyncFile(path: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  link(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

export interface ProjectTemplateApplyStorage {
  repoRoot: string;
  targetRoot: string;
  lockTargetPath: string;
  controlRoot: string;
  stagingRoot: string;
  backupsRoot: string;
  baselinesRoot: string;
  baselinesDevice: number;
  baselinesInode: number;
  journalPath: string;
  lockPath: string;
  device: number;
  inode: number;
  platform: NodeJS.Platform;
  io: ProjectTemplateApplyStorageIo;
}

export type ProjectTemplateReadOnlyStoragePhase =
  | 'repository-opened'
  | 'control-opened'
  | 'baselines-opened'
  | 'all-closed';

export interface ProjectTemplateReadOnlyStorageIoSeam {
  onPhase?(phase: ProjectTemplateReadOnlyStoragePhase): void;
}

function projectTemplateApprovalPath(
  storage: ProjectTemplateApplyStorage,
  approvalId: string,
): { approvalsRoot: string; approvalPath: string } {
  const safeApprovalId = assertSafeIdentifier(approvalId, 'approvalId');
  const approvalsRoot = join(storage.controlRoot, 'approvals');
  return {
    approvalsRoot,
    approvalPath: join(approvalsRoot, `${safeApprovalId}.json`),
  };
}

function projectTemplateApprovalClaimPath(
  storage: ProjectTemplateApplyStorage,
  approvalId: string,
): { claimsRoot: string; claimPath: string } {
  const safeApprovalId = assertSafeIdentifier(approvalId, 'approvalId');
  const claimsRoot = join(storage.controlRoot, 'approval-claims');
  return {
    claimsRoot,
    claimPath: join(claimsRoot, `${safeApprovalId}.json`),
  };
}

export async function writeProjectTemplateApprovalRecord(options: {
  storage: ProjectTemplateApplyStorage;
  approvalId: string;
  record: unknown;
}): Promise<void> {
  const { approvalPath } = projectTemplateApprovalPath(
    options.storage,
    options.approvalId,
  );
  await writePrivateDurableFile({
    storage: options.storage,
    finalPath: approvalPath,
    content: projectTemplateApprovalRecordContent(options.record),
    replace: false,
    io: options.storage.io,
  });
}

function projectTemplateApprovalRecordContent(record: unknown): Uint8Array {
  // Preserve the established approval-record encoding. The canonical renderer
  // already terminates its JSON and storage adds the historical trailing LF.
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_TEXT_ENCODER_ENCODE,
    APPROVAL_UTF8_ENCODER,
    [`${canonicalizeTaktpackJson(record)}\n`],
  ) as Uint8Array;
}

export async function readProjectTemplateApprovalRecord(options: {
  storage: ProjectTemplateApplyStorage;
  approvalId: string;
}): Promise<unknown> {
  const { approvalPath } = projectTemplateApprovalPath(
    options.storage,
    options.approvalId,
  );
  const approvalsRoot = dirname(approvalPath);
  await ensurePrivateDirectory(
    options.storage.io,
    approvalsRoot,
    options.storage.device,
    options.storage.platform,
  );
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_JSON_PARSE,
    CAPTURED_JSON_RECEIVER,
    [CAPTURED_REFLECT_APPLY(
      CAPTURED_TEXT_DECODER_DECODE,
      APPROVAL_UTF8_DECODER,
      [await options.storage.io.readPrivateFile(
        approvalPath,
        MAX_APPROVAL_BYTES,
        options.storage.device,
      )],
    )],
  ) as unknown;
}

export async function hasProjectTemplateApprovalClaim(options: {
  storage: ProjectTemplateApplyStorage;
  approvalId: string;
}): Promise<boolean> {
  const { claimsRoot, claimPath } = projectTemplateApprovalClaimPath(
    options.storage,
    options.approvalId,
  );
  await ensurePrivateDirectory(
    options.storage.io,
    claimsRoot,
    options.storage.device,
    options.storage.platform,
  );
  return await tryLstat(options.storage.io, claimPath) !== undefined;
}

export async function consumeProjectTemplateApprovalRecord(options: {
  storage: ProjectTemplateApplyStorage;
  approvalId: string;
  claim: unknown;
}): Promise<void> {
  const { claimsRoot, claimPath } = projectTemplateApprovalClaimPath(
    options.storage,
    options.approvalId,
  );
  await ensurePrivateDirectory(
    options.storage.io,
    claimsRoot,
    options.storage.device,
    options.storage.platform,
  );
  // O_EXCL is the one-shot linearization point. Never remove a published or
  // partially published claim: any uncertainty permanently burns the approval
  // and therefore fails closed if the issued record is later restored.
  await options.storage.io.writeExclusive(
    claimPath,
    CAPTURED_REFLECT_APPLY(
      CAPTURED_TEXT_ENCODER_ENCODE,
      APPROVAL_UTF8_ENCODER,
      [`${canonicalizeTaktpackJson(options.claim)}\n`],
    ) as Uint8Array,
    PRIVATE_FILE_MODE,
  );
  await options.storage.io.chmod(claimPath, PRIVATE_FILE_MODE);
  await options.storage.io.fsyncFile(claimPath);
  await options.storage.io.fsyncDirectory(claimsRoot);
}

export type ProjectTemplateApplyTarget =
  | { kind: 'template-entry'; path: string }
  | { kind: 'lock' }
  | { kind: 'content-lock' }
  | { kind: 'repertoire-lock' }
  | { kind: 'source-provenance' }
  | { kind: 'merge-baseline'; sha256: string };

export interface ResolvedProjectTemplateApplyTarget {
  target: ProjectTemplateApplyTarget;
  key: string;
  absolutePath: string;
  stagingRelativePath: string;
  displayPath: string;
}

export interface ProjectTemplateStoredFile {
  target: ProjectTemplateApplyTarget;
  absolutePath: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  storedMode: '0600';
  targetMode: string;
}

export interface ProjectTemplateBackupFileState {
  kind: 'file';
  sha256: string;
  bytes: number;
  mode: string;
  blobRelativePath: string;
  /**
   * Records the original target timestamp for audit and recovery diagnostics.
   * Restore correctness is intentionally based on content and mode because
   * replacing a file necessarily creates a new filesystem timestamp.
   */
  modifiedAt?: string;
}

export interface ProjectTemplateBackupAbsentState {
  kind: 'absent';
}

export type ProjectTemplateBackupEntryState =
  | ProjectTemplateBackupFileState
  | ProjectTemplateBackupAbsentState;

export interface ProjectTemplateBackupManifestEntry {
  target: ProjectTemplateApplyTarget;
  action: 'add' | 'update' | 'delete';
  before: ProjectTemplateBackupEntryState;
  after: ProjectTemplateBackupEntryState;
}

export interface ProjectTemplateBackupManifest {
  schemaVersion: '1.0' | '1.1';
  backupId: string;
  planId: string;
  preconditionToken: string;
  createdAt: string;
  /** Target-root-relative directories absent before this transaction. */
  createdTargetDirectories: readonly string[];
  entries: readonly ProjectTemplateBackupManifestEntry[];
}

export type ProjectTemplateApplyJournalState =
  | 'prepared'
  | 'committing'
  | 'verifying'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back'
  | 'restore-failed';

export interface ProjectTemplateApplyJournal {
  schemaVersion: '1.0' | '1.1';
  transactionId: string;
  planId: string;
  backupId: string;
  state: ProjectTemplateApplyJournalState;
  completedOperations: readonly string[];
  createdTargetDirectories: readonly string[];
  updatedAt: string;
}

export interface ProjectTemplateStagingFile extends ProjectTemplateStoredFile {
  transactionId: string;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function ioFailure(error: unknown, artifactPublished = false): ProjectTemplateApplyStorageError {
  if (error instanceof ProjectTemplateApplyStorageError) return error;
  if (error instanceof ProjectTemplateApplyStorageIoError) {
    return new ProjectTemplateApplyStorageError(
      'IO_FAILURE',
      error.message,
      error.operation,
      artifactPublished ? 'published' : 'not-published',
    );
  }
  return new ProjectTemplateApplyStorageError(
    'IO_FAILURE',
    'project template storage operation failed',
    undefined,
    artifactPublished ? 'published' : 'not-published',
  );
}

function runHook(
  hooks: ProjectTemplateApplyStorageFaultHooks,
  timing: 'before' | 'after',
  operation: ProjectTemplateApplyStorageIoOperation,
  path: string,
): void {
  try {
    hooks[timing]?.(operation, path);
  } catch (error) {
    throw new ProjectTemplateApplyStorageIoError(operation, path, error);
  }
}

async function withIoHooks<Result>(
  hooks: ProjectTemplateApplyStorageFaultHooks,
  operation: ProjectTemplateApplyStorageIoOperation,
  path: string,
  action: () => Promise<Result>,
): Promise<Result> {
  runHook(hooks, 'before', operation, path);
  let result: Result;
  try {
    result = await action();
  } catch (error) {
    if (
      error instanceof ProjectTemplateApplyStorageError
      || error instanceof ProjectTemplateApplyStorageIoError
    ) {
      throw error;
    }
    throw new ProjectTemplateApplyStorageIoError(operation, path, error);
  }
  runHook(hooks, 'after', operation, path);
  return result;
}

export function createProjectTemplateApplyStorageIo(
  hooks: ProjectTemplateApplyStorageFaultHooks = {},
  platform: NodeJS.Platform = process.platform,
): ProjectTemplateApplyStorageIo {
  return {
    lstat: async (path) => withIoHooks(hooks, 'lstat', path, () => lstat(path)),
    stat: async (path) => withIoHooks(hooks, 'stat', path, () => stat(path)),
    realpath: async (path) => withIoHooks(hooks, 'realpath', path, () => realpath(path)),
    mkdir: async (path, mode) => withIoHooks(
      hooks,
      'mkdir',
      path,
      async () => {
        await mkdir(path, { mode });
      },
    ),
    readdir: async (path, maxEntries) => withIoHooks(
      hooks,
      'readdir',
      path,
      async () => {
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
          throw new ProjectTemplateApplyStorageError(
            'LIMIT_EXCEEDED',
            'project template directory read budget is invalid',
          );
        }
        const entries: Dirent[] = [];
        const directory = await opendir(path);
        for await (const entry of directory) {
          if (entries.length >= maxEntries) {
            throw new ProjectTemplateApplyStorageError(
              'LIMIT_EXCEEDED',
              'project template directory exceeds the entry limit',
            );
          }
          entries.push(entry);
        }
        return entries;
      },
    ),
    readFile: async (path, maxBytes) => {
      runHook(hooks, 'before', 'read', path);
      const initial = await lstat(path);
      if (
        initial.isSymbolicLink()
        || !initial.isFile()
        || initial.nlink !== 1
      ) {
        throw new ProjectTemplateApplyStorageError(
          'UNSAFE_TARGET',
          'project template storage source is not a safe regular file',
        );
      }
      if (initial.size > maxBytes) {
        throw new ProjectTemplateApplyStorageError(
          'LIMIT_EXCEEDED',
          'project template storage file exceeds the read budget',
        );
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: Buffer | undefined;
      let primaryError: unknown;
      try {
        const before = await handle.stat();
        if (!areProjectTemplateFileStatsEqual(initial, before)) {
          throw new ProjectTemplateApplyStorageError(
            'UNSAFE_TARGET',
            'project template storage source changed before it was read',
          );
        }
        content = await handle.readFile();
        const after = await handle.stat();
        if (!areProjectTemplateFileStatsEqual(before, after)) {
          throw new ProjectTemplateApplyStorageError(
            'UNSAFE_TARGET',
            'project template storage source changed while it was read',
          );
        }
      } catch (error) {
        primaryError = error;
      }
      try {
        await handle.close();
      } catch (error) {
        primaryError ??= error;
      }
      if (primaryError !== undefined) throw primaryError;
      if (content === undefined || content.byteLength !== initial.size) {
        throw new ProjectTemplateApplyStorageError(
          'UNSAFE_TARGET',
          'project template storage source was truncated',
        );
      }
      runHook(hooks, 'after', 'read', path);
      return content;
    },
    readPrivateFile: async (path, maxBytes, expectedDevice) => {
      runHook(hooks, 'before', 'read', path);
      const pathBefore = await lstat(path);
      if (
        pathBefore.isSymbolicLink()
        || !pathBefore.isFile()
        || pathBefore.nlink !== 1
        || pathBefore.dev !== expectedDevice
        || !isProjectTemplatePrivateFileMode(pathBefore.mode, platform)
        || pathBefore.size < 0
        || pathBefore.size > maxBytes
      ) {
        throw new ProjectTemplateApplyStorageError(
          'UNSAFE_CONTROL_ROOT',
          'project template private record is unsafe',
        );
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: Buffer | undefined;
      let primaryError: unknown;
      try {
        const before = await handle.stat();
        if (
          !areProjectTemplateFileStatsEqual(pathBefore, before)
        ) {
          throw new ProjectTemplateApplyStorageError(
            'UNSAFE_CONTROL_ROOT',
            'project template private record changed before it was opened',
          );
        }
        const bounded = await readBoundedProjectTemplateFile(
          handle,
          before.size,
        );
        const after = await handle.stat();
        // The private-read hook intentionally runs before the final path
        // witness so fault tests can model replacement/chmod races in the
        // otherwise narrow post-read validation window.
        runHook(hooks, 'after', 'read', path);
        const pathAfter = await lstat(path);
        if (
          bounded.status !== 'complete'
          || bounded.content.byteLength !== before.size
          || !areProjectTemplateFileStatsEqual(before, after)
          || !areProjectTemplateFileStatsEqual(after, pathAfter)
        ) {
          throw new ProjectTemplateApplyStorageError(
            'UNSAFE_CONTROL_ROOT',
            'project template private record changed while it was read',
          );
        }
        content = bounded.content;
      } catch (error) {
        primaryError = error;
      }
      try {
        await handle.close();
      } catch (error) {
        primaryError ??= error;
      }
      if (primaryError !== undefined) throw primaryError;
      if (content === undefined) {
        throw new ProjectTemplateApplyStorageError(
          'UNSAFE_CONTROL_ROOT',
          'project template private record could not be read',
        );
      }
      return content;
    },
    writeExclusive: async (path, content, mode) => {
      runHook(hooks, 'before', 'write', path);
      const handle = await open(
        path,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        mode,
      );
      let primaryError: unknown;
      try {
        await handle.writeFile(content);
      } catch (error) {
        primaryError = error;
      }
      try {
        await handle.close();
      } catch (error) {
        primaryError ??= error;
      }
      if (primaryError !== undefined) {
        throw new ProjectTemplateApplyStorageIoError('write', path, primaryError);
      }
      runHook(hooks, 'after', 'write', path);
    },
    writePreparedExclusive: async (path, content, mode, expectedDevice) => {
      runHook(hooks, 'before', 'write', path);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let primaryError: unknown;
      try {
        handle = await open(
          path,
          constants.O_WRONLY
            | constants.O_CREAT
            | constants.O_EXCL
            | constants.O_NOFOLLOW,
          mode,
        );
        await handle.writeFile(content);
        // Keep the descriptor open across hooks and all durability operations.
        // A pathname chmod/fsync here would let a concurrent replacement redirect
        // those operations to an attacker-controlled target.
        runHook(hooks, 'after', 'write', path);
        runHook(hooks, 'before', 'chmod', path);
        await handle.chmod(mode);
        runHook(hooks, 'after', 'chmod', path);
        runHook(hooks, 'before', 'file-fsync', path);
        await handle.sync();
        runHook(hooks, 'after', 'file-fsync', path);
        const descriptorStat = await handle.stat();
        const pathStat = await lstat(path);
        if (
          !descriptorStat.isFile()
          || descriptorStat.nlink !== 1
          || descriptorStat.dev !== expectedDevice
          || descriptorStat.size !== content.byteLength
          || !isProjectTemplatePrivateFileMode(descriptorStat.mode, platform)
          || !areProjectTemplateFileStatsEqual(descriptorStat, pathStat)
        ) {
          throw new ProjectTemplateApplyStorageError(
            'UNSAFE_CONTROL_ROOT',
            'project template prepared record changed while it was written',
          );
        }
      } catch (error) {
        primaryError = error;
      }
      try {
        await handle?.close();
      } catch (error) {
        primaryError ??= error;
      }
      if (primaryError !== undefined) {
        if (primaryError instanceof ProjectTemplateApplyStorageError) {
          throw primaryError;
        }
        throw new ProjectTemplateApplyStorageIoError('write', path, primaryError);
      }
    },
    chmod: async (path, mode) => {
      runHook(hooks, 'before', 'chmod', path);
      try {
        await chmod(path, mode);
      } catch (error) {
        throw new ProjectTemplateApplyStorageIoError('chmod', path, error);
      }
      runHook(hooks, 'after', 'chmod', path);
    },
    fsyncFile: async (path) => {
      runHook(hooks, 'before', 'file-fsync', path);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let primaryError: unknown;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        await handle.sync();
      } catch (error) {
        primaryError = error;
      }
      try {
        await handle?.close();
      } catch (error) {
        primaryError ??= error;
      }
      if (primaryError !== undefined) {
        throw new ProjectTemplateApplyStorageIoError('file-fsync', path, primaryError);
      }
      runHook(hooks, 'after', 'file-fsync', path);
    },
    fsyncDirectory: async (path) => {
      // Windows does not expose portable directory fsync semantics. Files are
      // still fsynced before rename; publishing their directory entries is
      // therefore explicitly best-effort on that platform.
      if (platform === 'win32') return;
      runHook(hooks, 'before', 'directory-fsync', path);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let primaryError: unknown;
      try {
        handle = await open(path, constants.O_RDONLY);
        await handle.sync();
      } catch (error) {
        primaryError = error;
      }
      try {
        await handle?.close();
      } catch (error) {
        primaryError ??= error;
      }
      if (primaryError !== undefined) {
        throw new ProjectTemplateApplyStorageIoError('directory-fsync', path, primaryError);
      }
      runHook(hooks, 'after', 'directory-fsync', path);
    },
    rename: async (source, destination) => {
      runHook(hooks, 'before', 'rename', destination);
      try {
        await rename(source, destination);
      } catch (error) {
        throw new ProjectTemplateApplyStorageIoError('rename', destination, error);
      }
      runHook(hooks, 'after', 'rename', destination);
    },
    link: async (source, destination) => {
      runHook(hooks, 'before', 'link', destination);
      try {
        await link(source, destination);
      } catch (error) {
        throw new ProjectTemplateApplyStorageIoError('link', destination, error);
      }
      runHook(hooks, 'after', 'link', destination);
    },
    unlink: async (path) => withIoHooks(hooks, 'unlink', path, () => unlink(path)),
    rmdir: async (path) => withIoHooks(hooks, 'rmdir', path, () => rmdir(path)),
  };
}

async function tryLstat(
  io: ProjectTemplateApplyStorageIo,
  path: string,
): Promise<Stats | undefined> {
  try {
    return await io.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertSafeIdentifier(value: string, label: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    || value === '.'
    || value === '..'
  ) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_PATH',
      `${label} is not a safe storage identifier`,
    );
  }
  return value;
}

function safeRelativePath(value: string): string {
  try {
    return parsePortablePath(value, 'relativePath');
  } catch {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_PATH',
      'project template storage path is unsafe',
    );
  }
}

export function resolveProjectTemplateApplyTarget(
  storage: ProjectTemplateApplyStorage,
  value: ProjectTemplateApplyTarget,
): ResolvedProjectTemplateApplyTarget {
  if (value === null || typeof value !== 'object') {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_PATH',
      'project template apply target is invalid',
    );
  }
  if (value.kind === 'lock') {
    if (!hasExactDataKeys(value, ['kind'])) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_PATH',
        'project template apply target is invalid',
      );
    }
    return {
      target: { kind: 'lock' },
      key: 'lock',
      absolutePath: storage.lockTargetPath,
      stagingRelativePath: 'lock/.takt-template-lock.json',
      displayPath: '.takt-template-lock.json',
    };
  }
  if (value.kind === 'merge-baseline') {
    if (
      !hasExactDataKeys(value, ['kind', 'sha256'])
      || !/^[a-f0-9]{64}$/.test(value.sha256)
    ) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_PATH',
        'project template merge baseline target is invalid',
      );
    }
    return {
      target: { kind: 'merge-baseline', sha256: value.sha256 },
      key: `baseline:${value.sha256}`,
      absolutePath: join(storage.baselinesRoot, value.sha256),
      stagingRelativePath: `baselines/${value.sha256}`,
      displayPath: `.takt-template-state/merge-baselines/${value.sha256}`,
    };
  }
  const companion = value.kind === 'content-lock'
    ? {
        key: 'content-lock',
        path: '.takt-template-lock.json',
      }
    : value.kind === 'repertoire-lock'
      ? {
          key: 'repertoire-lock',
          path: PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
        }
      : value.kind === 'source-provenance'
        ? {
            key: 'source-provenance',
            path: PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
          }
        : undefined;
  if (companion !== undefined) {
    if (!hasExactDataKeys(value, ['kind'])) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_PATH',
        'project template apply target is invalid',
      );
    }
    const target = value.kind === 'content-lock'
      ? { kind: 'content-lock' as const }
      : value.kind === 'repertoire-lock'
        ? { kind: 'repertoire-lock' as const }
        : { kind: 'source-provenance' as const };
    return {
      target,
      key: companion.key,
      absolutePath: join(storage.repoRoot, companion.path),
      stagingRelativePath: `locks/${companion.path}`,
      displayPath: companion.path,
    };
  }
  if (value.kind !== 'template-entry') {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_PATH',
      'project template apply target kind is invalid',
    );
  }
  if (!hasExactDataKeys(value, ['kind', 'path'])) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_PATH',
      'project template apply target is invalid',
    );
  }
  const path = safeRelativePath(value.path);
  return {
    target: { kind: 'template-entry', path },
    key: `entry:${path}`,
    absolutePath: join(storage.targetRoot, path),
    stagingRelativePath: `entries/${path}`,
    displayPath: `.takt/${path}`,
  };
}

function hasExactDataKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key))
    && Object.values(descriptors).every((descriptor) => 'value' in descriptor);
}

function validateManifestTarget(
  value: unknown,
  schemaVersion: '1.0' | '1.1',
): ProjectTemplateApplyTarget {
  if (value === null || typeof value !== 'object') {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      'backup manifest target is invalid',
    );
  }
  const target = value as Partial<ProjectTemplateApplyTarget>;
  if (target.kind === 'template-entry') {
    if (!hasExactDataKeys(value, ['kind', 'path'])) {
      throw new ProjectTemplateApplyStorageError(
        'INVALID_MANIFEST',
        'backup manifest target is invalid',
      );
    }
    return {
      kind: 'template-entry',
      path: safeRelativePath((target as { path: string }).path),
    };
  }
  if (target.kind === 'merge-baseline') {
    if (
      schemaVersion !== '1.1'
      || !hasExactDataKeys(value, ['kind', 'sha256'])
      || typeof target.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(target.sha256)
    ) {
      throw new ProjectTemplateApplyStorageError(
        'INVALID_MANIFEST',
        'backup manifest merge baseline target is invalid',
      );
    }
    return { kind: 'merge-baseline', sha256: target.sha256 };
  }
  const expectedKinds = schemaVersion === '1.0'
    ? ['lock'] as const
    : ['content-lock', 'repertoire-lock', 'source-provenance'] as const;
  if (
    typeof target.kind !== 'string'
    || !expectedKinds.includes(target.kind as never)
    || !hasExactDataKeys(value, ['kind'])
  ) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      'backup manifest target is invalid',
    );
  }
  return { kind: target.kind } as ProjectTemplateApplyTarget;
}

function safeMode(value: string): string {
  if (!/^0[0-7]{3}$/.test(value)) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      'project template storage mode is invalid',
    );
  }
  return value;
}

function assertHash(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}

function assertTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      `${label} must be an ISO timestamp`,
    );
  }
  return value;
}

async function ensurePrivateDirectory(
  io: ProjectTemplateApplyStorageIo,
  path: string,
  expectedParentDevice: number,
  platform: NodeJS.Platform,
): Promise<void> {
  let entry = await tryLstat(io, path);
  if (entry === undefined) {
    try {
      await io.mkdir(path, PRIVATE_DIRECTORY_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    entry = await io.lstat(path);
  }
  if (
    entry.isSymbolicLink()
    || !entry.isDirectory()
    || entry.dev !== expectedParentDevice
    || !isProjectTemplatePrivateDirectoryMode(entry.mode, platform)
  ) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'project template control directory is unsafe',
    );
  }
  // Existence (including EEXIST) does not prove this name survived a prior
  // parent-fsync failure. Re-sync on every ensure so same-root retry can
  // re-establish durability before depending on the directory.
  await io.fsyncDirectory(dirname(path));
}

async function ensurePrivateParents(
  storage: ProjectTemplateApplyStorage,
  root: string,
  relativePath: string,
  io: ProjectTemplateApplyStorageIo,
): Promise<void> {
  // This path is produced only by resolveProjectTemplateApplyTarget after the
  // caller path is validated. Its internal `entries/` prefix legitimately
  // makes a maximum-length portable target longer than the public path bound.
  const segments = relativePath.split('/');
  if (
    !['entries', 'lock', 'locks', 'baselines'].includes(segments[0]!)
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_PATH', 'project template staging path is unsafe',
    );
  }
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    await ensurePrivateDirectory(io, current, storage.device, storage.platform);
  }
}

export async function initializeProjectTemplateApplyStorage(options: {
  repoPath: string;
  io?: ProjectTemplateApplyStorageIo;
  platform?: NodeJS.Platform;
}): Promise<ProjectTemplateApplyStorage> {
  const platform = options.platform ?? process.platform;
  const io = options.io ?? createProjectTemplateApplyStorageIo({}, platform);
  let repoRoot: string;
  try {
    repoRoot = await io.realpath(resolve(options.repoPath));
  } catch {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_REPOSITORY',
      'project template repository root cannot be resolved',
    );
  }
  const repoStat = await io.lstat(repoRoot);
  if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_REPOSITORY',
      'project template repository root must be a directory',
    );
  }

  const targetRoot = join(repoRoot, '.takt');
  const targetStat = await tryLstat(io, targetRoot);
  if (
    targetStat !== undefined
    && (
      targetStat.isSymbolicLink()
      || !targetStat.isDirectory()
      || targetStat.dev !== repoStat.dev
    )
  ) {
    throw new ProjectTemplateApplyStorageError(
      targetStat.dev !== repoStat.dev ? 'DEVICE_MISMATCH' : 'UNSAFE_TARGET',
      'project template target root is unsafe',
    );
  }

  const controlRoot = join(repoRoot, PROJECT_TEMPLATE_CONTROL_DIRECTORY);
  const stagingRoot = join(controlRoot, 'staging');
  const backupsRoot = join(controlRoot, 'backups');
  const baselinesRoot = join(controlRoot, 'merge-baselines');
  await ensurePrivateDirectory(io, controlRoot, repoStat.dev, platform);
  await ensurePrivateDirectory(io, stagingRoot, repoStat.dev, platform);
  await ensurePrivateDirectory(io, backupsRoot, repoStat.dev, platform);
  await ensurePrivateDirectory(io, baselinesRoot, repoStat.dev, platform);

  const controlRealPath = await io.realpath(controlRoot);
  if (controlRealPath !== controlRoot) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'project template control root changed identity',
    );
  }
  const controlStat = await io.stat(controlRoot);
  if (controlStat.dev !== repoStat.dev) {
    throw new ProjectTemplateApplyStorageError(
      'DEVICE_MISMATCH',
      'project template control root must share the target filesystem',
    );
  }
  const baselinesRealPath = await io.realpath(baselinesRoot);
  const baselinesStat = await io.lstat(baselinesRoot);
  if (
    baselinesRealPath !== baselinesRoot
    || baselinesStat.isSymbolicLink()
    || !baselinesStat.isDirectory()
    || baselinesStat.dev !== repoStat.dev
    || !isProjectTemplatePrivateDirectoryMode(baselinesStat.mode, platform)
  ) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'project template merge baseline root changed identity',
    );
  }

  const storage: ProjectTemplateApplyStorage = {
    repoRoot,
    targetRoot,
    lockTargetPath: join(repoRoot, '.takt-template-lock.json'),
    controlRoot,
    stagingRoot,
    backupsRoot,
    baselinesRoot,
    baselinesDevice: baselinesStat.dev,
    baselinesInode: baselinesStat.ino,
    journalPath: join(controlRoot, 'journal.json'),
    lockPath: join(controlRoot, 'apply.lock'),
    device: repoStat.dev,
    inode: repoStat.ino,
    platform,
    io,
  };
  const controlIgnorePath = join(controlRoot, '.gitignore');
  const existingIgnore = await tryLstat(io, controlIgnorePath);
  if (existingIgnore === undefined) {
    try {
      await writePrivateDurableFile({
        storage,
        finalPath: controlIgnorePath,
        content: CONTROL_GITIGNORE_CONTENT,
        replace: false,
        io,
      });
    } catch (error) {
      // Another initializer may have durably won the O_EXCL publication race.
      // Only that exact race is recoverable; every other storage failure keeps
      // its original fail-closed semantics.
      if (
        !(error instanceof ProjectTemplateApplyStorageError)
        || error.code !== 'ALREADY_EXISTS'
      ) throw error;
      await assertControlIgnoreFile(storage, controlIgnorePath, io);
    }
  } else {
    await assertControlIgnoreFile(storage, controlIgnorePath, io);
  }
  return storage;
}

/**
 * Opens an existing baseline store for preview without creating, syncing,
 * cleaning, locking, or repairing any control artifact.
 */
export async function openProjectTemplateApplyStorageReadOnly(options: {
  repoPath: string;
  platform?: NodeJS.Platform;
  ioSeam?: ProjectTemplateReadOnlyStorageIoSeam;
}): Promise<ProjectTemplateApplyStorage> {
  const platform = options.platform ?? process.platform;
  const io = createProjectTemplateApplyStorageIo({}, platform);
  const repoRoot = await realpath(resolve(options.repoPath));
  const controlRoot = join(repoRoot, PROJECT_TEMPLATE_CONTROL_DIRECTORY);
  const baselinesRoot = join(controlRoot, 'merge-baselines');
  const paths = [repoRoot, controlRoot, baselinesRoot] as const;
  const phases = [
    'repository-opened',
    'control-opened',
    'baselines-opened',
  ] as const;
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  const snapshots: Stats[] = [];
  let primaryError: unknown;
  let closeFailed = false;
  try {
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index]!;
      const pathBefore = await lstat(path);
      const resolvedPath = await realpath(path);
      if (
        resolvedPath !== path
        || pathBefore.isSymbolicLink()
        || !pathBefore.isDirectory()
        || (
          index > 0
          && !isProjectTemplatePrivateDirectoryMode(pathBefore.mode, platform)
        )
        || (
          index > 0
          && platform !== 'win32'
          && process.getuid !== undefined
          && pathBefore.uid !== process.getuid()
        )
        || (index > 0 && pathBefore.dev !== snapshots[0]!.dev)
      ) {
        throw new ProjectTemplateApplyStorageError(
          'UNSAFE_CONTROL_ROOT',
          'project template read-only control directory is unsafe',
        );
      }
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
      handles.push(handle);
      const opened = await handle.stat();
      if (!areProjectTemplateDirectorySnapshotsStable(pathBefore, opened)) {
        throw new ProjectTemplateApplyStorageError(
          'UNSAFE_CONTROL_ROOT',
          'project template read-only control directory changed identity',
        );
      }
      snapshots.push(opened);
      options.ioSeam?.onPhase?.(phases[index]!);
    }
    for (let index = 0; index < paths.length; index += 1) {
      const [openedAfter, pathAfter, resolvedAfter] = await Promise.all([
        handles[index]!.stat(),
        lstat(paths[index]!),
        realpath(paths[index]!),
      ]);
      if (
        resolvedAfter !== paths[index]
        || !areProjectTemplateDirectorySnapshotsStable(
          snapshots[index]!,
          openedAfter,
        )
        || !areProjectTemplateDirectorySnapshotsStable(
          openedAfter,
          pathAfter,
        )
      ) {
        throw new ProjectTemplateApplyStorageError(
          'UNSAFE_CONTROL_ROOT',
          'project template read-only control directory changed identity',
        );
      }
    }
  } catch (error) {
    primaryError = error;
  }
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    try {
      await handles[index]!.close();
    } catch (error) {
      closeFailed = true;
      primaryError ??= error;
    }
  }
  if (!closeFailed) {
    try {
      options.ioSeam?.onPhase?.('all-closed');
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError !== undefined) {
    if (primaryError instanceof ProjectTemplateApplyStorageError) {
      throw primaryError;
    }
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'project template read-only control directory cannot be proven safe',
    );
  }
  const repoStat = snapshots[0]!;
  const baselinesStat = snapshots[2]!;
  return {
    repoRoot,
    targetRoot: join(repoRoot, '.takt'),
    lockTargetPath: join(repoRoot, '.takt-template-lock.json'),
    controlRoot,
    stagingRoot: join(controlRoot, 'staging'),
    backupsRoot: join(controlRoot, 'backups'),
    baselinesRoot,
    baselinesDevice: baselinesStat.dev,
    baselinesInode: baselinesStat.ino,
    journalPath: join(controlRoot, 'journal.json'),
    lockPath: join(controlRoot, 'apply.lock'),
    device: repoStat.dev,
    inode: repoStat.ino,
    platform,
    io,
  };
}

async function assertControlIgnoreFile(
  storage: ProjectTemplateApplyStorage,
  controlIgnorePath: string,
  io: ProjectTemplateApplyStorageIo,
): Promise<void> {
  let content: Buffer;
  try {
    // One nofollow FD-bound read verifies regular-file type, nlink, exact 0600
    // mode, device, size bound, and pre/post path identity. A separate lstat
    // plus pathname read would reopen a swap window during concurrent init.
    content = await io.readPrivateFile(
      controlIgnorePath,
      CONTROL_GITIGNORE_CONTENT.byteLength,
      storage.device,
    );
  } catch {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'project template control ignore file is unsafe',
    );
  }
  if (!content.equals(CONTROL_GITIGNORE_CONTENT)) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'project template control ignore file is unsafe',
    );
  }
}

async function writePrivateDurableFile(options: {
  storage: ProjectTemplateApplyStorage;
  finalPath: string;
  content: Uint8Array;
  replace: boolean;
  io: ProjectTemplateApplyStorageIo;
}): Promise<string> {
  const { storage, finalPath, content, replace, io } = options;
  const parent = dirname(finalPath);
  const tempPath = join(
    parent,
    `.${basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let published = false;
  try {
    await ensurePrivateDirectory(io, parent, storage.device, storage.platform);
    if (!replace && await tryLstat(io, finalPath) !== undefined) {
      throw new ProjectTemplateApplyStorageError(
        'ALREADY_EXISTS',
        'project template storage artifact already exists',
      );
    }
    await io.writeExclusive(tempPath, content, PRIVATE_FILE_MODE);
    await io.chmod(tempPath, PRIVATE_FILE_MODE);
    await io.fsyncFile(tempPath);
    if (!replace && await tryLstat(io, finalPath) !== undefined) {
      throw new ProjectTemplateApplyStorageError(
        'ALREADY_EXISTS',
        'project template storage artifact already exists',
      );
    }
    await io.rename(tempPath, finalPath);
    published = true;
    await io.fsyncDirectory(parent);
    return finalPath;
  } catch (error) {
    if (!published) {
      try {
        await io.unlink(tempPath);
      } catch {
        // A failed cleanup leaves a private, uniquely named file for bounded recovery.
      }
    }
    throw ioFailure(error, published);
  }
}

export async function writeProjectTemplateStagingFile(options: {
  storage: ProjectTemplateApplyStorage;
  transactionId: string;
  target: ProjectTemplateApplyTarget;
  content: Uint8Array;
  expectedSha256: string;
  targetMode: string;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<ProjectTemplateStagingFile> {
  const transactionId = assertSafeIdentifier(options.transactionId, 'transactionId');
  const target = resolveProjectTemplateApplyTarget(options.storage, options.target);
  const expectedSha256 = assertHash(options.expectedSha256, 'expectedSha256');
  const targetMode = safeMode(options.targetMode);
  const content = Buffer.from(options.content);
  const digest = sha256(content);
  if (digest !== expectedSha256) {
    throw new ProjectTemplateApplyStorageError(
      'HASH_MISMATCH',
      'staging content does not match the expected digest',
    );
  }
  const io = options.io ?? options.storage.io;
  const transactionRoot = join(options.storage.stagingRoot, transactionId);
  await ensurePrivateDirectory(
    io,
    transactionRoot,
    options.storage.device,
    options.storage.platform,
  );
  await ensurePrivateParents(
    options.storage,
    transactionRoot,
    target.stagingRelativePath,
    io,
  );
  const absolutePath = join(transactionRoot, target.stagingRelativePath);
  await writePrivateDurableFile({
    storage: options.storage,
    finalPath: absolutePath,
    content,
    replace: false,
    io,
  });
  return {
    transactionId,
    target: target.target,
    absolutePath,
    relativePath: target.stagingRelativePath,
    sha256: digest,
    bytes: content.byteLength,
    storedMode: '0600',
    targetMode,
  };
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

export async function captureProjectTemplateBackupFile(options: {
  storage: ProjectTemplateApplyStorage;
  backupId: string;
  target: ProjectTemplateApplyTarget;
  expectedSha256: string;
  expectedMode: string;
  maxBytes: number;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<ProjectTemplateStoredFile> {
  const backupId = assertSafeIdentifier(options.backupId, 'backupId');
  const target = resolveProjectTemplateApplyTarget(options.storage, options.target);
  const expectedSha256 = assertHash(options.expectedSha256, 'expectedSha256');
  const expectedMode = safeMode(options.expectedMode);
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new ProjectTemplateApplyStorageError(
      'LIMIT_EXCEEDED',
      'backup byte budget is invalid',
    );
  }
  const io = options.io ?? options.storage.io;
  const sourcePath = target.absolutePath;
  const before = await io.lstat(sourcePath);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || before.dev !== options.storage.device
    || before.size > options.maxBytes
  ) {
    const isOversizedSafeFile = before.isFile()
      && !before.isSymbolicLink()
      && before.nlink === 1
      && before.dev === options.storage.device
      && before.size > options.maxBytes;
    throw new ProjectTemplateApplyStorageError(
      isOversizedSafeFile ? 'LIMIT_EXCEEDED' : 'UNSAFE_TARGET',
      'backup source is not a safe bounded regular file',
    );
  }
  const content = await io.readFile(sourcePath, options.maxBytes);
  const after = await io.lstat(sourcePath);
  if (!areProjectTemplateFileStatsEqual(before, after)) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_TARGET',
      'backup source changed while it was read',
    );
  }
  const digest = sha256(content);
  if (digest !== expectedSha256) {
    throw new ProjectTemplateApplyStorageError(
      'HASH_MISMATCH',
      'backup source does not match the apply plan',
    );
  }
  const actualMode = formatMode(after.mode);
  if (actualMode !== expectedMode) {
    throw new ProjectTemplateApplyStorageError(
      'MODE_MISMATCH',
      'backup source mode does not match the apply plan',
    );
  }

  const backupRoot = join(options.storage.backupsRoot, backupId);
  const blobsRoot = join(backupRoot, 'blobs');
  await ensurePrivateDirectory(
    io,
    backupRoot,
    options.storage.device,
    options.storage.platform,
  );
  await ensurePrivateDirectory(
    io,
    blobsRoot,
    options.storage.device,
    options.storage.platform,
  );
  const absolutePath = join(blobsRoot, digest);
  const existing = await tryLstat(io, absolutePath);
  if (existing === undefined) {
    await writePrivateDurableFile({
      storage: options.storage,
      finalPath: absolutePath,
      content,
      replace: false,
      io,
    });
  } else if (
    existing.isSymbolicLink()
    || !existing.isFile()
    || existing.nlink !== 1
    || existing.dev !== options.storage.device
    || !isProjectTemplatePrivateFileMode(existing.mode, options.storage.platform)
    || existing.size !== content.byteLength
    || sha256(await io.readFile(absolutePath, options.maxBytes)) !== digest
  ) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'existing backup blob is unsafe',
    );
  }
  return {
    target: target.target,
    absolutePath,
    relativePath: `blobs/${digest}`,
    sha256: digest,
    bytes: content.byteLength,
    storedMode: '0600',
    targetMode: actualMode,
  };
}

function validateBackupState(
  value: ProjectTemplateBackupEntryState,
): ProjectTemplateBackupEntryState {
  if (value === null || typeof value !== 'object') {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      'backup entry state is invalid',
    );
  }
  if (value.kind === 'absent') return { kind: 'absent' };
  if (value.kind !== 'file') {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      'backup entry state is invalid',
    );
  }
  const digest = assertHash(value.sha256, 'entry.sha256');
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      'backup entry byte count is invalid',
    );
  }
  const blobRelativePath = safeRelativePath(value.blobRelativePath);
  if (blobRelativePath !== `blobs/${digest}`) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      'backup blob path does not match its digest',
    );
  }
  return {
    kind: 'file',
    sha256: digest,
    bytes: value.bytes,
    mode: safeMode(value.mode),
    blobRelativePath,
    ...(value.modifiedAt === undefined
      ? {}
      : { modifiedAt: assertTimestamp(value.modifiedAt, 'entry.modifiedAt') }),
  };
}

function validateBackupManifest(
  manifest: ProjectTemplateBackupManifest,
): ProjectTemplateBackupManifest {
  if (
    (manifest.schemaVersion !== '1.0' && manifest.schemaVersion !== '1.1')
    || !hasExactDataKeys(manifest, [
      'schemaVersion',
      'backupId',
      'planId',
      'preconditionToken',
      'createdAt',
      'createdTargetDirectories',
      'entries',
    ])
    || !Array.isArray(manifest.entries)
    || manifest.entries.length > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxOperations
  ) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      'backup manifest shape is invalid',
    );
  }
  const paths = new Set<string>();
  let beforeTemplateBytes = 0;
  let afterTemplateBytes = 0;
  let beforeRecoveryBytes = 0;
  let afterRecoveryBytes = 0;
  const entries = manifest.entries.map((entry) => {
    if (
      entry === null
      || typeof entry !== 'object'
      || entry.target === null
      || typeof entry.target !== 'object'
    ) {
      throw new ProjectTemplateApplyStorageError(
        'INVALID_MANIFEST',
        'backup manifest entry is invalid',
      );
    }
    if (!hasExactDataKeys(entry, [
      'target', 'action', 'before', 'after',
    ])) {
      throw new ProjectTemplateApplyStorageError(
        'INVALID_MANIFEST',
        'backup manifest entry is invalid',
      );
    }
    const target = validateManifestTarget(
      entry.target,
      manifest.schemaVersion,
    );
    const targetKey = target.kind === 'template-entry'
      ? `entry:${target.path}`
      : target.kind === 'merge-baseline'
        ? `baseline:${target.sha256}`
        : target.kind;
    if (paths.has(targetKey)) {
      throw new ProjectTemplateApplyStorageError(
        'INVALID_MANIFEST',
        'backup manifest contains duplicate paths',
      );
    }
    paths.add(targetKey);
    if (!['add', 'update', 'delete'].includes(entry.action)) {
      throw new ProjectTemplateApplyStorageError(
        'INVALID_MANIFEST',
        'backup manifest action is invalid',
      );
    }
    const before = validateBackupState(entry.before);
    const after = validateBackupState(entry.after);
    const maxBytes = projectTemplateTransactionTargetByteLimit(target.kind);
    if (
      (before.kind === 'file' && before.bytes > maxBytes)
      || (after.kind === 'file' && after.bytes > maxBytes)
    ) {
      throw new ProjectTemplateApplyStorageError(
        'INVALID_MANIFEST', 'backup entry exceeds its target byte budget',
      );
    }
    const addStateBytes = (
      state: ProjectTemplateBackupEntryState,
      template: 'before' | 'after',
    ): void => {
      if (state.kind !== 'file') return;
      if (template === 'before') beforeRecoveryBytes += state.bytes;
      else afterRecoveryBytes += state.bytes;
      if (target.kind === 'template-entry') {
        if (template === 'before') beforeTemplateBytes += state.bytes;
        else afterTemplateBytes += state.bytes;
      }
      if (
        !Number.isSafeInteger(beforeRecoveryBytes)
        || !Number.isSafeInteger(afterRecoveryBytes)
        || !Number.isSafeInteger(beforeTemplateBytes)
        || !Number.isSafeInteger(afterTemplateBytes)
        || beforeRecoveryBytes > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxRecoveryBytes
        || afterRecoveryBytes > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxRecoveryBytes
        || beforeTemplateBytes > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxBytes
        || afterTemplateBytes > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxBytes
      ) {
        throw new ProjectTemplateApplyStorageError(
          'INVALID_MANIFEST', 'backup manifest exceeds its aggregate byte budget',
        );
      }
    };
    addStateBytes(before, 'before');
    addStateBytes(after, 'after');
    return {
      target,
      action: entry.action,
      before,
      after,
    };
  });
  const createdTargetDirectories = validateCreatedTargetDirectories(
    manifest.createdTargetDirectories,
    'INVALID_MANIFEST',
  );
  const allowedCreatedDirectories = new Set<string>();
  for (const entry of entries) {
    if (entry.target.kind !== 'template-entry') continue;
    allowedCreatedDirectories.add('');
    const parent = dirname(entry.target.path).split('/').filter(
      (segment) => segment !== '.',
    );
    let current = '';
    for (const segment of parent) {
      current = current === '' ? segment : `${current}/${segment}`;
      allowedCreatedDirectories.add(current);
    }
  }
  if (createdTargetDirectories.some((path) => !allowedCreatedDirectories.has(path))) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      'created target directory is not an ancestor of a template target',
    );
  }
  return {
    schemaVersion: manifest.schemaVersion,
    backupId: assertSafeIdentifier(manifest.backupId, 'backupId'),
    planId: assertHash(manifest.planId, 'planId'),
    preconditionToken: assertHash(manifest.preconditionToken, 'preconditionToken'),
    createdAt: assertTimestamp(manifest.createdAt, 'createdAt'),
    createdTargetDirectories,
    entries,
  };
}

function validateCreatedTargetDirectories(
  value: unknown,
  code: 'INVALID_MANIFEST' | 'INVALID_JOURNAL',
): string[] {
  if (
    !Array.isArray(value)
    || value.length > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxCreatedTargetDirectories
  ) {
    throw new ProjectTemplateApplyStorageError(code, 'created target directories are invalid');
  }
  const seen = new Set<string>();
  const directories = value.map((path) => {
    if (typeof path !== 'string') {
      throw new ProjectTemplateApplyStorageError(code, 'created target directory is invalid');
    }
    const normalized = path === '' ? '' : safeRelativePath(path);
    if (seen.has(normalized)) {
      throw new ProjectTemplateApplyStorageError(code, 'created target directories contain duplicates');
    }
    seen.add(normalized);
    return normalized;
  });
  const canonical = [...directories].sort((left, right) => {
    const leftDepth = left === '' ? 0 : left.split('/').length;
    const rightDepth = right === '' ? 0 : right.split('/').length;
    return leftDepth - rightDepth || left.localeCompare(right);
  });
  if (directories.some((path, index) => path !== canonical[index])) {
    throw new ProjectTemplateApplyStorageError(
      code,
      'created target directories are not in canonical order',
    );
  }
  return directories;
}

export async function writeProjectTemplateBackupManifest(options: {
  storage: ProjectTemplateApplyStorage;
  manifest: ProjectTemplateBackupManifest;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<string> {
  const manifest = validateBackupManifest(options.manifest);
  const content = Buffer.from(`${canonicalizeTaktpackJson(manifest)}\n`);
  if (content.byteLength > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxManifestBytes) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST', 'backup manifest exceeds its serialized byte budget',
    );
  }
  const io = options.io ?? options.storage.io;
  const backupRoot = join(options.storage.backupsRoot, manifest.backupId);
  await ensurePrivateDirectory(
    io,
    backupRoot,
    options.storage.device,
    options.storage.platform,
  );
  return writePrivateDurableFile({
    storage: options.storage,
    finalPath: join(backupRoot, 'manifest.json'),
    content,
    replace: false,
    io,
  });
}

export function parseProjectTemplateApplyJournal(
  value: unknown,
): ProjectTemplateApplyJournal {
  if (value === null || typeof value !== 'object') {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_JOURNAL',
      'apply journal shape is invalid',
    );
  }
  const journal = value as Partial<ProjectTemplateApplyJournal>;
  const validStates = new Set<ProjectTemplateApplyJournalState>([
    'prepared',
    'committing',
    'verifying',
    'committed',
    'rolling-back',
    'rolled-back',
    'restore-failed',
  ]);
  if (
    (journal.schemaVersion !== '1.0' && journal.schemaVersion !== '1.1')
    || !hasExactDataKeys(value, [
      'schemaVersion',
      'transactionId',
      'planId',
      'backupId',
      'state',
      'completedOperations',
      'createdTargetDirectories',
      'updatedAt',
    ])
    || typeof journal.transactionId !== 'string'
    || typeof journal.planId !== 'string'
    || typeof journal.backupId !== 'string'
    || typeof journal.state !== 'string'
    || !validStates.has(journal.state)
    || !Array.isArray(journal.completedOperations)
    || journal.completedOperations.length
      > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxOperations
    || journal.completedOperations.some(
      (operation) => (
        typeof operation !== 'string'
        || operation.length > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxOperationKeyLength
        || !isOperationKeyForSchema(operation, journal.schemaVersion!)
      ),
    )
    || typeof journal.updatedAt !== 'string'
  ) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_JOURNAL',
      'apply journal shape is invalid',
    );
  }
  const createdTargetDirectories = validateCreatedTargetDirectories(
    journal.createdTargetDirectories,
    'INVALID_JOURNAL',
  );
  return {
    schemaVersion: journal.schemaVersion,
    transactionId: assertSafeIdentifier(journal.transactionId, 'transactionId'),
    planId: assertHash(journal.planId, 'planId'),
    backupId: assertSafeIdentifier(journal.backupId, 'backupId'),
    state: journal.state,
    completedOperations: [...journal.completedOperations],
    createdTargetDirectories,
    updatedAt: assertTimestamp(journal.updatedAt, 'updatedAt'),
  };
}

function isOperationKeyForSchema(
  value: string,
  schemaVersion: '1.0' | '1.1',
): boolean {
  if (value.startsWith(PROJECT_TEMPLATE_ENTRY_OPERATION_PREFIX)) {
    try {
      return value === `${PROJECT_TEMPLATE_ENTRY_OPERATION_PREFIX}${safeRelativePath(
        value.slice(PROJECT_TEMPLATE_ENTRY_OPERATION_PREFIX.length),
      )}`;
    } catch {
      return false;
    }
  }
  return schemaVersion === '1.0'
    ? value === 'lock'
    : /^baseline:[a-f0-9]{64}$/.test(value)
      || value === 'content-lock'
      || value === 'repertoire-lock'
      || value === 'source-provenance';
}

export async function writeProjectTemplateApplyJournal(options: {
  storage: ProjectTemplateApplyStorage;
  journal: ProjectTemplateApplyJournal;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<string> {
  const journal = parseProjectTemplateApplyJournal(options.journal);
  const content = Buffer.from(`${canonicalizeTaktpackJson(journal)}\n`);
  if (content.byteLength > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxJournalBytes) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_JOURNAL', 'apply journal exceeds its serialized byte budget',
    );
  }
  return writePrivateDurableFile({
    storage: options.storage,
    finalPath: options.storage.journalPath,
    content,
    replace: true,
    io: options.io ?? options.storage.io,
  });
}

export async function readProjectTemplateBackupManifest(options: {
  storage: ProjectTemplateApplyStorage;
  backupId: string;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<ProjectTemplateBackupManifest> {
  const backupId = assertSafeIdentifier(options.backupId, 'backupId');
  const io = options.io ?? options.storage.io;
  const manifestPath = join(options.storage.backupsRoot, backupId, 'manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse((await io.readFile(
      manifestPath,
      PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxManifestBytes,
    )).toString('utf8'));
  } catch {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      'backup generation manifest cannot be read',
    );
  }
  const manifest = validateBackupManifest(parsed as ProjectTemplateBackupManifest);
  if (manifest.backupId !== backupId) {
    throw new ProjectTemplateApplyStorageError(
      'INVALID_MANIFEST',
      'backup directory does not match its manifest',
    );
  }
  return manifest;
}

/**
 * Lists complete backup generations without allowing the control directory to
 * become an unbounded input. The directory and every generation are witnessed
 * before and after manifest validation so callers never receive IDs collected
 * across a pathname replacement race.
 */
export async function listProjectTemplateBackupIdsBounded(options: {
  storage: ProjectTemplateApplyStorage;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<string[]> {
  const io = options.io ?? options.storage.io;
  const backupsBefore = await io.lstat(options.storage.backupsRoot);
  const backupsRealpathBefore = await io.realpath(options.storage.backupsRoot);
  if (
    backupsRealpathBefore !== options.storage.backupsRoot
    || !backupsBefore.isDirectory()
    || backupsBefore.isSymbolicLink()
    || backupsBefore.dev !== options.storage.device
  ) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'backup directory cannot be proven safe',
    );
  }
  // Why: the storage iterator throws while observing the 33rd entry. This is
  // a resource bound, not a presentation truncation that could hide drift.
  const entries = await io.readdir(
    options.storage.backupsRoot,
    MAX_PROJECT_TEMPLATE_LISTED_BACKUPS,
  );
  const generations: Array<{ backupId: string; createdAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_CONTROL_ROOT',
        'backup root contains an unsafe entry',
      );
    }
    const backupId = assertSafeIdentifier(entry.name, 'backupId');
    const generationPath = join(options.storage.backupsRoot, backupId);
    const generationBefore = await io.lstat(generationPath);
    const generationRealpath = await io.realpath(generationPath);
    if (
      generationRealpath !== generationPath
      || !generationBefore.isDirectory()
      || generationBefore.isSymbolicLink()
      || generationBefore.dev !== options.storage.device
    ) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_CONTROL_ROOT',
        'backup generation cannot be proven safe',
      );
    }
    const manifest = await readProjectTemplateBackupManifest({
      storage: options.storage,
      backupId,
      io,
    });
    const generationAfter = await io.lstat(generationPath);
    if (!areProjectTemplateDirectorySnapshotsStable(generationBefore, generationAfter)) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_CONTROL_ROOT',
        'backup generation changed during inspection',
      );
    }
    generations.push({ backupId, createdAt: manifest.createdAt });
  }
  const backupsAfter = await io.lstat(options.storage.backupsRoot);
  const backupsRealpathAfter = await io.realpath(options.storage.backupsRoot);
  if (
    backupsRealpathAfter !== options.storage.backupsRoot
    || !areProjectTemplateDirectorySnapshotsStable(backupsBefore, backupsAfter)
  ) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'backup directory changed during inspection',
    );
  }
  generations.sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
    || right.backupId.localeCompare(left.backupId)
  ));
  return generations.map(({ backupId }) => backupId);
}

async function removeControlTree(
  storage: ProjectTemplateApplyStorage,
  path: string,
  io: ProjectTemplateApplyStorageIo,
  budget: { entries: number },
  depth = 0,
): Promise<void> {
  if (depth > MAX_CONTROL_TREE_DEPTH) {
    throw new ProjectTemplateApplyStorageError(
      'LIMIT_EXCEEDED',
      'backup tree exceeds the removal depth limit',
    );
  }
  const entry = await io.lstat(path);
  if (entry.isSymbolicLink() || entry.dev !== storage.device) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'backup tree contains an unsafe entry',
    );
  }
  budget.entries += 1;
  if (budget.entries > MAX_CONTROL_DIRECTORY_ENTRIES) {
    throw new ProjectTemplateApplyStorageError(
      'LIMIT_EXCEEDED',
      'backup tree exceeds the removal entry limit',
    );
  }
  if (entry.isDirectory()) {
    for (const child of await io.readdir(
      path,
      MAX_CONTROL_DIRECTORY_ENTRIES - budget.entries,
    )) {
      await removeControlTree(storage, join(path, child.name), io, budget, depth + 1);
    }
    await io.rmdir(path);
    return;
  }
  if (!entry.isFile() || entry.nlink !== 1) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'backup tree contains a special or linked file',
    );
  }
  await io.unlink(path);
}

async function removeNamedControlRoot(options: {
  storage: ProjectTemplateApplyStorage;
  parentRoot: string;
  identifier: string;
  label: string;
  io: ProjectTemplateApplyStorageIo;
}): Promise<boolean> {
  const identifier = assertSafeIdentifier(options.identifier, options.label);
  const path = join(options.parentRoot, identifier);
  if (await tryLstat(options.io, path) === undefined) return false;
  try {
    await removeControlTree(
      options.storage,
      path,
      options.io,
      { entries: 0 },
    );
    await options.io.fsyncDirectory(options.parentRoot);
    return true;
  } catch (error) {
    throw ioFailure(error, true);
  }
}

export async function removeProjectTemplateStagingTransaction(options: {
  storage: ProjectTemplateApplyStorage;
  transactionId: string;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<boolean> {
  return removeNamedControlRoot({
    storage: options.storage,
    parentRoot: options.storage.stagingRoot,
    identifier: options.transactionId,
    label: 'transactionId',
    io: options.io ?? options.storage.io,
  });
}

export async function removeProjectTemplateBackupGeneration(options: {
  storage: ProjectTemplateApplyStorage;
  backupId: string;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<boolean> {
  return removeNamedControlRoot({
    storage: options.storage,
    parentRoot: options.storage.backupsRoot,
    identifier: options.backupId,
    label: 'backupId',
    io: options.io ?? options.storage.io,
  });
}

/**
 * Reclaims preparation artifacts left before a manifest could be published.
 * The caller must hold the apply lease: without an active owner, every staging
 * transaction is orphaned, while a backup is reclaimable only when its
 * generation never reached the durable manifest commit point.
 */
export async function reclaimProjectTemplatePreparationOrphans(options: {
  storage: ProjectTemplateApplyStorage;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<{ stagingTransactionIds: string[]; backupIds: string[] }> {
  const io = options.io ?? options.storage.io;
  const stagingEntries = await io.readdir(
    options.storage.stagingRoot,
    MAX_CONTROL_DIRECTORY_ENTRIES,
  );
  const backupEntries = await io.readdir(
    options.storage.backupsRoot,
    MAX_CONTROL_DIRECTORY_ENTRIES,
  );
  const stagingTransactionIds: string[] = [];
  for (const entry of stagingEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_CONTROL_ROOT',
        'staging root contains an unsafe entry',
      );
    }
    const transactionId = assertSafeIdentifier(entry.name, 'transactionId');
    await removeProjectTemplateStagingTransaction({
      storage: options.storage,
      transactionId,
      io,
    });
    stagingTransactionIds.push(transactionId);
  }
  const backupIds: string[] = [];
  for (const entry of backupEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_CONTROL_ROOT',
        'backup root contains an unsafe entry',
      );
    }
    const backupId = assertSafeIdentifier(entry.name, 'backupId');
    const manifestPath = join(options.storage.backupsRoot, backupId, 'manifest.json');
    if (await tryLstat(io, manifestPath) !== undefined) {
      // Validate completed generations before target mutation. A malformed or
      // replaced manifest is not a preparation orphan and must fail closed.
      await readProjectTemplateBackupManifest({
        storage: options.storage,
        backupId,
        io,
      });
      continue;
    }
    await removeProjectTemplateBackupGeneration({
      storage: options.storage,
      backupId,
      io,
    });
    backupIds.push(backupId);
  }
  return { stagingTransactionIds, backupIds };
}

export async function pruneProjectTemplateBackupGenerations(options: {
  storage: ProjectTemplateApplyStorage;
  maxGenerations?: number;
  protectedBackupIds?: readonly string[];
  io?: ProjectTemplateApplyStorageIo;
}): Promise<{
  removedBackupIds: string[];
  retainedBackupIds: string[];
}> {
  const maxGenerations =
    options.maxGenerations ?? DEFAULT_PROJECT_TEMPLATE_BACKUP_GENERATIONS;
  if (
    !Number.isSafeInteger(maxGenerations)
    || maxGenerations < 1
    || maxGenerations > 32
  ) {
    throw new ProjectTemplateApplyStorageError(
      'LIMIT_EXCEEDED',
      'backup generation limit must be between 1 and 32',
    );
  }
  const io = options.io ?? options.storage.io;
  if ((options.protectedBackupIds?.length ?? 0) > 32) {
    throw new ProjectTemplateApplyStorageError(
      'LIMIT_EXCEEDED',
      'protected backup generation limit must not exceed 32',
    );
  }
  const protectedBackupIds = new Set(
    (options.protectedBackupIds ?? []).map(
      (backupId) => assertSafeIdentifier(backupId, 'protectedBackupId'),
    ),
  );
  const directoryEntries = await io.readdir(
    options.storage.backupsRoot,
    MAX_CONTROL_DIRECTORY_ENTRIES,
  );
  const generations: Array<{ backupId: string; createdAt: string }> = [];
  for (const entry of directoryEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_CONTROL_ROOT',
        'backup root contains an unsafe entry',
      );
    }
    const backupId = assertSafeIdentifier(entry.name, 'backupId');
    const manifest = await readProjectTemplateBackupManifest({
      storage: options.storage,
      backupId,
      io,
    });
    generations.push({ backupId, createdAt: manifest.createdAt });
  }
  generations.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
    || right.backupId.localeCompare(left.backupId));
  const retainedBackupIds: string[] = [];
  const removedBackupIds: string[] = [];
  let unprotectedRetained = 0;
  for (const { backupId } of generations) {
    if (protectedBackupIds.has(backupId) || unprotectedRetained < maxGenerations) {
      retainedBackupIds.push(backupId);
      if (!protectedBackupIds.has(backupId)) unprotectedRetained += 1;
    } else {
      removedBackupIds.push(backupId);
    }
  }
  const removalBudget = { entries: 0 };
  for (const backupId of removedBackupIds) {
    await removeControlTree(
      options.storage,
      join(options.storage.backupsRoot, backupId),
      io,
      removalBudget,
    );
  }
  if (removedBackupIds.length > 0) {
    try {
      await io.fsyncDirectory(options.storage.backupsRoot);
    } catch (error) {
      throw ioFailure(error, true);
    }
  }
  return { removedBackupIds, retainedBackupIds };
}
