import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTemplateCliLocalApplyService as createCoreService,
  type ProjectTemplateCliLocalApplyPort,
} from '../../features/project-template/cli-local-apply-service.js';
import { startProjectTemplateCliLifecycle } from '../../features/project-template/cli-lifecycle.js';

const PLAN_ID = 'a'.repeat(64);

function createProjectTemplateCliLocalApplyService(value: ProjectTemplateCliLocalApplyPort) {
  const core = createCoreService(value);
  return {
    diff: core.diff,
    apply(options: Parameters<typeof core.apply>[0]) {
      if (options.mode === 'dry-run') return core.apply(options);
      return startProjectTemplateCliLifecycle({
        command: 'project-template apply', mode: 'apply', dispose: () => undefined,
        handle: ({ admitMutation, signal }) => core.apply({
          ...options, signal: options.signal ?? signal, admitMutation,
        }),
      }).result;
    },
  };
}

function port(
  overrides: Partial<ProjectTemplateCliLocalApplyPort> = {},
): ProjectTemplateCliLocalApplyPort {
  return {
    inspectGuard: vi.fn(() => ({ passed: true, blocks: [] })),
    derive: vi.fn(async () => ({
      transactionPlanId: PLAN_ID,
      changeCount: 2,
      conflictCount: 0,
      dependencyCount: 0,
      reviewRequired: false,
      hardConflict: false,
      defaultApplyPossible: true,
      forceApplicable: false,
      authority: Object.freeze({ kind: 'test-authority' }),
    })),
    execute: vi.fn(async () => ({
      status: 'committed',
      backupId: 'backup-1',
      transactionPlanId: PLAN_ID,
    })),
    ...overrides,
  };
}

