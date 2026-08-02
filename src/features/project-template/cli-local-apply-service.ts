import { resolve } from 'node:path';
import { types } from 'node:util';
import {
  createProductionProjectTemplateCliLocalApplyPort,
} from './local-transaction-apply-facade.js';
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

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  Object.getOwnPropertyDescriptor;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_REGEXP_TEST = RegExp.prototype.test;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;

export interface ProjectTemplateCliLocalDerivedPlan {
  readonly transactionPlanId: string;
  readonly changeCount: number;
  readonly conflictCount: number;
  readonly dependencyCount: number;
  readonly reviewRequired: boolean;
  readonly hardConflict: boolean;
  readonly defaultApplyPossible: boolean;
  /** True only for a core-resolved, non-hard content review decision. */
  readonly forceApplicable: boolean;
  /** Opaque process-local authority retained only for the trusted core port. */
  readonly authority: unknown;
}

export type ProjectTemplateCliLocalExecutionResult =
  | {
    readonly status: 'committed';
    readonly backupId: string;
    readonly transactionPlanId: string;
  }
  | { readonly status: 'recovery_required'; readonly backupId?: string }
  | {
    readonly status: 'not_started';
    readonly code:
      | 'TARGET_DRIFT'
      | 'PLAN_DRIFT'
      | 'BASE_LOCK_DRIFT'
      | 'LEASE_UNAVAILABLE'
      | 'APPLY_GUARD_BLOCKED'
      | 'BACKUP_UNAVAILABLE'
      | 'APPROVAL_REQUIRED'
      | 'APPROVAL_INVALID'
      | 'APPLY_FAILED_ROLLED_BACK'
      | 'SOURCE_INTEGRITY_FAILED'
      | 'INTERRUPTED'
      | 'SECURITY_GUARD';
  }
  | { readonly status: 'indeterminate' };

export interface ProjectTemplateCliLocalApplyPort {
  /** Read-only guard inspection. This must not acquire or repair a lease. */
  readonly inspectGuard: (cwd: string) => {
    readonly passed: boolean;
    readonly blocks: readonly { readonly code: string }[];
  };
  /**
   * Bounded core composition only: materialize archive, read the exact three-
   * lock cohort and baselines, snapshot target, and return a transaction id
   * that seals all of those witnesses.
   */
  readonly derive: (options: {
    readonly cwd: string;
    readonly sourcePath: string;
    readonly currentTaktVersion: string;
    readonly signal?: AbortSignal;
  }) => Promise<ProjectTemplateCliLocalDerivedPlan>;
  /**
   * Mutation admission boundary. The trusted core implementation must acquire
   * the lease, re-derive the exact transaction, issue and consume any internal
   * approval under that authority, invoke the executor, and drain it to a
   * terminal commit/rollback/recovery result before resolving.
   */
  readonly execute: (options: {
    readonly cwd: string;
    readonly sourcePath: string;
    readonly currentTaktVersion: string;
    readonly expectedTransactionPlanId: string;
    readonly force: boolean;
    readonly derived: ProjectTemplateCliLocalDerivedPlan;
    readonly signal?: AbortSignal;
  }) => Promise<ProjectTemplateCliLocalExecutionResult>;
}

export interface ProjectTemplateCliLocalBaseOptions {
  readonly cwd: string;
  readonly sourcePath: string;
  readonly currentTaktVersion: string;
  readonly force: boolean;
  readonly signal?: AbortSignal;
}

export type ProjectTemplateCliLocalApplyOptions =
  | (ProjectTemplateCliLocalBaseOptions & { readonly mode: 'dry-run' })
  | (ProjectTemplateCliLocalBaseOptions & {
    readonly mode: 'apply';
    readonly expectedPlanId: string;
    readonly admitMutation: ProjectTemplateCliMutationAdmission;
  });

export interface ProjectTemplateCliLocalApplyService {
  diff(options: ProjectTemplateCliLocalBaseOptions): Promise<ProjectTemplateCliOutcome>;
  apply(options: ProjectTemplateCliLocalApplyOptions): Promise<ProjectTemplateCliOutcome>;
}

