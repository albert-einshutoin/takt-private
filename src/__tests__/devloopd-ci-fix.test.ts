import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyCiFailure,
  collectCiFailures,
  runCiAutoRepairForPullRequest,
} from '../devloopd/ciRepair.js';
import type { DevloopCommandRunner } from '../devloopd/commandRunner.js';

interface Call {
  command: string;
  args: readonly string[];
  timeoutMs?: number;
}

function makeRunner(log: string): DevloopCommandRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    resolveCommand(command) {
      return command === 'gh' || command === 'git' || command === 'codex' ? `/mock/bin/${command}` : undefined;
    },
    async exec(command, args, options) {
      calls.push({ command, args, timeoutMs: options?.timeoutMs });
      if (command.endsWith('/gh') && args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 31,
            title: 'fix: automation change',
            body: 'Closes #55',
            headRefName: 'takt/issue-55',
            headRefOid: 'abc123',
            baseRepository: { nameWithOwner: 'owner/repo' },
            headRepository: { nameWithOwner: 'owner/repo' },
            labels: [],
          }),
          stderr: '',
        };
      }
      if (command.endsWith('/gh') && args[0] === 'pr' && args[1] === 'checks') {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              name: 'test',
              state: 'FAIL',
              bucket: 'fail',
              workflow: 'CI',
              link: 'https://github.com/owner/repo/actions/runs/123456/jobs/1',
              description: 'unit tests failed',
            },
          ]),
          stderr: '',
        };
      }
      if (command.endsWith('/gh') && args[0] === 'run' && args[1] === 'view') {
        return { exitCode: 0, stdout: log, stderr: '' };
      }
      if (command.endsWith('/gh') && args[0] === 'run' && args[1] === 'rerun') {
        return { exitCode: 0, stdout: 'rerun requested', stderr: '' };
      }
      if (command.endsWith('/gh') && args[0] === 'pr' && args[1] === 'diff') {
        return { exitCode: 0, stdout: 'src/devloopd/ciRepair.ts\nsrc/__tests__/devloopd-ci-fix.test.ts\n', stderr: '' };
      }
      return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
    },
  };
}

describe('devloopd CI repair loop', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-ci-fix-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(repoPath)) {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it.each([
    ['AssertionError: expected true received false', 'deterministic'],
    ['Resource not accessible by integration 403', 'auth_permission'],
    ['Test timed out after 30000ms', 'timeout'],
    ['ECONNRESET from npm registry 503', 'infra'],
    ['flaky test, please rerun', 'flaky'],
  ] as const)('classifies %s as %s', (log, kind) => {
    expect(classifyCiFailure(log)).toBe(kind);
  });

  it('collects failed GitHub check logs into ledger-compatible artifacts', async () => {
    const fake = makeRunner('AssertionError: expected true received false');

    const report = await collectCiFailures({
      pr: 31,
      headSha: 'abc123',
      repoPath,
      repo: 'owner/repo',
      runner: fake,
    });

    expect(report.state).toBe('failed');
    expect(report.failures[0]).toMatchObject({
      checkName: 'test',
      kind: 'deterministic',
      runId: '123456',
    });
    expect(readFileSync(join(repoPath, '.devloop', 'ledger.jsonl'), 'utf-8')).toContain('devloop_ci_failure_collected');
  });

  it('dry-runs deterministic CI repair through the scoped repair executor', async () => {
    const fake = makeRunner('AssertionError: expected true received false');

    const report = await runCiAutoRepairForPullRequest({
      pr: 31,
      repoPath,
      repo: 'owner/repo',
      runner: fake,
      dryRun: true,
      maxAttempts: 2,
    });

    expect(report.status).toBe('passed');
    expect(report.message).toContain('dry-run');
    expect(fake.calls.some((call) => call.command.endsWith('/git'))).toBe(false);
  });

  it('does not mutate code for infrastructure-only failures', async () => {
    const fake = makeRunner('ECONNRESET from registry 503 service unavailable');

    const report = await runCiAutoRepairForPullRequest({
      pr: 31,
      repoPath,
      repo: 'owner/repo',
      runner: fake,
      dryRun: true,
    });

    expect(report.status).toBe('skipped');
    expect(report.message).toContain('retry before code changes');
    expect(readFileSync(join(repoPath, '.devloop', 'ledger.jsonl'), 'utf-8')).toContain('devloop_ci_retry');
  });

  it('reruns transient CI failures with a bounded GitHub Actions rerun request', async () => {
    const fake = makeRunner('ECONNRESET from registry 503 service unavailable');

    const report = await runCiAutoRepairForPullRequest({
      pr: 31,
      repoPath,
      repo: 'owner/repo',
      runner: fake,
      now: new Date('2026-07-05T00:00:00.000Z'),
    });

    expect(report.status).toBe('skipped');
    expect(report.message).toContain('reran 1 transient CI run');
    const rerunCall = fake.calls.find((call) => call.args[0] === 'run' && call.args[1] === 'rerun');
    expect(rerunCall?.args).toEqual(['run', 'rerun', '123456', '--failed', '--repo', 'owner/repo']);
    expect(rerunCall?.timeoutMs).toBe(60_000);
    const ledger = readFileSync(join(repoPath, '.devloop', 'ledger.jsonl'), 'utf-8');
    expect(ledger).toContain('devloop_ci_rerun');
    expect(ledger).toContain('2026-07-05T00:15:00.000Z');
  });

  it('honors PR-head scoped CI retryAfter before collecting checks again', async () => {
    const fake = makeRunner('ECONNRESET from registry 503 service unavailable');

    await runCiAutoRepairForPullRequest({
      pr: 31,
      repoPath,
      repo: 'owner/repo',
      runner: fake,
      now: new Date('2026-07-05T00:00:00.000Z'),
    });
    fake.calls.length = 0;
    const blocked = await runCiAutoRepairForPullRequest({
      pr: 31,
      repoPath,
      repo: 'owner/repo',
      runner: fake,
      now: new Date('2026-07-05T00:05:00.000Z'),
    });

    expect(blocked.status).toBe('skipped');
    expect(blocked.message).toContain('CI retry backoff active');
    expect(fake.calls.some((call) => call.args[0] === 'pr' && call.args[1] === 'checks')).toBe(false);
  });

  it('blocks auth or permission failures for human/operator action', async () => {
    const fake = makeRunner('Resource not accessible by integration 403');

    const report = await runCiAutoRepairForPullRequest({
      pr: 31,
      repoPath,
      repo: 'owner/repo',
      runner: fake,
      dryRun: true,
    });

    expect(report.status).toBe('blocked');
    expect(report.message).toContain('operator');
  });
});
