import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectRepeatedWaitLoops,
  detectReasonlessWaitLoops,
  formatDevloopSoakHarnessReport,
  runDevloopSoakHarness,
} from '../devloopd/soakHarness.js';
import type { StagedDevloopReport } from '../devloopd/stagedScheduler.js';

const cleanupPaths = new Set<string>();

function makeCycle(reason: string): StagedDevloopReport {
  return {
    passed: true,
    mode: 'once',
    message: 'cycle',
    statePath: '/tmp/state.json',
    stageReports: [{
      stage: 'issue-scout',
      status: 'skipped',
      due: false,
      reason,
    }],
  };
}

afterEach(() => {
  for (const path of cleanupPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe('devloopd soak harness', () => {
  it('runs deterministic staged cycles without real sleeps or external providers', async () => {
    const repoPath = join(tmpdir(), `takt-soak-repo-${Date.now()}-${Math.random()}`);
    const statePath = join(repoPath, 'state.json');
    const reportPath = join(repoPath, 'soak-report.json');
    cleanupPaths.add(repoPath);

    const report = await runDevloopSoakHarness({
      repoPath,
      cycles: 5,
      statePath,
      reportPath,
      repeatedWaitLimit: 3,
    });

    expect(report.passed).toBe(true);
    expect(report.cycles).toBe(5);
    expect(report.stageRuns).toBeGreaterThan(0);
    expect(report.metrics.retryAfterSkips).toBeGreaterThan(0);
    expect(report.metrics.issueScoutRunsAfterRetryAfter).toBeGreaterThan(0);
    expect(report.metrics.retryActions).toBeGreaterThan(0);
    expect(report.metrics.productPolicyEscalations).toBeGreaterThan(0);
    expect(report.metrics.mergeSerializations).toBeGreaterThan(0);
    expect(report.metrics.leakedLockFiles).toEqual([]);
    expect(report.metrics.externalProcessesSpawned).toBe(0);
    expect(report.scenarioResults.every((scenario) => scenario.passed)).toBe(true);
    expect(report.repeatedWaits).toEqual([]);
    expect(report.reasonlessWaits).toEqual([]);
    expect(formatDevloopSoakHarnessReport(report)).toContain('devloopd soak passed');
    expect(existsSync(reportPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(reportPath, 'utf-8')) as { scenarioResults?: unknown[] };
    expect(artifact.scenarioResults).toHaveLength(report.scenarioResults.length);
  });

  it('detects repeated wait-loop reasons above the configured limit', () => {
    const repeated = detectRepeatedWaitLoops([
      makeCycle('stage interval not due'),
      makeCycle('stage interval not due'),
      makeCycle('stage interval not due'),
    ], { limit: 2 });

    expect(repeated).toEqual([{
      stage: 'issue-scout',
      reason: 'stage interval not due',
      count: 3,
    }]);
  });

  it('detects repeated reasonless wait or error loops above the configured limit', () => {
    const reasonless = detectReasonlessWaitLoops([
      makeCycle(''),
      makeCycle(''),
      makeCycle(''),
    ], { limit: 2 });

    expect(reasonless).toEqual([{
      stage: 'issue-scout',
      status: 'skipped',
      count: 3,
    }]);
  });
});
