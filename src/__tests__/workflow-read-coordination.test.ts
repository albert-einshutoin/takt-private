import { spawn } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireRepertoireCoordinationLease } from '../features/repertoire/coordination-lease.js';
import {
  assertActiveRepertoireReadPermit,
  withImmediateRepertoireReadPermit,
} from '../features/repertoire/read-permit.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import {
  createInternalWorkflowReadContext,
  iterateWorkflowDir,
} from '../infra/config/loaders/workflowDiscovery.js';
import { readApprovedRepertoireWorkflowText } from '../infra/config/loaders/workflowRepertoireSafeReader.js';
import {
  listWorkflowEntries,
  loadWorkflowByIdentifier,
} from '../infra/config/loaders/workflowLoader.js';
import {
  loadAgentPrompt,
  loadPersonaPromptFromPath,
  validatePersonaPromptPath,
} from '../infra/config/loaders/agentLoader.js';
import { resolveFacetByName } from '../infra/config/loaders/resource-resolver.js';
import { createRepertoireResourceReadAccess } from '../infra/config/loaders/repertoireResourceReadAccess.js';
import { resolveWorkflowProviderOptionsWithHost } from '../infra/config/loaders/workflowProviderOptionsResolver.js';
import { executeTaskWorkflow } from '../features/tasks/execute/taskWorkflowExecution.js';
import { resolveProjectTemplateRunStartMutexPath } from '../features/project-template/apply-guard.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';

const SAMPLE_WORKFLOW = `name: coordinated-workflow
description: coordinated workflow
initial_step: step1
max_steps: 1
steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`;

