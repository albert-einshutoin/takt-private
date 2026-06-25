import { info, success, error as logError } from '../../shared/ui/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { checkoutBranch } from '../../infra/task/index.js';
import { selectAndExecuteTask, determineWorkflow, saveTaskFromInteractive, createIssueAndSaveTask, promptLabelSelection, type SelectAndExecuteOptions } from '../../features/tasks/index.js';
import { executePipeline } from '../../features/pipeline/index.js';
import {
  interactiveMode,
  selectInteractiveMode,
  passthroughMode,
  quietMode,
  personaMode,
  resolveLanguage,
  dispatchConversationAction,
  type InteractiveModeResult,
} from '../../features/interactive/index.js';
import { INTERACTIVE_MODES } from '../../core/models/index.js';
import {
  getWorkflowDescription,
  resolveConfigValue,
  resolveConfigValues,
  loadPersonaSessions,
} from '../../infra/config/index.js';
import { resolvePersonaSessionId } from '../../infra/config/project/sessionStore.js';
import { resolveAssistantProviderModelFromConfig } from '../../core/config/provider-resolution.js';
import { resolveAssistantConfigLayers } from '../../features/interactive/assistantConfig.js';
import { program, resolvedCwd, pipelineMode } from './program.js';
import { resolveAgentOverrides, resolveWorkflowCliOption } from './helpers.js';
import { loadTaskHistory } from './taskHistory.js';
import { resolveIssueInput, resolvePrInput } from './routing-inputs.js';

export interface DefaultActionResult {
  offerContinue: boolean;
  continueQuestion?: string;
  continueStatusMessage?: string;
}

