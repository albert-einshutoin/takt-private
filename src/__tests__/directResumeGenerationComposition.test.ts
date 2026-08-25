import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockExecuteWorkflow, mockRunDirectInstructMode } = vi.hoisted(() => ({
  mockExecuteWorkflow: vi.fn(),
  mockRunDirectInstructMode: vi.fn(),
}));

vi.mock('../features/tasks/execute/workflowExecution.js', () => ({
  executeWorkflow: (...args: unknown[]) => mockExecuteWorkflow(...args),
}));

vi.mock('../features/tasks/resume/directInstructMode.js', () => ({
  runDirectInstructMode: (...args: unknown[]) => mockRunDirectInstructMode(...args),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(async () => 'instruct'),
}));

vi.mock('../shared/ui/index.js', () => ({
  blankLine: vi.fn(),
  error: vi.fn(),
  header: vi.fn(),
  info: vi.fn(),
  status: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../features/interactive/index.js', () => ({
  formatRunSessionForPrompt: vi.fn(() => ({
    runTask: 'Generation A task',
    runWorkflow: 'default',
    runStatus: 'aborted',
    runStepLogs: '',
    runReports: '',
  })),
  loadRunSessionContext: vi.fn(() => ({ task: 'Generation A task' })),
  runDirectRetryMode: vi.fn(),
}));

import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { resumeDirectRun } from '../features/tasks/resume/index.js';
import { RunMetaManager } from '../features/tasks/execute/runMeta.js';
import { buildWorkflowGenerationWitness } from '../features/tasks/execute/workflowRetryGeneration.js';
import { acquireRepertoireCoordinationLease } from '../features/repertoire/coordination-lease.js';
import { withImmediateRepertoireReadPermit } from '../features/repertoire/read-permit.js';
import { createInternalWorkflowReadContext } from '../infra/config/loaders/workflowDiscovery.js';
import { loadWorkflowByIdentifierWithReadContext } from '../infra/config/loaders/workflowResolver.js';
import { resolveProjectTemplateRunStartMutexPath } from '../features/project-template/apply-guard.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolveConfigValue.js';

const WORKFLOW_A = `name: default
initial_step: review
max_steps: 5
steps:
  - name: review
    instruction: Generation A review
`;

const WORKFLOW_B = WORKFLOW_A.replace('Generation A review', 'Generation B review');

describe('direct resume generation composition', () => {
  let projectDir: string;
  let configDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    projectDir = mkdtempSync(join(tmpdir(), 'takt-direct-generation-'));
    configDir = join(projectDir, '.global-takt');
    mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'language: en\n');
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = originalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('rejects generation B before the real executor after an A failure and prompt delay', async () => {
    const workflowPath = join(projectDir, '.takt', 'workflows', 'default.yaml');
    writeFileSync(workflowPath, WORKFLOW_A);
    const witnessA = withImmediateRepertoireReadPermit({
      globalConfigDir: configDir,
      operation: (permit) => {
        const readContext = createInternalWorkflowReadContext(configDir, permit);
        const workflow = loadWorkflowByIdentifierWithReadContext(
          'default',
          projectDir,
          { lookupCwd: projectDir },
          readContext,
        );
        if (!workflow) throw new Error('expected generation A workflow');
        return buildWorkflowGenerationWitness(workflow, projectDir, projectDir, readContext);
      },
    });
    const runMeta = new RunMetaManager(
      buildRunPaths(projectDir, '20260801-generation-a'),
      'Generation A task',
      'default',
      undefined,
      { workflowGenerationWitness: witnessA },
    );
    runMeta.updateStep('review', 2, {
      version: 1,
      stack: [{ workflow: 'default', step: 'review', kind: 'agent' }],
      iteration: 2,
      elapsed_ms: 10,
    });
    runMeta.finalize('aborted', 2, 'generation A failure');
    mockRunDirectInstructMode.mockImplementationOnce(async () => {
      writeFileSync(workflowPath, WORKFLOW_B);
      return { action: 'execute', task: 'Continue after the prompt' };
    });

    await expect(resumeDirectRun(projectDir)).rejects.toMatchObject({
      name: 'WorkflowDiscoveryReadError',
      message: 'Workflow discovery failed',
    });

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(existsSync(resolveProjectTemplateRunStartMutexPath(projectDir))).toBe(false);
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: configDir,
      mode: 'write',
      timeoutMs: 250,
    });
    writer.release();
  });
});
