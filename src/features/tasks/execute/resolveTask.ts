import {
  loadWorkflowByIdentifier,
  resolveWorkflowCallTarget,
  resolveWorkflowConfigValue,
} from '../../../infra/config/index.js';
import {
  type TaskInfo,
  checkWorktreePreflight,
  createCopyWorkspaceAbortable,
  createSharedCloneAbortable,
  resolveBaseBranch,
  branchExists,
  summarizeTaskName,
  resolveTaskWorkflowValue,
  resolveTaskStartStepValue,
  TaskExecutionConfigSchema,
} from '../../../infra/task/index.js';
import type { WorkflowConfig, WorkflowResumePoint } from '../../../core/models/index.js';
import { trimResumePointStackForWorkflow } from '../../../core/workflow/run/resume-point.js';
import { getGitProvider, type Issue } from '../../../infra/git/index.js';
import { warn, withProgress } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { generateReportDir } from '../../../shared/utils/reportDir.js';
import { generateExecutionReportDir } from '../../../core/workflow/run/run-slug.js';
import { getTaskSlugFromTaskDir } from '../../../shared/utils/taskPaths.js';
import { resolveConfigValue } from '../../../infra/config/resolveConfigValue.js';
import { stageTaskSpecForExecution } from './taskSpecContext.js';
import { resolveReusedWorktreeExecution } from './reusedWorktree.js';

const log = createLogger('task');

function resolveTaskDataBaseBranch(taskData: TaskInfo['data']): string | undefined {
  return taskData?.base_branch;
}

function resolveTaskBaseBranch(projectDir: string, taskData: TaskInfo['data']): string {
  const preferredBaseBranch = resolveTaskDataBaseBranch(taskData);
  return resolveBaseBranch(projectDir, preferredBaseBranch).branch;
}

export interface ResolvedTaskExecution {
  execCwd: string;
  workflowIdentifier: string;
  isWorktree: boolean;
  reportDirName: string;
  taskPrompt?: string;
  orderContent?: string;
  branch?: string;
  worktreePath?: string;
  copyWorkspacePath?: string;
  baseBranch?: string;
  startStep?: string;
  retryNote?: string;
  resumePoint?: WorkflowResumePoint;
  autoPr: boolean;
  draftPr: boolean;
  managedPr: boolean;
  shouldPublishBranchToOrigin: boolean;
  issueNumber?: number;
  maxStepsOverride?: number;
  initialIterationOverride?: number;
}

function resolveRetryResume(
  workflowConfig: WorkflowConfig | null | undefined,
  projectCwd: string,
  lookupCwd: string,
  configuredStartStep: string | undefined,
  resumePoint: WorkflowResumePoint | undefined,
): {
  startStep?: string;
  resumePoint?: WorkflowResumePoint;
} {
  if (!resumePoint) {
    return configuredStartStep ? { startStep: configuredStartStep } : {};
  }

  if (!workflowConfig) {
    return {
      ...(configuredStartStep ? { startStep: configuredStartStep } : {}),
    };
  }

  const resolvedResumePoint = trimResumePointStackForWorkflow({
    workflow: workflowConfig,
    resumePoint,
    resolveWorkflowCall: (parentWorkflow, step) => resolveWorkflowCallTarget(
      parentWorkflow,
      step.call,
      step.name,
      projectCwd,
      lookupCwd,
    ),
  });
  const rootEntry = resolvedResumePoint?.stack[0];
  if (rootEntry) {
    return {
      startStep: rootEntry.step,
      resumePoint: resolvedResumePoint,
    };
  }

  return {
    ...(configuredStartStep ? { startStep: configuredStartStep } : {}),
  };
}

function resolveWorkflowMaxSteps(workflowConfig: WorkflowConfig | null | undefined): number | undefined {
  const maxSteps = workflowConfig?.maxSteps;
  return typeof maxSteps === 'number' && Number.isFinite(maxSteps) && maxSteps > 0
    ? maxSteps
    : undefined;
}

function resolveRetryMaxStepsOverride(
  storedMaxSteps: number | undefined,
  initialIteration: number | undefined,
  workflowMaxSteps: number | undefined,
): number | undefined {
  if (initialIteration === undefined) {
    return storedMaxSteps;
  }

  const currentMaxSteps = storedMaxSteps ?? workflowMaxSteps;
  if (currentMaxSteps === undefined || initialIteration < currentMaxSteps) {
    return storedMaxSteps;
  }
  if (workflowMaxSteps === undefined) {
    return storedMaxSteps !== undefined && initialIteration >= storedMaxSteps
      ? initialIteration + 1
      : storedMaxSteps;
  }

  // Iteration-limit checks run before the next step, so the restored ceiling
  // must be strictly greater than the iteration count saved in retry metadata.
  const retryWindowCount = Math.floor(initialIteration / workflowMaxSteps) + 1;
  return Math.max(currentMaxSteps, retryWindowCount * workflowMaxSteps);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Task execution aborted');
  }
}

