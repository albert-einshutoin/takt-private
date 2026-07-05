import { resolve } from 'node:path';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandRunner,
} from './commandRunner.js';
import {
  evaluateDualLlmApproval,
  type DualLlmApprovalReport,
} from './prReviewGate.js';
import {
  classifyProductPolicyImpact,
  type ProductPolicyClassification,
} from './productPolicyClassifier.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type DevloopMergeCommandRunner = DevloopCommandRunner;

export type MergeGateResult =
  | 'SAFE_TO_MERGE'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'REQUEST_CHANGES'
  | 'POLICY_DENY'
  | 'CHECKS_FAILED';

export interface MergeGatePolicy {
  requiredLabel: string;
  forbiddenPathPatterns: readonly string[];
  humanReviewPathPatterns: readonly string[];
  maxFilesChanged: number;
  maxLinesChanged: number;
  mergeMethod: 'squash' | 'merge' | 'rebase';
}

export interface MergeGatePrSnapshot {
  url: string;
  number: number;
  title?: string;
  body?: string;
  headRefOid: string;
  labels: readonly string[];
  reviewDecision?: string;
  mergeStateStatus?: string;
  isDraft: boolean;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export interface MergeGateEvaluationInput {
  pr: MergeGatePrSnapshot;
  changedPaths: readonly string[];
  checksPassed: boolean;
  expectedHeadSha?: string;
  dualLlmApproval?: DualLlmApprovalReport;
  policy?: Partial<MergeGatePolicy>;
}

export interface MergeGateReport {
  result: MergeGateResult;
  passed: boolean;
  pr?: MergeGatePrSnapshot;
  changedPaths: readonly string[];
  reasons: string[];
  mergeCommand?: readonly string[];
  detail?: string;
  dualLlmApproval?: DualLlmApprovalReport;
  productPolicyImpact?: ProductPolicyClassification;
}

export interface MergeIfSafeOptions {
  pr: string;
  repoPath?: string;
  repo?: string;
  expectedHeadSha?: string;
  policy?: Partial<MergeGatePolicy>;
  runner?: DevloopMergeCommandRunner;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_POLICY: MergeGatePolicy = {
  requiredLabel: 'agent:auto-merge',
  forbiddenPathPatterns: [
    '.github/**',
    'infra/**',
    'terraform/**',
    'migrations/**',
    'auth/**',
    'billing/**',
    'payments/**',
    '**/.env*',
    '**/*secret*',
    '**/*credential*',
  ],
  humanReviewPathPatterns: [
    'package.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'package-lock.json',
    'Dockerfile',
    'src/middleware*',
    'src/middleware/**',
    'src/routes*',
    'src/routes/**',
    'src/config*',
    'src/config/**',
  ],
  maxFilesChanged: 12,
  maxLinesChanged: 500,
  mergeMethod: 'squash',
};

interface GhPrViewResponse {
  url?: string;
  number?: number;
  title?: string;
  body?: string;
  headRefOid?: string;
  labels?: Array<{ name?: string }>;
  reviewDecision?: string;
  mergeStateStatus?: string;
  isDraft?: boolean;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
}

interface GhIssueComment {
  body?: string;
  created_at?: string;
}

function resolvePolicy(policy: Partial<MergeGatePolicy> | undefined): MergeGatePolicy {
  return {
    ...DEFAULT_POLICY,
    ...policy,
    forbiddenPathPatterns: policy?.forbiddenPathPatterns ?? DEFAULT_POLICY.forbiddenPathPatterns,
    humanReviewPathPatterns: policy?.humanReviewPathPatterns ?? DEFAULT_POLICY.humanReviewPathPatterns,
  };
}

function sanitizeDetail(text: string): string {
  return sanitizeSensitiveText(text).trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split('/');
  if (segments[0] === '**' && segments.length > 1) {
    // Security path policies commonly use **/ to mean "repo root or any subdirectory".
    const tail = segments.slice(1).map((segment) => escapeRegExp(segment).replaceAll('\\*', '[^/]*')).join('/');
    return new RegExp(`^(?:.*/)?${tail}$`);
  }
  const source = segments.map((segment) => {
    if (segment === '**') {
      return '(?:.*)';
    }
    return escapeRegExp(segment).replaceAll('\\*', '[^/]*');
  }).join('/');
  return new RegExp(`^${source}$`);
}

function pathMatches(path: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => globToRegExp(pattern).test(path));
}

function buildPolicyReasons(input: MergeGateEvaluationInput, policy: MergeGatePolicy): {
  policyDeny: string[];
  humanReview: string[];
  requestChanges: string[];
  checksFailed: string[];
  productPolicyImpact: ProductPolicyClassification;
} {
  const policyDeny: string[] = [];
  const humanReview: string[] = [];
  const dualLlmReviewRequired: string[] = [];
  const requestChanges: string[] = [];
  const checksFailed: string[] = [];
  const productPolicyImpact = classifyProductPolicyImpact({
    changedPaths: input.changedPaths,
    title: input.pr.title,
    body: input.pr.body,
  });
  const dualLlmApproved = input.dualLlmApproval?.approved === true
    && input.dualLlmApproval.headSha === input.pr.headRefOid;

  if (input.expectedHeadSha !== undefined && input.pr.headRefOid !== input.expectedHeadSha) {
    policyDeny.push(`head SHA mismatch: expected ${input.expectedHeadSha}, got ${input.pr.headRefOid}`);
  }

  if (!input.checksPassed) {
    checksFailed.push('GitHub checks did not pass');
  }

  if (input.pr.isDraft) {
    humanReview.push('PR is draft');
  }
  if (!input.pr.labels.includes(policy.requiredLabel)) {
    humanReview.push(`missing required label: ${policy.requiredLabel}`);
  }
  if (input.pr.reviewDecision === 'CHANGES_REQUESTED') {
    requestChanges.push(`review decision is ${input.pr.reviewDecision}`);
  } else if (input.pr.reviewDecision !== undefined && input.pr.reviewDecision !== 'APPROVED') {
    if (!dualLlmApproved) {
      humanReview.push(`review decision is ${input.pr.reviewDecision}`);
    }
  }
  if (input.pr.mergeStateStatus !== undefined && !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(input.pr.mergeStateStatus)) {
    humanReview.push(`merge state is ${input.pr.mergeStateStatus}`);
  }
  if (input.pr.changedFiles > policy.maxFilesChanged) {
    dualLlmReviewRequired.push(`changed file count exceeds policy: ${input.pr.changedFiles} > ${policy.maxFilesChanged}`);
  }
  if (input.pr.additions + input.pr.deletions > policy.maxLinesChanged) {
    dualLlmReviewRequired.push(`changed line count exceeds policy: ${input.pr.additions + input.pr.deletions} > ${policy.maxLinesChanged}`);
  }

  if (productPolicyImpact.requiresHumanReview) {
    humanReview.push(`product-policy impact: ${productPolicyImpact.reasons.join('; ')}`);
  }

  for (const path of input.changedPaths) {
    const forbiddenPattern = pathMatches(path, policy.forbiddenPathPatterns);
    if (forbiddenPattern !== undefined) {
      policyDeny.push(`forbidden path touched: ${path} (${forbiddenPattern})`);
      continue;
    }
    const humanReviewPattern = pathMatches(path, policy.humanReviewPathPatterns);
    if (humanReviewPattern !== undefined && !productPolicyImpact.requiresHumanReview) {
      dualLlmReviewRequired.push(`human review path touched: ${path} (${humanReviewPattern})`);
    }
  }

  if (!dualLlmApproved) {
    humanReview.push(...dualLlmReviewRequired);
  }

  return { policyDeny, humanReview, requestChanges, checksFailed, productPolicyImpact };
}

export function evaluateMergeGate(input: MergeGateEvaluationInput): MergeGateReport {
  const policy = resolvePolicy(input.policy);
  const reasons = buildPolicyReasons(input, policy);

  if (reasons.policyDeny.length > 0) {
    return {
      result: 'POLICY_DENY',
      passed: false,
      pr: input.pr,
      changedPaths: input.changedPaths,
      reasons: reasons.policyDeny,
      dualLlmApproval: input.dualLlmApproval,
      productPolicyImpact: reasons.productPolicyImpact,
    };
  }
  if (reasons.checksFailed.length > 0) {
    return {
      result: 'CHECKS_FAILED',
      passed: false,
      pr: input.pr,
      changedPaths: input.changedPaths,
      reasons: reasons.checksFailed,
      dualLlmApproval: input.dualLlmApproval,
      productPolicyImpact: reasons.productPolicyImpact,
    };
  }
  if (reasons.requestChanges.length > 0) {
    return {
      result: 'REQUEST_CHANGES',
      passed: false,
      pr: input.pr,
      changedPaths: input.changedPaths,
      reasons: reasons.requestChanges,
      dualLlmApproval: input.dualLlmApproval,
      productPolicyImpact: reasons.productPolicyImpact,
    };
  }
  if (reasons.humanReview.length > 0) {
    return {
      result: 'HUMAN_REVIEW_REQUIRED',
      passed: false,
      pr: input.pr,
      changedPaths: input.changedPaths,
      reasons: reasons.humanReview,
      dualLlmApproval: input.dualLlmApproval,
      productPolicyImpact: reasons.productPolicyImpact,
    };
  }

  return {
    result: 'SAFE_TO_MERGE',
    passed: true,
    pr: input.pr,
    changedPaths: input.changedPaths,
    reasons: [],
    dualLlmApproval: input.dualLlmApproval,
    productPolicyImpact: reasons.productPolicyImpact,
  };
}

function parsePrView(raw: string, prRef: string): MergeGatePrSnapshot {
  const parsed = JSON.parse(raw) as GhPrViewResponse;
  if (!parsed.headRefOid || parsed.number === undefined || !parsed.url) {
    throw new Error(`gh pr view returned incomplete data for ${prRef}`);
  }

  return {
    url: parsed.url,
    number: parsed.number,
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.body !== undefined ? { body: parsed.body } : {}),
    headRefOid: parsed.headRefOid,
    labels: parsed.labels?.flatMap((label) => label.name ? [label.name] : []) ?? [],
    reviewDecision: parsed.reviewDecision,
    mergeStateStatus: parsed.mergeStateStatus,
    isDraft: parsed.isDraft === true,
    changedFiles: parsed.changedFiles ?? 0,
    additions: parsed.additions ?? 0,
    deletions: parsed.deletions ?? 0,
  };
}

