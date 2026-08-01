import { resolve } from 'node:path';
import {
  createProjectTemplateCliFailure,
  createProjectTemplateCliSuccess,
  projectTemplateCliExitCodeForErrorCode,
  type ProjectTemplateCliErrorCode,
  type ProjectTemplateCliOutcome,
  type ProjectTemplateCliReviewCode,
} from './cli-machine-contract.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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
  if (plan.reviewRequired) {
    return { readiness: 'review-required', reviewCodes: ['REVIEW_REQUIRED'] };
  }
  return { readiness: 'ready', reviewCodes: [] };
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function snapshotPlan(value: ProjectTemplateCliRemoteDerivedPlan): ProjectTemplateCliRemoteDerivedPlan {
  const plan = { ...value };
  if (!SHA256.test(plan.transactionPlanId)
    || !count(plan.changeCount) || !count(plan.conflictCount) || !count(plan.dependencyCount)
    || typeof plan.updateAvailable !== 'boolean'
    || typeof plan.reviewRequired !== 'boolean'
    || typeof plan.hardConflict !== 'boolean'
    || typeof plan.defaultApplyPossible !== 'boolean'
    || typeof plan.forceApplicable !== 'boolean'
    || plan.authority === undefined
  ) throw new ProjectTemplateCliRemotePortError('INTERNAL');
  return Object.freeze(plan);
}

function guardCode(blocks: readonly { readonly code: string }[]): ProjectTemplateCliErrorCode {
  const codes = new Set(blocks.map((block) => block.code));
  if (codes.has('RECOVERY_REQUIRED')) return 'RECOVERY_REQUIRED';
  if (codes.has('ACTIVE_RUN')) return 'ACTIVE_RUN';
  if (codes.has('SECURITY_GUARD')) return 'SECURITY_GUARD';
  return 'APPLY_GUARD_BLOCKED';
}

function portFailure(error: unknown): ProjectTemplateCliErrorCode {
  return error instanceof ProjectTemplateCliRemotePortError ? error.code : 'INTERNAL';
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createProjectTemplateCliRemoteApplyService(
  port: ProjectTemplateCliRemoteApplyPort,
): ProjectTemplateCliRemoteApplyService {
  const trusted = Object.freeze({
    inspectGuard: port.inspectGuard.bind(port),
    derive: port.derive.bind(port),
    execute: port.execute.bind(port),
  });

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
    if (!SHA256.test(options.expectedPlanId)) return failure(command, 'apply', 'INVALID_EXPECTED_PLAN_ID');
    const derived = await derive(options, command, 'apply');
    if ('envelope' in derived) return derived;
    if (derived.transactionPlanId !== options.expectedPlanId) return failure(command, 'apply', 'PLAN_DRIFT');
    if (derived.hardConflict) return failure(command, 'apply', 'HARD_CONFLICT');
    if (derived.reviewRequired && !(options.force && derived.forceApplicable)) {
      return failure(command, 'apply', 'REVIEW_REQUIRED');
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
        || !SAFE_ID.test(result.backupId)) return failure(command, 'apply', 'RESULT_INDETERMINATE');
      return success(command, 'apply', command === 'project-template update'
        ? { planId: result.transactionPlanId, updated: true, backupId: result.backupId, recoveryState: 'clean' }
        : { planId: result.transactionPlanId, applied: true, backupId: result.backupId, recoveryState: 'clean' });
    } catch (error) {
      return failure(command, 'apply', portFailure(error));
    }
  };

  return Object.freeze({
    diff: (options: ProjectTemplateCliRemoteBaseOptions) => dry('project-template diff', options),
    apply: (options: ProjectTemplateCliRemoteMutationOptions) => options.mode === 'dry-run'
      ? dry('project-template apply', options)
      : mutate('project-template apply', options),
    update: (options: ProjectTemplateCliRemoteMutationOptions) => options.mode === 'dry-run'
      ? dry('project-template update', options)
      : mutate('project-template update', options),
  });
}
