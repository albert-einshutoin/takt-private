import { Dirent, type Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { types } from 'node:util';
import { createHash } from 'node:crypto';
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
  PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1,
  createProjectTemplateCliV1_1FailureFor,
  createProjectTemplateCliV1_1Success,
  type ProjectTemplateCliV1_1Outcome,
} from './cli-machine-contract-v1-1.js';
import type { TemplateCapability, TemplateEntryPolicy, TemplateSource } from './types.js';
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
import { PROJECT_TEMPLATE_CONTROL_DIRECTORY } from './control-root-contract.js';
import { MAX_TEMPLATE_ENTRIES, parsePortablePath } from './validation.js';

const MAX_BACKUP_IDS = 32;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_PROTOTYPE = Object.prototype;
const REGEXP_TEST = RegExp.prototype.test;
const REGEXP_EXEC = RegExp.prototype.exec;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_PUSH = Array.prototype.push;
const ARRAY_SORT = Array.prototype.sort;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const DIRENT_IS_DIRECTORY = Dirent.prototype.isDirectory;
const DIRENT_IS_SYMBOLIC_LINK = Dirent.prototype.isSymbolicLink;
const TYPES_IS_PROXY = types.isProxy;
const SET = Set;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const HASH_SAMPLE = createHash('sha256');
const HASH_UPDATE = HASH_SAMPLE.update;
const HASH_DIGEST = HASH_SAMPLE.digest;
const INSPECT_DETAIL_LIMIT = 256;
const CAPABILITY_ORDER = Object.freeze([
  'executable', 'github-write', 'external-command',
] as const satisfies readonly TemplateCapability[]);
const CAPABILITIES = new SET<TemplateCapability>(CAPABILITY_ORDER);
const POLICIES = new SET<TemplateEntryPolicy>([
  'managed', 'merge', 'scaffold', 'excluded',
]);
const TOKEN_PATTERN = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u;

class ProjectTemplateCliInspectProjectionError extends Error {}

interface InspectArchiveProjection {
  readonly archiveSha256: string;
  readonly manifestSha256?: string;
  readonly descriptor?: { readonly version: '1.0' };
  readonly manifest: {
    readonly entries: readonly {
      readonly path?: string;
      readonly policy?: TemplateEntryPolicy;
      readonly capabilities?: readonly TemplateCapability[];
    }[];
    readonly packVersion?: string;
    readonly takt?: { readonly minVersion?: string; readonly maxVersion?: string };
    readonly source?: TemplateSource;
    readonly capabilities?: readonly TemplateCapability[];
  };
  readonly compatibility: {
    readonly status: 'unknown' | 'compatible' | 'incompatible';
    readonly minVersion?: string;
    readonly maxVersion?: string;
    readonly currentVersion?: string;
  };
}

interface CompanionProjection {
  readonly state: 'first-install' | 'update';
  readonly previousLocksSha256: string;
  readonly contentLock?: { readonly manifestSha256: string };
  readonly sourceProvenance?: {
    readonly source: {
      readonly kind?: 'local-import';
      readonly commit: string;
      readonly descriptorSha256: string;
    };
    readonly archive: {
      readonly sha256: string;
      readonly version: string;
      readonly manifestSha256: string;
    };
  };
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
  readonly listBackupIds: (
    cwd: string,
    installed: boolean,
    signal?: AbortSignal,
  ) => Promise<readonly string[]>;
}

export interface ProjectTemplateCliInspectOptions {
  readonly cwd: string;
  readonly sourcePath: string;
  readonly signal?: AbortSignal;
  readonly currentTaktVersion?: string;
}

export interface ProjectTemplateCliInspectV1_1Options extends ProjectTemplateCliInspectOptions {
  readonly schemaVersion: typeof PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1;
}

export interface ProjectTemplateCliListOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || TYPES_IS_PROXY(value)) {
    throw new Error('invalid projection');
  }
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    Object,
    [value, key],
  ) as PropertyDescriptor | undefined;
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new Error('invalid projection');
  }
  return descriptor.value;
}

function ownOptionalValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || TYPES_IS_PROXY(value)) {
    throw new Error('invalid projection');
  }
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    Object,
    [value, key],
  ) as PropertyDescriptor | undefined;
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new Error('invalid projection');
  }
  return descriptor.value;
}

function testPattern(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_TEST, pattern, [value]) as boolean;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function requireActive(signal: AbortSignal | undefined): void {
  if (isAborted(signal)) throw new Error('project template CLI operation interrupted');
}

async function awaitActive<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  requireActive(signal);
  const value = await promise;
  requireActive(signal);
  return value;
}

function snapshotStringArray(value: unknown, maxItems: number): string[] {
  const values = denseOwnArray(value, maxItems);
  const result: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (typeof item !== 'string') {
      throw new ProjectTemplateCliInspectProjectionError('invalid projection');
    }
    REFLECT_APPLY(ARRAY_PUSH, result, [item]);
  }
  return result;
}

