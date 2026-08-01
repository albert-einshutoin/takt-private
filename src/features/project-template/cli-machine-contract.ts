import { types } from 'node:util';
import { canonicalizeTaktpackJson } from './canonical-json.js';

export const PROJECT_TEMPLATE_CLI_SCHEMA_VERSION = '1.0' as const;

export type ProjectTemplateCliMode = 'dry-run' | 'apply';
export type ProjectTemplateCliExitCode = 0 | 20 | 21 | 22 | 23 | 24 | 25 | 70 | 130;
export type ProjectTemplateCliJson =
  | null
  | boolean
  | number
  | string
  | readonly ProjectTemplateCliJson[]
  | { readonly [key: string]: ProjectTemplateCliJson };

export interface ProjectTemplateCliWarning {
  readonly code: string;
}

interface ProjectTemplateCliEnvelopeBase {
  readonly schemaVersion: typeof PROJECT_TEMPLATE_CLI_SCHEMA_VERSION;
  readonly command: string;
  readonly mode: ProjectTemplateCliMode;
  readonly warnings: readonly ProjectTemplateCliWarning[];
}

export interface ProjectTemplateCliSuccessEnvelope
  extends ProjectTemplateCliEnvelopeBase {
  readonly status: 'success';
  readonly result: ProjectTemplateCliJson;
}

export interface ProjectTemplateCliFailureEnvelope
  extends ProjectTemplateCliEnvelopeBase {
  readonly status: 'error';
  readonly error: {
    readonly code: string;
  };
}

export type ProjectTemplateCliEnvelope =
  | ProjectTemplateCliSuccessEnvelope
  | ProjectTemplateCliFailureEnvelope;

export interface ProjectTemplateCliOutcome {
  readonly envelope: ProjectTemplateCliEnvelope;
  readonly exitCode: ProjectTemplateCliExitCode;
}

export interface ProjectTemplateCliMutationOptions {
  readonly mode: ProjectTemplateCliMode;
  readonly expectedPlanId?: string;
  readonly force: boolean;
}

const SYMBOLIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const PLAN_ID_PATTERN = /^[a-f0-9]{64}$/u;
const COMMAND_PATTERN = /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const FORBIDDEN_FIELD_PATTERN = /(?:credential|secret|password|token|cache|receipt|approval|evidence|verifier|lease)/iu;
const MAX_MACHINE_JSON_DEPTH = 64;
const MAX_MACHINE_JSON_NODES = 10_000;
const MAX_MACHINE_JSON_BYTES = 1_048_576;

const EXIT_20_CODES = new Set([
  'EXPECTED_PLAN_ID_REQUIRES_APPLY',
  'INVALID_ARGUMENT',
  'INVALID_EXPECTED_PLAN_ID',
  'MISSING_EXPECTED_PLAN_ID',
  'MUTUALLY_EXCLUSIVE_OPTIONS',
  'UNKNOWN_OPTION',
]);
const EXIT_21_CODES = new Set([
  'CONFLICT',
  'HARD_CONFLICT',
  'REVIEW_REQUIRED',
]);
const EXIT_22_CODES = new Set([
  'PLAN_DRIFT',
  'SOURCE_DRIFT',
  'TARGET_DRIFT',
  'TRANSACTION_PLAN_MISMATCH',
]);
const EXIT_23_CODES = new Set([
  'ACTIVE_RUN',
  'LEASE_UNAVAILABLE',
  'SECURITY_GUARD',
]);
const EXIT_24_CODES = new Set([
  'AUTH_FAILED',
  'NETWORK_FAILED',
  'SOURCE_UNAVAILABLE',
]);
const EXIT_25_CODES = new Set([
  'RECOVERY_REQUIRED',
  'RESULT_INDETERMINATE',
]);

export class ProjectTemplateCliContractError extends Error {
  readonly code: string;
  readonly exitCode: ProjectTemplateCliExitCode;

