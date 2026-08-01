import { resolve } from 'node:path';
import { types } from 'node:util';
import {
  createProjectTemplateCliFailure,
  createProjectTemplateCliSuccess,
  projectTemplateCliExitCodeForErrorCode,
  type ProjectTemplateCliErrorCode,
  type ProjectTemplateCliOutcome,
  type ProjectTemplateCliReviewCode,
} from './cli-machine-contract.js';
import {
  consumeProjectTemplateCliMutationAdmission,
  ProjectTemplateCliInvalidAdmission,
  snapshotProjectTemplateCliOwnData,
  type ProjectTemplateCliMutationAdmission,
} from './cli-lifecycle.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CAPTURED_REGEXP_TEST = RegExp.prototype.test;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_IS_PROXY = types.isProxy;
const CAPTURED_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const CAPTURED_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const CAPTURED_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const testPattern = (pattern: RegExp, value: string): boolean => (
  CAPTURED_REFLECT_APPLY(CAPTURED_REGEXP_TEST, pattern, [value]) as boolean
);
const MAX_COUNT = 10_000;

export type ProjectTemplateCliRemotePortErrorCode =
  | 'AUTH_FAILED'
  | 'NETWORK_FAILED'
  | 'SOURCE_INTEGRITY_FAILED'
  | 'SOURCE_UNAVAILABLE'
  | 'SECURITY_GUARD'
  | 'APPLY_GUARD_BLOCKED'
  | 'APPLY_LEASE_UNAVAILABLE'
  | 'RECOVERY_REQUIRED'
  | 'RESULT_INDETERMINATE'
  | 'INTERNAL';

export class ProjectTemplateCliRemotePortError extends Error {
  constructor(public readonly code: ProjectTemplateCliRemotePortErrorCode) {
    super('project template remote operation failed');
    this.name = 'ProjectTemplateCliRemotePortError';
    Object.freeze(this);
  }
}

export interface ProjectTemplateCliRemoteDerivedPlan {
  readonly transactionPlanId: string;
  readonly changeCount: number;
  readonly conflictCount: number;
  readonly dependencyCount: number;
  readonly updateAvailable: boolean;
  readonly reviewRequired: boolean;
  readonly hardConflict: boolean;
  readonly defaultApplyPossible: boolean;
  readonly forceApplicable: boolean;
  /** Process-local authority. It is never projected into a CLI result. */
  readonly authority: unknown;
}

export type ProjectTemplateCliRemoteExecutionResult =
  | {
    readonly status: 'committed';
    readonly transactionPlanId: string;
    readonly backupId: string;
  }
  | { readonly status: 'recovery_required'; readonly backupId?: string }
  | { readonly status: 'indeterminate' }
  | {
    readonly status: 'not_started';
    readonly code:
      | 'TARGET_DRIFT'
      | 'BASE_LOCK_DRIFT'
      | 'TRANSACTION_PLAN_MISMATCH'
      | 'APPLY_GUARD_BLOCKED'
      | 'APPLY_LEASE_UNAVAILABLE'
      | 'SECURITY_GUARD'
      | 'APPROVAL_REQUIRED'
      | 'APPLY_FAILED_ROLLED_BACK';
  };

export interface ProjectTemplateCliRemoteApplyPort {
  readonly inspectGuard: (cwd: string) => {
    readonly passed: boolean;
    readonly blocks: readonly { readonly code: string }[];
  };
  /** Must perform fresh advisory, download, offline receipt verification and derivation. */
  readonly derive: (options: {
    readonly cwd: string;
    readonly source: string;
    readonly currentTaktVersion: string;
    readonly baselineStrategy: 'conflict' | 'adopt-identical';
    readonly signal?: AbortSignal;
  }) => Promise<ProjectTemplateCliRemoteDerivedPlan>;
  /** Mutation admission boundary. It must drain to a terminal result. */
  readonly execute: (options: {
    readonly cwd: string;
    readonly source: string;
    readonly currentTaktVersion: string;
    readonly baselineStrategy: 'conflict' | 'adopt-identical';
    readonly expectedTransactionPlanId: string;
    readonly force: boolean;
    readonly derived: ProjectTemplateCliRemoteDerivedPlan;
  }) => Promise<ProjectTemplateCliRemoteExecutionResult>;
}

