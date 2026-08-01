import { Dirent, type Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inspectTaktpack } from './archive-inspector.js';
import { DEFAULT_TAKTPACK_LIMITS } from './archive-types.js';
import {
  createProjectTemplateCliFailure,
  createProjectTemplateCliSuccess,
  projectTemplateCliExitCodeForErrorCode,
  type ProjectTemplateCliErrorCode,
  type ProjectTemplateCliOutcome,
} from './cli-machine-contract.js';
import {
  ProjectTemplateCompanionLockStateError,
  readProjectTemplateCompanionLockState,
} from './companion-lock-state-reader.js';
import { TaktpackError } from './errors.js';
import { inspectProjectTemplateApplyGuard } from './apply-guard.js';
import {
  openProjectTemplateApplyStorageReadOnly,
  ProjectTemplateApplyStorageError,
  readProjectTemplateBackupManifest,
} from './apply-storage.js';
import { MAX_TEMPLATE_ENTRIES } from './validation.js';

const MAX_BACKUP_IDS = 32;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const REGEXP_TEST = RegExp.prototype.test;
const REFLECT_APPLY = Reflect.apply;
const DIRENT_IS_DIRECTORY = Dirent.prototype.isDirectory;
const DIRENT_IS_SYMBOLIC_LINK = Dirent.prototype.isSymbolicLink;

interface InspectArchiveProjection {
  readonly archiveSha256: string;
  readonly manifest: { readonly entries: readonly unknown[] };
  readonly compatibility: { readonly status: 'unknown' | 'compatible' | 'incompatible' };
}

interface CompanionProjection {
  readonly state: 'first-install' | 'update';
  readonly contentLock?: { readonly manifestSha256: string };
}

interface ApplyGuardProjection {
  readonly blocks: readonly { readonly code: string }[];
}

export interface ProjectTemplateCliInspectListDependencies {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly realpath: (path: string) => Promise<string>;
  readonly inspectTaktpack: (
    path: string,
    options: {
      readonly signal?: AbortSignal;
      readonly currentTaktVersion?: string;
      readonly limits: typeof DEFAULT_TAKTPACK_LIMITS;
    },
  ) => Promise<InspectArchiveProjection>;
  readonly readCompanionLockState: (cwd: string) => CompanionProjection;
  readonly inspectApplyGuard: (options: { readonly repoPath: string }) => ApplyGuardProjection;
  readonly listBackupIds: (cwd: string, installed: boolean) => Promise<readonly string[]>;
}

export interface ProjectTemplateCliInspectOptions {
  readonly cwd: string;
  readonly sourcePath: string;
  readonly signal?: AbortSignal;
  readonly currentTaktVersion?: string;
}

export interface ProjectTemplateCliListOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) throw new Error('invalid projection');
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    Object,
    [value, key],
  ) as PropertyDescriptor | undefined;
  if (descriptor === undefined || !('value' in descriptor)) throw new Error('invalid projection');
  return descriptor.value;
}

function testPattern(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_TEST, pattern, [value]) as boolean;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function snapshotStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) throw new Error('invalid projection');
  const length = ownValue(value, 'length');
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maxItems) {
    throw new Error('invalid projection');
  }
  const result: string[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const item = ownValue(value, String(index));
    if (typeof item !== 'string') throw new Error('invalid projection');
    result.push(item);
  }
  return result;
}

function outcomeSuccess(
  command: 'project-template inspect' | 'project-template list',
  result: Parameters<typeof createProjectTemplateCliSuccess>[0]['result'],
): ProjectTemplateCliOutcome {
  const envelope = createProjectTemplateCliSuccess({
    command,
    mode: 'dry-run',
    result,
  } as Parameters<typeof createProjectTemplateCliSuccess>[0]);
  return { envelope, exitCode: 0 };
}

function outcomeFailure(
  command: 'project-template inspect' | 'project-template list',
  code: ProjectTemplateCliErrorCode,
): ProjectTemplateCliOutcome {
  const envelope = createProjectTemplateCliFailure({ command, mode: 'dry-run', code });
  return { envelope, exitCode: projectTemplateCliExitCodeForErrorCode(code) };
}