async function loadPrSnapshot(
  runner: DevloopMergeCommandRunner,
  ghCommand: string,
  prRef: string,
  repoPath: string,
  repo: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<MergeGatePrSnapshot> {
  const args = [
    'pr',
    'view',
    prRef,
    '--json',
    'url,number,title,body,headRefOid,labels,reviewDecision,mergeStateStatus,isDraft,changedFiles,additions,deletions',
  ];
  if (repo) {
    args.push('--repo', repo);
  }

  const result = await runner.exec(ghCommand, args, { cwd: repoPath, env });
  if (result.exitCode !== 0) {
    throw new Error(`gh pr view failed: ${sanitizeDetail(result.stderr || result.stdout)}`);
  }
  return parsePrView(result.stdout, prRef);
}

async function loadReviewComments(
  runner: DevloopMergeCommandRunner,
  ghCommand: string,
  prNumber: number,
  repoPath: string,
  repo: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<Array<{ body: string; createdAt?: string }>> {
  const resolvedRepo = repo ?? await resolveLocalRepoName(runner, ghCommand, repoPath, env);
  if (resolvedRepo === undefined) {
    return [];
  }
  const result = await runner.exec(
    ghCommand,
    ['api', `repos/${resolvedRepo}/issues/${prNumber}/comments`, '--paginate'],
    { cwd: repoPath, env },
  );
  if (result.exitCode !== 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout || '[]') as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      const comment = item as GhIssueComment;
      if (comment.body === undefined) {
        return [];
      }
      return [{
        body: comment.body,
        ...(comment.created_at !== undefined ? { createdAt: comment.created_at } : {}),
      }];
    });
  } catch {
    return [];
  }
}

