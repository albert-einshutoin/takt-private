import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { TaskRunner } from '../infra/task/index.js';

describe('copy workspace task persistence', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('persists copy_workspace_path through running and completed task records', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-copy-workspace-persist-'));
    dirs.push(projectDir);
    const runner = new TaskRunner(projectDir);
    runner.addTask('Run isolated copy', {
      workflow: 'unit-workflow',
      isolation: 'copy',
    });
    const [claimed] = runner.claimNextTasks(1);
    if (!claimed) {
      throw new Error('Expected claimed task');
    }

    const copyWorkspacePath = join(projectDir, '..', 'takt-workspaces', '2026062500000-run-isolated-copy-000001');
    const running = runner.updateRunningTaskExecution(claimed.name, {
      runSlug: '20260625-run',
      copyWorkspacePath,
    });
    runner.completeTask({
      task: running,
      success: true,
      response: 'Task completed successfully',
      executionLog: [],
      startedAt: '2026-06-25T00:00:00.000Z',
      completedAt: '2026-06-25T00:01:00.000Z',
      copyWorkspacePath,
    });

    const tasksFile = readFileSync(join(projectDir, '.takt', 'tasks.yaml'), 'utf-8');
    const parsed = parseYaml(tasksFile) as { tasks: Array<Record<string, unknown>> };
    expect(parsed.tasks[0]).toMatchObject({
      status: 'completed',
      isolation: 'copy',
      copy_workspace_path: copyWorkspacePath,
    });
    expect(runner.listAllTaskItems()[0]).toMatchObject({
      kind: 'completed',
      copyWorkspacePath,
      data: {
        isolation: 'copy',
        copy_workspace_path: copyWorkspacePath,
      },
    });
  });
});
