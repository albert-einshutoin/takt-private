import { resolve } from 'node:path';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandRunner,
} from './commandRunner.js';
import {
  appendDevloopLedgerEvent,
  buildDevloopLedgerEvent,
  resolveDevloopLedgerPath,
} from './ledger.js';
import {
  buildRepairFingerprint,
  loadRepairPullRequestSnapshot,
  runScopedPullRequestRepair,
  type PullRequestRepairReport,
  type RepairPullRequestSnapshot,
} from './repairExecutor.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type CiCheckState = 'missing' | 'pending' | 'failed' | 'cancelled' | 'passed';
export type CiFailureKind = 'deterministic' | 'flaky' | 'infra' | 'auth_permission' | 'timeout' | 'unknown';

export interface CiCheckRun {
  name: string;
  state: CiCheckState;
  workflow?: string;
  link?: string;
  description?: string;
  runId?: string;
}

export interface CiFailureArtifact {
  checkName: string;
  state: CiCheckState;
  kind: CiFailureKind;
  summary: string;
  logExcerpt: string;
  runId?: string;
}

export interface CiFailureCollectionReport {
  passed: boolean;
  pr: number;
  headSha: string;
  state: CiCheckState;
  message: string;
  failures: readonly CiFailureArtifact[];
  ledgerPath: string;
}

export interface CiRepairOptions {
  pr: number;
  repoPath?: string;
  repo?: string;
  ledgerPath?: string;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
  dryRun?: boolean;
  maxAttempts?: number;
}

interface GhPrCheck {
  name?: string;
  state?: string;
  bucket?: string;
  workflow?: string;
  link?: string;
  description?: string;
}

function sanitizeLog(text: string): string {
  return sanitizeSensitiveText(text)
    .replace(/\r/g, '')
    .split('\n')
    .slice(-120)
    .join('\n')
    .slice(-12_000);
}

function normalizeCheckState(check: GhPrCheck): CiCheckState {
  const state = `${check.state ?? ''} ${check.bucket ?? ''}`.toLowerCase();
  if (/\b(pass|success)\b/u.test(state)) return 'passed';
  if (/\b(cancel|skipp)\b/u.test(state)) return 'cancelled';
  if (/\b(fail|error|action_required)\b/u.test(state)) return 'failed';
  if (/\b(pending|queued|in_progress|waiting|neutral)\b/u.test(state)) return 'pending';
  return 'failed';
}

function parseRunId(link: string | undefined): string | undefined {
  if (link === undefined) {
    return undefined;
  }
  return /\/actions\/runs\/(\d+)/u.exec(link)?.[1];
}

function parseChecks(raw: string): CiCheckRun[] {
  const parsed = JSON.parse(raw) as GhPrCheck[];
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((check) => {
    if (check.name === undefined) {
      return [];
    }
    const runId = parseRunId(check.link);
    return [{
      name: check.name,
      state: normalizeCheckState(check),
      ...(check.workflow !== undefined ? { workflow: check.workflow } : {}),
      ...(check.link !== undefined ? { link: check.link } : {}),
      ...(check.description !== undefined ? { description: check.description } : {}),
      ...(runId !== undefined ? { runId } : {}),
    }];
  });
}

export function classifyCiFailure(text: string): CiFailureKind {
  const normalized = text.toLowerCase();
  if (/\b(resource not accessible by integration|permission denied|unauthorized|forbidden|403|bad credentials|authentication failed)\b/u.test(normalized)) {
    return 'auth_permission';
  }
  if (/\b(timed out|timeout|exceeded.*time|cancelled after)\b/u.test(normalized)) {
    return 'timeout';
  }
  if (/\b(econnreset|etimedout|502|503|504|network|rate limit|temporar(?:y|ily)|service unavailable)\b/u.test(normalized)) {
    return 'infra';
  }
  if (/\b(flaky|race condition|intermittent|rerun|try again)\b/u.test(normalized)) {
    return 'flaky';
  }
  if (/\b(assertionerror|typeerror|referenceerror|syntaxerror|ts\d{4}|eslint|test failed|expected .* received|npm err!|exit code 1)\b/u.test(normalized)) {
    return 'deterministic';
  }
  return 'unknown';
}

function aggregateState(checks: readonly CiCheckRun[]): CiCheckState {
  if (checks.length === 0) return 'missing';
  if (checks.some((check) => check.state === 'failed')) return 'failed';
  if (checks.some((check) => check.state === 'cancelled')) return 'cancelled';
  if (checks.some((check) => check.state === 'pending')) return 'pending';
  return 'passed';
}

