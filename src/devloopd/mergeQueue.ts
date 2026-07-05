export type MergeQueueDecisionStatus = 'ready' | 'blocked' | 'serialized' | 'evicted';

export type MergeQueueStopRule =
  | 'head mismatch'
  | 'checks failed'
  | 'Mergeable: NO'
  | 'Unsafe or too broad'
  | 'overlap serialization'
  | 'conflict eviction';

export interface MergeQueuePullRequest {
  number: number;
  title: string;
  headRefOid: string;
  expectedHeadSha?: string;
  changedPaths: readonly string[];
  checksPassed: boolean;
  dualLlmApproved: boolean;
  productPolicyRequiresHumanReview?: boolean;
  mergeStateStatus?: string;
  isDraft?: boolean;
  mergeTreeOutput?: string;
  diffContext?: string;
  landedPrNumbers?: readonly number[];
}

export interface ChangedFileGraphEdge {
  left: number;
  right: number;
  overlapPaths: readonly string[];
}

export interface ChangedFileGraph {
  nodes: readonly number[];
  edges: readonly ChangedFileGraphEdge[];
}

export interface MergeQueueDecision {
  prNumber: number;
  status: MergeQueueDecisionStatus;
  reasons: readonly string[];
  stopRule?: MergeQueueStopRule;
  layer?: number;
  overlapsWith?: readonly number[];
}

export interface MergeQueueEvictionContext {
  prNumber: number;
  reason: string;
  conflictingPaths: readonly string[];
  mergeTreeOutput?: string;
  diffContext?: string;
  landedPrNumbers: readonly number[];
}

export interface MergeQueuePlan {
  decisions: readonly MergeQueueDecision[];
  graph: ChangedFileGraph;
  layers: readonly (readonly number[])[];
  evictions: readonly MergeQueueEvictionContext[];
}

const CONFLICTING_MERGE_STATES = new Set(['DIRTY', 'BLOCKED', 'BEHIND', 'UNKNOWN']);

function overlapPaths(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((path) => rightSet.has(path)).sort((a, b) => a.localeCompare(b));
}

export function buildChangedFileGraph(prs: readonly Pick<MergeQueuePullRequest, 'number' | 'changedPaths'>[]): ChangedFileGraph {
  const sorted = [...prs].sort((left, right) => left.number - right.number);
  const edges: ChangedFileGraphEdge[] = [];
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    const left = sorted[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const right = sorted[rightIndex]!;
      const overlap = overlapPaths(left.changedPaths, right.changedPaths);
      if (overlap.length > 0) {
        edges.push({ left: left.number, right: right.number, overlapPaths: overlap });
      }
    }
  }
  return {
    nodes: sorted.map((pr) => pr.number),
    edges,
  };
}

function firstBlockingReason(pr: MergeQueuePullRequest): MergeQueueDecision | undefined {
  if (pr.expectedHeadSha !== undefined && pr.expectedHeadSha !== pr.headRefOid) {
    return {
      prNumber: pr.number,
      status: 'blocked',
      stopRule: 'head mismatch',
      reasons: [`head SHA mismatch: expected ${pr.expectedHeadSha}, got ${pr.headRefOid}`],
    };
  }
  if (!pr.checksPassed) {
    return {
      prNumber: pr.number,
      status: 'blocked',
      stopRule: 'checks failed',
      reasons: ['GitHub checks did not pass'],
    };
  }
  if (!pr.dualLlmApproved) {
    return {
      prNumber: pr.number,
      status: 'blocked',
      stopRule: 'Mergeable: NO',
      reasons: ['dual-LLM approval is missing for current head'],
    };
  }
  if (pr.productPolicyRequiresHumanReview === true || pr.isDraft === true) {
    return {
      prNumber: pr.number,
      status: 'blocked',
      stopRule: 'Unsafe or too broad',
      reasons: [pr.isDraft === true ? 'PR is draft' : 'product-policy impact requires human review'],
    };
  }
  return undefined;
}

