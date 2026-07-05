import { resolve } from 'node:path';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandRunner,
} from './commandRunner.js';
import { buildAutomationStateEvent, type AutomationStateStatus } from './automationState.js';
import { runCiAutoRepairForPullRequest } from './ciRepair.js';
import { runIssueScout } from './issueScout.js';
import {
  appendDevloopLedgerEvent,
  resolveDevloopLedgerPath,
} from './ledger.js';
import {
  evaluateDualLlmApproval,
  formatReviewGateComment,
  parseReviewGateComment,
  type DualLlmApprovalReport,
  type ParsedReviewGateComment,
  type ReviewGateDecision,
} from './prReviewGate.js';
import { classifyProductPolicyImpact, type ProductPolicyClassification } from './productPolicyClassifier.js';
import { mergeIfSafe } from './mergeGate.js';
import { planMergeQueue, type MergeQueueDecision, type MergeQueuePullRequest } from './mergeQueue.js';
import { runReviewFixForPullRequest } from './reviewFix.js';
import { startDevloop, type DevloopStartReport, type StartDevloopOptions } from './supervisor.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type DevloopAutomationStage = 'issue-scout' | 'issue-to-pr' | 'pr-review' | 'review-fix' | 'pr-merge';

export interface AutomationPrSnapshot {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  authorLogin: string;
  labels: string[];
}

export interface DuplicateIssueCoverage {
  issue: number;
  prNumbers: number[];
  stopRule: 'Duplicate or already covered';
}

export interface DevloopAutomationAction {
  type: string;
  status: 'passed' | 'skipped' | 'blocked' | 'failed';
  message: string;
  pr?: number;
  stopRule?:
    | 'active run limit'
    | 'Duplicate or already covered'
    | 'Mergeable: NO'
    | 'Unsafe or too broad'
    | 'checks failed'
    | 'attempt budget exhausted'
    | 'head mismatch'
    | 'overlap serialization'
    | 'conflict eviction';
  dualLlmApproval?: DualLlmApprovalReport;
  productPolicyImpact?: ProductPolicyClassification;
}

export interface DevloopAutomationStageReport {
  passed: boolean;
  stage: DevloopAutomationStage;
  message: string;
  actions: DevloopAutomationAction[];
  startReport?: DevloopStartReport;
  duplicateIssueCoverage?: DuplicateIssueCoverage[];
}

export interface RunDevloopAutomationStageOptions {
  stage: DevloopAutomationStage;
  repoPath?: string;
  repo?: string;
  workflow?: string;
  policyPath?: string;
  ledgerPath?: string;
  skipAuth?: boolean;
  autoPr?: boolean;
  quiet?: boolean;
  dryRun?: boolean;
  autoMergeLabel?: string;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
  startDevloopOptions?: Partial<StartDevloopOptions>;
}

interface GhPrListItem {
  number?: number;
  title?: string;
  body?: string;
  headRefName?: string;
  headRefOid?: string;
  isDraft?: boolean;
  author?: { login?: string };
  labels?: Array<{ name?: string }>;
}

interface GhIssueComment {
  body?: string;
  created_at?: string;
}

interface GhPrViewForGate {
  number?: number;
  title?: string;
  body?: string;
  headRefOid?: string;
  mergeStateStatus?: string;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
}

const AUTOMATION_BRANCH_PATTERN = /^(takt|automation)\//u;
const DEFAULT_AUTO_MERGE_LABEL = 'agent:auto-merge';
const BLOCKED_LABEL = 'agent:blocked';

function sanitizeDetail(text: string): string {
  return sanitizeSensitiveText(text).trim();
}

