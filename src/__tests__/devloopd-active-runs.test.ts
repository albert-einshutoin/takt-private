import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatActiveRunsReport,
  inspectActiveRuns,
} from '../devloopd/activeRuns.js';

const cleanupDirs = new Set<string>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-devloopd-active-runs-'));
  cleanupDirs.add(dir);
  return dir;
}

function writeRunMeta(repoPath: string, slug: string, meta: Record<string, unknown>): void {
  const runDir = join(repoPath, '.takt', 'runs', slug);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    task: `Task ${slug}`,
    workflow: 'subscription-devloop',
    runSlug: slug,
    runRoot: `.takt/runs/${slug}`,
    reportDirectory: `.takt/runs/${slug}/reports`,
    contextDirectory: `.takt/runs/${slug}/context`,
    logsDirectory: `.takt/runs/${slug}/logs`,
    startTime: '2026-06-24T00:00:00.000Z',
    ...meta,
  }), 'utf-8');
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describe('devloopd active runs', () => {
  it('lists running TAKT runs and marks stale runs by updatedAt', () => {
    const repoPath = makeTempDir();
    writeRunMeta(repoPath, 'run-active', {
      status: 'running',
      updatedAt: '2026-06-24T02:30:00.000Z',
      currentStep: 'implement',
    });
    writeRunMeta(repoPath, 'run-stale', {
      status: 'running',
      updatedAt: '2026-06-24T00:00:00.000Z',
      currentStep: 'review',
    });
    writeRunMeta(repoPath, 'run-done', { status: 'completed' });

    const report = inspectActiveRuns({
      repoPath,
      staleAfterMinutes: 60,
      now: new Date('2026-06-24T03:00:00.000Z'),
    });

    expect(report.passed).toBe(true);
    expect(report.activeRuns.map((run) => run.slug)).toEqual(['run-active', 'run-stale']);
    expect(report.activeRuns.map((run) => run.stale)).toEqual([false, true]);
    expect(formatActiveRunsReport(report)).toContain('run-stale');
    expect(formatActiveRunsReport(report)).toContain('stale');
  });

  it('ignores corrupt run metadata instead of blocking inspection', () => {
    const repoPath = makeTempDir();
    mkdirSync(join(repoPath, '.takt', 'runs', 'bad-run'), { recursive: true });
    writeFileSync(join(repoPath, '.takt', 'runs', 'bad-run', 'meta.json'), '{bad json', 'utf-8');

    const report = inspectActiveRuns({ repoPath });

    expect(report.passed).toBe(true);
    expect(report.activeRuns).toEqual([]);
  });
});
