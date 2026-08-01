import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { formatTaktRunResult, runTakt } from '../helpers/takt-runner';
import { isValidReportDirName } from '../../src/shared/utils/taskPaths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface LocalRepo {
  path: string;
  cleanup: () => void;
}

interface TaskRecord {
  name: string;
  status: 'pending' | 'running' | 'failed' | 'completed';
  owner_pid?: number | null;
  run_slug?: string;
  workflow?: string;
  failure?: {
    error?: string;
  };
}

function createLocalRepo(): LocalRepo {
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-run-recovery-'));
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, stdio: 'pipe' });
  writeFileSync(join(repoPath, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'pipe' });
  return {
    path: repoPath,
    cleanup: () => {
      rmSync(repoPath, { recursive: true, force: true });
    },
  };
}

function readTasks(tasksFile: string): TaskRecord[] {
  const raw = readFileSync(tasksFile, 'utf-8');
  const parsed = parseYaml(raw) as { tasks?: TaskRecord[] };
  return parsed.tasks ?? [];
}

interface ForcedTerminationReadinessOptions {
  repoPath: string;
  tasksFile: string;
  ownerPid: number | undefined;
  timeoutMs: number;
  intervalMs: number;
}

interface ForcedTerminationReadiness {
  ready: boolean;
  diagnostic: string;
}

function inspectForcedTerminationReadiness(
  options: ForcedTerminationReadinessOptions,
): ForcedTerminationReadiness {
  if (!Number.isSafeInteger(options.ownerPid) || (options.ownerPid ?? 0) <= 0) {
    return { ready: false, diagnostic: 'child process did not publish a valid pid' };
  }
  if (!existsSync(options.tasksFile)) {
    return { ready: false, diagnostic: 'tasks.yaml has not been published' };
  }
  let tasks: TaskRecord[];
  try {
    tasks = readTasks(options.tasksFile);
  } catch (error) {
    return {
      ready: false,
      diagnostic: `tasks.yaml was not readable: ${error instanceof Error ? error.name : 'unknown error'}`,
    };
  }
  const task = tasks.find((candidate) =>
    candidate.status === 'running' && candidate.owner_pid === options.ownerPid);
  if (task === undefined) {
    return {
      ready: false,
      diagnostic: `no running task is owned by child pid ${String(options.ownerPid)}`,
    };
  }
  if (task.run_slug === undefined || !isValidReportDirName(task.run_slug)) {
    return { ready: false, diagnostic: 'owned running task has no safe run_slug' };
  }

  // Why: status=running is published before the durable run record and before
  // the run-start mutex is released. Killing in that window tests lease
  // recovery instead of stale-task recovery and is inherently timing-racy on
  // hosted runners.
  const metaPath = join(options.repoPath, '.takt', 'runs', task.run_slug, 'meta.json');
  try {
    const meta = lstatSync(metaPath);
    if (!meta.isFile() || meta.isSymbolicLink()) {
      return { ready: false, diagnostic: 'run meta path is not a regular file' };
    }
  } catch (error) {
    return {
      ready: false,
      diagnostic: `run meta is not durable yet: ${error instanceof Error ? error.name : 'unknown error'}`,
    };
  }

  const mutexPath = join(options.repoPath, '.takt-template-state', 'run-start.lock');
  const remainingArtifacts = [
    mutexPath,
    `${mutexPath}.reclaim`,
    `${mutexPath}.reclaim.recovery`,
  ].filter((path) => existsSync(path));
  if (remainingArtifacts.length > 0) {
    return {
      ready: false,
      diagnostic: `run-start coordination still owns ${String(remainingArtifacts.length)} artifact(s)`,
    };
  }
  return {
    ready: true,
    diagnostic: `durable run ${task.run_slug} is ready for forced termination`,
  };
}

function waitForForcedTerminationReadiness(
  options: ForcedTerminationReadinessOptions,
): Promise<ForcedTerminationReadiness> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    let latest: ForcedTerminationReadiness;
    let consecutiveReadyObservations = 0;
    const poll = (): void => {
      latest = inspectForcedTerminationReadiness(options);
      if (latest.ready) {
        consecutiveReadyObservations += 1;
        // The project mutex is released just before the surrounding global
        // repertoire read permit. Requiring a second bounded observation lets
        // that synchronous release finish without inspecting or weakening the
        // repertoire coordination protocol itself.
        if (consecutiveReadyObservations >= 2) {
          resolvePromise(latest);
          return;
        }
      } else {
        consecutiveReadyObservations = 0;
      }
      if (Date.now() - startedAt >= options.timeoutMs) {
        resolvePromise({
          ready: false,
          diagnostic: `timed out after ${String(options.timeoutMs)}ms: ${latest.diagnostic}`,
        });
        return;
      }
      setTimeout(poll, options.intervalMs);
    };
    poll();
  });
}

function forceKillChildProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'pipe' });
      return;
    } catch {
      child.kill('SIGKILL');
      return;
    }
  }
  try {
    // The spawned E2E command owns a dedicated process group. Killing the
    // group prevents provider descendants from retaining repertoire leases
    // after the parent is intentionally made ungraceful.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function createPendingTasksYaml(
  count: number,
  workflowPath: string,
  prefix: string,
): string {
  const now = new Date().toISOString();
  const tasks = Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${String(index + 1)}`,
    status: 'pending' as const,
    content: `${prefix} task ${String(index + 1)}`,
    workflow: workflowPath,
    created_at: now,
    started_at: null,
    completed_at: null,
    owner_pid: null,
  }));
  return stringifyYaml({ tasks });
}

function createEnvWithoutGlobalConfig(): {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
  globalConfigPath: string;
} {
  const baseDir = mkdtempSync(join(tmpdir(), 'takt-e2e-init-flow-'));
  const globalConfigDir = join(baseDir, '.takt-global');
  const globalGitConfigPath = join(baseDir, '.gitconfig');
  const globalConfigPath = join(globalConfigDir, 'config.yaml');

  writeFileSync(
    globalGitConfigPath,
    ['[user]', '  name = TAKT E2E Test', '  email = e2e@example.com'].join('\n'),
  );

  return {
    env: {
      ...process.env,
      TAKT_CONFIG_DIR: globalConfigDir,
      GIT_CONFIG_GLOBAL: globalGitConfigPath,
      TAKT_NO_TTY: '1',
      TAKT_NOTIFY_WEBHOOK: undefined,
    },
    globalConfigPath,
    cleanup: () => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Run interrupted task cleanup and high-priority run flows', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    repo.cleanup();
    isolatedEnv.cleanup();
  });

  it('should fail stale running task generated by forced process termination', async () => {
    // Given: 2 pending tasks exist, then first run is force-killed while task is running
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-model',
      concurrency: 1,
      task_poll_interval_ms: 100,
    });

    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-slow-multi-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/run-sigint-parallel.json');
    const tasksFile = join(repo.path, '.takt', 'tasks.yaml');

    mkdirSync(join(repo.path, '.takt'), { recursive: true });
    writeFileSync(tasksFile, createPendingTasksYaml(2, workflowPath, 'recovery-target'), 'utf-8');

    const binPath = resolve(__dirname, '../../bin/takt');
    const child = spawn('node', [binPath, 'run', '--provider', 'mock'], {
      cwd: repo.path,
      detached: process.platform !== 'win32',
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let firstStdout = '';
    let firstStderr = '';
    child.stdout?.on('data', (chunk) => {
      firstStdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      firstStderr += chunk.toString();
    });

    let childClosed = false;
    const childClosedPromise = new Promise<void>((resolvePromise) => {
      child.once('close', () => {
        childClosed = true;
        resolvePromise();
      });
    });

    try {
      const terminationReadiness = await waitForForcedTerminationReadiness({
        repoPath: repo.path,
        tasksFile,
        ownerPid: child.pid,
        timeoutMs: 30_000,
        intervalMs: 20,
      });

      expect(
        terminationReadiness.ready,
        `${terminationReadiness.diagnostic}\n\nstdout:\n${firstStdout}\n\nstderr:\n${firstStderr}`,
      ).toBe(true);

      forceKillChildProcessTree(child);
      await childClosedPromise;

      const staleTasks = readTasks(tasksFile);
      const runningTask = staleTasks.find((task) => task.status === 'running');
      expect(runningTask).toBeDefined();
      expect(runningTask?.owner_pid).toBeTypeOf('number');

      const rerunResult = runTakt({
        args: ['run', '--provider', 'mock'],
        cwd: repo.path,
        env: {
          ...isolatedEnv.env,
          TAKT_MOCK_SCENARIO: scenarioPath,
        },
        timeout: 240_000,
      });

      expect(rerunResult.exitCode, formatTaktRunResult(rerunResult)).toBe(0);
      const combined = rerunResult.stdout + rerunResult.stderr;
      expect(combined).toContain('Marked 1 interrupted running task(s) as failed.');
      expect(combined).toContain('recovery-target-2');

      const finalTasks = readTasks(tasksFile);
      expect(finalTasks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'recovery-target-1',
          status: 'failed',
          owner_pid: null,
          failure: {
            error: 'Task was interrupted before this TAKT run started. Requeue it explicitly to run again.',
          },
        }),
        expect.objectContaining({
          name: 'recovery-target-2',
          status: 'completed',
          owner_pid: null,
        }),
      ]));
      expect(finalTasks).toHaveLength(2);
    } finally {
      if (!childClosed) {
        forceKillChildProcessTree(child);
        await childClosedPromise;
      }
    }
  }, 240_000);

  it('should process high-concurrency batch without leaving inconsistent task state', () => {
    // Given: 12 pending tasks with concurrency=10
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-model',
      concurrency: 10,
      task_poll_interval_ms: 100,
    });

    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
    const tasksFile = join(repo.path, '.takt', 'tasks.yaml');

    mkdirSync(join(repo.path, '.takt'), { recursive: true });
    writeFileSync(tasksFile, createPendingTasksYaml(12, workflowPath, 'parallel-load'), 'utf-8');

    // When: run all tasks
    const result = runTakt({
      args: ['run', '--provider', 'mock'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    expect(result.exitCode, formatTaktRunResult(result)).toBe(0);
    expect(result.stdout).toContain('Concurrency: 10');
    expect(result.stdout).toContain('Tasks Summary');
    const finalTasks = readTasks(tasksFile);
    expect(finalTasks).toHaveLength(12);
    expect(finalTasks).toEqual(
      expect.arrayContaining(
        Array.from({ length: 12 }, (_, index) => expect.objectContaining({
          name: `parallel-load-${String(index + 1)}`,
          status: 'completed',
          owner_pid: null,
        })),
      ),
    );
  }, 240_000);

  it('should initialize project dirs and execute tasks after add+run when global config is absent', () => {
    const envWithoutConfig = createEnvWithoutGlobalConfig();

    try {
      const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-single-step.yaml');
      const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
      const projectConfigDir = join(repo.path, '.takt');
      const projectConfigPath = join(projectConfigDir, 'config.yaml');
      mkdirSync(projectConfigDir, { recursive: true });
      writeFileSync(projectConfigPath, 'provider: mock\nmodel: mock-model\n', 'utf-8');

      expect(existsSync(envWithoutConfig.globalConfigPath)).toBe(false);

      // When: add 2 tasks and run once
      const addResult1 = runTakt({
        args: ['--provider', 'mock', '--workflow', workflowPath, 'add', 'Initialize flow task 1'],
        cwd: repo.path,
        env: {
          ...envWithoutConfig.env,
          TAKT_MOCK_SCENARIO: scenarioPath,
        },
        input: 'n\n',
        timeout: 240_000,
      });

      const addResult2 = runTakt({
        args: ['--provider', 'mock', '--workflow', workflowPath, 'add', 'Initialize flow task 2'],
        cwd: repo.path,
        env: {
          ...envWithoutConfig.env,
          TAKT_MOCK_SCENARIO: scenarioPath,
        },
        input: 'n\n',
        timeout: 240_000,
      });

      const runResult = runTakt({
        args: ['--provider', 'mock', 'run'],
        cwd: repo.path,
        env: {
          ...envWithoutConfig.env,
          TAKT_MOCK_SCENARIO: scenarioPath,
        },
        timeout: 240_000,
      });

      // Then: tasks are persisted/executed correctly and project init artifacts exist
      expect(addResult1.exitCode, formatTaktRunResult(addResult1)).toBe(0);
      expect(addResult2.exitCode, formatTaktRunResult(addResult2)).toBe(0);
      expect(runResult.exitCode, formatTaktRunResult(runResult)).toBe(0);

      const tasksFile = join(repo.path, '.takt', 'tasks.yaml');
      const parsedFinal = parseYaml(readFileSync(tasksFile, 'utf-8')) as { tasks?: TaskRecord[] };
      expect(parsedFinal.tasks).toEqual([
        expect.objectContaining({
          name: 'initialize-flow-task-1',
          summary: 'Initialize flow task 1',
          status: 'completed',
          owner_pid: null,
        }),
        expect.objectContaining({
          name: 'initialize-flow-task-2',
          summary: 'Initialize flow task 2',
          status: 'completed',
          owner_pid: null,
        }),
      ]);

      const taskDirsRoot = join(repo.path, '.takt', 'tasks');
      const taskDirs = readdirSync(taskDirsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      expect(taskDirs.length).toBe(2);

      expect(existsSync(join(projectConfigDir, '.gitignore'))).toBe(true);
      expect(existsSync(envWithoutConfig.globalConfigPath)).toBe(false);
    } finally {
      envWithoutConfig.cleanup();
    }
  }, 240_000);
});