function denseOwnArray(value: unknown, maxItems: number): readonly unknown[] {
  if (!REFLECT_APPLY(ARRAY_IS_ARRAY, Array, [value])
    || typeof value !== 'object' || value === null || TYPES_IS_PROXY(value)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]) !== ARRAY_PROTOTYPE) {
    throw new ProjectTemplateCliInspectProjectionError('invalid projection');
  }
  const length = ownValue(value, 'length');
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [length])
    || (length as number) < 0 || (length as number) > maxItems) {
    throw new ProjectTemplateCliInspectProjectionError('invalid projection');
  }
  const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [value]) as PropertyKey[];
  if (keys.length !== (length as number) + 1) {
    throw new ProjectTemplateCliInspectProjectionError('invalid projection');
  }
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const item = ownValue(value, String(index));
    REFLECT_APPLY(ARRAY_PUSH, result, [item]);
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
  if (error instanceof ProjectTemplateCliInspectProjectionError) {
    return 'SOURCE_INTEGRITY_FAILED';
  }
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
  reviewCodes: readonly ('HARD_CONFLICT' | 'REVIEW_REQUIRED')[];
} {
  const packId = ownValue(value, 'archiveSha256');
  const manifest = ownValue(value, 'manifest');
  const entries = ownValue(manifest, 'entries');
  const compatibility = ownValue(value, 'compatibility');
  const status = ownValue(compatibility, 'status');
  if (typeof packId !== 'string' || !testPattern(SHA256_PATTERN, packId)) {
    throw new Error('invalid projection');
  }
  if (!REFLECT_APPLY(ARRAY_IS_ARRAY, Array, [entries])) throw new Error('invalid projection');
  const entryCount = ownValue(entries, 'length');
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [entryCount])
    || (entryCount as number) < 0
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
      reviewCodes: ['HARD_CONFLICT'],
    };
  }
  throw new Error('invalid projection');
}

function inspectV1_1Failure(code: ProjectTemplateCliErrorCode): ProjectTemplateCliV1_1Outcome {
  return {
    envelope: createProjectTemplateCliV1_1FailureFor({
      command: 'project-template inspect', mode: 'dry-run', code,
    }),
    exitCode: projectTemplateCliExitCodeForErrorCode(code),
  };
}

function stableInspectId(domain: string, fields: readonly string[]): string {
  const digest = createHash('sha256');
  REFLECT_APPLY(HASH_UPDATE, digest, [`${domain}\0`]);
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const bytes = REFLECT_APPLY(BUFFER_BYTE_LENGTH, Buffer, [field, 'utf8']) as number;
    REFLECT_APPLY(HASH_UPDATE, digest, [`${bytes}:${field}`]);
  }
  return REFLECT_APPLY(HASH_DIGEST, digest, ['hex']) as string;
}

interface SafeInspectEntryV1_1 {
  readonly path: string;
  readonly policy: TemplateEntryPolicy;
  readonly capabilities: readonly TemplateCapability[];
}

function requirePlainInspectRecord(value: unknown): void {
  if (typeof value !== 'object' || value === null || TYPES_IS_PROXY(value)) {
    throw new ProjectTemplateCliInspectProjectionError('invalid projection');
  }
  const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
    throw new ProjectTemplateCliInspectProjectionError('invalid projection');
  }
}

function inspectCapabilities(value: unknown): readonly TemplateCapability[] {
  const raw = denseOwnArray(value, CAPABILITY_ORDER.length);
  const seen = new SET<TemplateCapability>();
  for (let index = 0; index < raw.length; index += 1) {
    const capability = raw[index];
    if (typeof capability !== 'string'
      || !REFLECT_APPLY(SET_HAS, CAPABILITIES, [capability])
      || REFLECT_APPLY(SET_HAS, seen, [capability])) {
      throw new ProjectTemplateCliInspectProjectionError('invalid projection');
    }
    REFLECT_APPLY(SET_ADD, seen, [capability]);
  }
  const result: TemplateCapability[] = [];
  for (let index = 0; index < CAPABILITY_ORDER.length; index += 1) {
    const capability = CAPABILITY_ORDER[index]!;
    if (REFLECT_APPLY(SET_HAS, seen, [capability])) {
      REFLECT_APPLY(ARRAY_PUSH, result, [capability]);
    }
  }
  return result;
}

function inspectEntryV1_1(value: unknown): SafeInspectEntryV1_1 {
  requirePlainInspectRecord(value);
  const rawPath = ownValue(value, 'path');
  const rawPolicy = ownValue(value, 'policy');
  const rawCapabilities = ownOptionalValue(value, 'capabilities') ?? [];
  let path: string;
  try {
    path = parsePortablePath(rawPath, 'inspect.entry.path');
  } catch {
    throw new ProjectTemplateCliInspectProjectionError('invalid projection');
  }
  if (testPattern(TOKEN_PATTERN, path)
    || typeof rawPolicy !== 'string'
    || !REFLECT_APPLY(SET_HAS, POLICIES, [rawPolicy])) {
    throw new ProjectTemplateCliInspectProjectionError('invalid projection');
  }
  return {
    path,
    policy: rawPolicy as TemplateEntryPolicy,
    capabilities: inspectCapabilities(rawCapabilities),
  };
}