interface SafePort {
  inspectGuard: ProjectTemplateCliLocalApplyPort['inspectGuard'];
  derive: ProjectTemplateCliLocalApplyPort['derive'];
  execute: ProjectTemplateCliLocalApplyPort['execute'];
  receiver: object;
}

function testPattern(pattern: RegExp, value: string): boolean {
  return CAPTURED_REFLECT_APPLY(CAPTURED_REGEXP_TEST, pattern, [value]) as boolean;
}

function snapshotPort(value: unknown): SafePort {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_ARRAY_IS_ARRAY, Array, [value])
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      Object,
      [value],
    ) !== CAPTURED_OBJECT_PROTOTYPE
  ) throw new TypeError('local apply port is invalid');
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    Object,
    [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    Reflect,
    [descriptors],
  ) as PropertyKey[];
  if (keys.length !== 3
    || !keys.includes('inspectGuard') || !keys.includes('derive') || !keys.includes('execute')) {
    throw new TypeError('local apply port is invalid');
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)
      || typeof descriptor.value !== 'function'
      || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [descriptor.value])) {
      throw new TypeError('local apply port is invalid');
    }
  }
  return {
    receiver: value,
    inspectGuard: descriptors['inspectGuard']!.value as SafePort['inspectGuard'],
    derive: descriptors['derive']!.value as SafePort['derive'],
    execute: descriptors['execute']!.value as SafePort['execute'],
  };
}

function failure(
  command: 'project-template diff' | 'project-template apply',
  mode: 'dry-run' | 'apply',
  code: ProjectTemplateCliErrorCode,
): ProjectTemplateCliOutcome {
  const envelope = createProjectTemplateCliFailure({ command, mode, code });
  return { envelope, exitCode: projectTemplateCliExitCodeForErrorCode(code) };
}

function success(
  command: 'project-template diff' | 'project-template apply',
  mode: 'dry-run' | 'apply',
  result: Parameters<typeof createProjectTemplateCliSuccess>[0]['result'],
): ProjectTemplateCliOutcome {
  const envelope = createProjectTemplateCliSuccess({ command, mode, result } as
    Parameters<typeof createProjectTemplateCliSuccess>[0]);
  return { envelope, exitCode: 0 };
}

function active(signal: AbortSignal | undefined): boolean {
  return signal?.aborted !== true;
}

async function awaitActive<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!active(signal)) throw new Error('interrupted');
  const result = await promise;
  if (!active(signal)) throw new Error('interrupted');
  return result;
}

function ownData(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) throw new Error('invalid core result');
  const descriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    Object,
    [value, key],
  ) as PropertyDescriptor | undefined;
  if (descriptor === undefined || !('value' in descriptor)) throw new Error('invalid core result');
  return descriptor.value;
}

function snapshotPlan(value: unknown): ProjectTemplateCliLocalDerivedPlan {
  const transactionPlanId = ownData(value, 'transactionPlanId');
  const changeCount = ownData(value, 'changeCount');
  const conflictCount = ownData(value, 'conflictCount');
  const dependencyCount = ownData(value, 'dependencyCount');
  const reviewRequired = ownData(value, 'reviewRequired');
  const hardConflict = ownData(value, 'hardConflict');
  const defaultApplyPossible = ownData(value, 'defaultApplyPossible');
  const forceApplicable = ownData(value, 'forceApplicable');
  const authority = ownData(value, 'authority');
  if (typeof transactionPlanId !== 'string' || !testPattern(SHA256_PATTERN, transactionPlanId)
    || !CAPTURED_REFLECT_APPLY(CAPTURED_NUMBER_IS_SAFE_INTEGER, Number, [changeCount])
    || !CAPTURED_REFLECT_APPLY(CAPTURED_NUMBER_IS_SAFE_INTEGER, Number, [conflictCount])
    || !CAPTURED_REFLECT_APPLY(CAPTURED_NUMBER_IS_SAFE_INTEGER, Number, [dependencyCount])
    || (changeCount as number) < 0 || (conflictCount as number) < 0
    || (dependencyCount as number) < 0
    || (changeCount as number) > 8_192 || (conflictCount as number) > 8_192
    || (dependencyCount as number) > 128
    || typeof reviewRequired !== 'boolean' || typeof hardConflict !== 'boolean'
    || typeof defaultApplyPossible !== 'boolean' || typeof forceApplicable !== 'boolean') {
    throw new Error('invalid core plan');
  }
  return {
    transactionPlanId,
    changeCount: changeCount as number,
    conflictCount: conflictCount as number,
    dependencyCount: dependencyCount as number,
    reviewRequired,
    hardConflict,
    defaultApplyPossible,
    forceApplicable,
    authority,
  };
}

