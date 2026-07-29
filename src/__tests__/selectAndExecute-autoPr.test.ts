/**
 * Tests for selectAndExecuteTask behavior in execute path
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAddTask,
  mockCompleteTask,
  mockFailTask,
  mockExecuteTask,
  mockResolveWorkflowConfigValue,
  mockBeginProjectTemplatePreparation,
  mockCompleteProjectTemplatePreparation,
  mockAbortProjectTemplatePreparation,
  mockInvalidateResolvedConfigCache,
} = vi.hoisted(() => ({
  mockAddTask: vi.fn(() => ({
    name: 'test-task',
    content: 'test task',
    filePath: '/project/.takt/tasks.yaml',
    createdAt: '2026-02-14T00:00:00.000Z',
    status: 'pending',
    data: { task: 'test task' },
  })),
  mockCompleteTask: vi.fn(),
  mockFailTask: vi.fn(),
  mockExecuteTask: vi.fn(),
  mockResolveWorkflowConfigValue: vi.fn((_: string, key: string) => (key === 'autoPr' ? undefined : 'default')),
  mockBeginProjectTemplatePreparation: vi.fn(),
  mockCompleteProjectTemplatePreparation: vi.fn(),
  mockAbortProjectTemplatePreparation: vi.fn(),
  mockInvalidateResolvedConfigCache: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowConfigValue: (...args: unknown[]) => mockResolveWorkflowConfigValue(...args),
  listWorkflows: vi.fn(() => ['default']),
  listWorkflowEntries: vi.fn(() => []),
  loadWorkflowByIdentifier: vi.fn((identifier: string) => (
    identifier === 'default'
      ? { name: 'default', sourcePath: '/project/.takt/workflows/default.yaml' }
      : null
  )),
  isWorkflowPath: vi.fn(() => false),
  invalidateResolvedConfigCache: (...args: unknown[]) =>
    mockInvalidateResolvedConfigCache(...args),
}));

vi.mock('../infra/config/loaders/workflowSourceMetadata.js', () => ({
  getWorkflowSourcePath: (workflow: { sourcePath?: string }) => workflow.sourcePath,
}));

vi.mock('../infra/task/index.js', () => ({
  createSharedClone: vi.fn(),
  autoCommitAndPush: vi.fn(),
  summarizeTaskName: vi.fn(),
  resolveBaseBranch: vi.fn(() => ({ branch: 'main' })),
  TaskRunner: vi.fn(() => ({
    addTask: (...args: unknown[]) => mockAddTask(...args),
    completeTask: (...args: unknown[]) => mockCompleteTask(...args),
    failTask: (...args: unknown[]) => mockFailTask(...args),
  })),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  withProgress: async <T>(
    _startMessage: string,
    _completionMessage: string | ((result: T) => string),
    operation: () => Promise<T>,
  ): Promise<T> => operation(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/github/index.js', () => ({
  buildPrBody: vi.fn(),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeTask: (...args: unknown[]) => mockExecuteTask(...args),
}));

vi.mock('../features/tasks/execute/projectTemplatePreparationReservation.js', () => ({
  abortProjectTemplatePreparationAfterError: (
    reservation: { abort(): void },
  ) => reservation.abort(),
  beginProjectTemplatePreparation: (...args: unknown[]) => {
    mockBeginProjectTemplatePreparation(...args);
    return {
      complete: mockCompleteProjectTemplatePreparation,
      abort: mockAbortProjectTemplatePreparation,
    };
  },
}));

vi.mock('../features/workflowSelection/index.js', () => ({
  warnMissingWorkflows: vi.fn(),
  selectWorkflowFromCategorizedWorkflows: vi.fn(),
  selectWorkflowFromEntries: vi.fn(),
  selectWorkflow: vi.fn(),
}));

import { loadWorkflowByIdentifier } from '../infra/config/index.js';
import { autoCommitAndPush } from '../infra/task/index.js';
import { selectWorkflow } from '../features/workflowSelection/index.js';
import { selectAndExecuteTask, determineWorkflow } from '../features/tasks/execute/selectAndExecute.js';
import { error } from '../shared/ui/index.js';

const mockLoadWorkflowByIdentifier = vi.mocked(loadWorkflowByIdentifier);
const mockAutoCommitAndPush = vi.mocked(autoCommitAndPush);
const mockSelectWorkflow = vi.mocked(selectWorkflow);
const mockError = vi.mocked(error);

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadWorkflowByIdentifier.mockImplementation((identifier: string) => (
    identifier === 'default'
      ? { name: 'default', sourcePath: '/project/.takt/workflows/default.yaml' }
      : null
  ) as never);
  mockExecuteTask.mockResolvedValue(true);
});

describe('selectAndExecuteTask (execute path)', () => {
  it('should execute in-place without worktree setup or PR prompts', async () => {
    await selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
    });

    expect(mockAutoCommitAndPush).not.toHaveBeenCalled();
    expect(mockAddTask).toHaveBeenCalledWith('test task', { workflow: 'default' });
    expect(mockExecuteTask).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/project', projectCwd: '/project' }),
    );
    expect(mockBeginProjectTemplatePreparation.mock.invocationCallOrder[0])
      .toBeLessThan(mockExecuteTask.mock.invocationCallOrder[0]!);
    expect(mockCompleteProjectTemplatePreparation).toHaveBeenCalledTimes(1);
    expect(mockAbortProjectTemplatePreparation).not.toHaveBeenCalled();
    expect(mockBeginProjectTemplatePreparation.mock.invocationCallOrder[0])
      .toBeLessThan(mockInvalidateResolvedConfigCache.mock.invocationCallOrder[0]!);
    expect(mockInvalidateResolvedConfigCache.mock.invocationCallOrder[0])
      .toBeLessThan(mockExecuteTask.mock.invocationCallOrder[0]!);
  });

  it('aborts before mutation when the selected workflow resolves differently after reservation', async () => {
    let reservationPublished = false;
    mockBeginProjectTemplatePreparation.mockImplementationOnce(() => {
      reservationPublished = true;
    });
    mockLoadWorkflowByIdentifier.mockImplementation((identifier: string) => ({
      name: identifier,
      sourcePath: reservationPublished
        ? '/project/.takt/workflows/replaced.yaml'
        : '/project/.takt/workflows/default.yaml',
    } as never));

    await expect(selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
    })).rejects.toThrow('workflow selection changed during preparation');

    expect(mockInvalidateResolvedConfigCache).toHaveBeenCalledWith('/project');
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockExecuteTask).not.toHaveBeenCalled();
    expect(mockAbortProjectTemplatePreparation).toHaveBeenCalledTimes(1);
  });

  it('aborts before mutation when the selected workflow disappears after reservation', async () => {
    let reservationPublished = false;
    mockBeginProjectTemplatePreparation.mockImplementationOnce(() => {
      reservationPublished = true;
    });
    mockLoadWorkflowByIdentifier.mockImplementation((identifier: string) => (
      reservationPublished
        ? null
        : {
            name: identifier,
            sourcePath: '/project/.takt/workflows/default.yaml',
          }
    ) as never);

    await expect(selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
    })).rejects.toThrow('workflow selection changed during preparation');

    expect(mockInvalidateResolvedConfigCache).toHaveBeenCalledWith('/project');
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockExecuteTask).not.toHaveBeenCalled();
    expect(mockAbortProjectTemplatePreparation).toHaveBeenCalledTimes(1);
  });

  it('preserves audited execution when a fallback workflow is unresolved before and after reservation', async () => {
    mockSelectWorkflow.mockResolvedValue('default');
    mockLoadWorkflowByIdentifier.mockReturnValue(null);
    mockExecuteTask.mockResolvedValue(false);

    await expect(selectAndExecuteTask('/project', 'test task', {
      exitOnFailure: false,
    })).resolves.toBe(false);

    expect(mockBeginProjectTemplatePreparation).toHaveBeenCalledWith({
      projectRoot: '/project',
      task: 'test task',
      workflow: 'direct-task-preparation',
    });
    expect(mockInvalidateResolvedConfigCache).toHaveBeenCalledWith('/project');
    expect(mockExecuteTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteProjectTemplatePreparation).toHaveBeenCalledTimes(1);
    expect(mockAbortProjectTemplatePreparation).not.toHaveBeenCalled();
  });

  it('publishes an aborted reservation when pre-reservation workflow parsing throws', async () => {
    mockSelectWorkflow.mockResolvedValue('default');
    mockLoadWorkflowByIdentifier
      .mockImplementationOnce(() => {
        throw new Error('broken workflow yaml');
      })
      .mockReturnValue({
        name: 'default',
        sourcePath: '/project/.takt/workflows/default.yaml',
      } as never);

    await expect(selectAndExecuteTask('/project', 'test task'))
      .rejects.toThrow('broken workflow yaml');

    expect(mockBeginProjectTemplatePreparation).toHaveBeenCalledTimes(1);
    expect(mockInvalidateResolvedConfigCache).toHaveBeenCalledWith('/project');
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockExecuteTask).not.toHaveBeenCalled();
    expect(mockAbortProjectTemplatePreparation).toHaveBeenCalledTimes(1);
  });

  it('aborts before mutation when an unresolved workflow becomes resolved after reservation', async () => {
    mockSelectWorkflow.mockResolvedValue('default');
    mockLoadWorkflowByIdentifier
      .mockReturnValueOnce(null)
      .mockReturnValue({
        name: 'default',
        sourcePath: '/project/.takt/workflows/default.yaml',
      } as never);

    await expect(selectAndExecuteTask('/project', 'test task'))
      .rejects.toThrow('workflow selection changed during preparation');

    expect(mockBeginProjectTemplatePreparation).toHaveBeenCalledTimes(1);
    expect(mockInvalidateResolvedConfigCache).toHaveBeenCalledWith('/project');
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockExecuteTask).not.toHaveBeenCalled();
    expect(mockAbortProjectTemplatePreparation).toHaveBeenCalledTimes(1);
  });

  it('does not reserve or invalidate config when workflow selection is cancelled', async () => {
    mockSelectWorkflow.mockResolvedValue(null);

    await expect(selectAndExecuteTask('/project', 'test task'))
      .resolves.toBe(false);

    expect(mockBeginProjectTemplatePreparation).not.toHaveBeenCalled();
    expect(mockInvalidateResolvedConfigCache).not.toHaveBeenCalled();
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it('should call selectWorkflow when no override is provided', async () => {
    mockSelectWorkflow.mockResolvedValue('selected-workflow');

    const selected = await determineWorkflow('/project');

    expect(selected).toBe('selected-workflow');
    expect(mockSelectWorkflow).toHaveBeenCalledWith('/project');
  });

  it('should accept repertoire scoped workflow override when it exists', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({ name: '@nrslib/takt-ensembles/critical-thinking' } as never);

    const selected = await determineWorkflow('/project', '@nrslib/takt-ensembles/critical-thinking');

    expect(selected).toBe('@nrslib/takt-ensembles/critical-thinking');
  });

  it('should use workflow terminology when override is missing', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce(undefined);

    const selected = await determineWorkflow('/project', 'missing-workflow');

    expect(selected).toBeNull();
    expect(mockError).toHaveBeenCalledWith('Workflow not found: missing-workflow');
  });

  it('should sanitize workflow override before terminal output', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce(undefined);

    const selected = await determineWorkflow('/project', 'bad\x1b[31m-workflow\n');

    expect(selected).toBeNull();
    expect(mockError).toHaveBeenCalledWith('Workflow not found: bad-workflow\\n');
  });

  it('should fail task record when executeTask throws', async () => {
    mockExecuteTask.mockRejectedValue(new Error('boom'));

    await expect(selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
    })).rejects.toThrow('boom');

    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockFailTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).not.toHaveBeenCalled();
  });

  it('should record task and complete when executeTask returns true', async () => {
    mockExecuteTask.mockResolvedValue(true);

    await selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
    });

    expect(mockAddTask).toHaveBeenCalledWith('test task', { workflow: 'default' });
    expect(mockCompleteTask).toHaveBeenCalledTimes(1);
    expect(mockFailTask).not.toHaveBeenCalled();
  });

  it('should record task and fail when executeTask returns false', async () => {
    mockExecuteTask.mockResolvedValue(false);

    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process exit');
    }) as (code?: string | number | null | undefined) => never);

    await expect(selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
    })).rejects.toThrow('process exit');

    expect(mockAddTask).toHaveBeenCalledWith('test task', { workflow: 'default' });
    expect(mockFailTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).not.toHaveBeenCalled();
    expect(mockCompleteProjectTemplatePreparation.mock.invocationCallOrder[0])
      .toBeLessThan(processExitSpy.mock.invocationCallOrder[0]!);
    processExitSpy.mockRestore();
  });
});