function snapshotInspectionV1_1(value: unknown, archiveBytes: number): ProjectTemplateCliV1_1Outcome {
  requirePlainInspectRecord(value);
  const archiveId = ownValue(value, 'archiveSha256');
  const manifestId = ownValue(value, 'manifestSha256');
  const manifest = ownValue(value, 'manifest');
  requirePlainInspectRecord(manifest);
  const entries = ownValue(manifest, 'entries');
  const packVersion = ownValue(manifest, 'packVersion');
  const takt = ownValue(manifest, 'takt');
  requirePlainInspectRecord(takt);
  const minTaktVersion = ownValue(takt, 'minVersion');
  const maxTaktVersion = ownOptionalValue(takt, 'maxVersion');
  const manifestSource = ownValue(manifest, 'source');
  requirePlainInspectRecord(manifestSource);
  const sourceKind = ownValue(manifestSource, 'kind');
  const sourceCommit = ownValue(manifestSource, 'commit');
  const sourceUri = ownValue(manifestSource, 'uri');
  const sourceRef = ownValue(manifestSource, 'ref');
  const compatibility = ownValue(value, 'compatibility');
  requirePlainInspectRecord(compatibility);
  const compatibilityStatus = ownValue(compatibility, 'status');
  const currentTaktVersion = ownOptionalValue(compatibility, 'currentVersion');
  if (typeof archiveId !== 'string' || !testPattern(SHA256_PATTERN, archiveId)
    || typeof manifestId !== 'string' || !testPattern(SHA256_PATTERN, manifestId)
    || typeof packVersion !== 'string' || typeof minTaktVersion !== 'string'
    || (maxTaktVersion !== undefined && typeof maxTaktVersion !== 'string')
    || typeof sourceCommit !== 'string' || typeof sourceUri !== 'string'
    || typeof sourceRef !== 'string'
    || (compatibilityStatus !== 'unknown' && compatibilityStatus !== 'compatible'
      && compatibilityStatus !== 'incompatible')
    || (currentTaktVersion !== undefined && typeof currentTaktVersion !== 'string')) {
    throw new ProjectTemplateCliInspectProjectionError('invalid projection');
  }
  const rawEntries = denseOwnArray(entries, MAX_TEMPLATE_ENTRIES);
  const safeEntries: SafeInspectEntryV1_1[] = [];
  const detected = new SET<TemplateCapability>();
  let capabilityWarningTotal = 0;
  // Why: aggregate security facts must cover the complete archive even though
  // the public row budget is smaller. Truncating before this pass could hide an
  // executable or external-command capability from TaktDesk.
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = inspectEntryV1_1(rawEntries[index]);
    REFLECT_APPLY(ARRAY_PUSH, safeEntries, [entry]);
    capabilityWarningTotal += entry.capabilities.length;
    for (let capabilityIndex = 0;
      capabilityIndex < entry.capabilities.length;
      capabilityIndex += 1) {
      REFLECT_APPLY(SET_ADD, detected, [entry.capabilities[capabilityIndex]]);
    }
  }
  const detailTargets: Array<{
    readonly targetId: string;
    readonly manifestId: string;
    readonly path: string;
    readonly policy: TemplateEntryPolicy;
    readonly capabilities: readonly TemplateCapability[];
  }> = [];
  const capabilityWarnings: Array<{
    readonly warningId: string;
    readonly targetId: string;
    readonly manifestId: string;
    readonly path: string;
    readonly capability: TemplateCapability;
  }> = [];
  const emittedCount = safeEntries.length < INSPECT_DETAIL_LIMIT
    ? safeEntries.length
    : INSPECT_DETAIL_LIMIT;
  for (let index = 0; index < emittedCount; index += 1) {
    const entry = safeEntries[index]!;
    const targetId = stableInspectId(
      'takt.project-template.cli.inspect.target.v1',
      [manifestId, entry.path],
    );
    REFLECT_APPLY(ARRAY_PUSH, detailTargets, [{
      targetId, manifestId, path: entry.path, policy: entry.policy,
      capabilities: entry.capabilities,
    }]);
    for (let capabilityIndex = 0;
      capabilityIndex < entry.capabilities.length
        && capabilityWarnings.length < INSPECT_DETAIL_LIMIT;
      capabilityIndex += 1) {
      const capability = entry.capabilities[capabilityIndex]!;
      REFLECT_APPLY(ARRAY_PUSH, capabilityWarnings, [{
        warningId: stableInspectId(
          'takt.project-template.cli.inspect.capability-warning.v1',
          [targetId, capability],
        ),
        targetId, manifestId, path: entry.path, capability,
      }]);
    }
  }
  const rawDeclared = ownOptionalValue(manifest, 'capabilities') ?? [];
  const declaredCapabilities = inspectCapabilities(rawDeclared);
  const detectedCapabilities: TemplateCapability[] = [];
  for (let index = 0; index < CAPABILITY_ORDER.length; index += 1) {
    const capability = CAPABILITY_ORDER[index]!;
    if (REFLECT_APPLY(SET_HAS, detected, [capability])) {
      REFLECT_APPLY(ARRAY_PUSH, detectedCapabilities, [capability]);
    }
  }
  // Generic git is remote provenance and must not be relabeled as a local
  // import. Add a distinct closed remote variant before accepting providers
  // other than the GitHub and local variants supported by schema 1.1.
  if (sourceKind !== 'github' && sourceKind !== 'local') {
    throw new ProjectTemplateCliInspectProjectionError('invalid projection');
  }
  const sourceId = stableInspectId('takt.project-template.cli.inspect.source.v1', [
    sourceKind, sourceUri, sourceRef, sourceCommit,
  ]);
  let safeSource: Record<string, unknown>;
  if (sourceKind === 'github') {
    const matched = REFLECT_APPLY(
      REGEXP_EXEC,
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/u,
      [sourceUri],
    ) as RegExpExecArray | null;
    if (matched === null) throw new ProjectTemplateCliInspectProjectionError('invalid projection');
    safeSource = {
      kind: 'github', sourceId, owner: matched[1], repo: matched[2], requestedRef: sourceRef,
      resolvedCommit: sourceCommit, releaseTag: null, assetName: null, archiveId, manifestId,
    };
  } else {
    safeSource = {
      kind: 'local-import', sourceId, revision: sourceCommit, archiveId, manifestId,
    };
  }
  const review = compatibilityStatus === 'compatible'
    ? { readiness: 'ready' as const, reviewCodes: [] as const }
    : compatibilityStatus === 'unknown'
      ? { readiness: 'review-required' as const, reviewCodes: ['REVIEW_REQUIRED'] as const }
      : { readiness: 'blocked' as const, reviewCodes: ['HARD_CONFLICT'] as const };
  const targetsTruncated = safeEntries.length > detailTargets.length;
  const warningsTruncated = capabilityWarningTotal > capabilityWarnings.length;
  const truncated = targetsTruncated || warningsTruncated;
  const envelope = createProjectTemplateCliV1_1Success({
    schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1,
    command: 'project-template inspect', status: 'success', mode: 'dry-run',
    result: {
      packId: archiveId, entryCount: rawEntries.length, archiveBytes, dependencyCount: 0,
      ...review,
      detail: {
        identity: { packFormatVersion: '1.0', packVersion, archiveId, manifestId },
        compatibility: {
          status: compatibilityStatus, minTaktVersion,
          maxTaktVersion: maxTaktVersion ?? null,
          currentTaktVersion: currentTaktVersion ?? null,
        },
        source: safeSource,
        declaredCapabilities,
        detectedCapabilities,
        targets: {
          items: detailTargets, totalCount: safeEntries.length, truncated: targetsTruncated,
        },
        capabilityWarnings: {
          items: capabilityWarnings,
          totalCount: capabilityWarningTotal,
          truncated: warningsTruncated,
        },
      },
    },
    warnings: truncated ? [{ code: 'PARTIAL_RESULT' }] : [],
  });
  return { envelope, exitCode: 0 };
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
    const cwdBefore = await awaitActive(dependencies.lstat(cwd), options.signal);
    const cwdRealpath = await awaitActive(dependencies.realpath(cwd), options.signal);
    const sourceBefore = await awaitActive(dependencies.lstat(sourcePath), options.signal);
    const sourceRealpath = await awaitActive(
      dependencies.realpath(sourcePath),
      options.signal,
    );
    if (cwdRealpath !== cwd || !cwdBefore.isDirectory() || cwdBefore.isSymbolicLink()
      || sourceRealpath !== sourcePath
      || !sourceBefore.isFile() || sourceBefore.isSymbolicLink() || sourceBefore.nlink !== 1
      || sourceBefore.size > DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes) {
      return outcomeFailure('project-template inspect', 'SOURCE_INTEGRITY_FAILED');
    }
    const inspection = await awaitActive(
      dependencies.inspectTaktpack(sourcePath, {
        signal: options.signal,
        currentTaktVersion: options.currentTaktVersion,
        limits: DEFAULT_TAKTPACK_LIMITS,
      }),
      options.signal,
    );
    const cwdAfter = await awaitActive(dependencies.lstat(cwd), options.signal);
    const cwdRealpathAfter = await awaitActive(dependencies.realpath(cwd), options.signal);
    const sourceAfter = await awaitActive(dependencies.lstat(sourcePath), options.signal);
    const sourceRealpathAfter = await awaitActive(
      dependencies.realpath(sourcePath),
      options.signal,
    );
    if (cwdRealpathAfter !== cwd || !isStableDirectory(cwdBefore, cwdAfter)
      || sourceRealpathAfter !== sourcePath
      || !isStableFile(sourceBefore, sourceAfter)) {
      return outcomeFailure('project-template inspect', 'SOURCE_INTEGRITY_FAILED');
    }
    const projected = snapshotInspection(inspection);
    requireActive(options.signal);
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