export interface ProjectTemplateCliRemoteBaseOptions {
  readonly cwd: string;
  readonly source: string;
  readonly currentTaktVersion: string;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly force: boolean;
  readonly signal?: AbortSignal;
}

export type ProjectTemplateCliRemoteMutationOptions =
  | (ProjectTemplateCliRemoteBaseOptions & { readonly mode: 'dry-run' })
  | (ProjectTemplateCliRemoteBaseOptions & {
    readonly mode: 'apply';
    readonly expectedPlanId: string;
    readonly admitMutation: ProjectTemplateCliMutationAdmission;
  });

export interface ProjectTemplateCliRemoteApplyService {
  diff(options: ProjectTemplateCliRemoteBaseOptions): Promise<ProjectTemplateCliOutcome>;
  apply(options: ProjectTemplateCliRemoteMutationOptions): Promise<ProjectTemplateCliOutcome>;
  update(options: ProjectTemplateCliRemoteMutationOptions): Promise<ProjectTemplateCliOutcome>;
}

function failure(
  command: 'project-template diff' | 'project-template apply' | 'project-template update',
  mode: 'dry-run' | 'apply',
  code: ProjectTemplateCliErrorCode,
): ProjectTemplateCliOutcome {
  return {
    envelope: createProjectTemplateCliFailure({ command, mode, code }),
    exitCode: projectTemplateCliExitCodeForErrorCode(code),
  };
}

function success(
  command: 'project-template diff' | 'project-template apply' | 'project-template update',
  mode: 'dry-run' | 'apply',
  result: Parameters<typeof createProjectTemplateCliSuccess>[0]['result'],
): ProjectTemplateCliOutcome {
  return {
    envelope: createProjectTemplateCliSuccess({ command, mode, result } as
      Parameters<typeof createProjectTemplateCliSuccess>[0]),
    exitCode: 0,
  };
}

function review(plan: ProjectTemplateCliRemoteDerivedPlan): {
  readiness: 'ready' | 'review-required' | 'blocked';
  reviewCodes: readonly ProjectTemplateCliReviewCode[];
} {
  if (plan.hardConflict) return { readiness: 'blocked', reviewCodes: ['HARD_CONFLICT'] };
  if (!plan.defaultApplyPossible && !plan.reviewRequired) {
    return { readiness: 'blocked', reviewCodes: ['REVIEW_REQUIRED'] };
  }
  if (plan.reviewRequired) {
    return { readiness: 'review-required', reviewCodes: ['REVIEW_REQUIRED'] };
  }
  return { readiness: 'ready', reviewCodes: [] };
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number'
    && value >= 0 && value <= MAX_COUNT;
}

function snapshotPlan(value: ProjectTemplateCliRemoteDerivedPlan): ProjectTemplateCliRemoteDerivedPlan {
  if (typeof value !== 'object' || value === null || CAPTURED_IS_PROXY(value)
    || CAPTURED_REFLECT_APPLY(CAPTURED_GET_PROTOTYPE_OF, Object, [value])
      !== CAPTURED_OBJECT_PROTOTYPE) {
    throw new ProjectTemplateCliRemotePortError('INTERNAL');
  }
  const keys = [
    'transactionPlanId', 'changeCount', 'conflictCount', 'dependencyCount',
    'updateAvailable', 'reviewRequired', 'hardConflict', 'defaultApplyPossible',
    'forceApplicable', 'authority',
  ] as const;
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value],
  ) as Record<string, PropertyDescriptor>;
  const ownKeys = CAPTURED_REFLECT_APPLY(CAPTURED_OWN_KEYS, Reflect, [descriptors]) as PropertyKey[];
  if (ownKeys.length !== keys.length) {
    throw new ProjectTemplateCliRemotePortError('INTERNAL');
  }
  const plan = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE, Object, [null],
  ) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new ProjectTemplateCliRemotePortError('INTERNAL');
    }
    plan[key] = descriptor.value;
  }
  if (typeof plan.transactionPlanId !== 'string'
    || !testPattern(SHA256, plan.transactionPlanId)
    || !count(plan.changeCount) || !count(plan.conflictCount) || !count(plan.dependencyCount)
    || typeof plan.updateAvailable !== 'boolean'
    || typeof plan.reviewRequired !== 'boolean'
    || typeof plan.hardConflict !== 'boolean'
    || typeof plan.defaultApplyPossible !== 'boolean'
    || typeof plan.forceApplicable !== 'boolean'
    || (typeof plan.authority !== 'object' && typeof plan.authority !== 'function')
    || plan.authority === null || CAPTURED_IS_PROXY(plan.authority)
  ) throw new ProjectTemplateCliRemotePortError('INTERNAL');
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE, Object, [plan],
  ) as unknown as ProjectTemplateCliRemoteDerivedPlan;
}