function evictionFor(pr: MergeQueuePullRequest): MergeQueueEvictionContext | undefined {
  const state = pr.mergeStateStatus?.toUpperCase();
  if (state === undefined || !CONFLICTING_MERGE_STATES.has(state)) {
    return undefined;
  }
  return {
    prNumber: pr.number,
    reason: `merge state is ${state}`,
    conflictingPaths: [...pr.changedPaths],
    ...(pr.mergeTreeOutput !== undefined ? { mergeTreeOutput: pr.mergeTreeOutput } : {}),
    ...(pr.diffContext !== undefined ? { diffContext: pr.diffContext } : {}),
    landedPrNumbers: pr.landedPrNumbers ?? [],
  };
}

function overlapNeighbors(prNumber: number, graph: ChangedFileGraph): number[] {
  const neighbors = graph.edges.flatMap((edge) => {
    if (edge.left === prNumber) return [edge.right];
    if (edge.right === prNumber) return [edge.left];
    return [];
  });
  return [...new Set(neighbors)].sort((left, right) => left - right);
}

export function planMergeQueue(prs: readonly MergeQueuePullRequest[]): MergeQueuePlan {
  const sorted = [...prs].sort((left, right) => left.number - right.number);
  const graph = buildChangedFileGraph(sorted);
  const decisions = new Map<number, MergeQueueDecision>();
  const evictions: MergeQueueEvictionContext[] = [];

  for (const pr of sorted) {
    const eviction = evictionFor(pr);
    if (eviction !== undefined) {
      evictions.push(eviction);
      decisions.set(pr.number, {
        prNumber: pr.number,
        status: 'evicted',
        stopRule: 'conflict eviction',
        reasons: [eviction.reason],
      });
      continue;
    }
    const blocked = firstBlockingReason(pr);
    if (blocked !== undefined) {
      decisions.set(pr.number, blocked);
    }
  }

  const eligible = sorted.filter((pr) => !decisions.has(pr.number));
  const layers: number[][] = [];
  for (const pr of eligible) {
    const overlaps = overlapNeighbors(pr.number, graph).filter((neighbor) => eligible.some((candidate) => candidate.number === neighbor));
    const previousOverlaps = overlaps.filter((neighbor) => neighbor < pr.number);
    const layer = previousOverlaps.length === 0
      ? 0
      : Math.max(...previousOverlaps.map((neighbor) => decisions.get(neighbor)?.layer ?? 0)) + 1;
    if (layer > 0) {
      decisions.set(pr.number, {
        prNumber: pr.number,
        status: 'serialized',
        stopRule: 'overlap serialization',
        reasons: [`changed files overlap with PR(s): ${previousOverlaps.map((value) => `#${value}`).join(', ')}`],
        layer,
        overlapsWith: previousOverlaps,
      });
    } else {
      decisions.set(pr.number, {
        prNumber: pr.number,
        status: 'ready',
        reasons: [],
        layer,
      });
    }
    layers[layer] ??= [];
    layers[layer]!.push(pr.number);
  }

  return {
    decisions: sorted.map((pr) => decisions.get(pr.number)!),
    graph,
    layers,
    evictions,
  };
}

export function buildMergeQueueRepairPrompt(eviction: MergeQueueEvictionContext): string {
  return [
    '## MERGE QUEUE EVICTION',
    '',
    `PR: #${eviction.prNumber}`,
    `Reason: ${eviction.reason}`,
    `Landed PRs before eviction: ${eviction.landedPrNumbers.map((pr) => `#${pr}`).join(', ') || 'none'}`,
    '',
    'Conflicting files:',
    ...eviction.conflictingPaths.map((path) => `- ${path}`),
    '',
    'Merge-tree output:',
    eviction.mergeTreeOutput ?? 'not captured',
    '',
    'Diff context:',
    eviction.diffContext ?? 'not captured',
    '',
    'Repair instruction: create a review-fix worktree, rebase on current main, resolve only the listed files, run quality gates, and push the same PR head.',
  ].join('\n');
}