export function inspectProjectTemplateForCliV1_1(
  options: ProjectTemplateCliInspectV1_1Options,
): Promise<ProjectTemplateCliV1_1Outcome> {
  return inspectProjectTemplateForCliV1_1WithDependencies(options, {});
}

export async function inspectProjectTemplateForCliV1_1WithDependencies(
  options: ProjectTemplateCliInspectV1_1Options,
  dependencyOverrides: Partial<ProjectTemplateCliInspectListDependencies>,
): Promise<ProjectTemplateCliV1_1Outcome> {
  const dependencies = dependenciesWith(dependencyOverrides);
  if (isAborted(options.signal)) return inspectV1_1Failure('INTERRUPTED');
  const cwd = resolve(options.cwd);
  const sourcePath = resolve(cwd, options.sourcePath);
  try {
    const cwdBefore = await awaitActive(dependencies.lstat(cwd), options.signal);
    const cwdRealpath = await awaitActive(dependencies.realpath(cwd), options.signal);
    const sourceBefore = await awaitActive(dependencies.lstat(sourcePath), options.signal);
    const sourceRealpath = await awaitActive(dependencies.realpath(sourcePath), options.signal);
    if (cwdRealpath !== cwd || !cwdBefore.isDirectory() || cwdBefore.isSymbolicLink()
      || sourceRealpath !== sourcePath || !sourceBefore.isFile()
      || sourceBefore.isSymbolicLink() || sourceBefore.nlink !== 1
      || sourceBefore.size > DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes) {
      return inspectV1_1Failure('SOURCE_INTEGRITY_FAILED');
    }
    const inspection = await awaitActive(dependencies.inspectTaktpack(sourcePath, {
      signal: options.signal,
      currentTaktVersion: options.currentTaktVersion,
      limits: DEFAULT_TAKTPACK_LIMITS,
    }), options.signal);
    const cwdAfter = await awaitActive(dependencies.lstat(cwd), options.signal);
    const cwdRealpathAfter = await awaitActive(dependencies.realpath(cwd), options.signal);
    const sourceAfter = await awaitActive(dependencies.lstat(sourcePath), options.signal);
    const sourceRealpathAfter = await awaitActive(dependencies.realpath(sourcePath), options.signal);
    if (cwdRealpathAfter !== cwd || !isStableDirectory(cwdBefore, cwdAfter)
      || sourceRealpathAfter !== sourcePath || !isStableFile(sourceBefore, sourceAfter)) {
      return inspectV1_1Failure('SOURCE_INTEGRITY_FAILED');
    }
    requireActive(options.signal);
    try {
      return snapshotInspectionV1_1(inspection, sourceAfter.size);
    } catch {
      // Core inspection succeeded, so a rejected projection is untrusted
      // archive evidence rather than an internal runtime failure.
      return inspectV1_1Failure('SOURCE_INTEGRITY_FAILED');
    }
  } catch (error) {
    return inspectV1_1Failure(inspectErrorCode(error, options.signal));
  }
}

