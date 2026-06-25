import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';

const {
  mockCreateCopyWorkspaceAbortable,
  mockResolveWorkflowConfigValue,
  mockResolveConfigValue,
  mockWithProgress,
} = vi.hoisted(() => ({
  mockCreateCopyWorkspaceAbortable: vi.fn(),
  mockResolveWorkflowConfigValue: vi.fn(),
  mockResolveConfigValue: vi.fn(),
  mockWithProgress: vi.fn(async (_start: string, _done: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/task/index.js')>();
  return {
    ...actual,
    createCopyWorkspaceAbortable: (...args: unknown[]) => mockCreateCopyWorkspaceAbortable(...args),
  };
});

vi.mock('../infra/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/index.js')>();
  return {
    ...actual,
    loadWorkflowByIdentifier: vi.fn(),
    resolveWorkflowCallTarget: vi.fn(),
    resolveWorkflowConfigValue: (...args: unknown[]) => mockResolveWorkflowConfigValue(...args),
  };
});

vi.mock('../infra/config/resolveConfigValue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveConfigValue: (...args: unknown[]) => mockResolveConfigValue(...args),
}));

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  warn: vi.fn(),
  withProgress: (...args: unknown[]) => mockWithProgress(...args),
}));

import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';

function makeTask(data: NonNullable<TaskInfo['data']>): TaskInfo {
  return {
    filePath: '/project/.takt/tasks.yaml',
    name: 'copy-task',
    slug: 'copy-task',
    content: data.task,
    createdAt: '2026-06-25T00:00:00.000Z',
    status: 'running',
    data,
  };
}

describe('resolveTaskExecution copy workspace isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveWorkflowConfigValue.mockReturnValue(undefined);
    mockResolveConfigValue.mockReturnValue(undefined);
    mockCreateCopyWorkspaceAbortable.mockResolvedValue({ path: '/tmp/takt-workspaces/20260625-copy-task-000001' });
  });

  it('creates a copy workspace and executes from the copied directory without branch/worktree metadata', async () => {
    const result = await resolveTaskExecution(makeTask({
      task: 'Run in a copy',
      workflow: 'unit-workflow',
      isolation: 'copy',
    }), '/project');

    expect(mockCreateCopyWorkspaceAbortable).toHaveBeenCalledWith(
      '/project',
      { taskSlug: 'copy-task' },
      undefined,
    );
    expect(result.execCwd).toBe('/tmp/takt-workspaces/20260625-copy-task-000001');
    expect(result.copyWorkspacePath).toBe('/tmp/takt-workspaces/20260625-copy-task-000001');
    expect(result.isWorktree).toBe(false);
    expect(result.branch).toBeUndefined();
    expect(result.worktreePath).toBeUndefined();
    expect(result.autoPr).toBe(false);
    expect(result.shouldPublishBranchToOrigin).toBe(false);
  });

  it('rejects git-backed task options before creating a copy workspace', async () => {
    await expect(resolveTaskExecution(makeTask({
      task: 'Run in a copy',
      workflow: 'unit-workflow',
      isolation: 'copy',
      auto_pr: true,
    }), '/project')).rejects.toThrow('copy workspace does not support auto_pr');

    expect(mockCreateCopyWorkspaceAbortable).not.toHaveBeenCalled();
  });
});