function parseJsonArray(raw: string, context: string): unknown[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${context} did not return a JSON array`);
  }
  return parsed;
}

function normalizeLabelNames(labels: GhPrListItem['labels']): string[] {
  return labels?.flatMap((label) => label.name ? [label.name] : []) ?? [];
}

export function parseAutomationPullRequests(raw: string): AutomationPrSnapshot[] {
  return parseJsonArray(raw, 'gh pr list').flatMap((item) => {
    const pr = item as GhPrListItem;
    if (pr.number === undefined || pr.headRefName === undefined || pr.headRefOid === undefined) {
      return [];
    }

    return [{
      number: pr.number,
      title: pr.title ?? '',
      body: pr.body ?? '',
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      isDraft: pr.isDraft === true,
      authorLogin: pr.author?.login ?? '',
      labels: normalizeLabelNames(pr.labels),
    }];
  });
}

export function selectAutomationPullRequests(
  prs: readonly AutomationPrSnapshot[],
  options: { branchPattern?: RegExp; blockedLabel?: string } = {},
): AutomationPrSnapshot[] {
  const branchPattern = options.branchPattern ?? AUTOMATION_BRANCH_PATTERN;
  const blockedLabel = options.blockedLabel ?? BLOCKED_LABEL;
  return prs.filter((pr) => {
    return !pr.isDraft
      && pr.authorLogin !== 'dependabot[bot]'
      && branchPattern.test(pr.headRefName)
      && !pr.labels.includes(blockedLabel);
  });
}

function extractIssueNumbers(text: string): number[] {
  const issues = new Set<number>();
  for (const match of text.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|issue)\s+#(\d+)/giu)) {
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0) {
      issues.add(value);
    }
  }
  return [...issues].sort((left, right) => left - right);
}

export function findDuplicateIssueCoverage(prs: readonly AutomationPrSnapshot[]): DuplicateIssueCoverage[] {
  const byIssue = new Map<number, number[]>();
  for (const pr of prs) {
    for (const issue of extractIssueNumbers(`${pr.title}\n${pr.body}`)) {
      const existing = byIssue.get(issue) ?? [];
      existing.push(pr.number);
      byIssue.set(issue, existing);
    }
  }

  return [...byIssue.entries()]
    .filter(([, prNumbers]) => prNumbers.length > 1)
    .map(([issue, prNumbers]) => ({
      issue,
      prNumbers,
      stopRule: 'Duplicate or already covered' as const,
    }));
}

async function listAutomationPullRequests(options: {
  repoPath: string;
  repo?: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<AutomationPrSnapshot[]> {
  const ghCommand = options.runner.resolveCommand('gh', options.env);
  if (ghCommand === undefined) {
    throw new Error('command not found: gh');
  }

  const args = [
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,title,body,headRefName,headRefOid,isDraft,author,labels',
  ];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  const result = await options.runner.exec(ghCommand, args, { cwd: options.repoPath, env: options.env });
  if (result.exitCode !== 0) {
    throw new Error(`gh pr list failed: ${sanitizeDetail(result.stderr || result.stdout)}`);
  }

  return selectAutomationPullRequests(parseAutomationPullRequests(result.stdout));
}

async function loadPrView(options: {
  pr: number;
  repoPath: string;
  repo?: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<GhPrViewForGate> {
  const ghCommand = options.runner.resolveCommand('gh', options.env);
  if (ghCommand === undefined) {
    throw new Error('command not found: gh');
  }

  const args = [
    'pr',
    'view',
    String(options.pr),
    '--json',
    'number,title,body,headRefOid,mergeStateStatus,changedFiles,additions,deletions',
  ];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  const result = await options.runner.exec(ghCommand, args, { cwd: options.repoPath, env: options.env });
  if (result.exitCode !== 0) {
    throw new Error(`gh pr view failed: ${sanitizeDetail(result.stderr || result.stdout)}`);
  }
  return JSON.parse(result.stdout) as GhPrViewForGate;
}

async function loadChangedPaths(options: {
  pr: number;
  repoPath: string;
  repo?: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<string[]> {
  const ghCommand = options.runner.resolveCommand('gh', options.env);
  if (ghCommand === undefined) {
    throw new Error('command not found: gh');
  }

  const args = ['pr', 'diff', String(options.pr), '--name-only'];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  const result = await options.runner.exec(ghCommand, args, { cwd: options.repoPath, env: options.env });
  if (result.exitCode !== 0) {
    throw new Error(`gh pr diff failed: ${sanitizeDetail(result.stderr || result.stdout)}`);
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function loadReviewComments(options: {
  pr: number;
  repoPath: string;
  repo?: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<Array<{ body: string; createdAt?: string }>> {
  const ghCommand = options.runner.resolveCommand('gh', options.env);
  if (ghCommand === undefined) {
    throw new Error('command not found: gh');
  }
  const repo = options.repo ?? await resolveLocalRepoName({
    repoPath: options.repoPath,
    env: options.env,
    runner: options.runner,
    ghCommand,
  });
  if (repo === undefined) {
    return [];
  }

  const result = await options.runner.exec(
    ghCommand,
    ['api', `repos/${repo}/issues/${options.pr}/comments`, '--paginate'],
    { cwd: options.repoPath, env: options.env },
  );
  if (result.exitCode !== 0) {
    return [];
  }

  return parseJsonArray(result.stdout || '[]', 'gh api comments').flatMap((item) => {
    const comment = item as GhIssueComment;
    if (comment.body === undefined) {
      return [];
    }
    return [{
      body: comment.body,
      ...(comment.created_at !== undefined ? { createdAt: comment.created_at } : {}),
    }];
  });
}

async function resolveLocalRepoName(options: {
  repoPath: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
  ghCommand: string;
}): Promise<string | undefined> {
  const result = await options.runner.exec(
    options.ghCommand,
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd: options.repoPath, env: options.env },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  const repo = result.stdout.trim();
  return repo.length > 0 ? repo : undefined;
}

export function findCurrentHeadBlockingReview(options: {
  headSha: string;
  comments: readonly { body: string; createdAt?: string }[];
}): ParsedReviewGateComment | undefined {
  return options.comments
    .flatMap((comment) => {
      const parsed = parseReviewGateComment(comment.body, comment.createdAt);
      return parsed === undefined ? [] : [parsed];
    })
    .filter((comment) => comment.headSha === options.headSha && comment.decision === 'blocked')
    .at(-1);
}

async function checkGithubChecks(options: {
  pr: number;
  repoPath: string;
  repo?: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<boolean> {
  const ghCommand = options.runner.resolveCommand('gh', options.env);
  if (ghCommand === undefined) {
    throw new Error('command not found: gh');
  }

  const args = ['pr', 'checks', String(options.pr)];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  const result = await options.runner.exec(ghCommand, args, { cwd: options.repoPath, env: options.env });
  return result.exitCode === 0;
}

async function addAutoMergeLabel(options: {
  pr: number;
  repoPath: string;
  repo?: string;
  label: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<void> {
  const ghCommand = options.runner.resolveCommand('gh', options.env);
  if (ghCommand === undefined) {
    throw new Error('command not found: gh');
  }

  const args = ['pr', 'edit', String(options.pr), '--add-label', options.label];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  const result = await options.runner.exec(ghCommand, args, { cwd: options.repoPath, env: options.env });
  if (result.exitCode !== 0) {
    throw new Error(`gh pr edit failed: ${sanitizeDetail(result.stderr || result.stdout)}`);
  }
}

async function postReviewComment(options: {
  pr: number;
  repoPath: string;
  repo?: string;
  body: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<void> {
  const ghCommand = options.runner.resolveCommand('gh', options.env);
  if (ghCommand === undefined) {
    throw new Error('command not found: gh');
  }
  const args = ['pr', 'comment', String(options.pr), '--body', options.body];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  const result = await options.runner.exec(ghCommand, args, { cwd: options.repoPath, env: options.env });
  if (result.exitCode !== 0) {
    throw new Error(`gh pr comment failed: ${sanitizeDetail(result.stderr || result.stdout)}`);
  }
}

function normalizeAgyDecision(output: string): ReviewGateDecision {
  return /^Mergeable:\s*YES\s*$/imu.test(output) ? 'approved' : 'blocked';
}

function normalizeCodexDecision(output: string): ReviewGateDecision {
  return /^Codex-Human-Review:\s*APPROVED\s*$/imu.test(output) ? 'approved' : 'blocked';
}

async function runAgyReview(options: {
  pr: number;
  headSha: string;
  repoPath: string;
  repo?: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<DevloopAutomationAction> {
  const agyCommand = options.runner.resolveCommand('agy', options.env);
  if (agyCommand === undefined) {
    return {
      type: 'agy-review',
      status: 'skipped',
      pr: options.pr,
      message: 'command not found: agy',
    };
  }
  const prompt = [
    options.prompt,
    '',
    'Return exactly this contract:',
    '',
    'Mergeable: YES|NO',
    'Reason: one concise sentence',
    'Blockers:',
    '- none, or concrete blockers with file paths/commands',
    'Verification:',
    '- evidence used',
  ].join('\n');
  const result = await options.runner.exec(
    agyCommand,
    ['--model', options.env.TAKT_LOOP_AGY_MODEL ?? 'gpt-5', '--print-timeout', options.env.TAKT_LOOP_AGY_PRINT_TIMEOUT ?? '900', '-p', prompt],
    { cwd: options.repoPath, env: options.env },
  );
  const rawReview = result.exitCode === 0
    ? result.stdout
    : `Mergeable: NO\nReason: agy review command failed.\nBlockers:\n- ${sanitizeDetail(result.stderr || result.stdout)}\nVerification:\n- agy exited with code ${result.exitCode}`;
  const decision = normalizeAgyDecision(rawReview);
  await postReviewComment({
    pr: options.pr,
    repoPath: options.repoPath,
    repo: options.repo,
    body: formatReviewGateComment({
      reviewer: 'agy',
      decision,
      headSha: options.headSha,
      body: rawReview,
    }),
    env: options.env,
    runner: options.runner,
  });

  return {
    type: 'agy-review',
    status: decision === 'approved' ? 'passed' : 'blocked',
    pr: options.pr,
    message: `agy review ${decision}`,
    ...(decision === 'blocked' ? { stopRule: 'Mergeable: NO' as const } : {}),
  };
}

async function runCodexReview(options: {
  pr: number;
  headSha: string;
  repoPath: string;
  repo?: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<DevloopAutomationAction> {
  const codexCommand = options.runner.resolveCommand('codex', options.env);
  if (codexCommand === undefined) {
    return {
      type: 'codex-review',
      status: 'skipped',
      pr: options.pr,
      message: 'command not found: codex',
    };
  }
  const prompt = [
    options.prompt,
    '',
    'Return exactly this contract:',
    '',
    'Codex-Human-Review: APPROVED|BLOCKED',
    'Reason: one concise sentence',
    'Blockers:',
    '- none, or concrete blockers with file paths/commands',
    'Verification:',
    '- evidence used',
  ].join('\n');
  const result = await options.runner.exec(
    codexCommand,
    [
      'exec',
      '--sandbox',
      'read-only',
      '--cd',
      options.repoPath,
      '--model',
      options.env.TAKT_LOOP_CODEX_REVIEW_MODEL ?? 'gpt-5',
      '-c',
      `model_reasoning_effort=${options.env.TAKT_LOOP_CODEX_REVIEW_REASONING_EFFORT ?? 'high'}`,
      '-c',
      'approval_policy="never"',
      '-',
    ],
    { cwd: options.repoPath, env: options.env, stdin: prompt },
  );
  const rawReview = result.exitCode === 0
    ? result.stdout
    : `Codex-Human-Review: BLOCKED\nReason: codex review command failed.\nBlockers:\n- ${sanitizeDetail(result.stderr || result.stdout)}\nVerification:\n- codex exited with code ${result.exitCode}`;
  const decision = normalizeCodexDecision(rawReview);
  await postReviewComment({
    pr: options.pr,
    repoPath: options.repoPath,
    repo: options.repo,
    body: formatReviewGateComment({
      reviewer: 'codex',
      decision,
      headSha: options.headSha,
      body: rawReview,
    }),
    env: options.env,
    runner: options.runner,
  });

  return {
    type: 'codex-review',
    status: decision === 'approved' ? 'passed' : 'blocked',
    pr: options.pr,
    message: `codex review ${decision}`,
    ...(decision === 'blocked' ? { stopRule: 'Mergeable: NO' as const } : {}),
  };
}

function buildReviewPrompt(options: {
  pr: number;
  headSha: string;
  metadata: GhPrViewForGate;
  changedPaths: readonly string[];
  productPolicyImpact: ProductPolicyClassification;
  checksPassed: boolean;
}): string {
  return [
    'You are reviewing an automation PR for guarded merge.',
    '',
    'Return the exact contract requested by your reviewer role. Approve only when the current head is safe, scoped, and mechanically verified.',
    '',
    `PR: #${options.pr}`,
    `Head SHA: ${options.headSha}`,
    `Checks passed: ${String(options.checksPassed)}`,
    `Product-policy impact: ${options.productPolicyImpact.impact}`,
    `Product-policy reasons: ${options.productPolicyImpact.reasons.join('; ')}`,
    '',
    'Metadata:',
    JSON.stringify(options.metadata, null, 2),
    '',
    'Changed files:',
    options.changedPaths.join('\n') || 'none',
  ].join('\n');
}

