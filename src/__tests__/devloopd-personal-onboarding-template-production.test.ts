import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeProjectTemplateCliMutationAdmission,
} from '../features/project-template/cli-lifecycle.js';
import {
  createProjectTemplateCliSuccess,
  type ProjectTemplateCliOutcome,
} from '../features/project-template/cli-machine-contract.js';
import {
  createProductionPersonalOnboardingTemplateFacade,
} from '../devloopd/personalOnboardingTemplateProduction.js';
import type {
  ProjectTemplateCliCommandAdapterDependencies,
} from '../app/cli/projectTemplateCommands.js';

const PLAN_ID = 'a'.repeat(64);

afterEach(() => { vi.restoreAllMocks(); });

function outcome(mode: 'dry-run' | 'apply'): ProjectTemplateCliOutcome {
  return mode === 'apply'
    ? {
      envelope: createProjectTemplateCliSuccess({
        command: 'project-template apply', mode,
        result: {
          planId: PLAN_ID, applied: true,
          backupId: 'backup-safe', recoveryState: 'clean',
        },
      }),
      exitCode: 0,
    }
    : {
      envelope: createProjectTemplateCliSuccess({
        command: 'project-template apply', mode,
        result: {
          planId: PLAN_ID, changeCount: 1, conflictCount: 0,
          dependencyCount: 0, readiness: 'ready', reviewCodes: [],
        },
      }),
      exitCode: 0,
    };
}

function harness(dispatch: ProjectTemplateCliCommandAdapterDependencies['dispatch']) {
  const dispose = vi.fn(async () => undefined);
  const factory = vi.fn(() => ({
    dispatch,
    dispose,
    writeStdout: vi.fn(),
    setExitCode: vi.fn(),
    installInterrupt: vi.fn(() => () => {}),
    cwd: () => '/unused',
    currentTaktVersion: '0.48.0',
  }));
  const load = vi.fn(async () => factory);
  const facade = createProductionPersonalOnboardingTemplateFacade({
    currentTaktVersion: '0.48.0',
    loadCommandDependenciesFactory: load,
    installInterrupt: () => () => {},
    ensureRootGitignore: () => ({
      status: 'exists', name: 'root gitignore', message: 'already present',
    }),
    ensureGithubLabels: async () => [{
      status: 'exists', name: 'github labels', message: 'already present',
    }],
  });
  return { dispose, facade, factory, load };
}

const applyOptions = {
  repoPath: '/repo',
  source: { kind: 'local' as const, value: '/repo/starter.taktpack' },
  mutation: {
    mode: 'apply' as const, force: false, expectedPlanId: PLAN_ID,
  },
};

describe('production personal onboarding template facade', () => {
  it('keeps the default SIGINT listener active through admitted transaction drain', async () => {
    let installed: NodeJS.SignalsListener | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const on = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGINT') installed = listener as NodeJS.SignalsListener;
      return process;
    });
    const removeListener = vi.spyOn(process, 'removeListener').mockReturnValue(process);
    const dispatch = vi.fn(async (_request, context) => {
      consumeProjectTemplateCliMutationAdmission(context.admitMutation);
      installed?.('SIGINT');
      installed?.('SIGINT');
      await gate;
      return outcome('apply');
    });
    const value = harness(dispatch);
    const facade = createProductionPersonalOnboardingTemplateFacade({
      currentTaktVersion: '0.48.0',
      loadCommandDependenciesFactory: value.load,
      ensureRootGitignore: () => ({
        status: 'exists', name: 'root gitignore', message: 'already present',
      }),
      ensureGithubLabels: async () => [],
    });

    const pending = facade.run(applyOptions);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(removeListener).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toMatchObject({ passed: true });
    expect(removeListener).toHaveBeenCalledWith('SIGINT', installed);
  });

  it('loads production dependencies lazily and disposes exactly once', async () => {
    const dispatch = vi.fn(async (request, context) => {
      expect(request.mutation).toMatchObject({ mode: 'apply' });
      consumeProjectTemplateCliMutationAdmission(context.admitMutation);
      return outcome('apply');
    });
    const value = harness(dispatch);
    expect(value.load).not.toHaveBeenCalled();

    const report = await value.facade.run(applyOptions);

    expect(report.passed).toBe(true);
    expect(value.load).toHaveBeenCalledOnce();
    expect(value.factory).toHaveBeenCalledOnce();
    expect(value.dispose).toHaveBeenCalledOnce();
  });

  it('returns 130 without dispatch when SIGINT arrives before admission', async () => {
    const dispatch = vi.fn(async () => outcome('apply'));
    const value = harness(dispatch);
    const facade = createProductionPersonalOnboardingTemplateFacade({
      currentTaktVersion: '0.48.0',
      loadCommandDependenciesFactory: value.load,
      installInterrupt(interrupt) {
        interrupt();
        return () => {};
      },
      ensureRootGitignore: () => ({
        status: 'exists', name: 'root gitignore', message: 'already present',
      }),
      ensureGithubLabels: async () => [],
    });

    const report = await facade.run(applyOptions);

    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(report.machineOutput)).toMatchObject({
      components: { files: { status: 'error', code: 'INTERRUPTED' } },
    });
  });

  it('drains admitted work after SIGINT and never exposes internal dependency writers', async () => {
    let interrupt!: () => void;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn(async (_request, context) => {
      consumeProjectTemplateCliMutationAdmission(context.admitMutation);
      interrupt();
      await gate;
      return outcome('apply');
    });
    const value = harness(dispatch);
    const facade = createProductionPersonalOnboardingTemplateFacade({
      currentTaktVersion: '0.48.0',
      loadCommandDependenciesFactory: value.load,
      installInterrupt(listener) {
        interrupt = listener;
        return () => {};
      },
      ensureRootGitignore: () => ({
        status: 'exists', name: 'root gitignore', message: 'already present',
      }),
      ensureGithubLabels: async () => [],
    });

    const pending = facade.run(applyOptions);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(value.dispose).not.toHaveBeenCalled();
    release();
    const report = await pending;

    expect(report.passed).toBe(true);
    expect(value.dispose).toHaveBeenCalledOnce();
    expect(report.machineOutput).not.toMatch(/credential|authority|\/repo/iu);
  });

  it('closes a rejected GitHub runner behind the component facade', async () => {
    const dispatch = vi.fn(async (_request, context) => {
      consumeProjectTemplateCliMutationAdmission(context.admitMutation);
      return outcome('apply');
    });
    const value = harness(dispatch);
    const facade = createProductionPersonalOnboardingTemplateFacade({
      currentTaktVersion: '0.48.0',
      loadCommandDependenciesFactory: value.load,
      installInterrupt: () => () => {},
      ensureRootGitignore: () => ({
        status: 'exists', name: 'root gitignore', message: 'already present',
      }),
      ensureGithubLabels: async () => {
        throw new Error('child rejected /repo Authorization: bearer secret');
      },
    });

    const report = await facade.run(applyOptions);

    expect(report.passed).toBe(false);
    expect(value.dispose).toHaveBeenCalledOnce();
    expect(JSON.parse(report.machineOutput)).toMatchObject({
      status: 'partial', backupId: 'backup-safe',
      components: {
        files: { status: 'success' },
        rootGitignore: { status: 'success' },
        labels: { status: 'error', changed: false },
      },
    });
    expect(report.machineOutput).not.toMatch(/\/repo|authorization|bearer|secret|path|detail/iu);
  });
});
