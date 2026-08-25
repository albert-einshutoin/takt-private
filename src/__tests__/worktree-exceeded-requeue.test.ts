import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// --- Mock setup ---

const { loadWorkflowByIdentifierMock } = vi.hoisted(() => ({
  loadWorkflowByIdentifierMock: vi.fn(),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/index.js')>();
  return {
    ...actual,
    loadWorkflowByIdentifier: loadWorkflowByIdentifierMock,
    isWorkflowPath: vi.fn().mockReturnValue(false),
    resolveWorkflowConfigValues: vi.fn().mockReturnValue({}),
    resolveWorkflowConfigValue: vi.fn().mockReturnValue(undefined),
  };
});

vi.mock('../infra/config/loaders/workflowResolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/loaders/workflowResolver.js')>();
  return {
    ...actual,
    // Runtime execution deliberately uses the internal context-aware loader;
    // keep this behavioral fixture bound to the same workflow mock authority.
    loadWorkflowByIdentifierWithReadContext: loadWorkflowByIdentifierMock,
  };
});

vi.mock('../infra/config/resolveConfigValue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveProviderOptionsWithTrace: vi.fn().mockReturnValue({
    value: undefined,
    source: 'global',
    originResolver: () => 'default',
  }),
}));

vi.mock('../features/tasks/execute/workflowExecution.js', () => ({
  executeWorkflow: vi.fn(),
}));

