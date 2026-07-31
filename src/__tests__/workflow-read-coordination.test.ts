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

  it('honors a writer held by another process for workflow discovery', async () => {
    createRepertoireWorkflow();
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
