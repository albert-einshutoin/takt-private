import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DevloopCommandRunner } from '../devloopd/commandRunner.js';
import { readRawDevloopLedgerEvents } from '../devloopd/ledger.js';
import {
  attachDagPlanToMergeQueuePullRequests,
  findCurrentHeadBlockingReview,
  findDuplicateIssueCoverage,
  parseAutomationPullRequests,
  runDevloopAutomationStage,
  selectAutomationPullRequests,
} from '../devloopd/prAutomation.js';
import { formatReviewGateComment } from '../devloopd/prReviewGate.js';

function makePrMergeRunner(): DevloopCommandRunner & { calls: string[]; timeouts: Array<number | undefined> } {
  const calls: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const approvalComments = [
    {
      body: formatReviewGateComment({
        reviewer: 'agy',
        decision: 'approved',
        headSha: 'abc123',
        body: 'Mergeable: YES\nReason: scoped automation change',
      }),
    },
    {
      body: formatReviewGateComment({
        reviewer: 'codex',
        decision: 'approved',
        headSha: 'abc123',
        body: 'Codex-Human-Review: APPROVED\nReason: scoped automation change',
      }),
    },
  ];

  return {
    calls,
    timeouts,
    resolveCommand(command) {
      return command === 'gh' ? '/mock/bin/gh' : undefined;
    },
    async exec(_command, args, options) {
      calls.push(args.join(' '));
      timeouts.push(options?.timeoutMs);
      if (args.slice(0, 2).join(' ') === 'pr list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{
            number: 42,
            title: 'fix: queue automation closeout',
            body: 'Closes #70',
            headRefName: 'takt/issue-70',
            headRefOid: 'abc123',
            isDraft: false,
            author: { login: 'dev' },
            labels: [],
          }]),
          stderr: '',
        };
      }
      if (args.slice(0, 2).join(' ') === 'pr view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 42,
            title: 'fix: queue automation closeout',
            body: 'Closes #70',
            headRefOid: 'abc123',
            mergeStateStatus: 'DIRTY',
            changedFiles: 1,
            additions: 8,
            deletions: 2,
          }),
          stderr: '',
        };
      }
      if (args.slice(0, 2).join(' ') === 'pr diff' && args.includes('--name-only')) {
        return {
          exitCode: 0,
          stdout: 'src/devloopd/prAutomation.ts\n',
          stderr: '',
        };
      }
      if (args.slice(0, 2).join(' ') === 'pr diff' && args.includes('--patch')) {
        return {
          exitCode: 0,
          stdout: [
            'diff --git a/src/devloopd/prAutomation.ts b/src/devloopd/prAutomation.ts',
            '+captured eviction context',
          ].join('\n'),
          stderr: '',
        };
      }
      if (args.slice(0, 2).join(' ') === 'pr checks') {
        return { exitCode: 0, stdout: 'All checks were successful\n', stderr: '' };
      }
      if (args[0] === 'api') {
        return { exitCode: 0, stdout: JSON.stringify(approvalComments), stderr: '' };
      }
      if (args.slice(0, 2).join(' ') === 'pr edit') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected gh args: ${args.join(' ')}` };
    },
  };
}

describe('devloopd PR automation orchestration', () => {
  it('discovers non-draft automation PRs from mocked GitHub output', () => {
    const prs = parseAutomationPullRequests(JSON.stringify([
      {
        number: 10,
        title: 'fix: issue 40',
        body: 'Closes #40',
        headRefName: 'takt/issue-40',
        headRefOid: 'abc123',
        isDraft: false,
        author: { login: 'dev' },
        labels: [{ name: 'agent:ready' }],
      },
      {
        number: 11,
        title: 'draft',
        body: 'Closes #41',
        headRefName: 'takt/issue-41',
        headRefOid: 'def456',
        isDraft: true,
        author: { login: 'dev' },
        labels: [],
      },
      {
        number: 12,
        title: 'deps',
        body: '',
        headRefName: 'dependabot/npm',
        headRefOid: 'fedcba',
        isDraft: false,
        author: { login: 'dependabot[bot]' },
        labels: [],
      },
    ]));

    expect(selectAutomationPullRequests(prs).map((pr) => pr.number)).toEqual([10]);
  });

  it('keeps duplicate issue coverage as a distinct stop rule', () => {
    const prs = parseAutomationPullRequests(JSON.stringify([
      {
        number: 10,
        title: 'fix: issue 40',
        body: 'Closes #40',
        headRefName: 'takt/issue-40-a',
        headRefOid: 'abc123',
        isDraft: false,
        author: { login: 'dev' },
        labels: [],
      },
      {
        number: 11,
        title: 'fix: issue 40 again',
        body: 'Fixes #40',
        headRefName: 'automation/issue-40-b',
        headRefOid: 'def456',
        isDraft: false,
        author: { login: 'dev' },
        labels: [],
      },
    ]));

    expect(findDuplicateIssueCoverage(prs)).toEqual([
      {
        issue: 40,
        prNumbers: [10, 11],
        stopRule: 'Duplicate or already covered',
      },
    ]);
  });

  it('detects current-head Mergeable: NO reviews as a review-fix stop rule', () => {
    const blocker = findCurrentHeadBlockingReview({
      headSha: 'abc123',
      comments: [
        {
          body: '<!-- takt-loop-mergeability-review -->\nHead SHA: `old456`\n\nMergeable: NO\nReason: stale',
        },
        {
          body: '<!-- takt-loop-mergeability-review -->\nHead SHA: `abc123`\n\nMergeable: NO\nReason: current blocker',
        },
      ],
    });

    expect(blocker).toMatchObject({
      reviewer: 'agy',
      decision: 'blocked',
      headSha: 'abc123',
    });
  });

  it('records merge queue eviction state with captured PR diff context', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'takt-pr-automation-'));
    const ledgerPath = 'ledger.jsonl';
    const runner = makePrMergeRunner();

    const report = await runDevloopAutomationStage({
      stage: 'pr-merge',
      repoPath,
      repo: 'owner/repo',
      ledgerPath,
      runner,
      env: { PATH: '/mock/bin' },
    });

    const events = readRawDevloopLedgerEvents(join(repoPath, ledgerPath))
      .filter((event) => event.eventType === 'devloop_automation_state');

    expect(report.passed).toBe(true);
    expect(report.actions[0]).toMatchObject({
      type: 'merge-queue',
      status: 'blocked',
      pr: 42,
      stopRule: 'conflict eviction',
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'eviction',
        status: 'blocked',
        prNumber: 42,
        stopRule: 'conflict eviction',
      }),
    ]));
    expect(JSON.stringify(events)).toContain('diff --git');
    expect(runner.timeouts.every((timeout) => timeout === 60_000)).toBe(true);
  });

  it('attaches executable DAG work-unit metadata before merge queue planning', () => {
    const planned = attachDagPlanToMergeQueuePullRequests([
      {
        number: 50,
        title: 'first scheduler change',
        headRefOid: 'a1',
        changedPaths: ['src/devloopd/stagedScheduler.ts'],
        checksPassed: true,
        dualLlmApproved: true,
      },
      {
        number: 51,
        title: 'second scheduler change',
        headRefOid: 'b2',
        changedPaths: ['src/devloopd/stagedScheduler.ts'],
        checksPassed: true,
        dualLlmApproved: true,
      },
    ]);

    expect(planned[0]).toMatchObject({ workUnitId: 'pr-50', dagLayer: 0 });
    expect(planned[1]).toMatchObject({ workUnitId: 'pr-51', dagLayer: 1 });
  });
});
