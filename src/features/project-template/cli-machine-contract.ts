import {
  serializeProjectTemplateCliJson,
  snapshotProjectTemplateCliJson,
} from './cli-bounded-json.js';
import { ProjectTemplateCliContractError } from './cli-contract-error.js';

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
  | 'UPDATE_AVAILABLE';
export interface ProjectTemplateCliWarning {
  readonly code: ProjectTemplateCliWarningCode;
}

export type ProjectTemplateCliErrorCode =
  | 'EXPECTED_PLAN_ID_REQUIRES_APPLY'
  | 'INVALID_ARGUMENT'
  | 'INVALID_EXPECTED_PLAN_ID'
  | 'MISSING_EXPECTED_PLAN_ID'
  | 'MUTUALLY_EXCLUSIVE_OPTIONS'
  | 'UNKNOWN_OPTION'
  | 'CONFLICT'
  | 'HARD_CONFLICT'
  | 'REVIEW_REQUIRED'
  | 'PLAN_DRIFT'
  | 'SOURCE_DRIFT'
  | 'TARGET_DRIFT'
  | 'TRANSACTION_PLAN_MISMATCH'
  | 'ACTIVE_RUN'
  | 'LEASE_UNAVAILABLE'
  | 'SECURITY_GUARD'
  | 'AUTH_FAILED'
  | 'NETWORK_FAILED'
  | 'SOURCE_UNAVAILABLE'
  | 'RECOVERY_REQUIRED'
  | 'RESULT_INDETERMINATE'
  | 'INTERNAL'
  | 'PROTOCOL_ERROR'
  | 'INTERRUPTED';

export type ProjectTemplateCliResult =
  | { readonly planId: string; readonly entryCount: number; readonly byteLength: number }
  | { readonly planId: string; readonly packId: string; readonly entryCount: number; readonly byteLength: number }
  | { readonly packId: string; readonly entryCount: number; readonly valid: boolean }
  | { readonly planId: string; readonly changeCount: number; readonly conflictCount: number }
  | { readonly planId: string; readonly applied: true }
  | { readonly planId: string; readonly updateAvailable: boolean }
  | { readonly planId: string; readonly updated: true }
  | { readonly planId: string }
  | { readonly planId: string; readonly rolledBack: true }
  | { readonly installed: false; readonly backupIds: readonly string[] }
  | { readonly installed: true; readonly targetId: string; readonly backupIds: readonly string[] };

interface ProjectTemplateCliEnvelopeBase {
  readonly schemaVersion: typeof PROJECT_TEMPLATE_CLI_SCHEMA_VERSION;
  readonly command: ProjectTemplateCliCommand;
  readonly mode: ProjectTemplateCliMode;
  readonly warnings: readonly ProjectTemplateCliWarning[];
}

export interface ProjectTemplateCliSuccessEnvelope extends ProjectTemplateCliEnvelopeBase {
  readonly status: 'success';
  readonly result: ProjectTemplateCliResult;
}

export interface ProjectTemplateCliFailureEnvelope extends ProjectTemplateCliEnvelopeBase {
  readonly status: 'error';
  readonly error: { readonly code: ProjectTemplateCliErrorCode };
}

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

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const TOKEN_PATTERN = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u;
const SYMBOLIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const MAX_WARNINGS = 10;
const MAX_BACKUP_IDS = 1_000;

const COMMANDS = new Set<ProjectTemplateCliCommand>([
  'project-template export',
  'project-template inspect',
  'project-template diff',
  'project-template apply',
  'project-template update',
  'project-template rollback',
  'project-template list',
]);
const ERROR_CODES = new Set<ProjectTemplateCliErrorCode>([
  'EXPECTED_PLAN_ID_REQUIRES_APPLY', 'INVALID_ARGUMENT',
  'INVALID_EXPECTED_PLAN_ID', 'MISSING_EXPECTED_PLAN_ID',
  'MUTUALLY_EXCLUSIVE_OPTIONS', 'UNKNOWN_OPTION', 'CONFLICT',
  'HARD_CONFLICT', 'REVIEW_REQUIRED', 'PLAN_DRIFT', 'SOURCE_DRIFT',
  'TARGET_DRIFT', 'TRANSACTION_PLAN_MISMATCH', 'ACTIVE_RUN',
  'LEASE_UNAVAILABLE', 'SECURITY_GUARD', 'AUTH_FAILED', 'NETWORK_FAILED',
  'SOURCE_UNAVAILABLE', 'RECOVERY_REQUIRED', 'RESULT_INDETERMINATE',
  'INTERNAL', 'PROTOCOL_ERROR', 'INTERRUPTED',
]);
const WARNING_CODES = new Set<ProjectTemplateCliWarningCode>([
  'DEPRECATED_SOURCE', 'PARTIAL_RESULT', 'UPDATE_AVAILABLE',
]);

