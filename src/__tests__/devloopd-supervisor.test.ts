import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatDevloopStartReport,
  startDevloop,
  type DevloopStartDependencies,
} from '../devloopd/supervisor.js';
import type { IssueCandidate, IssueScanReport } from '../devloopd/issueScanner.js';

function candidate(input: Partial<IssueCandidate> & { number: number; mode: IssueCandidate['mode'] }): IssueCandidate {
  return {
    number: input.number,
    title: input.title ?? `Issue ${input.number}`,
    url: input.url ?? `https://github.com/owner/repo/issues/${input.number}`,
    labels: input.labels ?? ['agent:ready'],
    updatedAt: input.updatedAt ?? '2026-06-24T00:00:00Z',
    comments: input.comments ?? 0,
    mechanicalRisk: input.mechanicalRisk ?? (input.mode === 'auto_merge_candidate' ? 'low' : 'medium'),
    mode: input.mode,
    reason: input.reason ?? 'test candidate',
  };
}

function makeScan(candidates: IssueCandidate[]): IssueScanReport {
  return {
    passed: true,
    message: `Found ${candidates.length} candidate issue(s)`,
    candidates,
    skipped: [],
  };
}

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'takt-devloopd-supervisor-'));
}

function writeRunningRun(repoPath: string, slug: string): void {
  const runDir = join(repoPath, '.takt', 'runs', slug);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    task: 'Running task',
    workflow: 'subscription-devloop',
    runSlug: slug,
    runRoot: `.takt/runs/${slug}`,
    reportDirectory: `.takt/runs/${slug}/reports`,
    contextDirectory: `.takt/runs/${slug}/context`,
    logsDirectory: `.takt/runs/${slug}/logs`,
    status: 'running',
    startTime: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:30:00.000Z',
  }), 'utf-8');
}

describe('devloopd supervisor', () => {
  it('runs one safest issue and imports the latest TAKT run', async () => {
    const calls: string[] = [];
    const dependencies: DevloopStartDependencies = {
      async scanIssues(options) {
        calls.push(`scan:${options.repo}`);
        return makeScan([
          candidate({ number: 200, mode: 'auto_pr_only', mechanicalRisk: 'medium' }),
          candidate({ number: 123, mode: 'auto_merge_candidate', mechanicalRisk: 'low' }),
        ]);
      },
      async runDevloopIssue(options) {
        calls.push(`run:${options.issue}:${options.workflow}`);
        return { passed: true, message: 'TAKT issue pipeline completed' };
      },
      importTaktRun(options) {
        calls.push(`import:${options.issue}`);
        return {
          passed: true,
          message: 'Imported TAKT run run_123',
          runSlug: 'run_123',
          ledgerPath: '/repo/.devloop/ledger.jsonl',
        };
      },
    };

    const report = await startDevloop({
      repoPath: '/repo',
      repo: 'owner/repo',
      workflow: 'workflows/subscription-devloop.yaml',
      once: true,
      dependencies,
    });

    expect(report.passed).toBe(true);
    expect(report.selected.map((item) => item.number)).toEqual([123]);
    expect(calls).toEqual([
      'scan:owner/repo',
      'run:123:workflows/subscription-devloop.yaml',
      'import:123',
    ]);
    expect(formatDevloopStartReport(report)).toContain('#123');
  });

  it('does not start TAKT when the issue scan fails', async () => {
    const calls: string[] = [];
    const dependencies: DevloopStartDependencies = {
      async scanIssues() {
        calls.push('scan');
        return { passed: false, message: 'gh issue list failed', candidates: [], skipped: [] };
      },
      async runDevloopIssue() {
        calls.push('run');
        return { passed: true, message: 'unexpected' };
      },
      importTaktRun() {
        calls.push('import');
        return { passed: true, message: 'unexpected', ledgerPath: '/repo/.devloop/ledger.jsonl' };
      },
    };

    const report = await startDevloop({ repoPath: '/repo', once: true, dependencies });

    expect(report.passed).toBe(false);
    expect(report.message).toContain('issue scan failed');
    expect(calls).toEqual(['scan']);
  });

  it('does not import when the TAKT issue run fails', async () => {
    const calls: string[] = [];
    const dependencies: DevloopStartDependencies = {
      async scanIssues() {
        calls.push('scan');
        return makeScan([candidate({ number: 123, mode: 'auto_pr_only' })]);
      },
      async runDevloopIssue() {
        calls.push('run');
        return { passed: false, message: 'subscription-only doctor failed' };
      },
      importTaktRun() {
        calls.push('import');
        return { passed: true, message: 'unexpected', ledgerPath: '/repo/.devloop/ledger.jsonl' };
      },
    };

    const report = await startDevloop({ repoPath: '/repo', once: true, dependencies });

    expect(report.passed).toBe(false);
    expect(report.runs[0]?.importReport).toBeUndefined();
    expect(calls).toEqual(['scan', 'run']);
  });

  it('runs daemon cycles without requiring --once', async () => {
    const calls: string[] = [];
    const dependencies: DevloopStartDependencies = {
      async scanIssues() {
        calls.push('scan');
        return makeScan([]);
      },
      async runDevloopIssue() {
        throw new Error('should not run');
      },
      importTaktRun() {
        throw new Error('should not import');
      },
    };

    const report = await startDevloop({
      repoPath: '/repo',
      maxCycles: 2,
      sleep: async (milliseconds) => {
        calls.push(`sleep:${milliseconds}`);
      },
      dependencies,
    });

    expect(report.passed).toBe(true);
    expect(report.message).toContain('daemon stopped after 2 cycle(s)');
    expect(report.cycles).toHaveLength(2);
    expect(calls).toEqual(['scan', 'sleep:60000', 'scan']);
  });

  it('does not scan issues when the active run limit is reached', async () => {
    const repoPath = makeTempRepo();
    writeRunningRun(repoPath, 'run-active');
    const dependencies: DevloopStartDependencies = {
      async scanIssues() {
        throw new Error('should not scan');
      },
      async runDevloopIssue() {
        throw new Error('should not run');
      },
      importTaktRun() {
        throw new Error('should not import');
      },
    };

    try {
      const report = await startDevloop({ repoPath, once: true, dependencies });

      expect(report.passed).toBe(false);
      expect(report.message).toContain('active run limit reached');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('uses scan retry-after hints before the next daemon cycle', async () => {
    const calls: string[] = [];
    const dependencies: DevloopStartDependencies = {
      async scanIssues() {
        calls.push('scan');
        return {
          passed: false,
          message: 'gh issue list rate limited',
          candidates: [],
          skipped: [],
          failureKind: 'rate_limited',
          retryAfterSeconds: 45,
        };
      },
      async runDevloopIssue() {
        throw new Error('should not run');
      },
      importTaktRun() {
        throw new Error('should not import');
      },
    };

    const report = await startDevloop({
      repoPath: '/repo',
      maxCycles: 2,
      sleep: async (milliseconds) => {
        calls.push(`sleep:${milliseconds}`);
      },
      dependencies,
    });

    expect(report.passed).toBe(true);
    expect(calls).toEqual(['scan', 'sleep:45000', 'scan']);
  });
});
