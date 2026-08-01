import { describe, expect, it, vi } from 'vitest';
import {
  createPersonalOnboardingTemplateFacade,
} from '../devloopd/personalOnboardingTemplate.js';
import {
  createProjectTemplateCliFailure,
  createProjectTemplateCliSuccess,
  projectTemplateCliExitCodeForErrorCode,
} from '../features/project-template/cli-machine-contract.js';

const PLAN_ID = 'a'.repeat(64);

function fileSuccess() {
  return {
    envelope: createProjectTemplateCliSuccess({
      command: 'project-template apply', mode: 'apply',
      result: {
        planId: PLAN_ID, applied: true, backupId: 'backup-safe', recoveryState: 'clean',
      },
    }),
    exitCode: 0,
  };
}

function fileFailure() {
  const code = 'PLAN_DRIFT' as const;
  return {
    envelope: createProjectTemplateCliFailure({
      command: 'project-template apply', mode: 'apply', code,
    }),
    exitCode: projectTemplateCliExitCodeForErrorCode(code),
  };
}

const options = {
  repoPath: '/repo',
  repo: 'owner/repo',
  source: { kind: 'local' as const, value: '/repo/starter.taktpack' },
  mutation: {
    mode: 'apply' as const, force: true, expectedPlanId: PLAN_ID,
  },
};

describe('personal onboarding template facade', () => {
  it('skips root gitignore and labels when safe file application fails', async () => {
    const applyFiles = vi.fn(async () => fileFailure());
    const ensureRootGitignore = vi.fn();
    const ensureGithubLabels = vi.fn();
    const facade = createPersonalOnboardingTemplateFacade({
      applyFiles, ensureRootGitignore, ensureGithubLabels,
    });

    const report = await facade.run(options);

    expect(applyFiles).toHaveBeenCalledWith(options);
    expect(ensureRootGitignore).not.toHaveBeenCalled();
    expect(ensureGithubLabels).not.toHaveBeenCalled();
    expect(report.passed).toBe(false);
    expect(JSON.parse(report.machineOutput)).toMatchObject({
      status: 'error', mode: 'apply',
      components: {
        files: { status: 'error', code: 'PLAN_DRIFT' },
        rootGitignore: { status: 'skipped' },
        labels: { status: 'skipped' },
      },
    });
  });

  it('runs post-file components in order and retains backupId on partial failure', async () => {
    const order: string[] = [];
    const applyFiles = vi.fn(async () => {
      order.push('files');
      return fileSuccess();
    });
    const ensureRootGitignore = vi.fn(() => {
      order.push('root');
      return {
        status: 'changed' as const, name: 'root gitignore', message: 'updated',
        path: '/repo/.gitignore',
      };
    });
    const ensureGithubLabels = vi.fn(async () => {
      order.push('labels');
      return [{
        status: 'fail' as const, name: 'github label agent:ready',
        message: 'failed to create GitHub label', detail: 'token redacted',
      }];
    });
    const facade = createPersonalOnboardingTemplateFacade({
      applyFiles, ensureRootGitignore, ensureGithubLabels,
    });

    const report = await facade.run(options);

    expect(order).toEqual(['files', 'root', 'labels']);
    expect(ensureRootGitignore).toHaveBeenCalledWith('/repo', true);
    expect(ensureGithubLabels).toHaveBeenCalledWith({
      repoPath: '/repo', repo: 'owner/repo', apply: true,
    });
    expect(report.passed).toBe(false);
    const machine = JSON.parse(report.machineOutput);
    expect(machine).toMatchObject({
      status: 'partial', mode: 'apply', backupId: 'backup-safe',
      components: {
        files: { status: 'success', changed: true },
        rootGitignore: { status: 'success', changed: true },
        labels: { status: 'error', changed: false },
      },
    });
    expect(report.machineOutput).not.toMatch(/\/repo|token|path|detail/iu);
    expect(report.humanOutput).toContain('backup-safe');
  });

  it('closes a root gitignore exception and skips labels while retaining backupId', async () => {
    const ensureGithubLabels = vi.fn();
    const facade = createPersonalOnboardingTemplateFacade({
      applyFiles: vi.fn(async () => fileSuccess()),
      ensureRootGitignore: vi.fn(() => {
        throw new Error('root failure /repo/.gitignore token=secret');
      }),
      ensureGithubLabels,
    });

    const report = await facade.run(options);

    expect(ensureGithubLabels).not.toHaveBeenCalled();
    expect(report.passed).toBe(false);
    expect(JSON.parse(report.machineOutput)).toMatchObject({
      status: 'partial', mode: 'apply', backupId: 'backup-safe',
      components: {
        files: { status: 'success', changed: true },
        rootGitignore: { status: 'error', changed: false },
        labels: { status: 'skipped' },
      },
    });
    expect(report.machineOutput).not.toMatch(/\/repo|token|secret|path|detail/iu);
    expect(report.humanOutput).not.toMatch(/\/repo|token|secret/iu);
  });

  it('closes a labels exception after root success and retains backupId', async () => {
    const facade = createPersonalOnboardingTemplateFacade({
      applyFiles: vi.fn(async () => fileSuccess()),
      ensureRootGitignore: vi.fn(() => ({
        status: 'exists' as const, name: 'root gitignore', message: 'already present',
      })),
      ensureGithubLabels: vi.fn(async () => {
        throw new Error('gh failure /repo credential=secret');
      }),
    });

    const report = await facade.run(options);

    expect(report.passed).toBe(false);
    expect(JSON.parse(report.machineOutput)).toMatchObject({
      status: 'partial', mode: 'apply', backupId: 'backup-safe',
      components: {
        files: { status: 'success', changed: true },
        rootGitignore: { status: 'success', changed: false },
        labels: { status: 'error', changed: false },
      },
    });
    expect(report.machineOutput).not.toMatch(/\/repo|credential|secret|path|detail/iu);
    expect(report.humanOutput).not.toMatch(/\/repo|credential|secret/iu);
  });

  it('keeps dry-run post components non-mutating', async () => {
    const applyFiles = vi.fn(async () => ({
      envelope: createProjectTemplateCliSuccess({
        command: 'project-template apply', mode: 'dry-run',
        result: {
          planId: PLAN_ID, changeCount: 2, conflictCount: 0,
          dependencyCount: 0, readiness: 'ready', reviewCodes: [],
        },
      }),
      exitCode: 0,
    }));
    const ensureRootGitignore = vi.fn(() => ({
      status: 'would_change' as const, name: 'root gitignore', message: 'would update',
    }));
    const ensureGithubLabels = vi.fn(async () => [{
      status: 'would_change' as const, name: 'github label agent:ready', message: 'would create',
    }]);
    const facade = createPersonalOnboardingTemplateFacade({
      applyFiles, ensureRootGitignore, ensureGithubLabels,
    });

    const report = await facade.run({
      ...options,
      mutation: { mode: 'dry-run', force: false },
    });

    expect(ensureRootGitignore).toHaveBeenCalledWith('/repo', false);
    expect(ensureGithubLabels).toHaveBeenCalledWith({
      repoPath: '/repo', repo: 'owner/repo', apply: false,
    });
    expect(report.passed).toBe(true);
    expect(JSON.parse(report.machineOutput)).toMatchObject({
      status: 'success', mode: 'dry-run',
      components: {
        files: { status: 'success', changed: false },
        rootGitignore: { status: 'success', changed: false },
        labels: { status: 'success', changed: false },
      },
    });
  });
});
