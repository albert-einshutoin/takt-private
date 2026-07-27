import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DevloopCommandRunner } from '../devloopd/commandRunner.js';
import { DecisionStore } from '../devloopd/decisionStore.js';
import { readRawDevloopLedgerEvents } from '../devloopd/ledger.js';
import {
  automationActionRequiresDecision,
  attachAutomationDecisions,
  attachDagPlanToMergeQueuePullRequests,
  findCurrentHeadBlockingReview,
  findDuplicateIssueCoverage,
  parseAutomationPullRequests,
  prepareAutomationPullRequests,
  promotePullRequestAutoMerge,
  continuePullRequestAutomationStage,
  runDevloopAutomationStage,
  selectAutomationPullRequests,
  formatDevloopAutomationStageReport,
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

function makePreparationRunner(
  commentsByPr: Record<number, Array<{ body: string }>>,
): DevloopCommandRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveCommand(command) {
      return command === 'gh' ? '/mock/bin/gh' : undefined;
    },
    async exec(_command, args) {
      calls.push(args.join(' '));
      if (args[0] === 'api') {
        const prNumber = Number(/\/issues\/(\d+)\/comments$/u.exec(args[1] ?? '')?.[1]);
        return {
          exitCode: 0,
          stdout: JSON.stringify(commentsByPr[prNumber] ?? []),
          stderr: '',
        };
      }
      if (args.slice(0, 2).join(' ') === 'pr edit') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected gh args: ${args.join(' ')}` };
    },
  };
}

function makeProductPolicyPromotionRunner(): DevloopCommandRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveCommand(command) {
      return command === 'gh' ? '/mock/bin/gh' : undefined;
    },
    async exec(_command, args) {
      calls.push(args.join(' '));
      if (args.slice(0, 2).join(' ') === 'pr view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 77,
            title: 'change auth policy',
            body: 'Adjust authentication behavior.',
            headRefOid: '2123456789abcdef0123456789abcdef01234567',
            mergeStateStatus: 'CLEAN',
            changedFiles: 1,
            additions: 12,
            deletions: 2,
          }),
          stderr: '',
        };
      }
      if (args.slice(0, 2).join(' ') === 'pr diff' && args.includes('--name-only')) {
        return { exitCode: 0, stdout: 'src/routes/auth.ts\n', stderr: '' };
      }
      if (args.slice(0, 2).join(' ') === 'pr edit') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected gh args: ${args.join(' ')}` };
    },
  };
}

