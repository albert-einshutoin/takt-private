/**
 * Tests for confirmAndCreateWorktree (CLI clone confirmation flow)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
  selectOptionWithDefault: vi.fn(),
}));

vi.mock('../infra/task/git.js', () => ({
  stageAndCommit: vi.fn(),
  getCurrentBranch: vi.fn(() => 'main'),
}));

vi.mock('../infra/task/clone.js', () => ({
  checkWorktreePreflight: vi.fn(() => ({ ok: true })),
  createSharedClone: vi.fn(),
  removeClone: vi.fn(),
  resolveBaseBranch: vi.fn(() => ({ branch: 'main' })),
}));

vi.mock('../infra/task/branchList.js', () => ({
  detectDefaultBranch: vi.fn(() => 'main'),
  BranchManager: vi.fn(),
}));

vi.mock('../infra/task/autoCommit.js', () => ({
  autoCommitAndPush: vi.fn(),
}));

vi.mock('../infra/task/summarize.js', () => ({
  summarizeTaskName: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => {
  const info = vi.fn();
  return {
    info,
    error: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    header: vi.fn(),
    status: vi.fn(),
    setLogLevel: vi.fn(),
    withProgress: vi.fn(async (start, done, operation) => {
      info(start);
      const result = await operation();
      info(typeof done === 'function' ? done(result) : done);
      return result;
    }),
  };
});

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  initDebugLogger: vi.fn(),
  setVerboseConsole: vi.fn(),
  getDebugLogFile: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  initGlobalDirs: vi.fn(),
  initProjectDirs: vi.fn(),
  loadGlobalConfig: vi.fn(() => ({ logLevel: 'info' })),
}));

vi.mock('../infra/config/paths.js', () => ({
  clearPersonaSessions: vi.fn(),
  isVerboseMode: vi.fn(() => false),
}));

vi.mock('../infra/config/loaders/workflowLoader.js', () => ({
  listWorkflows: vi.fn(() => []),
}));

vi.mock('../shared/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/constants.js')>();
  return {
    ...actual,
    DEFAULT_WORKFLOW_NAME: 'default',
  };
});

vi.mock('../infra/github/issue.js', () => ({
  isIssueReference: vi.fn((s: string) => /^#\d+$/.test(s)),
  resolveIssueTask: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkForUpdates: vi.fn(),
}));

import { confirm } from '../shared/prompt/index.js';
import { checkWorktreePreflight, createSharedClone } from '../infra/task/clone.js';
import { summarizeTaskName } from '../infra/task/summarize.js';
import { info, warn } from '../shared/ui/index.js';
import { confirmAndCreateWorktree } from '../features/tasks/index.js';

const mockConfirm = vi.mocked(confirm);
const mockCheckWorktreePreflight = vi.mocked(checkWorktreePreflight);
const mockCreateSharedClone = vi.mocked(createSharedClone);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockInfo = vi.mocked(info);
const mockWarn = vi.mocked(warn);

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckWorktreePreflight.mockReturnValue({ ok: true });
});

describe('confirmAndCreateWorktree', () => {
  it('should return original cwd when user declines clone creation', async () => {
    // Given: user says "no" to clone creation
    mockConfirm.mockResolvedValue(false);

    // When
    const result = await confirmAndCreateWorktree('/project', 'fix-auth');

    // Then
    expect(result.execCwd).toBe('/project');
    expect(result.isWorktree).toBe(false);
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(mockSummarizeTaskName).not.toHaveBeenCalled();
  });

  it('should create shared clone and return clone path when user confirms', async () => {
    // Given: user says "yes" to clone creation
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('fix-auth');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-fix-auth',
      branch: 'takt/20260128T0504-fix-auth',
    });

    // When
    const result = await confirmAndCreateWorktree('/project', 'fix-auth');

    // Then
    expect(result.execCwd).toBe('/project/../20260128T0504-fix-auth');
    expect(result.isWorktree).toBe(true);
    expect(mockSummarizeTaskName).toHaveBeenCalledWith('fix-auth', { cwd: '/project' });
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', {
      worktree: true,
      taskSlug: 'fix-auth',
    });
  });

  it('should display clone info when created', async () => {
    // Given
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('my-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-my-task',
      branch: 'takt/20260128T0504-my-task',
    });

    // When
    await confirmAndCreateWorktree('/project', 'my-task');

    // Then
    expect(mockInfo).toHaveBeenCalledWith(
      'Clone created: /project/../20260128T0504-my-task (branch: takt/20260128T0504-my-task)'
    );
  });

  it('should call confirm with default=true', async () => {
    // Given
    mockConfirm.mockResolvedValue(false);

    // When
    await confirmAndCreateWorktree('/project', 'task');

    // Then
    expect(mockConfirm).toHaveBeenCalledWith('Create worktree?', true);
  });

  it('should summarize Japanese task name to English slug', async () => {
    // Given: Japanese task name, AI summarizes to English
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('add-auth');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-add-auth',
      branch: 'takt/20260128T0504-add-auth',
    });

    // When
    await confirmAndCreateWorktree('/project', '認証機能を追加する');

    // Then
    expect(mockSummarizeTaskName).toHaveBeenCalledWith('認証機能を追加する', { cwd: '/project' });
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', {
      worktree: true,
      taskSlug: 'add-auth',
    });
  });

  it('should show generating message when creating clone', async () => {
    // Given
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-test-task',
      branch: 'takt/20260128T0504-test-task',
    });

    // When
    await confirmAndCreateWorktree('/project', 'テストタスク');

    // Then
    expect(mockInfo).toHaveBeenCalledWith('Generating branch name...');
    expect(mockInfo).toHaveBeenCalledWith('Branch name generated: test-task');
  });

  it('should skip prompt when override is false', async () => {
    const result = await confirmAndCreateWorktree('/project', 'task', false);

    expect(result.execCwd).toBe('/project');
    expect(result.isWorktree).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should skip prompt when override is true and still create clone', async () => {
    mockSummarizeTaskName.mockResolvedValue('task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-task',
      branch: 'takt/20260128T0504-task',
    });

    const result = await confirmAndCreateWorktree('/project', 'task', true);

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(result.isWorktree).toBe(true);
  });

  it('should ask to run in the current directory when worktree preflight fails interactively', async () => {
    mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mockCheckWorktreePreflight.mockReturnValueOnce({
      ok: false,
      reason: 'not_git_repository',
      message: 'Git repository is not initialized.',
    });

    const result = await confirmAndCreateWorktree('/project', 'fix auth');

    expect(result).toEqual({ execCwd: '/project', isWorktree: false });
    expect(mockConfirm).toHaveBeenNthCalledWith(1, 'Create worktree?', true);
    expect(mockConfirm).toHaveBeenNthCalledWith(2, 'Run in the current directory instead?', true);
    expect(mockWarn).toHaveBeenCalledWith(
      'Git repository is not initialized. Worktree execution requires a Git repository with at least one commit.'
    );
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(mockSummarizeTaskName).not.toHaveBeenCalled();
  });

  it('should cancel interactive worktree creation when fallback is declined', async () => {
    mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockCheckWorktreePreflight.mockReturnValueOnce({
      ok: false,
      reason: 'no_commits',
      message: 'Git repository has no commits yet.',
    });

    const result = await confirmAndCreateWorktree('/project', 'fix auth');

    expect(result).toEqual({ execCwd: '/project', isWorktree: false, cancelled: true });
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(mockSummarizeTaskName).not.toHaveBeenCalled();
  });

  it('should fall back without prompting when override=true and worktree preflight fails', async () => {
    mockCheckWorktreePreflight.mockReturnValueOnce({
      ok: false,
      reason: 'no_commits',
      message: 'Git repository has no commits yet.',
    });

    const result = await confirmAndCreateWorktree('/project', 'fix auth', true);

    expect(result).toEqual({ execCwd: '/project', isWorktree: false });
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'Git repository has no commits yet. Worktree execution requires a Git repository with at least one commit.'
    );
    expect(mockWarn).toHaveBeenCalledWith(
      'Running in the current directory instead. Use --skip-git for explicit in-place pipeline execution or create an initial commit to enable worktrees.'
    );
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(mockSummarizeTaskName).not.toHaveBeenCalled();
  });

  it('should pass branchOverride to createSharedClone', async () => {
    // Given: branchOverride provided (e.g., PR head branch)
    mockSummarizeTaskName.mockResolvedValue('fix-auth');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-fix-auth',
      branch: 'fix/pr-branch',
    });

    // When
    await confirmAndCreateWorktree('/project', 'fix auth', true, 'fix/pr-branch');

    // Then
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', expect.objectContaining({
      branch: 'fix/pr-branch',
    }));
  });

  it('should not pass branch to createSharedClone when branchOverride is omitted', async () => {
    // Given: no branchOverride
    mockSummarizeTaskName.mockResolvedValue('fix-auth');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-fix-auth',
      branch: 'takt/20260128T0504-fix-auth',
    });

    // When
    await confirmAndCreateWorktree('/project', 'fix auth', true);

    // Then
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', {
      worktree: true,
      taskSlug: 'fix-auth',
    });
  });
});
