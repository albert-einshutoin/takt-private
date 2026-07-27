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
  buildRecursiveLaneCandidate,
  classifyDependencyUpdateKind,
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

function riskySource(candidateTitle: string): IssueScoutSource {
  return {
    id: 'local_backlog',
    scan() {
      return {
        sourceId: 'local_backlog',
        status: 'success',
        summary: 'risky fixture source',
        candidates: [
          buildIssueScoutCandidate({
            sourceId: 'local_backlog',
            title: candidateTitle,
            summary: 'Change an existing public product commitment',
            lane: 'feature_improvement',
            policyCategory: 'product_policy',
            riskBucket: 'high',
            acceptanceCriteria: ['Preserve the existing public commitment.'],
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
    const candidate = buildRecursiveLaneCandidate({
      sourceId: 'dependency_report',
      title: 'Update dependency lockfile evidence',
      summary: 'Patch dependency update from a report',
      lane: 'dependencies',
      currentVersion: '1.2.3',
      targetVersion: '1.2.4',
      changelogUrls: ['https://example.com/changelog'],
      advisoryUrls: ['https://example.com/advisory'],
    });

    const draft = generateMaintenanceIssue(candidate);

    expect(draft.labels).toContain('lane:dependencies');
    expect(draft.body).toContain('## Lane Evidence');
    expect(draft.body).toContain('updateKind=patch');
    expect(draft.body).toContain('https://example.com/changelog');
    expect(draft.body).toContain('## Acceptance Criteria');
    expect(draft.body).toContain('## Product-Policy Escalation');
    expect(draft.body).toContain('## Expected Changed Surfaces');
  });

  it('classifies major dependency updates for human review before automation', async () => {
    mkdirSync(join(repoPath, '.devloop'), { recursive: true });
    writeFileSync(join(repoPath, '.devloop', 'dependency-report.json'), JSON.stringify({
      title: 'Upgrade workflow-runtime to v3',
      summary: 'Major dependency migration with public compatibility risk',
      currentVersion: '2.8.0',
      targetVersion: '3.0.0',
      changelogUrls: ['https://example.com/runtime-v3'],
    }), 'utf-8');

    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sourceIds: ['dependency_report'],
      existingWork: [],
      now: new Date('2026-07-05T00:00:00.000Z'),
    });

    expect(classifyDependencyUpdateKind({ currentVersion: '2.8.0', targetVersion: '3.0.0' })).toBe('major');
    expect(report.selected).toEqual([]);
    expect(report.skipped[0]).toMatchObject({
      stopRule: 'Unsafe or too broad',
      decisionId: expect.stringMatching(/^dec_[a-f0-9]{64}$/u),
    });
    expect(report.skipped[0]?.candidate.policyCategory).toBe('human_policy');
  });

  it('links one durable decision to repeated risky skips and the report', async () => {
    const first = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [riskySource('Choose preview release eligibility')],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const second = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [riskySource('Choose preview release eligibility')],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T01:00:00.000Z'),
    });

    expect(first.skipped[0]?.decisionId).toBeDefined();
    expect(second.skipped[0]?.decisionId).toBe(first.skipped[0]?.decisionId);
    expect(formatIssueScoutReport(first)).toContain(`Decision: ${first.skipped[0]?.decisionId}`);

    const events = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        eventType: string;
        skipped?: Array<{ decisionId?: string }>;
      });
    expect(events.filter((event) => event.eventType === 'devloop_decision_requested')).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'devloop_issue_scout')).toHaveLength(2);
    expect(events
      .filter((event) => event.eventType === 'devloop_issue_scout')
      .every((event) => event.skipped?.[0]?.decisionId === first.skipped[0]?.decisionId))
      .toBe(true);
  });

  it('does not create decisions for low-risk, duplicate, or backoff candidates', async () => {
    const ledgerPath = resolveDevloopLedgerPath(repoPath, undefined);
    appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_issue_scout', {
      skipped: [{
        candidateKey: 'docs tests tooling add docs and tests in backoff',
        retryAfter: '2026-07-28T02:00:00.000Z',
      }],
    }, new Date('2026-07-28T00:00:00.000Z')));

    await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [source('Add docs and tests in backoff')],
      existingWork: [],
      now: new Date('2026-07-28T01:00:00.000Z'),
    });
    await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [source('Duplicate docs candidate')],
      existingWork: [{ title: 'Duplicate docs candidate', issueNumber: 42 }],
      now: new Date('2026-07-28T03:00:00.000Z'),
    });
    const riskyDuplicate = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [riskySource('Duplicate product-policy candidate')],
      existingWork: [{ title: 'Duplicate product-policy candidate', issueNumber: 43 }],
      now: new Date('2026-07-28T03:30:00.000Z'),
    });
    await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [source('Eligible low risk docs candidate')],
      existingWork: [],
      now: new Date('2026-07-28T04:00:00.000Z'),
    });

    expect(riskyDuplicate.skipped[0]?.stopRule).toBe('Duplicate or already covered');
    expect(readFileSync(ledgerPath, 'utf8')).not.toContain('devloop_decision_requested');
  });

  it('turns safe dependency report JSON into lane evidence and verification', async () => {
    mkdirSync(join(repoPath, '.devloop'), { recursive: true });
    writeFileSync(join(repoPath, '.devloop', 'dependency-report.json'), JSON.stringify({
      title: 'Patch semver advisory',
      summary: 'Patch dependency update from advisory evidence',
      currentVersion: '7.6.2',
      targetVersion: '7.6.3',
      changelogUrls: ['https://example.com/semver/changelog'],
      advisoryUrls: ['https://example.com/advisories/CVE-2026-0001'],
      verificationCommand: 'npm test -- dependency-report',
    }), 'utf-8');

    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sourceIds: ['dependency_report'],
      existingWork: [],
      dryRun: true,
      createIssues: true,
      now: new Date('2026-07-05T00:00:00.000Z'),
    });

    expect(report.selected).toHaveLength(1);
    expect(report.wouldCreate[0]?.body).toContain('updateKind=patch');
    expect(report.wouldCreate[0]?.body).toContain('changelog=https://example.com/semver/changelog');
    expect(report.wouldCreate[0]?.body).toContain('advisory=https://example.com/advisories/CVE-2026-0001');
    expect(report.wouldCreate[0]?.body).toContain('`npm test -- dependency-report`');
  });

  it('requires benchmark evidence for performance lane candidates', async () => {
    mkdirSync(join(repoPath, '.devloop'), { recursive: true });
    writeFileSync(join(repoPath, '.devloop', 'benchmark-report.json'), JSON.stringify({
      title: 'Reduce planner latency regression',
      summary: 'Benchmark p95 latency regressed in devloop planner',
      baselineMetric: 'p95=420ms',
      targetMetric: 'p95<=320ms',
      verificationCommand: 'npm test -- planner-benchmark',
    }), 'utf-8');

    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sourceIds: ['benchmark_report'],
      existingWork: [],
      dryRun: true,
      createIssues: true,
      now: new Date('2026-07-05T00:00:00.000Z'),
    });

    expect(report.selected).toHaveLength(1);
    expect(report.wouldCreate[0]?.body).toContain('baseline=p95=420ms');
    expect(report.wouldCreate[0]?.body).toContain('target=p95<=320ms');
    expect(report.wouldCreate[0]?.body).toContain('Include before/after performance evidence');
  });

  it('creates recursive feature-improvement follow-up candidates from ledger evidence', async () => {
    const ledgerPath = resolveDevloopLedgerPath(repoPath, undefined);
    appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_follow_up_evidence', {
      title: 'Improve approval inbox empty state',
      summary: 'Accepted UX test shows the empty state is unclear after all PRs are merged',
      lane: 'feature_improvement',
      evidence: 'tests/approval-inbox-empty-state.test.ts',
      verificationCommand: 'npm test -- approval-inbox-empty-state',
    }, new Date('2026-07-05T00:00:00.000Z')));

    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sourceIds: ['ledger_events'],
      existingWork: [],
      dryRun: true,
      createIssues: true,
      now: new Date('2026-07-05T00:10:00.000Z'),
    });

    expect(report.selected[0]?.candidate.lane).toBe('feature_improvement');
    expect(report.wouldCreate[0]?.title).toBe('Improve approval inbox empty state');
    expect(report.wouldCreate[0]?.body).toContain('tests/approval-inbox-empty-state.test.ts');
    expect(report.wouldCreate[0]?.body).toContain('`npm test -- approval-inbox-empty-state`');
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
