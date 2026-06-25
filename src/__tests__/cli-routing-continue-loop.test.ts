import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  withProgress: vi.fn(async (_start, _done, operation) => operation()),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const {
  mockGetWorkflowDescription,
  mockResolveConfigValues,
  mockResolveAgentOverrides,
  mockResolveAssistantConfigLayers,
} = vi.hoisted(() => ({
  mockGetWorkflowDescription: vi.fn(() => ({
    name: 'default',
    description: 'test workflow',
    workflowStructure: '',
    stepPreviews: [],
  })),
  mockResolveConfigValues: vi.fn(() => ({ language: 'en', interactivePreviewSteps: 3, provider: 'claude' })),
  mockResolveAgentOverrides: vi.fn(),
  mockResolveAssistantConfigLayers: vi.fn(() => ({ local: {}, global: {} })),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    checkCliStatus: vi.fn(() => ({ available: true })),
    fetchIssue: vi.fn(),
    fetchPrReviewComments: vi.fn(),
  }),
  parseIssueNumbers: vi.fn(() => []),
  formatIssueAsTask: vi.fn(),
  isIssueReference: vi.fn(),
  resolveIssueTask: vi.fn(),
  formatPrReviewAsTask: vi.fn(),
}));

vi.mock('../features/tasks/index.js', () => ({
  selectAndExecuteTask: vi.fn(),
  determineWorkflow: vi.fn(),
  saveTaskFromInteractive: vi.fn(),
  createIssueAndSaveTask: vi.fn(),
  promptLabelSelection: vi.fn().mockResolvedValue([]),
}));

vi.mock('../features/pipeline/index.js', () => ({
  executePipeline: vi.fn(),
}));

vi.mock('../features/interactive/index.js', () => ({
  interactiveMode: vi.fn(),
  selectInteractiveMode: vi.fn(() => 'assistant'),
  passthroughMode: vi.fn(),
  quietMode: vi.fn(),
  personaMode: vi.fn(),
  resolveLanguage: vi.fn(() => 'en'),
  dispatchConversationAction: vi.fn(async (
    result: { action: string },
    handlers: Record<string, (r: unknown) => unknown>,
  ) => handlers[result.action](result)),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: vi.fn(() => ({
    listAllTaskItems: vi.fn(() => []),
  })),
  isStaleRunningTask: vi.fn(() => false),
  checkoutBranch: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  getWorkflowDescription: (...args: unknown[]) => mockGetWorkflowDescription(...args),
  resolveConfigValue: vi.fn(() => undefined),
  resolveConfigValues: (...args: unknown[]) => mockResolveConfigValues(...args),
  loadPersonaSessions: vi.fn(() => ({})),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: (...args: unknown[]) => mockResolveAssistantConfigLayers(...args),
}));

const mockOpts: Record<string, unknown> = {};

vi.mock('../app/cli/program.js', () => {
  const chainable = {
    opts: vi.fn(() => mockOpts),
    argument: vi.fn().mockReturnThis(),
    action: vi.fn().mockReturnThis(),
  };
  return {
    program: chainable,
    resolvedCwd: '/test/cwd',
    pipelineMode: false,
  };
});

vi.mock('../app/cli/helpers.js', () => ({
  resolveAgentOverrides: (...args: unknown[]) => mockResolveAgentOverrides(...args),
  resolveWorkflowCliOption: vi.fn((opts: Record<string, unknown>) =>
    typeof opts.workflow === 'string' ? opts.workflow : undefined,
  ),
}));

import { info } from '../shared/ui/index.js';
import { selectAndExecuteTask, determineWorkflow } from '../features/tasks/index.js';
import { interactiveMode, quietMode, selectInteractiveMode } from '../features/interactive/index.js';
import {
  executeInteractiveDefaultActionLoop,
  type DefaultActionResult,
} from '../app/cli/routing.js';

