/**
 * Task execution logic
 */

import type { TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import { executeWorkflow } from './workflowExecution.js';
import type {
  TaskExecutionOptions,
  ExecuteTaskOptions,
  WorkflowExecutionResult,
  TaskExecutionParallelOptions,
} from './types.js';
import { resolveTaskExecution, resolveTaskIssue } from './resolveTask.js';
import { buildTraceTaskMetadata } from './traceTaskMetadata.js';
import { postExecutionFlow } from './postExecution.js';
import {
  buildBooleanTaskResult,
  buildTaskResult,
  persistExceededTaskResult,
  persistTaskError,
  persistPrFailedTaskResult,
  persistTaskResult,
} from './taskResultHandler.js';
import { executeTaskWorkflow } from './taskWorkflowExecution.js';
import { randomUUID } from 'node:crypto';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { RunMetaManager } from './runMeta.js';

export type { TaskExecutionOptions, ExecuteTaskOptions };

export async function executeTaskWithResult(options: ExecuteTaskOptions): Promise<WorkflowExecutionResult> {
  return executeTaskWorkflow(options, executeWorkflow);
}

/**
 * Execute a single task with workflow.
 */
export async function executeTask(options: ExecuteTaskOptions): Promise<boolean> {
  const result = await executeTaskWithResult(options);
  return result.success;
}

/**
 * Execute a task: resolve clone → run workflow → auto-commit+push → remove clone → record completion.
 *
 * Shared by watch/list/retry flows to avoid duplicated
 * resolve → execute → autoCommit → complete logic.
 *
 * @returns true if the task succeeded
 */
export async function executeAndCompleteTask(
  task: TaskInfo,
  taskRunner: TaskRunner,
  cwd: string,
  taskExecutionOptions?: TaskExecutionOptions,
  parallelOptions?: TaskExecutionParallelOptions,
): Promise<boolean> {
  return executeTaskAndCompleteWithResult(
    task,
    taskRunner,
    cwd,
    executeTaskWithResult,
    taskExecutionOptions,
    parallelOptions,
  );
}

export async function executeTaskAndCompleteWithResult(
  task: TaskInfo,
  taskRunner: TaskRunner,
  cwd: string,
  taskExecutor: (options: ExecuteTaskOptions) => Promise<WorkflowExecutionResult>,
  taskExecutionOptions?: TaskExecutionOptions,
  parallelOptions?: TaskExecutionParallelOptions,
): Promise<boolean> {
  const startedAt = new Date().toISOString();
  let taskForPersistence = task;
  const taskAbortController = new AbortController();
  const externalAbortSignal = parallelOptions?.abortSignal;
  const taskAbortSignal = externalAbortSignal ? taskAbortController.signal : undefined;
  let preparationReservation: RunMetaManager | undefined;
  let preparationHandedOff = false;

  const onExternalAbort = (): void => {
    taskAbortController.abort();
  };

  if (externalAbortSignal) {
    if (externalAbortSignal.aborted) {
      taskAbortController.abort();
    } else {
      externalAbortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    // Preparation can create/reuse a worktree or copy and resolve retry
    // workflow/config state asynchronously. Publish a normal running record
    // first so apply remains blocked without holding the short mutex. Terminal
    // preparation records intentionally remain in run history for audit and
    // ordinary retention; a crash leaves `running`, which becomes STALE_RUN
    // and requires the existing explicit recovery flow instead of guessing.
    preparationReservation = new RunMetaManager(
      buildRunPaths(
        cwd,
        `project-template-preparation-${randomUUID()}`,
      ),
      task.content,
      'task-preparation',
    );
    const {
      execCwd,
      workflowIdentifier,
      isWorktree,
      taskPrompt,
      reportDirName,
      branch,
      worktreePath,
      copyWorkspacePath,
      baseBranch,
      startStep,
      retryNote,
      resumePoint,
      autoPr,
      draftPr,
      managedPr,
      shouldPublishBranchToOrigin,
      issueNumber,
      orderContent,
      maxStepsOverride,
      initialIterationOverride,
    } = await resolveTaskExecution(task, cwd, taskAbortSignal);

    const executionTask = taskRunner.updateRunningTaskExecution(task.name, {
      runSlug: reportDirName,
      ...(worktreePath ? { worktreePath } : {}),
      ...(copyWorkspacePath ? { copyWorkspacePath } : {}),
      ...(branch ? { branch } : {}),
    });
    taskForPersistence = executionTask;

    const projectRootCwd = cwd;
    const taskRunResult = await taskExecutor({
      task: taskPrompt ?? task.content,
      cwd: execCwd,
      workflowIdentifier,
      projectCwd: projectRootCwd,
      agentOverrides: taskExecutionOptions,
      startStep,
      retryNote,
      resumePoint,
      reportDirName,
      abortSignal: taskAbortSignal,
      taskPrefix: parallelOptions?.taskPrefix,
      taskColorIndex: parallelOptions?.taskColorIndex,
      taskDisplayLabel: parallelOptions?.taskDisplayLabel,
      maxStepsOverride,
      initialIterationOverride,
      currentTaskIssueNumber: issueNumber,
      traceTaskMetadata: buildTraceTaskMetadata({
        task,
        taskContent: taskPrompt ?? task.content,
        branch,
        baseBranch,
        worktreePath,
        copyWorkspacePath,
        issueNumber,
      }),
      onRunningEvidencePublished: () => {
        if (preparationHandedOff) return;
        preparationHandedOff = true;
        preparationReservation!.finalize('completed');
      },
    });

    if (taskRunResult.exceeded && taskRunResult.exceededInfo) {
      persistExceededTaskResult(taskRunner, executionTask, taskRunResult.exceededInfo, {
        worktreePath,
        copyWorkspacePath,
        branch,
      });
      return false;
    }

    const taskSuccess = taskRunResult.success;
    const completedAt = new Date().toISOString();

    let prUrl: string | undefined;
    let prFailedError: string | undefined;
    let postExecutionTaskError: string | undefined;
    if (taskSuccess && isWorktree) {
      const issues = resolveTaskIssue(issueNumber, projectRootCwd);
      const postResult = await postExecutionFlow({
        execCwd,
        projectCwd: projectRootCwd,
        task: task.name,
        branch,
        baseBranch,
        shouldCreatePr: autoPr,
        managedPr,
        shouldPublishBranchToOrigin,
        draftPr,
        workflowIdentifier,
        issues,
        orderContent,
      });
      prUrl = postResult.prUrl;
      if (postResult.prFailed) {
        prFailedError = postResult.prError;
      }
      if (postResult.taskFailed) {
        postExecutionTaskError = postResult.taskError;
      }
    }

    if (postExecutionTaskError !== undefined) {
      const taskResult = buildBooleanTaskResult({
        task: executionTask,
        taskSuccess: false,
        startedAt,
        completedAt,
        successResponse: 'Task completed successfully',
        failureResponse: postExecutionTaskError,
        worktreePath,
        copyWorkspacePath,
        branch,
      });
      persistTaskResult(taskRunner, taskResult);
      return false;
    }

    const taskResult = buildTaskResult({
      task: executionTask,
      runResult: taskRunResult,
      startedAt,
      completedAt,
      branch,
      worktreePath,
      copyWorkspacePath,
      prUrl,
    });

    if (prFailedError !== undefined) {
      persistPrFailedTaskResult(taskRunner, taskResult, prFailedError);
      return true;
    }

    persistTaskResult(taskRunner, taskResult);
    return taskRunResult.success;
  } catch (err) {
    const completedAt = new Date().toISOString();
    persistTaskError(taskRunner, taskForPersistence, startedAt, completedAt, err);
    return false;
  } finally {
    if (preparationReservation !== undefined && !preparationHandedOff) {
      preparationReservation.finalize('aborted');
    }
    if (externalAbortSignal) {
      externalAbortSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}
