import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendDevloopLedgerEvent, buildDevloopLedgerEvent, resolveDevloopLedgerPath } from '../devloopd/ledger.js';
import { requestPersonalDaemonStop } from '../devloopd/personalLifecycle.js';
import {
  DEVLOOP_AUTOMATION_STAGES,
  runStagedDevloop,
  type DevloopAutomationStage,
} from '../devloopd/stagedScheduler.js';

const cleanupDirs = new Set<string>();

function makeTempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-staged-'));
  cleanupDirs.add(dir);
  return join(dir, 'state.json');
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-staged-repo-'));
  cleanupDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describe('devloopd staged scheduler', () => {
  it('runs due stages in deterministic order and persists structured state', async () => {
    const statePath = makeTempStatePath();
    const calls: DevloopAutomationStage[] = [];

    const report = await runStagedDevloop({
      repoPath: '/repo',
      mode: 'once',
      statePath,
      now: () => new Date('2026-07-05T00:00:00.000Z'),
      dependencies: {
        runStage: async (options) => {
          calls.push(options.stage);
          return { passed: true, stage: options.stage, message: `ran ${options.stage}`, actions: [] };
        },
      },
    });

    expect(report.passed).toBe(true);
    expect(calls).toEqual([...DEVLOOP_AUTOMATION_STAGES]);
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { lastRunAt: Record<string, string> };
    expect(state.lastRunAt['issue-scout']).toBe('2026-07-05T00:00:00.000Z');
    expect(state.lastRunAt['pr-merge']).toBe('2026-07-05T00:00:00.000Z');
  });

  it('skips stages that are not due yet', async () => {
    const statePath = makeTempStatePath();
    const calls: DevloopAutomationStage[] = [];

    await runStagedDevloop({
      repoPath: '/repo',
      mode: 'once',
      statePath,
      now: () => new Date('2026-07-05T00:00:00.000Z'),
      dependencies: {
        runStage: async (options) => {
          calls.push(options.stage);
          return { passed: true, stage: options.stage, message: `ran ${options.stage}`, actions: [] };
        },
      },
    });

    const second = await runStagedDevloop({
      repoPath: '/repo',
      mode: 'once',
      statePath,
      intervals: {
        'issue-scout': 3600,
        'issue-to-pr': 3600,
        'pr-review': 3600,
        'review-fix': 3600,
        'pr-merge': 3600,
      },
      now: () => new Date('2026-07-05T00:10:00.000Z'),
      dependencies: {
        runStage: async (options) => {
          calls.push(options.stage);
          return { passed: true, stage: options.stage, message: `ran ${options.stage}`, actions: [] };
        },
      },
    });

    expect(calls).toEqual([...DEVLOOP_AUTOMATION_STAGES]);
    expect(second.stageReports.every((stage) => stage.status === 'skipped')).toBe(true);
  });

  it('recovers from malformed state by treating stages as due', async () => {
    const statePath = makeTempStatePath();
    const calls: DevloopAutomationStage[] = [];

    await import('node:fs').then(({ writeFileSync }) => writeFileSync(statePath, '{bad json', 'utf-8'));

    const report = await runStagedDevloop({
      repoPath: '/repo',
      mode: 'once',
      statePath,
      now: () => new Date('2026-07-05T00:00:00.000Z'),
      dependencies: {
        runStage: async (options) => {
          calls.push(options.stage);
          return { passed: true, stage: options.stage, message: `ran ${options.stage}`, actions: [] };
        },
      },
    });

    expect(report.passed).toBe(true);
    expect(report.stateWarning).toContain('malformed');
    expect(calls).toEqual([...DEVLOOP_AUTOMATION_STAGES]);
  });

  it('can run a single stage without consulting intervals', async () => {
    const statePath = makeTempStatePath();
    const calls: DevloopAutomationStage[] = [];

    const report = await runStagedDevloop({
      repoPath: '/repo',
      stage: 'pr-review',
      statePath,
      now: () => new Date('2026-07-05T00:00:00.000Z'),
      dependencies: {
        runStage: async (options) => {
          calls.push(options.stage);
          return { passed: true, stage: options.stage, message: `ran ${options.stage}`, actions: [] };
        },
      },
    });

    expect(report.passed).toBe(true);
    expect(calls).toEqual(['pr-review']);
    expect(report.stageReports.map((stage) => stage.stage)).toEqual(['pr-review']);
  });

  it('stops loop before running stages when a stop request already exists', async () => {
    const repoPath = makeTempRepo();
    requestPersonalDaemonStop({ repoPath, reason: 'maintenance window' });
    const calls: DevloopAutomationStage[] = [];

    const report = await runStagedDevloop({
      repoPath,
      mode: 'loop',
      maxCycles: 2,
      tickSeconds: 0,
      statePath: join(repoPath, 'state.json'),
      dependencies: {
        runStage: async (options) => {
          calls.push(options.stage);
          return { passed: true, stage: options.stage, message: `ran ${options.stage}`, actions: [] };
        },
      },
    });

    expect(report.passed).toBe(true);
    expect(report.stoppedReason).toBe('stop_requested');
    expect(report.message).toContain('maintenance window');
    expect(report.cycles).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('stops loop before the next cycle when a stop request appears during sleep', async () => {
    const repoPath = makeTempRepo();
    const calls: DevloopAutomationStage[] = [];

    const report = await runStagedDevloop({
      repoPath,
      mode: 'loop',
      maxCycles: 3,
      tickSeconds: 1,
      statePath: join(repoPath, 'state.json'),
      sleep: async () => {
        requestPersonalDaemonStop({ repoPath, reason: 'operator requested stop' });
      },
      dependencies: {
        runStage: async (options) => {
          calls.push(options.stage);
          return { passed: true, stage: options.stage, message: `ran ${options.stage}`, actions: [] };
        },
      },
    });

    expect(report.passed).toBe(true);
    expect(report.stoppedReason).toBe('stop_requested');
    expect(report.cycles).toHaveLength(1);
    expect(calls).toEqual([...DEVLOOP_AUTOMATION_STAGES]);
  });

  it('stops before running stages when persisted safety budgets are exhausted', async () => {
    const statePath = makeTempStatePath();
    const calls: DevloopAutomationStage[] = [];

    await import('node:fs').then(({ writeFileSync }) => writeFileSync(statePath, JSON.stringify({
      version: 1,
      lastRunAt: {},
      safety: {
        startedAt: '2026-07-05T00:00:00.000Z',
        runs: 2,
        consecutiveNoopSignals: 2,
      },
    }), 'utf-8'));

    const report = await runStagedDevloop({
      repoPath: '/repo',
      mode: 'once',
      statePath,
      safetyBudgets: { maxConsecutiveNoopSignals: 2 },
      now: () => new Date('2026-07-05T00:05:00.000Z'),
      dependencies: {
        runStage: async (options) => {
          calls.push(options.stage);
          return { passed: true, stage: options.stage, message: `ran ${options.stage}`, actions: [] };
        },
      },
    });

    expect(report.passed).toBe(false);
    expect(report.safetyReport?.stopRule).toBe('completion signal');
    expect(report.message).toContain('automation safety stopped');
    expect(calls).toEqual([]);
  });

  it('persists recursive safety counters after no-op stages', async () => {
    const statePath = makeTempStatePath();

    const report = await runStagedDevloop({
      repoPath: '/repo',
      stage: 'issue-scout',
      statePath,
      safetyBudgets: { maxConsecutiveNoopSignals: 3 },
      now: () => new Date('2026-07-05T00:00:00.000Z'),
      dependencies: {
        runStage: async (options) => ({
          passed: true,
          stage: options.stage,
          message: `ran ${options.stage}`,
          actions: [],
        }),
      },
    });

    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      safety?: { runs?: number; consecutiveNoopSignals?: number };
    };
    expect(report.passed).toBe(true);
    expect(state.safety?.runs).toBe(1);
    expect(state.safety?.consecutiveNoopSignals).toBe(1);
  });

  it('uses safe-default safety profile unless a shorter smoke profile is requested', async () => {
    const statePath = makeTempStatePath();

    const report = await runStagedDevloop({
      repoPath: '/repo',
      mode: 'once',
      stage: 'issue-scout',
      statePath,
      safetyProfile: 'smoke',
      now: () => new Date('2026-07-05T00:00:00.000Z'),
      dependencies: {
        runStage: async (options) => ({
          passed: true,
          stage: options.stage,
          message: `ran ${options.stage}`,
          actions: [],
        }),
      },
    });

    expect(report.safetyProfile).toBe('smoke');
    expect(report.safetyBudgets?.maxRuns).toBe(5);
    expect(report.safetyBudgets?.maxDurationSeconds).toBe(300);
  });

  it('rejects unknown safety profiles from the environment', async () => {
    const report = await runStagedDevloop({
      repoPath: '/repo',
      statePath: makeTempStatePath(),
      env: { TAKT_LOOP_SAFETY_PROFILE: 'forever' },
      dependencies: {
        runStage: async (options) => ({
          passed: true,
          stage: options.stage,
          message: `ran ${options.stage}`,
          actions: [],
        }),
      },
    });

    expect(report.passed).toBe(false);
    expect(report.message).toContain('invalid TAKT_LOOP_SAFETY_PROFILE');
  });

  it('honors active top-level issue-scout retryAfter ledger events without running the stage', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'takt-staged-retry-'));
    const statePath = join(repoPath, 'state.json');
    const ledgerPath = resolveDevloopLedgerPath(repoPath, undefined);
    const calls: DevloopAutomationStage[] = [];
    appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_issue_scout', {
      repoPath,
      retryAfter: '2026-07-05T01:00:00.000Z',
    }, new Date('2026-07-05T00:00:00.000Z')));

    const report = await runStagedDevloop({
      repoPath,
      mode: 'once',
      statePath,
      now: () => new Date('2026-07-05T00:30:00.000Z'),
      dependencies: {
        runStage: async (options) => {
          calls.push(options.stage);
          return { passed: true, stage: options.stage, message: `ran ${options.stage}`, actions: [] };
        },
      },
    });

    expect(report.stageReports.find((stage) => stage.stage === 'issue-scout')).toMatchObject({
      status: 'skipped',
      due: false,
      retryAfter: '2026-07-05T01:00:00.000Z',
    });
    expect(calls).not.toContain('issue-scout');
    expect(calls).toContain('pr-merge');
  });
});