vi.mock('../features/tasks/execute/postExecution.js', () => ({
  postExecutionFlow: vi.fn(),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/task/index.js')>();
  return {
    ...actual,
    checkWorktreePreflight: vi.fn(),
    createSharedCloneAbortable: vi.fn(),
    detectDefaultBranch: vi.fn(),
    summarizeTaskName: vi.fn(),
  };
});

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  withProgress: vi.fn().mockImplementation(
    async (_startMsg: string, _successFn: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

// --- Imports ---

import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import { postExecutionFlow } from '../features/tasks/execute/postExecution.js';
import { loadWorkflowByIdentifier } from '../infra/config/index.js';
import { checkWorktreePreflight, createSharedCloneAbortable, detectDefaultBranch, summarizeTaskName } from '../infra/task/index.js';
import { withProgress } from '../shared/ui/index.js';
import { executeAndCompleteTask } from '../features/tasks/execute/taskExecution.js';
import { TaskRunner } from '../infra/task/runner.js';
import type { WorkflowConfig } from '../core/models/index.js';
import type { WorkflowExecutionOptions } from '../features/tasks/execute/types.js';
import { buildWorkflowGenerationWitness } from '../features/tasks/execute/workflowRetryGeneration.js';
import { snapshotWorkflowRuntimeRead } from '../features/tasks/execute/workflowRuntimeReadBoundary.js';

// --- Helpers ---

function createTestDir(): string {
  const dir = join(tmpdir(), `takt-worktree-requeue-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function loadTasksFile(testDir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(testDir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

function writeExceededRecord(testDir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(testDir, '.takt'), { recursive: true });
  const record = {
    name: 'task-a',
    status: 'exceeded',
    content: 'Do work',
    workflow: 'test-workflow',
    created_at: '2026-02-09T00:00:00.000Z',
    started_at: '2026-02-09T00:01:00.000Z',
    completed_at: '2026-02-09T00:05:00.000Z',
    owner_pid: null,
    start_step: 'implement',
    exceeded_max_steps: 60,
    exceeded_current_iteration: 30,
    workflow_generation_witness: buildTestWorkflowGenerationWitness(
      buildTestWorkflowConfig(),
      testDir,
    ),
    ...overrides,
  };
  writeFileSync(
    join(testDir, '.takt', 'tasks.yaml'),
    stringifyYaml({ tasks: [record] }),
    'utf-8',
  );
}

function writeFailedRecord(testDir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(testDir, '.takt'), { recursive: true });
  const record = {
    name: 'task-a',
    status: 'failed',
    content: 'Do work',
    workflow: 'test-workflow',
    created_at: '2026-02-09T00:00:00.000Z',
    started_at: '2026-02-09T00:01:00.000Z',
    completed_at: '2026-02-09T00:05:00.000Z',
    owner_pid: null,
    start_step: 'implement',
    failure: {
      error: 'Boom after retry',
    },
    workflow_generation_witness: buildTestWorkflowGenerationWitness(
      buildTestWorkflowConfig(),
      testDir,
    ),
    ...overrides,
  };
  writeFileSync(
    join(testDir, '.takt', 'tasks.yaml'),
    stringifyYaml({ tasks: [record] }),
    'utf-8',
  );
}

function buildTestWorkflowConfig(): WorkflowConfig {
  return {
    name: 'test-workflow',
    maxSteps: 30,
    initialStep: 'plan',
    steps: [
      {
        name: 'plan',
        persona: '../personas/plan.md',
        personaDisplayName: 'plan',
        instruction: 'Run plan',
        passPreviousResponse: true,
        rules: [],
      },
    ],
  };
}

function buildTestWorkflowGenerationWitness(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd = projectCwd,
): string {
  return snapshotWorkflowRuntimeRead({
    snapshot: (readContext) => buildWorkflowGenerationWitness(
      workflow,
      projectCwd,
      lookupCwd,
      readContext,
    ),
  });
}

function applyDefaultMocks(): void {
  vi.mocked(loadWorkflowByIdentifier).mockReturnValue(buildTestWorkflowConfig());
  vi.mocked(checkWorktreePreflight).mockReturnValue({ ok: true });
  vi.mocked(detectDefaultBranch).mockReturnValue('main');
  vi.mocked(postExecutionFlow).mockResolvedValue({ prUrl: undefined, prFailed: false });
  vi.mocked(withProgress).mockImplementation(
    async (_startMsg: string, _successFn: unknown, fn: () => Promise<unknown>) => fn(),
  );
}

// --- Tests ---

describe('シナリオ1・2: exceeded status transition via executeAndCompleteTask', () => {
  let testDir: string;
  let runner: TaskRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    applyDefaultMocks();
    testDir = createTestDir();
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('scenario 1: task transitions to exceeded status when executeWorkflow returns exceeded result', async () => {
    runner.addTask('Do work', { workflow: 'test-workflow' });
    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executeWorkflow).mockResolvedValueOnce({
      success: false,
      exceeded: true,
      exceededInfo: {
        currentStep: 'implement',
        newMaxSteps: 60,
        currentIteration: 30,
      },
    });

    const result = await executeAndCompleteTask(task, runner, testDir);

    expect(result).toBe(false);

    const exceededTasks = runner.listExceededTasks();
    expect(exceededTasks).toHaveLength(1);
    expect(exceededTasks[0]?.kind).toBe('exceeded');
    expect(exceededTasks[0]?.name).toBe(task.name);
  });

  it('scenario 2: exceeded metadata is recorded in tasks.yaml for resumption', async () => {
    const resumePoint = {
      version: 1 as const,
      stack: [
        { workflow: 'test-workflow', step: 'delegate', kind: 'workflow_call' as const },
        { workflow: 'takt/coding', step: 'review', kind: 'agent' as const },
      ],
      iteration: 30,
      elapsed_ms: 183245,
    };
    runner.addTask('Do work', { workflow: 'test-workflow' });
    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executeWorkflow).mockResolvedValueOnce({
      success: false,
      exceeded: true,
      exceededInfo: {
        currentStep: 'implement',
        newMaxSteps: 60,
        currentIteration: 30,
        resumePoint,
      },
    });

    await executeAndCompleteTask(task, runner, testDir);

    const file = loadTasksFile(testDir);
    const exceededRecord = file.tasks[0];
    expect(exceededRecord?.status).toBe('exceeded');
    expect(exceededRecord?.start_movement).toBe('implement');
    expect(exceededRecord?.start_step).toBeUndefined();
    expect(exceededRecord?.exceeded_max_steps).toBe(60);
    expect(exceededRecord?.exceeded_current_iteration).toBe(30);
    expect(exceededRecord?.resume_point).toEqual(resumePoint);
  });

  it('scenario 5: first exceed on worktree task persists worktree_path and branch in tasks.yaml', async () => {
    const cloneDir = join(testDir, '.takt', 'worktrees', `first-exceed-${randomUUID()}`);
    mkdirSync(cloneDir, { recursive: true });
    vi.mocked(summarizeTaskName).mockResolvedValueOnce('slug-562');
    vi.mocked(createSharedCloneAbortable).mockResolvedValueOnce({
      path: cloneDir,
      branch: 'takt/slug-562',
    });

    runner.addTask('Do work', { workflow: 'test-workflow', worktree: true });
    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executeWorkflow).mockResolvedValueOnce({
      success: false,
      exceeded: true,
      exceededInfo: {
        currentStep: 'implement',
        newMaxSteps: 60,
        currentIteration: 30,
      },
    });

    await executeAndCompleteTask(task, runner, testDir);

    const file = loadTasksFile(testDir);
    const rec = file.tasks[0];
    expect(rec?.status).toBe('exceeded');
    expect(rec?.worktree_path).toBe(cloneDir);
    expect(rec?.branch).toBe('takt/slug-562');
  });
});

describe('シナリオ3・4: requeue → re-execution passes exceeded metadata to executeWorkflow', () => {
  let testDir: string;
  let cloneDir: string;
  let runner: TaskRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    applyDefaultMocks();
    testDir = createTestDir();
    cloneDir = join(testDir, '.takt', 'worktrees', `existing-${randomUUID()}`);
    mkdirSync(cloneDir, { recursive: true });
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    for (const dir of [testDir, cloneDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('scenario 3: maxStepsOverride and initialIterationOverride are passed to executeWorkflow after requeue', async () => {
    writeExceededRecord(testDir, {
      worktree: true,
      worktree_path: cloneDir,
      exceeded_max_steps: 60,
      exceeded_current_iteration: 30,
    });

    runner.requeueExceededTask('task-a');

    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executeWorkflow).mockResolvedValueOnce({ success: true });

    await executeAndCompleteTask(task, runner, testDir);

    expect(vi.mocked(executeWorkflow)).toHaveBeenCalledOnce();
    const capturedOptions = vi.mocked(executeWorkflow).mock.calls[0]![3] as WorkflowExecutionOptions;
    expect(capturedOptions.maxStepsOverride).toBe(60);
    expect(capturedOptions.initialIterationOverride).toBe(30);
  });

  it('scenario 4: startStep is passed so re-execution resumes from the exceeded step', async () => {
    writeExceededRecord(testDir, {
      worktree: true,
      worktree_path: cloneDir,
      exceeded_max_steps: 60,
      exceeded_current_iteration: 30,
      start_step: 'implement',
    });

    runner.requeueExceededTask('task-a');

    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executeWorkflow).mockResolvedValueOnce({ success: true });

    await executeAndCompleteTask(task, runner, testDir);

    expect(vi.mocked(executeWorkflow)).toHaveBeenCalledOnce();
    const capturedOptions = vi.mocked(executeWorkflow).mock.calls[0]![3] as WorkflowExecutionOptions;
    expect(capturedOptions.startStep).toBe('implement');
  });

  it('scenario 7: failed requeue raises maxStepsOverride beyond the restored iteration', async () => {
    const generationA = {
      ...buildTestWorkflowConfig(),
      maxSteps: 50,
    };
    vi.mocked(loadWorkflowByIdentifier).mockReturnValue(generationA);
    const resumePoint = {
      version: 1 as const,
      stack: [
        { workflow: 'test-workflow', step: 'plan', kind: 'agent' as const },
      ],
      iteration: 51,
      elapsed_ms: 183245,
    };
    writeFailedRecord(testDir, {
      worktree: true,
      worktree_path: cloneDir,
      resume_point: resumePoint,
      workflow_generation_witness: buildTestWorkflowGenerationWitness(generationA, testDir, cloneDir),
    });

    runner.requeueTask('task-a', ['failed'], 'plan', undefined, resumePoint);

    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executeWorkflow).mockResolvedValueOnce({ success: true });

    await executeAndCompleteTask(task, runner, testDir);

    expect(vi.mocked(executeWorkflow)).toHaveBeenCalledOnce();
    const capturedOptions = vi.mocked(executeWorkflow).mock.calls[0]![3] as WorkflowExecutionOptions;
    expect(capturedOptions.initialIterationOverride).toBe(51);
    expect(capturedOptions.maxStepsOverride).toBe(100);
  });

  it('scenario 6: re-execution trims workflow_call resume_point to the root step when the child no longer resolves', async () => {
    const generationA: WorkflowConfig = {
      name: 'test-workflow',
      maxSteps: 30,
      initialStep: 'delegate',
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          instruction: '',
          personaDisplayName: 'delegate',
          passPreviousResponse: true,
          rules: [],
        },
      ],
    };
    vi.mocked(loadWorkflowByIdentifier).mockReturnValue(generationA);
    writeExceededRecord(testDir, {
      worktree: true,
      worktree_path: cloneDir,
      start_step: 'delegate',
      resume_point: {
        version: 1,
        stack: [
          { workflow: 'test-workflow', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'review', kind: 'agent' },
        ],
        iteration: 30,
        elapsed_ms: 183245,
      },
      workflow_generation_witness: buildTestWorkflowGenerationWitness(generationA, testDir, cloneDir),
    });

    runner.requeueExceededTask('task-a');

    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executeWorkflow).mockResolvedValueOnce({ success: true });

    await executeAndCompleteTask(task, runner, testDir);

    const capturedOptions = vi.mocked(executeWorkflow).mock.calls[0]![3] as WorkflowExecutionOptions;
    expect(capturedOptions.startStep).toBe('delegate');
    expect(capturedOptions.resumePoint).toEqual({
      version: 1,
      stack: [
        { workflow: 'test-workflow', step: 'delegate', kind: 'workflow_call' },
      ],
      iteration: 30,
      elapsed_ms: 183245,
    });
  });

  it('preserves generation A retry metadata when B is rejected before run meta publication', async () => {
    const generationA = buildTestWorkflowConfig();
    const generationB: WorkflowConfig = {
      ...generationA,
      steps: generationA.steps.map((step) => ({
        ...step,
        instruction: 'Generation B instruction',
      })),
    };
    const resumePoint = {
      version: 1 as const,
      stack: [{ workflow: 'test-workflow', step: 'plan', kind: 'agent' as const }],
      iteration: 30,
      elapsed_ms: 183245,
    };
    const witnessA = buildTestWorkflowGenerationWitness(generationA, testDir, cloneDir);
    writeExceededRecord(testDir, {
      worktree: true,
      worktree_path: cloneDir,
      resume_point: resumePoint,
      workflow_generation_witness: witnessA,
    });
    vi.mocked(loadWorkflowByIdentifier).mockReturnValue(generationB);

    runner.requeueExceededTask('task-a');
    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    await expect(executeAndCompleteTask(task, runner, testDir)).resolves.toBe(false);

    expect(vi.mocked(executeWorkflow)).not.toHaveBeenCalled();
    const [record] = loadTasksFile(testDir).tasks;
    expect(record?.status).toBe('failed');
    expect(record?.resume_point).toEqual(resumePoint);
    expect(record?.workflow_generation_witness).toBe(witnessA);
    expect(record?.exceeded_current_iteration).toBe(30);
    expect(record?.exceeded_max_steps).toBe(60);
    expect(record?.run_slug).toBeUndefined();
  });
});
