import { classifyProductPolicyImpact, type ProductPolicyClassificationInput, type ProductPolicyImpact } from './productPolicyClassifier.js';
import type { DevloopLedgerEvent } from './ledger.js';

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
  categoryCounts: Record<ProductPolicyImpact, {
    expected: number;
    actual: number;
    mismatches: number;
  }>;
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

export const PRODUCT_POLICY_CLASSIFIER_REPLAY_FIXTURES: readonly ProductPolicyClassifierEvalFixture[] = [
  {
    id: 'replay-safe-dependency-patch',
    expectedImpact: 'implementation',
    input: {
      changedPaths: ['package.json', 'package-lock.json'],
      title: 'chore: update dev dependency patch version',
      body: 'Automation updated a patch-level test dependency without runtime behavior changes.',
      diff: 'diff --git a/package.json b/package.json\n@@\n+    "vitest": "^3.2.8"',
    },
  },
  {
    id: 'replay-public-cli-contract',
    expectedImpact: 'product_policy',
    input: {
      changedPaths: ['src/app/cli/index.ts'],
      title: 'feat: rename CLI option',
      body: 'This changes a public command-line contract.',
      diff: 'diff --git a/src/app/cli/index.ts b/src/app/cli/index.ts\n@@\n+program.option("--renamed-output <path>");',
    },
  },
  {
    id: 'replay-security-hardening',
    expectedImpact: 'implementation',
    input: {
      changedPaths: ['src/shared/utils/sensitiveText.ts'],
      title: 'fix: strengthen token redaction',
      body: 'Security hardening that redacts additional provider token formats.',
      diff: 'diff --git a/src/shared/utils/sensitiveText.ts b/src/shared/utils/sensitiveText.ts\n@@\n+redactKnownProviderTokens(input);',
    },
  },
  {
    id: 'replay-security-posture-downgrade',
    expectedImpact: 'product_policy',
    input: {
      changedPaths: ['src/middleware/security.ts'],
      title: 'feat: allow unauthenticated access for trial users',
      body: 'Security posture tradeoff for onboarding.',
      diff: 'diff --git a/src/middleware/security.ts b/src/middleware/security.ts\n@@\n+allowUnauthenticatedRequests = true;',
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

function emptyCategoryCounts(): ProductPolicyClassifierEvalReport['categoryCounts'] {
  return {
    mechanical: { expected: 0, actual: 0, mismatches: 0 },
    implementation: { expected: 0, actual: 0, mismatches: 0 },
    product_policy: { expected: 0, actual: 0, mismatches: 0 },
    human_policy: { expected: 0, actual: 0, mismatches: 0 },
  };
}

function isProductPolicyImpact(value: unknown): value is ProductPolicyImpact {
  return value === 'mechanical'
    || value === 'implementation'
    || value === 'product_policy'
    || value === 'human_policy';
}

function replayInputFromEvent(event: DevloopLedgerEvent): ProductPolicyClassificationInput | undefined {
  const input = event.input;
  if (typeof input === 'object' && input !== null && Array.isArray((input as { changedPaths?: unknown }).changedPaths)) {
    const candidate = input as {
      changedPaths: unknown[];
      title?: unknown;
      body?: unknown;
      diff?: unknown;
    };
    return {
      changedPaths: candidate.changedPaths.filter((path): path is string => typeof path === 'string'),
      ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
      ...(typeof candidate.body === 'string' ? { body: candidate.body } : {}),
      ...(typeof candidate.diff === 'string' ? { diff: candidate.diff.slice(0, 12_000) } : {}),
    };
  }
  if (Array.isArray(event.changedPaths)) {
    return {
      changedPaths: event.changedPaths.filter((path): path is string => typeof path === 'string'),
      ...(typeof event.title === 'string' ? { title: event.title } : {}),
      ...(typeof event.body === 'string' ? { body: event.body } : {}),
      ...(typeof event.diff === 'string' ? { diff: event.diff.slice(0, 12_000) } : {}),
    };
  }
  return undefined;
}

export function buildProductPolicyReplayFixtures(
  events: readonly DevloopLedgerEvent[],
): ProductPolicyClassifierEvalFixture[] {
  return events.flatMap((event) => {
    if (event.eventType !== 'devloop_product_policy_replay' || !isProductPolicyImpact(event.expectedImpact)) {
      return [];
    }
    const input = replayInputFromEvent(event);
    if (input === undefined || input.changedPaths.length === 0) {
      return [];
    }
    return [{
      id: typeof event.replayId === 'string' ? event.replayId : event.eventId,
      expectedImpact: event.expectedImpact,
      input,
    }];
  });
}

export function runProductPolicyClassifierEval(options: {
  fixtures?: readonly ProductPolicyClassifierEvalFixture[];
  replayEvents?: readonly DevloopLedgerEvent[];
  thresholds?: Partial<ProductPolicyClassifierEvalThresholds>;
} = {}): ProductPolicyClassifierEvalReport {
  const fixtures = [
    ...(options.fixtures ?? PRODUCT_POLICY_CLASSIFIER_EVAL_FIXTURES),
    ...PRODUCT_POLICY_CLASSIFIER_REPLAY_FIXTURES,
    ...(options.replayEvents === undefined ? [] : buildProductPolicyReplayFixtures(options.replayEvents)),
  ];
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const categoryCounts = emptyCategoryCounts();
  const mismatches = fixtures.flatMap((fixture) => {
    const actual = classifyProductPolicyImpact(fixture.input);
    categoryCounts[fixture.expectedImpact].expected += 1;
    categoryCounts[actual.impact].actual += 1;
    if (actual.impact !== fixture.expectedImpact) {
      categoryCounts[fixture.expectedImpact].mismatches += 1;
    }
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
    categoryCounts,
    mismatches,
    thresholds,
  };
}