async function resolveLocalRepoName(
  runner: DevloopMergeCommandRunner,
  ghCommand: string,
  repoPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const result = await runner.exec(
    ghCommand,
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd: repoPath, env },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  const repo = result.stdout.trim();
  return repo.length > 0 ? repo : undefined;
}

async function loadChangedPaths(
  runner: DevloopMergeCommandRunner,
  ghCommand: string,
  prRef: string,
  repoPath: string,
  repo: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const args = ['pr', 'diff', prRef, '--name-only'];
  if (repo) {
    args.push('--repo', repo);
  }
  const result = await runner.exec(ghCommand, args, { cwd: repoPath, env });
  if (result.exitCode !== 0) {
    throw new Error(`gh pr diff failed: ${sanitizeDetail(result.stderr || result.stdout)}`);
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function checkGithubChecks(
  runner: DevloopMergeCommandRunner,
  ghCommand: string,
  prRef: string,
  repoPath: string,
  repo: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const args = ['pr', 'checks', prRef];
  if (repo) {
    args.push('--repo', repo);
  }
  const result = await runner.exec(ghCommand, args, { cwd: repoPath, env });
  return result.exitCode === 0;
}

function buildMergeArgs(prRef: string, headSha: string, policy: MergeGatePolicy, repo: string | undefined): string[] {
  const methodFlag = policy.mergeMethod === 'merge' ? '--merge' : policy.mergeMethod === 'rebase' ? '--rebase' : '--squash';
  const args = [
    'pr',
    'merge',
    prRef,
    '--auto',
    methodFlag,
    '--delete-branch',
    '--match-head-commit',
    headSha,
  ];
  if (repo) {
    args.push('--repo', repo);
  }
  return args;
}

export async function mergeIfSafe(options: MergeIfSafeOptions): Promise<MergeGateReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const ghCommand = runner.resolveCommand('gh', env);
  if (ghCommand === undefined) {
    return {
      result: 'POLICY_DENY',
      passed: false,
      changedPaths: [],
      reasons: ['command not found: gh'],
    };
  }

  try {
    const policy = resolvePolicy(options.policy);
    const pr = await loadPrSnapshot(runner, ghCommand, options.pr, repoPath, options.repo, env);
    const changedPaths = await loadChangedPaths(runner, ghCommand, options.pr, repoPath, options.repo, env);
    const checksPassed = await checkGithubChecks(runner, ghCommand, options.pr, repoPath, options.repo, env);
    const comments = await loadReviewComments(runner, ghCommand, pr.number, repoPath, options.repo, env);
    const dualLlmApproval = evaluateDualLlmApproval({ headSha: pr.headRefOid, comments });
    const report = evaluateMergeGate({
      pr,
      changedPaths,
      checksPassed,
      expectedHeadSha: options.expectedHeadSha,
      dualLlmApproval,
      policy,
    });

    if (!report.passed) {
      return report;
    }

    const mergeArgs = buildMergeArgs(options.pr, pr.headRefOid, policy, options.repo);
    const result = await runner.exec(ghCommand, mergeArgs, { cwd: repoPath, env });
    if (result.exitCode !== 0) {
      return {
        ...report,
        result: 'CHECKS_FAILED',
        passed: false,
        reasons: ['gh pr merge failed'],
        detail: sanitizeDetail(result.stderr || result.stdout),
      };
    }

    return {
      ...report,
      mergeCommand: [ghCommand, ...mergeArgs],
    };
  } catch (error) {
    return {
      result: 'POLICY_DENY',
      passed: false,
      changedPaths: [],
      reasons: [error instanceof Error ? sanitizeDetail(error.message) : sanitizeDetail(String(error))],
    };
  }
}

export function formatMergeGateReport(report: MergeGateReport): string {
  const lines = [
    `devloopd merge-if-safe: ${report.result}`,
    ...report.reasons.map((reason) => `- ${reason}`),
  ];
  if (report.pr) {
    lines.push(`PR: ${report.pr.url}`);
    lines.push(`Head: ${report.pr.headRefOid}`);
  }
  if (report.mergeCommand) {
    lines.push(`Merge command: ${report.mergeCommand.join(' ')}`);
  }
  if (report.productPolicyImpact) {
    lines.push(`Product policy impact: ${report.productPolicyImpact.impact}`);
  }
  if (report.dualLlmApproval) {
    lines.push(`Dual LLM approval: ${report.dualLlmApproval.approved ? 'approved' : 'not approved'}`);
  }
  if (report.detail) {
    lines.push(`Detail: ${report.detail}`);
  }
  return lines.join('\n');
}