function isStableFile(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.nlink === 1
    && right.nlink === 1
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function isStableDirectory(left: Stats, right: Stats): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function inspectErrorCode(error: unknown, signal?: AbortSignal): ProjectTemplateCliErrorCode {
  if (signal?.aborted === true) return 'INTERRUPTED';
  if (error instanceof TaktpackError) {
    if (error.code === 'OPERATION_ABORTED') return 'INTERRUPTED';
    if (error.code === 'ARCHIVE_READ_FAILED' || error.code === 'OPERATION_TIMEOUT') {
      return 'SOURCE_UNAVAILABLE';
    }
    return 'SOURCE_INTEGRITY_FAILED';
  }
  if (error instanceof ProjectTemplateCompanionLockStateError) {
    return error.code === 'UNREADABLE_LOCK' ? 'SOURCE_UNAVAILABLE' : 'SOURCE_INTEGRITY_FAILED';
  }
  const code = typeof error === 'object' && error !== null
    ? OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(error, 'code')?.value
    : undefined;
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EIO') {
    return 'SOURCE_UNAVAILABLE';
  }
  return 'INTERNAL';
}

function snapshotInspection(value: unknown): {
  packId: string;
  entryCount: number;
  readiness: 'ready' | 'review-required' | 'blocked';
  reviewCodes: readonly ('REVIEW_REQUIRED')[];
} {
  const packId = ownValue(value, 'archiveSha256');
  const manifest = ownValue(value, 'manifest');
  const entries = ownValue(manifest, 'entries');
  const compatibility = ownValue(value, 'compatibility');
  const status = ownValue(compatibility, 'status');
  if (typeof packId !== 'string' || !testPattern(SHA256_PATTERN, packId)) {
    throw new Error('invalid projection');
  }
  if (!Array.isArray(entries)) throw new Error('invalid projection');
  const entryCount = ownValue(entries, 'length');
  if (!Number.isSafeInteger(entryCount) || (entryCount as number) < 0
    || (entryCount as number) > MAX_TEMPLATE_ENTRIES) {
    throw new Error('invalid projection');
  }
  if (status === 'compatible') {
    return { packId, entryCount: entryCount as number, readiness: 'ready', reviewCodes: [] };
  }
  if (status === 'unknown') {
    return {
      packId,
      entryCount: entryCount as number,
      readiness: 'review-required',
      reviewCodes: ['REVIEW_REQUIRED'],
    };
  }
  if (status === 'incompatible') {
    return {
      packId,
      entryCount: entryCount as number,
      readiness: 'blocked',
      reviewCodes: ['REVIEW_REQUIRED'],
    };
  }
  throw new Error('invalid projection');
}

const productionDependencies: ProjectTemplateCliInspectListDependencies = {
  lstat,
  realpath,
  inspectTaktpack,
  readCompanionLockState: readProjectTemplateCompanionLockState,
  inspectApplyGuard: inspectProjectTemplateApplyGuard,
  listBackupIds: listProjectTemplateBackupIdsReadOnly,
};

function dependenciesWith(
  overrides: Partial<ProjectTemplateCliInspectListDependencies>,
): ProjectTemplateCliInspectListDependencies {
  return { ...productionDependencies, ...overrides };
}

export function inspectProjectTemplateForCli(
  options: ProjectTemplateCliInspectOptions,
): Promise<ProjectTemplateCliOutcome> {
  return inspectProjectTemplateForCliWithDependencies(options, {});
}

