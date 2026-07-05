import { resolve } from 'node:path';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandRunner,
} from './commandRunner.js';
import { parseReviewGateComment, type ParsedReviewGateComment } from './prReviewGate.js';
import {
  buildRepairFingerprint,
  loadRepairPullRequestSnapshot,
  runScopedPullRequestRepair,
  type PullRequestRepairReport,
  type RepairPullRequestSnapshot,
} from './repairExecutor.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export interface ReviewFixOptions {
  pr: number;
  repoPath?: string;
  repo?: string;
  ledgerPath?: string;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
  dryRun?: boolean;
  maxAttempts?: number;
}

interface GhIssueComment {
  body?: string;
  created_at?: string;
}

function sanitizeDetail(text: string): string {
  return sanitizeSensitiveText(text).replace(/\s+/g, ' ').trim();
}

function parseJsonArray(raw: string): unknown[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

async function resolveLocalRepoName(options: {
  repoPath: string;
  runner: DevloopCommandRunner;
  env: NodeJS.ProcessEnv;
  ghCommand: string;
}): Promise<string | undefined> {
  const result = await options.runner.exec(
    options.ghCommand,
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd: options.repoPath, env: options.env, timeoutMs: 30_000 },
  );
  return result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : undefined;
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
    return [];
  }
  const repo = options.repo ?? await resolveLocalRepoName({
    repoPath: options.repoPath,
    runner: options.runner,
    env: options.env,
    ghCommand,
  });
  if (repo === undefined) {
    return [];
  }
  const result = await options.runner.exec(
    ghCommand,
    ['api', `repos/${repo}/issues/${options.pr}/comments`, '--paginate'],
    { cwd: options.repoPath, env: options.env, timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) {
    return [];
  }
  return parseJsonArray(result.stdout || '[]').flatMap((item) => {
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

async function loadChangedPaths(options: {
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
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function findCurrentHeadReviewBlocker(options: {
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

function buildReviewFixContext(options: {
  pr: RepairPullRequestSnapshot;
  blocker: ParsedReviewGateComment;
  changedPaths: readonly string[];
}): string {
  return [
    `Reviewer: ${options.blocker.reviewer}`,
    `Review created at: ${options.blocker.createdAt ?? 'unknown'}`,
    `Review marker head: ${options.blocker.headSha}`,
    '',
    'Blocking review body:',
    options.blocker.body,
    '',
    'Original PR changed files:',
    options.changedPaths.join('\n') || 'unknown',
  ].join('\n');
}

export async function runReviewFixForPullRequest(options: ReviewFixOptions): Promise<PullRequestRepairReport> {
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
  if (pr === undefined) {
    return {
      kind: 'review-fix',
      pr: options.pr,
      status: 'failed',
      message: 'unable to load PR metadata',
      ledgerPath: options.ledgerPath ?? '',
      attempt: 0,
      changedPaths: [],
    };
  }

  const comments = await loadReviewComments({ pr: options.pr, repoPath, repo: options.repo, env, runner });
  const blocker = findCurrentHeadReviewBlocker({ headSha: pr.headRefOid, comments });
  if (blocker === undefined) {
    return {
      kind: 'review-fix',
      pr: options.pr,
      status: 'skipped',
      message: 'no current-head Mergeable: NO review found',
      ledgerPath: options.ledgerPath ?? '',
      attempt: 0,
      changedPaths: [],
    };
  }

  const changedPaths = await loadChangedPaths({ pr: options.pr, repoPath, repo: options.repo, env, runner });
  return runScopedPullRequestRepair({
    kind: 'review-fix',
    pr,
    repoPath,
    repo: options.repo,
    ledgerPath: options.ledgerPath,
    env,
    runner,
    dryRun: options.dryRun,
    maxAttempts: options.maxAttempts,
    blockerSummary: `${blocker.reviewer} blocked current head ${pr.headRefOid}`,
    blockerFingerprint: buildRepairFingerprint([pr.headRefOid, blocker.reviewer, blocker.body]),
    contextBody: buildReviewFixContext({ pr, blocker, changedPaths }),
    allowedChangedPaths: changedPaths,
    commitSubject: `fix: address review for PR #${pr.number}`,
    commitBody: [
      `Review marker: ${blocker.reviewer} ${pr.headRefOid}`,
      '',
      sanitizeDetail(blocker.body).slice(0, 1_000),
    ].join('\n'),
  });
}

export function formatReviewFixReport(report: PullRequestRepairReport): string {
  const lines = [
    `devloopd review-fix #${report.pr}: ${report.status}`,
    report.message,
    `Ledger: ${report.ledgerPath}`,
    `Attempt: ${report.attempt}`,
  ];
  if (report.stopRule !== undefined) {
    lines.push(`Stop rule: ${report.stopRule}`);
  }
  if (report.changedPaths.length > 0) {
    lines.push('Changed paths:');
    lines.push(...report.changedPaths.map((path) => `- ${path}`));
  }
  return lines.join('\n');
}