function guardCode(blocks: readonly { readonly code: string }[]): ProjectTemplateCliErrorCode {
  let recoveryRequired = false;
  let activeRun = false;
  let securityGuard = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const code = blocks[index]?.code;
    // Why: an unreadable recovery marker is at least as severe as a confirmed
    // marker. Preserve the recovery-required exit category instead of hiding
    // operator action behind the generic coordination guard.
    if (code === 'RECOVERY_REQUIRED' || code === 'RECOVERY_REQUIRED_UNKNOWN') {
      recoveryRequired = true;
    }
    if (code === 'ACTIVE_RUN') activeRun = true;
    if (code === 'SECURITY_GUARD') securityGuard = true;
  }
  if (recoveryRequired) return 'RECOVERY_REQUIRED';
  if (activeRun) return 'ACTIVE_RUN';
  if (securityGuard) return 'SECURITY_GUARD';
  return 'APPLY_GUARD_BLOCKED';
}

function portFailure(error: unknown): ProjectTemplateCliErrorCode {
  if (!(error instanceof ProjectTemplateCliRemotePortError)) return 'INTERNAL';
  switch (error.code) {
    case 'AUTH_FAILED': case 'NETWORK_FAILED': case 'SOURCE_INTEGRITY_FAILED':
    case 'SOURCE_UNAVAILABLE': case 'SECURITY_GUARD': case 'APPLY_GUARD_BLOCKED':
    case 'APPLY_LEASE_UNAVAILABLE': case 'RECOVERY_REQUIRED':
    case 'RESULT_INDETERMINATE': return error.code;
    default: return 'INTERNAL';
  }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function snapshotPort(value: unknown): ProjectTemplateCliRemoteApplyPort {
  if (typeof value !== 'object' || value === null || CAPTURED_IS_PROXY(value)
    || CAPTURED_REFLECT_APPLY(CAPTURED_GET_PROTOTYPE_OF, Object, [value])
      !== CAPTURED_OBJECT_PROTOTYPE) {
    throw new TypeError('remote apply port is invalid');
  }
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value],
  ) as Record<string, PropertyDescriptor>;
  const keys = ['inspectGuard', 'derive', 'execute'] as const;
  if ((CAPTURED_REFLECT_APPLY(CAPTURED_OWN_KEYS, Reflect, [descriptors]) as PropertyKey[]).length
    !== keys.length) {
    throw new TypeError('remote apply port is invalid');
  }
  const methods = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE, Object, [null],
  ) as Record<string, (...args: never[]) => unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)
      || typeof descriptor.value !== 'function' || CAPTURED_IS_PROXY(descriptor.value)) {
      throw new TypeError('remote apply port is invalid');
    }
    methods[key] = descriptor.value as (...args: never[]) => unknown;
  }
  return CAPTURED_REFLECT_APPLY(CAPTURED_OBJECT_FREEZE, Object, [{
    inspectGuard: methods['inspectGuard']!.bind(value),
    derive: methods['derive']!.bind(value),
    execute: methods['execute']!.bind(value),
  }]) as unknown as ProjectTemplateCliRemoteApplyPort;
}

function validBase(options: ProjectTemplateCliRemoteBaseOptions): boolean {
  return typeof options.cwd === 'string' && options.cwd.length > 0
    && typeof options.source === 'string' && options.source.length > 0
    && options.source.length <= 2_048
    && typeof options.currentTaktVersion === 'string'
    && options.currentTaktVersion.length > 0
    && (options.baselineStrategy === 'conflict'
      || options.baselineStrategy === 'adopt-identical')
    && typeof options.force === 'boolean'
    && (options.signal === undefined || options.signal instanceof AbortSignal);
}

