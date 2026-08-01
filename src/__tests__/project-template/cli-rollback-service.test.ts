import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTemplateCliRollbackService,
  type ProjectTemplateCliRollbackPort,
} from '../../features/project-template/cli-rollback-service.js';
import { settleProjectTemplateRollbackAfterLease } from '../../features/project-template/rollback-transaction-apply-facade.js';

const planId = 'a'.repeat(64);
const derived = Object.freeze({
  planId,
  backupId: 'backup-1',
  recoveryRequired: false,
  authority: Object.freeze({}),
});

function port(overrides: Partial<ProjectTemplateCliRollbackPort> = {}): ProjectTemplateCliRollbackPort {
  return {
    inspectGuard: () => ({ passed: true, blocks: [] }),
    derive: vi.fn(async () => derived),
    execute: vi.fn(async () => ({ status: 'rolled_back', backupId: 'backup-1' })),
    ...overrides,
  };
}

describe('project template CLI rollback service', () => {
  it('admits exact-once and drains rollback without forwarding the signal', async () => {
    const controller = new AbortController();
    const admitMutation = vi.fn(() => controller.abort());
    const execute = vi.fn(async () => ({ status: 'rolled_back' as const, backupId: 'backup-1' }));
    const service = createProjectTemplateCliRollbackService(port({ execute }));
    await service.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: false, mode: 'apply',
      expectedPlanId: planId, signal: controller.signal, admitMutation,
    });
    expect(admitMutation).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).not.toHaveProperty('signal');
  });
  it('classifies lease release failure as indeterminate', () => {
    expect(settleProjectTemplateRollbackAfterLease(
      { status: 'rolled_back', backupId: 'backup-1' },
      () => { throw new Error('release failed'); },
    )).toEqual({ status: 'indeterminate' });
  });
  it('returns only the closed dry-run contract', async () => {
    const service = createProjectTemplateCliRollbackService(port());
    const outcome = await service.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: false, mode: 'dry-run',
    });
    expect(outcome.envelope).toMatchObject({
      status: 'success', command: 'project-template rollback', mode: 'dry-run',
      result: { planId, recoveryState: 'clean', readiness: 'ready', reviewCodes: [] },
    });
    expect(JSON.stringify(outcome)).not.toContain('authority');
  });

  it('requires the caller expected plan before mutation admission', async () => {
    const value = port();
    const service = createProjectTemplateCliRollbackService(value);
    const outcome = await service.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: true, mode: 'apply',
      expectedPlanId: 'b'.repeat(64),
    });
    expect(outcome.envelope).toMatchObject({ status: 'error', error: { code: 'PLAN_DRIFT' } });
    expect(value.execute).not.toHaveBeenCalled();
  });

  it('drains an admitted rollback and returns its exact backup', async () => {
    const value = port();
    const service = createProjectTemplateCliRollbackService(value);
    const outcome = await service.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: false, mode: 'apply',
      expectedPlanId: planId,
    });
    expect(value.execute).toHaveBeenCalledOnce();
    expect(outcome.envelope).toMatchObject({
      status: 'success', mode: 'apply',
      result: { planId, rolledBack: true, backupId: 'backup-1', recoveryState: 'clean' },
    });
  });

  it('maps pre-admission abort and indeterminate terminal state', async () => {
    const controller = new AbortController();
    controller.abort();
    const value = port();
    const service = createProjectTemplateCliRollbackService(value);
    const interrupted = await service.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: false, mode: 'dry-run',
      signal: controller.signal,
    });
    expect(interrupted.exitCode).toBe(130);
    expect(value.derive).not.toHaveBeenCalled();

    const uncertain = createProjectTemplateCliRollbackService(port({
      execute: async () => ({ status: 'indeterminate' }),
    }));
    const outcome = await uncertain.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: false, mode: 'apply',
      expectedPlanId: planId,
    });
    expect(outcome.envelope).toMatchObject({
      status: 'error', error: { code: 'RESULT_INDETERMINATE' },
    });
  });

  it('does not let force bypass recovery or active-runtime guards', async () => {
    const value = port({
      inspectGuard: () => ({ passed: false, blocks: [{ code: 'ACTIVE_RUN' }] }),
    });
    const service = createProjectTemplateCliRollbackService(value);
    const outcome = await service.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: true, mode: 'apply',
      expectedPlanId: planId,
    });
    expect(outcome.envelope).toMatchObject({ status: 'error', error: { code: 'ACTIVE_RUN' } });
    expect(value.derive).not.toHaveBeenCalled();
  });

  it('reports an active run as blocked without inventing recovery state', async () => {
    const service = createProjectTemplateCliRollbackService(port({
      inspectGuard: () => ({ passed: false, blocks: [{ code: 'ACTIVE_RUN' }] }),
    }));
    const outcome = await service.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: false, mode: 'dry-run',
    });
    expect(outcome.envelope).toMatchObject({
      status: 'success',
      result: { readiness: 'blocked', recoveryState: 'clean', reviewCodes: ['ACTIVE_RUN'] },
    });
  });
});
