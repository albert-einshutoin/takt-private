import { describe, expect, it, vi } from 'vitest';
import {
  ProjectTemplateCliRemotePortError,
  createProjectTemplateCliRemoteApplyService,
  type ProjectTemplateCliRemoteApplyPort,
} from '../../features/project-template/cli-remote-apply-service.js';

const PLAN_ID = 'a'.repeat(64);

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
    const execute = vi.fn(port().execute);
    const service = createProjectTemplateCliRemoteApplyService(port({ execute }));
    const outcome = await service.apply({
      ...base, mode: 'apply', expectedPlanId: 'b'.repeat(64),
    });

    expect(outcome).toMatchObject({
      exitCode: 22,
      envelope: { status: 'error', error: { code: 'PLAN_DRIFT' } },
    });
    expect(execute).not.toHaveBeenCalled();
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

    await expect(hard.apply({ ...base, force: true, mode: 'apply', expectedPlanId: PLAN_ID }))
      .resolves.toMatchObject({ envelope: { error: { code: 'HARD_CONFLICT' } } });
    await expect(blocked.apply({ ...base, force: true, mode: 'apply', expectedPlanId: PLAN_ID }))
      .resolves.toMatchObject({ envelope: { error: { code: 'ACTIVE_RUN' } } });
    expect(execute).not.toHaveBeenCalled();
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
