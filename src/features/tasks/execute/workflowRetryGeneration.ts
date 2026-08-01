import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import type { WorkflowConfig, WorkflowResumePoint } from '../../../core/models/index.js';
import { trimResumePointStackForWorkflow } from '../../../core/workflow/run/resume-point.js';
import { getWorkflowReference } from '../../../core/workflow/workflow-reference.js';
import { isWorkflowCallStep } from '../../../core/workflow/step-kind.js';
import { resolveWorkflowCallTarget } from '../../../infra/config/loaders/workflowCallResolver.js';
import type { InternalWorkflowReadContext } from '../../../infra/config/loaders/workflowDiscovery.js';
import { WorkflowDiscoveryReadError } from '../../../infra/config/loaders/workflowDiscoveryError.js';

const MAX_WORKFLOW_GENERATION_DEPTH = 5;
const MAX_WORKFLOW_GENERATION_NODES = 256;
const MAX_WORKFLOW_GENERATION_STEPS = 4096;
// Repertoire/resource readers cap one workflow at 2 MiB. The witness may span
// multiple files, so allow two maximum-sized inputs while bounding cumulative
// canonicalization memory inside the global/project critical section.
const MAX_WORKFLOW_GENERATION_BYTES = 4 * 1024 * 1024;
const MAX_RESUME_STACK_DEPTH = 5;
const WITNESS_PATTERN = /^[0-9a-f]{64}$/;
const safeIsProxy = utilTypes.isProxy.bind(utilTypes);
const safeGetPrototypeOf = Object.getPrototypeOf.bind(Object);
const safeGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors.bind(Object);

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
  readContext: InternalWorkflowReadContext,
): string {
  const state: TraversalState = { nodes: 0, steps: 0, bytes: 0, memo: new Map() };
  const tree = captureWorkflowTree(workflow, projectCwd, lookupCwd, readContext, [], 1, state);
  return hashCanonical(tree);
}

export function resolveWorkflowRetryOverrides(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  source: WorkflowRetrySource,
  readContext: InternalWorkflowReadContext,
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
      undefined,
      readContext,
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

export function snapshotWorkflowRetrySource(value: unknown): WorkflowRetrySource {
  const source = snapshotPlainRecord(value, new Set([
    'configuredStartStep',
    'resumePoint',
    'storedMaxSteps',
    'initialIteration',
    'generationWitness',
  ]));
  const generationWitness = source.generationWitness;
  if (typeof generationWitness !== 'string' || !WITNESS_PATTERN.test(generationWitness)) {
    throw new WorkflowDiscoveryReadError();
  }
  const configuredStartStep = optionalNonEmptyString(source.configuredStartStep);
  const storedMaxSteps = optionalInteger(source.storedMaxSteps, 1);
  const initialIteration = optionalInteger(source.initialIteration, 0);
  const resumePoint = source.resumePoint === undefined
    ? undefined
    : snapshotResumePoint(source.resumePoint);
  return Object.freeze({
    ...(configuredStartStep ? { configuredStartStep } : {}),
    ...(resumePoint ? { resumePoint } : {}),
    ...(storedMaxSteps !== undefined ? { storedMaxSteps } : {}),
    ...(initialIteration !== undefined ? { initialIteration } : {}),
    generationWitness,
  });
}

interface TraversalState {
  nodes: number;
  steps: number;
  bytes: number;
  memo: Map<string, number>;
}

function captureWorkflowTree(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  readContext: InternalWorkflowReadContext,
  ancestors: readonly string[],
  depth: number,
  state: TraversalState,
): unknown {
  if (depth > MAX_WORKFLOW_GENERATION_DEPTH) {
    throw new WorkflowDiscoveryReadError();
  }
  const reference = getWorkflowReference(workflow);
  if (ancestors.includes(reference)) {
    return { reference, cycle: true };
  }
  const canonicalWorkflow = JSON.stringify(canonicalize(workflow));
  state.bytes += Buffer.byteLength(canonicalWorkflow, 'utf8');
  if (state.bytes > MAX_WORKFLOW_GENERATION_BYTES) throw new WorkflowDiscoveryReadError();
  const workflowHash = createHash('sha256').update(canonicalWorkflow).digest('hex');
  const memoKey = `${reference}\0${workflowHash}`;
  const memoId = state.memo.get(memoKey);
  if (memoId !== undefined) return { memo: memoId };
  state.nodes += 1;
  state.steps += workflow.steps.length;
  if (state.nodes > MAX_WORKFLOW_GENERATION_NODES || state.steps > MAX_WORKFLOW_GENERATION_STEPS) {
    throw new WorkflowDiscoveryReadError();
  }
  const id = state.nodes;
  state.memo.set(memoKey, id);
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
      undefined,
      readContext,
    );
    if (!child) {
      children.push({ step: step.name, missing: true });
      continue;
    }
    children.push({
      step: step.name,
      workflow: captureWorkflowTree(
        child,
        projectCwd,
        lookupCwd,
        readContext,
        nextAncestors,
        depth + 1,
        state,
      ),
    });
  }
  return { id, reference, workflow, children };
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function snapshotPlainRecord(value: unknown, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || safeIsProxy(value)) {
    throw new WorkflowDiscoveryReadError();
  }
  const prototype = safeGetPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new WorkflowDiscoveryReadError();
  const descriptors = safeGetOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedKeys.has(key) || !('value' in descriptor)) throw new WorkflowDiscoveryReadError();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotResumePoint(value: unknown): WorkflowResumePoint {
  const point = snapshotPlainRecord(value, new Set(['version', 'stack', 'iteration', 'elapsed_ms']));
  if (point.version !== 1 || !Array.isArray(point.stack)) throw new WorkflowDiscoveryReadError();
  if (safeIsProxy(point.stack) || point.stack.length < 1 || point.stack.length > MAX_RESUME_STACK_DEPTH) {
    throw new WorkflowDiscoveryReadError();
  }
  const stack = point.stack.map((entry) => {
    const item = snapshotPlainRecord(entry, new Set(['workflow', 'workflow_ref', 'step', 'kind']));
    const workflow = requiredNonEmptyString(item.workflow);
    const step = requiredNonEmptyString(item.step);
    const workflowRef = optionalNonEmptyString(item.workflow_ref);
    if (item.kind !== 'agent' && item.kind !== 'system' && item.kind !== 'workflow_call') {
      throw new WorkflowDiscoveryReadError();
    }
    return Object.freeze({
      workflow,
      ...(workflowRef ? { workflow_ref: workflowRef } : {}),
      step,
      kind: item.kind,
    });
  });
  const iteration = optionalInteger(point.iteration, 0);
  const elapsedMs = optionalInteger(point.elapsed_ms, 0);
  if (iteration === undefined || elapsedMs === undefined) throw new WorkflowDiscoveryReadError();
  return Object.freeze({
    version: 1,
    stack: Object.freeze(stack) as unknown as WorkflowResumePoint['stack'],
    iteration,
    elapsed_ms: elapsedMs,
  });
}

function requiredNonEmptyString(value: unknown): string {
  const result = optionalNonEmptyString(value);
  if (result === undefined) throw new WorkflowDiscoveryReadError();
  return result;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new WorkflowDiscoveryReadError();
  return value;
}

function optionalInteger(value: unknown, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new WorkflowDiscoveryReadError();
  }
  return value;
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