function assertCopyWorkspaceCompatible(taskName: string, data: TaskInfo['data']): void {
  if (!data) {
    return;
  }
  const unsupportedFields = [
    data.worktree ? 'worktree' : undefined,
    data.branch ? 'branch' : undefined,
    data.base_branch ? 'base_branch' : undefined,
    data.auto_pr === true ? 'auto_pr' : undefined,
    data.draft_pr === true ? 'draft_pr' : undefined,
    data.managed_pr === true ? 'managed_pr' : undefined,
    data.should_publish_branch_to_origin === true ? 'should_publish_branch_to_origin' : undefined,
  ].filter((field): field is string => field !== undefined);

  if (unsupportedFields.length > 0) {
    throw new Error(`Task "${taskName}" copy workspace does not support ${unsupportedFields.join(', ')}.`);
  }
}

function shouldUseWorktree(data: TaskInfo['data']): boolean {
  return (data?.worktree !== undefined && data.worktree !== false)
    || data?.isolation === 'worktree';
}

export function resolveTaskIssue(issueNumber: number | undefined, projectCwd: string): Issue[] | undefined {
  if (issueNumber === undefined) {
    return undefined;
  }

  const gitProvider = getGitProvider();
  const cliStatus = gitProvider.checkCliStatus(projectCwd);
  if (!cliStatus.available) {
    log.info('VCS CLI unavailable, skipping issue resolution for PR body', { issueNumber });
    return undefined;
  }

  try {
    const issue = gitProvider.fetchIssue(issueNumber, projectCwd);
    return [issue];
  } catch (e) {
    log.info('Failed to fetch issue for PR body, continuing without issue info', { issueNumber, error: getErrorMessage(e) });
    return undefined;
  }
}

