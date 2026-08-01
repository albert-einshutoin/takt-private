import {
  parseProjectTemplateCliJson,
  serializeProjectTemplateCliJson,
  snapshotProjectTemplateCliJson,
} from './cli-bounded-json.js';
import { ProjectTemplateCliContractError } from './cli-contract-error.js';
import { DEFAULT_TAKTPACK_LIMITS } from './archive-types.js';
import { MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES } from './source-descriptor.js';
import { MAX_TEMPLATE_ENTRIES } from './validation.js';

export { ProjectTemplateCliContractError } from './cli-contract-error.js';

export const PROJECT_TEMPLATE_CLI_SCHEMA_VERSION = '1.0' as const;

export type ProjectTemplateCliMode = 'dry-run' | 'apply';
export type ProjectTemplateCliCommand =
  | 'project-template export'
  | 'project-template inspect'
  | 'project-template diff'
  | 'project-template apply'
  | 'project-template update'
  | 'project-template rollback'
  | 'project-template list';
export type ProjectTemplateCliExitCode = 0 | 20 | 21 | 22 | 23 | 24 | 25 | 70 | 130;
export type ProjectTemplateCliJson =
  | null
  | boolean
  | number
  | string
  | readonly ProjectTemplateCliJson[]
  | { readonly [key: string]: ProjectTemplateCliJson };

export type ProjectTemplateCliWarningCode =
  | 'DEPRECATED_SOURCE'
  | 'PARTIAL_RESULT'
  | 'RECOVERY_AVAILABLE'
  | 'REVIEW_REQUIRED'
  | 'UPDATE_AVAILABLE';
export interface ProjectTemplateCliWarning {
  readonly code: ProjectTemplateCliWarningCode;
}

export type ProjectTemplateCliErrorCode =
  | 'EXPECTED_PLAN_ID_REQUIRES_APPLY'
  | 'INVALID_APPLY_INPUT'
  | 'INVALID_ARGUMENT'
  | 'INVALID_EXPECTED_PLAN_ID'
  | 'MISSING_EXPECTED_PLAN_ID'
  | 'MUTUALLY_EXCLUSIVE_OPTIONS'
  | 'UNKNOWN_OPTION'
  | 'CONFLICT'
  | 'APPROVAL_REQUIRED'
  | 'DEPENDENCY_CONFLICT'
  | 'HARD_CONFLICT'
  | 'REVIEW_REQUIRED'
  | 'PLAN_DRIFT'
  | 'BASE_LOCK_DRIFT'
  | 'ROLLBACK_DRIFT'
  | 'SOURCE_DRIFT'
  | 'TARGET_DRIFT'
  | 'TRANSACTION_PLAN_MISMATCH'
  | 'ACTIVE_RUN'
  | 'APPLY_GUARD_BLOCKED'
  | 'APPLY_LEASE_UNAVAILABLE'
  | 'LEASE_UNAVAILABLE'
  | 'SECURITY_GUARD'
  | 'AUTH_FAILED'
  | 'NETWORK_FAILED'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_INTEGRITY_FAILED'
  | 'BACKUP_UNAVAILABLE'
  | 'APPLY_FAILED_ROLLED_BACK'
  | 'NO_RECOVERY_STATE'
  | 'PARTIAL_FAILURE'
  | 'RECOVERY_REQUIRED'
  | 'RESULT_INDETERMINATE'
  | 'INTERNAL'
  | 'PROTOCOL_ERROR'
  | 'INTERRUPTED';

export type ProjectTemplateCliReadiness =
  | 'ready'
  | 'review-required'
  | 'blocked'
  | 'recovery-required';
export type ProjectTemplateCliRecoveryState = 'clean' | 'recovery-required';
export type ProjectTemplateCliReviewCode =
  | 'ACTIVE_RUN'
  | 'DEPENDENCY_CONFLICT'
  | 'HARD_CONFLICT'
  | 'RECOVERY_REQUIRED'
  | 'REVIEW_REQUIRED'
  | 'SOURCE_DRIFT'
  | 'TARGET_DRIFT';

interface ProjectTemplateCliReviewSummary {
  readonly readiness: ProjectTemplateCliReadiness;
  readonly reviewCodes: readonly ProjectTemplateCliReviewCode[];
}