type ProjectTemplateCliLocalGuardCode =
  | 'ACTIVE_RUN'
  | 'LEASE_UNAVAILABLE'
  | 'RECOVERY_REQUIRED'
  | 'SECURITY_GUARD';

function guardCode(report: ReturnType<ProjectTemplateCliLocalApplyPort['inspectGuard']>):
ProjectTemplateCliLocalGuardCode | undefined {
  if (report.passed) return undefined;
  const codes = report.blocks.map((block) => block.code);
  if (codes.includes('RECOVERY_REQUIRED') || codes.includes('RECOVERY_REQUIRED_UNKNOWN')) {
    return 'RECOVERY_REQUIRED';
  }
  if (
    codes.includes('ACTIVE_RUN')
    || codes.includes('STALE_RUN')
    || codes.includes('PERSONAL_DAEMON_RUNNING')
  ) {
    return 'ACTIVE_RUN';
  }
  if (codes.includes('APPLY_LEASE_PRESENT') || codes.includes('APPLY_LEASE_UNKNOWN')) {
    return 'LEASE_UNAVAILABLE';
  }
  return 'SECURITY_GUARD';
}

function review(plan: ProjectTemplateCliLocalDerivedPlan): {
  readiness: 'ready' | 'review-required' | 'blocked';
  reviewCodes: readonly ProjectTemplateCliReviewCode[];
} {
  if (plan.hardConflict || plan.conflictCount > 0) {
    return { readiness: 'blocked', reviewCodes: ['HARD_CONFLICT'] };
  }
  if (plan.reviewRequired || !plan.defaultApplyPossible) {
    return { readiness: 'review-required', reviewCodes: ['REVIEW_REQUIRED'] };
  }
  return { readiness: 'ready', reviewCodes: [] };
}

function previewOutcome(
  command: 'project-template diff' | 'project-template apply',
  plan: ProjectTemplateCliLocalDerivedPlan,
  guardFailure?: ProjectTemplateCliLocalGuardCode,
): ProjectTemplateCliOutcome {
  if (guardFailure === 'LEASE_UNAVAILABLE' || guardFailure === 'SECURITY_GUARD') {
    return failure(command, 'dry-run', guardFailure);
  }
  const summary = guardFailure === 'RECOVERY_REQUIRED'
    ? { readiness: 'recovery-required' as const, reviewCodes: ['RECOVERY_REQUIRED'] as const }
    : guardFailure === 'ACTIVE_RUN'
      ? { readiness: 'blocked' as const, reviewCodes: ['ACTIVE_RUN'] as const }
      : review(plan);
  return success(command, 'dry-run', {
    planId: plan.transactionPlanId,
    changeCount: plan.changeCount,
    conflictCount: plan.conflictCount,
    dependencyCount: plan.dependencyCount,
    readiness: summary.readiness,
    reviewCodes: summary.reviewCodes,
  });
}

function executionFailure(code: string): ProjectTemplateCliErrorCode {
  if (code === 'PLAN_DRIFT') return 'PLAN_DRIFT';
  if (code === 'TARGET_DRIFT') return 'TARGET_DRIFT';
  if (code === 'BASE_LOCK_DRIFT') return 'BASE_LOCK_DRIFT';
  if (code === 'LEASE_UNAVAILABLE') return 'LEASE_UNAVAILABLE';
  if (code === 'BACKUP_UNAVAILABLE') return 'BACKUP_UNAVAILABLE';
  if (code === 'APPROVAL_REQUIRED' || code === 'APPROVAL_INVALID') return 'APPROVAL_REQUIRED';
  if (code === 'APPLY_FAILED_ROLLED_BACK') return 'APPLY_FAILED_ROLLED_BACK';
  if (code === 'SOURCE_INTEGRITY_FAILED') return 'SOURCE_INTEGRITY_FAILED';
  if (code === 'INTERRUPTED') return 'INTERRUPTED';
  return code === 'APPLY_GUARD_BLOCKED' ? 'APPLY_GUARD_BLOCKED' : 'SECURITY_GUARD';
}