export async function promotePullRequestAutoMerge(options: {
  pr: number;
  repoPath?: string;
  repo?: string;
  label?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
}): Promise<DevloopAutomationAction> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const metadata = await loadPrView({ pr: options.pr, repoPath, repo: options.repo, env, runner });
  const headSha = metadata.headRefOid;
  if (headSha === undefined) {
    return {
      type: 'promote-auto-merge',
      status: 'failed',
      pr: options.pr,
      message: 'PR metadata did not include headRefOid',
    };
  }

  const changedPaths = await loadChangedPaths({ pr: options.pr, repoPath, repo: options.repo, env, runner });
  const productPolicyImpact = classifyProductPolicyImpact({
    changedPaths,
    title: metadata.title,
    body: metadata.body,
  });
  if (productPolicyImpact.requiresHumanReview) {
    return {
      type: 'promote-auto-merge',
      status: 'blocked',
      pr: options.pr,
      message: 'product-policy impact requires human review',
      productPolicyImpact,
    };
  }

  const checksPassed = await checkGithubChecks({ pr: options.pr, repoPath, repo: options.repo, env, runner });
  if (!checksPassed) {
    return {
      type: 'promote-auto-merge',
      status: 'skipped',
      pr: options.pr,
      message: 'GitHub checks are not passing yet',
      productPolicyImpact,
    };
  }

  const comments = await loadReviewComments({ pr: options.pr, repoPath, repo: options.repo, env, runner });
  let dualLlmApproval = evaluateDualLlmApproval({ headSha, comments });
  const actions: DevloopAutomationAction[] = [];
  if (!dualLlmApproval.approved) {
    const prompt = buildReviewPrompt({
      pr: options.pr,
      headSha,
      metadata,
      changedPaths,
      productPolicyImpact,
      checksPassed,
    });
    const agyReview = await runAgyReview({ pr: options.pr, headSha, repoPath, repo: options.repo, prompt, env, runner });
    actions.push(agyReview);
    const codexReview = await runCodexReview({ pr: options.pr, headSha, repoPath, repo: options.repo, prompt, env, runner });
    actions.push(codexReview);
    const refreshedComments = await loadReviewComments({ pr: options.pr, repoPath, repo: options.repo, env, runner });
    dualLlmApproval = evaluateDualLlmApproval({ headSha, comments: refreshedComments });
  }

  if (!dualLlmApproval.approved) {
    return {
      type: 'promote-auto-merge',
      status: 'blocked',
      pr: options.pr,
      message: `dual-LLM approval missing: ${dualLlmApproval.reasons.join('; ')}`,
      dualLlmApproval,
      productPolicyImpact,
      ...(actions.some((action) => action.stopRule === 'Mergeable: NO') ? { stopRule: 'Mergeable: NO' as const } : {}),
    };
  }

  if (options.dryRun === true) {
    return {
      type: 'promote-auto-merge',
      status: 'passed',
      pr: options.pr,
      message: `dry-run: would add ${options.label ?? DEFAULT_AUTO_MERGE_LABEL}`,
      dualLlmApproval,
      productPolicyImpact,
    };
  }

  await addAutoMergeLabel({
    pr: options.pr,
    repoPath,
    repo: options.repo,
    label: options.label ?? DEFAULT_AUTO_MERGE_LABEL,
    env,
    runner,
  });

  return {
    type: 'promote-auto-merge',
    status: 'passed',
    pr: options.pr,
    message: `added ${options.label ?? DEFAULT_AUTO_MERGE_LABEL}`,
    dualLlmApproval,
    productPolicyImpact,
  };
}