export interface ProjectTemplateCliExportDryRunResult extends ProjectTemplateCliReviewSummary {
  readonly planId: string;
  readonly entryCount: number;
  readonly archiveBytes: number;
  readonly dependencyCount: number;
}
export interface ProjectTemplateCliExportApplyResult extends ProjectTemplateCliExportDryRunResult {
  readonly packId: string;
}
export interface ProjectTemplateCliInspectResult extends ProjectTemplateCliReviewSummary {
  readonly packId: string;
  readonly entryCount: number;
  readonly archiveBytes: number;
  readonly dependencyCount: number;
}
export interface ProjectTemplateCliDiffResult extends ProjectTemplateCliReviewSummary {
  readonly planId: string;
  readonly changeCount: number;
  readonly conflictCount: number;
  readonly dependencyCount: number;
}
export interface ProjectTemplateCliApplyResult {
  readonly planId: string;
  readonly applied: true;
  readonly backupId: string;
  readonly recoveryState: 'clean';
}
export interface ProjectTemplateCliUpdateDryRunResult extends ProjectTemplateCliReviewSummary {
  readonly planId: string;
  readonly updateAvailable: boolean;
  readonly dependencyCount: number;
}
export interface ProjectTemplateCliUpdateApplyResult {
  readonly planId: string;
  readonly updated: true;
  readonly backupId: string;
  readonly recoveryState: 'clean';
}
export interface ProjectTemplateCliRollbackDryRunResult extends ProjectTemplateCliReviewSummary {
  readonly planId: string;
  readonly recoveryState: ProjectTemplateCliRecoveryState;
}
export interface ProjectTemplateCliRollbackApplyResult {
  readonly planId: string;
  readonly rolledBack: true;
  readonly backupId: string;
  readonly recoveryState: 'clean';
}
export type ProjectTemplateCliListResult =
  | {
    readonly installed: false;
    readonly backupIds: readonly string[];
    readonly recoveryState: ProjectTemplateCliRecoveryState;
  }
  | {
    readonly installed: true;
    readonly targetId: string;
    readonly backupIds: readonly string[];
    readonly recoveryState: ProjectTemplateCliRecoveryState;
  };

export type ProjectTemplateCliResult =
  | ProjectTemplateCliExportDryRunResult
  | ProjectTemplateCliExportApplyResult
  | ProjectTemplateCliInspectResult
  | ProjectTemplateCliDiffResult
  | ProjectTemplateCliApplyResult
  | ProjectTemplateCliUpdateDryRunResult
  | ProjectTemplateCliUpdateApplyResult
  | ProjectTemplateCliRollbackDryRunResult
  | ProjectTemplateCliRollbackApplyResult
  | ProjectTemplateCliListResult;

interface ProjectTemplateCliEnvelopeBase {
  readonly schemaVersion: typeof PROJECT_TEMPLATE_CLI_SCHEMA_VERSION;
  readonly command: ProjectTemplateCliCommand;
  readonly mode: ProjectTemplateCliMode;
  readonly warnings: readonly ProjectTemplateCliWarning[];
}

interface ProjectTemplateCliSuccessVariant<
  C extends ProjectTemplateCliCommand,
  M extends ProjectTemplateCliMode,
  R extends ProjectTemplateCliResult,
> extends ProjectTemplateCliEnvelopeBase {
  readonly status: 'success';
  readonly command: C;
  readonly mode: M;
  readonly result: R;
}

export type ProjectTemplateCliSuccessEnvelope =
  | ProjectTemplateCliSuccessVariant<'project-template export', 'dry-run', ProjectTemplateCliExportDryRunResult>
  | ProjectTemplateCliSuccessVariant<'project-template export', 'apply', ProjectTemplateCliExportApplyResult>
  | ProjectTemplateCliSuccessVariant<'project-template inspect', 'dry-run', ProjectTemplateCliInspectResult>
  | ProjectTemplateCliSuccessVariant<'project-template diff', 'dry-run', ProjectTemplateCliDiffResult>
  | ProjectTemplateCliSuccessVariant<'project-template apply', 'dry-run', ProjectTemplateCliDiffResult>
  | ProjectTemplateCliSuccessVariant<'project-template apply', 'apply', ProjectTemplateCliApplyResult>
  | ProjectTemplateCliSuccessVariant<'project-template update', 'dry-run', ProjectTemplateCliUpdateDryRunResult>
  | ProjectTemplateCliSuccessVariant<'project-template update', 'apply', ProjectTemplateCliUpdateApplyResult>
  | ProjectTemplateCliSuccessVariant<'project-template rollback', 'dry-run', ProjectTemplateCliRollbackDryRunResult>
  | ProjectTemplateCliSuccessVariant<'project-template rollback', 'apply', ProjectTemplateCliRollbackApplyResult>
  | ProjectTemplateCliSuccessVariant<'project-template list', 'dry-run', ProjectTemplateCliListResult>;