export function createProjectTemplateCliLocalApplyService(
  value: ProjectTemplateCliLocalApplyPort,
): ProjectTemplateCliLocalApplyService {
  const port = snapshotPort(value);
  const derive = async (
    options: ProjectTemplateCliLocalBaseOptions,
  ): Promise<ProjectTemplateCliLocalDerivedPlan> => {
    const cwd = resolve(options.cwd);
    const sourcePath = resolve(cwd, options.sourcePath);
    const derived = await awaitActive(CAPTURED_REFLECT_APPLY(port.derive, port.receiver, [{
      cwd,
      sourcePath,
      currentTaktVersion: options.currentTaktVersion,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }]) as Promise<ProjectTemplateCliLocalDerivedPlan>, options.signal);
    return snapshotPlan(derived);
  };
  return Object.freeze({
    async diff(options: ProjectTemplateCliLocalBaseOptions): Promise<ProjectTemplateCliOutcome> {
      try {
        const cwd = resolve(options.cwd);
        const guard = CAPTURED_REFLECT_APPLY(port.inspectGuard, port.receiver, [cwd]) as
          ReturnType<ProjectTemplateCliLocalApplyPort['inspectGuard']>;
        const plan = await derive(options);
        if (!active(options.signal)) return failure('project-template diff', 'dry-run', 'INTERRUPTED');
        return previewOutcome('project-template diff', plan, guardCode(guard));
      } catch {
        return failure(
          'project-template diff',
          'dry-run',
          active(options.signal) ? 'SOURCE_INTEGRITY_FAILED' : 'INTERRUPTED',
        );
      }
    },
    async apply(options: ProjectTemplateCliLocalApplyOptions): Promise<ProjectTemplateCliOutcome> {
      const requestedMode = typeof options === 'object' && options !== null
        && !CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [options])
        && CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(options, 'mode')?.value === 'apply'
        ? 'apply' as const : 'dry-run' as const;
      let safeOptions: ProjectTemplateCliLocalApplyOptions;
      try {
        const snapshot = snapshotProjectTemplateCliOwnData(options,
          ['cwd', 'sourcePath', 'currentTaktVersion', 'force', 'mode'],
          ['signal', 'expectedPlanId', 'admitMutation']);
        const applyMode = snapshot['mode'] === 'apply';
        if ((!applyMode && snapshot['mode'] !== 'dry-run')
          || (applyMode && (!('expectedPlanId' in snapshot) || !('admitMutation' in snapshot)))
          || (!applyMode && ('expectedPlanId' in snapshot || 'admitMutation' in snapshot))
          || typeof snapshot['cwd'] !== 'string' || typeof snapshot['sourcePath'] !== 'string'
          || typeof snapshot['currentTaktVersion'] !== 'string'
          || typeof snapshot['force'] !== 'boolean'
          || (snapshot['signal'] !== undefined && !(snapshot['signal'] instanceof AbortSignal))) {
          throw new ProjectTemplateCliInvalidAdmission();
        }
        safeOptions = snapshot as unknown as ProjectTemplateCliLocalApplyOptions;
      } catch {
        return failure('project-template apply', requestedMode, 'SECURITY_GUARD');
      }
      options = safeOptions;
      const outputMode = options.mode;
      if (!active(options.signal)) return failure('project-template apply', outputMode, 'INTERRUPTED');
      const cwd = resolve(options.cwd);
      const initialGuard = CAPTURED_REFLECT_APPLY(port.inspectGuard, port.receiver, [cwd]) as
        ReturnType<ProjectTemplateCliLocalApplyPort['inspectGuard']>;
      const initialGuardCode = guardCode(initialGuard);
      if (options.mode === 'apply' && initialGuardCode !== undefined) {
        return failure('project-template apply', 'apply', initialGuardCode);
      }
      let plan: ProjectTemplateCliLocalDerivedPlan;
      try {
        plan = await derive(options);
      } catch {
        return failure(
          'project-template apply',
          outputMode,
          active(options.signal) ? 'SOURCE_INTEGRITY_FAILED' : 'INTERRUPTED',
        );
      }
      if (options.mode === 'dry-run') {
        return previewOutcome('project-template apply', plan, initialGuardCode);
      }
      if (typeof options.expectedPlanId !== 'string') {
        return failure('project-template apply', 'apply', 'MISSING_EXPECTED_PLAN_ID');
      }
      if (options.expectedPlanId !== plan.transactionPlanId) {
        return failure('project-template apply', 'apply', 'PLAN_DRIFT');
      }
      if (plan.hardConflict || plan.conflictCount > 0) {
        return failure('project-template apply', 'apply', 'HARD_CONFLICT');
      }
      if (plan.reviewRequired && !plan.forceApplicable) {
        return failure('project-template apply', 'apply', 'REVIEW_REQUIRED');
      }
      if (plan.reviewRequired && !options.force) {
        return failure('project-template apply', 'apply', 'APPROVAL_REQUIRED');
      }
      if (!plan.defaultApplyPossible && !plan.reviewRequired) {
        return failure('project-template apply', 'apply', 'SECURITY_GUARD');
      }
      if (!active(options.signal)) return failure('project-template apply', 'apply', 'INTERRUPTED');
      const finalGuard = CAPTURED_REFLECT_APPLY(port.inspectGuard, port.receiver, [cwd]) as
        ReturnType<ProjectTemplateCliLocalApplyPort['inspectGuard']>;
      const finalGuardCode = guardCode(finalGuard);
      if (finalGuardCode !== undefined) return failure('project-template apply', 'apply', finalGuardCode);
      if (!active(options.signal)) return failure('project-template apply', 'apply', 'INTERRUPTED');

      // Mutation admission begins inside this one trusted call. Cancellation
      // after it starts must never make the CLI abandon executor recovery.
      try {
        consumeProjectTemplateCliMutationAdmission(options.admitMutation);
      } catch (error) {
        return failure('project-template apply', 'apply',
          !active(options.signal) ? 'INTERRUPTED'
            : error instanceof ProjectTemplateCliInvalidAdmission ? 'SECURITY_GUARD' : 'INTERNAL');
      }
      let executed: ProjectTemplateCliLocalExecutionResult;
      try {
        executed = await (CAPTURED_REFLECT_APPLY(port.execute, port.receiver, [{
          cwd,
          sourcePath: resolve(cwd, options.sourcePath),
          currentTaktVersion: options.currentTaktVersion,
          expectedTransactionPlanId: plan.transactionPlanId,
          force: options.force,
          derived: plan,
        }]) as Promise<ProjectTemplateCliLocalExecutionResult>);
      } catch {
        return failure('project-template apply', 'apply', 'RESULT_INDETERMINATE');
      }
      const status = ownData(executed, 'status');
      if (status === 'recovery_required') {
        return failure('project-template apply', 'apply', 'RECOVERY_REQUIRED');
      }
      if (status === 'indeterminate') {
        return failure('project-template apply', 'apply', 'RESULT_INDETERMINATE');
      }
      if (status === 'not_started') {
        const code = ownData(executed, 'code');
        return failure(
          'project-template apply',
          'apply',
          executionFailure(typeof code === 'string' ? code : 'SECURITY_GUARD'),
        );
      }
      if (status !== 'committed') {
        return failure('project-template apply', 'apply', 'RESULT_INDETERMINATE');
      }
      const backupId = ownData(executed, 'backupId');
      const transactionPlanId = ownData(executed, 'transactionPlanId');
      if (typeof backupId !== 'string' || !testPattern(SAFE_ID_PATTERN, backupId)
        || transactionPlanId !== plan.transactionPlanId) {
        return failure('project-template apply', 'apply', 'RESULT_INDETERMINATE');
      }
      return success('project-template apply', 'apply', {
        planId: plan.transactionPlanId,
        applied: true,
        backupId,
        recoveryState: 'clean',
      });
    },
  });
}

/** Creates the production local CLI service over the trusted transaction port. */
export function createProductionProjectTemplateCliLocalApplyService():
ProjectTemplateCliLocalApplyService {
  return createProjectTemplateCliLocalApplyService(
    createProductionProjectTemplateCliLocalApplyPort(),
  );
}