const EXIT_20_CODES = new Set<ProjectTemplateCliErrorCode>([
  'EXPECTED_PLAN_ID_REQUIRES_APPLY', 'INVALID_ARGUMENT',
  'INVALID_EXPECTED_PLAN_ID', 'MISSING_EXPECTED_PLAN_ID',
  'MUTUALLY_EXCLUSIVE_OPTIONS', 'UNKNOWN_OPTION',
]);
const EXIT_21_CODES = new Set<ProjectTemplateCliErrorCode>([
  'CONFLICT', 'HARD_CONFLICT', 'REVIEW_REQUIRED',
]);
const EXIT_22_CODES = new Set<ProjectTemplateCliErrorCode>([
  'PLAN_DRIFT', 'SOURCE_DRIFT', 'TARGET_DRIFT', 'TRANSACTION_PLAN_MISMATCH',
]);
const EXIT_23_CODES = new Set<ProjectTemplateCliErrorCode>([
  'ACTIVE_RUN', 'LEASE_UNAVAILABLE', 'SECURITY_GUARD',
]);
const EXIT_24_CODES = new Set<ProjectTemplateCliErrorCode>([
  'AUTH_FAILED', 'NETWORK_FAILED', 'SOURCE_UNAVAILABLE',
]);
const EXIT_25_CODES = new Set<ProjectTemplateCliErrorCode>([
  'RECOVERY_REQUIRED', 'RESULT_INDETERMINATE',
]);

function invalidSchema(): never {
  throw new ProjectTemplateCliContractError(
    'PROTOCOL_ERROR',
    'machine value does not match the closed schema 1.0 contract',
  );
}

function isArray(
  value: ProjectTemplateCliJson | undefined,
): value is readonly ProjectTemplateCliJson[] {
  return Array.isArray(value);
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
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCount(value: ProjectTemplateCliJson | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isHash(value: ProjectTemplateCliJson | undefined): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function isSafeId(value: ProjectTemplateCliJson | undefined): value is string {
  return typeof value === 'string'
    && ID_PATTERN.test(value)
    && !TOKEN_PATTERN.test(value);
}

function assertExactResult(
  result: Readonly<Record<string, ProjectTemplateCliJson>>,
  keys: readonly string[],
): void {
  if (!hasExactKeys(result, keys)) invalidSchema();
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
      ? ['planId', 'packId', 'entryCount', 'byteLength']
      : ['planId', 'entryCount', 'byteLength'];
    assertExactResult(result, keys);
    if (!isHash(result.planId)
      || (mode === 'apply' && !isHash(result.packId))
      || !isCount(result.entryCount)
      || !isCount(result.byteLength)) invalidSchema();
  } else if (command === 'project-template inspect') {
    if (mode !== 'dry-run') invalidSchema();
    assertExactResult(result, ['packId', 'entryCount', 'valid']);
    if (!isHash(result.packId) || !isCount(result.entryCount) || typeof result.valid !== 'boolean') {
      invalidSchema();
    }
  } else if (command === 'project-template diff') {
    if (mode !== 'dry-run') invalidSchema();
    assertExactResult(result, ['planId', 'changeCount', 'conflictCount']);
    if (!isHash(result.planId) || !isCount(result.changeCount) || !isCount(result.conflictCount)) {
      invalidSchema();
    }
  } else if (command === 'project-template apply') {
    const keys = mode === 'apply'
      ? ['planId', 'applied']
      : ['planId', 'changeCount', 'conflictCount'];
    assertExactResult(result, keys);
    if (!isHash(result.planId)
      || (mode === 'apply' && result.applied !== true)
      || (mode === 'dry-run' && (!isCount(result.changeCount) || !isCount(result.conflictCount)))) {
      invalidSchema();
    }
  } else if (command === 'project-template update') {
    const keys = mode === 'apply' ? ['planId', 'updated'] : ['planId', 'updateAvailable'];
    assertExactResult(result, keys);
    if (!isHash(result.planId)
      || (mode === 'apply' && result.updated !== true)
      || (mode === 'dry-run' && typeof result.updateAvailable !== 'boolean')) invalidSchema();
  } else if (command === 'project-template rollback') {
    const keys = mode === 'apply' ? ['planId', 'rolledBack'] : ['planId'];
    assertExactResult(result, keys);
    if (!isHash(result.planId) || (mode === 'apply' && result.rolledBack !== true)) {
      invalidSchema();
    }
  } else {
    if (mode !== 'dry-run') invalidSchema();
    const keys = result.installed === true
      ? ['installed', 'targetId', 'backupIds']
      : ['installed', 'backupIds'];
    assertExactResult(result, keys);
    if (typeof result.installed !== 'boolean'
      || !isArray(result.backupIds)
      || result.backupIds.length > MAX_BACKUP_IDS
      || (result.installed && !isSafeId(result.targetId))) invalidSchema();
    const unique = new Set<string>();
    for (const backupId of result.backupIds) {
      if (!isSafeId(backupId) || unique.has(backupId)) invalidSchema();
      unique.add(backupId);
    }
  }
  return result as ProjectTemplateCliResult;
}

function validateWarnings(value: ProjectTemplateCliJson | undefined): readonly ProjectTemplateCliWarning[] {
  if (value === undefined || !isArray(value) || value.length > MAX_WARNINGS) invalidSchema();
  const warnings: ProjectTemplateCliWarning[] = [];
  const unique = new Set<ProjectTemplateCliWarningCode>();
  for (const warning of value) {
    if (!isRecord(warning) || !hasExactKeys(warning, ['code']) || typeof warning.code !== 'string') {
      invalidSchema();
    }
    const code = warning.code as ProjectTemplateCliWarningCode;
    if (!SYMBOLIC_CODE_PATTERN.test(code) || !WARNING_CODES.has(code) || unique.has(code)) {
      invalidSchema();
    }
    unique.add(code);
    warnings.push({ code });
  }
  return Object.freeze(warnings.map((warning) => Object.freeze(warning)));
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
    || !COMMANDS.has(snapshot.command as ProjectTemplateCliCommand)
    || (snapshot.mode !== 'dry-run' && snapshot.mode !== 'apply')
    || (snapshot.status !== 'success' && snapshot.status !== 'error')) invalidSchema();
  const command = snapshot.command as ProjectTemplateCliCommand;
  const warnings = validateWarnings(snapshot.warnings);
  if (snapshot.status === 'success') {
    if (!hasExactKeys(snapshot, [
      'schemaVersion', 'command', 'status', 'mode', 'result', 'warnings',
    ])) invalidSchema();
    return Object.freeze({
      schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION,
      command,
      status: 'success',
      mode: snapshot.mode,
      result: validateResult(command, snapshot.mode, snapshot.result),
      warnings,
    });
  }
  if (!hasExactKeys(snapshot, [
    'schemaVersion', 'command', 'status', 'mode', 'error', 'warnings',
  ]) || !isRecord(snapshot.error) || !hasExactKeys(snapshot.error, ['code'])
    || typeof snapshot.error.code !== 'string') invalidSchema();
  const code = snapshot.error.code as ProjectTemplateCliErrorCode;
  if (!SYMBOLIC_CODE_PATTERN.test(code) || !ERROR_CODES.has(code)) invalidSchema();
  return Object.freeze({
    schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION,
    command,
    status: 'error',
    mode: snapshot.mode,
    error: Object.freeze({ code }),
    warnings,
  });
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
  return Object.freeze({ envelope, exitCode: expectedExitCode });
}