function snapshotOptions(
  value: unknown,
  mutation: boolean,
): ProjectTemplateCliRemoteBaseOptions | ProjectTemplateCliRemoteMutationOptions | undefined {
  let snapshot: Readonly<Record<string, unknown>>;
  try {
    const mode = mutation ? requestedMode(value) : 'dry-run';
    snapshot = snapshotProjectTemplateCliOwnData(value,
      mutation
        ? mode === 'apply'
          ? ['cwd', 'source', 'currentTaktVersion', 'baselineStrategy', 'force', 'mode',
            'expectedPlanId', 'admitMutation']
          : ['cwd', 'source', 'currentTaktVersion', 'baselineStrategy', 'force', 'mode']
        : ['cwd', 'source', 'currentTaktVersion', 'baselineStrategy', 'force'],
      ['signal']);
  } catch {
    return undefined;
  }
  const mode = snapshot['mode'];
  const base = {
    cwd: snapshot['cwd'], source: snapshot['source'],
    currentTaktVersion: snapshot['currentTaktVersion'],
    baselineStrategy: snapshot['baselineStrategy'], force: snapshot['force'],
    ...(snapshot['signal'] === undefined ? {} : { signal: snapshot['signal'] }),
  } as ProjectTemplateCliRemoteBaseOptions;
  if (!validBase(base)) return undefined;
  if (!mutation) return Object.freeze(base);
  if (mode === 'dry-run') return Object.freeze({ ...base, mode: 'dry-run' as const });
  if (mode === 'apply' && typeof snapshot['expectedPlanId'] === 'string') {
    return Object.freeze({ ...base, mode: 'apply' as const,
      expectedPlanId: snapshot['expectedPlanId'], admitMutation: snapshot['admitMutation'] as ProjectTemplateCliMutationAdmission });
  }
  return undefined;
}

function requestedMode(value: unknown): 'dry-run' | 'apply' {
  if (typeof value !== 'object' || value === null || CAPTURED_IS_PROXY(value)) return 'dry-run';
  const descriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_GET_OWN_PROPERTY_DESCRIPTOR, Object, [value, 'mode'],
  ) as PropertyDescriptor | undefined;
  return descriptor !== undefined && 'value' in descriptor && descriptor.value === 'apply'
    ? 'apply' : 'dry-run';
}

