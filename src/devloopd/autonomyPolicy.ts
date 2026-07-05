export type AutomationPolicyCategory = 'product_policy' | 'human_policy' | 'auto_recursive' | 'mechanical';

export type RecursiveAutomationLane =
  | 'feature_improvement'
  | 'performance'
  | 'dependencies'
  | 'security_hardening'
  | 'idiomatic_refactor'
  | 'docs_tests_tooling';

export interface RecursiveAutomationLaneDefinition {
  lane: RecursiveAutomationLane;
  title: string;
  policyCategory: Extract<AutomationPolicyCategory, 'auto_recursive' | 'mechanical'>;
  allowedWork: readonly string[];
  humanReviewEscalation: readonly string[];
  defaultVerification: readonly string[];
  expectedChangedSurfaces: readonly string[];
}

export interface LaneClassificationInput {
  title?: string;
  body?: string;
  labels?: readonly string[];
  changedPaths?: readonly string[];
}

export interface LaneClassification {
  lane: RecursiveAutomationLane;
  policyCategory: Extract<AutomationPolicyCategory, 'auto_recursive' | 'mechanical'>;
  requiresHumanReview: boolean;
  reasons: string[];
}

const LANE_DEFINITIONS: readonly RecursiveAutomationLaneDefinition[] = [
  {
    lane: 'feature_improvement',
    title: 'Feature improvement',
    policyCategory: 'auto_recursive',
    allowedWork: [
      'Scoped implementation improvements for already accepted behavior',
      'Small UX or workflow fixes backed by an existing issue',
    ],
    humanReviewEscalation: [
      'new user-facing promise',
      'pricing, billing, auth, retention, or public API behavior',
      'roadmap or product direction change',
    ],
    defaultVerification: ['npm test -- devloopd', 'npm run build'],
    expectedChangedSurfaces: ['src/**', 'docs/**', 'tests/**'],
  },
  {
    lane: 'performance',
    title: 'Performance',
    policyCategory: 'auto_recursive',
    allowedWork: [
      'Benchmark-backed optimization without public behavior changes',
      'Memory, allocation, or IO efficiency improvements with regression coverage',
    ],
    humanReviewEscalation: [
      'observable behavior change',
      'resource limit policy change',
      'new infrastructure commitment',
    ],
    defaultVerification: ['npm test -- devloopd', 'npm run build'],
    expectedChangedSurfaces: ['src/**', 'benchmarks/**', 'tests/**'],
  },
  {
    lane: 'dependencies',
    title: 'Dependencies',
    policyCategory: 'auto_recursive',
    allowedWork: [
      'Safe library updates with lockfile evidence',
      'Patch or minor updates that preserve public behavior',
    ],
    humanReviewEscalation: [
      'major version migration with public compatibility risk',
      'license or pricing impact',
      'dependency with privileged runtime access',
    ],
    defaultVerification: ['npm test', 'npm run build'],
    expectedChangedSurfaces: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
  },
  {
    lane: 'security_hardening',
    title: 'Security hardening',
    policyCategory: 'auto_recursive',
    allowedWork: [
      'Vulnerability fixes and safer defaults that do not change product posture',
      'Input validation, secret redaction, and least-privilege implementation details',
    ],
    humanReviewEscalation: [
      'security posture or access model change',
      'data retention, privacy, or compliance decision',
      'new public security guarantee',
    ],
    defaultVerification: ['npm test -- security devloopd', 'npm run build'],
    expectedChangedSurfaces: ['src/**', 'tests/**', 'docs/**'],
  },
  {
    lane: 'idiomatic_refactor',
    title: 'Idiomatic refactor',
    policyCategory: 'auto_recursive',
    allowedWork: [
      'Language-idiomatic simplification and type-safety improvements',
      'Scoped refactors that preserve behavior and reduce maintenance cost',
    ],
    humanReviewEscalation: [
      'cross-module architecture direction change',
      'public API or compatibility change',
      'large behavior-preserving claim without verification coverage',
    ],
    defaultVerification: ['npm test -- devloopd', 'npm run build'],
    expectedChangedSurfaces: ['src/**', 'tests/**'],
  },
  {
    lane: 'docs_tests_tooling',
    title: 'Docs, tests, and tooling',
    policyCategory: 'mechanical',
    allowedWork: [
      'Documentation corrections',
      'Test coverage, fixtures, linting, formatting, and local developer tooling',
    ],
    humanReviewEscalation: [
      'documentation that changes product promises',
      'CI or release policy change',
      'tooling that changes deployment or security posture',
    ],
    defaultVerification: ['npm test -- devloopd', 'npm run build'],
    expectedChangedSurfaces: ['docs/**', 'src/__tests__/**', 'test/**', 'scripts/**', 'tools/**'],
  },
];