function recoveryRequired(report: unknown): boolean {
  const blocks = ownValue(report, 'blocks');
  if (!REFLECT_APPLY(ARRAY_IS_ARRAY, Array, [blocks])) {
    throw new Error('invalid guard projection');
  }
  const length = ownValue(blocks, 'length');
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [length])
    || (length as number) < 0 || (length as number) > 8_192) {
    throw new Error('invalid guard projection');
  }
  for (let index = 0; index < (length as number); index += 1) {
    const code = ownValue(ownValue(blocks, String(index)), 'code');
    if (code === 'RECOVERY_REQUIRED' || code === 'RECOVERY_REQUIRED_UNKNOWN') return true;
    if (typeof code !== 'string') throw new Error('invalid guard projection');
  }
  return false;
}

type CompanionSnapshot =
  | { readonly installed: false; readonly cohortId: string }
  | {
    readonly installed: true;
    readonly cohortId: string;
    readonly targetId: string;
    readonly sourceProvenance: {
      readonly kind: 'local-import' | 'github';
      readonly sourceId: string;
      readonly revision: string;
      readonly version: string;
      readonly archiveId: string;
      readonly manifestId: string;
    };
    readonly sourceDetail: Readonly<Record<string, unknown>>;
  };

function snapshotSourceProvenance(
  value: unknown,
): Extract<CompanionSnapshot, { readonly installed: true }>['sourceProvenance'] {
  // Why: TaktDesk needs immutable provenance to identify an installation, but
  // raw lock data contains local paths and repository URLs. Project only
  // validated hashes, the resolved revision, and version across the CLI trust
  // boundary so list remains useful without becoming a metadata disclosure.
  const source = ownValue(value, 'source');
  const archive = ownValue(value, 'archive');
  const sourceKind = ownOptionalValue(source, 'kind');
  let kind: 'local-import' | 'github';
  if (sourceKind === undefined) kind = 'github';
  else if (sourceKind === 'local-import') kind = 'local-import';
  else throw new Error('invalid projection');
  const sourceId = ownValue(source, 'descriptorSha256');
  const revision = ownValue(source, 'commit');
  const version = ownValue(archive, 'version');
  const archiveId = ownValue(archive, 'sha256');
  const manifestId = ownValue(archive, 'manifestSha256');
  if (typeof sourceId !== 'string'
    || typeof revision !== 'string'
    || typeof version !== 'string'
    || typeof archiveId !== 'string'
    || typeof manifestId !== 'string') throw new Error('invalid projection');
  return { kind, sourceId, revision, version, archiveId, manifestId };
}