function makeStageReport(stage: DevloopAutomationStage, actions: DevloopAutomationAction[], extra: Partial<DevloopAutomationStageReport> = {}): DevloopAutomationStageReport {
  const failed = actions.some((action) => action.status === 'failed');
  return {
    passed: !failed,
    stage,
    message: actions.length === 0 ? `${stage}: no actions` : `${stage}: ${actions.length} action(s)`,
    actions,
    ...extra,
  };
}

function queueDecisionStatus(decision: MergeQueueDecision): AutomationStateStatus {
  if (decision.status === 'ready') return 'passed';
  if (decision.status === 'serialized') return 'skipped';
  return 'blocked';
}

function queueDecisionAction(decision: MergeQueueDecision): DevloopAutomationAction | undefined {
  if (decision.status === 'ready') {
    return undefined;
  }
  return {
    type: 'merge-queue',
    status: decision.status === 'serialized' ? 'skipped' : 'blocked',
    pr: decision.prNumber,
    message: decision.reasons.join('; ') || decision.status,
    ...(decision.stopRule !== undefined ? { stopRule: decision.stopRule } : {}),
  };
}

function appendMergeQueueStateEvents(options: {
  repoPath: string;
  ledgerPath?: string;
  decisions: readonly MergeQueueDecision[];
}): void {
  const ledgerPath = resolveDevloopLedgerPath(options.repoPath, options.ledgerPath);
  for (const decision of options.decisions) {
    appendDevloopLedgerEvent(ledgerPath, buildAutomationStateEvent({
      stage: 'merge_queue',
      status: queueDecisionStatus(decision),
      summary: decision.reasons.join('; ') || `PR #${decision.prNumber} ${decision.status}`,
      prNumber: decision.prNumber,
      ...(decision.stopRule !== undefined ? { stopRule: decision.stopRule } : {}),
      nextActions: decision.status === 'ready'
        ? [`merge PR #${decision.prNumber}`]
        : decision.status === 'serialized'
          ? [`wait for overlapping PR(s) before PR #${decision.prNumber}`]
          : [`inspect PR #${decision.prNumber} before merge`],
    }));
  }
}

