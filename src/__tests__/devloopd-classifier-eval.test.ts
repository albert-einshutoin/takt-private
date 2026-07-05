import { describe, expect, it } from 'vitest';
import {
  PRODUCT_POLICY_CLASSIFIER_EVAL_FIXTURES,
  runProductPolicyClassifierEval,
} from '../devloopd/productPolicyClassifierEval.js';

describe('devloopd product-policy classifier eval', () => {
  it('keeps classifier false positives and false negatives within thresholds', () => {
    const report = runProductPolicyClassifierEval();

    expect(report.passed).toBe(true);
    expect(report.falsePositives).toBe(0);
    expect(report.falseNegatives).toBe(0);
    expect(report.mismatches).toEqual([]);
    expect(report.total).toBe(PRODUCT_POLICY_CLASSIFIER_EVAL_FIXTURES.length);
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
});