function snapshotSourceDetail(value: unknown): Readonly<Record<string, unknown>> {
  const source = ownValue(value, 'source');
  const archive = ownValue(value, 'archive');
  const sourceKind = ownOptionalValue(source, 'kind');
  const sourceId = ownValue(source, 'descriptorSha256');
  const revision = ownValue(source, 'commit');
  const archiveId = ownValue(archive, 'sha256');
  const manifestId = ownValue(archive, 'manifestSha256');
  if (typeof sourceId !== 'string' || typeof revision !== 'string'
    || typeof archiveId !== 'string' || typeof manifestId !== 'string') {
    throw new Error('invalid projection');
  }
  if (sourceKind === 'local-import') {
    return Object.freeze({
      kind: 'local-import', sourceId, revision, archiveId, manifestId,
    });
  }
  if (sourceKind !== undefined) throw new Error('invalid projection');
  const owner = ownValue(source, 'owner');
  const repo = ownValue(source, 'repo');
  const requestedRef = ownValue(source, 'requestedRef');
  const releaseTag = ownValue(source, 'releaseTag');
  const assetName = ownOptionalValue(source, 'assetName');
  if (typeof owner !== 'string' || typeof repo !== 'string'
    || typeof requestedRef !== 'string' || typeof releaseTag !== 'string'
    || (assetName !== undefined && typeof assetName !== 'string')) {
    throw new Error('invalid projection');
  }
  return Object.freeze({
    kind: 'github', sourceId, owner, repo, requestedRef,
    resolvedCommit: revision, releaseTag, assetName: assetName ?? null,
    archiveId, manifestId,
  });
}

function snapshotCompanion(value: unknown): CompanionSnapshot {
  const state = ownValue(value, 'state');
  const cohortId = ownValue(value, 'previousLocksSha256');
  if (typeof cohortId !== 'string' || !testPattern(SHA256_PATTERN, cohortId)) {
    throw new Error('invalid companion projection');
  }
  if (state === 'first-install') return { installed: false, cohortId };
  if (state !== 'update') throw new Error('invalid companion projection');
  const targetId = ownValue(ownValue(value, 'contentLock'), 'manifestSha256');
  if (typeof targetId !== 'string' || !testPattern(SHA256_PATTERN, targetId)) {
    throw new Error('invalid companion projection');
  }
  return {
    installed: true,
    cohortId,
    targetId,
    sourceProvenance: snapshotSourceProvenance(ownValue(value, 'sourceProvenance')),
    sourceDetail: snapshotSourceDetail(ownValue(value, 'sourceProvenance')),
  };
}

function sameCompanionSnapshot(left: CompanionSnapshot, right: CompanionSnapshot): boolean {
  // Why: a stable content lock alone is insufficient when another process can
  // replace only the provenance cohort. Bind every public provenance field to
  // the second read so the UI never presents mixed source and target state.
  return left.installed === right.installed
    && left.cohortId === right.cohortId
    && (!left.installed || (right.installed
      && left.targetId === right.targetId
      && left.sourceProvenance.kind === right.sourceProvenance.kind
      && left.sourceProvenance.sourceId === right.sourceProvenance.sourceId
      && left.sourceProvenance.revision === right.sourceProvenance.revision
      && left.sourceProvenance.version === right.sourceProvenance.version
      && left.sourceProvenance.archiveId === right.sourceProvenance.archiveId
      && left.sourceProvenance.manifestId === right.sourceProvenance.manifestId
      && sameSourceDetail(left.sourceDetail, right.sourceDetail)));
}

