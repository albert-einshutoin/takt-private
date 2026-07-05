import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendDevloopLedgerEvent,
  buildDevloopLedgerEvent,
  readRawDevloopLedgerEvents,
  resolveDevloopLedgerPath,
} from './ledger.js';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandRunner,
} from './commandRunner.js';
import { classifyProductPolicyImpact, type ProductPolicyClassification } from './productPolicyClassifier.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type PullRequestRepairKind = 'review-fix' | 'ci-fix';
export type PullRequestRepairStatus = 'passed' | 'skipped' | 'blocked' | 'failed';

export interface RepairRepositoryRef {
  name?: string;
  nameWithOwner?: string;
  owner?: { login?: string };
}

export interface RepairPullRequestSnapshot {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  headRefOid: string;
  baseRepository?: RepairRepositoryRef;
  headRepository?: RepairRepositoryRef;
  labels?: readonly string[];
}

export interface PullRequestRepairOptions {
  kind: PullRequestRepairKind;
  pr: RepairPullRequestSnapshot;
  repoPath?: string;
  repo?: string;
  ledgerPath?: string;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
  dryRun?: boolean;
  maxAttempts?: number;
  blockerSummary: string;
  blockerFingerprint: string;
  contextBody: string;
  allowedChangedPaths: readonly string[];
  commitSubject: string;
  commitBody: string;
}

export interface PullRequestRepairReport {
  kind: PullRequestRepairKind;
  pr: number;
  status: PullRequestRepairStatus;
  message: string;
  ledgerPath: string;
  attempt: number;
  worktreePath?: string;
  changedPaths: readonly string[];
  productPolicyImpact?: ProductPolicyClassification;
  stopRule?: 'Mergeable: NO' | 'checks failed' | 'Unsafe or too broad' | 'attempt budget exhausted';
}

interface GhPrViewResponse {
  number?: number;
  title?: string;
  body?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRepository?: RepairRepositoryRef;
  headRepository?: RepairRepositoryRef;
  labels?: Array<{ name?: string }>;
}

const AUTOMATION_BRANCH_PATTERN = /^(takt|automation)\//u;
const BLOCKED_LABEL = 'agent:blocked';
const HUMAN_APPROVAL_LABELS = new Set(['human:approved', 'human-review:approved', 'human:reviewed']);
const FORBIDDEN_REPAIR_PATTERNS = [
  /^\.github\//u,
  /^infra\//u,
  /^terraform\//u,
  /^migrations?\//u,
  /^auth\//u,
  /^billing\//u,
  /^payments?\//u,
  /(^|\/)\.env/u,
  /secret/iu,
  /credential/iu,
];