export function createProjectTemplateCliSuccess(input: {
  readonly command: ProjectTemplateCliCommand;
  readonly mode: ProjectTemplateCliMode;
  readonly result: ProjectTemplateCliResult;
  readonly warnings?: readonly ProjectTemplateCliWarning[];
}): ProjectTemplateCliSuccessEnvelope {
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
  if (code === 'INTERRUPTED') return 130;
  if (EXIT_20_CODES.has(code as ProjectTemplateCliErrorCode)) return 20;
  if (EXIT_21_CODES.has(code as ProjectTemplateCliErrorCode)) return 21;
  if (EXIT_22_CODES.has(code as ProjectTemplateCliErrorCode)) return 22;
  if (EXIT_23_CODES.has(code as ProjectTemplateCliErrorCode)) return 23;
  if (EXIT_24_CODES.has(code as ProjectTemplateCliErrorCode)) return 24;
  if (EXIT_25_CODES.has(code as ProjectTemplateCliErrorCode)) return 25;
  return 70;
}

function usageError(code: ProjectTemplateCliErrorCode, message: string): never {
  throw new ProjectTemplateCliContractError(code, message, 20);
}

export function parseProjectTemplateCliMutationOptions(
  argv: readonly string[],
): ProjectTemplateCliMutationOptions {
  let apply = false;
  let dryRun = false;
  let force = false;
  let expectedPlanId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      if (apply) usageError('INVALID_ARGUMENT', '--apply may only be provided once');
      apply = true;
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
      if (candidate === undefined || candidate.startsWith('--')) {
        usageError('MISSING_EXPECTED_PLAN_ID', '--expected-plan-id requires a value');
      }
      expectedPlanId = candidate;
      index += 1;
    } else {
      usageError('UNKNOWN_OPTION', 'unknown project-template mutation option');
    }
  }
  if (apply && dryRun) {
    usageError('MUTUALLY_EXCLUSIVE_OPTIONS', '--apply and --dry-run are exclusive');
  }
  if (!apply && expectedPlanId !== undefined) {
    usageError('EXPECTED_PLAN_ID_REQUIRES_APPLY', '--expected-plan-id is only valid with --apply');
  }
  if (apply && expectedPlanId === undefined) {
    usageError('MISSING_EXPECTED_PLAN_ID', '--apply requires --expected-plan-id');
  }
  if (expectedPlanId !== undefined && !HASH_PATTERN.test(expectedPlanId)) {
    usageError('INVALID_EXPECTED_PLAN_ID', 'expected plan id must be lowercase sha256');
  }
  return apply
    ? Object.freeze({ mode: 'apply', expectedPlanId: expectedPlanId!, force })
    : Object.freeze({ mode: 'dry-run', force });
}
