import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DevloopCommandRunner } from '../devloopd/commandRunner.js';
import {
  buildRepairFingerprint,
  evaluateRepairDiffSafety,
  isSameRepositoryAutomationPr,
  runScopedPullRequestRepair,
  type RepairPullRequestSnapshot,
} from '../devloopd/repairExecutor.js';
import {
  findCurrentHeadReviewBlocker,
  runReviewFixForPullRequest,
} from '../devloopd/reviewFix.js';

interface Call {
  command: string;
  args: readonly string[];
}

function pr(overrides: Partial<RepairPullRequestSnapshot> = {}): RepairPullRequestSnapshot {
  return {
    number: 22,
    title: 'fix: improve devloopd',
    body: 'Closes #45',
    headRefName: 'takt/issue-45',
    headRefOid: 'abc123',
    baseRepository: { nameWithOwner: 'owner/repo' },
    headRepository: { nameWithOwner: 'owner/repo' },
    labels: [],
    ...overrides,
  };
}

function runner(): DevloopCommandRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    resolveCommand(command) {
      return command === 'gh' || command === 'git' || command === 'codex' ? `/mock/bin/${command}` : undefined;
    },
    async exec(command, args) {
      calls.push({ command, args });
      if (command.endsWith('/gh') && args[0] === 'pr' && args[1] === 'view') {
        return { exitCode: 0, stdout: JSON.stringify(pr()), stderr: '' };
      }
      if (command.endsWith('/gh') && args[0] === 'api') {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              body: '<!-- takt-loop-mergeability-review -->\nReviewer: agy\nHead SHA: `abc123`\n\nMergeable: NO\nReason: add missing test',
              created_at: '2026-07-05T00:00:00Z',
            },
          ]),
          stderr: '',
        };
      }
      if (command.endsWith('/gh') && args[0] === 'pr' && args[1] === 'diff') {
        return { exitCode: 0, stdout: 'src/devloopd/prAutomation.ts\nsrc/__tests__/devloopd-pr-automation.test.ts\n', stderr: '' };
      }
      return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
    },
  };
}

describe('devloopd review-fix repair loop', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-review-fix-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(repoPath)) {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('detects current-head blocking review comments in TypeScript', () => {
    const blocker = findCurrentHeadReviewBlocker({
      headSha: 'abc123',
      comments: [
        { body: '<!-- takt-loop-mergeability-review -->\nHead SHA: `old`\n\nMergeable: NO\nReason: stale' },
        { body: '<!-- takt-loop-review-gate:v1 reviewer=codex decision=blocked head=abc123 -->\nHead SHA: `abc123`\n\nCodex-Human-Review: BLOCKED\nReason: current' },
      ],
    });

    expect(blocker).toMatchObject({
      reviewer: 'codex',
      decision: 'blocked',
      headSha: 'abc123',
    });
  });

  it('only accepts same-repository automation PR branches', () => {
    expect(isSameRepositoryAutomationPr(pr())).toBe(true);
    expect(isSameRepositoryAutomationPr(pr({ headRefName: 'feature/manual' }))).toBe(false);
    expect(isSameRepositoryAutomationPr(pr({
      headRepository: { nameWithOwner: 'fork/repo' },
    }))).toBe(false);
  });

  it('dry-runs a current-head review-fix without invoking git worktree mutation', async () => {
    const fake = runner();

    const report = await runReviewFixForPullRequest({
      pr: 22,
      repoPath,
      repo: 'owner/repo',
      runner: fake,
      dryRun: true,
      maxAttempts: 2,
    });

    expect(report.status).toBe('passed');
    expect(report.message).toContain('dry-run');
    expect(fake.calls.some((call) => call.command.endsWith('/git'))).toBe(false);

    const ledger = readFileSync(join(repoPath, '.devloop', 'ledger.jsonl'), 'utf-8');
    expect(ledger).toContain('devloop_repair_attempt');
  });

  it('blocks repeated attempts for the same PR head and blocker fingerprint', async () => {
    const fingerprint = buildRepairFingerprint(['abc123', 'agy', 'same blocker']);

    await runScopedPullRequestRepair({
      kind: 'review-fix',
      pr: pr(),
      repoPath,
      runner: runner(),
      dryRun: true,
      maxAttempts: 1,
      blockerSummary: 'same blocker',
      blockerFingerprint: fingerprint,
      contextBody: 'review body',
      allowedChangedPaths: ['src/devloopd/prAutomation.ts'],
      commitSubject: 'fix: review',
      commitBody: 'Review marker: agy abc123',
    });
    const second = await runScopedPullRequestRepair({
      kind: 'review-fix',
      pr: pr(),
      repoPath,
      runner: runner(),
      dryRun: true,
      maxAttempts: 1,
      blockerSummary: 'same blocker',
      blockerFingerprint: fingerprint,
      contextBody: 'review body',
      allowedChangedPaths: ['src/devloopd/prAutomation.ts'],
      commitSubject: 'fix: review',
      commitBody: 'Review marker: agy abc123',
    });

    expect(second.status).toBe('blocked');
    expect(second.stopRule).toBe('attempt budget exhausted');
  });

  it('refuses scope expansion and product-policy repair diffs', () => {
    expect(evaluateRepairDiffSafety({
      pr: pr(),
      changedPaths: ['src/other.ts'],
      allowedChangedPaths: ['src/devloopd/prAutomation.ts'],
    })).toMatchObject({
      passed: false,
      reason: 'repair changed path outside original PR scope: src/other.ts',
    });

    expect(evaluateRepairDiffSafety({
      pr: pr(),
      changedPaths: ['migrations/001.sql'],
      allowedChangedPaths: ['migrations/001.sql'],
    })).toMatchObject({
      passed: false,
    });
  });
});