async function buildMergeQueuePullRequest(options: {
  pr: AutomationPrSnapshot;
  repoPath: string;
  repo?: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<MergeQueuePullRequest> {
  const metadata = await loadPrView({
    pr: options.pr.number,
    repoPath: options.repoPath,
    repo: options.repo,
    env: options.env,
    runner: options.runner,
  });
  const changedPaths = await loadChangedPaths({
    pr: options.pr.number,
    repoPath: options.repoPath,
    repo: options.repo,
    env: options.env,
    runner: options.runner,
  });
  const comments = await loadReviewComments({
    pr: options.pr.number,
    repoPath: options.repoPath,
    repo: options.repo,
    env: options.env,
    runner: options.runner,
  });
  const checksPassed = await checkGithubChecks({
    pr: options.pr.number,
    repoPath: options.repoPath,
    repo: options.repo,
    env: options.env,
    runner: options.runner,
  });
  const dualLlmApproval = evaluateDualLlmApproval({ headSha: options.pr.headRefOid, comments });
  const productPolicyImpact = classifyProductPolicyImpact({
    changedPaths,
    title: metadata.title ?? options.pr.title,
    body: metadata.body ?? options.pr.body,
  });

  return {
    number: options.pr.number,
    title: metadata.title ?? options.pr.title,
    headRefOid: metadata.headRefOid ?? options.pr.headRefOid,
    expectedHeadSha: options.pr.headRefOid,
    changedPaths,
    checksPassed,
    dualLlmApproved: dualLlmApproval.approved && dualLlmApproval.headSha === options.pr.headRefOid,
    productPolicyRequiresHumanReview: productPolicyImpact.requiresHumanReview,
    mergeStateStatus: metadata.mergeStateStatus,
    isDraft: options.pr.isDraft,
  };
}

export async function runDevloopAutomationStage(options: RunDevloopAutomationStageOptions): Promise<DevloopAutomationStageReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();

  if (options.stage === 'issue-scout') {
    const scout = await runIssueScout({
      repoPath,
      repo: options.repo,
      ledgerPath: options.ledgerPath,
      dryRun: options.dryRun,
      env,
      runner,
    });
    return makeStageReport(options.stage, [{
      type: 'issue-scout',
      status: scout.passed ? 'passed' : 'failed',
      message: scout.message,
      ...(scout.selected.length === 0 ? { stopRule: 'Duplicate or already covered' as const } : {}),
    }], { passed: scout.passed });
  }

  if (options.stage === 'issue-to-pr') {
    const startReport = await startDevloop({
      repoPath,
      repo: options.repo,
      workflow: options.workflow,
      policyPath: options.policyPath,
      ledgerPath: options.ledgerPath,
      skipAuth: options.skipAuth,
      autoPr: options.autoPr,
      quiet: options.quiet,
      once: true,
      env,
      runner,
      ...options.startDevloopOptions,
    });
    const action: DevloopAutomationAction = {
      type: 'issue-to-pr',
      status: startReport.passed ? 'passed' : 'skipped',
      message: startReport.message,
      ...(startReport.message.includes('active run limit') ? { stopRule: 'active run limit' as const } : {}),
    };
    return makeStageReport(options.stage, [action], { passed: startReport.passed, startReport });
  }

  const prs = await listAutomationPullRequests({ repoPath, repo: options.repo, env, runner });
  const duplicateIssueCoverage = findDuplicateIssueCoverage(prs);
  const duplicatePrNumbers = new Set(duplicateIssueCoverage.flatMap((duplicate) => duplicate.prNumbers));
  const duplicateActions: DevloopAutomationAction[] = duplicateIssueCoverage.flatMap((duplicate) => duplicate.prNumbers.map((pr) => ({
    type: 'duplicate-issue-coverage',
    status: 'skipped' as const,
    pr,
    stopRule: duplicate.stopRule,
    message: `issue #${duplicate.issue} already has automation PR coverage`,
  })));
  const nonDuplicatePrs = prs.filter((pr) => !duplicatePrNumbers.has(pr.number));

  if (options.stage === 'pr-review') {
    const actions = [
      ...duplicateActions,
      ...await Promise.all(nonDuplicatePrs.map((pr) => promotePullRequestAutoMerge({
        pr: pr.number,
        repoPath,
        repo: options.repo,
        label: options.autoMergeLabel,
        dryRun: options.dryRun,
        env,
        runner,
      }))),
    ];
    return makeStageReport(options.stage, actions, { duplicateIssueCoverage });
  }

  if (options.stage === 'review-fix') {
    const reviewFixActions = await Promise.all(nonDuplicatePrs.map(async (pr): Promise<DevloopAutomationAction> => {
      const report = await runReviewFixForPullRequest({
        pr: pr.number,
        repoPath,
        repo: options.repo,
        ledgerPath: options.ledgerPath,
        dryRun: options.dryRun,
        env,
        runner,
      });
      return {
        type: 'review-fix',
        status: report.status,
        pr: pr.number,
        message: report.message,
        ...(report.stopRule !== undefined ? { stopRule: report.stopRule } : {}),
        ...(report.productPolicyImpact !== undefined ? { productPolicyImpact: report.productPolicyImpact } : {}),
      };
    }));
    return makeStageReport(options.stage, [
      ...duplicateActions,
      ...reviewFixActions,
    ], { duplicateIssueCoverage });
  }

  const promotionResults = await Promise.all(nonDuplicatePrs.map(async (pr) => ({
    pr,
    promotion: await promotePullRequestAutoMerge({
      pr: pr.number,
      repoPath,
      repo: options.repo,
      label: options.autoMergeLabel,
      dryRun: options.dryRun,
      env,
      runner,
    }),
  })));
  const preQueueActions = await Promise.all(promotionResults.flatMap((result) => {
    if (result.promotion.status === 'passed') {
      return [];
    }
    if (result.promotion.status === 'skipped' && /checks/i.test(result.promotion.message)) {
      return [runCiAutoRepairForPullRequest({
        pr: result.pr.number,
        repoPath,
        repo: options.repo,
        ledgerPath: options.ledgerPath,
        dryRun: options.dryRun,
        env,
        runner,
      }).then((repair): DevloopAutomationAction => ({
        type: 'ci-fix',
        status: repair.status,
        pr: result.pr.number,
        message: repair.message,
        ...(repair.stopRule !== undefined ? { stopRule: repair.stopRule } : {}),
        ...(repair.productPolicyImpact !== undefined ? { productPolicyImpact: repair.productPolicyImpact } : {}),
      }))];
    }
    return [Promise.resolve(result.promotion)];
  }));
  const queueCandidates = promotionResults.filter((result) => result.promotion.status === 'passed');
  const queueItems = await Promise.all(queueCandidates.map((result) => buildMergeQueuePullRequest({
    pr: result.pr,
    repoPath,
    repo: options.repo,
    env,
    runner,
  })));
  const queuePlan = planMergeQueue(queueItems);
  appendMergeQueueStateEvents({
    repoPath,
    ledgerPath: options.ledgerPath,
    decisions: queuePlan.decisions,
  });
  const readyPrNumbers = new Set(queuePlan.decisions
    .filter((decision) => decision.status === 'ready')
    .map((decision) => decision.prNumber));
  const queueActions = queuePlan.decisions.flatMap((decision) => {
    const action = queueDecisionAction(decision);
    return action === undefined ? [] : [action];
  });
  const mergeActions = await Promise.all(queueCandidates
    .filter((result) => readyPrNumbers.has(result.pr.number))
    .map(async (result): Promise<DevloopAutomationAction> => {
      if (options.dryRun === true) {
        return {
          type: 'merge-if-safe',
          status: 'passed',
          pr: result.pr.number,
          message: 'dry-run: would call merge-if-safe',
          dualLlmApproval: result.promotion.dualLlmApproval,
          productPolicyImpact: result.promotion.productPolicyImpact,
        };
      }
      const mergeReport = await mergeIfSafe({
        pr: String(result.pr.number),
        repoPath,
        repo: options.repo,
        expectedHeadSha: result.pr.headRefOid,
        env,
        runner,
      });
      return {
        type: 'merge-if-safe',
        status: mergeReport.passed ? 'passed' : 'blocked',
        pr: result.pr.number,
        message: mergeReport.result,
        dualLlmApproval: result.promotion.dualLlmApproval,
        productPolicyImpact: result.promotion.productPolicyImpact,
      };
    }));
  const actions = [
    ...duplicateActions,
    ...preQueueActions,
    ...queueActions,
    ...mergeActions,
  ];
  return makeStageReport(options.stage, actions, { duplicateIssueCoverage });
}

export function formatDevloopAutomationStageReport(report: DevloopAutomationStageReport): string {
  const lines = [
    report.passed ? `devloopd ${report.stage} passed` : `devloopd ${report.stage} failed`,
    report.message,
  ];
  for (const duplicate of report.duplicateIssueCoverage ?? []) {
    lines.push(`Duplicate issue #${duplicate.issue}: PRs ${duplicate.prNumbers.map((pr) => `#${pr}`).join(', ')}`);
  }
  for (const action of report.actions) {
    lines.push(`- ${action.type}${action.pr !== undefined ? ` #${action.pr}` : ''}: ${action.status} - ${action.message}`);
    if (action.stopRule !== undefined) {
      lines.push(`  stop rule: ${action.stopRule}`);
    }
  }
  return lines.join('\n');
}
