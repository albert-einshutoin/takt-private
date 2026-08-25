import { inspectProjectTemplateApplyGuard } from './apply-guard.js';
import {
  acquireProjectTemplateApplyLease,
  assertProjectTemplateMutationLeaseOwned,
  type ProjectTemplateMutationLease,
} from './apply-lease.js';
import { openProjectTemplateApplyStorageReadOnly } from './apply-storage.js';
import {
  rollbackOwnedProjectTemplateApply,
  type ProjectTemplateRollbackResult,
} from './apply-executor.js';
import type {
  ProjectTemplateCliRollbackDerivedPlan,
  ProjectTemplateCliRollbackExecutionResult,
  ProjectTemplateCliRollbackPort,
} from './cli-rollback-service.js';
import {
  deriveProjectTemplateRollbackPlan,
  type ProjectTemplateRollbackPlan,
} from './rollback-plan.js';

interface RollbackAuthority {
  readonly cwd: string;
  readonly plan: ProjectTemplateRollbackPlan;
  readonly storage: Awaited<ReturnType<typeof openProjectTemplateApplyStorageReadOnly>>;
  state: 'active' | 'consumed';
}

const AUTHORITIES = new WeakMap<object, RollbackAuthority>();

function guardFailure(
  report: ReturnType<typeof inspectProjectTemplateApplyGuard>,
): ProjectTemplateCliRollbackExecutionResult | undefined {
  if (report.passed) return undefined;
  const codes = report.blocks.map(({ code }) => code);
  if (codes.includes('RECOVERY_REQUIRED') || codes.includes('RECOVERY_REQUIRED_UNKNOWN')) {
    return { status: 'recovery_required' };
  }
  if (codes.includes('APPLY_LEASE_PRESENT') || codes.includes('APPLY_LEASE_UNKNOWN')) {
    return { status: 'not_started', code: 'LEASE_UNAVAILABLE' };
  }
  return { status: 'not_started', code: 'APPLY_GUARD_BLOCKED' };
}

export function settleProjectTemplateRollbackAfterLease(
  result: ProjectTemplateCliRollbackExecutionResult,
  release: () => void,
): ProjectTemplateCliRollbackExecutionResult {
  try {
    release();
    return result;
  } catch {
    return { status: 'indeterminate' };
  }
}

function project(result: ProjectTemplateRollbackResult):
ProjectTemplateCliRollbackExecutionResult {
  if (result.status === 'rolled_back') return result;
  if (result.status === 'indeterminate') return result;
  if (result.status === 'recovery_required') {
    return { status: 'recovery_required', backupId: result.backupId };
  }
  return { status: 'not_started', code: result.code };
}

async function derive(options: {
  readonly cwd: string;
  readonly backupId: string;
  readonly signal?: AbortSignal;
}): Promise<ProjectTemplateCliRollbackDerivedPlan> {
  const storage = await openProjectTemplateApplyStorageReadOnly({ repoPath: options.cwd });
  const plan = await deriveProjectTemplateRollbackPlan({
    storage,
    backupId: options.backupId,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const authority = Object.freeze({ kind: 'project-template-rollback-authority' });
  AUTHORITIES.set(authority, { cwd: options.cwd, storage, plan, state: 'active' });
  return Object.freeze({
    planId: plan.planId,
    backupId: plan.backupId,
    recoveryRequired: false,
    authority,
  });
}

async function execute(options: {
  readonly cwd: string;
  readonly expectedPlanId: string;
  readonly derived: ProjectTemplateCliRollbackDerivedPlan;
  readonly signal?: AbortSignal;
}): Promise<ProjectTemplateCliRollbackExecutionResult> {
  const authority = typeof options.derived.authority === 'object'
    && options.derived.authority !== null
    ? AUTHORITIES.get(options.derived.authority)
    : undefined;
  if (authority === undefined || authority.state !== 'active'
    || authority.cwd !== options.cwd || authority.plan.planId !== options.expectedPlanId) {
    return { status: 'not_started', code: 'SECURITY_GUARD' };
  }
  authority.state = 'consumed';
  const initial = guardFailure(inspectProjectTemplateApplyGuard({ repoPath: options.cwd }));
  if (initial !== undefined) return initial;
  let lease: ReturnType<typeof acquireProjectTemplateApplyLease>;
  try {
    lease = acquireProjectTemplateApplyLease(options.cwd);
  } catch {
    return { status: 'not_started', code: 'LEASE_UNAVAILABLE' };
  }
  let result: ProjectTemplateCliRollbackExecutionResult;
  try {
    assertProjectTemplateMutationLeaseOwned(
      options.cwd,
      lease as ProjectTemplateMutationLease,
    );
    const owned = guardFailure(inspectProjectTemplateApplyGuard({
      repoPath: options.cwd,
      ownedLease: lease,
    }));
    result = owned ?? project(await rollbackOwnedProjectTemplateApply({
      storage: authority.storage,
      lease,
      plan: authority.plan,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
  } catch {
    result = { status: 'indeterminate' };
  }
  return settleProjectTemplateRollbackAfterLease(result, () => lease.release());
}

export function createProductionProjectTemplateCliRollbackPort():
ProjectTemplateCliRollbackPort {
  return Object.freeze({
    inspectGuard: (cwd: string) => inspectProjectTemplateApplyGuard({ repoPath: cwd }),
    derive,
    execute,
  });
}