describe('devloopd PR automation orchestration', () => {
  it('continues only the exact PR and requires revalidation when its head changed', async () => {
    const calls: string[] = [];
    const runner: DevloopCommandRunner = {
      resolveCommand(command) {
        return command === 'gh' ? '/mock/bin/gh' : undefined;
      },
      async exec(_command, args) {
        calls.push(args.join(' '));
        if (args.slice(0, 2).join(' ') === 'pr view') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 42,
              headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            }),
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
      },
    };

    const report = await continuePullRequestAutomationStage({
      pr: 42,
      stage: 'pr-review',
      expectedHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      repoPath: '/repo',
      repo: 'owner/repo',
      runner,
    });

    expect(report).toMatchObject({
      passed: false,
      revalidationRequired: true,
      reasonCode: 'pr_head_changed',
    });
    expect(calls).toEqual([
      'pr view 42 --json number,title,body,headRefOid,mergeStateStatus,changedFiles,additions,deletions --repo owner/repo',
    ]);
    expect(calls.some((call) => call.startsWith('pr list'))).toBe(false);
  });
  it.each([
    ['checks failed', { type: 'ci-fix', status: 'blocked', stopRule: 'checks failed', message: 'checks failed' }],
    ['head mismatch', { type: 'merge-if-safe', status: 'blocked', stopRule: 'head mismatch', message: 'head mismatch' }],
    ['overlap serialization', { type: 'merge-queue', status: 'skipped', stopRule: 'overlap serialization', message: 'serialized' }],
    ['provider failure', { type: 'codex-review', status: 'failed', message: 'provider command failed' }],
    ['attempt budget', { type: 'ci-fix', status: 'blocked', stopRule: 'attempt budget exhausted', message: 'budget exhausted' }],
  ] as const)('does not turn the mechanical %s stop into a Decision', (_case, action) => {
    expect(automationActionRequiresDecision(action)).toBe(false);
  });

  it.each([
    { type: 'current-head-blocked', status: 'blocked', stopRule: 'Mergeable: NO', message: 'current review block' },
    { type: 'review-fix', status: 'blocked', stopRule: 'Unsafe or too broad', message: 'scope policy required' },
    { type: 'human-review-hold', status: 'blocked', stopRule: 'human review required', message: 'owner approval required' },
  ] as const)('turns explicit human policy stop $type into a Decision', (action) => {
    expect(automationActionRequiresDecision(action)).toBe(true);
  });

  it('fails closed when the evaluated human-review head moves before Decision attachment', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'takt-pr-decision-'));
    const calls: string[] = [];
    const listedHeadSha = '0123456789abcdef0123456789abcdef01234567';
    const currentHeadSha = '1123456789abcdef0123456789abcdef01234567';
    const runner: DevloopCommandRunner = {
      resolveCommand: (command) => command === 'gh' ? '/mock/bin/gh' : undefined,
      async exec(_command, args) {
        calls.push(args.join(' '));
        if (args.slice(0, 2).join(' ') === 'pr list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{
              number: 77,
              title: 'change public authentication policy',
              body: '',
              headRefName: 'takt/issue-77',
              headRefOid: listedHeadSha,
              isDraft: false,
              author: { login: 'dev' },
              labels: [{ name: 'human:review' }],
            }]),
            stderr: '',
          };
        }
        if (args.slice(0, 2).join(' ') === 'repo view') {
          return { exitCode: 0, stdout: 'owner/repo\n', stderr: '' };
        }
        if (args.slice(0, 2).join(' ') === 'pr view') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ number: 77, headRefOid: currentHeadSha }),
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
      },
    };

    const first = await runDevloopAutomationStage({
      stage: 'pr-review',
      repoPath,
      ledgerPath: 'ledger.jsonl',
      runner,
      env: { PATH: '/mock/bin' },
      dryRun: true,
    });
    const second = await runDevloopAutomationStage({
      stage: 'pr-review',
      repoPath,
      ledgerPath: 'ledger.jsonl',
      runner,
      env: { PATH: '/mock/bin' },
      dryRun: true,
    });
    const events = readRawDevloopLedgerEvents(join(repoPath, 'ledger.jsonl'));
    const requested = events.filter((event) => event.eventType === 'devloop_decision_requested');
    const states = events.filter((event) => event.eventType === 'devloop_automation_state');

    expect(first.actions[0]).toMatchObject({
      type: 'human-review-hold',
      pr: 77,
      status: 'failed',
      headSha: listedHeadSha,
      message: 'decision generation failed: head_changed',
    });
    expect(first.actions[0]?.decisionId).toBeUndefined();
    expect(second.actions[0]?.decisionId).toBeUndefined();
    expect(requested).toHaveLength(0);
    expect(first.passed).toBe(false);
    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({
        prNumber: 77,
        status: 'failed',
      }),
    ]));
    expect(formatDevloopAutomationStageReport(first)).toContain('head_changed');
    expect(calls.filter((call) => call.startsWith('repo view '))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith('pr view 77 '))).toHaveLength(2);
  });

  it('fails the stage without creating a Decision when current PR metadata is invalid', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'takt-pr-decision-invalid-'));
    const runner: DevloopCommandRunner = {
      resolveCommand: (command) => command === 'gh' ? '/mock/bin/gh' : undefined,
      async exec(_command, args) {
        if (args.slice(0, 2).join(' ') === 'pr list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{
              number: 77,
              title: 'change public authentication policy',
              body: '',
              headRefName: 'takt/issue-77',
              headRefOid: '0123456789abcdef0123456789abcdef01234567',
              isDraft: false,
              author: { login: 'dev' },
              labels: [{ name: 'human:review' }],
            }]),
            stderr: '',
          };
        }
        if (args.slice(0, 2).join(' ') === 'pr view') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ number: 77, headRefOid: 'short-head' }),
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected metadata command' };
      },
    };

    const report = await runDevloopAutomationStage({
      stage: 'pr-review',
      repoPath,
      ledgerPath: 'ledger.jsonl',
      repo: 'owner/repo',
      runner,
      env: { PATH: '/mock/bin' },
      dryRun: true,
    });
    const events = readRawDevloopLedgerEvents(join(repoPath, 'ledger.jsonl'));

    expect(report.actions[0]).toMatchObject({
      type: 'human-review-hold',
      status: 'failed',
    });
    expect(report.passed).toBe(false);
    expect(report.actions[0]?.decisionId).toBeUndefined();
    expect(report.actions[0]?.message).toContain('decision generation failed');
    expect(events.some((event) => event.eventType === 'devloop_decision_requested')).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'devloop_automation_state',
        status: 'failed',
        prNumber: 77,
      }),
    ]));
    expect(formatDevloopAutomationStageReport(report)).toContain('failed');
  });

  it('resolves repository metadata once for multiple PR decisions in one stage', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'takt-pr-decision-batch-'));
    const calls: string[] = [];
    const runner: DevloopCommandRunner = {
      resolveCommand: (command) => command === 'gh' ? '/mock/bin/gh' : undefined,
      async exec(_command, args) {
        calls.push(args.join(' '));
        if (args.slice(0, 2).join(' ') === 'pr list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([77, 78].map((number) => ({
              number,
              title: `policy change ${number}`,
              body: '',
              headRefName: `takt/issue-${number}`,
              headRefOid: `${number === 77 ? '0' : '1'}123456789abcdef0123456789abcdef01234567`,
              isDraft: false,
              author: { login: 'dev' },
              labels: [{ name: 'human:review' }],
            }))),
            stderr: '',
          };
        }
        if (args.slice(0, 2).join(' ') === 'repo view') {
          return { exitCode: 0, stdout: 'owner/repo\n', stderr: '' };
        }
        if (args.slice(0, 2).join(' ') === 'pr view') {
          const number = Number(args[2]);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number,
              headRefOid: `${number === 77 ? '0' : '1'}123456789abcdef0123456789abcdef01234567`,
            }),
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
      },
    };

    const report = await runDevloopAutomationStage({
      stage: 'pr-review',
      repoPath,
      ledgerPath: 'ledger.jsonl',
      runner,
      env: { PATH: '/mock/bin' },
      dryRun: true,
    });

    expect(report.actions.map((action) => action.decisionId)).toEqual([
      expect.stringMatching(/^dec_[a-f0-9]{64}$/u),
      expect.stringMatching(/^dec_[a-f0-9]{64}$/u),
    ]);
    expect(calls.filter((call) => call.startsWith('repo view '))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('pr view '))).toHaveLength(2);
  });

  it('loads the Decision projection index once per stage', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'takt-pr-decision-index-'));
    const listSpy = vi.spyOn(DecisionStore.prototype, 'list');
    const headSha = '0123456789abcdef0123456789abcdef01234567';
    const runner: DevloopCommandRunner = {
      resolveCommand: (command) => command === 'gh' ? '/mock/bin/gh' : undefined,
      async exec(_command, args) {
        if (args.slice(0, 2).join(' ') === 'pr list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{
              number: 77,
              title: 'policy change',
              body: '',
              headRefName: 'takt/issue-77',
              headRefOid: headSha,
              isDraft: false,
              author: { login: 'dev' },
              labels: [{ name: 'human:review' }],
            }]),
            stderr: '',
          };
        }
        if (args.slice(0, 2).join(' ') === 'pr view') {
          return { exitCode: 0, stdout: JSON.stringify({ number: 77, headRefOid: headSha }), stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
      },
    };

    await runDevloopAutomationStage({
      stage: 'pr-review',
      repoPath,
      repo: 'owner/repo',
      ledgerPath: 'ledger.jsonl',
      runner,
      env: { PATH: '/mock/bin' },
      dryRun: true,
    });

    expect(listSpy).toHaveBeenCalledTimes(1);
    listSpy.mockRestore();
  });

  it('correlates every same-guard action to one aggregate Decision', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'takt-pr-decision-group-'));
    const headSha = '0123456789abcdef0123456789abcdef01234567';
    const movedHeadSha = '1123456789abcdef0123456789abcdef01234567';
    const store = new DecisionStore(repoPath, 'ledger.jsonl');
    const runner: DevloopCommandRunner = {
      resolveCommand: (command) => command === 'gh' ? '/mock/bin/gh' : undefined,
      async exec(_command, args) {
        if (args.slice(0, 2).join(' ') === 'pr view') {
          return { exitCode: 0, stdout: JSON.stringify({ number: 77, headRefOid: headSha }), stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
      },
    };
    const actions = [
      {
        type: 'human-review-hold',
        status: 'blocked' as const,
        pr: 77,
        headSha,
        stopRule: 'human review required' as const,
        message: 'Product owner approval is missing.',
      },
      {
        type: 'current-head-blocked',
        status: 'blocked' as const,
        pr: 77,
        headSha,
        stopRule: 'Mergeable: NO' as const,
        message: 'Security review remains blocked.',
      },
    ];

    const report = await attachAutomationDecisions({
      store,
      report: {
        passed: true,
        stage: 'pr-review',
        message: 'two blockers',
        actions,
      },
      prs: [{
        number: 77,
        title: 'policy change',
        body: '',
        headRefName: 'takt/issue-77',
        headRefOid: headSha,
        isDraft: false,
        authorLogin: 'dev',
        labels: [],
      }],
      repoPath,
      repository: 'owner/repo',
      env: { PATH: '/mock/bin' },
      runner,
    });
    const events = readRawDevloopLedgerEvents(join(repoPath, 'ledger.jsonl'));
    const requested = events.filter((event) => event.eventType === 'devloop_decision_requested');

    expect(report.actions[0]?.decisionId).toBe(report.actions[1]?.decisionId);
    expect(requested).toHaveLength(1);
    expect(JSON.stringify(requested[0])).toContain('Product owner approval is missing.');
    expect(JSON.stringify(requested[0])).toContain('Security review remains blocked.');
    expect(requested[0]).toMatchObject({
      request: {
        subject: { headSha },
        resumeGuard: { expectedHeadSha: headSha },
      },
    });

    const inconsistent = await attachAutomationDecisions({
      store,
      report: {
        passed: true,
        stage: 'pr-review',
        message: 'inconsistent evaluated heads',
        actions: [
          actions[0]!,
          { ...actions[1]!, headSha: movedHeadSha },
        ],
      },
      prs: [{
        number: 77,
        title: 'policy change',
        body: '',
        headRefName: 'takt/issue-77',
        headRefOid: headSha,
        isDraft: false,
        authorLogin: 'dev',
        labels: [],
      }],
      repoPath,
      repository: 'owner/repo',
      env: { PATH: '/mock/bin' },
      runner,
    });

    expect(inconsistent.passed).toBe(false);
    expect(inconsistent.actions).toEqual([
      expect.objectContaining({
        status: 'failed',
        message: 'decision generation failed: head_changed',
      }),
      expect.objectContaining({
        status: 'failed',
        message: 'decision generation failed: head_changed',
      }),
    ]);
    expect(inconsistent.actions.every((action) => action.decisionId === undefined)).toBe(true);
    expect(readRawDevloopLedgerEvents(join(repoPath, 'ledger.jsonl'))
      .filter((event) => event.eventType === 'devloop_decision_requested')).toHaveLength(1);
  });

  it('clears a stale Decision id when current-head metadata validation fails', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'takt-pr-decision-stale-id-'));
    const runner: DevloopCommandRunner = {
      resolveCommand: (command) => command === 'gh' ? '/mock/bin/gh' : undefined,
      async exec(_command, args) {
        if (args.slice(0, 2).join(' ') === 'pr view') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ number: 77, headRefOid: 'short-head' }),
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
      },
    };

    const report = await attachAutomationDecisions({
      store: new DecisionStore(repoPath, 'ledger.jsonl'),
      report: {
        passed: true,
        stage: 'pr-review',
        message: 'blocked',
        actions: [{
          type: 'human-review-hold',
          status: 'blocked',
          pr: 77,
          decisionId: 'dec_stale',
          headSha: '0123456789abcdef0123456789abcdef01234567',
          stopRule: 'human review required',
          message: 'Product owner approval is missing.',
        }],
      },
      prs: [{
        number: 77,
        title: 'policy change',
        body: '',
        headRefName: 'takt/issue-77',
        headRefOid: '0123456789abcdef0123456789abcdef01234567',
        isDraft: false,
        authorLogin: 'dev',
        labels: [],
      }],
      repoPath,
      repository: 'owner/repo',
      env: { PATH: '/mock/bin' },
      runner,
    });

    expect(report.actions[0]).toMatchObject({
      status: 'failed',
      message: 'decision generation failed: pr_head_unavailable',
      stopRule: 'human review required',
    });
    expect(report.actions[0]?.decisionId).toBeUndefined();
  });

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
      {
        number: 13,
        title: 'blocked',
        body: '',
        headRefName: 'takt/issue-43',
        headRefOid: 'bcd234',
        isDraft: false,
        author: { login: 'dev' },
        labels: [{ name: 'agent:blocked' }],
      },
      {
        number: 14,
        title: 'human review',
        body: '',
        headRefName: 'takt/issue-44',
        headRefOid: 'cde345',
        isDraft: false,
        author: { login: 'dev' },
        labels: [{ name: 'human:review' }],
      },
    ]));

    expect(selectAutomationPullRequests(prs).map((pr) => pr.number)).toEqual([10]);
    expect(selectAutomationPullRequests(prs, {
      includeBlocked: true,
      includeHumanReview: true,
    }).map((pr) => pr.number)).toEqual([10, 13, 14]);
  });

  it('re-enters stale blocked PRs after the head has moved', async () => {
    const runner = makePreparationRunner({
      20: [{
        body: formatReviewGateComment({
          reviewer: 'agy',
          decision: 'blocked',
          headSha: 'old123',
          body: 'Mergeable: NO\nReason: stale blocker',
        }),
      }],
    });

    const prepared = await prepareAutomationPullRequests({
      prs: [{
        number: 20,
        title: 'fix stale review block',
        body: '',
        headRefName: 'takt/issue-20',
        headRefOid: 'new456',
        isDraft: false,
        authorLogin: 'dev',
        labels: ['agent:blocked'],
      }],
      repoPath: '/repo',
      repo: 'owner/repo',
      env: { PATH: '/mock/bin' },
      runner,
    });

    expect(prepared.prs.map((pr) => pr.number)).toEqual([20]);
    expect(prepared.actions).toContainEqual(expect.objectContaining({
      type: 'stale-block-unlock',
      status: 'passed',
      pr: 20,
    }));
    expect(runner.calls).toContain('pr edit 20 --remove-label agent:blocked --repo owner/repo');
  });

  it('keeps current-head blocked PRs out of review retry', async () => {
    const runner = makePreparationRunner({
      21: [{
        body: formatReviewGateComment({
          reviewer: 'codex',
          decision: 'blocked',
          headSha: 'head789',
          body: 'Codex-Human-Review: BLOCKED\nReason: still unsafe',
        }),
      }],
    });

    const prepared = await prepareAutomationPullRequests({
      prs: [{
        number: 21,
        title: 'still blocked',
        body: '',
        headRefName: 'takt/issue-21',
        headRefOid: 'head789',
        isDraft: false,
        authorLogin: 'dev',
        labels: ['agent:blocked'],
      }],
      repoPath: '/repo',
      repo: 'owner/repo',
      env: { PATH: '/mock/bin' },
      runner,
    });

    expect(prepared.prs).toEqual([]);
    expect(prepared.actions).toContainEqual(expect.objectContaining({
      type: 'current-head-blocked',
      status: 'blocked',
      pr: 21,
      headSha: 'head789',
      stopRule: 'Mergeable: NO',
    }));
    expect(runner.calls.some((call) => call.includes('--remove-label agent:blocked'))).toBe(false);
  });

  it('holds human review PRs outside automation stages', async () => {
    const runner = makePreparationRunner({});

    const prepared = await prepareAutomationPullRequests({
      prs: [{
        number: 22,
        title: 'product direction change',
        body: '',
        headRefName: 'takt/issue-22',
        headRefOid: 'human123',
        isDraft: false,
        authorLogin: 'dev',
        labels: ['human:review'],
      }],
      repoPath: '/repo',
      repo: 'owner/repo',
      env: { PATH: '/mock/bin' },
      runner,
    });

    expect(prepared.prs).toEqual([]);
    expect(prepared.actions).toContainEqual(expect.objectContaining({
      type: 'human-review-hold',
      status: 'blocked',
      pr: 22,
      headSha: 'human123',
      stopRule: 'human review required',
    }));
    expect(runner.calls).toEqual([]);
  });

  it('marks product-policy PRs with human:review before leaving automation', async () => {
    const runner = makeProductPolicyPromotionRunner();

    const action = await promotePullRequestAutoMerge({
      pr: 77,
      repoPath: '/repo',
      repo: 'owner/repo',
      env: { PATH: '/mock/bin' },
      runner,
    });

    expect(action).toMatchObject({
      type: 'promote-auto-merge',
      status: 'blocked',
      pr: 77,
      headSha: '2123456789abcdef0123456789abcdef01234567',
      stopRule: 'human review required',
    });
    expect(action.message).toContain('human:review');
    expect(runner.calls).toContain('pr edit 77 --add-label human:review --repo owner/repo');
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
