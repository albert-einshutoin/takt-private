import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendDevloopLedgerEvent,
  buildDevloopLedgerEvent,
  DevloopLedgerCapacityError,
  exportDevloopLedger,
  formatExportDevloopLedgerReport,
  formatImportTaktRunReport,
  formatReconcileTaktRunsReport,
  formatTimelineReport,
  importTaktRun,
  reconcileTaktRuns,
  readRawDevloopLedgerEvents,
  renderTimeline,
  MAX_DEVLOOP_LEDGER_BYTES,
  MAX_DEVLOOP_LEDGER_LINE_BYTES,
  withLockedDevloopLedgerTransaction,
} from '../devloopd/ledger.js';

function writeRunFixture(
  repoPath: string,
  slug: string,
  overrides: {
    issue?: number;
    status?: string;
    startTime?: string;
    endTime?: string;
    task?: string;
    workflow?: string;
    reportName?: string;
    reportContent?: string;
  } = {},
): void {
  const runDir = join(repoPath, '.takt', 'runs', slug);
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  mkdirSync(join(runDir, 'reports'), { recursive: true });
  writeFileSync(join(runDir, 'logs', 'session.jsonl'), [
    JSON.stringify({ type: 'workflow_start', ts: overrides.startTime ?? '2026-06-24T00:00:00.000Z' }),
    JSON.stringify({ type: 'workflow_complete', ts: overrides.endTime ?? '2026-06-24T00:10:00.000Z' }),
  ].join('\n'), 'utf-8');
  writeFileSync(
    join(runDir, 'reports', overrides.reportName ?? 'summary.md'),
    overrides.reportContent ?? '# Summary\nDone',
    'utf-8',
  );
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    task: overrides.task ?? `Issue #${overrides.issue ?? 123}`,
    workflow: overrides.workflow ?? 'subscription-devloop',
    status: overrides.status ?? 'completed',
    startTime: overrides.startTime ?? '2026-06-24T00:00:00.000Z',
    endTime: overrides.endTime ?? '2026-06-24T00:10:00.000Z',
    logsDirectory: `.takt/runs/${slug}/logs`,
    reportDirectory: `.takt/runs/${slug}/reports`,
    runSlug: slug,
  }), 'utf-8');
}

