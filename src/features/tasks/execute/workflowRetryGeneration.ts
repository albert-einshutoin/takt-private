import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import type {
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
} from '../../../core/models/index.js';
import { trimResumePointStackForWorkflow } from '../../../core/workflow/run/resume-point.js';
import {
  buildWorkflowResumePointEntry,
  getWorkflowReference,
} from '../../../core/workflow/workflow-reference.js';
import { getWorkflowStepKind, isWorkflowCallStep } from '../../../core/workflow/step-kind.js';
import { resolveWorkflowCallTarget } from '../../../infra/config/loaders/workflowCallResolver.js';
import type { InternalWorkflowReadContext } from '../../../infra/config/loaders/workflowDiscovery.js';
import { WorkflowDiscoveryReadError } from '../../../infra/config/loaders/workflowDiscoveryError.js';
import { getWorkflowTrustInfo } from '../../../infra/config/loaders/workflowTrustSource.js';

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

const workflowGenerationSnapshotBrand: unique symbol = Symbol('WorkflowGenerationSnapshot');

export interface WorkflowGenerationSnapshot {
  readonly witness: string;
  readonly [workflowGenerationSnapshotBrand]: true;
}

export type PinnedWorkflowCallResolver = (
  parentWorkflow: WorkflowConfig,
  identifier: string,
  stepName: string,
) => WorkflowConfig | null;

const workflowGenerationSnapshots = new WeakSet<object>();
const workflowGenerationSnapshotStates = new WeakMap<object, WorkflowGenerationSnapshotState>();

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
  const snapshot = buildWorkflowGenerationSnapshot(workflow, projectCwd, lookupCwd, readContext);
  try {
    return snapshot.witness;
  } finally {
    disposeWorkflowGenerationSnapshot(snapshot);
  }
}

export function buildWorkflowGenerationSnapshot(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  readContext: InternalWorkflowReadContext,
): WorkflowGenerationSnapshot {
  const state: TraversalState = {
    nodes: 0,
    steps: 0,
    bytes: 0,
    memo: new Map(),
    canonicalWorkflows: new WeakMap(),
    edges: new WeakMap(),
  };
  const tree = captureWorkflowTree(workflow, projectCwd, lookupCwd, readContext, [], 1, state);
  const snapshot: WorkflowGenerationSnapshot = Object.freeze({
    witness: hashCanonical(tree),
    [workflowGenerationSnapshotBrand]: true as const,
  });
  workflowGenerationSnapshots.add(snapshot);
  workflowGenerationSnapshotStates.set(snapshot, {
    capturedRoot: workflow,
    boundRuntimeRoot: undefined,
    edges: state.edges,
    disposed: false,
  });
  return snapshot;
}

/** Bind the immutable callable tree to the root object actually given to the engine. */
export function bindWorkflowGenerationSnapshot(
  snapshot: WorkflowGenerationSnapshot,
  runtimeRoot: WorkflowConfig,
): PinnedWorkflowCallResolver {
  const state = requireWorkflowGenerationSnapshotState(snapshot);
  if (state.disposed) throw new WorkflowDiscoveryReadError();
  if (state.boundRuntimeRoot && state.boundRuntimeRoot !== runtimeRoot) {
    throw new WorkflowDiscoveryReadError();
  }
  state.boundRuntimeRoot = runtimeRoot;
  return (parentWorkflow, identifier, stepName) => {
    if (state.disposed || !state.capturedRoot) throw new WorkflowDiscoveryReadError();
    const capturedParent = parentWorkflow === state.boundRuntimeRoot
      ? state.capturedRoot
      : parentWorkflow;
    return resolvePinnedWorkflowCall(state.edges, capturedParent, identifier, stepName);
  };
}

/** Release the run-owned root reference as soon as execution finishes or aborts. */
export function disposeWorkflowGenerationSnapshot(snapshot: WorkflowGenerationSnapshot): void {
  const state = requireWorkflowGenerationSnapshotState(snapshot);
  if (state.disposed) return;
  state.disposed = true;
  state.capturedRoot = undefined;
  state.boundRuntimeRoot = undefined;
  state.edges = new WeakMap();
}