export async function resolveTaskExecution(
  task: TaskInfo,
  defaultCwd: string,
  abortSignal?: AbortSignal,
): Promise<ResolvedTaskExecution> {
  throwIfAborted(abortSignal);

  const data = task.data;
  if (!data) {
    throw new Error(`Task "${task.name}" is missing required data, including workflow.`);
  }

  const validationData = { ...data } as Record<string, unknown>;
  delete validationData.task;
  delete validationData.baseBranch;
  const normalizedData = TaskExecutionConfigSchema.parse(validationData) as Record<string, unknown>;
  const workflowIdentifier = resolveTaskWorkflowValue(normalizedData);
  if (!workflowIdentifier || workflowIdentifier.trim() === '') {
    throw new Error(`Task "${task.name}" is missing required workflow.`);
  }
  const configuredStartStep = resolveTaskStartStepValue(normalizedData);
  const resumePoint = normalizedData.resume_point as WorkflowResumePoint | undefined;
  const retryNote = normalizedData.retry_note;

  let execCwd = defaultCwd;
  let isWorktree = false;
  let reportDirName: string | undefined;
  let taskPrompt: string | undefined;
  let orderContent: string | undefined;
  let branch: string | undefined;
  let worktreePath: string | undefined;
  let copyWorkspacePath: string | undefined;
  let baseBranch: string | undefined;
  const timezone = resolveConfigValue(defaultCwd, 'timezone');
  const preferredBaseBranch = resolveTaskDataBaseBranch(data);
  if (task.taskDir) {
    const taskSlug = getTaskSlugFromTaskDir(task.taskDir);
    if (!taskSlug) {
      throw new Error(`Invalid task_dir format: ${task.taskDir}`);
    }
  }

  if (data.isolation === 'copy') {
    assertCopyWorkspaceCompatible(task.name, data);
    const taskSlug = task.slug ?? await withProgress(
      'Generating workspace name...',
      (slug) => `Workspace name generated: ${slug}`,
      () => summarizeTaskName(task.content, { cwd: defaultCwd }),
    );
    throwIfAborted(abortSignal);
    const result = await withProgress(
      'Creating copy workspace...',
      (workspaceResult) => `Copy workspace created: ${workspaceResult.path}`,
      async () => createCopyWorkspaceAbortable(defaultCwd, { taskSlug }, abortSignal),
    );
    throwIfAborted(abortSignal);
    execCwd = result.path;
    copyWorkspacePath = result.path;
  } else if (shouldUseWorktree(data)) {
    throwIfAborted(abortSignal);
    const preflight = checkWorktreePreflight(defaultCwd);
    if (!preflight.ok) {
      warn(`${preflight.message} Worktree execution requires a Git repository with at least one commit.`);
      warn('Running in the current directory instead. Create an initial commit to enable worktrees.');
    } else {
      const targetBranch = data.branch;
      const needsBaseBranch = !targetBranch || !branchExists(defaultCwd, targetBranch);
      baseBranch = needsBaseBranch
        ? resolveTaskBaseBranch(defaultCwd, data)
        : preferredBaseBranch;

      const reusedWorktree = resolveReusedWorktreeExecution(
        defaultCwd,
        task,
        configuredStartStep,
        resumePoint,
        retryNote,
      );
      if (reusedWorktree) {
        execCwd = reusedWorktree.execCwd;
        branch = reusedWorktree.branch;
        worktreePath = reusedWorktree.worktreePath;
        isWorktree = reusedWorktree.isWorktree;
      } else {
        const taskSlug = task.slug ?? await withProgress(
          'Generating branch name...',
          (slug) => `Branch name generated: ${slug}`,
          () => summarizeTaskName(task.content, { cwd: defaultCwd }),
        );

        throwIfAborted(abortSignal);
        const result = await withProgress(
          'Creating clone...',
          (cloneResult) => `Clone created: ${cloneResult.path} (branch: ${cloneResult.branch})`,
          async () => createSharedCloneAbortable(defaultCwd, {
            worktree: data.worktree ?? true,
            branch: data.branch,
            ...(preferredBaseBranch ? { baseBranch: preferredBaseBranch } : {}),
            taskSlug,
            issueNumber: data.issue,
          }, abortSignal),
        );
        throwIfAborted(abortSignal);
        execCwd = result.path;
        branch = result.branch;
        worktreePath = result.path;
        isWorktree = true;
      }
    }
  }

  if (task.taskDir) {
    reportDirName = generateExecutionReportDir(execCwd, task.content, { timezone });
    const stagedTaskSpec = stageTaskSpecForExecution(defaultCwd, execCwd, task.taskDir, reportDirName);
    taskPrompt = stagedTaskSpec.taskPrompt;
    orderContent = stagedTaskSpec.orderContent;
  }

  const resolvedReportDirName = reportDirName ?? generateReportDir(task.content, { timezone });
  const needsWorkflowRetryContext = resumePoint !== undefined || data.exceeded_current_iteration !== undefined;
  const workflowConfig = needsWorkflowRetryContext
    ? loadWorkflowByIdentifier(workflowIdentifier, defaultCwd, { lookupCwd: execCwd })
    : undefined;
  const retryResume = resolveRetryResume(
    workflowConfig,
    defaultCwd,
    execCwd,
    configuredStartStep,
    resumePoint,
  );
  const resolvedRetryNote = data.retry_note;
  const initialIterationOverride = data.exceeded_current_iteration ?? retryResume.resumePoint?.iteration;
  const maxStepsOverride = resolveRetryMaxStepsOverride(
    data.exceeded_max_steps,
    initialIterationOverride,
    resolveWorkflowMaxSteps(workflowConfig),
  );

  const autoPr = data.auto_pr ?? resolveWorkflowConfigValue(defaultCwd, 'autoPr') ?? false;
  const draftPr = data.draft_pr ?? resolveWorkflowConfigValue(defaultCwd, 'draftPr') ?? false;
  const managedPr = data.managed_pr === true;
  const shouldPublishBranchToOrigin =
    normalizedData.should_publish_branch_to_origin === true || autoPr;

  return {
    execCwd,
    workflowIdentifier,
    isWorktree,
    reportDirName: resolvedReportDirName,
    autoPr,
    draftPr,
    managedPr,
    shouldPublishBranchToOrigin,
    ...(taskPrompt ? { taskPrompt } : {}),
    ...(orderContent !== undefined ? { orderContent } : {}),
    ...(branch ? { branch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(copyWorkspacePath ? { copyWorkspacePath } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(retryResume.startStep ? { startStep: retryResume.startStep } : {}),
    ...(resolvedRetryNote ? { retryNote: resolvedRetryNote } : {}),
    ...(retryResume.resumePoint ? { resumePoint: retryResume.resumePoint } : {}),
    ...(data.issue !== undefined ? { issueNumber: data.issue } : {}),
    ...(maxStepsOverride !== undefined ? { maxStepsOverride } : {}),
    ...(initialIterationOverride !== undefined ? { initialIterationOverride } : {}),
  };
}
