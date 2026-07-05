import { classifyProductPolicyImpact, type ProductPolicyClassificationInput, type ProductPolicyImpact } from './productPolicyClassifier.js';

export interface ProductPolicyClassifierEvalFixture {
  id: string;
  expectedImpact: ProductPolicyImpact;
  input: ProductPolicyClassificationInput;
}

export interface ProductPolicyClassifierEvalThresholds {
  maxFalsePositives: number;
  maxFalseNegatives: number;
}

export interface ProductPolicyClassifierEvalReport {
  passed: boolean;
  total: number;
  falsePositives: number;
  falseNegatives: number;
  mismatches: Array<{
    id: string;
    expectedImpact: ProductPolicyImpact;
    actualImpact: ProductPolicyImpact;
    reasons: readonly string[];
  }>;
  thresholds: ProductPolicyClassifierEvalThresholds;
}

export const PRODUCT_POLICY_CLASSIFIER_EVAL_FIXTURES: readonly ProductPolicyClassifierEvalFixture[] = [
  {
    id: 'mechanical-docs-only',
    expectedImpact: 'mechanical',
    input: {
      changedPaths: ['docs/devloopd.md'],
      title: 'docs: clarify local setup',
      diff: 'diff --git a/docs/devloopd.md b/docs/devloopd.md\n@@\n+Run npm test before opening a PR.',
    },
  },
  {
    id: 'mechanical-tests-only',
    expectedImpact: 'mechanical',
    input: {
      changedPaths: ['src/__tests__/devloopd-product-policy-classifier.test.ts'],
      title: 'test: add classifier regression',
      diff: 'diff --git a/src/__tests__/x.test.ts b/src/__tests__/x.test.ts\n@@\n+expect(result.requiresHumanReview).toBe(false);',
    },
  },
  {
    id: 'implementation-package-metadata',
    expectedImpact: 'implementation',
    input: {
      changedPaths: ['package.json', 'package-lock.json'],
      title: 'chore: update test tooling patch version',
      diff: 'diff --git a/package.json b/package.json\n@@\n+    "vitest": "^3.2.7"',
    },
  },
  {
    id: 'implementation-security-hardening',
    expectedImpact: 'implementation',
    input: {
      changedPaths: ['src/shared/utils/sensitiveText.ts'],
      title: 'fix: redact tokens from logs',
      diff: 'diff --git a/src/shared/utils/sensitiveText.ts b/src/shared/utils/sensitiveText.ts\n@@\n+const redacted = sanitize(input).replace(secretPattern, "[REDACTED]");',
    },
  },
  {
    id: 'product-policy-public-api-contract',
    expectedImpact: 'product_policy',
    input: {
      changedPaths: ['src/public-api/client.ts'],
      title: 'feat: rename public API option',
      diff: 'diff --git a/src/public-api/client.ts b/src/public-api/client.ts\n@@\n+export interface ClientOptions { renamedOption: string }',
    },
  },
  {
    id: 'product-policy-auth-billing',
    expectedImpact: 'product_policy',
    input: {
      changedPaths: ['src/routes/settings.ts'],
      title: 'feat: update account settings',
      diff: 'diff --git a/src/routes/settings.ts b/src/routes/settings.ts\n@@\n+if (user.role === "admin") enableBillingPlanChange();',
    },
  },
  {
    id: 'product-policy-security-posture',
    expectedImpact: 'product_policy',
    input: {
      changedPaths: ['src/middleware/security.ts'],
      title: 'feat: relax public access',
      diff: 'diff --git a/src/middleware/security.ts b/src/middleware/security.ts\n@@\n+allowUnauthenticatedRequests = true;',
    },
  },
  {
    id: 'product-policy-migration',
    expectedImpact: 'product_policy',
    input: {
      changedPaths: ['migrations/20260705_drop_old_table.sql'],
      title: 'chore: drop old table',
      diff: 'diff --git a/migrations/20260705_drop_old_table.sql b/migrations/20260705_drop_old_table.sql\n@@\n+DROP TABLE old_sessions;',
    },
  },
];

const DEFAULT_THRESHOLDS: ProductPolicyClassifierEvalThresholds = {
  maxFalsePositives: 0,
  maxFalseNegatives: 0,
};

function isPolicy(impact: ProductPolicyImpact): boolean {
  return impact === 'product_policy' || impact === 'human_policy';
}

export function runProductPolicyClassifierEval(options: {
  fixtures?: readonly ProductPolicyClassifierEvalFixture[];
  thresholds?: Partial<ProductPolicyClassifierEvalThresholds>;
} = {}): ProductPolicyClassifierEvalReport {
  const fixtures = options.fixtures ?? PRODUCT_POLICY_CLASSIFIER_EVAL_FIXTURES;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const mismatches = fixtures.flatMap((fixture) => {
    const actual = classifyProductPolicyImpact(fixture.input);
    return actual.impact === fixture.expectedImpact
      ? []
      : [{
        id: fixture.id,
        expectedImpact: fixture.expectedImpact,
        actualImpact: actual.impact,
        reasons: actual.reasons,
      }];
  });
  const falsePositives = mismatches.filter((item) => !isPolicy(item.expectedImpact) && isPolicy(item.actualImpact)).length;
  const falseNegatives = mismatches.filter((item) => isPolicy(item.expectedImpact) && !isPolicy(item.actualImpact)).length;

  return {
    passed: falsePositives <= thresholds.maxFalsePositives && falseNegatives <= thresholds.maxFalseNegatives && mismatches.length === 0,
    total: fixtures.length,
    falsePositives,
    falseNegatives,
    mismatches,
    thresholds,
  };
}
