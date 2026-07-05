import { describe, expect, it } from 'vitest';
import { classifyProductPolicyImpact } from '../devloopd/productPolicyClassifier.js';

describe('devloopd product-policy classifier', () => {
  it('classifies docs-only changes as mechanical', () => {
    const result = classifyProductPolicyImpact({
      changedPaths: ['docs/devloopd.md', 'README.md'],
    });

    expect(result.impact).toBe('mechanical');
    expect(result.policyCategory).toBe('mechanical');
    expect(result.requiresHumanReview).toBe(false);
  });

  it('classifies tests-only changes as mechanical', () => {
    const result = classifyProductPolicyImpact({
      changedPaths: ['src/__tests__/devloopd-merge-gate.test.ts', 'test/fixtures/pr.json'],
    });

    expect(result.impact).toBe('mechanical');
    expect(result.requiresHumanReview).toBe(false);
  });

  it('classifies package metadata changes as implementation unless policy tokens are present', () => {
    const result = classifyProductPolicyImpact({
      changedPaths: ['package.json', 'package-lock.json'],
      title: 'chore: add devloopd scheduler tests',
    });

    expect(result.impact).toBe('implementation');
    expect(result.policyCategory).toBe('auto_recursive');
    expect(result.requiresHumanReview).toBe(false);
    expect(result.evidencePaths).toContain('package.json');
  });

  it('classifies auth, billing, and security posture changes as product policy', () => {
    const result = classifyProductPolicyImpact({
      changedPaths: ['src/routes/auth.ts', 'src/billing/pricing.ts', 'src/security/policy.ts'],
    });

    expect(result.impact).toBe('product_policy');
    expect(result.policyCategory).toBe('product_policy');
    expect(result.requiresHumanReview).toBe(true);
    expect(result.evidencePaths).toContain('src/routes/auth.ts');
  });

  it('classifies migrations as product policy', () => {
    const result = classifyProductPolicyImpact({
      changedPaths: ['migrations/20260705_add_retention.sql'],
    });

    expect(result.impact).toBe('product_policy');
    expect(result.reasons.join('\n')).toContain('migration');
  });

  it('classifies automation policy taxonomy changes as human policy', () => {
    const result = classifyProductPolicyImpact({
      changedPaths: ['docs/devloopd.md'],
      title: 'Define lane taxonomy and human review boundary',
    });

    expect(result.impact).toBe('human_policy');
    expect(result.policyCategory).toBe('human_policy');
    expect(result.requiresHumanReview).toBe(true);
  });

  it('classifies public API contract changes as product policy', () => {
    const result = classifyProductPolicyImpact({
      changedPaths: ['openapi/public.yaml', 'src/routes/api/contracts.ts'],
    });

    expect(result.impact).toBe('product_policy');
    expect(result.reasons.join('\n')).toContain('public API');
  });
});
