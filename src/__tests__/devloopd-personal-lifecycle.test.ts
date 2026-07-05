import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatPersonalLifecycleReport,
  inspectPersonalLifecycle,
  requestPersonalDaemonStop,
  resetPersonalLifecycle,
  resolvePersonalLifecyclePaths,
} from '../devloopd/personalLifecycle.js';
import {
  startDevloop,
  type DevloopStartDependencies,
} from '../devloopd/supervisor.js';

const cleanupDirs = new Set<string>();

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-personal-lifecycle-'));
  cleanupDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describe('devloopd personal lifecycle', () => {
  it('records a stop request and surfaces it in lifecycle status', () => {
    const repoPath = makeTempRepo();

    const stopReport = requestPersonalDaemonStop({ repoPath, reason: 'operator requested stop' });
    const status = inspectPersonalLifecycle({ repoPath });

    expect(stopReport.passed).toBe(true);
    expect(status.stopRequested).toBe(true);
    expect(status.stopRequest?.reason).toBe('operator requested stop');
    expect(formatPersonalLifecycleReport(status)).toContain('stop requested');
  });

  it('resets lifecycle state without touching TAKT run artifacts', () => {
    const repoPath = makeTempRepo();
    const paths = resolvePersonalLifecyclePaths(repoPath);
    requestPersonalDaemonStop({ repoPath, reason: 'test' });

    const report = resetPersonalLifecycle({ repoPath });

    expect(report.passed).toBe(true);
    expect(existsSync(paths.stopRequestPath)).toBe(false);
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it('stops the foreground supervisor before scanning when a stop request exists', async () => {
    const repoPath = makeTempRepo();
    requestPersonalDaemonStop({ repoPath, reason: 'maintenance window' });
    const dependencies: DevloopStartDependencies = {
      async scanIssues() {
        throw new Error('should not scan after stop request');
      },
      async runDevloopIssue() {
        throw new Error('should not run');
      },
      importTaktRun() {
        throw new Error('should not import');
      },
    };

    const report = await startDevloop({
      repoPath,
      maxCycles: 2,
      dependencies,
    });

    expect(report.passed).toBe(true);
    expect(report.stoppedReason).toBe('stop_requested');
    expect(report.message).toContain('stop requested');
  });
});
