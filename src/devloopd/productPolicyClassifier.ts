import type { AutomationPolicyCategory } from './autonomyPolicy.js';

export type ProductPolicyImpact = 'mechanical' | 'implementation' | 'product_policy' | 'human_policy';

export interface ProductPolicyClassificationInput {
  changedPaths: readonly string[];
  title?: string;
  body?: string;
  diff?: string;
}

export interface ProductPolicyEvidenceHunk {
  path: string;
  reason: string;
  snippet: string;
}

export interface ProductPolicyClassification {
  impact: ProductPolicyImpact;
  policyCategory: AutomationPolicyCategory;
  requiresHumanReview: boolean;
  reasons: string[];
  evidencePaths: string[];
  evidenceHunks: ProductPolicyEvidenceHunk[];
}

interface PathRule {
  test(path: string): boolean;
  reason: string;
}

interface SemanticDiffRule {
  name: string;
  test(text: string, path: string): boolean;
  reason: string;
}

const PRODUCT_POLICY_PATH_RULES: readonly PathRule[] = [
  {
    test: (path) => /(^|\/)(migrations?|schema-migrations|db\/migrations?)(\/|$)/u.test(path),
    reason: 'migration or schema state can change irreversible operational behavior',
  },
  {
    test: (path) => /(^|\/)(auth|authentication|billing|payments?|pricing|plans?|subscriptions?|entitlements?)(\/|\.|$)/u.test(path),
    reason: 'auth, billing, pricing, or entitlement behavior changes product policy',
  },
  {
    test: (path) => /(^|\/)(security|permissions?|roles?|rbac|privacy|retention|compliance)(\/|\.|$)/u.test(path),
    reason: 'security, privacy, permissions, or retention posture requires human review',
  },
  {
    test: (path) => /(^|\/)(openapi|public-api|api-contracts?|contracts?)(\/|\.|$)/u.test(path),
    reason: 'public API contract changes require human review',
  },
  {
    test: (path) => /(^|\/)src\/routes\/.*(auth|billing|payments?|pricing|plans?|contracts?|public-api|retention)/u.test(path),
    reason: 'route changes touching public policy or API contracts require human review',
  },
  {
    test: (path) => /(^|\/)(infra|terraform|\.github\/workflows)(\/|$)/u.test(path),
    reason: 'deployment, CI, or infrastructure changes alter operational policy',
  },
];

const PRODUCT_POLICY_TEXT_TOKENS = [
  'pricing',
  'billing',
  'payment',
  'authentication',
  'authorization',
  'security posture',
  'data retention',
  'privacy',
  'terms',
  'public api',
  'migration',
  'roadmap',
];

const SECURITY_HARDENING_TOKENS = [
  'redact',
  'sanitize',
  'validate input',
  'escape',
  'constant-time',
  'constant time',
  'rate limit',
  'least privilege',
];

const HUMAN_POLICY_TEXT_TOKENS = [
  'human review',
  'lane taxonomy',
  'auto-merge policy',
  'merge policy',
  'review gate',
  'product-policy boundary',
];

const SEMANTIC_DIFF_RULES: readonly SemanticDiffRule[] = [
  {
    name: 'user-facing-commitment',
    test: (text) => /\b(guarantee|commit(?:ment)?|sla|available|unlimited|we will|users can|customers can|supports?)\b/iu.test(text),
    reason: 'diff changes a user-facing commitment',
  },
  {
    name: 'public-api-contract',
    test: (text, path) => /(^|\/)(openapi|public-api|api-contracts?|contracts?|cli|commands?)(\/|\.|$)/u.test(path)
      || /\b(public api|breaking change|deprecated|remove(?:d)? option|rename(?:d)? option|export interface|export type|export function)\b/iu.test(text),
    reason: 'diff changes a public API or CLI compatibility contract',
  },
  {
    name: 'auth-billing-retention',
    test: (text) => /(auth|authentication|authorization|permission|rbac|role|billing|pricing|payment|subscription|entitlement|retention|delete after|deleteafter|ttl)/iu.test(text),
    reason: 'diff changes auth, billing, entitlement, or data-retention behavior',
  },
  {
    name: 'security-posture',
    test: (text) => /\b(security posture|allow unauthenticated|disable csrf|disable auth|skip permission|bypass auth|public access|risk accepted|permit all|default allow)\b/iu.test(text),
    reason: 'diff changes security posture rather than ordinary hardening',
  },
  {
    name: 'migration-or-irreversible',
    test: (text, path) => /(^|\/)(migrations?|schema-migrations|db\/migrations?)(\/|$)/u.test(path)
      || /\b(drop table|truncate|destructive|irreversible|backfill|schema migration|data migration)\b/iu.test(text),
    reason: 'diff changes migration or irreversible operational behavior',
  },
];

const PACKAGE_METADATA_PATHS = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

function isDocsPath(path: string): boolean {
  return path === 'readme.md'
    || path.endsWith('.md')
    || path.startsWith('docs/')
    || path.startsWith('examples/');
}

function isTestPath(path: string): boolean {
  return path.includes('/__tests__/')
    || path.includes('/test/')
    || path.startsWith('test/')
    || path.startsWith('tests/')
    || path.includes('/fixtures/')
    || /\.test\.[cm]?[jt]sx?$/u.test(path)
    || /\.spec\.[cm]?[jt]sx?$/u.test(path);
}