export async function inspectProjectTemplateForCliWithDependencies(
  options: ProjectTemplateCliInspectOptions,
  dependencyOverrides: Partial<ProjectTemplateCliInspectListDependencies>,
): Promise<ProjectTemplateCliOutcome> {
  const dependencies = dependenciesWith(dependencyOverrides);
  if (isAborted(options.signal)) {
    return outcomeFailure('project-template inspect', 'INTERRUPTED');
  }
  const cwd = resolve(options.cwd);
  const sourcePath = resolve(cwd, options.sourcePath);
  try {
    const [cwdBefore, cwdRealpath, sourceBefore, sourceRealpath] = await Promise.all([
      dependencies.lstat(cwd),
      dependencies.realpath(cwd),
      dependencies.lstat(sourcePath),
      dependencies.realpath(sourcePath),
    ]);
    if (cwdRealpath !== cwd || !cwdBefore.isDirectory() || cwdBefore.isSymbolicLink()
      || sourceRealpath !== sourcePath
      || !sourceBefore.isFile() || sourceBefore.isSymbolicLink() || sourceBefore.nlink !== 1
      || sourceBefore.size > DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes) {
      return outcomeFailure('project-template inspect', 'SOURCE_INTEGRITY_FAILED');
    }
    const inspection = await dependencies.inspectTaktpack(sourcePath, {
      signal: options.signal,
      currentTaktVersion: options.currentTaktVersion,
      limits: DEFAULT_TAKTPACK_LIMITS,
    });
    const [cwdAfter, cwdRealpathAfter, sourceAfter, sourceRealpathAfter] = await Promise.all([
      dependencies.lstat(cwd),
      dependencies.realpath(cwd),
      dependencies.lstat(sourcePath),
      dependencies.realpath(sourcePath),
    ]);
    if (cwdRealpathAfter !== cwd || !isStableDirectory(cwdBefore, cwdAfter)
      || sourceRealpathAfter !== sourcePath
      || !isStableFile(sourceBefore, sourceAfter)) {
      return outcomeFailure('project-template inspect', 'SOURCE_INTEGRITY_FAILED');
    }
    const projected = snapshotInspection(inspection);
    return outcomeSuccess('project-template inspect', {
      packId: projected.packId,
      entryCount: projected.entryCount,
      archiveBytes: sourceAfter.size,
      // Why: taktpack 1.0 carries no repertoire dependency declaration. Zero
      // is the only truthful closed-schema value; deriving it from paths or
      // source metadata would leak provenance and invent authority.
      dependencyCount: 0,
      readiness: projected.readiness,
      reviewCodes: projected.reviewCodes,
    });
  } catch (error) {
    return outcomeFailure('project-template inspect', inspectErrorCode(error, options.signal));
  }
}

function recoveryRequired(report: unknown): boolean {
  const blocks = ownValue(report, 'blocks');
  if (!Array.isArray(blocks)) throw new Error('invalid guard projection');
  const length = ownValue(blocks, 'length');
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 8_192) {
    throw new Error('invalid guard projection');
  }
  for (let index = 0; index < (length as number); index += 1) {
    const code = ownValue(ownValue(blocks, String(index)), 'code');
    if (code === 'RECOVERY_REQUIRED' || code === 'RECOVERY_REQUIRED_UNKNOWN') return true;
    if (typeof code !== 'string') throw new Error('invalid guard projection');
  }
  return false;
}

function snapshotCompanion(value: unknown): { installed: false } | { installed: true; targetId: string } {
  const state = ownValue(value, 'state');
  if (state === 'first-install') return { installed: false };
  if (state !== 'update') throw new Error('invalid companion projection');
  const targetId = ownValue(ownValue(value, 'contentLock'), 'manifestSha256');
  if (typeof targetId !== 'string' || !testPattern(SHA256_PATTERN, targetId)) {
    throw new Error('invalid companion projection');
  }
  return { installed: true, targetId };
}

export function listProjectTemplatesForCli(
  options: ProjectTemplateCliListOptions,
): Promise<ProjectTemplateCliOutcome> {
  return listProjectTemplatesForCliWithDependencies(options, {});
}