  constructor(code: string, message: string, exitCode: ProjectTemplateCliExitCode = 70) {
    super(message);
    this.name = 'ProjectTemplateCliContractError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function assertSymbolicCode(code: string): void {
  if (!SYMBOLIC_CODE_PATTERN.test(code)) {
    throw new ProjectTemplateCliContractError(
      'PROTOCOL_ERROR',
      'machine error and warning codes must be symbolic',
    );
  }
}

function assertSafeMachineJson(value: ProjectTemplateCliJson): void {
  if (typeof value === 'string') {
    if (value.startsWith('/') || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)) {
      throw new ProjectTemplateCliContractError(
        'PROTOCOL_ERROR',
        'absolute paths are not allowed in machine output',
      );
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertSafeMachineJson(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    // Authority and local-state fields stay out of the public envelope because
    // callers routinely persist stdout in CI logs and automation artifacts.
    if (FORBIDDEN_FIELD_PATTERN.test(key)) {
      throw new ProjectTemplateCliContractError(
        'PROTOCOL_ERROR',
        'authority and local-state fields are not allowed in machine output',
      );
    }
    assertSafeMachineJson(item);
  }
}

function invalidMachineGraph(): never {
  throw new ProjectTemplateCliContractError(
    'PROTOCOL_ERROR',
    'machine output must be a bounded plain JSON graph',
  );
}

function preflightMachineGraph(root: unknown): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  const seen = new WeakSet<object>();
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_MACHINE_JSON_NODES || current.depth > MAX_MACHINE_JSON_DEPTH) {
      invalidMachineGraph();
    }
    const value = current.value;
    if (
      value === null
      || typeof value === 'string'
      || typeof value === 'boolean'
    ) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) invalidMachineGraph();
      continue;
    }
    if (typeof value !== 'object' || types.isProxy(value) || seen.has(value)) {
      invalidMachineGraph();
    }
    seen.add(value);

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) invalidMachineGraph();
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined
        || !('value' in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || keys.length !== lengthDescriptor.value + 1
      ) invalidMachineGraph();
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[`${index}`];
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !('value' in descriptor)
        ) invalidMachineGraph();
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      continue;
    }
    if (prototype !== Object.prototype && prototype !== null) invalidMachineGraph();
    for (const key of keys) {
      if (typeof key !== 'string') invalidMachineGraph();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
      ) invalidMachineGraph();
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

function snapshotMachineJson(value: unknown): ProjectTemplateCliJson {
  try {
    preflightMachineGraph(value);
    const canonical = canonicalizeTaktpackJson(value);
    if (Buffer.byteLength(canonical, 'utf8') > MAX_MACHINE_JSON_BYTES) {
      invalidMachineGraph();
    }
    const snapshot = JSON.parse(canonical) as ProjectTemplateCliJson;
    assertSafeMachineJson(snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof ProjectTemplateCliContractError) throw error;
    throw new ProjectTemplateCliContractError(
      'PROTOCOL_ERROR',
      'machine result must be a safe finite JSON value',
    );
  }
}

function snapshotWarnings(
  warnings: readonly ProjectTemplateCliWarning[] | undefined,
): readonly ProjectTemplateCliWarning[] {
  const snapshot = snapshotMachineJson(warnings ?? []);
  if (!isJsonArray(snapshot)) invalidMachineGraph();
  return snapshot.map((warning) => {
    if (
      warning === null
      || isJsonArray(warning)
      || typeof warning !== 'object'
      || !hasExactKeys(warning, ['code'])
      || typeof warning.code !== 'string'
    ) invalidMachineGraph();
    assertSymbolicCode(warning.code);
    return Object.freeze({ code: warning.code });
  });
}

