import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as productionModule from '../../app/cli/projectTemplateCommandProduction.js';
const {
  createProjectTemplateCliCommandProductionDependencies,
} = productionModule;
import { GlobalConfigManager } from '../../infra/config/global/globalConfigCore.js';
import { invalidateAllResolvedConfigCache } from '../../infra/config/resolveConfigValue.js';
import {
  createProjectTemplateCliSuccess,
  type ProjectTemplateCliOutcome,
} from '../../features/project-template/cli-machine-contract.js';
import type {
  ProjectTemplateCliRemoteProductionRuntime,
} from '../../infra/github/project-template-cli-remote-production.js';

const roots: string[] = [];
const originalConfigDirectory = process.env.TAKT_CONFIG_DIR;

afterEach(async () => {
  if (originalConfigDirectory === undefined) delete process.env.TAKT_CONFIG_DIR;
  else process.env.TAKT_CONFIG_DIR = originalConfigDirectory;
  GlobalConfigManager.resetInstance();
  invalidateAllResolvedConfigCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function dryRunOutcome(): ProjectTemplateCliOutcome {
  return {
    envelope: createProjectTemplateCliSuccess({
      command: 'project-template diff',
      mode: 'dry-run',
      result: {
        planId: 'a'.repeat(64), changeCount: 0, conflictCount: 0,
        dependencyCount: 0, readiness: 'ready', reviewCodes: [],
      },
    }),
    exitCode: 0,
  };
}

function remoteRequest(cwd: string) {
  return {
    command: 'project-template diff' as const,
    cwd,
    json: true,
    currentTaktVersion: '0.48.0',
    source: { kind: 'github' as const, value: 'github:owner/template@v1.0.0' },
    mutation: { mode: 'dry-run' as const, force: false },
  };
}

function remoteApplyRequest(cwd: string) {
  return {
    ...remoteRequest(cwd),
    command: 'project-template apply' as const,
    mutation: {
      mode: 'apply' as const,
      force: false,
      expectedPlanId: 'a'.repeat(64),
    },
  };
}

function context() {
  return { signal: new AbortController().signal, admitMutation: vi.fn() };
}

describe('project-template production command dependencies', () => {
  it.each([
    ['missing configs', undefined, undefined, 'en'],
    ['global config', 'ja', undefined, 'ja'],
    ['project config', undefined, 'ja', 'ja'],
    ['project override', 'ja', 'en', 'en'],
  ] as const)(
    'resolves repertoire language from %s without creating missing config',
    async (_name, globalLanguage, projectLanguage, expectedLanguage) => {
      const root = await mkdtemp(join(tmpdir(), 'takt-cli-language-'));
      roots.push(root);
      const project = join(root, 'project');
      const globalConfigDirectory = join(root, 'global-config');
      await mkdir(join(project, '.git'), { recursive: true });
      await mkdir(globalConfigDirectory);
      if (globalLanguage !== undefined) {
        await writeFile(
          join(globalConfigDirectory, 'config.yaml'),
          `language: ${globalLanguage}\n`,
        );
      }
      if (projectLanguage !== undefined) {
        await mkdir(join(project, '.takt'), { recursive: true });
        await writeFile(
          join(project, '.takt', 'config.yaml'),
          `language: ${projectLanguage}\n`,
        );
      }
      process.env.TAKT_CONFIG_DIR = globalConfigDirectory;
      GlobalConfigManager.resetInstance();
      invalidateAllResolvedConfigCache();
      const before = await readdir(globalConfigDirectory);
      const resolveLanguage = (
        productionModule as unknown as {
          resolveProjectTemplateCliProductionLanguage?: (projectRoot: string) => 'en' | 'ja';
        }
      ).resolveProjectTemplateCliProductionLanguage;

      expect(resolveLanguage).toBeTypeOf('function');
      expect(resolveLanguage?.(project)).toBe(expectedLanguage);
      expect(await readdir(globalConfigDirectory)).toEqual(before);
    },
  );

  it('owns and disposes a runtime that completes creation after disposal starts', async () => {
    let release!: (runtime: ProjectTemplateCliRemoteProductionRuntime) => void;
    const disposeRuntime = vi.fn(async () => undefined);
    const runtimePromise = new Promise<ProjectTemplateCliRemoteProductionRuntime>((resolve) => {
      release = resolve;
    });
    const dependencies = createProjectTemplateCliCommandProductionDependencies('0.48.0', {
      createRemoteRuntime: vi.fn(() => runtimePromise),
    });
    const dispatch = dependencies.dispatch(remoteRequest('/project'), context());
    const disposal = Promise.resolve(dependencies.dispose());
    release({
      service: { diff: vi.fn(async () => dryRunOutcome()) } as never,
      dispose: disposeRuntime,
    });

    await expect(dispatch).resolves.toEqual(dryRunOutcome());
    await disposal;
    await dependencies.dispose();
    expect(disposeRuntime).toHaveBeenCalledOnce();
  });

  it('delegates admission to the remote service exact execution boundary', async () => {
    const admission = vi.fn();
    const apply = vi.fn(async (options: { admitMutation?: () => void }) => {
      expect(admission).not.toHaveBeenCalled();
      options.admitMutation?.();
      return dryRunOutcome();
    });
    const dependencies = createProjectTemplateCliCommandProductionDependencies('0.48.0', {
      createRemoteRuntime: vi.fn(async () => ({
        service: { apply } as never,
        dispose: vi.fn(async () => undefined),
      })),
    });

    await dependencies.dispatch(remoteApplyRequest('/project'), {
      signal: new AbortController().signal,
      admitMutation: admission,
    });

    expect(apply).toHaveBeenCalledOnce();
    expect(admission).toHaveBeenCalledOnce();
    await dependencies.dispose();
  });

  it('keeps a runtime construction failure primary while disposal stays bounded', async () => {
    const primary = new Error('runtime construction failed');
    const dependencies = createProjectTemplateCliCommandProductionDependencies('0.48.0', {
      createRemoteRuntime: vi.fn(async () => { throw primary; }),
    });
    const dispatch = dependencies.dispatch(remoteRequest('/project'), context());

    await expect(dispatch).rejects.toBe(primary);
    await expect(dependencies.dispose()).resolves.toBeUndefined();
  });

  it('reports runtime disposal failure and rejects acquisition after disposal', async () => {
    const disposeFailure = new Error('runtime disposal failed');
    const createRemoteRuntime = vi.fn(async () => ({
      service: { diff: vi.fn(async () => dryRunOutcome()) } as never,
      dispose: vi.fn(async () => { throw disposeFailure; }),
    }));
    const dependencies = createProjectTemplateCliCommandProductionDependencies('0.48.0', {
      createRemoteRuntime,
    });
    await dependencies.dispatch(remoteRequest('/project'), context());

    await expect(dependencies.dispose()).rejects.toBe(disposeFailure);
    await expect(dependencies.dispatch(remoteRequest('/other'), context())).rejects.toThrow(
      'remote runtime is disposed',
    );
    expect(createRemoteRuntime).toHaveBeenCalledOnce();
  });

  it('rejects acquisition after disposal completed before creation', async () => {
    const createRemoteRuntime = vi.fn();
    const dependencies = createProjectTemplateCliCommandProductionDependencies('0.48.0', {
      createRemoteRuntime,
    });

    await dependencies.dispose();
    await expect(dependencies.dispatch(remoteRequest('/project'), context())).rejects.toThrow(
      'remote runtime is disposed',
    );
    expect(createRemoteRuntime).not.toHaveBeenCalled();
  });

  it.each(['missing', 'non-project', 'symlink'] as const)(
    'rejects an unsafe %s cwd without initializing filesystem state',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'takt-cli-production-'));
      roots.push(root);
      const parent = join(root, 'parent');
      await mkdir(parent);
      let cwd = join(parent, 'missing');
      if (kind === 'non-project') {
        cwd = join(parent, 'plain');
        await mkdir(cwd);
      } else if (kind === 'symlink') {
        const target = join(parent, 'target');
        await mkdir(join(target, '.git'), { recursive: true });
        await writeFile(join(target, 'sentinel'), 'unchanged');
        cwd = join(parent, 'alias');
        await symlink(target, cwd, 'dir');
      }
      const before = await readdir(parent, { recursive: true });
      const dependencies = createProjectTemplateCliCommandProductionDependencies('0.48.0');

      await expect(dependencies.dispatch(remoteRequest(cwd), context())).rejects.toThrow();
      await dependencies.dispose();

      expect(await readdir(parent, { recursive: true })).toEqual(before);
    },
  );

  it('rejects a .takt symlink before writing through it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'takt-cli-production-'));
    roots.push(root);
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    await mkdir(project);
    await mkdir(outside);
    await symlink(outside, join(project, '.takt'), 'dir');
    const dependencies = createProjectTemplateCliCommandProductionDependencies('0.48.0');

    await expect(dependencies.dispatch(remoteRequest(project), context())).rejects.toThrow();
    await dependencies.dispose();

    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(project)).toEqual(['.takt']);
  });
});