async function collectLog(options: {
  check: CiCheckRun;
  ghCommand: string;
  repoPath: string;
  repo?: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<string> {
  if (options.check.runId === undefined) {
    return options.check.description ?? '';
  }
  const args = ['run', 'view', options.check.runId, '--log'];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  const result = await options.runner.exec(options.ghCommand, args, {
    cwd: options.repoPath,
    env: options.env,
    timeoutMs: 60_000,
  });
  return result.exitCode === 0 ? result.stdout : `${options.check.description ?? ''}\n${result.stderr || result.stdout}`;
}

async function loadPrChangedPaths(options: {
  pr: number;
  repoPath: string;
  repo?: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<string[]> {
  const ghCommand = options.runner.resolveCommand('gh', options.env);
  if (ghCommand === undefined) {
    return [];
  }
  const args = ['pr', 'diff', String(options.pr), '--name-only'];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  const result = await options.runner.exec(ghCommand, args, {
    cwd: options.repoPath,
    env: options.env,
    timeoutMs: 30_000,
  });
  return result.exitCode === 0
    ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
}

export async function collectCiFailures(options: {
  pr: number;
  headSha: string;
  repoPath?: string;
  repo?: string;
  ledgerPath?: string;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
}): Promise<CiFailureCollectionReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  const ghCommand = runner.resolveCommand('gh', env);
  if (ghCommand === undefined) {
    return {
      passed: false,
      pr: options.pr,
      headSha: options.headSha,
      state: 'missing',
      message: 'command not found: gh',
      failures: [],
      ledgerPath,
    };
  }
  const args = ['pr', 'checks', String(options.pr), '--json', 'name,state,bucket,workflow,link,description'];
  if (options.repo !== undefined) {
    args.push('--repo', options.repo);
  }
  const checksResult = await runner.exec(ghCommand, args, {
    cwd: repoPath,
    env,
    timeoutMs: 60_000,
  });
  if (checksResult.exitCode !== 0) {
    const detail = sanitizeLog(checksResult.stderr || checksResult.stdout);
    const state: CiCheckState = /no checks|not found/iu.test(detail) ? 'missing' : 'failed';
    return {
      passed: false,
      pr: options.pr,
      headSha: options.headSha,
      state,
      message: `gh pr checks failed: ${detail}`,
      failures: [],
      ledgerPath,
    };
  }

  const checks = parseChecks(checksResult.stdout);
  const state = aggregateState(checks);
  const failedChecks = checks.filter((check) => check.state === 'failed' || check.state === 'cancelled');
  const failures: CiFailureArtifact[] = [];
  for (const check of failedChecks) {
    const log = sanitizeLog(await collectLog({ check, ghCommand, repoPath, repo: options.repo, env, runner }));
    const summary = sanitizeLog([check.description, log.split('\n').slice(-8).join('\n')].filter(Boolean).join('\n'));
    failures.push({
      checkName: check.name,
      state: check.state,
      kind: classifyCiFailure(`${check.name}\n${summary}\n${log}`),
      summary,
      logExcerpt: log,
      ...(check.runId !== undefined ? { runId: check.runId } : {}),
    });
  }

  appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_ci_failure_collected', {
    repoPath,
    prNumber: options.pr,
    headSha: options.headSha,
    state,
    failures: failures.map((failure) => ({
      checkName: failure.checkName,
      state: failure.state,
      kind: failure.kind,
      summary: failure.summary.slice(0, 1_000),
      runId: failure.runId,
    })),
  }));

  return {
    passed: state !== 'failed' && state !== 'cancelled',
    pr: options.pr,
    headSha: options.headSha,
    state,
    message: state === 'passed'
      ? 'all checks passed'
      : `CI state is ${state} with ${failures.length} failure artifact(s)`,
    failures,
    ledgerPath,
  };
}

function shouldRepair(failures: readonly CiFailureArtifact[]): boolean {
  return failures.some((failure) => failure.kind === 'deterministic' || failure.kind === 'unknown');
}

function shouldBlockForOperator(failures: readonly CiFailureArtifact[]): boolean {
  return failures.some((failure) => failure.kind === 'auth_permission');
}

function buildCiContext(failures: readonly CiFailureArtifact[]): string {
  return failures.map((failure) => [
    `Check: ${failure.checkName}`,
    `State: ${failure.state}`,
    `Kind: ${failure.kind}`,
    'Summary:',
    failure.summary,
    'Log excerpt:',
    failure.logExcerpt,
  ].join('\n')).join('\n\n---\n\n');
}

