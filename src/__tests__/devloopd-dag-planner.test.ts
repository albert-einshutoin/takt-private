import { describe, expect, it } from 'vitest';
import { buildExecutableDagWorkUnitPlan, planDagWorkUnits } from '../devloopd/workUnitPlanner.js';

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

  it('builds an executable DAG plan with worktree isolation, quality gates, and paused policy units', () => {
    const plan = buildExecutableDagWorkUnitPlan([
      {
        id: 'safe-refactor',
        title: 'Refactor scheduler helper',
        body: 'Scoped implementation refactor',
        lane: 'idiomatic_refactor',
        changedSurfaces: ['src/devloopd/stagedScheduler.ts'],
        acceptanceCriteria: ['Behavior stays the same'],
      },
      {
        id: 'policy-change',
        title: 'Change public API contract',
        body: 'Product direction decision',
        lane: 'feature_improvement',
        policyCategory: 'product_policy',
        changedSurfaces: ['src/public-api/client.ts'],
        acceptanceCriteria: ['Human approves the contract'],
      },
    ]);

    expect(plan.executableUnits.find((unit) => unit.id === 'safe-refactor')).toMatchObject({
      status: 'ready',
      isolation: 'worktree',
      mergeQueueLayer: 0,
    });
    expect(plan.executableUnits.find((unit) => unit.id === 'safe-refactor')?.qualityGates).toContain('npm run build');
    expect(plan.executableUnits.find((unit) => unit.id === 'policy-change')).toMatchObject({
      status: 'paused',
      pausedReason: 'human review required before implementation',
    });
  });
});