function hasExactKeys(
  value: Readonly<Record<string, ProjectTemplateCliJson>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function isJsonArray(
  value: ProjectTemplateCliJson,
): value is readonly ProjectTemplateCliJson[] {
  return Array.isArray(value);
}

function validateEnvelope(envelope: unknown): ProjectTemplateCliEnvelope {
  const snapshot = snapshotMachineJson(envelope);
  if (snapshot === null || isJsonArray(snapshot) || typeof snapshot !== 'object') {
    throw new ProjectTemplateCliContractError(
      'PROTOCOL_ERROR',
      'machine envelope must be an object',
    );
  }
  const record = snapshot as Readonly<Record<string, ProjectTemplateCliJson>>;
  if (
    record.schemaVersion !== PROJECT_TEMPLATE_CLI_SCHEMA_VERSION
    || typeof record.command !== 'string'
    || !COMMAND_PATTERN.test(record.command)
    || (record.mode !== 'dry-run' && record.mode !== 'apply')
    || (record.status !== 'success' && record.status !== 'error')
    || !Array.isArray(record.warnings)
  ) {
    throw new ProjectTemplateCliContractError(
      'PROTOCOL_ERROR',
      'machine envelope base fields are invalid',
    );
  }
  for (const warning of record.warnings) {
    if (
      warning === null
      || isJsonArray(warning)
      || typeof warning !== 'object'
      || !hasExactKeys(warning, ['code'])
      || typeof warning.code !== 'string'
    ) {
      throw new ProjectTemplateCliContractError(
        'PROTOCOL_ERROR',
        'machine warning is invalid',
      );
    }
    assertSymbolicCode(warning.code);
  }
  if (record.status === 'success') {
    if (!hasExactKeys(record, [
      'schemaVersion', 'command', 'status', 'mode', 'result', 'warnings',
    ])) {
      throw new ProjectTemplateCliContractError(
        'PROTOCOL_ERROR',
        'success envelope must contain result and no error',
      );
    }
  } else {
    if (
      !hasExactKeys(record, [
        'schemaVersion', 'command', 'status', 'mode', 'error', 'warnings',
      ])
      || record.error === null
    ) {
      throw new ProjectTemplateCliContractError(
        'PROTOCOL_ERROR',
        'error envelope must contain one symbolic error and no result',
      );
    }
    const errorValue = record.error;
    if (
      errorValue === undefined
      || isJsonArray(errorValue)
      || typeof errorValue !== 'object'
      || !hasExactKeys(errorValue, ['code'])
      || typeof errorValue.code !== 'string'
    ) {
      throw new ProjectTemplateCliContractError(
        'PROTOCOL_ERROR',
        'machine error must contain one symbolic code',
      );
    }
    assertSymbolicCode(errorValue.code);
  }
  return snapshot as unknown as ProjectTemplateCliEnvelope;
}

export function createProjectTemplateCliSuccess(input: {
  readonly command: string;
  readonly mode: ProjectTemplateCliMode;
  readonly result: unknown;
  readonly warnings?: readonly ProjectTemplateCliWarning[];
}): ProjectTemplateCliSuccessEnvelope {
  return Object.freeze({
    schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION,
    command: input.command,
    status: 'success',
    mode: input.mode,
    result: snapshotMachineJson(input.result),
    warnings: Object.freeze(snapshotWarnings(input.warnings)),
  });
}

export function createProjectTemplateCliFailure(input: {
  readonly command: string;
  readonly mode: ProjectTemplateCliMode;
  readonly code: string;
  readonly warnings?: readonly ProjectTemplateCliWarning[];
}): ProjectTemplateCliFailureEnvelope {
  assertSymbolicCode(input.code);
  return Object.freeze({
    schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION,
    command: input.command,
    status: 'error',
    mode: input.mode,
    error: Object.freeze({ code: input.code }),
    warnings: Object.freeze(snapshotWarnings(input.warnings)),
  });
}

export function presentProjectTemplateCliEnvelope(
  envelope: ProjectTemplateCliEnvelope,
): string {
  return canonicalizeTaktpackJson(validateEnvelope(envelope));
}

export async function writeProjectTemplateCliOutcome(
  outcome: ProjectTemplateCliOutcome,
  write: (chunk: string) => void | Promise<void>,
): Promise<void> {
  // A single top-level write prevents partial JSON from becoming observable if
  // presentation fails and gives shell consumers one complete record to parse.
  const expectedExitCode = outcome.envelope.status === 'success'
    ? 0
    : projectTemplateCliExitCodeForErrorCode(outcome.envelope.error.code);
  if (outcome.exitCode !== expectedExitCode) {
    throw new ProjectTemplateCliContractError(
      'PROTOCOL_ERROR',
      'exit code contradicts machine envelope status',
    );
  }
  const chunk = presentProjectTemplateCliEnvelope(outcome.envelope);
  await write(chunk);
}

export function projectTemplateCliExitCodeForErrorCode(
  code: string,
): ProjectTemplateCliExitCode {
  if (code === 'INTERRUPTED') return 130;
  if (EXIT_20_CODES.has(code)) return 20;
  if (EXIT_21_CODES.has(code)) return 21;
  if (EXIT_22_CODES.has(code)) return 22;
  if (EXIT_23_CODES.has(code)) return 23;
  if (EXIT_24_CODES.has(code)) return 24;
  if (EXIT_25_CODES.has(code)) return 25;
  return 70;
}

function usageError(code: string, message: string): never {
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
    usageError(
      'EXPECTED_PLAN_ID_REQUIRES_APPLY',
      '--expected-plan-id is only valid with --apply',
    );
  }
  if (apply && expectedPlanId === undefined) {
    usageError('MISSING_EXPECTED_PLAN_ID', '--apply requires --expected-plan-id');
  }
  if (expectedPlanId !== undefined && !PLAN_ID_PATTERN.test(expectedPlanId)) {
    usageError('INVALID_EXPECTED_PLAN_ID', 'expected plan id must be lowercase sha256');
  }

  if (apply) {
    return Object.freeze({ mode: 'apply', expectedPlanId, force });
  }
  return Object.freeze({ mode: 'dry-run', force });
}