const LANE_KEYWORDS: Readonly<Record<RecursiveAutomationLane, readonly RegExp[]>> = {
  feature_improvement: [/\bfeature\b/iu, /\bworkflow\b/iu, /\bimprove(?:ment)?\b/iu],
  performance: [/\bperformance\b/iu, /\bperf\b/iu, /\bbenchmark\b/iu, /\bmemory\b/iu, /\blatency\b/iu],
  dependencies: [/\bdependenc(?:y|ies)\b/iu, /\blibrary\b/iu, /\blockfile\b/iu, /\bnpm audit\b/iu, /\bpackage(?:-lock)?\.json\b/iu],
  security_hardening: [/\bsecurity hardening\b/iu, /\bvulnerabilit(?:y|ies)\b/iu, /\bredact\b/iu, /\bsecret\b/iu],
  idiomatic_refactor: [/\brefactor\b/iu, /\bidiomatic\b/iu, /\btype[- ]?safety\b/iu, /\bcleanup\b/iu],
  docs_tests_tooling: [/\bdocs?\b/iu, /\btests?\b/iu, /\bfixtures?\b/iu, /\blint\b/iu, /\btooling\b/iu],
};

const POLICY_ESCALATION_PATTERNS: readonly RegExp[] = [
  /\b(product direction|roadmap|pricing|billing|payment|auth(?:entication|orization)?|data retention|privacy|public api|contract)\b/iu,
  /\b(change|update|define)\s+(lane taxonomy|human review|merge policy|auto-merge policy|review gate)\b/iu,
  /\b(security posture|compliance|terms|migration)\b/iu,
];

function joinedInput(input: LaneClassificationInput): string {
  return [
    input.title,
    input.body,
    input.labels?.join(' '),
    input.changedPaths?.join(' '),
  ].filter((value): value is string => value !== undefined && value.trim().length > 0).join('\n');
}

function normalizeLane(value: string): RecursiveAutomationLane | undefined {
  const normalized = value.trim().toLowerCase().replaceAll('-', '_');
  return LANE_DEFINITIONS.find((definition) => definition.lane === normalized)?.lane;
}

export function listRecursiveAutomationLanes(): readonly RecursiveAutomationLaneDefinition[] {
  return LANE_DEFINITIONS;
}

export function getRecursiveAutomationLaneDefinition(lane: RecursiveAutomationLane): RecursiveAutomationLaneDefinition {
  return LANE_DEFINITIONS.find((definition) => definition.lane === lane) ?? LANE_DEFINITIONS[0]!;
}

export function classifyRecursiveAutomationLane(input: LaneClassificationInput): LaneClassification {
  const text = joinedInput(input);
  const explicitLane = input.labels
    ?.map((label) => label.replace(/^lane:/u, ''))
    .map(normalizeLane)
    .find((lane): lane is RecursiveAutomationLane => lane !== undefined);
  const lane = explicitLane
    ?? LANE_DEFINITIONS.find((definition) => LANE_KEYWORDS[definition.lane].some((pattern) => pattern.test(text)))?.lane
    ?? 'feature_improvement';
  const definition = getRecursiveAutomationLaneDefinition(lane);
  const escalationReasons = POLICY_ESCALATION_PATTERNS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => `matches policy escalation pattern: ${pattern.source}`);

  return {
    lane,
    policyCategory: definition.policyCategory,
    requiresHumanReview: escalationReasons.length > 0,
    reasons: escalationReasons.length > 0
      ? escalationReasons
      : [`routed to ${lane} recursive automation lane`],
  };
}
