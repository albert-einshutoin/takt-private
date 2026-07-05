import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendDevloopLedgerEvent,
  buildDevloopLedgerEvent,
  resolveDevloopLedgerPath,
} from '../devloopd/ledger.js';
import {
  buildIssueScoutCandidate,
  formatIssueScoutReport,
  generateMaintenanceIssue,
  runIssueScout,
  scoreIssueScoutCandidate,
  type IssueScoutSource,
} from '../devloopd/issueScout.js';
import type { DevloopCommandRunner } from '../devloopd/commandRunner.js';

function runner(): DevloopCommandRunner {
  return {
    resolveCommand(command) {
      return command === 'rg' ? '/mock/bin/rg' : undefined;
    },
    async exec() {
      return { exitCode: 1, stdout: '', stderr: '' };
    },
  };
}

function source(candidateTitle: string): IssueScoutSource {
  return {
    id: 'local_backlog',
    scan() {
      return {
        sourceId: 'local_backlog',
        status: 'success',
        summary: 'fixture source',
        candidates: [
          buildIssueScoutCandidate({
            sourceId: 'local_backlog',
            title: candidateTitle,
            summary: 'Add docs and tests for a small devloopd improvement',
            lane: 'docs_tests_tooling',
          }),
        ],
        nextActions: [],
        artifacts: [],
      };
    },
  };
}

describe('devloopd issue-scout', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-issue-scout-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(repoPath)) {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('returns warning observations for unavailable sources without failing the scan', async () => {
    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sourceIds: ['local_backlog'],
      backlogFiles: ['missing.md'],
      now: new Date('2026-07-05T00:00:00.000Z'),
    });

    expect(report.passed).toBe(true);
    expect(report.observations[0]).toMatchObject({
      sourceId: 'local_backlog',
      status: 'warning',
    });
    expect(formatIssueScoutReport(report)).toContain('no local backlog files found');
  });

  it('generates recursive maintenance issue templates with escalation criteria', () => {
    const candidate = buildIssueScoutCandidate({
      sourceId: 'dependency_report',
      title: 'Update dependency lockfile evidence',
      summary: 'Patch dependency update from a report',
      lane: 'dependencies',
    });

    const draft = generateMaintenanceIssue(candidate);

    expect(draft.labels).toContain('lane:dependencies');
    expect(draft.body).toContain('## Acceptance Criteria');
    expect(draft.body).toContain('## Product-Policy Escalation');
    expect(draft.body).toContain('## Expected Changed Surfaces');
  });

  it('scores low-risk docs and tooling work ahead of broader feature work', () => {
    const docs = buildIssueScoutCandidate({
      sourceId: 'local_backlog',
      title: 'Add docs and tests',
      summary: 'Documentation maintenance',
      lane: 'docs_tests_tooling',
    });
    const feature = buildIssueScoutCandidate({
      sourceId: 'local_backlog',
      title: 'Improve feature workflow',
      summary: 'Feature implementation maintenance',
      lane: 'feature_improvement',
    });

    expect(scoreIssueScoutCandidate(docs).score).toBeLessThan(scoreIssueScoutCandidate(feature).score);
  });

  it('dedupes against existing issues and records the decision in the ledger', async () => {
    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [source('Add docs and tests for devloopd')],
      existingWork: [{ title: 'Add docs and tests for devloopd', issueNumber: 10 }],
      now: new Date('2026-07-05T00:00:00.000Z'),
    });

    expect(report.selected).toEqual([]);
    expect(report.skipped[0]).toMatchObject({ stopRule: 'Duplicate or already covered' });

    const ledger = readFileSync(join(repoPath, '.devloop', 'ledger.jsonl'), 'utf-8').trim().split('\n');
    expect(ledger).toHaveLength(1);
    const event = JSON.parse(ledger[0]!) as { eventType: string; stopRule: string; skipped: unknown[] };
    expect(event.eventType).toBe('devloop_issue_scout');
    expect(event.stopRule).toBe('no candidates');
    expect(event.skipped).toHaveLength(1);
  });

  it('prints would-create issues in dry-run mode without mutating GitHub', async () => {
    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [source('Add docs and tests for devloopd dry run')],
      existingWork: [],
      dryRun: true,
      createIssues: true,
      now: new Date('2026-07-05T00:00:00.000Z'),
    });

    expect(report.createdIssues).toEqual([]);
    expect(report.wouldCreate).toHaveLength(1);
    expect(formatIssueScoutReport(report)).toContain('Would create');
  });

  it('honors candidate retry backoff and lets stale backoff expire deterministically', async () => {
    const ledgerPath = resolveDevloopLedgerPath(repoPath, undefined);
    appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_issue_scout', {
      skipped: [{
        candidateKey: 'docs tests tooling add docs and tests for devloopd backoff',
        retryAfter: '2026-07-05T01:00:00.000Z',
      }],
    }, new Date('2026-07-05T00:00:00.000Z')));

    const blocked = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [source('Add docs and tests for devloopd backoff')],
      existingWork: [],
      now: new Date('2026-07-05T00:30:00.000Z'),
    });
    const expired = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [source('Add docs and tests for devloopd backoff')],
      existingWork: [],
      now: new Date('2026-07-05T01:30:00.000Z'),
    });

    expect(blocked.skipped[0]).toMatchObject({ stopRule: 'backoff active' });
    expect(expired.selected).toHaveLength(1);
  });

  it('discovers backlog files with typed local_backlog observations', async () => {
    writeFileSync(join(repoPath, 'BACKLOG.md'), '- [ ] Refactor TypeScript helper for maintainability\n', 'utf-8');

    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sourceIds: ['local_backlog'],
      existingWork: [],
      now: new Date('2026-07-05T00:00:00.000Z'),
    });

    expect(report.selected).toHaveLength(1);
    expect(report.observations[0]?.sourceId).toBe('local_backlog');
    expect(report.wouldCreate[0]?.title).toContain('Refactor TypeScript helper');
  });
});