function sameSourceDetail(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  return left['kind'] === right['kind']
    && left['sourceId'] === right['sourceId']
    && left['revision'] === right['revision']
    && left['owner'] === right['owner']
    && left['repo'] === right['repo']
    && left['requestedRef'] === right['requestedRef']
    && left['resolvedCommit'] === right['resolvedCommit']
    && left['releaseTag'] === right['releaseTag']
    && left['assetName'] === right['assetName']
    && left['archiveId'] === right['archiveId']
    && left['manifestId'] === right['manifestId'];
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
    requireActive(options.signal);
    if (recoveryRequired(dependencies.inspectApplyGuard({ repoPath: cwd }))) {
      return outcomeFailure('project-template list', 'RECOVERY_REQUIRED');
    }
    requireActive(options.signal);
    const companion = snapshotCompanion(dependencies.readCompanionLockState(cwd));
    requireActive(options.signal);
    const backupIds = snapshotStringArray(
      await awaitActive(
        dependencies.listBackupIds(cwd, companion.installed, options.signal),
        options.signal,
      ),
      MAX_BACKUP_IDS,
    );
    for (const backupId of backupIds) {
      if (!testPattern(BACKUP_ID_PATTERN, backupId)) throw new Error('invalid backup id');
    }
    REFLECT_APPLY(ARRAY_SORT, backupIds, []);
    let companionAfter: CompanionSnapshot | undefined;
    let companionAfterError: unknown;
    try {
      companionAfter = snapshotCompanion(dependencies.readCompanionLockState(cwd));
    } catch (error) {
      companionAfterError = error;
    }
    requireActive(options.signal);
    if (recoveryRequired(dependencies.inspectApplyGuard({ repoPath: cwd }))) {
      return outcomeFailure('project-template list', 'RECOVERY_REQUIRED');
    }
    requireActive(options.signal);
    if (companionAfterError !== undefined) {
      if (companionAfterError instanceof ProjectTemplateCompanionLockStateError
        && companionAfterError.code === 'MIXED_STATE') {
        return outcomeFailure('project-template list', 'TARGET_DRIFT');
      }
      throw companionAfterError;
    }
    if (companionAfter === undefined || !sameCompanionSnapshot(companion, companionAfter)) {
      return outcomeFailure('project-template list', 'TARGET_DRIFT');
    }
    requireActive(options.signal);
    return outcomeSuccess(
      'project-template list',
      companion.installed
        ? {
          installed: true,
          targetId: companion.targetId,
          sourceProvenance: companion.sourceProvenance,
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

function listV1_1Failure(code: ProjectTemplateCliErrorCode): ProjectTemplateCliV1_1Outcome {
  return {
    envelope: createProjectTemplateCliV1_1FailureFor({
      command: 'project-template list', mode: 'dry-run', code,
    }),
    exitCode: projectTemplateCliExitCodeForErrorCode(code),
  };
}

export function listProjectTemplatesForCliV1_1(
  options: ProjectTemplateCliListOptions,
): Promise<ProjectTemplateCliV1_1Outcome> {
  return listProjectTemplatesForCliV1_1WithDependencies(options, {});
}

export async function listProjectTemplatesForCliV1_1WithDependencies(
  options: ProjectTemplateCliListOptions,
  dependencyOverrides: Partial<ProjectTemplateCliInspectListDependencies>,
): Promise<ProjectTemplateCliV1_1Outcome> {
  const dependencies = dependenciesWith(dependencyOverrides);
  if (isAborted(options.signal)) return listV1_1Failure('INTERRUPTED');
  const cwd = resolve(options.cwd);
  try {
    requireActive(options.signal);
    if (recoveryRequired(dependencies.inspectApplyGuard({ repoPath: cwd }))) {
      return listV1_1Failure('RECOVERY_REQUIRED');
    }
    const companion = snapshotCompanion(dependencies.readCompanionLockState(cwd));
    const backupIds = snapshotStringArray(
      await awaitActive(
        dependencies.listBackupIds(cwd, companion.installed, options.signal),
        options.signal,
      ),
      MAX_BACKUP_IDS,
    );
    for (const backupId of backupIds) {
      if (!testPattern(BACKUP_ID_PATTERN, backupId)) throw new Error('invalid backup id');
    }
    REFLECT_APPLY(ARRAY_SORT, backupIds, []);
    let companionAfter: CompanionSnapshot | undefined;
    let companionAfterError: unknown;
    try {
      companionAfter = snapshotCompanion(dependencies.readCompanionLockState(cwd));
    } catch (error) {
      companionAfterError = error;
    }
    requireActive(options.signal);
    if (recoveryRequired(dependencies.inspectApplyGuard({ repoPath: cwd }))) {
      return listV1_1Failure('RECOVERY_REQUIRED');
    }
    // Once backup enumeration has started, a newly mixed lock cohort is
    // target drift rather than corruption of the source we initially read.
    // This preserves the schema 1.0 concurrency classification and exit code.
    if (companionAfterError !== undefined) {
      if (companionAfterError instanceof ProjectTemplateCompanionLockStateError
        && companionAfterError.code === 'MIXED_STATE') {
        return listV1_1Failure('TARGET_DRIFT');
      }
      throw companionAfterError;
    }
    if (companionAfter === undefined || !sameCompanionSnapshot(companion, companionAfter)) {
      return listV1_1Failure('TARGET_DRIFT');
    }
    const envelope = createProjectTemplateCliV1_1Success({
      schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1,
      command: 'project-template list', status: 'success', mode: 'dry-run',
      result: companion.installed
        ? {
          installed: true,
          targetId: companion.targetId,
          sourceProvenance: companion.sourceProvenance,
          backupIds,
          recoveryState: 'clean',
          detail: { source: companion.sourceDetail },
        }
        : {
          installed: false,
          backupIds,
          recoveryState: 'clean',
          detail: { source: null },
        },
      warnings: [],
    });
    return { envelope, exitCode: 0 };
  } catch (error) {
    if (isAborted(options.signal)) return listV1_1Failure('INTERRUPTED');
    if (error instanceof ProjectTemplateCompanionLockStateError) {
      return listV1_1Failure(
        error.code === 'UNREADABLE_LOCK' ? 'SOURCE_UNAVAILABLE' : 'SOURCE_INTEGRITY_FAILED',
      );
    }
    return listV1_1Failure('SECURITY_GUARD');
  }
}

async function listProjectTemplateBackupIdsReadOnly(
  cwd: string,
  installed: boolean,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  // Keep the read-only probe on the same canonical control namespace as the
  // transaction storage. A second literal silently hides installed backups.
  const controlRoot = join(resolve(cwd), PROJECT_TEMPLATE_CONTROL_DIRECTORY);
  try {
    await awaitActive(lstat(controlRoot), signal);
  } catch (error) {
    requireActive(signal);
    const code = typeof error === 'object' && error !== null
      ? OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(error, 'code')?.value
      : undefined;
    if (code === 'ENOENT' && !installed) return [];
    throw error;
  }
  const storage = await awaitActive(
    openProjectTemplateApplyStorageReadOnly({ repoPath: cwd }),
    signal,
  );
  const backupsBefore = await awaitActive(storage.io.lstat(storage.backupsRoot), signal);
  const resolvedBefore = await awaitActive(storage.io.realpath(storage.backupsRoot), signal);
  if (resolvedBefore !== storage.backupsRoot || !backupsBefore.isDirectory()
    || backupsBefore.isSymbolicLink() || backupsBefore.dev !== storage.device) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'backup directory cannot be proven safe',
    );
  }
  // Why: asking the storage boundary for at most 32 entries makes the 33rd
  // generation a hard failure before it can become an unbounded CLI result.
  const entries = await awaitActive(
    storage.io.readdir(storage.backupsRoot, MAX_BACKUP_IDS),
    signal,
  );
  const backupIds: string[] = [];
  for (const entry of entries) {
    const backupId = snapshotBackupDirent(entry);
    const generationPath = join(storage.backupsRoot, backupId);
    const generationBefore = await awaitActive(storage.io.lstat(generationPath), signal);
    const generationRealpath = await awaitActive(storage.io.realpath(generationPath), signal);
    if (generationRealpath !== generationPath || !generationBefore.isDirectory()
      || generationBefore.isSymbolicLink() || generationBefore.dev !== storage.device) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_CONTROL_ROOT',
        'backup generation cannot be proven safe',
      );
    }
    const manifest = await awaitActive(
      readProjectTemplateBackupManifest({ storage, backupId }),
      signal,
    );
    const generationAfter = await awaitActive(storage.io.lstat(generationPath), signal);
    if (!isStableDirectory(generationBefore, generationAfter)) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_CONTROL_ROOT',
        'backup generation changed during inspection',
      );
    }
    const companionKinds = manifest.entries
      .filter(({ target }) => target.kind === 'content-lock'
        || target.kind === 'repertoire-lock'
        || target.kind === 'source-provenance')
      .map(({ target }) => target.kind)
      .sort();
    // Why: schema 1.0 rollback remains available only through the legacy core
    // API. The CLI cannot safely provide path-based mutation admission for
    // that format, so discovery exposes only exact atomic 1.1 cohorts.
    if (manifest.schemaVersion === '1.1'
      && companionKinds.join(',')
        === 'content-lock,repertoire-lock,source-provenance') {
      backupIds.push(backupId);
    }
  }
  const backupsAfter = await awaitActive(storage.io.lstat(storage.backupsRoot), signal);
  const resolvedAfter = await awaitActive(storage.io.realpath(storage.backupsRoot), signal);
  if (resolvedAfter !== storage.backupsRoot || !isStableDirectory(backupsBefore, backupsAfter)) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'backup directory changed during inspection',
    );
  }
  requireActive(signal);
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
