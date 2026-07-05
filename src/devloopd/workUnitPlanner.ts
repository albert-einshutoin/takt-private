import type { AutomationPolicyCategory, RecursiveAutomationLane } from './autonomyPolicy.js';

export type WorkUnitTier = 'trivial' | 'small' | 'medium' | 'large';

export interface BacklogWorkItem {
  id: string;
  title: string;
  body: string;
  lane: RecursiveAutomationLane;
  policyCategory?: AutomationPolicyCategory;
  changedSurfaces: readonly string[];
  acceptanceCriteria: readonly string[];
  dependsOn?: readonly string[];
}

export interface PlannedWorkUnit {
  id: string;
  title: string;
  body: string;
  lane: RecursiveAutomationLane;
  tier: WorkUnitTier;
  deps: readonly string[];
  changedSurfaces: readonly string[];
  acceptanceCriteria: readonly string[];
  humanReviewRequired: boolean;
}

export interface DagWorkUnitPlan {
  units: readonly PlannedWorkUnit[];
  layers: readonly (readonly string[])[];
  humanReviewRequired: boolean;
}

export type WorkUnitIsolationStrategy = 'worktree';
export type ExecutableWorkUnitStatus = 'ready' | 'waiting' | 'paused';

export interface ExecutablePlannedWorkUnit extends PlannedWorkUnit {
  status: ExecutableWorkUnitStatus;
  isolation: WorkUnitIsolationStrategy;
  expectedChangedPaths: readonly string[];
  qualityGates: readonly string[];
  mergeQueueLayer: number;
  pausedReason?: string;
}

export interface ExecutableDagWorkUnitPlan extends DagWorkUnitPlan {
  executableUnits: readonly ExecutablePlannedWorkUnit[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function companionTestSurface(path: string): string | undefined {
  const match = /^src\/(?:devloopd\/)?([^/]+)\.ts$/u.exec(path);
  if (match?.[1] === undefined || path.includes('__tests__')) {
    return undefined;
  }
  return `src/__tests__/${match[1]}.test.ts`;
}

function expandChangedSurfaces(surfaces: readonly string[]): string[] {
  return unique([
    ...surfaces,
    ...surfaces.flatMap((surface) => {
      const companion = companionTestSurface(surface);
      return companion === undefined ? [] : [companion];
    }),
  ]);
}

function surfacesOverlap(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((surface) => rightSet.has(surface));
}

function requiresHumanReview(item: BacklogWorkItem): boolean {
  return item.policyCategory === 'product_policy' || item.policyCategory === 'human_policy';
}

function tierFor(item: BacklogWorkItem, surfaces: readonly string[], humanReviewRequired: boolean): WorkUnitTier {
  if (humanReviewRequired) return 'large';
  if (surfaces.length >= 5 || item.body.length > 1_200) return 'large';
  if (surfaces.length >= 3 || item.lane === 'feature_improvement' || item.lane === 'performance') return 'medium';
  if (surfaces.length === 1 && item.lane === 'docs_tests_tooling') return 'trivial';
  return 'small';
}

function buildDeps(item: BacklogWorkItem, index: number, planned: readonly PlannedWorkUnit[]): string[] {
  const explicit = item.dependsOn ?? [];
  const overlapDeps = planned
    .slice(0, index)
    .filter((unit) => surfacesOverlap(expandChangedSurfaces(item.changedSurfaces), unit.changedSurfaces))
    .map((unit) => unit.id);
  return unique([...explicit, ...overlapDeps]);
}

function topologicalLayers(units: readonly PlannedWorkUnit[]): string[][] {
  const remaining = new Map(units.map((unit) => [unit.id, new Set(unit.deps)]));
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((dep) => !remaining.has(dep)))
      .map(([id]) => id)
      .sort((left, right) => left.localeCompare(right));
    if (ready.length === 0) {
      layers.push([...remaining.keys()].sort((left, right) => left.localeCompare(right)));
      break;
    }
    layers.push(ready);
    for (const id of ready) {
      remaining.delete(id);
    }
  }
  return layers;
}

function defaultQualityGates(unit: PlannedWorkUnit): string[] {
  const gates = ['npm run build', 'npm run lint'];
  if (unit.changedSurfaces.some((surface) => surface.includes('__tests__') || surface.endsWith('.test.ts'))) {
    gates.push('npm test -- changed test files');
  } else {
    gates.push('npm test -- focused devloopd tests');
  }
  if (unit.lane === 'security_hardening') {
    gates.push('security self-review: verify no secrets or weaker posture');
  }
  return gates;
}

function layerByUnitId(layers: readonly (readonly string[])[]): Map<string, number> {
  const result = new Map<string, number>();
  layers.forEach((layer, index) => {
    for (const id of layer) {
      result.set(id, index);
    }
  });
  return result;
}

export function planDagWorkUnits(items: readonly BacklogWorkItem[]): DagWorkUnitPlan {
  const planned: PlannedWorkUnit[] = [];
  items.forEach((item, index) => {
    const changedSurfaces = expandChangedSurfaces(item.changedSurfaces);
    const humanReviewRequired = requiresHumanReview(item);
    const deps = buildDeps(item, index, planned);
    planned.push({
      id: item.id,
      title: item.title,
      body: item.body,
      lane: item.lane,
      tier: tierFor(item, changedSurfaces, humanReviewRequired),
      deps,
      changedSurfaces,
      acceptanceCriteria: item.acceptanceCriteria,
      humanReviewRequired,
    });
  });

  return {
    units: planned,
    layers: topologicalLayers(planned),
    humanReviewRequired: planned.some((unit) => unit.humanReviewRequired),
  };
}

export function buildExecutableDagWorkUnitPlan(items: readonly BacklogWorkItem[]): ExecutableDagWorkUnitPlan {
  const plan = planDagWorkUnits(items);
  const layerMap = layerByUnitId(plan.layers);
  const executableUnits = plan.units.map((unit): ExecutablePlannedWorkUnit => {
    const mergeQueueLayer = layerMap.get(unit.id) ?? 0;
    const status: ExecutableWorkUnitStatus = unit.humanReviewRequired
      ? 'paused'
      : unit.deps.length > 0
        ? 'waiting'
        : 'ready';
    return {
      ...unit,
      status,
      isolation: 'worktree',
      expectedChangedPaths: unit.changedSurfaces,
      qualityGates: defaultQualityGates(unit),
      mergeQueueLayer,
      ...(unit.humanReviewRequired ? { pausedReason: 'human review required before implementation' } : {}),
    };
  });

  return {
    ...plan,
    executableUnits,
  };
}