const mockInfo = vi.mocked(info);
const mockSelectAndExecuteTask = vi.mocked(selectAndExecuteTask);
const mockDetermineWorkflow = vi.mocked(determineWorkflow);
const mockInteractiveMode = vi.mocked(interactiveMode);
const mockQuietMode = vi.mocked(quietMode);
const mockSelectInteractiveMode = vi.mocked(selectInteractiveMode);

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mockOpts)) {
    delete mockOpts[key];
  }
  mockDetermineWorkflow.mockResolvedValue('default');
  mockInteractiveMode.mockResolvedValue({ action: 'execute', task: 'first task' });
  mockQuietMode.mockResolvedValue({ action: 'execute', task: 'quiet task' });
  mockSelectInteractiveMode.mockResolvedValue('assistant');
  mockSelectAndExecuteTask.mockResolvedValue(true);
  mockResolveConfigValues.mockReturnValue({ language: 'en', interactivePreviewSteps: 3, provider: 'claude' });
  mockResolveAgentOverrides.mockReturnValue(undefined);
  mockResolveAssistantConfigLayers.mockReturnValue({ local: {}, global: {} });
});

describe('executeInteractiveDefaultActionLoop', () => {
  it('returns to the initial interactive flow when the user confirms after a completed task', async () => {
    const confirmContinue = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mockInteractiveMode
      .mockResolvedValueOnce({ action: 'execute', task: 'first task' })
      .mockResolvedValueOnce({ action: 'execute', task: 'second task' });

    await executeInteractiveDefaultActionLoop(undefined, {
      confirmContinue,
      isInteractiveTerminal: () => true,
    });

    expect(mockInteractiveMode).toHaveBeenCalledTimes(2);
    expect(mockSelectAndExecuteTask).toHaveBeenCalledTimes(2);
    expect(confirmContinue).toHaveBeenCalledTimes(2);
    expect(confirmContinue).toHaveBeenCalledWith('Continue?', true);
    expect(mockInfo).toHaveBeenCalledWith('Task completed');
  });

  it('asks whether to continue after a failed interactive task without exiting', async () => {
    const confirmContinue = vi.fn().mockResolvedValueOnce(false);
    mockSelectAndExecuteTask.mockResolvedValueOnce(false);

    await executeInteractiveDefaultActionLoop(undefined, {
      confirmContinue,
      isInteractiveTerminal: () => true,
    });

    expect(confirmContinue).toHaveBeenCalledWith('Continue?', true);
    expect(mockInfo).toHaveBeenCalledWith('Task failed');
  });

  it('does not prompt after a direct --task one-shot execution', async () => {
    const confirmContinue = vi.fn();
    mockOpts.task = 'run once';

    await executeInteractiveDefaultActionLoop(undefined, {
      confirmContinue,
      isInteractiveTerminal: () => true,
    });

    expect(mockSelectAndExecuteTask).toHaveBeenCalledTimes(1);
    expect(confirmContinue).not.toHaveBeenCalled();
  });

  it('keeps quiet mode as a one-shot execution path without interactive failure handling', async () => {
    const confirmContinue = vi.fn();
    mockSelectInteractiveMode.mockResolvedValueOnce('quiet');

    await executeInteractiveDefaultActionLoop(undefined, {
      confirmContinue,
      isInteractiveTerminal: () => true,
    });

    expect(mockQuietMode).toHaveBeenCalledTimes(1);
    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'quiet task',
      expect.not.objectContaining({ exitOnFailure: false }),
      undefined,
    );
    expect(confirmContinue).not.toHaveBeenCalled();
  });

  it('propagates quiet mode execution errors as one-shot failures', async () => {
    const confirmContinue = vi.fn();
    mockSelectInteractiveMode.mockResolvedValueOnce('quiet');
    mockSelectAndExecuteTask.mockRejectedValueOnce(new Error('quiet failed'));

    await expect(executeInteractiveDefaultActionLoop(undefined, {
      confirmContinue,
      isInteractiveTerminal: () => true,
    })).rejects.toThrow('quiet failed');

    expect(confirmContinue).not.toHaveBeenCalled();
  });

  it('does not prompt in non-TTY execution even when the action is otherwise continue-eligible', async () => {
    const confirmContinue = vi.fn();
    const runDefaultAction = vi.fn<() => Promise<DefaultActionResult>>()
      .mockResolvedValue({
        offerContinue: true,
        continueQuestion: 'Continue?',
        continueStatusMessage: 'Task completed',
      });

    await executeInteractiveDefaultActionLoop(undefined, {
      confirmContinue,
      isInteractiveTerminal: () => false,
      runDefaultAction,
    });

    expect(runDefaultAction).toHaveBeenCalledTimes(1);
    expect(confirmContinue).not.toHaveBeenCalled();
  });
});