describe('devloopd ledger import and timeline', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-devloopd-ledger-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(repoPath)) {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('imports a TAKT run into the devloop ledger with artifact hashes', () => {
    writeRunFixture(repoPath, '20260624-issue-123', { issue: 123 });

    const report = importTaktRun({
      repoPath,
      issue: 123,
      runSlug: '20260624-issue-123',
    });

    expect(report.passed).toBe(true);
    expect(formatImportTaktRunReport(report)).toContain('20260624-issue-123');

    const ledger = readFileSync(join(repoPath, '.devloop', 'ledger.jsonl'), 'utf-8').trim().split('\n');
    expect(ledger).toHaveLength(1);
    const event = JSON.parse(ledger[0]!) as {
      eventType: string;
      issueNumber: number;
      artifacts: Array<{ kind: string; path: string; sha256: string }>;
    };
    expect(event.eventType).toBe('takt_run_imported');
    expect(event.issueNumber).toBe(123);
    expect(event.artifacts.some((artifact) => artifact.kind === 'report' && artifact.path.endsWith('summary.md'))).toBe(true);
    expect(event.artifacts.every((artifact) => artifact.sha256.length === 64)).toBe(true);
  });

  it('appends generic devloop events without changing TAKT timeline imports', () => {
    const ledgerPath = join(repoPath, '.devloop', 'ledger.jsonl');
    appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_issue_scout', {
      repoPath,
      candidates: 2,
      selected: ['candidate-a'],
    }));

    expect(readRawDevloopLedgerEvents(ledgerPath)).toHaveLength(1);
    expect(renderTimeline({ repoPath }).events).toEqual([]);
    expect(statSync(join(repoPath, '.devloop')).mode & 0o777).toBe(0o700);
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
  });

  it('scopes append capability to the locked ledger transaction', () => {
    const ledgerPath = join(repoPath, '.devloop', 'ledger.jsonl');
    const event = buildDevloopLedgerEvent('devloop_lock_boundary', { sequence: 1 });
    let appendAfterTransaction: (() => void) | undefined;

    withLockedDevloopLedgerTransaction(ledgerPath, (transaction) => {
      transaction.append(event);
      appendAfterTransaction = () => transaction.append(
        buildDevloopLedgerEvent('devloop_lock_boundary', { sequence: 2 }),
      );
    }, { timeoutMs: 25 });

    expect(readRawDevloopLedgerEvents(ledgerPath)).toEqual([event]);
    expect(() => appendAfterTransaction?.()).toThrow(/transaction/i);
    expect(statSync(join(repoPath, '.devloop')).mode & 0o777).toBe(0o700);
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
  });

  it('preflights serialization before changing an existing ledger to owner-only', () => {
    const ledgerDirectory = join(repoPath, '.devloop');
    const ledgerPath = join(ledgerDirectory, 'ledger.jsonl');
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(ledgerPath, '');
    chmodSync(ledgerPath, 0o644);
    let modeDuringSerialization: number | undefined;
    const event = {
      eventId: 'evt_secure_mode',
      eventType: 'devloop_secure_mode',
      get sequence(): number {
        modeDuringSerialization = statSync(ledgerPath).mode & 0o777;
        return 1;
      },
    };

    appendDevloopLedgerEvent(ledgerPath, event);

    expect(modeDuringSerialization).toBe(0o644);
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
    expect(readRawDevloopLedgerEvents(ledgerPath)).toHaveLength(1);
  });

  it('rejects hard-linked ledgers without mutating the victim', () => {
    const ledgerDirectory = join(repoPath, '.devloop');
    const ledgerPath = join(ledgerDirectory, 'ledger.jsonl');
    const victimPath = join(repoPath, 'victim.jsonl');
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(victimPath, 'preserve-me\n');
    linkSync(victimPath, ledgerPath);

    expect(() => appendDevloopLedgerEvent(
      ledgerPath,
      buildDevloopLedgerEvent('devloop_hardlink', { sequence: 1 }),
    )).toThrow(/regular|link/i);
    expect(readFileSync(victimPath, 'utf8')).toBe('preserve-me\n');
  });

  it('rejects a symlinked ledger at secure open without mutating the victim', () => {
    const ledgerDirectory = join(repoPath, '.devloop');
    const ledgerPath = join(ledgerDirectory, 'ledger.jsonl');
    const victimPath = join(repoPath, 'victim.jsonl');
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(victimPath, 'preserve-me\n');
    symlinkSync(victimPath, ledgerPath);

    expect(() => appendDevloopLedgerEvent(
      ledgerPath,
      buildDevloopLedgerEvent('devloop_symlink', { sequence: 1 }),
    )).toThrow();
    expect(readFileSync(victimPath, 'utf8')).toBe('preserve-me\n');
  });

  it('rejects a group-writable ledger parent directory', () => {
    const ledgerDirectory = join(repoPath, '.devloop');
    const ledgerPath = join(ledgerDirectory, 'ledger.jsonl');
    mkdirSync(ledgerDirectory, { recursive: true });
    chmodSync(ledgerDirectory, 0o770);

    expect(() => appendDevloopLedgerEvent(
      ledgerPath,
      buildDevloopLedgerEvent('devloop_unsafe_parent', { sequence: 1 }),
    )).toThrow(/directory/i);
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('pins shared ledger capacity constants', () => {
    expect(MAX_DEVLOOP_LEDGER_LINE_BYTES).toBe(1024 * 1024);
    expect(MAX_DEVLOOP_LEDGER_BYTES).toBe(64 * 1024 * 1024);
  });

  it('accepts an exact-limit JSON line and rejects one extra byte without creating a ledger', () => {
    const eventWithJsonBytes = (jsonBytes: number, eventId: string) => {
      const empty = { eventId, eventType: 'devloop_capacity', padding: '' };
      const overhead = Buffer.byteLength(JSON.stringify(empty), 'utf8');
      return {
        ...empty,
        padding: 'x'.repeat(jsonBytes - overhead),
      };
    };
    const exactLedgerPath = join(repoPath, '.devloop', 'exact.jsonl');
    const oversizedLedgerPath = join(repoPath, '.devloop', 'oversized.jsonl');

    appendDevloopLedgerEvent(
      exactLedgerPath,
      eventWithJsonBytes(MAX_DEVLOOP_LEDGER_LINE_BYTES, 'evt_exact'),
    );
    expect(
      Buffer.byteLength(readFileSync(exactLedgerPath, 'utf8').trimEnd(), 'utf8'),
    ).toBe(MAX_DEVLOOP_LEDGER_LINE_BYTES);

    expect(() => appendDevloopLedgerEvent(
      oversizedLedgerPath,
      eventWithJsonBytes(MAX_DEVLOOP_LEDGER_LINE_BYTES + 1, 'evt_oversized'),
    )).toThrow(DevloopLedgerCapacityError);
    expect(existsSync(oversizedLedgerPath)).toBe(false);
  });

  it('imports the latest run when no run slug is specified', () => {
    writeRunFixture(repoPath, 'old-run', { startTime: '2026-06-24T00:00:00.000Z' });
    writeRunFixture(repoPath, 'new-run', { startTime: '2026-06-24T01:00:00.000Z' });

    const report = importTaktRun({ repoPath, issue: 123, latest: true });

    expect(report.passed).toBe(true);
    expect(report.runSlug).toBe('new-run');
  });

  it('does not implicitly import latest run unless latest is requested', () => {
    writeRunFixture(repoPath, 'new-run', { startTime: '2026-06-24T01:00:00.000Z' });

    const report = importTaktRun({ repoPath, issue: 123 });

    expect(report.passed).toBe(false);
    expect(report.message).toContain('No TAKT runs found');
  });

  it('writes ledger directory and file with owner-only permissions', () => {
    writeRunFixture(repoPath, 'run-123', { issue: 123 });

    const report = importTaktRun({ repoPath, issue: 123, runSlug: 'run-123' });

    expect(report.passed).toBe(true);
    expect(statSync(join(repoPath, '.devloop')).mode & 0o777).toBe(0o700);
    expect(statSync(join(repoPath, '.devloop', 'ledger.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('does not change permissions on an existing custom ledger directory', () => {
    writeRunFixture(repoPath, 'run-123', { issue: 123 });
    const customLedgerDir = join(repoPath, 'public-ledger');
    mkdirSync(customLedgerDir, { recursive: true });
    chmodSync(customLedgerDir, 0o755);

    const report = importTaktRun({
      repoPath,
      issue: 123,
      runSlug: 'run-123',
      ledgerPath: join('public-ledger', 'ledger.jsonl'),
    });

    expect(report.passed).toBe(true);
    expect(statSync(customLedgerDir).mode & 0o777).toBe(0o755);
    expect(statSync(join(customLedgerDir, 'ledger.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('renders a timeline filtered by issue number', () => {
    writeRunFixture(repoPath, 'run-123', { issue: 123, task: 'Fix bug' });
    writeRunFixture(repoPath, 'run-456', { issue: 456, task: 'Other issue' });
    importTaktRun({ repoPath, issue: 123, runSlug: 'run-123' });
    importTaktRun({ repoPath, issue: 456, runSlug: 'run-456' });

    const timeline = renderTimeline({ repoPath, issue: 123 });
    const output = formatTimelineReport(timeline);

    expect(timeline.passed).toBe(true);
    expect(output).toContain('#123');
    expect(output).toContain('run-123');
    expect(output).toContain('Fix bug');
    expect(output).not.toContain('run-456');
  });

  it('fails cleanly when no TAKT run can be imported', () => {
    const report = importTaktRun({ repoPath, issue: 123, latest: true });

    expect(report.passed).toBe(false);
    expect(formatImportTaktRunReport(report)).toContain('No TAKT runs found');
  });

  it('reconciles missing non-running TAKT runs without duplicating imported runs', () => {
    writeRunFixture(repoPath, 'run-imported', { startTime: '2026-06-24T00:00:00.000Z' });
    writeRunFixture(repoPath, 'run-missing', { startTime: '2026-06-24T01:00:00.000Z' });
    writeRunFixture(repoPath, 'run-active', { status: 'running', startTime: '2026-06-24T02:00:00.000Z' });
    importTaktRun({ repoPath, runSlug: 'run-imported' });

    const report = reconcileTaktRuns({ repoPath });
    const output = formatReconcileTaktRunsReport(report);

    expect(report.passed).toBe(true);
    expect(report.imported.map((item) => item.runSlug)).toEqual(['run-missing']);
    expect(report.skipped).toEqual([
      { runSlug: 'run-imported', reason: 'already imported' },
      { runSlug: 'run-active', reason: 'run is still running' },
    ]);
    expect(output).toContain('run-missing');

    const ledger = readFileSync(join(repoPath, '.devloop', 'ledger.jsonl'), 'utf-8').trim().split('\n');
    expect(ledger).toHaveLength(2);
  });

  it('exports filtered ledger events without overwriting an existing backup by default', () => {
    writeRunFixture(repoPath, 'run-123', { issue: 123, task: 'Fix bug' });
    writeRunFixture(repoPath, 'run-456', { issue: 456, task: 'Other issue' });
    importTaktRun({ repoPath, issue: 123, runSlug: 'run-123' });
    importTaktRun({ repoPath, issue: 456, runSlug: 'run-456' });

    const outputPath = join('.devloop', 'backup', 'ledger-123.jsonl');
    const exportReport = exportDevloopLedger({ repoPath, issue: 123, outputPath });
    const output = formatExportDevloopLedgerReport(exportReport);

    expect(exportReport.passed).toBe(true);
    expect(exportReport.events).toHaveLength(1);
    expect(output).toContain('1 ledger event');

    const exportedLines = readFileSync(join(repoPath, outputPath), 'utf-8').trim().split('\n');
    expect(exportedLines).toHaveLength(1);
    expect(JSON.parse(exportedLines[0]!) as { runSlug: string }).toMatchObject({ runSlug: 'run-123' });

    const blockedReport = exportDevloopLedger({ repoPath, issue: 123, outputPath });
    expect(blockedReport.passed).toBe(false);
    expect(blockedReport.message).toContain('--force');

    const forcedReport = exportDevloopLedger({ repoPath, issue: 123, outputPath, force: true });
    expect(forcedReport.passed).toBe(true);

    const escapedReport = exportDevloopLedger({ repoPath, outputPath: '../outside-ledger.jsonl' });
    expect(escapedReport.passed).toBe(false);
    expect(escapedReport.message).toContain('inside the repository');
  });
});
