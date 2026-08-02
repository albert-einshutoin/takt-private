import { describe, expect, it, vi } from 'vitest';
import {
  ProjectTemplateCliRemotePortError,
  createProjectTemplateCliRemoteApplyService as createCoreService,
  type ProjectTemplateCliRemoteApplyPort,
} from '../../features/project-template/cli-remote-apply-service.js';
import { startProjectTemplateCliLifecycle } from '../../features/project-template/cli-lifecycle.js';

const PLAN_ID = 'a'.repeat(64);

function createProjectTemplateCliRemoteApplyService(value: ProjectTemplateCliRemoteApplyPort) {
  const core = createCoreService(value);
  const mutate = (command: 'apply' | 'update', options: Parameters<typeof core.apply>[0]) => {
    if (options.mode === 'dry-run') return core[command](options);
    return startProjectTemplateCliLifecycle({
      command: `project-template ${command}` as const, mode: 'apply', dispose: () => undefined,
      handle: ({ admitMutation, signal }) => core[command]({
        ...options, signal: options.signal ?? signal, admitMutation,
      }),
    }).result;
  };
  return { diff: core.diff, apply: (options: Parameters<typeof core.apply>[0]) => mutate('apply', options),
    update: (options: Parameters<typeof core.update>[0]) => mutate('update', options) };
}

function port(overrides: Partial<ProjectTemplateCliRemoteApplyPort> = {}): ProjectTemplateCliRemoteApplyPort {
  return {
    inspectGuard: () => ({ passed: true, blocks: [] }),
    derive: async () => ({
      transactionPlanId: PLAN_ID,
      changeCount: 2,
      conflictCount: 0,
      dependencyCount: 1,
      updateAvailable: true,
      reviewRequired: false,
      hardConflict: false,
      defaultApplyPossible: true,
      forceApplicable: false,
      authority: Object.freeze(Object.create(null)),
    }),
    execute: async () => ({
      status: 'committed',
      transactionPlanId: PLAN_ID,
      backupId: 'backup-safe',
    }),
    ...overrides,
  };
}

const base = {
  cwd: '/repo',
  source: 'github:owner/repo@v1.0.0',
  currentTaktVersion: '0.48.0',
  baselineStrategy: 'conflict' as const,
  force: false,
};