export function resolveWorkflowRetryOverrides(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  source: WorkflowRetrySource,
  readContext: InternalWorkflowReadContext,
): WorkflowRetryOverrides {
  const reboundResumePoint = rebindResumePointToCurrentWorkflow(
    workflow,
    source.resumePoint,
    projectCwd,
    lookupCwd,
    readContext,
  );
  const resumePoint = trimResumePointStackForWorkflow({
    workflow,
    resumePoint: reboundResumePoint,
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

function rebindResumePointToCurrentWorkflow(
  workflow: WorkflowConfig,
  resumePoint: WorkflowResumePoint | undefined,
  projectCwd: string,
  lookupCwd: string,
  readContext: InternalWorkflowReadContext,
): WorkflowResumePoint | undefined {
  if (!resumePoint) return undefined;
  const reboundStack: WorkflowResumePointEntry[] = [];
  let currentWorkflow = workflow;
  for (let index = 0; index < resumePoint.stack.length; index += 1) {
    const savedEntry = resumePoint.stack[index]!;
    if (savedEntry.workflow !== currentWorkflow.name) throw new WorkflowDiscoveryReadError();
    const currentStep = currentWorkflow.steps.find((step) => step.name === savedEntry.step);
    if (!currentStep) throw new WorkflowDiscoveryReadError();
    const currentKind = getWorkflowStepKind(currentStep);
    if (currentKind !== savedEntry.kind) throw new WorkflowDiscoveryReadError();
    reboundStack.push(buildWorkflowResumePointEntry(
      currentWorkflow,
      currentStep.name,
      currentKind,
    ));
    if (index === resumePoint.stack.length - 1) continue;
    if (!isWorkflowCallStep(currentStep)) throw new WorkflowDiscoveryReadError();
    const childWorkflow = resolveWorkflowCallTarget(
      currentWorkflow,
      currentStep.call,
      currentStep.name,
      projectCwd,
      lookupCwd,
      undefined,
      readContext,
    );
    if (!childWorkflow) {
      // Preserve the established nearest-call fallback only when the witnessed
      // topology itself records an unavailable child. The current call entry
      // has already been fully validated and rebound atomically.
      return { ...resumePoint, stack: reboundStack };
    }
    if (resumePoint.stack[index + 1]!.workflow !== childWorkflow.name) {
      throw new WorkflowDiscoveryReadError();
    }
    currentWorkflow = childWorkflow;
  }
  return { ...resumePoint, stack: reboundStack };
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
  memo: Map<string, WorkflowMemoEntry>;
  canonicalWorkflows: WeakMap<WorkflowConfig, WorkflowConfig>;
  edges: WeakMap<WorkflowConfig, Map<string, PinnedWorkflowEdge>>;
}

interface PinnedWorkflowEdge {
  readonly child: WorkflowConfig | null;
  readonly identifier: string;
}

interface WorkflowGenerationSnapshotState {
  capturedRoot: WorkflowConfig | undefined;
  boundRuntimeRoot: WorkflowConfig | undefined;
  edges: WeakMap<WorkflowConfig, Map<string, PinnedWorkflowEdge>>;
  disposed: boolean;
}

interface WorkflowAncestor {
  readonly reference: string;
  readonly id: number;
  readonly workflow: WorkflowConfig;
}

interface WorkflowMemoEntry {
  readonly id: number;
  readonly workflow: WorkflowConfig;
}

function captureWorkflowTree(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  readContext: InternalWorkflowReadContext,
  ancestors: readonly WorkflowAncestor[],
  depth: number,
  state: TraversalState,
): unknown {
  if (depth > MAX_WORKFLOW_GENERATION_DEPTH) {
    throw new WorkflowDiscoveryReadError();
  }
  const reference = getWorkflowReference(workflow);
  const cycleTarget = ancestors.find((ancestor) => ancestor.reference === reference);
  if (cycleTarget) {
    state.canonicalWorkflows.set(workflow, cycleTarget.workflow);
    return { cycle: cycleTarget.id };
  }
  const canonicalWorkflow = JSON.stringify(canonicalize(workflow));
  state.bytes += Buffer.byteLength(canonicalWorkflow, 'utf8');
  if (state.bytes > MAX_WORKFLOW_GENERATION_BYTES) throw new WorkflowDiscoveryReadError();
  const workflowHash = createHash('sha256').update(canonicalWorkflow).digest('hex');
  const memoKey = `${reference}\0${workflowHash}`;
  const memoEntry = state.memo.get(memoKey);
  if (memoEntry) {
    // Different loader objects may describe the same memoized DAG node. Every
    // incoming edge must return the already-captured object whose child edges
    // are present in the WeakMap, otherwise only the first path is callable.
    state.canonicalWorkflows.set(workflow, memoEntry.workflow);
    return { memo: memoEntry.id };
  }
  state.nodes += 1;
  state.steps += workflow.steps.length;
  if (state.nodes > MAX_WORKFLOW_GENERATION_NODES || state.steps > MAX_WORKFLOW_GENERATION_STEPS) {
    throw new WorkflowDiscoveryReadError();
  }
  const id = state.nodes;
  state.memo.set(memoKey, { id, workflow });
  state.canonicalWorkflows.set(workflow, workflow);
  const nextAncestors = [...ancestors, { reference, id, workflow }];
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
      registerPinnedEdge(state.edges, workflow, step.name, step.call, null);
      continue;
    }
    const childTree = captureWorkflowTree(
      child,
      projectCwd,
      lookupCwd,
      readContext,
      nextAncestors,
      depth + 1,
      state,
    );
    registerPinnedEdge(
      state.edges,
      workflow,
      step.name,
      step.call,
      requireCanonicalWorkflow(state.canonicalWorkflows, child),
    );
    children.push({
      step: step.name,
      workflow: childTree,
    });
  }
  // Opaque references contain absolute source-path hashes and are intentionally
  // excluded from the persisted tree. Deterministic traversal IDs retain DAG
  // and cycle topology while allowing an identical .takt tree to move hosts.
  return {
    id,
    workflow,
    trust: getPortableWorkflowTrust(workflow, projectCwd),
    children,
  };
}

function requireCanonicalWorkflow(
  canonicalWorkflows: WeakMap<WorkflowConfig, WorkflowConfig>,
  workflow: WorkflowConfig,
): WorkflowConfig {
  const canonical = canonicalWorkflows.get(workflow);
  if (!canonical) throw new WorkflowDiscoveryReadError();
  return canonical;
}

function getPortableWorkflowTrust(workflow: WorkflowConfig, projectCwd: string) {
  const trustInfo = getWorkflowTrustInfo(workflow, projectCwd);
  return {
    source: trustInfo.source,
    isProjectTrustRoot: trustInfo.isProjectTrustRoot,
    isProjectWorkflowRoot: trustInfo.isProjectWorkflowRoot,
  };
}

function registerPinnedEdge(
  edges: WeakMap<WorkflowConfig, Map<string, PinnedWorkflowEdge>>,
  parentWorkflow: WorkflowConfig,
  stepName: string,
  identifier: string,
  child: WorkflowConfig | null,
): void {
  let parentEdges = edges.get(parentWorkflow);
  if (!parentEdges) {
    parentEdges = new Map();
    edges.set(parentWorkflow, parentEdges);
  }
  const existing = parentEdges.get(stepName);
  if (existing && (existing.identifier !== identifier || existing.child !== child)) {
    throw new WorkflowDiscoveryReadError();
  }
  parentEdges.set(stepName, Object.freeze({ child, identifier }));
}

function resolvePinnedWorkflowCall(
  edges: WeakMap<WorkflowConfig, Map<string, PinnedWorkflowEdge>>,
  parentWorkflow: WorkflowConfig,
  identifier: string,
  stepName: string,
): WorkflowConfig | null {
  const step = parentWorkflow.steps.find((candidate) => candidate.name === stepName);
  if (!step || !isWorkflowCallStep(step) || step.call !== identifier) {
    throw new WorkflowDiscoveryReadError();
  }
  const edge = edges.get(parentWorkflow)?.get(stepName);
  if (!edge || edge.identifier !== identifier) throw new WorkflowDiscoveryReadError();
  return edge.child;
}

function requireWorkflowGenerationSnapshotState(
  snapshot: WorkflowGenerationSnapshot,
): WorkflowGenerationSnapshotState {
  if (
    typeof snapshot !== 'object'
    || snapshot === null
    || !workflowGenerationSnapshots.has(snapshot)
  ) {
    throw new WorkflowDiscoveryReadError();
  }
  const state = workflowGenerationSnapshotStates.get(snapshot);
  if (!state) throw new WorkflowDiscoveryReadError();
  return state;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
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
  if (
    safeIsProxy(point.stack)
    || safeGetPrototypeOf(point.stack) !== Array.prototype
    || point.stack.length < 1
    || point.stack.length > MAX_RESUME_STACK_DEPTH
  ) {
    throw new WorkflowDiscoveryReadError();
  }
  const stackDescriptors = safeGetOwnPropertyDescriptors(point.stack);
  const stackKeys = Reflect.ownKeys(stackDescriptors);
  if (stackKeys.some((key) => {
    if (key === 'length') return false;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
    const descriptor = stackDescriptors[key];
    return descriptor === undefined || !('value' in descriptor);
  })) throw new WorkflowDiscoveryReadError();
  for (let index = 0; index < point.stack.length; index += 1) {
    const descriptor = stackDescriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new WorkflowDiscoveryReadError();
    }
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