describe('local project-template CLI diff/apply service', () => {
  it('rejects missing, accessor, and proxied admission inputs before execute', async () => {
    const execute = vi.fn(port().execute);
    const service = createCoreService(port({ execute }));
    const base = { cwd: '/safe/repo', sourcePath: 'pack.taktpack', currentTaktVersion: '0.48.0',
      force: false, mode: 'apply' as const, expectedPlanId: PLAN_ID };
    await expect(service.apply(base)).resolves.toMatchObject({
      envelope: { error: { code: 'SECURITY_GUARD' } },
    });
    const forceGetter = vi.fn(() => false);
    await expect(service.apply(Object.defineProperty({ ...base }, 'force', { get: forceGetter }) as never))
      .resolves.toMatchObject({ envelope: { error: { code: 'SECURITY_GUARD' } } });
    await expect(service.apply(new Proxy(base, {}) as never))
      .resolves.toMatchObject({ envelope: { error: { code: 'SECURITY_GUARD' } } });
    expect(forceGetter).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('admits exact-once and drains execution without forwarding the signal', async () => {
    const controller = new AbortController();
    const admitMutation = vi.fn(() => controller.abort());
    const execute = vi.fn(port().execute);
    const service = createProjectTemplateCliLocalApplyService(port({ execute }));
    await service.apply({
      cwd: '/safe/repo', sourcePath: 'pack.taktpack', currentTaktVersion: '0.48.0',
      force: false, mode: 'apply', expectedPlanId: PLAN_ID,
      signal: controller.signal, admitMutation,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).not.toHaveProperty('signal');
  });
  it('rejects an arbitrary admission callback before execute', async () => {
    const controller = new AbortController();
    const execute = vi.fn();
    const service = createCoreService(port({ execute }));
    const outcome = await service.apply({
      cwd: '/safe/repo', sourcePath: 'pack.taktpack', currentTaktVersion: '0.48.0',
      force: false, mode: 'apply', expectedPlanId: PLAN_ID, signal: controller.signal,
      admitMutation() { controller.abort(); throw new Error('interrupt'); },
    });
    expect(outcome).toMatchObject({ exitCode: 23, envelope: { error: { code: 'SECURITY_GUARD' } } });
    expect(execute).not.toHaveBeenCalled();
    const generic = await service.apply({
      cwd: '/safe/repo', sourcePath: 'pack.taktpack', currentTaktVersion: '0.48.0',
      force: false, mode: 'apply', expectedPlanId: PLAN_ID,
      admitMutation() { throw new Error('failed'); },
    });
    expect(generic).toMatchObject({ exitCode: 23, envelope: { error: { code: 'SECURITY_GUARD' } } });
    expect(execute).not.toHaveBeenCalled();
  });
  it('returns the same closed dry-run plan for diff and apply', async () => {
    const service = createProjectTemplateCliLocalApplyService(port());
    const options = {
      cwd: '/safe/repo',
      sourcePath: 'pack.taktpack',
      currentTaktVersion: '0.48.0',
      force: false,
    };

    const diff = await service.diff(options);
    const applyPreview = await service.apply({ ...options, mode: 'dry-run' });

    expect(diff).toMatchObject({
      exitCode: 0,
      envelope: {
        command: 'project-template diff',
        mode: 'dry-run',
        result: {
          planId: PLAN_ID,
          changeCount: 2,
          conflictCount: 0,
          dependencyCount: 0,
          readiness: 'ready',
          reviewCodes: [],
        },
      },
    });
    expect(applyPreview).toMatchObject({
      exitCode: 0,
      envelope: {
        command: 'project-template apply',
        mode: 'dry-run',
        result: diff.envelope.status === 'success' ? diff.envelope.result : undefined,
      },
    });
    expect(JSON.stringify(diff)).not.toContain('authority');
  });

  it.each([
    ['diff', 'APPLY_LEASE_PRESENT', 'LEASE_UNAVAILABLE'],
    ['apply', 'APPLY_LEASE_UNKNOWN', 'LEASE_UNAVAILABLE'],
    ['diff', 'UNRECOGNIZED_SECURITY_BLOCK', 'SECURITY_GUARD'],
    ['apply', 'UNRECOGNIZED_SECURITY_BLOCK', 'SECURITY_GUARD'],
  ] as const)('reports %s guard %s as non-reviewable %s', async (
    command,
    blockCode,
    errorCode,
  ) => {
    const service = createProjectTemplateCliLocalApplyService(port({
      inspectGuard: vi.fn(() => ({ passed: false, blocks: [{ code: blockCode }] })),
    }));
    const options = {
      cwd: '/safe/repo',
      sourcePath: 'pack.taktpack',
      currentTaktVersion: '0.48.0',
      force: false,
    };

    const outcome = command === 'diff'
      ? await service.diff(options)
      : await service.apply({ ...options, mode: 'dry-run' });

    expect(outcome).toMatchObject({
      exitCode: 23,
      envelope: {
        command: `project-template ${command}`,
        status: 'error',
        mode: 'dry-run',
        error: { code: errorCode },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('REVIEW_REQUIRED');
  });

  it('rejects expected-plan drift before mutation admission', async () => {
    const admitMutation = vi.fn();
    const execute = vi.fn();
    const service = createProjectTemplateCliLocalApplyService(port({ execute }));
    const outcome = await service.apply({
      cwd: '/safe/repo',
      sourcePath: 'pack.taktpack',
      currentTaktVersion: '0.48.0',
      mode: 'apply',
      expectedPlanId: 'b'.repeat(64),
      force: false,
      admitMutation,
    });

    expect(outcome).toMatchObject({
      exitCode: 22,
      envelope: { status: 'error', error: { code: 'PLAN_DRIFT' } },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(admitMutation).not.toHaveBeenCalled();
  });

  it('does not let force bypass a hard content conflict', async () => {
    const execute = vi.fn();
    const admitMutation = vi.fn();
    const service = createProjectTemplateCliLocalApplyService(port({
      derive: vi.fn(async () => ({
        transactionPlanId: PLAN_ID,
        changeCount: 1,
        conflictCount: 1,
        dependencyCount: 0,
        reviewRequired: true,
        hardConflict: true,
        defaultApplyPossible: false,
        forceApplicable: false,
        authority: Object.freeze({}),
      })),
      execute,
    }));

    const outcome = await service.apply({
      cwd: '/safe/repo',
      sourcePath: 'pack.taktpack',
      currentTaktVersion: '0.48.0',
      mode: 'apply',
      expectedPlanId: PLAN_ID,
      force: true,
      admitMutation,
    });

    expect(outcome).toMatchObject({
      exitCode: 21,
      envelope: { status: 'error', error: { code: 'HARD_CONFLICT' } },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(admitMutation).not.toHaveBeenCalled();
  });

  it('blocks active-run state before deriving or creating approval state', async () => {
    const derive = vi.fn();
    const execute = vi.fn();
    const service = createProjectTemplateCliLocalApplyService(port({
      inspectGuard: vi.fn(() => ({
        passed: false,
        blocks: [{ code: 'ACTIVE_RUN' }],
      })),
      derive,
      execute,
    }));

    const outcome = await service.apply({
      cwd: '/safe/repo',
      sourcePath: 'pack.taktpack',
      currentTaktVersion: '0.48.0',
      mode: 'apply',
      expectedPlanId: PLAN_ID,
      force: true,
    });

    expect(outcome).toMatchObject({
      exitCode: 23,
      envelope: { status: 'error', error: { code: 'ACTIVE_RUN' } },
    });
    expect(derive).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps pre-admission abort to INTERRUPTED without calling execute', async () => {
    const controller = new AbortController();
    const execute = vi.fn();
    const service = createProjectTemplateCliLocalApplyService(port({
      derive: vi.fn(async () => {
        controller.abort();
        return {
          transactionPlanId: PLAN_ID,
          changeCount: 0,
          conflictCount: 0,
          dependencyCount: 0,
          reviewRequired: false,
          hardConflict: false,
          defaultApplyPossible: true,
          forceApplicable: false,
          authority: Object.freeze({}),
        };
      }),
      execute,
    }));

    const outcome = await service.apply({
      cwd: '/safe/repo',
      sourcePath: 'pack.taktpack',
      currentTaktVersion: '0.48.0',
      mode: 'apply',
      expectedPlanId: PLAN_ID,
      force: false,
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({
      exitCode: 130,
      envelope: { status: 'error', error: { code: 'INTERRUPTED' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('drains admitted execution and reports its terminal recovery state', async () => {
    const controller = new AbortController();
    const service = createProjectTemplateCliLocalApplyService(port({
      execute: vi.fn(async () => {
        controller.abort();
        return { status: 'recovery_required', backupId: 'backup-1' };
      }),
    }));

    const outcome = await service.apply({
      cwd: '/safe/repo',
      sourcePath: 'pack.taktpack',
      currentTaktVersion: '0.48.0',
      mode: 'apply',
      expectedPlanId: PLAN_ID,
      force: false,
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({
      exitCode: 25,
      envelope: { status: 'error', error: { code: 'RECOVERY_REQUIRED' } },
    });
  });

  it.each([
    ['INTERRUPTED', 130],
    ['SOURCE_INTEGRITY_FAILED', 24],
    ['PLAN_DRIFT', 22],
    ['TARGET_DRIFT', 22],
  ] as const)('preserves the closed %s execution result', async (code, exitCode) => {
    const service = createProjectTemplateCliLocalApplyService(port({
      execute: vi.fn(async () => ({ status: 'not_started', code })),
    }));

    const outcome = await service.apply({
      cwd: '/safe/repo',
      sourcePath: 'pack.taktpack',
      currentTaktVersion: '0.48.0',
      mode: 'apply',
      expectedPlanId: PLAN_ID,
      force: false,
    });

    expect(outcome).toMatchObject({
      exitCode,
      envelope: { status: 'error', error: { code } },
    });
  });

  it('returns only closed commit fields from an admitted apply', async () => {
    const service = createProjectTemplateCliLocalApplyService(port({
      execute: vi.fn(async () => ({
        status: 'committed',
        backupId: 'backup-1',
        transactionPlanId: PLAN_ID,
        receipt: 'LEAK_CANARY_RECEIPT',
        path: 'LEAK_CANARY_PATH',
      })),
    }));

    const outcome = await service.apply({
      cwd: '/safe/repo',
      sourcePath: 'pack.taktpack',
      currentTaktVersion: '0.48.0',
      mode: 'apply',
      expectedPlanId: PLAN_ID,
      force: false,
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: {
        status: 'success',
        result: {
          planId: PLAN_ID,
          applied: true,
          backupId: 'backup-1',
          recoveryState: 'clean',
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('LEAK_CANARY');
  });
});
