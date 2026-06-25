/**
 * Instruction actions for completed/failed tasks.
 *
 * Uses the existing worktree (clone) for conversation and direct re-execution.
 * The worktree is preserved after initial execution, so no clone creation is needed.
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  TaskRunner,
  detectDefaultBranch,
} from '../../../infra/task/index.js';
import { resolveWorkflowConfigValues, getWorkflowDescription } from '../../../infra/config/index.js';
import { info, warn, error as logError } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { runInstructMode } from './instructMode.js';
import { dispatchConversationAction } from '../../interactive/actionDispatcher.js';
import type { WorkflowContext } from '../../interactive/interactive.js';
import { resolveLanguage, findRunForTask, findPreviousOrderContent } from '../../interactive/index.js';
import { type BranchActionTarget, resolveTargetBranch } from './taskActionTarget.js';
import {
  appendRetryNote,
  DEPRECATED_PROVIDER_CONFIG_WARNING,
  hasDeprecatedProviderConfig,
  selectWorkflowWithOptionalReuse,
  selectRunSessionContext,
} from './requeueHelpers.js';
import { executeAndCompleteTask } from '../execute/taskExecution.js';
import { prepareTaskForExecution } from './prepareTaskForExecution.js';
import {
  cleanupPreparedRetryTaskSpec,
  prepareRetryTaskSpecWithAttachments,
} from './retryTaskSpecAttachments.js';

const log = createLogger('list-tasks');

interface BranchContextBase {
  baseBranch: string;
  isPrDerived: boolean;
  fallbackToDefaultBranch: boolean;
  prNumber?: number;
}

function collectBranchDiffSection(projectDir: string, baseBranch: string, branch: string): readonly string[] {
  try {
    const diffStat = execFileSync(
      'git', ['diff', '--stat', `${baseBranch}...${branch}`],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    return diffStat
      ? [`## 現在の変更内容（${baseBranch}からの差分）`, '```', diffStat, '```']
      : [];
  } catch (err) {
    log.debug('Failed to collect branch diff stat for instruction context', {
      branch,
      baseBranch,
      error: getErrorMessage(err),
    });
    return [];
  }
}

function collectBranchCommitSection(projectDir: string, baseBranch: string, branch: string): readonly string[] {
  try {
    const commitLog = execFileSync(
      'git', ['log', '--oneline', `${baseBranch}..${branch}`],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    return commitLog
      ? ['', '## コミット履歴', '```', commitLog, '```']
      : [];
  } catch (err) {
    log.debug('Failed to collect branch commit log for instruction context', {
      branch,
      baseBranch,
      error: getErrorMessage(err),
    });
    return [];
  }
}

function resolveBranchContextBase(
  projectDir: string,
  branch: string,
  target: BranchActionTarget,
): BranchContextBase {
  if (!('kind' in target)) {
    return {
      baseBranch: detectDefaultBranch(projectDir),
      isPrDerived: false,
      fallbackToDefaultBranch: false,
    };
  }

  const prNumber = target.data?.pr_number ?? target.prNumber;
  const isPrDerived = target.data?.source === 'pr_review'
    || target.source === 'pr_review'
    || prNumber !== undefined;
  if (!isPrDerived) {
    return {
      baseBranch: detectDefaultBranch(projectDir),
      isPrDerived: false,
      fallbackToDefaultBranch: false,
    };
  }

  const savedBaseBranch = target.data?.base_branch?.trim();
  if (savedBaseBranch) {
    return {
      baseBranch: savedBaseBranch,
      isPrDerived: true,
      fallbackToDefaultBranch: false,
      ...(prNumber !== undefined ? { prNumber } : {}),
    };
  }

  // PR follow-up instructions must be judged against the PR base. If older
  // task records lack that saved base, make the fallback visible in the prompt
  // so reviewers do not mistake a default-branch guess for first-party PR data.
  return {
    baseBranch: detectDefaultBranch(projectDir),
    isPrDerived: true,
    fallbackToDefaultBranch: true,
    ...(prNumber !== undefined ? { prNumber } : {}),
  };
}

function collectPrContextSection(context: BranchContextBase, branch: string): readonly string[] {
  if (!context.isPrDerived) {
    return [];
  }

  const lines = [
    '## PR Context',
    '',
    'この実行は PR 由来です。判断対象は単一コミットや現在の working tree だけではなく、PR の base から head までの累積差分です。',
    '',
    `- PR: ${context.prNumber !== undefined ? `#${context.prNumber}` : '(unknown)'}`,
    `- Base: ${context.baseBranch}`,
    `- Head: ${branch}`,
    `- Diff range: ${context.baseBranch}...${branch}`,
  ];

  if (context.fallbackToDefaultBranch) {
    lines.push(`- Base fallback: 保存済み PR base がないため、検出した default branch ${context.baseBranch} を使用しています。`);
  }

  lines.push(
    '',
    '必要な判断は現在の base...head 差分で確認してください。前回 report や review-target.md は snapshot / 参考情報であり、最新差分の代替ではありません。',
    '',
  );
  return lines;
}

function getBranchContext(projectDir: string, branch: string, target: BranchActionTarget): string {
  const contextBase = resolveBranchContextBase(projectDir, branch, target);
  const lines = [
    ...collectPrContextSection(contextBase, branch),
    ...collectBranchDiffSection(projectDir, contextBase.baseBranch, branch),
    ...collectBranchCommitSection(projectDir, contextBase.baseBranch, branch),
  ];

  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

export async function instructBranch(
  projectDir: string,
  target: BranchActionTarget,
): Promise<boolean> {
  if (!('kind' in target)) {
    throw new Error('Instruct requeue requires a task target.');
  }

  if (!target.worktreePath || !fs.existsSync(target.worktreePath)) {
    logError(`Worktree directory does not exist for task: ${target.name}`);
    return false;
  }
  const worktreePath = target.worktreePath;

  const branch = resolveTargetBranch(target);

  const globalConfig = resolveWorkflowConfigValues(projectDir, ['interactivePreviewSteps', 'language']);
  const lang = resolveLanguage(globalConfig.language);
  const matchedSlug = findRunForTask(worktreePath, target.content);
  const selectedWorkflow = await selectWorkflowWithOptionalReuse(projectDir, target.data?.workflow, worktreePath, lang);
  if (!selectedWorkflow) {
    info('Cancelled');
    return false;
  }

  const workflowDesc = getWorkflowDescription(
    selectedWorkflow,
    projectDir,
    globalConfig.interactivePreviewSteps,
    worktreePath,
  );
  const workflowContext: WorkflowContext = {
    name: workflowDesc.name,
    description: workflowDesc.description,
    workflowStructure: workflowDesc.workflowStructure,
    stepPreviews: workflowDesc.stepPreviews,
  };

  // Runs data lives in the worktree (written during previous execution)
  const runSessionContext = await selectRunSessionContext(worktreePath, lang);
  const previousOrderContent = findPreviousOrderContent(worktreePath, matchedSlug);
  if (hasDeprecatedProviderConfig(previousOrderContent)) {
    warn(DEPRECATED_PROVIDER_CONFIG_WARNING);
  }

  const branchContext = getBranchContext(projectDir, branch, target);

  const result = await runInstructMode(
    worktreePath, branchContext, branch,
    target.name, target.content, target.data?.retry_note ?? '',
    workflowContext, runSessionContext, previousOrderContent,
  );

  const executeWithInstruction = async (instruction: string): Promise<boolean> => {
    const retryNote = appendRetryNote(target.data?.retry_note, instruction);
    const preparedSpec = prepareRetryTaskSpecWithAttachments(projectDir, target.content, retryNote, result.attachments, target.taskDir);
    const taskDir = preparedSpec?.taskDirRelative;
    const runner = new TaskRunner(projectDir);
    let taskInfo: ReturnType<TaskRunner['startReExecution']>;
    try {
      taskInfo = runner.startReExecution(target.name, ['completed', 'failed'], undefined, retryNote, undefined, undefined, taskDir);
    } catch (error) {
      cleanupPreparedRetryTaskSpec(preparedSpec);
      throw error;
    }
    const taskForExecution = prepareTaskForExecution(taskInfo, selectedWorkflow);

    log.info('Starting re-execution of instructed task', {
      name: target.name,
      worktreePath,
      branch,
      workflow: selectedWorkflow,
    });

    return executeAndCompleteTask(taskForExecution, runner, projectDir);
  };

  return dispatchConversationAction(result, {
    cancel: () => {
      info('Cancelled');
      return false;
    },
    execute: async ({ task }) => executeWithInstruction(task),
    save_task: async ({ task }) => {
      const retryNote = appendRetryNote(target.data?.retry_note, task);
      const preparedSpec = prepareRetryTaskSpecWithAttachments(projectDir, target.content, retryNote, result.attachments, target.taskDir);
      const taskDir = preparedSpec?.taskDirRelative;
      const runner = new TaskRunner(projectDir);
      try {
        runner.requeueTask(target.name, ['completed', 'failed'], undefined, retryNote, undefined, undefined, taskDir);
      } catch (error) {
        cleanupPreparedRetryTaskSpec(preparedSpec);
        throw error;
      }
      info(`Task "${target.name}" has been requeued.`);
      return true;
    },
  });
}
