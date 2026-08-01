import { resolve } from 'node:path';
import {
  createProjectTemplateCliFailure,
  createProjectTemplateCliSuccess,
  projectTemplateCliExitCodeForErrorCode,
  type ProjectTemplateCliErrorCode,
  type ProjectTemplateCliOutcome,
} from './cli-machine-contract.js';
import { createProductionProjectTemplateCliRollbackPort } from './rollback-transaction-apply-facade.js';

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface ProjectTemplateCliRollbackDerivedPlan {
  readonly planId: string;
  readonly backupId: string;
  readonly recoveryRequired: boolean;
  readonly authority: unknown;
}

export type ProjectTemplateCliRollbackExecutionResult =
  | { readonly status: 'rolled_back'; readonly backupId: string }
  | { readonly status: 'recovery_required'; readonly backupId?: string }
  | { readonly status: 'not_started'; readonly code: string }
  | { readonly status: 'indeterminate' };

export interface ProjectTemplateCliRollbackPort {
  readonly inspectGuard: (cwd: string) => {
    readonly passed: boolean;
    readonly blocks: readonly { readonly code: string }[];
  };
  readonly derive: (options: {
    readonly cwd: string;
    readonly backupId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ProjectTemplateCliRollbackDerivedPlan>;
  readonly execute: (options: {
    readonly cwd: string;
    readonly expectedPlanId: string;
    readonly derived: ProjectTemplateCliRollbackDerivedPlan;
    readonly signal?: AbortSignal;
  }) => Promise<ProjectTemplateCliRollbackExecutionResult>;
}

export type ProjectTemplateCliRollbackOptions = {
  readonly cwd: string;
  readonly backupId: string;
  readonly force: boolean;
  readonly signal?: AbortSignal;
} & (
  | { readonly mode: 'dry-run' }
  | { readonly mode: 'apply'; readonly expectedPlanId: string }
);

export interface ProjectTemplateCliRollbackService {
  rollback(options: ProjectTemplateCliRollbackOptions): Promise<ProjectTemplateCliOutcome>;
}

function failure(
  mode: 'dry-run' | 'apply',
  code: ProjectTemplateCliErrorCode,
): ProjectTemplateCliOutcome {
  return {
    envelope: createProjectTemplateCliFailure({
      command: 'project-template rollback', mode, code,
    }),
    exitCode: projectTemplateCliExitCodeForErrorCode(code),
  };
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function guardCode(report: ReturnType<ProjectTemplateCliRollbackPort['inspectGuard']>):
ProjectTemplateCliErrorCode | undefined {
  if (report.passed) return undefined;
  const codes = report.blocks.map(({ code }) => code);
  if (codes.includes('RECOVERY_REQUIRED') || codes.includes('RECOVERY_REQUIRED_UNKNOWN')) {
    return 'RECOVERY_REQUIRED';
  }
  if (codes.includes('ACTIVE_RUN') || codes.includes('PERSONAL_DAEMON_RUNNING')) {
    return 'ACTIVE_RUN';
  }
  if (codes.includes('APPLY_LEASE_PRESENT') || codes.includes('APPLY_LEASE_UNKNOWN')) {
    return 'LEASE_UNAVAILABLE';
  }
  return 'SECURITY_GUARD';
}

function safePlan(value: ProjectTemplateCliRollbackDerivedPlan):
ProjectTemplateCliRollbackDerivedPlan {
  if (!HASH.test(value.planId) || !SAFE_ID.test(value.backupId)
    || typeof value.recoveryRequired !== 'boolean') throw new Error('invalid rollback plan');
  return Object.freeze({
    planId: value.planId,
    backupId: value.backupId,
    recoveryRequired: value.recoveryRequired,
    authority: value.authority,
  });
}

function executionCode(code: string): ProjectTemplateCliErrorCode {
  if (code === 'ROLLBACK_DRIFT' || code === 'TARGET_DRIFT') return 'TARGET_DRIFT';
  if (code === 'BACKUP_UNAVAILABLE') return 'BACKUP_UNAVAILABLE';
  if (code === 'INTERRUPTED') return 'INTERRUPTED';
  if (code === 'APPLY_LEASE_UNAVAILABLE' || code === 'LEASE_UNAVAILABLE') {
    return 'LEASE_UNAVAILABLE';
  }
  if (code === 'APPLY_GUARD_BLOCKED') return 'APPLY_GUARD_BLOCKED';
  return 'SECURITY_GUARD';
}

export function createProjectTemplateCliRollbackService(
  port: ProjectTemplateCliRollbackPort,
): ProjectTemplateCliRollbackService {
  return Object.freeze({
    async rollback(options: ProjectTemplateCliRollbackOptions): Promise<ProjectTemplateCliOutcome> {
      const mode = options.mode;
      if (aborted(options.signal)) return failure(mode, 'INTERRUPTED');
      const cwd = resolve(options.cwd);
      if (!SAFE_ID.test(options.backupId)) return failure(mode, 'INVALID_ARGUMENT');
      const initialGuard = guardCode(port.inspectGuard(cwd));
      if (mode === 'apply' && initialGuard !== undefined) return failure(mode, initialGuard);
      let plan: ProjectTemplateCliRollbackDerivedPlan;
      try {
        plan = safePlan(await port.derive({
          cwd,
          backupId: options.backupId,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }));
      } catch {
        return failure(
          mode,
          aborted(options.signal) ? 'INTERRUPTED' : 'BACKUP_UNAVAILABLE',
        );
      }
      if (mode === 'dry-run') {
        const recoveryState = plan.recoveryRequired
          ? 'recovery-required' as const : 'clean' as const;
        const readiness = plan.recoveryRequired || initialGuard !== undefined
          ? 'recovery-required' as const : 'ready' as const;
        const reviewCodes = readiness === 'recovery-required'
          ? ['RECOVERY_REQUIRED'] as const : [] as const;
        return {
          envelope: createProjectTemplateCliSuccess({
            command: 'project-template rollback', mode: 'dry-run',
            result: { planId: plan.planId, recoveryState, readiness, reviewCodes },
          }),
          exitCode: 0,
        };
      }
      if (options.expectedPlanId !== plan.planId) return failure(mode, 'PLAN_DRIFT');
      if (aborted(options.signal)) return failure(mode, 'INTERRUPTED');
      const finalGuard = guardCode(port.inspectGuard(cwd));
      if (finalGuard !== undefined) return failure(mode, finalGuard);
      let executed: ProjectTemplateCliRollbackExecutionResult;
      try {
        // Once admitted, always await the core's terminal rollback/recovery result.
        executed = await port.execute({
          cwd,
          expectedPlanId: plan.planId,
          derived: plan,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch {
        return failure(mode, 'RESULT_INDETERMINATE');
      }
      if (executed.status === 'indeterminate') return failure(mode, 'RESULT_INDETERMINATE');
      if (executed.status === 'recovery_required') return failure(mode, 'RECOVERY_REQUIRED');
      if (executed.status === 'not_started') return failure(mode, executionCode(executed.code));
      if (executed.backupId !== plan.backupId) return failure(mode, 'RESULT_INDETERMINATE');
      return {
        envelope: createProjectTemplateCliSuccess({
          command: 'project-template rollback', mode: 'apply',
          result: {
            planId: plan.planId,
            rolledBack: true,
            backupId: plan.backupId,
            recoveryState: 'clean',
          },
        }),
        exitCode: 0,
      };
    },
  });
}

export function createProductionProjectTemplateCliRollbackService():
ProjectTemplateCliRollbackService {
  return createProjectTemplateCliRollbackService(
    createProductionProjectTemplateCliRollbackPort(),
  );
}