function isLowRiskToolingPath(path: string): boolean {
  return PACKAGE_METADATA_PATHS.has(path)
    || path.startsWith('tools/')
    || path.startsWith('scripts/')
    || path.endsWith('.config.js')
    || path.endsWith('.config.ts')
    || path === 'tsconfig.json'
    || path === 'eslint.config.js';
}

function summarizeText(input: ProductPolicyClassificationInput): string {
  return [input.title, input.body].filter((value): value is string => value !== undefined).join('\n').toLowerCase();
}

function currentDiffPath(line: string): string | undefined {
  const match = /^diff --git a\/.+ b\/(.+)$/u.exec(line);
  return match?.[1];
}

function isAddedSemanticLine(line: string): boolean {
  return line.startsWith('+') && !line.startsWith('+++');
}

function parseDiffEvidence(diff: string | undefined): ProductPolicyEvidenceHunk[] {
  if (diff === undefined || diff.trim().length === 0) {
    return [];
  }

  const evidence: ProductPolicyEvidenceHunk[] = [];
  let path = 'unknown';
  let hunkHeader = '';
  const lines = diff.split('\n');
  for (const line of lines) {
    const nextPath = currentDiffPath(line);
    if (nextPath !== undefined) {
      path = normalizePath(nextPath);
      hunkHeader = '';
      continue;
    }
    if (line.startsWith('@@')) {
      hunkHeader = line.trim();
      continue;
    }
    if (!isAddedSemanticLine(line)) {
      continue;
    }
    const text = line.slice(1).trim();
    if (text.length === 0) {
      continue;
    }
    for (const rule of SEMANTIC_DIFF_RULES) {
      if (!rule.test(text, path)) {
        continue;
      }
      if (rule.name === 'security-posture' && SECURITY_HARDENING_TOKENS.some((token) => text.toLowerCase().includes(token))) {
        continue;
      }
      evidence.push({
        path,
        reason: rule.reason,
        snippet: [hunkHeader, text].filter(Boolean).join(' '),
      });
    }
  }
  return evidence;
}

export function classifyProductPolicyImpact(input: ProductPolicyClassificationInput): ProductPolicyClassification {
  const changedPaths = unique(input.changedPaths.map(normalizePath).filter((path) => path.length > 0));
  const productPolicyReasons: string[] = [];
  const productPolicyPaths: string[] = [];
  const semanticEvidence = parseDiffEvidence(input.diff);

  for (const path of changedPaths) {
    const rule = PRODUCT_POLICY_PATH_RULES.find((candidate) => candidate.test(path));
    if (rule !== undefined) {
      productPolicyReasons.push(rule.reason);
      productPolicyPaths.push(path);
    }
  }
  for (const hunk of semanticEvidence) {
    productPolicyReasons.push(hunk.reason);
    productPolicyPaths.push(hunk.path);
  }

  const summary = summarizeText(input);
  for (const token of PRODUCT_POLICY_TEXT_TOKENS) {
    if (summary.includes(token)) {
      productPolicyReasons.push(`PR summary mentions product-policy token: ${token}`);
    }
  }

  const humanPolicyReasons = HUMAN_POLICY_TEXT_TOKENS
    .filter((token) => summary.includes(token))
    .map((token) => `PR summary mentions human-policy token: ${token}`);

  if (productPolicyReasons.length > 0) {
    return {
      impact: 'product_policy',
      policyCategory: 'product_policy',
      requiresHumanReview: true,
      reasons: unique(productPolicyReasons),
      evidencePaths: unique(productPolicyPaths),
      evidenceHunks: semanticEvidence,
    };
  }

  if (humanPolicyReasons.length > 0) {
    return {
      impact: 'human_policy',
      policyCategory: 'human_policy',
      requiresHumanReview: true,
      reasons: unique(humanPolicyReasons),
      evidencePaths: changedPaths,
      evidenceHunks: [],
    };
  }

  if (changedPaths.length > 0 && changedPaths.every((path) => isDocsPath(path) || isTestPath(path))) {
    return {
      impact: 'mechanical',
      policyCategory: 'mechanical',
      requiresHumanReview: false,
      reasons: ['only docs, tests, fixtures, or examples changed'],
      evidencePaths: changedPaths,
      evidenceHunks: [],
    };
  }

  if (changedPaths.length > 0 && changedPaths.every((path) => isLowRiskToolingPath(path) || isDocsPath(path) || isTestPath(path))) {
    return {
      impact: 'implementation',
      policyCategory: 'auto_recursive',
      requiresHumanReview: false,
      reasons: ['tooling or package metadata changed without product-policy indicators'],
      evidencePaths: changedPaths.filter(isLowRiskToolingPath),
      evidenceHunks: [],
    };
  }

  return {
    impact: 'implementation',
    policyCategory: 'auto_recursive',
    requiresHumanReview: false,
    // Keep non-policy behavior changes eligible for the dual-LLM gate; humans
    // should spend time on product direction, not routine scoped implementation.
    reasons: ['scoped implementation change without product-policy indicators'],
    evidencePaths: changedPaths,
    evidenceHunks: [],
  };
}