function makeSkippedRepairReport(input: {
  kind: PullRequestRepairReport['kind'];
  pr: number;
  status: PullRequestRepairReport['status'];
  message: string;
  ledgerPath: string;
  stopRule?: PullRequestRepairReport['stopRule'];
}): PullRequestRepairReport {
  return {
    kind: input.kind,
    pr: input.pr,
    status: input.status,
    message: input.message,
    ledgerPath: input.ledgerPath,
    attempt: 0,
    changedPaths: [],
    ...(input.stopRule !== undefined ? { stopRule: input.stopRule } : {}),
  };
}

export async function runCiAutoRepairForPullRequest(options: CiRepairOptions): Promise<PullRequestRepairReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const pr = await loadRepairPullRequestSnapshot({
    pr: options.pr,
    repoPath,
    repo: options.repo,
    env,
    runner,
  });
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  if (pr === undefined) {
    return makeSkippedRepairReport({
      kind: 'ci-fix',
      pr: options.pr,
      status: 'failed',
      message: 'unable to load PR metadata',
      ledgerPath,
    });
  }
  const collection = await collectCiFailures({
    pr: pr.number,
    headSha: pr.headRefOid,
    repoPath,
    repo: options.repo,
    ledgerPath: options.ledgerPath,
    env,
    runner,
  });
  if (collection.state === 'passed') {
    return makeSkippedRepairReport({
      kind: 'ci-fix',
      pr: pr.number,
      status: 'skipped',
      message: 'CI checks already pass',
      ledgerPath,
    });
  }
  if (collection.state === 'missing' || collection.state === 'pending') {
    return makeSkippedRepairReport({
      kind: 'ci-fix',
      pr: pr.number,
      status: 'skipped',
      message: `CI state is ${collection.state}; waiting before repair`,
      ledgerPath,
      stopRule: 'checks failed',
    });
  }
  if (shouldBlockForOperator(collection.failures)) {
    return makeSkippedRepairReport({
      kind: 'ci-fix',
      pr: pr.number,
      status: 'blocked',
      message: 'CI failure requires human/operator credentials or permission action',
      ledgerPath,
      stopRule: 'checks failed',
    });
  }
  if (!shouldRepair(collection.failures)) {
    appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_ci_retry', {
      repoPath,
      prNumber: pr.number,
      headSha: pr.headRefOid,
      failureKinds: collection.failures.map((failure) => failure.kind),
      retryAfter: new Date(Date.now() + 15 * 60_000).toISOString(),
    }));
    return makeSkippedRepairReport({
      kind: 'ci-fix',
      pr: pr.number,
      status: 'skipped',
      message: 'CI failure looks flaky or infrastructure-related; retry before code changes',
      ledgerPath,
      stopRule: 'checks failed',
    });
  }

  const changedPaths = await loadPrChangedPaths({ pr: pr.number, repoPath, repo: options.repo, env, runner });
  return runScopedPullRequestRepair({
    kind: 'ci-fix',
    pr: pr as RepairPullRequestSnapshot,
    repoPath,
    repo: options.repo,
    ledgerPath: options.ledgerPath,
    env,
    runner,
    dryRun: options.dryRun,
    maxAttempts: options.maxAttempts,
    blockerSummary: `CI failed for PR #${pr.number}`,
    blockerFingerprint: buildRepairFingerprint([
      pr.headRefOid,
      ...collection.failures.map((failure) => `${failure.checkName}:${failure.kind}:${failure.summary}`),
    ]),
    contextBody: buildCiContext(collection.failures),
    allowedChangedPaths: changedPaths,
    commitSubject: `fix: repair CI for PR #${pr.number}`,
    commitBody: [
      `CI head: ${pr.headRefOid}`,
      '',
      collection.failures.map((failure) => `${failure.checkName}: ${failure.kind}`).join('\n'),
    ].join('\n'),
  });
}

export function formatCiFailureCollectionReport(report: CiFailureCollectionReport): string {
  const lines = [
    `devloopd ci-fix collect #${report.pr}: ${report.state}`,
    report.message,
    `Ledger: ${report.ledgerPath}`,
  ];
  for (const failure of report.failures) {
    lines.push(`- ${failure.checkName}: ${failure.kind} (${failure.state})`);
  }
  return lines.join('\n');
}