interface ProjectTemplateCliFailureVariant<
  C extends ProjectTemplateCliCommand,
  M extends ProjectTemplateCliMode,
> extends ProjectTemplateCliEnvelopeBase {
  readonly status: 'error';
  readonly command: C;
  readonly mode: M;
  readonly error: { readonly code: ProjectTemplateCliErrorCode };
}

export type ProjectTemplateCliFailureEnvelope =
  | ProjectTemplateCliFailureVariant<'project-template export', ProjectTemplateCliMode>
  | ProjectTemplateCliFailureVariant<'project-template inspect', 'dry-run'>
  | ProjectTemplateCliFailureVariant<'project-template diff', 'dry-run'>
  | ProjectTemplateCliFailureVariant<'project-template apply', ProjectTemplateCliMode>
  | ProjectTemplateCliFailureVariant<'project-template update', ProjectTemplateCliMode>
  | ProjectTemplateCliFailureVariant<'project-template rollback', ProjectTemplateCliMode>
  | ProjectTemplateCliFailureVariant<'project-template list', 'dry-run'>;

export type ProjectTemplateCliEnvelope =
  | ProjectTemplateCliSuccessEnvelope
  | ProjectTemplateCliFailureEnvelope;

export interface ProjectTemplateCliOutcome {
  readonly envelope: ProjectTemplateCliEnvelope;
  readonly exitCode: ProjectTemplateCliExitCode;
}

export interface ProjectTemplateCliDryRunOptions {
  readonly mode: 'dry-run';
  readonly force: boolean;
}

export interface ProjectTemplateCliApplyOptions {
  readonly mode: 'apply';
  readonly expectedPlanId: string;
  readonly force: boolean;
}

export type ProjectTemplateCliMutationOptions =
  | ProjectTemplateCliDryRunOptions
  | ProjectTemplateCliApplyOptions;

const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_ARRAY_RECEIVER = Array;
const CAPTURED_ARRAY_PUSH = Array.prototype.push;
const CAPTURED_OBJECT_KEYS = Object.keys;
const CAPTURED_OBJECT_HAS_OWN = Object.hasOwn;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const CAPTURED_NUMBER_RECEIVER = Number;
const CAPTURED_SET = Set;
const CAPTURED_SET_HAS = Set.prototype.has;
const CAPTURED_SET_ADD = Set.prototype.add;
const CAPTURED_REGEXP_TEST = RegExp.prototype.test;
const CAPTURED_STRING_STARTS_WITH = String.prototype.startsWith;