export function createProjectTemplateCliRemoteApplyService(
  port: ProjectTemplateCliRemoteApplyPort,
): ProjectTemplateCliRemoteApplyService {
  const trusted = snapshotPort(port);

  const derive = async (
    options: ProjectTemplateCliRemoteBaseOptions,
    command: 'project-template diff' | 'project-template apply' | 'project-template update',
    mode: 'dry-run' | 'apply',
  ): Promise<ProjectTemplateCliRemoteDerivedPlan | ProjectTemplateCliOutcome> => {
    if (aborted(options.signal)) return failure(command, mode, 'INTERRUPTED');
    const cwd = resolve(options.cwd);
    const guard = trusted.inspectGuard(cwd);
    if (!guard.passed) return failure(command, mode, guardCode(guard.blocks));
    try {
      const plan = snapshotPlan(await trusted.derive({
        cwd,
        source: options.source,
        currentTaktVersion: options.currentTaktVersion,
        baselineStrategy: options.baselineStrategy,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }));
      if (aborted(options.signal)) return failure(command, mode, 'INTERRUPTED');
      return plan;
    } catch (error) {
      if (aborted(options.signal)) return failure(command, mode, 'INTERRUPTED');
      return failure(command, mode, portFailure(error));
    }
  };

  const dry = async (
    command: 'project-template diff' | 'project-template apply' | 'project-template update',
    options: ProjectTemplateCliRemoteBaseOptions,
  ): Promise<ProjectTemplateCliOutcome> => {
    if (!validBase(options)) return failure(command, 'dry-run', 'INVALID_ARGUMENT');
    const derived = await derive(options, command, 'dry-run');
    if ('envelope' in derived) return derived;
    const summary = review(derived);
    if (command === 'project-template update') return success(command, 'dry-run', {
      planId: derived.transactionPlanId,
      updateAvailable: derived.updateAvailable,
      dependencyCount: derived.dependencyCount,
      ...summary,
    });
    return success(command, 'dry-run', {
      planId: derived.transactionPlanId,
      changeCount: derived.changeCount,
      conflictCount: derived.conflictCount,
      dependencyCount: derived.dependencyCount,
      ...summary,
    });
  };

  const mutate = async (
    command: 'project-template apply' | 'project-template update',
    options: Extract<ProjectTemplateCliRemoteMutationOptions, { mode: 'apply' }>,
  ): Promise<ProjectTemplateCliOutcome> => {
    if (!validBase(options)) return failure(command, 'apply', 'INVALID_ARGUMENT');
    if (!testPattern(SHA256, options.expectedPlanId)) return failure(command, 'apply', 'INVALID_EXPECTED_PLAN_ID');
    const derived = await derive(options, command, 'apply');
    if ('envelope' in derived) return derived;
    if (derived.transactionPlanId !== options.expectedPlanId) return failure(command, 'apply', 'PLAN_DRIFT');
    if (derived.hardConflict || derived.conflictCount > 0) {
      return failure(command, 'apply', 'HARD_CONFLICT');
    }
    if (!derived.defaultApplyPossible && !derived.reviewRequired) {
      return failure(command, 'apply', 'SECURITY_GUARD');
    }
    if (command === 'project-template update' && !derived.updateAvailable) {
      return failure(command, 'apply', 'PLAN_DRIFT');
    }
    if (derived.reviewRequired && !derived.forceApplicable) {
      return failure(command, 'apply', 'REVIEW_REQUIRED');
    }
    if (derived.reviewRequired && !options.force) {
      return failure(command, 'apply', 'APPROVAL_REQUIRED');
    }
    try {
      consumeProjectTemplateCliMutationAdmission(options.admitMutation);
    } catch (error) {
      return failure(command, 'apply', aborted(options.signal) ? 'INTERRUPTED'
        : error instanceof ProjectTemplateCliInvalidAdmission ? 'SECURITY_GUARD' : 'INTERNAL');
    }
    try {
      // Cancellation is intentionally not forwarded after this admission
      // boundary. The trusted port must drain commit/rollback/recovery.
      const result = await trusted.execute({
        cwd: resolve(options.cwd), source: options.source,
        currentTaktVersion: options.currentTaktVersion,
        baselineStrategy: options.baselineStrategy,
        expectedTransactionPlanId: options.expectedPlanId,
        force: options.force,
        derived,
      });
      if (result.status === 'indeterminate') return failure(command, 'apply', 'RESULT_INDETERMINATE');
      if (result.status === 'recovery_required') return failure(command, 'apply', 'RECOVERY_REQUIRED');
      if (result.status === 'not_started') {
        const code = result.code === 'TRANSACTION_PLAN_MISMATCH'
          ? 'TRANSACTION_PLAN_MISMATCH'
          : result.code;
        return failure(command, 'apply', code);
      }
      if (result.transactionPlanId !== options.expectedPlanId
        || !testPattern(SAFE_ID, result.backupId)) return failure(command, 'apply', 'RESULT_INDETERMINATE');
      return success(command, 'apply', command === 'project-template update'
        ? { planId: result.transactionPlanId, updated: true, backupId: result.backupId, recoveryState: 'clean' }
        : { planId: result.transactionPlanId, applied: true, backupId: result.backupId, recoveryState: 'clean' });
    } catch (error) {
      return failure(command, 'apply', error instanceof ProjectTemplateCliRemotePortError
        ? portFailure(error) : 'RESULT_INDETERMINATE');
    }
  };

  return Object.freeze({
    async diff(value: ProjectTemplateCliRemoteBaseOptions) {
      const options = snapshotOptions(value, false) as ProjectTemplateCliRemoteBaseOptions | undefined;
      return options === undefined
        ? failure('project-template diff', 'dry-run', 'INVALID_ARGUMENT')
        : await dry('project-template diff', options);
    },
    async apply(value: ProjectTemplateCliRemoteMutationOptions) {
      const options = snapshotOptions(value, true) as ProjectTemplateCliRemoteMutationOptions | undefined;
      if (options === undefined) {
        const mode = requestedMode(value);
        return failure('project-template apply', mode,
          mode === 'apply' ? 'SECURITY_GUARD' : 'INVALID_ARGUMENT');
      }
      return options.mode === 'dry-run'
        ? await dry('project-template apply', options)
        : await mutate('project-template apply', options);
    },
    async update(value: ProjectTemplateCliRemoteMutationOptions) {
      const options = snapshotOptions(value, true) as ProjectTemplateCliRemoteMutationOptions | undefined;
      if (options === undefined) {
        const mode = requestedMode(value);
        return failure('project-template update', mode,
          mode === 'apply' ? 'SECURITY_GUARD' : 'INVALID_ARGUMENT');
      }
      return options.mode === 'dry-run'
        ? await dry('project-template update', options)
        : await mutate('project-template update', options);
    },
  });
}