function sanitizeDetail(text: string): string {
  return sanitizeSensitiveText(text).replace(/\s+/g, ' ').trim();
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function normalizeRepoName(repo: RepairRepositoryRef | undefined): string | undefined {
  if (repo?.nameWithOwner !== undefined) {
    return repo.nameWithOwner.toLowerCase();
  }
  if (repo?.owner?.login !== undefined && repo.name !== undefined) {
    return `${repo.owner.login}/${repo.name}`.toLowerCase();
  }
  return undefined;
}

function hasHumanApprovalLabel(pr: RepairPullRequestSnapshot): boolean {
  return pr.labels?.some((label) => HUMAN_APPROVAL_LABELS.has(label)) === true;
}

export function isSameRepositoryAutomationPr(pr: RepairPullRequestSnapshot): boolean {
  if (!AUTOMATION_BRANCH_PATTERN.test(pr.headRefName)) {
    return false;
  }
  const base = normalizeRepoName(pr.baseRepository);
  const head = normalizeRepoName(pr.headRepository);
  return base === undefined || head === undefined || base === head;
}

export function buildRepairFingerprint(parts: readonly string[]): string {
  return fingerprint(parts.join('\n---\n'));
}

function parseStringArray(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function countPreviousAttempts(options: {
  ledgerPath: string;
  kind: PullRequestRepairKind;
  pr: RepairPullRequestSnapshot;
  blockerFingerprint: string;
}): number {
  return readRawDevloopLedgerEvents(options.ledgerPath)
    .filter((event) => event.eventType === 'devloop_repair_attempt')
    .filter((event) => event.kind === options.kind)
    .filter((event) => event.prNumber === options.pr.number)
    .filter((event) => event.headSha === options.pr.headRefOid)
    .filter((event) => event.blockerFingerprint === options.blockerFingerprint)
    .filter((event) => event.status === 'started')
    .length;
}

function normalizeMaxAttempts(value: number | undefined, env: NodeJS.ProcessEnv): number {
  const parsed = value ?? Number(env.TAKT_LOOP_REPAIR_MAX_ATTEMPTS ?? 2);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
}

function appendRepairEvent(options: {
  ledgerPath: string;
  repoPath: string;
  kind: PullRequestRepairKind;
  pr: RepairPullRequestSnapshot;
  blockerFingerprint: string;
  blockerSummary: string;
  attempt: number;
  status: string;
  reason?: string;
  changedPaths?: readonly string[];
}): void {
  appendDevloopLedgerEvent(options.ledgerPath, buildDevloopLedgerEvent('devloop_repair_attempt', {
    repoPath: options.repoPath,
    kind: options.kind,
    prNumber: options.pr.number,
    headSha: options.pr.headRefOid,
    blockerFingerprint: options.blockerFingerprint,
    blockerSummary: sanitizeDetail(options.blockerSummary).slice(0, 500),
    attempt: options.attempt,
    status: options.status,
    reason: options.reason,
    changedPaths: options.changedPaths ?? [],
  }));
}

function resolveQualityGate(worktreePath: string, env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.TAKT_LOOP_QUALITY_GATE;
  if (configured !== undefined && configured.trim().length > 0) {
    return configured.startsWith('/') ? configured : join(worktreePath, configured);
  }
  return [
    '.takt/quality-gates/project-check.sh',
    '.takt/quality-gates/takt-check.sh',
    '.takt/quality-gates/check.sh',
  ].map((candidate) => join(worktreePath, candidate)).find((candidate) => existsSync(candidate));
}

async function runQualityGate(options: {
  worktreePath: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<string | undefined> {
  const gate = resolveQualityGate(options.worktreePath, options.env);
  if (gate === undefined) {
    return undefined;
  }
  const result = await options.runner.exec(gate, [], {
    cwd: options.worktreePath,
    env: options.env,
    timeoutMs: 15 * 60_000,
  });
  return result.exitCode === 0 ? undefined : `quality gate failed: ${sanitizeDetail(result.stderr || result.stdout)}`;
}

async function runGit(options: {
  runner: DevloopCommandRunner;
  env: NodeJS.ProcessEnv;
  cwd: string;
  args: readonly string[];
  timeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const gitCommand = options.runner.resolveCommand('git', options.env);
  if (gitCommand === undefined) {
    return { exitCode: 1, stdout: '', stderr: 'command not found: git' };
  }
  return options.runner.exec(gitCommand, options.args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
}

async function loadLatestHeadSha(options: {
  pr: number;
  repoPath: string;
  repo?: string;
  runner: DevloopCommandRunner;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const ghCommand = options.runner.resolveCommand('gh', options.env);
  if (ghCommand === undefined) {
    return undefined;
  }
  const args = ['pr', 'view', String(options.pr), '--json', 'headRefOid', '--jq', '.headRefOid'];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  const result = await options.runner.exec(ghCommand, args, {
    cwd: options.repoPath,
    env: options.env,
    timeoutMs: 30_000,
  });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

function parseChangedPaths(raw: string): string[] {
  return raw.split('\n').map((line) => line.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export function evaluateRepairDiffSafety(options: {
  pr: RepairPullRequestSnapshot;
  changedPaths: readonly string[];
  allowedChangedPaths: readonly string[];
}): { passed: true; productPolicyImpact: ProductPolicyClassification } | { passed: false; reason: string; productPolicyImpact?: ProductPolicyClassification } {
  const forbidden = options.changedPaths.find((path) => FORBIDDEN_REPAIR_PATTERNS.some((pattern) => pattern.test(path)));
  if (forbidden !== undefined) {
    return { passed: false, reason: `forbidden repair path touched: ${forbidden}` };
  }

  if (options.allowedChangedPaths.length > 0) {
    const allowed = new Set(options.allowedChangedPaths);
    const expanded = options.changedPaths.find((path) => !allowed.has(path));
    if (expanded !== undefined) {
      return { passed: false, reason: `repair changed path outside original PR scope: ${expanded}` };
    }
  }

  const productPolicyImpact = classifyProductPolicyImpact({
    changedPaths: options.changedPaths,
    title: options.pr.title,
    body: options.pr.body,
  });
  if (productPolicyImpact.requiresHumanReview && !hasHumanApprovalLabel(options.pr)) {
    return {
      passed: false,
      reason: `product-policy impact requires human approval: ${productPolicyImpact.reasons.join('; ')}`,
      productPolicyImpact,
    };
  }

  return { passed: true, productPolicyImpact };
}

function buildRepairPrompt(options: PullRequestRepairOptions): string {
  return [
    `Repair kind: ${options.kind}`,
    `PR: #${options.pr.number}`,
    `Branch: ${options.pr.headRefName}`,
    `Head SHA: ${options.pr.headRefOid}`,
    '',
    'Strict scope limits:',
    '- Only fix the blocker described below.',
    '- Do not change product direction, public contracts, pricing, auth, retention, or security posture.',
    '- Keep changed files within the original PR scope unless a local test file already exists in that scope.',
    '',
    'PR metadata:',
    JSON.stringify({
      title: options.pr.title,
      body: options.pr.body,
      allowedChangedPaths: options.allowedChangedPaths,
    }, null, 2),
    '',
    'Repair context:',
    options.contextBody,
  ].join('\n');
}

async function runFixer(options: {
  worktreePath: string;
  prompt: string;
  kind: PullRequestRepairKind;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<string | undefined> {
  const commandName = options.env.TAKT_LOOP_REPAIR_COMMAND
    ?? (options.kind === 'review-fix' ? options.env.TAKT_LOOP_REVIEW_FIX_COMMAND : options.env.TAKT_LOOP_CI_FIX_COMMAND)
    ?? 'codex';
  const command = options.runner.resolveCommand(commandName, options.env);
  if (command === undefined) {
    return `command not found: ${commandName}`;
  }
  const configuredArgs = parseStringArray(options.env.TAKT_LOOP_REPAIR_ARGS);
  const args = configuredArgs ?? (commandName === 'codex'
    ? [
      'exec',
      '--sandbox',
      'workspace-write',
      '--cd',
      options.worktreePath,
      '--model',
      options.env.TAKT_LOOP_CODEX_FIX_MODEL ?? 'gpt-5',
      '-c',
      `model_reasoning_effort=${options.env.TAKT_LOOP_CODEX_FIX_REASONING_EFFORT ?? 'high'}`,
      '-c',
      'approval_policy="never"',
      '-',
    ]
    : []);
  const result = await options.runner.exec(command, args, {
    cwd: options.worktreePath,
    env: options.env,
    stdin: options.prompt,
    timeoutMs: Number(options.env.TAKT_LOOP_REPAIR_TIMEOUT_MS ?? 30 * 60_000),
  });
  return result.exitCode === 0 ? undefined : `fixer failed: ${sanitizeDetail(result.stderr || result.stdout)}`;
}

function makeReport(input: {
  options: PullRequestRepairOptions;
  repoPath: string;
  ledgerPath: string;
  status: PullRequestRepairStatus;
  message: string;
  attempt: number;
  changedPaths?: readonly string[];
  worktreePath?: string;
  productPolicyImpact?: ProductPolicyClassification;
  stopRule?: PullRequestRepairReport['stopRule'];
}): PullRequestRepairReport {
  return {
    kind: input.options.kind,
    pr: input.options.pr.number,
    status: input.status,
    message: input.message,
    ledgerPath: input.ledgerPath,
    attempt: input.attempt,
    changedPaths: input.changedPaths ?? [],
    ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
    ...(input.productPolicyImpact !== undefined ? { productPolicyImpact: input.productPolicyImpact } : {}),
    ...(input.stopRule !== undefined ? { stopRule: input.stopRule } : {}),
  };
}

export async function loadRepairPullRequestSnapshot(options: {
  pr: number;
  repoPath: string;
  repo?: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<RepairPullRequestSnapshot | undefined> {
  const ghCommand = options.runner.resolveCommand('gh', options.env);
  if (ghCommand === undefined) {
    return undefined;
  }
  const args = [
    'pr',
    'view',
    String(options.pr),
    '--json',
    'number,title,body,headRefName,headRefOid,baseRepository,headRepository,labels',
  ];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  const result = await options.runner.exec(ghCommand, args, {
    cwd: options.repoPath,
    env: options.env,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  const parsed = JSON.parse(result.stdout) as GhPrViewResponse;
  if (parsed.number === undefined || parsed.headRefName === undefined || parsed.headRefOid === undefined) {
    return undefined;
  }
  return {
    number: parsed.number,
    title: parsed.title ?? '',
    body: parsed.body ?? '',
    headRefName: parsed.headRefName,
    headRefOid: parsed.headRefOid,
    ...(parsed.baseRepository !== undefined ? { baseRepository: parsed.baseRepository } : {}),
    ...(parsed.headRepository !== undefined ? { headRepository: parsed.headRepository } : {}),
    labels: parsed.labels?.flatMap((label) => label.name ? [label.name] : []) ?? [],
  };
}

async function addBlockedLabel(options: {
  pr: number;
  repoPath: string;
  repo?: string;
  runner: DevloopCommandRunner;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const ghCommand = options.runner.resolveCommand('gh', options.env);
  if (ghCommand === undefined) {
    return;
  }
  const args = ['pr', 'edit', String(options.pr), '--add-label', BLOCKED_LABEL];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  await options.runner.exec(ghCommand, args, {
    cwd: options.repoPath,
    env: options.env,
    timeoutMs: 30_000,
  });
}

async function cleanupWorktree(options: {
  repoPath: string;
  worktreePath: string;
  runner: DevloopCommandRunner;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await runGit({
    runner: options.runner,
    env: options.env,
    cwd: options.repoPath,
    args: ['worktree', 'remove', '--force', options.worktreePath],
    timeoutMs: 60_000,
  });
  if (existsSync(options.worktreePath)) {
    rmSync(options.worktreePath, { recursive: true, force: true });
  }
}

export async function runScopedPullRequestRepair(options: PullRequestRepairOptions): Promise<PullRequestRepairReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts, env);
  const previousAttempts = countPreviousAttempts({
    ledgerPath,
    kind: options.kind,
    pr: options.pr,
    blockerFingerprint: options.blockerFingerprint,
  });
  const attempt = previousAttempts + 1;

  if (!isSameRepositoryAutomationPr(options.pr)) {
    appendRepairEvent({
      ledgerPath,
      repoPath,
      kind: options.kind,
      pr: options.pr,
      blockerFingerprint: options.blockerFingerprint,
      blockerSummary: options.blockerSummary,
      attempt,
      status: 'skipped',
      reason: 'PR is not a same-repository automation branch',
    });
    return makeReport({
      options,
      repoPath,
      ledgerPath,
      status: 'skipped',
      message: 'PR is not a same-repository automation branch',
      attempt,
    });
  }

  if (previousAttempts >= maxAttempts) {
    await addBlockedLabel({ pr: options.pr.number, repoPath, repo: options.repo, runner, env });
    appendRepairEvent({
      ledgerPath,
      repoPath,
      kind: options.kind,
      pr: options.pr,
      blockerFingerprint: options.blockerFingerprint,
      blockerSummary: options.blockerSummary,
      attempt,
      status: 'budget_exhausted',
      reason: `max attempts exhausted: ${maxAttempts}`,
    });
    return makeReport({
      options,
      repoPath,
      ledgerPath,
      status: 'blocked',
      message: `max repair attempts exhausted: ${maxAttempts}`,
      attempt,
      stopRule: 'attempt budget exhausted',
    });
  }

  appendRepairEvent({
    ledgerPath,
    repoPath,
    kind: options.kind,
    pr: options.pr,
    blockerFingerprint: options.blockerFingerprint,
    blockerSummary: options.blockerSummary,
    attempt,
    status: 'started',
  });

  if (options.dryRun === true) {
    appendRepairEvent({
      ledgerPath,
      repoPath,
      kind: options.kind,
      pr: options.pr,
      blockerFingerprint: options.blockerFingerprint,
      blockerSummary: options.blockerSummary,
      attempt,
      status: 'dry_run',
    });
    return makeReport({
      options,
      repoPath,
      ledgerPath,
      status: 'passed',
      message: 'dry-run: would create repair worktree, run fixer, verify, commit, and push',
      attempt,
    });
  }

  const parent = mkdtempSync(join(tmpdir(), `takt-${options.kind}-`));
  const worktreePath = join(parent, `pr-${options.pr.number}`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  try {
    const fetch = await runGit({
      runner,
      env,
      cwd: repoPath,
      args: ['fetch', 'origin', options.pr.headRefName],
      timeoutMs: 120_000,
    });
    if (fetch.exitCode !== 0) {
      throw new Error(`git fetch failed: ${sanitizeDetail(fetch.stderr || fetch.stdout)}`);
    }
    const add = await runGit({
      runner,
      env,
      cwd: repoPath,
      args: ['worktree', 'add', '--force', '--detach', worktreePath, 'FETCH_HEAD'],
      timeoutMs: 120_000,
    });
    if (add.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${sanitizeDetail(add.stderr || add.stdout)}`);
    }

    const fixerError = await runFixer({
      worktreePath,
      prompt: buildRepairPrompt(options),
      kind: options.kind,
      env,
      runner,
    });
    if (fixerError !== undefined) {
      throw new Error(fixerError);
    }

    const gateError = await runQualityGate({ worktreePath, env, runner });
    if (gateError !== undefined) {
      throw new Error(gateError);
    }

    const diffCheck = await runGit({
      runner,
      env,
      cwd: worktreePath,
      args: ['diff', '--check'],
      timeoutMs: 60_000,
    });
    if (diffCheck.exitCode !== 0) {
      throw new Error(`git diff --check failed: ${sanitizeDetail(diffCheck.stderr || diffCheck.stdout)}`);
    }

    const changed = await runGit({
      runner,
      env,
      cwd: worktreePath,
      args: ['diff', '--name-only'],
      timeoutMs: 60_000,
    });
    if (changed.exitCode !== 0) {
      throw new Error(`git diff --name-only failed: ${sanitizeDetail(changed.stderr || changed.stdout)}`);
    }
    const changedPaths = parseChangedPaths(changed.stdout);
    if (changedPaths.length === 0) {
      appendRepairEvent({
        ledgerPath,
        repoPath,
        kind: options.kind,
        pr: options.pr,
        blockerFingerprint: options.blockerFingerprint,
        blockerSummary: options.blockerSummary,
        attempt,
        status: 'skipped',
        reason: 'fixer made no changes',
      });
      return makeReport({
        options,
        repoPath,
        ledgerPath,
        status: 'skipped',
        message: 'fixer made no changes',
        attempt,
        worktreePath,
      });
    }

    const safety = evaluateRepairDiffSafety({
      pr: options.pr,
      changedPaths,
      allowedChangedPaths: options.allowedChangedPaths,
    });
    if (!safety.passed) {
      appendRepairEvent({
        ledgerPath,
        repoPath,
        kind: options.kind,
        pr: options.pr,
        blockerFingerprint: options.blockerFingerprint,
        blockerSummary: options.blockerSummary,
        attempt,
        status: 'blocked',
        reason: safety.reason,
        changedPaths,
      });
      return makeReport({
        options,
        repoPath,
        ledgerPath,
        status: 'blocked',
        message: safety.reason,
        attempt,
        worktreePath,
        changedPaths,
        productPolicyImpact: safety.productPolicyImpact,
        stopRule: 'Unsafe or too broad',
      });
    }

    const latestHeadSha = await loadLatestHeadSha({
      pr: options.pr.number,
      repoPath,
      repo: options.repo,
      runner,
      env,
    });
    if (latestHeadSha !== undefined && latestHeadSha !== options.pr.headRefOid) {
      throw new Error(`head SHA changed before push: expected ${options.pr.headRefOid}, got ${latestHeadSha}`);
    }

    const addAll = await runGit({ runner, env, cwd: worktreePath, args: ['add', '--all'], timeoutMs: 60_000 });
    if (addAll.exitCode !== 0) {
      throw new Error(`git add failed: ${sanitizeDetail(addAll.stderr || addAll.stdout)}`);
    }
    const commit = await runGit({
      runner,
      env,
      cwd: worktreePath,
      args: ['commit', '-m', options.commitSubject, '-m', options.commitBody],
      timeoutMs: 120_000,
    });
    if (commit.exitCode !== 0) {
      throw new Error(`git commit failed: ${sanitizeDetail(commit.stderr || commit.stdout)}`);
    }
    const push = await runGit({
      runner,
      env,
      cwd: worktreePath,
      args: ['push', 'origin', `HEAD:${options.pr.headRefName}`, `--force-with-lease=${options.pr.headRefName}:${options.pr.headRefOid}`],
      timeoutMs: 120_000,
    });
    if (push.exitCode !== 0) {
      throw new Error(`git push failed: ${sanitizeDetail(push.stderr || push.stdout)}`);
    }

    appendRepairEvent({
      ledgerPath,
      repoPath,
      kind: options.kind,
      pr: options.pr,
      blockerFingerprint: options.blockerFingerprint,
      blockerSummary: options.blockerSummary,
      attempt,
      status: 'pushed',
      changedPaths,
    });
    return makeReport({
      options,
      repoPath,
      ledgerPath,
      status: 'passed',
      message: `pushed ${options.kind} repair to ${options.pr.headRefName}`,
      attempt,
      worktreePath,
      changedPaths,
      productPolicyImpact: safety.productPolicyImpact,
      stopRule: options.kind === 'review-fix' ? 'Mergeable: NO' : 'checks failed',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    appendRepairEvent({
      ledgerPath,
      repoPath,
      kind: options.kind,
      pr: options.pr,
      blockerFingerprint: options.blockerFingerprint,
      blockerSummary: options.blockerSummary,
      attempt,
      status: 'failed',
      reason,
    });
    return makeReport({
      options,
      repoPath,
      ledgerPath,
      status: 'failed',
      message: sanitizeDetail(reason),
      attempt,
      worktreePath,
    });
  } finally {
    await cleanupWorktree({ repoPath, worktreePath, runner, env });
    if (existsSync(parent)) {
      rmSync(parent, { recursive: true, force: true });
    }
  }
}
