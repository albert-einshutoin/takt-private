import { describe, expect, it } from 'vitest';
import {
  PRODUCT_POLICY_CLASSIFIER_REPLAY_FIXTURES,
  PRODUCT_POLICY_CLASSIFIER_EVAL_FIXTURES,
  buildProductPolicyReplayFixtures,
  runProductPolicyClassifierEval,
} from '../devloopd/productPolicyClassifierEval.js';

describe('devloopd product-policy classifier eval', () => {
  it('keeps classifier false positives and false negatives within thresholds', () => {
    const report = runProductPolicyClassifierEval();

    expect(report.passed).toBe(true);
    expect(report.falsePositives).toBe(0);
    expect(report.falseNegatives).toBe(0);
    expect(report.mismatches).toEqual([]);
    expect(report.total).toBe(PRODUCT_POLICY_CLASSIFIER_EVAL_FIXTURES.length + PRODUCT_POLICY_CLASSIFIER_REPLAY_FIXTURES.length);
    expect(report.categoryCounts.product_policy.expected).toBeGreaterThan(0);
  });

  it('reports false negatives when product-policy fixtures are missed', () => {
    const report = runProductPolicyClassifierEval({
      fixtures: [{
        id: 'missed-policy',
        expectedImpact: 'product_policy',
        input: {
          changedPaths: ['src/app.ts'],
          title: 'chore: rename local variable',
          diff: 'diff --git a/src/app.ts b/src/app.ts\n@@\n+const value = 1;',
        },
      }],
    });

    expect(report.passed).toBe(false);
    expect(report.falseNegatives).toBe(1);
  });

  it('builds sanitized live replay fixtures from ledger events', () => {
    const fixtures = buildProductPolicyReplayFixtures([
      {
        version: 1,
        eventId: 'evt_replay_public_api',
        eventType: 'devloop_product_policy_replay',
        timestamp: '2026-07-05T00:00:00.000Z',
        replayId: 'public-api-replay',
        expectedImpact: 'product_policy',
        input: {
          changedPaths: ['src/public-api/client.ts'],
          title: 'feat: rename public API option',
          diff: 'diff --git a/src/public-api/client.ts b/src/public-api/client.ts\n@@\n+export interface ClientOptions { renamedOption: string }',
        },
      },
    ]);

    expect(fixtures).toHaveLength(1);
    const report = runProductPolicyClassifierEval({
      fixtures: [],
      replayEvents: [
        {
          version: 1,
          eventId: 'evt_replay_public_api',
          eventType: 'devloop_product_policy_replay',
          timestamp: '2026-07-05T00:00:00.000Z',
          replayId: 'public-api-replay',
          expectedImpact: 'product_policy',
          input: fixtures[0]!.input,
        },
      ],
    });
    expect(report.passed).toBe(true);
    expect(report.total).toBe(PRODUCT_POLICY_CLASSIFIER_REPLAY_FIXTURES.length + 1);
  });
});
