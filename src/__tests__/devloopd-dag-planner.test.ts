import { describe, expect, it } from 'vitest';
import { planDagWorkUnits } from '../devloopd/workUnitPlanner.js';

describe('devloopd DAG work-unit planner', () => {
  it('keeps implementation and characterization tests in the same work unit', () => {
    const plan = planDagWorkUnits([
      {
        id: 'planner-cache',
        title: 'Refactor planner cache',
        body: 'Idiomatic refactor with characterization coverage',
        lane: 'idiomatic_refactor',
        changedSurfaces: ['src/devloopd/planner.ts'],
        acceptanceCriteria: ['Behavior is preserved'],
      },
    ]);

    expect(plan.units[0]?.changedSurfaces).toContain('src/devloopd/planner.ts');
    expect(plan.units[0]?.changedSurfaces).toContain('src/__tests__/planner.test.ts');
    expect(plan.layers).toEqual([['planner-cache']]);
  });

  it('adds dependencies for overlapping file surfaces and produces layers', () => {
    const plan = planDagWorkUnits([
      {
        id: 'queue-core',
        title: 'Add merge queue core',
        body: 'Implement queue',
        lane: 'feature_improvement',
        changedSurfaces: ['src/devloopd/mergeQueue.ts'],
        acceptanceCriteria: ['Queue evaluates overlap'],
      },
      {
        id: 'queue-cli',
        title: 'Expose merge queue CLI',
        body: 'Use queue core from devloopd CLI',
        lane: 'docs_tests_tooling',
        changedSurfaces: ['src/devloopd/mergeQueue.ts', 'src/app/devloopd/index.ts'],
        acceptanceCriteria: ['CLI prints plan'],
      },
    ]);

    expect(plan.units.find((unit) => unit.id === 'queue-cli')?.deps).toContain('queue-core');
    expect(plan.layers).toEqual([['queue-core'], ['queue-cli']]);
  });

  it('marks product-policy work units as human-review-required', () => {
    const plan = planDagWorkUnits([
      {
        id: 'pricing-policy',
        title: 'Change pricing policy',
        body: 'Product direction decision',
        lane: 'feature_improvement',
        policyCategory: 'product_policy',
        changedSurfaces: ['docs/pricing.md'],
        acceptanceCriteria: ['Human approves policy'],
      },
    ]);

    expect(plan.humanReviewRequired).toBe(true);
    expect(plan.units[0]).toMatchObject({
      humanReviewRequired: true,
      tier: 'large',
    });
  });
});