describe('project template remote CLI service', () => {
  it('rejects missing admission capability before apply and update execution', async () => {
    const execute = vi.fn(port().execute);
    const service = createCoreService(port({ execute }));
    for (const command of ['apply', 'update'] as const) {
      await expect(service[command]({ ...base, mode: 'apply', expectedPlanId: PLAN_ID }))
        .resolves.toMatchObject({ envelope: { error: { code: 'SECURITY_GUARD' } } });
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects an invalid plan id after RegExp prototype poisoning', async () => {
    const execute = vi.fn(port().execute);
    const service = createProjectTemplateCliRemoteApplyService(port({ execute }));
    const original = RegExp.prototype.test;
    try {
      RegExp.prototype.test = () => true;
      await expect(service.apply({ ...base, mode: 'apply', expectedPlanId: 'invalid' } as never))
        .resolves.toMatchObject({ envelope: { error: { code: 'INVALID_EXPECTED_PLAN_ID' } } });
    } finally {
      RegExp.prototype.test = original;
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['apply', 'update'] as const)('admits %s exact-once before terminal execution', async (command) => {
    const controller = new AbortController();
    const admitMutation = vi.fn(() => controller.abort());
    const execute = vi.fn(port().execute);
    const service = createProjectTemplateCliRemoteApplyService(port({ execute }));
    await service[command]({ ...base, mode: 'apply', expectedPlanId: PLAN_ID,
      signal: controller.signal, admitMutation });
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each([
    ['INTERNAL', false, 70],
    ['INTERRUPTED', true, 130],
  ] as const)('rejects arbitrary callback before remote execution (%s)', async (_code, interrupt, _exitCode) => {
    const execute = vi.fn();
    const controller = new AbortController();
    const service = createCoreService(port({ execute }));
    const outcome = await service.apply({ ...base, mode: 'apply', expectedPlanId: PLAN_ID,
      signal: controller.signal,
      admitMutation() { if (interrupt) controller.abort(); throw new Error('admission failed'); } });
    expect(outcome).toMatchObject({ exitCode: 23, envelope: { error: { code: 'SECURITY_GUARD' } } });
    expect(execute).not.toHaveBeenCalled();
  });
  it('returns only the closed safe diff DTO from a fresh derivation', async () => {
    const service = createProjectTemplateCliRemoteApplyService(port());
    const outcome = await service.diff(base);

    expect(outcome).toEqual({
      exitCode: 0,
      envelope: {
        schemaVersion: '1.0', status: 'success', command: 'project-template diff', mode: 'dry-run',
        result: {
          planId: PLAN_ID, changeCount: 2, conflictCount: 0, dependencyCount: 1,
          readiness: 'ready', reviewCodes: [],
        },
        warnings: [],
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(
      /receipt|previewId|approval|evidence|verifier|cache|authority/iu,
    );
  });

  it('re-derives in a new process and admits only an exact expected plan', async () => {
    const execute = vi.fn(port().execute);
    const service = createProjectTemplateCliRemoteApplyService(port({ execute }));

    const outcome = await service.apply({ ...base, mode: 'apply', expectedPlanId: PLAN_ID });

    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: { status: 'success', result: {
        planId: PLAN_ID, applied: true, backupId: 'backup-safe', recoveryState: 'clean',
      } },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].derived.authority).toBeDefined();
    expect(execute.mock.calls[0]![0]).not.toHaveProperty('signal');
  });

  it('rejects drift before mutation admission', async () => {
    const admitMutation = vi.fn();
    const execute = vi.fn(port().execute);
    const service = createProjectTemplateCliRemoteApplyService(port({ execute }));
    const outcome = await service.apply({
      ...base, mode: 'apply', expectedPlanId: 'b'.repeat(64), admitMutation,
    });

    expect(outcome).toMatchObject({
      exitCode: 22,
      envelope: { status: 'error', error: { code: 'PLAN_DRIFT' } },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(admitMutation).not.toHaveBeenCalled();
  });

  it('projects update dry-run and apply without internal handles', async () => {
    const service = createProjectTemplateCliRemoteApplyService(port());
    const dry = await service.update({ ...base, mode: 'dry-run' });
    const applied = await service.update({ ...base, mode: 'apply', expectedPlanId: PLAN_ID });

    expect(dry).toMatchObject({ envelope: { result: {
      planId: PLAN_ID, updateAvailable: true, dependencyCount: 1, readiness: 'ready', reviewCodes: [],
    } } });
    expect(applied).toMatchObject({ envelope: { result: {
      planId: PLAN_ID, updated: true, backupId: 'backup-safe', recoveryState: 'clean',
    } } });
    expect(JSON.stringify([dry, applied])).not.toMatch(/receipt|previewId|approval|evidence|cache/iu);
  });

  it('does not let force bypass hard conflicts or guards', async () => {
    const execute = vi.fn(port().execute);
    const admitMutation = vi.fn();
    const hard = createProjectTemplateCliRemoteApplyService(port({
      execute,
      derive: async () => ({
        ...(await port().derive({
          cwd: '/repo', source: 'github:owner/repo@v1', currentTaktVersion: '0.48.0',
          baselineStrategy: 'conflict',
        })),
        hardConflict: true, reviewRequired: true, defaultApplyPossible: false,
      }),
    }));
    const blocked = createProjectTemplateCliRemoteApplyService(port({
      inspectGuard: () => ({ passed: false, blocks: [{ code: 'ACTIVE_RUN' }] }),
      execute,
    }));

    await expect(hard.apply({ ...base, force: true, mode: 'apply', expectedPlanId: PLAN_ID, admitMutation }))
      .resolves.toMatchObject({ envelope: { error: { code: 'HARD_CONFLICT' } } });
    await expect(blocked.apply({ ...base, force: true, mode: 'apply', expectedPlanId: PLAN_ID, admitMutation }))
      .resolves.toMatchObject({ envelope: { error: { code: 'ACTIVE_RUN' } } });
    expect(execute).not.toHaveBeenCalled();
    expect(admitMutation).not.toHaveBeenCalled();
  });

  it.each(['STALE_RUN', 'PERSONAL_DAEMON_RUNNING'] as const)(
    'classifies %s as an active-run block',
    async (code) => {
      const derive = vi.fn(port().derive);
      const service = createProjectTemplateCliRemoteApplyService(port({
        inspectGuard: () => ({ passed: false, blocks: [{ code }] }),
        derive,
      }));

      await expect(service.diff(base)).resolves.toMatchObject({
        exitCode: 23,
        envelope: { error: { code: 'ACTIVE_RUN' } },
      });
      expect(derive).not.toHaveBeenCalled();
    },
  );

  it('requires approval when force is applicable but missing', async () => {
    const execute = vi.fn(port().execute);
    const forceApplicable = createProjectTemplateCliRemoteApplyService(port({
      execute,
      derive: async () => ({
        ...(await port().derive({
          cwd: '/repo', source: 'github:owner/repo@v1', currentTaktVersion: '0.48.0',
          baselineStrategy: 'conflict',
        })),
        reviewRequired: true,
        defaultApplyPossible: false,
        forceApplicable: true,
      }),
    }));

    await expect(forceApplicable.apply({
      ...base, mode: 'apply', expectedPlanId: PLAN_ID,
    })).resolves.toMatchObject({ envelope: { error: { code: 'APPROVAL_REQUIRED' } } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'keeps a non-force-applicable review required when force=%s',
    async (force) => {
      const execute = vi.fn(port().execute);
      const reviewOnly = createProjectTemplateCliRemoteApplyService(port({
        execute,
        derive: async () => ({
          ...(await port().derive({
            cwd: '/repo', source: 'github:owner/repo@v1', currentTaktVersion: '0.48.0',
            baselineStrategy: 'conflict',
          })),
          reviewRequired: true,
          defaultApplyPossible: false,
          forceApplicable: false,
        }),
      }));

      await expect(reviewOnly.apply({
        ...base, force, mode: 'apply', expectedPlanId: PLAN_ID,
      })).resolves.toMatchObject({ envelope: { error: { code: 'REVIEW_REQUIRED' } } });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('preserves unknown recovery state as recovery-required', async () => {
    const execute = vi.fn(port().execute);
    const service = createProjectTemplateCliRemoteApplyService(port({
      inspectGuard: () => ({
        passed: false,
        blocks: [{ code: 'RECOVERY_REQUIRED_UNKNOWN' }],
      }),
      execute,
    }));

    await expect(service.diff(base)).resolves.toMatchObject({
      exitCode: 25,
      envelope: { status: 'error', error: { code: 'RECOVERY_REQUIRED' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('blocks non-zero conflicts and inconsistent non-applicable plans even with force', async () => {
    const execute = vi.fn(port().execute);
    const conflict = createProjectTemplateCliRemoteApplyService(port({
      execute,
      derive: async (options) => ({ ...(await port().derive(options)), conflictCount: 1 }),
    }));
    const inconsistent = createProjectTemplateCliRemoteApplyService(port({
      execute,
      derive: async (options) => ({
        ...(await port().derive(options)), defaultApplyPossible: false,
      }),
    }));

    await expect(conflict.apply({ ...base, force: true, mode: 'apply', expectedPlanId: PLAN_ID }))
      .resolves.toMatchObject({ envelope: { error: { code: 'HARD_CONFLICT' } } });
    await expect(inconsistent.apply({ ...base, force: true, mode: 'apply', expectedPlanId: PLAN_ID }))
      .resolves.toMatchObject({ envelope: { error: { code: 'SECURITY_GUARD' } } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not mutate an up-to-date update plan', async () => {
    const execute = vi.fn(port().execute);
    const service = createProjectTemplateCliRemoteApplyService(port({
      execute,
      derive: async (options) => ({ ...(await port().derive(options)), updateAvailable: false }),
    }));
    const dry = await service.update({ ...base, mode: 'dry-run' });
    const applied = await service.update({ ...base, mode: 'apply', expectedPlanId: PLAN_ID });

    expect(dry).toMatchObject({ envelope: { result: { updateAvailable: false } } });
    expect(applied).toMatchObject({ envelope: { error: { code: 'PLAN_DRIFT' } } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects accessor, proxy, prototype and oversized port results without executing them', async () => {
    let getterCalls = 0;
    const accessorPort = Object.create(null, {
      inspectGuard: { enumerable: true, get() { getterCalls += 1; return port().inspectGuard; } },
      derive: { enumerable: true, value: port().derive },
      execute: { enumerable: true, value: port().execute },
    });
    expect(() => createProjectTemplateCliRemoteApplyService(accessorPort))
      .toThrow('remote apply port is invalid');
    expect(getterCalls).toBe(0);

    const proxyResult = createProjectTemplateCliRemoteApplyService(port({
      derive: async (options) => new Proxy(await port().derive(options), {}),
    }));
    await expect(proxyResult.diff(base)).resolves.toMatchObject({
      envelope: { error: { code: 'INTERNAL' } },
    });

    const oversized = createProjectTemplateCliRemoteApplyService(port({
      derive: async (options) => ({ ...(await port().derive(options)), changeCount: 1_000_000 }),
    }));
    await expect(oversized.diff(base)).resolves.toMatchObject({
      envelope: { error: { code: 'INTERNAL' } },
    });
  });

  it('rejects invalid runtime options with a closed redacted error', async () => {
    const service = createProjectTemplateCliRemoteApplyService(port());
    const outcome = await service.diff({ ...base, source: '' });
    expect(outcome).toMatchObject({ envelope: { error: { code: 'INVALID_ARGUMENT' } } });
    expect(JSON.stringify(outcome)).not.toContain('/repo');
  });

  it('returns 130 before admission but drains admitted execution', async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => ({
      status: 'committed' as const, transactionPlanId: PLAN_ID, backupId: 'backup-safe',
    }));
    const service = createProjectTemplateCliRemoteApplyService(port({ execute }));

    await expect(service.apply({
      ...base, mode: 'apply', expectedPlanId: PLAN_ID, signal: controller.signal,
    })).resolves.toMatchObject({ exitCode: 130 });
    expect(execute).not.toHaveBeenCalled();

    const admitted = await service.apply({ ...base, mode: 'apply', expectedPlanId: PLAN_ID });
    expect(admitted.exitCode).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    ['AUTH_FAILED', 24], ['NETWORK_FAILED', 24], ['SOURCE_INTEGRITY_FAILED', 24],
    ['SOURCE_UNAVAILABLE', 24], ['SECURITY_GUARD', 23],
  ] as const)('maps redacted stable port error %s', async (code, exitCode) => {
    const service = createProjectTemplateCliRemoteApplyService(port({
      derive: async () => { throw new ProjectTemplateCliRemotePortError(code); },
    }));
    const outcome = await service.diff(base);
    expect(outcome).toMatchObject({ exitCode, envelope: { error: { code } } });
    expect(JSON.stringify(outcome)).not.toContain('/repo');
  });
});
