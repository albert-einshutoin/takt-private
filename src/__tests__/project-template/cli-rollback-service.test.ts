import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTemplateCliRollbackService as createCoreService,
  type ProjectTemplateCliRollbackPort,
} from '../../features/project-template/cli-rollback-service.js';
import { settleProjectTemplateRollbackAfterLease } from '../../features/project-template/rollback-transaction-apply-facade.js';
import { startProjectTemplateCliLifecycle } from '../../features/project-template/cli-lifecycle.js';

const planId = 'a'.repeat(64);

function createProjectTemplateCliRollbackService(value: ProjectTemplateCliRollbackPort) {
  const core = createCoreService(value);
  return { rollback(options: Parameters<typeof core.rollback>[0]) {
    if (options.mode === 'dry-run') return core.rollback(options);
    return startProjectTemplateCliLifecycle({
      command: 'project-template rollback', mode: 'apply', dispose: () => undefined,
      handle: ({ admitMutation, signal }) => core.rollback({ ...options, signal, admitMutation }),
    }).result;
  } };
}
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
  it('rejects missing, accessor, and proxied admission inputs before execute', async () => {
    const execute = vi.fn(port().execute);
    const service = createCoreService(port({ execute }));
    const base = { cwd: '/safe/repo', backupId: 'backup-1', force: false,
      mode: 'apply' as const, expectedPlanId: planId };
    await expect(service.rollback(base)).resolves.toMatchObject({
      envelope: { error: { code: 'SECURITY_GUARD' } },
    });
    const forceGetter = vi.fn(() => false);
    await expect(service.rollback(Object.defineProperty({ ...base }, 'force', { get: forceGetter }) as never))
      .resolves.toMatchObject({ envelope: { error: { code: 'SECURITY_GUARD' } } });
    await expect(service.rollback(new Proxy(base, {}) as never))
      .resolves.toMatchObject({ envelope: { error: { code: 'SECURITY_GUARD' } } });
    expect(forceGetter).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('admits exact-once and drains rollback without forwarding the signal', async () => {
    const controller = new AbortController();
    const admitMutation = vi.fn(() => controller.abort());
    const execute = vi.fn(async () => ({ status: 'rolled_back' as const, backupId: 'backup-1' }));
    const service = createProjectTemplateCliRollbackService(port({ execute }));
    await service.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: false, mode: 'apply',
      expectedPlanId: planId, signal: controller.signal, admitMutation,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).not.toHaveProperty('signal');
  });
  it('rejects arbitrary admission before rollback execution', async () => {
    const controller = new AbortController();
    const execute = vi.fn();
    const service = createCoreService(port({ execute }));
    const outcome = await service.rollback({ cwd: '/safe/repo', backupId: 'backup-1', force: false,
      mode: 'apply', expectedPlanId: planId, signal: controller.signal,
      admitMutation() { controller.abort(); throw new Error('interrupt'); } });
    expect(outcome).toMatchObject({ exitCode: 23, envelope: { error: { code: 'SECURITY_GUARD' } } });
    expect(execute).not.toHaveBeenCalled();
    const generic = await service.rollback({ cwd: '/safe/repo', backupId: 'backup-1', force: false,
      mode: 'apply', expectedPlanId: planId,
      admitMutation() { throw new Error('failed'); } });
    expect(generic).toMatchObject({ exitCode: 23, envelope: { error: { code: 'SECURITY_GUARD' } } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an invalid plan before admission after global Reflect.apply poisoning', async () => {
    const execute = vi.fn(async () => ({ status: 'rolled_back' as const, backupId: 'unsafe backup/id' }));
    const service = createProjectTemplateCliRollbackService(port({
      derive: async () => ({
        ...derived,
        planId: 'not-a-sha256',
        backupId: 'unsafe backup/id',
      }),
      execute,
    }));
    const originalReflectApply = Reflect.apply;
    let outcome: Awaited<ReturnType<typeof service.rollback>> | undefined;
    try {
      Reflect.apply = (() => true) as typeof Reflect.apply;
      outcome = await service.rollback({
        cwd: '/safe/repo', backupId: 'backup-1', force: false, mode: 'apply',
        expectedPlanId: 'not-a-sha256',
      });
    } finally {
      Reflect.apply = originalReflectApply;
    }

    expect(outcome).toMatchObject({
      envelope: { status: 'error', error: { code: 'INVALID_EXPECTED_PLAN_ID' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it('classifies lease release failure as indeterminate', () => {
    expect(settleProjectTemplateRollbackAfterLease(
      { status: 'rolled_back', backupId: 'backup-1' },
      () => { throw new Error('release failed'); },
    )).toEqual({ status: 'indeterminate' });
  });
  it('returns only the closed dry-run contract', async () => {
    const admitMutation = vi.fn();
    const service = createProjectTemplateCliRollbackService(port());
    const outcome = await service.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: false, mode: 'dry-run', admitMutation,
    });
    expect(outcome.envelope).toMatchObject({
      status: 'success', command: 'project-template rollback', mode: 'dry-run',
      result: { planId, recoveryState: 'clean', readiness: 'ready', reviewCodes: [] },
    });
    expect(JSON.stringify(outcome)).not.toContain('authority');
    expect(admitMutation).not.toHaveBeenCalled();
  });

  it('requires the caller expected plan before mutation admission', async () => {
    const admitMutation = vi.fn();
    const value = port();
    const service = createProjectTemplateCliRollbackService(value);
    const outcome = await service.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: true, mode: 'apply',
      expectedPlanId: 'b'.repeat(64),
      admitMutation,
    });
    expect(outcome.envelope).toMatchObject({ status: 'error', error: { code: 'PLAN_DRIFT' } });
    expect(value.execute).not.toHaveBeenCalled();
    expect(admitMutation).not.toHaveBeenCalled();
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
    const admitMutation = vi.fn();
    const value = port({
      inspectGuard: () => ({ passed: false, blocks: [{ code: 'ACTIVE_RUN' }] }),
    });
    const service = createProjectTemplateCliRollbackService(value);
    const outcome = await service.rollback({
      cwd: '/safe/repo', backupId: 'backup-1', force: true, mode: 'apply',
      expectedPlanId: planId,
      admitMutation,
    });
    expect(outcome.envelope).toMatchObject({ status: 'error', error: { code: 'ACTIVE_RUN' } });
    expect(value.derive).not.toHaveBeenCalled();
    expect(admitMutation).not.toHaveBeenCalled();
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
