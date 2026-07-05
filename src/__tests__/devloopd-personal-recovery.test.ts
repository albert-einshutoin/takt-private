import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatPersonalRecoveryReport,
  runPersonalRecovery,
} from '../devloopd/personalRecovery.js';
import { resolvePersonalLifecyclePaths } from '../devloopd/personalLifecycle.js';

const cleanupDirs = new Set<string>();

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-personal-recovery-'));
  cleanupDirs.add(dir);
  return dir;
}

function writeRunMeta(repoPath: string, slug: string, overrides: Record<string, unknown>): string {
  const runDir = join(repoPath, '.takt', 'runs', slug);
  mkdirSync(runDir, { recursive: true });
  const metaPath = join(runDir, 'meta.json');
  writeFileSync(metaPath, JSON.stringify({
    task: `Task ${slug}`,
    workflow: 'subscription-devloop',
    runSlug: slug,
    runRoot: `.takt/runs/${slug}`,
    reportDirectory: `.takt/runs/${slug}/reports`,
    contextDirectory: `.takt/runs/${slug}/context`,
    logsDirectory: `.takt/runs/${slug}/logs`,
    status: 'running',
    startTime: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    currentStep: 'implement',
    ...overrides,
  }, null, 2), 'utf-8');
  return metaPath;
}

function writeLedger(repoPath: string, events: unknown[]): void {
  const ledgerDir = join(repoPath, '.devloop');
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, 'ledger.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'), 'utf-8');
}

function touchOld(filePath: string): void {
  const old = new Date('2026-07-06T00:00:00.000Z');
  utimesSync(filePath, old, old);
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describe('devloopd personal recovery', () => {
  it('dry-runs stale runs while preserving active runs', () => {
    const repoPath = makeTempRepo();
    writeRunMeta(repoPath, 'run-stale', { updatedAt: '2026-07-06T00:00:00.000Z' });
    writeRunMeta(repoPath, 'run-active', { updatedAt: '2026-07-06T02:50:00.000Z' });

    const report = runPersonalRecovery({
      repoPath,
      apply: false,
      staleAfterMinutes: 60,
      now: new Date('2026-07-06T03:00:00.000Z'),
    });

    expect(report.passed).toBe(true);
    expect(report.changed).toBe(false);
    expect(report.actions).toContainEqual(expect.objectContaining({
      status: 'would_change',
      name: 'stale run run-stale',
    }));
    expect(report.actions).toContainEqual(expect.objectContaining({
      status: 'skipped',
      name: 'active run run-active',
    }));
    expect(formatPersonalRecoveryReport(report)).toContain('devloopd recover-stale passed');
  });

  it('apply marks stale runs aborted without deleting run artifacts', () => {
    const repoPath = makeTempRepo();
    const metaPath = writeRunMeta(repoPath, 'run-stale', { updatedAt: '2026-07-06T00:00:00.000Z' });

    const report = runPersonalRecovery({
      repoPath,
      apply: true,
      staleAfterMinutes: 60,
      now: new Date('2026-07-06T03:00:00.000Z'),
    });

    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { status?: string; endTime?: string; recoveryReason?: string };
    expect(report.changed).toBe(true);
    expect(existsSync(join(repoPath, '.takt', 'runs', 'run-stale'))).toBe(true);
    expect(meta.status).toBe('aborted');
    expect(meta.endTime).toBe('2026-07-06T03:00:00.000Z');
    expect(meta.recoveryReason).toBe('stale active run recovered by devloopd recover-stale');
  });

  it('removes stale lock files but preserves recent locks', () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, '.devloop'), { recursive: true });
    const staleLock = join(repoPath, '.devloop', 'ledger.jsonl.lock');
    const recentLock = join(repoPath, '.devloop', 'fresh.lock');
    writeFileSync(staleLock, '{}', 'utf-8');
    writeFileSync(recentLock, '{}', 'utf-8');
    touchOld(staleLock);
    const now = new Date('2026-07-06T03:00:00.000Z');
    utimesSync(recentLock, now, now);

    const report = runPersonalRecovery({
      repoPath,
      apply: true,
      lockStaleMinutes: 60,
      now,
    });

    expect(report.actions).toContainEqual(expect.objectContaining({
      status: 'changed',
      name: 'stale lock',
      path: staleLock,
    }));
    expect(existsSync(staleLock)).toBe(false);
    expect(existsSync(recentLock)).toBe(true);
  });

  it('reports retryAfter windows without mutating the ledger', () => {
    const repoPath = makeTempRepo();
    writeLedger(repoPath, [
      {
        eventType: 'devloop_issue_scout',
        retryAfter: '2026-07-06T00:30:00.000Z',
      },
      {
        eventType: 'devloop_ci_retry',
        retryAfter: '2026-07-06T04:00:00.000Z',
      },
    ]);

    const report = runPersonalRecovery({
      repoPath,
      apply: true,
      now: new Date('2026-07-06T03:00:00.000Z'),
    });

    expect(report.actions).toContainEqual(expect.objectContaining({
      status: 'exists',
      name: 'expired retryAfter',
    }));
    expect(report.actions).toContainEqual(expect.objectContaining({
      status: 'skipped',
      name: 'active retryAfter',
    }));
    expect(readFileSync(join(repoPath, '.devloop', 'ledger.jsonl'), 'utf-8')).toContain('2026-07-06T00:30:00.000Z');
  });

  it('clears dead daemon metadata and prunes abandoned non-git worktree directories', () => {
    const repoPath = makeTempRepo();
    const lifecycle = resolvePersonalLifecyclePaths(repoPath);
    mkdirSync(lifecycle.stateDir, { recursive: true });
    writeFileSync(lifecycle.statePath, JSON.stringify({
      version: 1,
      pid: 999999,
      startedAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
      repoPath,
      command: 'devloopd start',
      status: 'running',
      cycleCount: 1,
    }), 'utf-8');
    const worktreeDir = join(repoPath, '.takt', 'worktrees', 'old-temp');
    mkdirSync(worktreeDir, { recursive: true });
    touchOld(worktreeDir);

    const report = runPersonalRecovery({
      repoPath,
      apply: true,
      worktreeStaleMinutes: 60,
      now: new Date('2026-07-06T03:00:00.000Z'),
    });

    expect(report.actions).toContainEqual(expect.objectContaining({
      status: 'changed',
      name: 'dead daemon metadata',
    }));
    expect(report.actions).toContainEqual(expect.objectContaining({
      status: 'changed',
      name: 'abandoned worktree directory',
    }));
    expect(existsSync(lifecycle.statePath)).toBe(false);
    expect(existsSync(worktreeDir)).toBe(false);
  });
});
