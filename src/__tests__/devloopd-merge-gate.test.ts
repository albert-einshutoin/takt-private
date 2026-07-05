import { describe, expect, it } from 'vitest';
import {
  evaluateMergeGate,
  formatMergeGateReport,
  mergeIfSafe,
  type DevloopMergeCommandRunner,
} from '../devloopd/mergeGate.js';

interface ExecCall {
  command: string;
  args: readonly string[];
  timeoutMs?: number;
}

function makeRunner(options: {
  prView?: Record<string, unknown>;
  diff?: string;
  checksExitCode?: number;
  checksStdout?: string;
} = {}): DevloopMergeCommandRunner & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const prView = options.prView ?? {
    url: 'https://github.com/owner/repo/pull/12',
    number: 12,
    headRefOid: 'abc123',
    labels: [{ name: 'agent:auto-merge' }],
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    isDraft: false,
    changedFiles: 2,
    additions: 20,
    deletions: 5,
  };

  return {
    calls,
    resolveCommand(command) {
      return command === 'gh' ? '/mock/bin/gh' : undefined;
    },
    async exec(command, args, execOptions) {
      calls.push({ command, args, timeoutMs: execOptions?.timeoutMs });
      if (args[0] === 'pr' && args[1] === 'view') {
        return { exitCode: 0, stdout: JSON.stringify(prView), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'diff') {
        if (args.includes('--name-only')) {
          return { exitCode: 0, stdout: options.diff ?? 'src/app.ts\nsrc/app.test.ts\n', stderr: '' };
        }
        return { exitCode: 0, stdout: options.diff ?? 'diff --git a/src/app.ts b/src/app.ts\n@@\n+const value = 1;\n', stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'checks') {
        return { exitCode: options.checksExitCode ?? 0, stdout: options.checksStdout ?? 'All checks were successful', stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
    },
  };
}

describe('devloopd merge gate', () => {
  it('allows safe PRs and invokes gh merge with match-head-commit', async () => {
    const runner = makeRunner();

    const report = await mergeIfSafe({
      pr: '12',
      repoPath: '/repo',
      expectedHeadSha: 'abc123',
      runner,
    });

    expect(report.result).toBe('SAFE_TO_MERGE');
    expect(runner.calls.at(-1)).toMatchObject({
      command: '/mock/bin/gh',
      args: ['pr', 'merge', '12', '--auto', '--squash', '--delete-branch', '--match-head-commit', 'abc123'],
      timeoutMs: 60_000,
    });
    expect(formatMergeGateReport(report)).toContain('SAFE_TO_MERGE');
  });

  it('denies forbidden paths before attempting merge', async () => {
    const runner = makeRunner({ diff: '.github/workflows/ci.yml\nsrc/app.ts\n' });

    const report = await mergeIfSafe({ pr: '12', repoPath: '/repo', runner });

    expect(report.result).toBe('POLICY_DENY');
    expect(formatMergeGateReport(report)).toContain('forbidden path touched');
    expect(runner.calls.some((call) => call.args[1] === 'merge')).toBe(false);
  });

  it('denies root-level sensitive files and nested human-review paths before attempting merge', async () => {
    const runner = makeRunner({ diff: '.env\nsecret.txt\nsrc/middleware/auth.ts\n' });

    const report = await mergeIfSafe({ pr: '12', repoPath: '/repo', runner });

    expect(report.result).toBe('POLICY_DENY');
    expect(formatMergeGateReport(report)).toContain('forbidden path touched: .env');
    expect(formatMergeGateReport(report)).toContain('forbidden path touched: secret.txt');
    expect(runner.calls.some((call) => call.args[1] === 'merge')).toBe(false);
  });

  it('treats leading globstar patterns as matching repository root files', () => {
    const report = evaluateMergeGate({
      pr: {
        url: 'https://github.com/owner/repo/pull/12',
        number: 12,
        headRefOid: 'abc123',
        labels: ['agent:auto-merge'],
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        isDraft: false,
        changedFiles: 1,
        additions: 1,
        deletions: 0,
      },
      changedPaths: ['.env.local'],
      checksPassed: true,
    });

    expect(report.result).toBe('POLICY_DENY');
    expect(report.reasons).toContain('forbidden path touched: .env.local (**/.env*)');
  });

  it('routes review-required decisions to human review instead of request changes', () => {
    const report = evaluateMergeGate({
      pr: {
        url: 'https://github.com/owner/repo/pull/12',
        number: 12,
        headRefOid: 'abc123',
        labels: ['agent:auto-merge'],
        reviewDecision: 'REVIEW_REQUIRED',
        mergeStateStatus: 'CLEAN',
        isDraft: false,
        changedFiles: 1,
        additions: 1,
        deletions: 0,
      },
      changedPaths: ['src/app.ts'],
      checksPassed: true,
    });

    expect(report.result).toBe('HUMAN_REVIEW_REQUIRED');
    expect(report.reasons).toContain('review decision is REVIEW_REQUIRED');
  });

  it('checks GitHub status without watch mode so merge gate cannot hang indefinitely', async () => {
    const runner = makeRunner();

    await mergeIfSafe({ pr: '12', repoPath: '/repo', runner });

    const checksCall = runner.calls.find((call) => call.args[0] === 'pr' && call.args[1] === 'checks');
    expect(checksCall?.args).toEqual(['pr', 'checks', '12']);
    expect(checksCall?.timeoutMs).toBe(60_000);
  });

  it('requires the auto-merge label', async () => {
    const runner = makeRunner({ prView: {
      url: 'https://github.com/owner/repo/pull/12',
      number: 12,
      headRefOid: 'abc123',
      labels: [],
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      isDraft: false,
      changedFiles: 2,
      additions: 20,
      deletions: 5,
    } });

    const report = await mergeIfSafe({ pr: '12', repoPath: '/repo', runner });

    expect(report.result).toBe('HUMAN_REVIEW_REQUIRED');
    expect(formatMergeGateReport(report)).toContain('missing required label: agent:auto-merge');
  });

  it('requires GitHub checks to pass', async () => {
    const runner = makeRunner({ checksExitCode: 1, checksStdout: 'test failing' });

    const report = await mergeIfSafe({ pr: '12', repoPath: '/repo', runner });

    expect(report.result).toBe('CHECKS_FAILED');
    expect(formatMergeGateReport(report)).toContain('GitHub checks did not pass');
  });

  it('requires expected head SHA to match when provided', async () => {
    const runner = makeRunner();

    const report = await mergeIfSafe({
      pr: '12',
      repoPath: '/repo',
      expectedHeadSha: 'different',
      runner,
    });

    expect(report.result).toBe('POLICY_DENY');
    expect(formatMergeGateReport(report)).toContain('head SHA mismatch');
  });

  it('evaluates policy without executing merge', () => {
    const report = evaluateMergeGate({
      pr: {
        url: 'https://github.com/owner/repo/pull/12',
        number: 12,
        headRefOid: 'abc123',
        labels: ['agent:auto-merge'],
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        isDraft: false,
        changedFiles: 13,
        additions: 10,
        deletions: 0,
      },
      changedPaths: ['src/app.ts'],
      checksPassed: true,
    });

    expect(report.result).toBe('HUMAN_REVIEW_REQUIRED');
    expect(report.reasons).toContain('changed file count exceeds policy: 13 > 12');
  });

  it('allows non-product-policy package metadata changes after dual-LLM approval', () => {
    const report = evaluateMergeGate({
      pr: {
        url: 'https://github.com/owner/repo/pull/12',
        number: 12,
        headRefOid: 'abc123',
        labels: ['agent:auto-merge'],
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        isDraft: false,
        changedFiles: 2,
        additions: 40,
        deletions: 20,
      },
      changedPaths: ['package.json', 'package-lock.json'],
      checksPassed: true,
      dualLlmApproval: {
        approved: true,
        headSha: 'abc123',
        reasons: [],
        reviewers: {
          agy: { state: 'approved', headSha: 'abc123' },
          codex: { state: 'approved', headSha: 'abc123' },
        },
      },
    });

    expect(report.result).toBe('SAFE_TO_MERGE');
    expect(report.productPolicyImpact?.impact).toBe('implementation');
  });

  it('does not let dual-LLM approval override product-policy impact', () => {
    const report = evaluateMergeGate({
      pr: {
        url: 'https://github.com/owner/repo/pull/12',
        number: 12,
        headRefOid: 'abc123',
        labels: ['agent:auto-merge'],
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        isDraft: false,
        changedFiles: 1,
        additions: 12,
        deletions: 2,
      },
      changedPaths: ['src/routes/auth.ts'],
      checksPassed: true,
      dualLlmApproval: {
        approved: true,
        headSha: 'abc123',
        reasons: [],
        reviewers: {
          agy: { state: 'approved', headSha: 'abc123' },
          codex: { state: 'approved', headSha: 'abc123' },
        },
      },
    });

    expect(report.result).toBe('HUMAN_REVIEW_REQUIRED');
    expect(report.reasons.join('\n')).toContain('product-policy impact');
  });

  it('does not let dual-LLM approval override semantic diff product-policy impact', () => {
    const report = evaluateMergeGate({
      pr: {
        url: 'https://github.com/owner/repo/pull/12',
        number: 12,
        headRefOid: 'abc123',
        labels: ['agent:auto-merge'],
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        isDraft: false,
        changedFiles: 1,
        additions: 3,
        deletions: 1,
      },
      changedPaths: ['src/settings.ts'],
      diff: 'diff --git a/src/settings.ts b/src/settings.ts\n@@\n+enableBillingPlanChange();',
      checksPassed: true,
      dualLlmApproval: {
        approved: true,
        headSha: 'abc123',
        reasons: [],
        reviewers: {
          agy: { state: 'approved', headSha: 'abc123' },
          codex: { state: 'approved', headSha: 'abc123' },
        },
      },
    });

    expect(report.result).toBe('HUMAN_REVIEW_REQUIRED');
    expect(report.productPolicyImpact?.evidenceHunks).toHaveLength(1);
  });
});