describe('workflow repertoire read coordination', () => {
  let configDir: string;
  let projectDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'takt-workflow-read-config-'));
    projectDir = mkdtempSync(join(tmpdir(), 'takt-workflow-read-project-'));
    process.env.TAKT_CONFIG_DIR = configDir;
    writeFileSync(join(configDir, 'config.yaml'), 'enable_builtin_workflows: false\n');
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = originalConfigDir;
    invalidateGlobalConfigCache();
    rmSync(configDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function createRepertoireWorkflow(name = 'review'): string {
    const workflowsDir = join(configDir, 'repertoire', '@owner', 'repo', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const path = join(workflowsDir, `${name}.yaml`);
    writeFileSync(path, SAMPLE_WORKFLOW);
    return path;
  }

  function createProjectRuntimeWorkflow(name = 'runtime'): void {
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, `${name}.yaml`), SAMPLE_WORKFLOW);
  }

  function createProjectWorkflowWithScopedResources(): void {
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const packageDir = join(configDir, 'repertoire', '@owner', 'repo');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(join(packageDir, 'facets', 'instructions'), { recursive: true });
    mkdirSync(join(packageDir, 'facets', 'personas'), { recursive: true });
    mkdirSync(join(packageDir, 'provider-options'), { recursive: true });
    writeFileSync(join(packageDir, 'facets', 'instructions', 'review.md'), 'Use approved repertoire instructions.');
    writeFileSync(join(packageDir, 'facets', 'personas', 'reviewer.md'), 'You review changes.');
    writeFileSync(join(packageDir, 'provider-options', 'safe.yaml'), 'codex:\n  network_access: false\n');
    writeFileSync(join(workflowDir, 'scoped-resources.yaml'), `name: scoped-resources
workflow_config:
  provider_options:
    extends: "@owner/repo/safe"
initial_step: review
steps:
  - name: review
    persona: "@owner/repo/reviewer"
    instruction: "@owner/repo/review"
`);
  }

  function createRepertoireWorkflowWithPartial(): string {
    const packageDir = join(configDir, 'repertoire', '@owner', 'repo');
    const workflowsDir = join(packageDir, 'workflows');
    const partialsDir = join(packageDir, 'facets', 'partials', 'instructions');
    mkdirSync(workflowsDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });
    writeFileSync(join(partialsDir, 'shared.md'), 'Approved shared partial.');
    writeFileSync(join(workflowsDir, 'partial.yaml'), `name: partial-workflow
initial_step: review
steps:
  - name: review
    instruction: "Before {partial:shared} After"
`);
    return join(partialsDir, 'shared.md');
  }

  function createProjectWorkflowWithRepertoireAlias(
    kind: 'facet' | 'partial' | 'persona' | 'provider',
    aliasKind: 'symlink' | 'hardlink' = 'symlink',
  ): void {
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const targetDir = join(configDir, 'repertoire', '@owner', 'repo', 'alias-targets');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${kind}.${kind === 'provider' ? 'yaml' : 'md'}`);
    const localDirs = {
      facet: join(projectDir, '.takt', 'facets', 'instructions'),
      partial: join(projectDir, '.takt', 'facets', 'partials', 'instructions'),
      persona: join(projectDir, '.takt', 'facets', 'personas'),
      provider: join(projectDir, '.takt', 'provider-options'),
    } as const;
    const localDir = localDirs[kind];
    mkdirSync(localDir, { recursive: true });
    writeFileSync(targetPath, kind === 'provider'
      ? 'codex:\n  network_access: false\n'
      : `repertoire ${kind}`);
    const aliasPath = join(localDir, `alias.${kind === 'provider' ? 'yaml' : 'md'}`);
    if (aliasKind === 'symlink') symlinkSync(targetPath, aliasPath);
    else linkSync(targetPath, aliasPath);
    const stepFields = kind === 'facet'
      ? '    instruction: alias\n'
      : kind === 'partial'
        ? '    instruction: "Use {partial:alias}"\n'
        : kind === 'persona'
          ? '    persona: alias\n    instruction: "{task}"\n'
          : '    instruction: "{task}"\n';
    const workflowProvider = kind === 'provider'
      ? 'workflow_config:\n  provider_options:\n    extends: alias\n'
      : '';
    writeFileSync(join(workflowDir, `alias-${kind}.yaml`), `name: alias-${kind}
${workflowProvider}initial_step: review
steps:
  - name: review
${stepFields}`);
  }

  it('blocks list and direct scope reads behind a writer, then succeeds after release', async () => {
    createRepertoireWorkflow();
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: configDir,
      mode: 'write',
    });
    try {
      expect(() => listWorkflowEntries(projectDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
      expect(() => loadWorkflowByIdentifier('@owner/repo/review', projectDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
    } finally {
      writer.release();
    }

    expect(listWorkflowEntries(projectDir).map(({ name }) => name)).toContain('@owner/repo/review');
    expect(loadWorkflowByIdentifier('@owner/repo/review', projectDir)?.name).toBe('coordinated-workflow');
  });

  it('acquires global repertoire before the project run-start mutex', async () => {
    createProjectRuntimeWorkflow();
    const mutexPath = resolveProjectTemplateRunStartMutexPath(projectDir);
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: configDir,
      mode: 'write',
    });
    let executorCalled = false;
    const executionFailure = executeTaskWorkflow({
      task: 'lock order',
      cwd: projectDir,
      projectCwd: projectDir,
      workflowIdentifier: 'runtime',
    }, async () => {
      executorCalled = true;
      return { success: true };
    }).catch((error: unknown) => error);

    try {
      await delay(50);
      expect(executorCalled).toBe(false);
      expect(existsSync(mutexPath)).toBe(false);
    } finally {
      writer.release();
    }
    await expect(executionFailure).resolves.toMatchObject({ code: 'WRITER_PENDING' });
  });

  it('releases both read boundaries before awaiting an unresolved executor Promise', async () => {
    createProjectRuntimeWorkflow();
    const mutexPath = resolveProjectTemplateRunStartMutexPath(projectDir);
    let executorStarted: (() => void) | undefined;
    let resolveExecutor: ((result: { success: boolean }) => void) | undefined;
    const started = new Promise<void>((resolve) => { executorStarted = resolve; });
    const pending = new Promise<{ success: boolean }>((resolve) => { resolveExecutor = resolve; });
    const execution = executeTaskWorkflow({
      task: 'release before provider work',
      cwd: projectDir,
      projectCwd: projectDir,
      workflowIdentifier: 'runtime',
    }, () => {
      expect(existsSync(mutexPath)).toBe(true);
      executorStarted!();
      return pending;
    });

    await started;
    expect(existsSync(mutexPath)).toBe(false);
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: configDir,
      mode: 'write',
      timeoutMs: 250,
    });
    writer.release();
    resolveExecutor!({ success: true });
    await expect(execution).resolves.toEqual({ success: true });
  });

  it('releases runtime read boundaries when workflow loading fails', async () => {
    createProjectRuntimeWorkflow('broken');
    writeFileSync(
      join(projectDir, '.takt', 'workflows', 'broken.yaml'),
      'name: broken\ninitial_step: missing\nsteps: []\n',
    );
    await expect(executeTaskWorkflow({
      task: 'read failure',
      cwd: projectDir,
      projectCwd: projectDir,
      workflowIdentifier: 'broken',
    }, async () => ({ success: true }))).rejects.toThrow();

    expect(existsSync(resolveProjectTemplateRunStartMutexPath(projectDir))).toBe(false);
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: configDir,
      mode: 'write',
      timeoutMs: 250,
    });
    writer.release();
  });

  it('rejects custom thenables without adopting them', async () => {
    createProjectRuntimeWorkflow();
    let adopted = false;
    const thenable = {
      then() {
        adopted = true;
      },
    };

    await expect(executeTaskWorkflow({
      task: 'reject thenable',
      cwd: projectDir,
      projectCwd: projectDir,
      workflowIdentifier: 'runtime',
    }, (() => thenable) as never)).rejects.toMatchObject({ code: 'WORKFLOW_DISCOVERY_FAILED' });
    expect(adopted).toBe(false);
    expect(existsSync(resolveProjectTemplateRunStartMutexPath(projectDir))).toBe(false);
  });

  it('releases the child resolution permit before nested execution can begin', async () => {
    const childPath = createRepertoireWorkflow('child');
    writeFileSync(childPath, `${SAMPLE_WORKFLOW}\nsubworkflow:\n  callable: true\n`);
    const parentDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, 'parent.yaml'), `name: parent
initial_step: delegate
max_steps: 1
steps:
  - name: delegate
    kind: workflow_call
    call: "@owner/repo/child"
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    const parent = loadWorkflowByIdentifier('parent', projectDir);
    expect(parent).not.toBeNull();

    const child = resolveWorkflowCallTarget(
      parent!,
      '@owner/repo/child',
      'delegate',
      projectDir,
    );
    expect(child?.name).toBe('coordinated-workflow');

    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: configDir,
      mode: 'write',
      timeoutMs: 250,
    });
    writer.release();
  });

  it('blocks project workflow facet, persona, and provider reads behind a writer', async () => {
    createProjectWorkflowWithScopedResources();
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: configDir,
      mode: 'write',
    });
    try {
      expect(() => loadWorkflowByIdentifier('scoped-resources', projectDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
    } finally {
      writer.release();
    }

    const workflow = loadWorkflowByIdentifier('scoped-resources', projectDir);
    expect(workflow?.steps[0]?.instruction).toBe('Use approved repertoire instructions.');
    expect(workflow?.steps[0]?.personaPath).toBe(
      join(configDir, 'repertoire', '@owner', 'repo', 'facets', 'personas', 'reviewer.md'),
    );
    expect(workflow?.providerOptions).toEqual({ codex: { networkAccess: false } });
  });

  it('reads a package instruction partial only under the outer workflow permit', () => {
    createRepertoireWorkflowWithPartial();
    const workflow = loadWorkflowByIdentifier('@owner/repo/partial', projectDir);
    expect(workflow?.steps[0]?.instruction).toBe('Before Approved shared partial. After');
  });

  it('blocks runtime repertoire persona reads behind a writer and succeeds after release', async () => {
    createProjectWorkflowWithScopedResources();
    const personaPath = join(configDir, 'repertoire', '@owner', 'repo', 'facets', 'personas', 'reviewer.md');
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: configDir,
      mode: 'write',
    });
    try {
      expect(() => loadPersonaPromptFromPath(personaPath, projectDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
    } finally {
      writer.release();
    }
    expect(loadPersonaPromptFromPath(personaPath, projectDir)).toBe('You review changes.');
  });

  it('does not let an ancestor alias bypass persona read coordination on any public path', async () => {
    createProjectWorkflowWithScopedResources();
    const aliasRoot = join(projectDir, 'global-config-alias');
    symlinkSync(configDir, aliasRoot);
    const personaPath = join(
      aliasRoot,
      'repertoire',
      '@owner',
      'repo',
      'facets',
      'personas',
      'reviewer.md',
    );
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: configDir,
      mode: 'write',
    });
    try {
      expect(() => validatePersonaPromptPath(personaPath, projectDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
      expect(() => loadAgentPrompt({ name: 'reviewer', promptFile: personaPath }, projectDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
      expect(() => loadPersonaPromptFromPath(personaPath, projectDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
    } finally {
      writer.release();
    }
  });

  it.each(['facet', 'partial', 'persona', 'provider'] as const)(
    'does not let a project %s symlink alias bypass a repertoire writer',
    async (kind) => {
      createProjectWorkflowWithRepertoireAlias(kind);
      const writer = await acquireRepertoireCoordinationLease({
        globalConfigDir: configDir,
        mode: 'write',
      });
      try {
        expect(() => loadWorkflowByIdentifier(`alias-${kind}`, projectDir)).toThrow(
          expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
        );
      } finally {
        writer.release();
      }
      expect(() => loadWorkflowByIdentifier(`alias-${kind}`, projectDir)).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_DISCOVERY_FAILED' }),
      );
    },
  );

  it.each(['facet', 'partial', 'persona', 'provider'] as const)(
    'rejects a project %s hardlink to repertoire bytes even while a writer is active',
    async (kind) => {
      createProjectWorkflowWithRepertoireAlias(kind, 'hardlink');
      const writer = await acquireRepertoireCoordinationLease({
        globalConfigDir: configDir,
        mode: 'write',
      });
      try {
        if (kind === 'persona') {
          const workflow = loadWorkflowByIdentifier(`alias-${kind}`, projectDir);
          expect(() => loadPersonaPromptFromPath(workflow!.steps[0]!.personaPath!, projectDir)).toThrow(
            expect.objectContaining({ code: 'WORKFLOW_RESOURCE_READ_FAILED' }),
          );
        } else {
          expect(() => loadWorkflowByIdentifier(`alias-${kind}`, projectDir)).toThrow(
            expect.objectContaining({ code: 'WORKFLOW_RESOURCE_READ_FAILED' }),
          );
        }
      } finally {
        writer.release();
      }
    },
  );

  it('loads absolute and relative repertoire workflow paths through approved bytes', async () => {
    const workflowPath = createRepertoireWorkflow();
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: configDir,
      mode: 'write',
    });
    try {
      expect(() => loadWorkflowByIdentifier(workflowPath, projectDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
      expect(() => loadWorkflowByIdentifier('./repertoire/@owner/repo/workflows/review.yaml', projectDir, {
        basePath: configDir,
      })).toThrow(expect.objectContaining({ code: 'REPERTOIRE_BUSY' }));
    } finally {
      writer.release();
    }
    expect(loadWorkflowByIdentifier(workflowPath, projectDir)?.name).toBe('coordinated-workflow');
    expect(loadWorkflowByIdentifier('./repertoire/@owner/repo/workflows/review.yaml', projectDir, {
      basePath: configDir,
    })?.name).toBe('coordinated-workflow');
  });

  it.each(['symlink', 'hardlink'] as const)(
    'rejects an external %s alias to a repertoire workflow path',
    async (kind) => {
      const workflowPath = createRepertoireWorkflow();
      const aliasPath = join(projectDir, `${kind}-workflow.yaml`);
      if (kind === 'symlink') symlinkSync(workflowPath, aliasPath);
      else linkSync(workflowPath, aliasPath);
      const writer = await acquireRepertoireCoordinationLease({
        globalConfigDir: configDir,
        mode: 'write',
      });
      try {
        expect(() => loadWorkflowByIdentifier(aliasPath, projectDir)).toThrow(
          expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
        );
      } finally {
        writer.release();
      }
      expect(() => loadWorkflowByIdentifier(aliasPath, projectDir)).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_DISCOVERY_FAILED' }),
      );
    },
  );

  it.each([
    ['facet', 'facets/instructions/review.md'],
    ['persona', 'facets/personas/reviewer.md'],
    ['provider options', 'provider-options/safe.yaml'],
  ])('rejects a symlinked scoped %s resource', (_kind, relativePath) => {
    createProjectWorkflowWithScopedResources();
    const resourcePath = join(configDir, 'repertoire', '@owner', 'repo', relativePath);
    const outsidePath = join(projectDir, `outside-${relativePath.replaceAll('/', '-')}`);
    writeFileSync(outsidePath, 'outside');
    rmSync(resourcePath);
    symlinkSync(outsidePath, resourcePath);

    expect(() => loadWorkflowByIdentifier('scoped-resources', projectDir)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_DISCOVERY_FAILED' }),
    );
  });

  it('rejects a hard-linked scoped facet instead of parsing aliased bytes', () => {
    createProjectWorkflowWithScopedResources();
    const resourcePath = join(configDir, 'repertoire', '@owner', 'repo', 'facets', 'instructions', 'review.md');
    const outsidePath = join(projectDir, 'outside-facet.md');
    writeFileSync(outsidePath, 'outside');
    rmSync(resourcePath);
    linkSync(outsidePath, resourcePath);

    expect(() => loadWorkflowByIdentifier('scoped-resources', projectDir)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_DISCOVERY_FAILED' }),
    );
  });

  it('honors a writer held by another process for workflow discovery', async () => {
    createRepertoireWorkflow();
    createProjectWorkflowWithScopedResources();
    const readyPath = join(configDir, 'child.ready');
    const releasePath = join(configDir, 'child.release');
    const vitestEntry = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));
    const childTest = fileURLToPath(new URL('./repertoire/coordination-lease-child.test.ts', import.meta.url));
    const child = spawn(process.execPath, [vitestEntry, 'run', childTest], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TAKT_REPERTOIRE_LEASE_CHILD: '1',
        TAKT_REPERTOIRE_LEASE_CONFIG_DIR: configDir,
        TAKT_REPERTOIRE_LEASE_READY_PATH: readyPath,
        TAKT_REPERTOIRE_LEASE_RELEASE_PATH: releasePath,
      },
      stdio: 'pipe',
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(readyPath) && Date.now() < deadline) await delay(10);
      expect(existsSync(readyPath)).toBe(true);
      expect(() => listWorkflowEntries(projectDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
      expect(() => loadWorkflowByIdentifier('@owner/repo/review', projectDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
      expect(() => loadWorkflowByIdentifier('scoped-resources', projectDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
      writeFileSync(releasePath, 'release\n', { flag: 'wx', mode: 0o600 });
      const exitCode = await new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
      expect(exitCode).toBe(0);
      expect(loadWorkflowByIdentifier('@owner/repo/review', projectDir)).not.toBeNull();
    } finally {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    }
  }, 15_000);

  it('fails closed for repertoire directory and workflow symlink aliases', () => {
    const workflowPath = createRepertoireWorkflow();
    const realWorkflow = join(configDir, 'real-workflow.yaml');
    writeFileSync(realWorkflow, SAMPLE_WORKFLOW);
    rmSync(workflowPath);
    symlinkSync(realWorkflow, workflowPath);

    expect(() => listWorkflowEntries(projectDir)).toThrow(expect.objectContaining({
      code: 'WORKFLOW_DISCOVERY_FAILED',
      message: 'Workflow discovery failed',
    }));
    expect(() => loadWorkflowByIdentifier('@owner/repo/review', projectDir)).toThrow(
      expect.objectContaining({
        code: 'WORKFLOW_DISCOVERY_FAILED',
        message: 'Workflow discovery failed',
      }),
    );
  });

  it('rejects a symlinked repertoire root before discovery or direct resolution', () => {
    const outsideRepertoire = join(projectDir, 'outside-repertoire');
    const outsideWorkflows = join(outsideRepertoire, '@owner', 'repo', 'workflows');
    mkdirSync(outsideWorkflows, { recursive: true });
    writeFileSync(join(outsideWorkflows, 'review.yaml'), SAMPLE_WORKFLOW);
    symlinkSync(outsideRepertoire, join(configDir, 'repertoire'), 'dir');

    expect(() => listWorkflowEntries(projectDir)).toThrow(expect.objectContaining({
      code: 'WORKFLOW_DISCOVERY_FAILED',
      message: 'Workflow discovery failed',
    }));
    expect(() => loadWorkflowByIdentifier('@owner/repo/review', projectDir)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_DISCOVERY_FAILED' }),
    );
  });

  it('rejects a cross-root hard link even while the source root has a writer', async () => {
    const workflowsDir = join(configDir, 'repertoire', '@owner', 'repo', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const sourceRoot = mkdtempSync(join(tmpdir(), 'takt-workflow-hardlink-source-'));
    const sourceWorkflows = join(sourceRoot, 'repertoire', '@owner', 'repo', 'workflows');
    mkdirSync(sourceWorkflows, { recursive: true });
    const source = join(sourceWorkflows, 'review.yaml');
    writeFileSync(source, SAMPLE_WORKFLOW);
    linkSync(source, join(workflowsDir, 'review.yaml'));
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: sourceRoot,
      mode: 'write',
    });
    try {
      expect(() => listWorkflowEntries(projectDir)).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_DISCOVERY_FAILED' }),
      );
      expect(() => loadWorkflowByIdentifier('@owner/repo/review', projectDir)).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_DISCOVERY_FAILED' }),
      );
    } finally {
      writer.release();
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it('rejects replacement after opening instead of parsing stale approved bytes', () => {
    const workflowPath = createRepertoireWorkflow();
    const backupPath = `${workflowPath}.before`;

    expect(() => withImmediateRepertoireReadPermit({
      globalConfigDir: configDir,
      operation: (permit) => {
        const context = createInternalWorkflowReadContext(configDir, permit);
        return readApprovedRepertoireWorkflowText({
          assertRead: () => assertActiveRepertoireReadPermit(permit, configDir),
          expectedRealPath: join(context.repertoireRealPath, '@owner', 'repo', 'workflows', 'review.yaml'),
          path: workflowPath,
          repertoireDir: context.repertoireDir,
        }, {
          afterOpen: () => {
            renameSync(workflowPath, backupPath);
            writeFileSync(workflowPath, SAMPLE_WORKFLOW.replace('coordinated-workflow', 'replacement'));
          },
        });
      },
    })).toThrow(expect.objectContaining({ code: 'WORKFLOW_DISCOVERY_FAILED' }));
  });

  it('rejects unsafe direct-ref option shapes before acquiring a permit or invoking hooks', () => {
    createRepertoireWorkflow();
    const coordinationDir = join(configDir, '.takt-repertoire-coordination');
    let hooks = 0;
    const accessor = Object.defineProperty({}, 'lookupCwd', {
      get: () => {
        hooks += 1;
        return projectDir;
      },
    });
    const proxy = new Proxy({ lookupCwd: projectDir }, {
      ownKeys: () => {
        hooks += 1;
        return ['lookupCwd'];
      },
    });
    const inherited = Object.create({ lookupCwd: projectDir });
    const symbol = { [Symbol('lookupCwd')]: projectDir };
    const extra = { lookupCwd: projectDir, unexpected: projectDir };

    for (const options of [accessor, proxy, inherited, symbol, extra]) {
      expect(() => loadWorkflowByIdentifier('@owner/repo/review', projectDir, options as never)).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_DISCOVERY_FAILED' }),
      );
      expect(existsSync(coordinationDir)).toBe(false);
    }
    expect(hooks).toBe(0);
  });

  it('rejects a forged repertoire filesystem capability', () => {
    createProjectWorkflowWithScopedResources();
    const forged = {
      contains: () => true,
      exists: () => true,
      isSymlink: () => false,
      readText: () => 'forged',
      realpath: (path: string) => path,
    };

    expect(() => resolveFacetByName('@owner/repo/review', 'instructions', {
      lang: 'en',
      repertoireDir: join(configDir, 'repertoire'),
      repertoireReadAccess: forged,
    })).toThrow(expect.objectContaining({ code: 'WORKFLOW_DISCOVERY_FAILED' }));
  });

  it('preserves injected inspection provenance when a valid capability belongs to another custom root', () => {
    createProjectWorkflowWithScopedResources();
    const otherRepertoire = join(projectDir, 'other-repertoire');
    const workflowDir = join(otherRepertoire, '@other', 'repo', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    let callbacks = 0;

    const result = withImmediateRepertoireReadPermit({
      globalConfigDir: configDir,
      operation: (permit) => {
        const access = createRepertoireResourceReadAccess(
          createInternalWorkflowReadContext(configDir, permit),
        );
        return resolveWorkflowProviderOptionsWithHost(
          { extends: 'preset' },
          workflowDir,
          {
            rootDir: workflowDir,
            context: {
              lang: 'en',
              workflowDir,
              repertoireDir: otherRepertoire,
              repertoireReadAccess: access,
            },
            fileAccess: {
              exists: () => { callbacks += 1; return true; },
              readText: () => { callbacks += 1; return 'codex:\n  network_access: false\n'; },
              realpath: (path) => { callbacks += 1; return path; },
            },
          },
        );
      },
    });
    expect(result).toEqual({ codex: { networkAccess: false } });
    expect(callbacks).toBe(5);
  });

  it('rejects an expired valid capability for the same root before invoking injected access', () => {
    createProjectWorkflowWithScopedResources();
    const repertoireDir = join(configDir, 'repertoire');
    const workflowDir = join(repertoireDir, '@owner', 'repo', 'workflows');
    const alternateConfigDir = mkdtempSync(join(tmpdir(), 'takt-workflow-read-alternate-config-'));
    let expiredAccess: ReturnType<typeof createRepertoireResourceReadAccess> | undefined;
    let callbacks = 0;

    withImmediateRepertoireReadPermit({
      globalConfigDir: configDir,
      operation: (permit) => {
        expiredAccess = createRepertoireResourceReadAccess(
          createInternalWorkflowReadContext(configDir, permit),
        );
      },
    });

    // The bound root is now a custom root from this process's perspective. A
    // matching minted capability must still fail closed when its permit ended.
    process.env.TAKT_CONFIG_DIR = alternateConfigDir;
    writeFileSync(join(alternateConfigDir, 'config.yaml'), 'enable_builtin_workflows: false\n');
    invalidateGlobalConfigCache();

    try {
      expect(() => resolveWorkflowProviderOptionsWithHost(
        { extends: 'safe' },
        workflowDir,
        {
          rootDir: workflowDir,
          context: {
            lang: 'en',
            workflowDir,
            repertoireDir,
            repertoireReadAccess: expiredAccess,
          },
          fileAccess: {
            exists: () => { callbacks += 1; return true; },
            readText: () => { callbacks += 1; return 'codex:\n  network_access: false\n'; },
            realpath: (path) => { callbacks += 1; return path; },
          },
        },
      )).toThrow(expect.objectContaining({ code: 'UNSAFE_STATE' }));
      expect(callbacks).toBe(0);
    } finally {
      process.env.TAKT_CONFIG_DIR = configDir;
      invalidateGlobalConfigCache();
      rmSync(alternateConfigDir, { recursive: true, force: true });
    }
  });

  it('normalizes filesystem discovery failures without path or cause leakage', () => {
    const invalidRoot = join(projectDir, 'not-a-directory');
    writeFileSync(invalidRoot, 'data');
    let failure: unknown;
    try {
      Array.from(iterateWorkflowDir(invalidRoot, 'project'));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'WORKFLOW_DISCOVERY_FAILED',
      message: 'Workflow discovery failed',
    });
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain(invalidRoot);
  });

  it('invokes warning callbacks only after releasing the repertoire read lease', () => {
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'invalid.yaml'), 'name: [invalid\n');
    const readerDir = join(configDir, '.takt-repertoire-coordination', 'readers');
    let readerClaims: string[] | undefined;

    listWorkflowEntries(projectDir, {
      onWarning: () => {
        readerClaims = readdirSync(readerDir);
      },
    });

    expect(readerClaims).toEqual([]);
  });
});
