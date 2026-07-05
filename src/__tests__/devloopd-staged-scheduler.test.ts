import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEVLOOP_AUTOMATION_STAGES,
  runStagedDevloop,
  type DevloopAutomationStage,
} from '../devloopd/stagedScheduler.js';

function makeTempStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'takt-staged-')), 'state.json');
}

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
});
