import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTemplateCliLocalApplyService,
  type ProjectTemplateCliLocalApplyPort,
} from '../../features/project-template/cli-local-apply-service.js';

const PLAN_ID = 'a'.repeat(64);

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

  it('rejects expected-plan drift before mutation admission', async () => {
    const execute = vi.fn();
    const service = createProjectTemplateCliLocalApplyService(port({ execute }));
    const outcome = await service.apply({
      cwd: '/safe/repo',
      sourcePath: 'pack.taktpack',
      currentTaktVersion: '0.48.0',
      mode: 'apply',
      expectedPlanId: 'b'.repeat(64),
      force: false,
    });

    expect(outcome).toMatchObject({
      exitCode: 22,
      envelope: { status: 'error', error: { code: 'PLAN_DRIFT' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not let force bypass a hard content conflict', async () => {
    const execute = vi.fn();
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
    });

    expect(outcome).toMatchObject({
      exitCode: 21,
      envelope: { status: 'error', error: { code: 'HARD_CONFLICT' } },
    });
    expect(execute).not.toHaveBeenCalled();
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
