import { createHash } from 'node:crypto';
import type { WorkflowConfig, WorkflowResumePoint } from '../../../core/models/index.js';
import { trimResumePointStackForWorkflow } from '../../../core/workflow/run/resume-point.js';
import { getWorkflowReference } from '../../../core/workflow/workflow-reference.js';
import { isWorkflowCallStep } from '../../../core/workflow/step-kind.js';
import { resolveWorkflowCallTarget } from '../../../infra/config/loaders/workflowCallResolver.js';

const MAX_WORKFLOW_GENERATION_DEPTH = 64;

export interface WorkflowRetrySource {
  readonly configuredStartStep?: string;
  readonly resumePoint?: WorkflowResumePoint;
  readonly storedMaxSteps?: number;
  readonly initialIteration?: number;
  readonly generationWitness: string;
}

export interface WorkflowRetryOverrides {
  readonly startStep?: string;
  readonly resumePoint?: WorkflowResumePoint;
  readonly maxStepsOverride?: number;
  readonly initialIterationOverride?: number;
}

/**
 * Hash the complete callable workflow tree, not only the root file. A retry
 * stack is meaningful only for the exact generation that produced it; a
 * same-name child with different instructions must not inherit old progress.
 */
export function buildWorkflowGenerationWitness(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
): string {
  const tree = captureWorkflowTree(workflow, projectCwd, lookupCwd, [], 0);
  return createHash('sha256').update(JSON.stringify(tree)).digest('hex');
}

export function resolveWorkflowRetryOverrides(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  source: WorkflowRetrySource,
): WorkflowRetryOverrides {
  const resumePoint = trimResumePointStackForWorkflow({
    workflow,
    resumePoint: source.resumePoint,
    resolveWorkflowCall: (parentWorkflow, step) => resolveWorkflowCallTarget(
      parentWorkflow,
      step.call,
      step.name,
      projectCwd,
      lookupCwd,
    ),
  });
  const rootStep = resumePoint?.stack[0]?.step;
  const startStep = rootStep ?? source.configuredStartStep;
  const initialIterationOverride = source.initialIteration ?? resumePoint?.iteration;
  const maxStepsOverride = resolveRetryMaxStepsOverride(
    source.storedMaxSteps,
    initialIterationOverride,
    resolveWorkflowMaxSteps(workflow),
  );
  return {
    ...(startStep ? { startStep } : {}),
    ...(resumePoint ? { resumePoint } : {}),
    ...(maxStepsOverride !== undefined ? { maxStepsOverride } : {}),
    ...(initialIterationOverride !== undefined ? { initialIterationOverride } : {}),
  };
}

function captureWorkflowTree(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  ancestors: readonly string[],
  depth: number,
): unknown {
  if (depth > MAX_WORKFLOW_GENERATION_DEPTH) {
    throw new Error('Workflow generation tree exceeds the retry safety limit.');
  }
  const reference = getWorkflowReference(workflow);
  if (ancestors.includes(reference)) {
    return { reference, cycle: true };
  }
  const nextAncestors = [...ancestors, reference];
  const children: unknown[] = [];
  for (const step of workflow.steps) {
    if (!isWorkflowCallStep(step)) continue;
    const child = resolveWorkflowCallTarget(
      workflow,
      step.call,
      step.name,
      projectCwd,
      lookupCwd,
    );
    if (!child) {
      children.push({ step: step.name, missing: true });
      continue;
    }
    children.push({
      step: step.name,
      workflow: captureWorkflowTree(child, projectCwd, lookupCwd, nextAncestors, depth + 1),
    });
  }
  return { reference, workflow, children };
}

function resolveWorkflowMaxSteps(workflow: WorkflowConfig): number | undefined {
  const maxSteps = workflow.maxSteps;
  return typeof maxSteps === 'number' && Number.isFinite(maxSteps) && maxSteps > 0
    ? maxSteps
    : undefined;
}

function resolveRetryMaxStepsOverride(
  storedMaxSteps: number | undefined,
  initialIteration: number | undefined,
  workflowMaxSteps: number | undefined,
): number | undefined {
  if (initialIteration === undefined) return storedMaxSteps;
  const currentMaxSteps = storedMaxSteps ?? workflowMaxSteps;
  if (currentMaxSteps === undefined || initialIteration < currentMaxSteps) return storedMaxSteps;
  if (workflowMaxSteps === undefined) {
    return storedMaxSteps !== undefined && initialIteration >= storedMaxSteps
      ? initialIteration + 1
      : storedMaxSteps;
  }
  const retryWindowCount = Math.floor(initialIteration / workflowMaxSteps) + 1;
  return Math.max(currentMaxSteps, retryWindowCount * workflowMaxSteps);
}