export async function listProjectTemplatesForCliWithDependencies(
  options: ProjectTemplateCliListOptions,
  dependencyOverrides: Partial<ProjectTemplateCliInspectListDependencies>,
): Promise<ProjectTemplateCliOutcome> {
  const dependencies = dependenciesWith(dependencyOverrides);
  if (isAborted(options.signal)) {
    return outcomeFailure('project-template list', 'INTERRUPTED');
  }
  const cwd = resolve(options.cwd);
  try {
    const companion = snapshotCompanion(dependencies.readCompanionLockState(cwd));
    if (recoveryRequired(dependencies.inspectApplyGuard({ repoPath: cwd }))) {
      return outcomeFailure('project-template list', 'RECOVERY_REQUIRED');
    }
    if (isAborted(options.signal)) {
      return outcomeFailure('project-template list', 'INTERRUPTED');
    }
    const backupIds = snapshotStringArray(
      await dependencies.listBackupIds(cwd, companion.installed),
      MAX_BACKUP_IDS,
    );
    for (const backupId of backupIds) {
      if (!testPattern(BACKUP_ID_PATTERN, backupId)) throw new Error('invalid backup id');
    }
    backupIds.sort();
    return outcomeSuccess(
      'project-template list',
      companion.installed
        ? {
          installed: true,
          targetId: companion.targetId,
          backupIds,
          recoveryState: 'clean',
        }
        : {
          installed: false,
          backupIds,
          recoveryState: 'clean',
        },
    );
  } catch (error) {
    if (isAborted(options.signal)) {
      return outcomeFailure('project-template list', 'INTERRUPTED');
    }
    if (error instanceof ProjectTemplateCompanionLockStateError) {
      return outcomeFailure(
        'project-template list',
        error.code === 'UNREADABLE_LOCK' ? 'SOURCE_UNAVAILABLE' : 'SOURCE_INTEGRITY_FAILED',
      );
    }
    if (error instanceof ProjectTemplateApplyStorageError) {
      return outcomeFailure('project-template list', 'SECURITY_GUARD');
    }
    return outcomeFailure('project-template list', 'SECURITY_GUARD');
  }
}

async function listProjectTemplateBackupIdsReadOnly(
  cwd: string,
  installed: boolean,
): Promise<readonly string[]> {
  const controlRoot = join(resolve(cwd), '.takt-control');
  try {
    await lstat(controlRoot);
  } catch (error) {
    const code = typeof error === 'object' && error !== null
      ? OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(error, 'code')?.value
      : undefined;
    if (code === 'ENOENT' && !installed) return [];
    throw error;
  }
  const storage = await openProjectTemplateApplyStorageReadOnly({ repoPath: cwd });
  const backupsBefore = await storage.io.lstat(storage.backupsRoot);
  const resolvedBefore = await storage.io.realpath(storage.backupsRoot);
  if (resolvedBefore !== storage.backupsRoot || !backupsBefore.isDirectory()
    || backupsBefore.isSymbolicLink() || backupsBefore.dev !== storage.device) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'backup directory cannot be proven safe',
    );
  }
  // Why: asking the storage boundary for at most 32 entries makes the 33rd
  // generation a hard failure before it can become an unbounded CLI result.
  const entries = await storage.io.readdir(storage.backupsRoot, MAX_BACKUP_IDS);
  const backupIds: string[] = [];
  for (const entry of entries) {
    const backupId = snapshotBackupDirent(entry);
    const generationPath = join(storage.backupsRoot, backupId);
    const generationBefore = await storage.io.lstat(generationPath);
    const generationRealpath = await storage.io.realpath(generationPath);
    if (generationRealpath !== generationPath || !generationBefore.isDirectory()
      || generationBefore.isSymbolicLink() || generationBefore.dev !== storage.device) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_CONTROL_ROOT',
        'backup generation cannot be proven safe',
      );
    }
    await readProjectTemplateBackupManifest({ storage, backupId });
    const generationAfter = await storage.io.lstat(generationPath);
    if (!isStableDirectory(generationBefore, generationAfter)) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_CONTROL_ROOT',
        'backup generation changed during inspection',
      );
    }
    backupIds.push(backupId);
  }
  const backupsAfter = await storage.io.lstat(storage.backupsRoot);
  const resolvedAfter = await storage.io.realpath(storage.backupsRoot);
  if (resolvedAfter !== storage.backupsRoot || !isStableDirectory(backupsBefore, backupsAfter)) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'backup directory changed during inspection',
    );
  }
  return backupIds;
}

function snapshotBackupDirent(entry: Dirent): string {
  const name = ownValue(entry, 'name');
  if (typeof name !== 'string'
    || !REFLECT_APPLY(DIRENT_IS_DIRECTORY, entry, [])
    || REFLECT_APPLY(DIRENT_IS_SYMBOLIC_LINK, entry, [])
    || !testPattern(BACKUP_ID_PATTERN, name)) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'backup directory contains an unsafe generation',
    );
  }
  return name;
}
