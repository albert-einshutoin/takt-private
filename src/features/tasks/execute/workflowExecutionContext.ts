import type { WorkflowConfig } from '../../../core/models/index.js';
import type { WorkflowEngineOptions } from '../../../core/workflow/types.js';
import { resolveWorkflowCallTarget } from '../../../infra/config/index.js';
import { getWorkflowSourcePath } from '../../../infra/config/loaders/workflowSourceMetadata.js';
import { getWorkflowTrustInfo } from '../../../infra/config/loaders/workflowTrustSource.js';
import { WorkflowDiscoveryReadError } from '../../../infra/config/loaders/workflowDiscoveryError.js';
import {
  bindWorkflowGenerationSnapshot,
  type WorkflowGenerationSnapshot,
} from './workflowRetryGeneration.js';

export function createWorkflowExecutionContext(workflowConfig: WorkflowConfig, projectCwd: string) {
  return {
    sourcePath: getWorkflowSourcePath(workflowConfig),
    trustInfo: getWorkflowTrustInfo(workflowConfig, projectCwd),
  };
}

export function createWorkflowCallResolver(
  workflowContext: ReturnType<typeof createWorkflowExecutionContext>,
  generationSnapshot?: WorkflowGenerationSnapshot,
  runtimeRootWorkflow?: WorkflowConfig,
): WorkflowEngineOptions['workflowCallResolver'] {
  const pinnedResolver = generationSnapshot
    ? bindWorkflowGenerationSnapshot(generationSnapshot, requireRuntimeRoot(runtimeRootWorkflow))
    : undefined;
  return ({
    parentWorkflow,
    identifier,
    stepName,
    projectCwd,
    lookupCwd,
  }) => pinnedResolver
    ? pinnedResolver(parentWorkflow, identifier, stepName)
    : resolveWorkflowCallTarget(
      parentWorkflow,
      identifier,
      stepName,
      projectCwd,
      lookupCwd,
      workflowContext,
    );
}

function requireRuntimeRoot(runtimeRootWorkflow: WorkflowConfig | undefined): WorkflowConfig {
  if (!runtimeRootWorkflow) throw new WorkflowDiscoveryReadError();
  return runtimeRootWorkflow;
}
