import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAutomationStateEvent } from '../devloopd/automationState.js';
import {
  formatPersonalStatusReport,
  inspectPersonalStatus,
} from '../devloopd/personalStatus.js';

const cleanupDirs = new Set<string>();

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-personal-status-'));
  cleanupDirs.add(dir);
  return dir;
}

function writeLedger(repoPath: string, events: unknown[]): void {
  const ledgerDir = join(repoPath, '.devloop');
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(
    join(ledgerDir, 'ledger.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n'),
    'utf-8',
  );
}

function writeRunMeta(repoPath: string): void {
  const runDir = join(repoPath, '.takt', 'runs', 'run-active');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    task: 'Automate issue #82',
    workflow: 'subscription-devloop',
    runSlug: 'run-active',
    runRoot: '.takt/runs/run-active',
    reportDirectory: '.takt/runs/run-active/reports',
    contextDirectory: '.takt/runs/run-active/context',
    logsDirectory: '.takt/runs/run-active/logs',
    status: 'running',
    startTime: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:10:00.000Z',
    currentStep: 'implement',
  }), 'utf-8');
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describe('devloopd personal status', () => {
  it('combines lifecycle, active runs, and automation ledger state into one report', () => {
    const repoPath = makeTempRepo();
    writeRunMeta(repoPath);
    writeLedger(repoPath, [
      buildAutomationStateEvent({
        stage: 'scout',
        status: 'passed',
        summary: 'selected issue #82',
        issueNumber: 82,
        nextActions: ['run issue-to-pr'],
      }, new Date('2026-07-06T00:11:00.000Z')),
    ]);

    const report = inspectPersonalStatus({
      repoPath,
      now: new Date('2026-07-06T00:20:00.000Z'),
    });

    expect(report.passed).toBe(true);
    expect(report.activeRuns.activeRuns).toHaveLength(1);
    expect(report.automationState.currentState).toBe('passed');
    expect(report.nextActions).toEqual(['run issue-to-pr']);
    expect(formatPersonalStatusReport(report)).toContain('devloopd status passed');
    expect(formatPersonalStatusReport(report)).toContain('run-active');
  });
});
