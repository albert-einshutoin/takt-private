import type { WorkflowConfig } from '../../../core/models/index.js';
import type { WorkflowEngineOptions } from '../../../core/workflow/types.js';
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
  _workflowContext: ReturnType<typeof createWorkflowExecutionContext>,
  generationSnapshot?: WorkflowGenerationSnapshot,
  runtimeRootWorkflow?: WorkflowConfig,
): WorkflowEngineOptions['workflowCallResolver'] {
  const pinnedResolver = generationSnapshot
    ? bindWorkflowGenerationSnapshot(generationSnapshot, requireRuntimeRoot(runtimeRootWorkflow))
    : undefined;
  return ({ parentWorkflow, identifier, stepName }) => {
    // A workflow_call must never fall back to a live disk read after run start.
    // Leaf-only workflows do not invoke this resolver, preserving direct runs.
    if (!pinnedResolver) throw new WorkflowDiscoveryReadError();
    return pinnedResolver(parentWorkflow, identifier, stepName);
  };
}

function requireRuntimeRoot(runtimeRootWorkflow: WorkflowConfig | undefined): WorkflowConfig {
  if (!runtimeRootWorkflow) throw new WorkflowDiscoveryReadError();
  return runtimeRootWorkflow;
}