export interface InteractiveDefaultActionLoopOptions {
  isInteractiveTerminal?: () => boolean;
  confirmContinue?: (message: string, defaultYes: boolean) => Promise<boolean>;
  runDefaultAction?: (task?: string) => Promise<DefaultActionResult>;
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function confirmContinue(message: string, defaultYes: boolean): Promise<boolean> {
  const { confirm } = await import('../../shared/prompt/index.js');
  return confirm(message, defaultYes);
}

export async function executeInteractiveDefaultActionLoop(
  task?: string,
  options: InteractiveDefaultActionLoopOptions = {},
): Promise<void> {
  const canPrompt = options.isInteractiveTerminal ?? isInteractiveTerminal;
  const askContinue = options.confirmContinue ?? confirmContinue;
  const runDefaultAction = options.runDefaultAction ?? executeDefaultAction;
  let nextTask = task;

  while (true) {
    const result = await runDefaultAction(nextTask);
    if (!result.offerContinue || !canPrompt()) {
      return;
    }
    if (result.continueStatusMessage) {
      info(result.continueStatusMessage);
    }
    const shouldContinue = await askContinue(result.continueQuestion ?? 'Continue?', true);
    if (!shouldContinue) {
      return;
    }
    nextTask = undefined;
  }
}

export async function executeDefaultAction(task?: string): Promise<DefaultActionResult> {
  const opts = program.opts();
  if (!pipelineMode && (opts.autoPr === true || opts.draft === true)) {
    logError('--auto-pr/--draft are supported only in --pipeline mode');
    process.exit(1);
  }
  if (!pipelineMode && (opts.copyWorkspace === true || typeof opts.isolation === 'string')) {
    logError('--copy-workspace/--isolation are supported only in --pipeline mode');
    process.exit(1);
  }
  const prNumber = opts.pr as number | undefined;
  const issueNumber = opts.issue as number | undefined;

  if (prNumber && issueNumber) {
    logError('--pr and --issue cannot be used together');
    process.exit(1);
  }

  if (prNumber && (opts.task as string | undefined)) {
    logError('--pr and --task cannot be used together');
    process.exit(1);
  }
  const agentOverrides = resolveAgentOverrides(program);
  let resolvedWorkflow: string | undefined;
  try {
    resolvedWorkflow = resolveWorkflowCliOption(opts as Record<string, unknown>);
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const resolvedPipelineWorkflow = resolvedWorkflow;
  if (pipelineMode && resolvedPipelineWorkflow === undefined) {
    logError('--workflow (-w) is required in pipeline mode');
    process.exit(1);
  }
  const resolvedPipelineAutoPr = opts.autoPr === true
    ? true
    : (resolveConfigValue(resolvedCwd, 'autoPr') ?? false);
  const resolvedPipelineDraftPr = opts.draft === true
    ? true
    : (resolveConfigValue(resolvedCwd, 'draftPr') ?? false);
  const resolvedPipelineIsolation = resolvePipelineIsolation(opts as Record<string, unknown>);
  const selectOptions: SelectAndExecuteOptions = {
    workflow: resolvedWorkflow,
  };

  if (pipelineMode) {
    const exitCode = await executePipeline({
      issueNumber,
      prNumber,
      task: opts.task as string | undefined,
      workflow: resolvedPipelineWorkflow!,
      branch: opts.branch as string | undefined,
      autoPr: resolvedPipelineAutoPr,
      draftPr: resolvedPipelineDraftPr,
      repo: opts.repo as string | undefined,
      skipGit: opts.skipGit === true,
      isolation: resolvedPipelineIsolation,
      cwd: resolvedCwd,
      provider: agentOverrides?.provider,
      model: agentOverrides?.model,
    });

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return { offerContinue: false };
  }

  const taskFromOption = opts.task as string | undefined;
  if (taskFromOption) {
    selectOptions.skipTaskList = true;
    await selectAndExecuteTask(resolvedCwd, taskFromOption, selectOptions, agentOverrides);
    return { offerContinue: false };
  }

  let directTask: string | undefined = task;
  let sourceContext: string | undefined;
  let prBranch: string | undefined;
  let prBaseBranch: string | undefined;
  let sourceIssueNumber: number | undefined;

  if (prNumber) {
    try {
      const prResult = await resolvePrInput(prNumber);
      directTask = undefined;
      sourceContext = prResult.initialInput;
      prBranch = prResult.prBranch;
      prBaseBranch = prResult.baseBranch;
      selectOptions.traceTaskContext = {
        source: 'pr_review',
        prNumber,
        branch: prBranch,
        ...(prBaseBranch ? { baseBranch: prBaseBranch } : {}),
      };
    } catch (e) {
      logError(getErrorMessage(e));
      process.exit(1);
    }
  } else {
    try {
      const issueResult = await resolveIssueInput(issueNumber, task);
      if (issueResult) {
        directTask = undefined;
        sourceContext = issueResult.initialInput;
        sourceIssueNumber = issueResult.issueNumber;
        selectOptions.traceTaskContext = {
          source: 'issue',
          ...(sourceIssueNumber !== undefined ? { issueNumber: sourceIssueNumber } : {}),
        };
      }
    } catch (e) {
      logError(getErrorMessage(e));
      process.exit(1);
    }
  }

  const globalConfig = resolveConfigValues(
    resolvedCwd,
    ['language', 'interactivePreviewSteps'],
  );
  const lang = resolveLanguage(globalConfig.language);

  const workflowId = await determineWorkflow(resolvedCwd, selectOptions.workflow);
  if (workflowId === null) {
    info(getLabel('interactive.ui.cancelled', lang));
    return { offerContinue: false };
  }

  const previewCount = globalConfig.interactivePreviewSteps;
  const workflowDesc = getWorkflowDescription(workflowId, resolvedCwd, previewCount);

  const availableInteractiveModes = sourceContext && !directTask
    ? INTERACTIVE_MODES.filter((mode) => mode !== 'passthrough')
    : INTERACTIVE_MODES;
  const selectedMode = await selectInteractiveMode(
    lang,
    workflowDesc.interactiveMode,
    availableInteractiveModes,
  );
  if (selectedMode === null) {
    info(getLabel('interactive.ui.cancelled', lang));
    return { offerContinue: false };
  }

  const workflowContext = {
    name: workflowDesc.name,
    description: workflowDesc.description,
    workflowStructure: workflowDesc.workflowStructure,
    stepPreviews: workflowDesc.stepPreviews,
    taskHistory: loadTaskHistory(resolvedCwd, lang),
  };
  const interactiveSeed = directTask || sourceContext
    ? {
      ...(directTask ? { userMessage: directTask } : {}),
      ...(sourceContext ? { sourceContext } : {}),
    }
    : undefined;
  let result: InteractiveModeResult;
  let taskRunFinished = false;
  let taskRunSucceeded = true;

  switch (selectedMode) {
    case 'assistant': {
      let selectedSessionId: string | undefined;
      if (opts.continue === true) {
        const { provider: providerType } = resolveAssistantProviderModelFromConfig(
          resolveAssistantConfigLayers(resolvedCwd),
          {
            provider: agentOverrides?.provider,
            model: agentOverrides?.model,
          },
        );
        if (!providerType) {
          throw new Error('Provider is not configured.');
        }
        const savedSessions = loadPersonaSessions(resolvedCwd, providerType);
        const savedSessionId = resolvePersonaSessionId(savedSessions, 'interactive', providerType);
        if (savedSessionId) {
          selectedSessionId = savedSessionId;
        } else {
          info(getLabel('interactive.continueNoSession', lang));
        }
      }
      const interactiveOpts = prBranch ? { excludeActions: ['create_issue'] as const } : undefined;
      const assistantModeOptions = {
        ...interactiveOpts,
        ...(agentOverrides?.provider ? { provider: agentOverrides.provider } : {}),
        ...(agentOverrides?.model ? { model: agentOverrides.model } : {}),
      };
      result = await interactiveMode(
        resolvedCwd,
        interactiveSeed,
        workflowContext,
        selectedSessionId,
        undefined,
        Object.keys(assistantModeOptions).length > 0 ? assistantModeOptions : undefined,
      );
      break;
    }

    case 'passthrough':
      result = await passthroughMode(lang, directTask);
      break;

    case 'quiet':
      result = await quietMode(resolvedCwd, interactiveSeed, workflowContext);
      break;

    case 'persona': {
      if (!workflowDesc.firstStep) {
        info(getLabel('interactive.ui.personaFallback', lang));
        result = await interactiveMode(resolvedCwd, interactiveSeed, workflowContext);
      } else {
        result = await personaMode(resolvedCwd, workflowDesc.firstStep, interactiveSeed, workflowContext);
      }
      break;
    }
  }

  await dispatchConversationAction(result, {
    execute: async ({ task: confirmedTask }) => {
      if (prBranch) {
        info(`Fetching and checking out PR branch: ${prBranch}`);
        checkoutBranch(resolvedCwd, prBranch);
        success(`Checked out PR branch: ${prBranch}`);
      }
      selectOptions.interactiveUserInput = true;
      selectOptions.workflow = workflowId;
      selectOptions.interactiveMetadata = { confirmed: true, task: confirmedTask };
      selectOptions.skipTaskList = true;
      if (selectedMode !== 'quiet') {
        selectOptions.exitOnFailure = false;
      }
      if (result.attachments) {
        selectOptions.attachments = result.attachments;
      }
      try {
        taskRunSucceeded = await selectAndExecuteTask(resolvedCwd, confirmedTask, selectOptions, agentOverrides);
      } catch (err) {
        taskRunSucceeded = false;
        if (selectedMode === 'quiet') {
          throw err;
        }
        logError(getErrorMessage(err));
      } finally {
        taskRunFinished = true;
      }
    },
    create_issue: async ({ task: confirmedTask }) => {
      const labels = await promptLabelSelection(lang);
      await createIssueAndSaveTask(resolvedCwd, confirmedTask, workflowId, {
        confirmAtEndMessage: 'Add this issue to tasks?',
        labels,
        ...(result.attachments ? { attachments: result.attachments } : {}),
      });
    },
    save_task: async ({ task: confirmedTask }) => {
      const presetSettings = prBranch
        ? {
          worktree: true as const,
          branch: prBranch,
          autoPr: true,
          ...(prBaseBranch ? { baseBranch: prBaseBranch } : {}),
        }
        : undefined;
      await saveTaskFromInteractive(resolvedCwd, confirmedTask, workflowId, {
        presetSettings,
        ...(prNumber !== undefined ? { prNumber } : {}),
        ...(sourceIssueNumber !== undefined ? { issue: sourceIssueNumber } : {}),
        ...(result.attachments ? { attachments: result.attachments } : {}),
      });
    },
    cancel: () => undefined,
  });

  return {
    offerContinue: taskRunFinished && selectedMode !== 'quiet',
    continueQuestion: getLabel('interactive.continueQuestion', lang),
    continueStatusMessage: taskRunSucceeded
      ? getLabel('interactive.runCompleted', lang)
      : getLabel('interactive.runFailed', lang),
  };
}

function resolvePipelineIsolation(opts: Record<string, unknown>): 'none' | 'worktree' | 'copy' | undefined {
  if (opts.copyWorkspace === true && typeof opts.isolation === 'string' && opts.isolation !== 'copy') {
    logError('--copy-workspace cannot be combined with --isolation unless the isolation mode is copy');
    process.exit(1);
  }
  if (opts.copyWorkspace === true) {
    return 'copy';
  }
  if (opts.isolation === undefined) {
    return undefined;
  }
  if (opts.isolation === 'none' || opts.isolation === 'worktree' || opts.isolation === 'copy') {
    return opts.isolation;
  }
  logError('--isolation must be one of: none, worktree, copy');
  process.exit(1);
}

program
  .argument('[task]', 'Task to execute (or issue reference like "#6")')
  .action((task?: string) => executeInteractiveDefaultActionLoop(task));
