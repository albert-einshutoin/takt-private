import type { WorkflowConfig } from '../../../core/models/index.js';
import { isWorkflowPath, resolveWorkflowConfigValues } from '../../../infra/config/index.js';
import { loadWorkflowByIdentifierWithReadContext } from '../../../infra/config/loaders/workflowResolver.js';
import type { InternalWorkflowReadContext } from '../../../infra/config/loaders/workflowDiscovery.js';
import { WorkflowDiscoveryReadError } from '../../../infra/config/loaders/workflowDiscoveryError.js';
import { resolveProviderOptionsWithTrace } from '../../../infra/config/resolveConfigValue.js';
import { info, error } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import type { ExecuteTaskOptions, WorkflowExecutionOptions, WorkflowExecutionResult } from './types.js';
import { buildTraceTaskMetadata } from './traceTaskMetadata.js';
import type { WorkflowTraceTaskMetadata } from '../../../core/workflow/types.js';
import { existsSync } from 'node:fs';
import {
  withProjectTemplateRunStartPermit,
  type ProjectTemplateRunStartPermit,
} from '../../project-template/apply-lease.js';
import { prepareWorkflowRuntimeRead } from './workflowRuntimeReadBoundary.js';
import {
  buildWorkflowGenerationWitness,
  resolveWorkflowRetryOverrides,
  snapshotWorkflowRetrySource,
} from './workflowRetryGeneration.js';

const log = createLogger('task');

type WorkflowExecutor = (
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions,
) => Promise<WorkflowExecutionResult>;

export async function executeTaskWorkflow(
  options: ExecuteTaskOptions,
  workflowExecutor: WorkflowExecutor,
): Promise<WorkflowExecutionResult> {
  const {
    task,
    cwd,
    workflowIdentifier,
    projectCwd,
    agentOverrides,
    interactiveUserInput,
    interactiveMetadata,
    startStep,
    retryNote,
    resumePoint,
    retrySource,
    directResume,
    reportDirName,
    abortSignal,
    taskPrefix,
    taskColorIndex,
    taskDisplayLabel,
    maxStepsOverride,
    initialIterationOverride,
    currentTaskIssueNumber,
    onRunningEvidencePublished,
  } = options;
  // Snapshot untrusted retry metadata before either coordination lock is held.
  // Accessors/proxies must never execute while they can prolong a lease.
  const safeRetrySource = retrySource === undefined
    ? undefined
    : snapshotWorkflowRetrySource(retrySource);
  const prepareWorkflow = (
    readContext: InternalWorkflowReadContext,
  ): Promise<WorkflowExecutionResult> => {
    const startWorkflow = (
      projectTemplateRunStartPermit?: ProjectTemplateRunStartPermit,
    ): Promise<WorkflowExecutionResult> => {
    const traceTaskMetadata = resolveTraceTaskMetadata(options);
    const workflowConfig = loadWorkflowByIdentifierWithReadContext(
      workflowIdentifier,
      projectCwd,
      { lookupCwd: cwd },
      readContext,
    );
    const safeWorkflowIdentifier = sanitizeTerminalText(workflowIdentifier);

    if (!workflowConfig) {
      if (isWorkflowPath(workflowIdentifier)) {
        error(`Workflow file not found: ${safeWorkflowIdentifier}`);
        return Promise.resolve({
          success: false,
          reason: `Workflow file not found: ${safeWorkflowIdentifier}`,
        });
      }

      error(`Workflow "${safeWorkflowIdentifier}" not found.`);
      info('Available workflows are searched in .takt/workflows/ and ~/.takt/workflows/.');
      info('If the same workflow name exists in multiple locations, project workflows/ take priority over user workflows/.');
      info('Specify a valid workflow when creating tasks (e.g., via "takt add").');
      return Promise.resolve({
        success: false,
        reason: `Workflow "${safeWorkflowIdentifier}" not found.`,
      });
    }
    const workflowGenerationWitness = buildWorkflowGenerationWitness(
      workflowConfig,
      projectCwd,
      cwd,
      readContext,
    );
    const retryOverrides = safeRetrySource === undefined
      ? { startStep, resumePoint, maxStepsOverride, initialIterationOverride }
      : resolveWitnessedRetryOverrides(
        workflowConfig,
        projectCwd,
        cwd,
        safeRetrySource,
        workflowGenerationWitness,
        readContext,
      );
    log.debug('Running workflow', {
      name: workflowConfig.name,
      steps: workflowConfig.steps.map((s: { name: string }) => s.name),
    });

    const config = resolveWorkflowConfigValues(projectCwd, ['language', 'personaProviders', 'providerRouting', 'providerProfiles']);
    const providerOptions = resolveProviderOptionsWithTrace(projectCwd);
    return workflowExecutor(workflowConfig, task, cwd, {
      projectCwd,
      language: config.language,
      provider: agentOverrides?.provider,
      model: agentOverrides?.model,
      providerOptions: providerOptions.value,
      providerOptionsSource: providerOptions.source,
      providerOptionsOriginResolver: providerOptions.originResolver,
      personaProviders: config.personaProviders,
      providerRouting: config.providerRouting,
      providerProfiles: config.providerProfiles,
      interactiveUserInput,
      interactiveMetadata,
      startStep: retryOverrides.startStep,
      retryNote,
      resumePoint: retryOverrides.resumePoint,
      directResume,
      reportDirName,
      abortSignal,
      taskPrefix,
      taskColorIndex,
      taskDisplayLabel,
      maxStepsOverride: retryOverrides.maxStepsOverride,
      initialIterationOverride: retryOverrides.initialIterationOverride,
      workflowGenerationWitness,
      currentTaskIssueNumber,
      traceTaskMetadata,
      onRunningEvidencePublished,
      ...(projectTemplateRunStartPermit
        ? { projectTemplateRunStartPermit }
        : {}),
    });
    };

    // Global repertoire is always acquired before the project run-start mutex.
    // This fixed order avoids global/project deadlocks. The executor must create
    // its Promise after synchronous evidence publication; project then global
    // release before any provider/network/engine continuation adopts it.
    return existsSync(projectCwd)
      ? withProjectTemplateRunStartPermit(projectCwd, startWorkflow)
      : startWorkflow();
  };
  return prepareWorkflowRuntimeRead({
    ...(abortSignal ? { abortSignal } : {}),
    prepare: prepareWorkflow,
  });
}

function resolveWitnessedRetryOverrides(
  workflowConfig: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  retrySource: NonNullable<ExecuteTaskOptions['retrySource']>,
  currentWitness: string,
  readContext: InternalWorkflowReadContext,
) {
  if (currentWitness !== retrySource.generationWitness) {
    throw new WorkflowDiscoveryReadError();
  }
  return resolveWorkflowRetryOverrides(
    workflowConfig,
    projectCwd,
    lookupCwd,
    retrySource,
    readContext,
  );
}

function resolveTraceTaskMetadata(options: ExecuteTaskOptions): WorkflowTraceTaskMetadata | undefined {
  if (options.traceTaskMetadata && options.traceTaskContext) {
    throw new Error('Use either traceTaskMetadata or traceTaskContext, not both');
  }
  if (options.traceTaskMetadata) {
    return options.traceTaskMetadata;
  }
  if (!options.traceTaskContext) {
    return undefined;
  }
  return buildTraceTaskMetadata({
    taskContent: options.task,
    ...options.traceTaskContext,
  });
}
