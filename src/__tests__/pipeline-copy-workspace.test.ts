import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockCreateCopyWorkspaceAbortable,
  mockSummarizeTaskName,
} = vi.hoisted(() => ({
  mockCreateCopyWorkspaceAbortable: vi.fn(),
  mockSummarizeTaskName: vi.fn(),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/task/index.js')>();
  return {
    ...actual,
    createCopyWorkspaceAbortable: (...args: unknown[]) => mockCreateCopyWorkspaceAbortable(...args),
    summarizeTaskName: (...args: unknown[]) => mockSummarizeTaskName(...args),
  };
});

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

import { resolveExecutionContext } from '../features/pipeline/steps.js';

describe('pipeline copy workspace isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSummarizeTaskName.mockResolvedValue('pipeline-copy');
    mockCreateCopyWorkspaceAbortable.mockResolvedValue({
      path: '/tmp/takt-workspaces/2026062500000-pipeline-copy-000001',
    });
  });

  it('creates a copy workspace instead of a branch when isolation is copy', async () => {
    const context = await resolveExecutionContext('/project', 'Do work', {
      isolation: 'copy',
      autoPr: false,
    }, undefined);

    expect(mockSummarizeTaskName).toHaveBeenCalledWith('Do work', { cwd: '/project' });
    expect(mockCreateCopyWorkspaceAbortable).toHaveBeenCalledWith('/project', { taskSlug: 'pipeline-copy' });
    expect(context).toEqual({
      execCwd: '/tmp/takt-workspaces/2026062500000-pipeline-copy-000001',
      isWorktree: false,
      copyWorkspacePath: '/tmp/takt-workspaces/2026062500000-pipeline-copy-000001',
    });
  });

  it('rejects auto-pr and branch options for copy workspace pipeline runs', async () => {
    await expect(resolveExecutionContext('/project', 'Do work', {
      isolation: 'copy',
      autoPr: true,
    }, undefined)).rejects.toThrow('copy workspace does not support auto_pr');

    await expect(resolveExecutionContext('/project', 'Do work', {
      isolation: 'copy',
      autoPr: false,
      branch: 'feature/nope',
    }, undefined)).rejects.toThrow('copy workspace does not support branch');

    expect(mockCreateCopyWorkspaceAbortable).not.toHaveBeenCalled();
  });
});