function apply<T>(fn: (...args: never[]) => T, receiver: unknown, args: unknown[]): T {
  return CAPTURED_REFLECT_APPLY(fn, receiver, args) as T;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const TOKEN_PATTERN = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u;
const SYMBOLIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const MAX_WARNINGS = 10;
const MAX_BACKUP_IDS = 32;
const MAX_CHANGES = 8_192;
const MAX_REVIEW_CODES = 32;

const COMMANDS = new CAPTURED_SET<ProjectTemplateCliCommand>([
  'project-template export',
  'project-template inspect',
  'project-template diff',
  'project-template apply',
  'project-template update',
  'project-template rollback',
  'project-template list',
]);
const WARNING_CODES = apply(CAPTURED_OBJECT_FREEZE, CAPTURED_OBJECT_RECEIVER, [{
  DEPRECATED_SOURCE: true,
  PARTIAL_RESULT: true,
  RECOVERY_AVAILABLE: true,
  REVIEW_REQUIRED: true,
  UPDATE_AVAILABLE: true,
} as const satisfies Readonly<Record<ProjectTemplateCliWarningCode, true>>]);
const REVIEW_CODES = apply(CAPTURED_OBJECT_FREEZE, CAPTURED_OBJECT_RECEIVER, [{
  ACTIVE_RUN: true,
  DEPENDENCY_CONFLICT: true,
  HARD_CONFLICT: true,
  RECOVERY_REQUIRED: true,
  REVIEW_REQUIRED: true,
  SOURCE_DRIFT: true,
  TARGET_DRIFT: true,
} as const satisfies Readonly<Record<ProjectTemplateCliReviewCode, true>>]);

export const PROJECT_TEMPLATE_CLI_ERROR_EXIT_CODES = apply(
  CAPTURED_OBJECT_FREEZE,
  CAPTURED_OBJECT_RECEIVER,
  [{
  EXPECTED_PLAN_ID_REQUIRES_APPLY: 20,
  INVALID_APPLY_INPUT: 20,
  INVALID_ARGUMENT: 20,
  INVALID_EXPECTED_PLAN_ID: 20,
  MISSING_EXPECTED_PLAN_ID: 20,
  MUTUALLY_EXCLUSIVE_OPTIONS: 20,
  NO_RECOVERY_STATE: 20,
  UNKNOWN_OPTION: 20,
  APPROVAL_REQUIRED: 21,
  CONFLICT: 21,
  DEPENDENCY_CONFLICT: 21,
  HARD_CONFLICT: 21,
  REVIEW_REQUIRED: 21,
  BASE_LOCK_DRIFT: 22,
  PLAN_DRIFT: 22,
  ROLLBACK_DRIFT: 22,
  SOURCE_DRIFT: 22,
  TARGET_DRIFT: 22,
  TRANSACTION_PLAN_MISMATCH: 22,
  ACTIVE_RUN: 23,
  APPLY_GUARD_BLOCKED: 23,
  APPLY_LEASE_UNAVAILABLE: 23,
  LEASE_UNAVAILABLE: 23,
  SECURITY_GUARD: 23,
  AUTH_FAILED: 24,
  BACKUP_UNAVAILABLE: 24,
  NETWORK_FAILED: 24,
  SOURCE_INTEGRITY_FAILED: 24,
  SOURCE_UNAVAILABLE: 24,
  PARTIAL_FAILURE: 25,
  APPLY_FAILED_ROLLED_BACK: 25,
  RECOVERY_REQUIRED: 25,
  RESULT_INDETERMINATE: 25,
  INTERNAL: 70,
  PROTOCOL_ERROR: 70,
  INTERRUPTED: 130,
  } as const satisfies Readonly<Record<
  ProjectTemplateCliErrorCode,
  ProjectTemplateCliExitCode
  >>],
) as Readonly<Record<ProjectTemplateCliErrorCode, ProjectTemplateCliExitCode>>;

function invalidSchema(): never {
  throw new ProjectTemplateCliContractError(
    'PROTOCOL_ERROR',
    'machine value does not match the closed schema 1.0 contract',
  );
}

function isArray(
  value: ProjectTemplateCliJson | undefined,
): value is readonly ProjectTemplateCliJson[] {
  return apply(CAPTURED_ARRAY_IS_ARRAY, CAPTURED_ARRAY_RECEIVER, [value]);
}

function isRecord(
  value: ProjectTemplateCliJson | undefined,
): value is Readonly<Record<string, ProjectTemplateCliJson>> {
  return value !== undefined && value !== null && !isArray(value) && typeof value === 'object';
}

function hasExactKeys(
  value: Readonly<Record<string, ProjectTemplateCliJson>>,
  keys: readonly string[],
): boolean {
  const actual = apply(CAPTURED_OBJECT_KEYS, CAPTURED_OBJECT_RECEIVER, [value]);
  if (actual.length !== keys.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    if (!apply(CAPTURED_OBJECT_HAS_OWN, CAPTURED_OBJECT_RECEIVER, [
      value,
      keys[index]!,
    ])) return false;
  }
  return true;
}

function isCount(
  value: ProjectTemplateCliJson | undefined,
  maximum: number,
): value is number {
  return typeof value === 'number'
    && apply(CAPTURED_NUMBER_IS_SAFE_INTEGER, CAPTURED_NUMBER_RECEIVER, [value])
    && value >= 0
    && value <= maximum;
}

function isHash(value: ProjectTemplateCliJson | undefined): value is string {
  return typeof value === 'string' && apply(CAPTURED_REGEXP_TEST, HASH_PATTERN, [value]);
}

function isSafeId(value: ProjectTemplateCliJson | undefined): value is string {
  return typeof value === 'string'
    && apply(CAPTURED_REGEXP_TEST, ID_PATTERN, [value])
    && !apply(CAPTURED_REGEXP_TEST, TOKEN_PATTERN, [value]);
}

function assertExactResult(
  result: Readonly<Record<string, ProjectTemplateCliJson>>,
  keys: readonly string[],
): void {
  if (!hasExactKeys(result, keys)) invalidSchema();
}

function isRecoveryState(
  value: ProjectTemplateCliJson | undefined,
): value is ProjectTemplateCliRecoveryState {
  return value === 'clean' || value === 'recovery-required';
}

function validateReviewSummary(
  result: Readonly<Record<string, ProjectTemplateCliJson>>,
): void {
  if (
    result.readiness !== 'ready'
    && result.readiness !== 'review-required'
    && result.readiness !== 'blocked'
    && result.readiness !== 'recovery-required'
  ) invalidSchema();
  if (!isArray(result.reviewCodes) || result.reviewCodes.length > MAX_REVIEW_CODES) {
    invalidSchema();
  }
  const unique = new CAPTURED_SET<ProjectTemplateCliReviewCode>();
  for (let index = 0; index < result.reviewCodes.length; index += 1) {
    const value = result.reviewCodes[index]!;
    const code = value as ProjectTemplateCliReviewCode;
    if (
      typeof value !== 'string'
      || !apply(CAPTURED_OBJECT_HAS_OWN, CAPTURED_OBJECT_RECEIVER, [REVIEW_CODES, code])
      || apply(CAPTURED_SET_HAS, unique, [code])
    ) {
      invalidSchema();
    }
    apply(CAPTURED_SET_ADD, unique, [code]);
  }
  if ((result.readiness === 'ready') !== (result.reviewCodes.length === 0)) {
    invalidSchema();
  }
}

function validateResult(
  command: ProjectTemplateCliCommand,
  mode: ProjectTemplateCliMode,
  value: ProjectTemplateCliJson | undefined,
): ProjectTemplateCliResult {
  if (!isRecord(value)) invalidSchema();
  const result = value;
  if (command === 'project-template export') {
    const keys = mode === 'apply'
      ? [
        'planId', 'packId', 'entryCount', 'archiveBytes', 'dependencyCount',
        'readiness', 'reviewCodes',
      ]
      : [
        'planId', 'entryCount', 'archiveBytes', 'dependencyCount',
        'readiness', 'reviewCodes',
      ];
    assertExactResult(result, keys);
    validateReviewSummary(result);
    // Machine DTO limits mirror core/archive limits so CLI validation cannot
    // promise work that the transaction layer must later reject.
    if (!isHash(result.planId)
      || (mode === 'apply' && !isHash(result.packId))
      || !isCount(result.entryCount, MAX_TEMPLATE_ENTRIES)
      || !isCount(result.archiveBytes, DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes)
      || !isCount(
        result.dependencyCount,
        MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES,
      )) invalidSchema();
  } else if (command === 'project-template inspect') {
    if (mode !== 'dry-run') invalidSchema();
    assertExactResult(result, [
      'packId', 'entryCount', 'archiveBytes', 'dependencyCount',
      'readiness', 'reviewCodes',
    ]);
    validateReviewSummary(result);
    if (!isHash(result.packId)
      || !isCount(result.entryCount, MAX_TEMPLATE_ENTRIES)
      || !isCount(result.archiveBytes, DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes)
      || !isCount(
        result.dependencyCount,
        MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES,
      )) invalidSchema();
  } else if (command === 'project-template diff') {
    if (mode !== 'dry-run') invalidSchema();
    assertExactResult(result, [
      'planId', 'changeCount', 'conflictCount', 'dependencyCount',
      'readiness', 'reviewCodes',
    ]);
    validateReviewSummary(result);
    if (!isHash(result.planId)
      || !isCount(result.changeCount, MAX_CHANGES)
      || !isCount(result.conflictCount, MAX_CHANGES)
      || !isCount(
        result.dependencyCount,
        MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES,
      )) invalidSchema();
  } else if (command === 'project-template apply') {
    const keys = mode === 'apply'
      ? ['planId', 'applied', 'backupId', 'recoveryState']
      : [
        'planId', 'changeCount', 'conflictCount', 'dependencyCount',
        'readiness', 'reviewCodes',
      ];
    assertExactResult(result, keys);
    if (!isHash(result.planId)
      || (mode === 'apply' && (
        result.applied !== true
        || !isSafeId(result.backupId)
        || result.recoveryState !== 'clean'
      ))
      || (mode === 'dry-run' && (
        !isCount(result.changeCount, MAX_CHANGES)
        || !isCount(result.conflictCount, MAX_CHANGES)
        || !isCount(
          result.dependencyCount,
          MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES,
        )
      ))) {
      invalidSchema();
    }
    if (mode === 'dry-run') validateReviewSummary(result);
  } else if (command === 'project-template update') {
    const keys = mode === 'apply'
      ? ['planId', 'updated', 'backupId', 'recoveryState']
      : [
        'planId', 'updateAvailable', 'dependencyCount', 'readiness', 'reviewCodes',
      ];
    assertExactResult(result, keys);
    if (!isHash(result.planId)
      || (mode === 'apply' && (
        result.updated !== true
        || !isSafeId(result.backupId)
        || result.recoveryState !== 'clean'
      ))
      || (mode === 'dry-run' && (
        typeof result.updateAvailable !== 'boolean'
        || !isCount(
          result.dependencyCount,
          MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES,
        )
      ))) invalidSchema();
    if (mode === 'dry-run') validateReviewSummary(result);
  } else if (command === 'project-template rollback') {
    const keys = mode === 'apply'
      ? ['planId', 'rolledBack', 'backupId', 'recoveryState']
      : ['planId', 'recoveryState', 'readiness', 'reviewCodes'];
    assertExactResult(result, keys);
    if (!isHash(result.planId)
      || (mode === 'apply' && (
        result.rolledBack !== true
        || !isSafeId(result.backupId)
        || result.recoveryState !== 'clean'
      ))
      || (mode === 'dry-run' && !isRecoveryState(result.recoveryState))) {
      invalidSchema();
    }
    if (mode === 'dry-run') validateReviewSummary(result);
  } else {
    if (mode !== 'dry-run') invalidSchema();
    const keys = result.installed === true
      ? ['installed', 'targetId', 'backupIds', 'recoveryState']
      : ['installed', 'backupIds', 'recoveryState'];
    assertExactResult(result, keys);
    if (typeof result.installed !== 'boolean'
      || !isArray(result.backupIds)
      || result.backupIds.length > MAX_BACKUP_IDS
      || !isRecoveryState(result.recoveryState)
      || (result.installed && !isSafeId(result.targetId))) invalidSchema();
    const unique = new CAPTURED_SET<string>();
    for (let index = 0; index < result.backupIds.length; index += 1) {
      const backupId = result.backupIds[index]!;
      if (!isSafeId(backupId) || apply(CAPTURED_SET_HAS, unique, [backupId])) {
        invalidSchema();
      }
      apply(CAPTURED_SET_ADD, unique, [backupId]);
    }
  }
  return result as ProjectTemplateCliResult;
}

function validateWarnings(value: ProjectTemplateCliJson | undefined): readonly ProjectTemplateCliWarning[] {
  if (value === undefined || !isArray(value) || value.length > MAX_WARNINGS) invalidSchema();
  const warnings: ProjectTemplateCliWarning[] = [];
  const unique = new CAPTURED_SET<ProjectTemplateCliWarningCode>();
  for (let index = 0; index < value.length; index += 1) {
    const warning = value[index]!;
    if (!isRecord(warning) || !hasExactKeys(warning, ['code']) || typeof warning.code !== 'string') {
      invalidSchema();
    }
    const code = warning.code as ProjectTemplateCliWarningCode;
    if (
      !apply(CAPTURED_REGEXP_TEST, SYMBOLIC_CODE_PATTERN, [code])
      || !apply(CAPTURED_OBJECT_HAS_OWN, CAPTURED_OBJECT_RECEIVER, [WARNING_CODES, code])
      || apply(CAPTURED_SET_HAS, unique, [code])
    ) {
      invalidSchema();
    }
    apply(CAPTURED_SET_ADD, unique, [code]);
    apply(CAPTURED_ARRAY_PUSH, warnings, [
      apply(CAPTURED_OBJECT_FREEZE, CAPTURED_OBJECT_RECEIVER, [{ code }]),
    ]);
  }
  return apply(
    CAPTURED_OBJECT_FREEZE,
    CAPTURED_OBJECT_RECEIVER,
    [warnings],
  ) as readonly ProjectTemplateCliWarning[];
}

function snapshotJson(value: unknown): ProjectTemplateCliJson {
  try {
    return snapshotProjectTemplateCliJson(value) as ProjectTemplateCliJson;
  } catch (error) {
    if (error instanceof ProjectTemplateCliContractError) throw error;
    invalidSchema();
  }
}

export function snapshotProjectTemplateCliEnvelope(value: unknown): ProjectTemplateCliEnvelope {
  const snapshot = snapshotJson(value);
  if (!isRecord(snapshot)
    || snapshot.schemaVersion !== PROJECT_TEMPLATE_CLI_SCHEMA_VERSION
    || typeof snapshot.command !== 'string'
    || !apply(CAPTURED_SET_HAS, COMMANDS, [
      snapshot.command as ProjectTemplateCliCommand,
    ])
    || (snapshot.mode !== 'dry-run' && snapshot.mode !== 'apply')
    || (snapshot.status !== 'success' && snapshot.status !== 'error')) invalidSchema();
  const command = snapshot.command as ProjectTemplateCliCommand;
  if (
    snapshot.mode === 'apply'
    && (
      command === 'project-template inspect'
      || command === 'project-template diff'
      || command === 'project-template list'
    )
  ) invalidSchema();
  const warnings = validateWarnings(snapshot.warnings);
  if (snapshot.status === 'success') {
    if (!hasExactKeys(snapshot, [
      'schemaVersion', 'command', 'status', 'mode', 'result', 'warnings',
    ])) invalidSchema();
    return apply(CAPTURED_OBJECT_FREEZE, CAPTURED_OBJECT_RECEIVER, [{
      schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION,
      command,
      status: 'success',
      mode: snapshot.mode,
      result: validateResult(command, snapshot.mode, snapshot.result),
      warnings,
    }]) as ProjectTemplateCliSuccessEnvelope;
  }
  if (!hasExactKeys(snapshot, [
    'schemaVersion', 'command', 'status', 'mode', 'error', 'warnings',
  ]) || !isRecord(snapshot.error) || !hasExactKeys(snapshot.error, ['code'])
    || typeof snapshot.error.code !== 'string') invalidSchema();
  const code = snapshot.error.code as ProjectTemplateCliErrorCode;
  if (
    !apply(CAPTURED_REGEXP_TEST, SYMBOLIC_CODE_PATTERN, [code])
    || !apply(CAPTURED_OBJECT_HAS_OWN, CAPTURED_OBJECT_RECEIVER, [
      PROJECT_TEMPLATE_CLI_ERROR_EXIT_CODES,
      code,
    ])
  ) invalidSchema();
  return apply(CAPTURED_OBJECT_FREEZE, CAPTURED_OBJECT_RECEIVER, [{
    schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION,
    command,
    status: 'error',
    mode: snapshot.mode,
    error: apply(CAPTURED_OBJECT_FREEZE, CAPTURED_OBJECT_RECEIVER, [{ code }]),
    warnings,
  }]) as ProjectTemplateCliFailureEnvelope;
}

export function snapshotProjectTemplateCliOutcome(value: unknown): ProjectTemplateCliOutcome {
  const snapshot = snapshotJson(value);
  if (!isRecord(snapshot) || !hasExactKeys(snapshot, ['envelope', 'exitCode'])
    || snapshot.envelope === undefined || typeof snapshot.exitCode !== 'number') invalidSchema();
  const envelope = snapshotProjectTemplateCliEnvelope(snapshot.envelope);
  const expectedExitCode = envelope.status === 'success'
    ? 0
    : projectTemplateCliExitCodeForErrorCode(envelope.error.code);
  if (snapshot.exitCode !== expectedExitCode) invalidSchema();
  return apply(CAPTURED_OBJECT_FREEZE, CAPTURED_OBJECT_RECEIVER, [{
    envelope,
    exitCode: expectedExitCode,
  }]) as ProjectTemplateCliOutcome;
}

export type ProjectTemplateCliSuccessInput =
  ProjectTemplateCliSuccessEnvelope extends infer E
    ? E extends ProjectTemplateCliSuccessEnvelope
      ? {
        readonly command: E['command'];
        readonly mode: E['mode'];
        readonly result: E['result'];
        readonly warnings?: readonly ProjectTemplateCliWarning[];
      }
      : never
    : never;

export function createProjectTemplateCliSuccess(
  input: ProjectTemplateCliSuccessInput,
): ProjectTemplateCliSuccessEnvelope {
  return snapshotProjectTemplateCliEnvelope({
    schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION,
    command: input.command,
    status: 'success',
    mode: input.mode,
    result: input.result,
    warnings: input.warnings ?? [],
  }) as ProjectTemplateCliSuccessEnvelope;
}

export function createProjectTemplateCliFailure(input: {
  readonly command: ProjectTemplateCliCommand;
  readonly mode: ProjectTemplateCliMode;
  readonly code: ProjectTemplateCliErrorCode;
  readonly warnings?: readonly ProjectTemplateCliWarning[];
}): ProjectTemplateCliFailureEnvelope {
  return snapshotProjectTemplateCliEnvelope({
    schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION,
    command: input.command,
    status: 'error',
    mode: input.mode,
    error: { code: input.code },
    warnings: input.warnings ?? [],
  }) as ProjectTemplateCliFailureEnvelope;
}

export function presentProjectTemplateCliEnvelope(envelope: ProjectTemplateCliEnvelope): string {
  return serializeProjectTemplateCliJson(snapshotProjectTemplateCliEnvelope(envelope));
}

export function parseProjectTemplateCliEnvelopeJson(text: unknown): ProjectTemplateCliEnvelope {
  return snapshotProjectTemplateCliEnvelope(parseProjectTemplateCliJson(text));
}

export async function writeProjectTemplateCliOutcome(
  outcome: ProjectTemplateCliOutcome,
  write: (chunk: string) => void | Promise<void>,
): Promise<void> {
  // Validate and snapshot before inspecting status or invoking the writer so
  // hostile accessors cannot cross the top-level machine-output boundary.
  const validated = snapshotProjectTemplateCliOutcome(outcome);
  const chunk = serializeProjectTemplateCliJson(validated.envelope);
  await write(chunk);
}

export function projectTemplateCliExitCodeForErrorCode(code: string): ProjectTemplateCliExitCode {
  return apply(CAPTURED_OBJECT_HAS_OWN, CAPTURED_OBJECT_RECEIVER, [
    PROJECT_TEMPLATE_CLI_ERROR_EXIT_CODES,
    code,
  ])
    ? PROJECT_TEMPLATE_CLI_ERROR_EXIT_CODES[code as ProjectTemplateCliErrorCode]
    : 70;
}

function usageError(code: ProjectTemplateCliErrorCode, message: string): never {
  throw new ProjectTemplateCliContractError(code, message, 20);
}

export function parseProjectTemplateCliMutationOptions(
  argv: readonly string[],
): ProjectTemplateCliMutationOptions {
  let applyMode = false;
  let dryRun = false;
  let force = false;
  let expectedPlanId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      if (applyMode) usageError('INVALID_ARGUMENT', '--apply may only be provided once');
      applyMode = true;
    } else if (argument === '--dry-run') {
      if (dryRun) usageError('INVALID_ARGUMENT', '--dry-run may only be provided once');
      dryRun = true;
    } else if (argument === '--force') {
      if (force) usageError('INVALID_ARGUMENT', '--force may only be provided once');
      force = true;
    } else if (argument === '--expected-plan-id') {
      if (expectedPlanId !== undefined) {
        usageError('INVALID_ARGUMENT', '--expected-plan-id may only be provided once');
      }
      const candidate = argv[index + 1];
      if (
        candidate === undefined
        || apply(CAPTURED_STRING_STARTS_WITH, candidate, ['--'])
      ) {
        usageError('MISSING_EXPECTED_PLAN_ID', '--expected-plan-id requires a value');
      }
      expectedPlanId = candidate;
      index += 1;
    } else {
      usageError('UNKNOWN_OPTION', 'unknown project-template mutation option');
    }
  }
  if (applyMode && dryRun) {
    usageError('MUTUALLY_EXCLUSIVE_OPTIONS', '--apply and --dry-run are exclusive');
  }
  if (!applyMode && expectedPlanId !== undefined) {
    usageError('EXPECTED_PLAN_ID_REQUIRES_APPLY', '--expected-plan-id is only valid with --apply');
  }
  if (applyMode && expectedPlanId === undefined) {
    usageError('MISSING_EXPECTED_PLAN_ID', '--apply requires --expected-plan-id');
  }
  if (
    expectedPlanId !== undefined
    && !apply(CAPTURED_REGEXP_TEST, HASH_PATTERN, [expectedPlanId])
  ) {
    usageError('INVALID_EXPECTED_PLAN_ID', 'expected plan id must be lowercase sha256');
  }
  return (applyMode
    ? apply(CAPTURED_OBJECT_FREEZE, CAPTURED_OBJECT_RECEIVER, [{
      mode: 'apply', expectedPlanId: expectedPlanId!, force,
    }])
    : apply(CAPTURED_OBJECT_FREEZE, CAPTURED_OBJECT_RECEIVER, [{
      mode: 'dry-run', force,
    }])) as ProjectTemplateCliMutationOptions;
}
