import { describe, expect, it } from 'vitest';
import {
  buildChangedFileGraph,
  buildMergeQueueRepairPrompt,
  planMergeQueue,
} from '../devloopd/mergeQueue.js';

describe('devloopd merge queue', () => {
  it('allows non-overlapping PRs to land in the same queue layer', () => {
    const plan = planMergeQueue([
      {
        number: 10,
        title: 'docs',
        headRefOid: 'a1',
        changedPaths: ['docs/devloopd.md'],
        checksPassed: true,
        dualLlmApproved: true,
      },
      {
        number: 11,
        title: 'tests',
        headRefOid: 'b2',
        changedPaths: ['src/__tests__/devloopd.test.ts'],
        checksPassed: true,
        dualLlmApproved: true,
      },
    ]);

    expect(plan.layers).toEqual([[10, 11]]);
    expect(plan.decisions.map((decision) => decision.status)).toEqual(['ready', 'ready']);
  });

  it('serializes overlapping changed files and records the overlap edge', () => {
    const prs = [
      {
        number: 20,
        title: 'first',
        headRefOid: 'a1',
        changedPaths: ['src/devloopd/prAutomation.ts'],
        checksPassed: true,
        dualLlmApproved: true,
      },
      {
        number: 21,
        title: 'second',
        headRefOid: 'b2',
        changedPaths: ['src/devloopd/prAutomation.ts', 'src/devloopd/mergeGate.ts'],
        checksPassed: true,
        dualLlmApproved: true,
      },
    ];

    expect(buildChangedFileGraph(prs).edges).toEqual([
      { left: 20, right: 21, overlapPaths: ['src/devloopd/prAutomation.ts'] },
    ]);
    const plan = planMergeQueue(prs);

    expect(plan.layers).toEqual([[20], [21]]);
    expect(plan.decisions[1]).toMatchObject({
      prNumber: 21,
      status: 'serialized',
      stopRule: 'overlap serialization',
      overlapsWith: [20],
    });
  });

  it('blocks unsafe gates before merge and keeps reasons machine-readable', () => {
    const plan = planMergeQueue([
      {
        number: 30,
        title: 'policy',
        headRefOid: 'a1',
        expectedHeadSha: 'old',
        changedPaths: ['src/public-api.ts'],
        checksPassed: false,
        dualLlmApproved: false,
        productPolicyRequiresHumanReview: true,
      },
    ]);

    expect(plan.decisions[0]).toMatchObject({
      status: 'blocked',
      stopRule: 'head mismatch',
    });
    expect(plan.decisions[0]?.reasons).toContain('head SHA mismatch: expected old, got a1');
  });

  it('evicts dirty or conflicted PRs with repair context', () => {
    const plan = planMergeQueue([
      {
        number: 40,
        title: 'conflict',
        headRefOid: 'a1',
        changedPaths: ['src/devloopd/mergeQueue.ts'],
        checksPassed: true,
        dualLlmApproved: true,
        mergeStateStatus: 'DIRTY',
        mergeTreeOutput: 'CONFLICT (content): src/devloopd/mergeQueue.ts',
        landedPrNumbers: [39],
      },
    ]);

    expect(plan.decisions[0]).toMatchObject({
      status: 'evicted',
      stopRule: 'conflict eviction',
    });
    expect(plan.evictions[0]).toMatchObject({
      prNumber: 40,
      conflictingPaths: ['src/devloopd/mergeQueue.ts'],
      landedPrNumbers: [39],
    });
    expect(buildMergeQueueRepairPrompt(plan.evictions[0]!)).toContain('CONFLICT (content)');
  });

  it('preserves DAG work-unit metadata and waits for later DAG layers', () => {
    const plan = planMergeQueue([
      {
        number: 50,
        title: 'layer one',
        workUnitId: 'queue-layer-1',
        dagLayer: 1,
        headRefOid: 'a1',
        changedPaths: ['src/devloopd/workUnitPlanner.ts'],
        checksPassed: true,
        dualLlmApproved: true,
      },
    ]);

    expect(plan.layers).toEqual([[], [50]]);
    expect(plan.decisions[0]).toMatchObject({
      prNumber: 50,
      workUnitId: 'queue-layer-1',
      dagLayer: 1,
      layer: 1,
      status: 'serialized',
    });
    expect(plan.decisions[0]?.reasons).toContain('waiting for DAG layer 1');
  });
});
