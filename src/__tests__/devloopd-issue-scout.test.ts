import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
  ISSUE_SCOUT_MAX_BATCH_BYTES,
  ISSUE_SCOUT_MAX_CANDIDATES,
  measureIssueScoutCandidateBatchBytes,
  runIssueScout,
  scoreIssueScoutCandidate,
  type IssueScoutSource,
} from '../devloopd/issueScout.js';
import type { DevloopCommandRunner } from '../devloopd/commandRunner.js';
import { DecisionStore, DecisionStoreError } from '../devloopd/decisionStore.js';
import {
  createDecisionAppliedEvent,
  createDecisionApplyStartedEvent,
} from '../devloopd/decisionEvents.js';

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

  it.each([16 * 1024, 32 * 1024])(
    'bounds direct %i-character candidate input before classification and sanitization',
    (length) => {
      const secretTail = 'direct-tail-secret';
      const raw = `${'a'.repeat(length)}tokenlike-${secretTail}`;
      const startedAt = performance.now();
      const candidate = buildIssueScoutCandidate({
        sourceId: 'local_backlog',
        title: raw,
        summary: raw,
        lane: 'docs_tests_tooling',
      });
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeLessThan(2_000);
      expect(candidate.title.length).toBeLessThanOrEqual(4_000);
      expect(candidate.summary.length).toBeLessThanOrEqual(4_000);
      expect(candidate.id.length).toBeLessThan(128);
      expect(candidate.policyCategory).toBe('human_policy');
      expect(candidate.riskBucket).toBe('high');
      expect(candidate.escalationCriteria).toContain(
        'Source evidence was truncated or omitted; inspect the original source.',
      );
      expect(JSON.stringify(candidate)).not.toContain(secretTail);
    },
  );

  it('routes a truncated direct docs candidate to a human decision', async () => {
    const secretTail = 'auth migration public api direct-tail-secret';
    const candidate = buildIssueScoutCandidate({
      sourceId: 'local_backlog',
      title: `docs ${'a'.repeat(4_100)} ${secretTail}`,
      summary: 'Small documentation update',
      lane: 'docs_tests_tooling',
      policyCategory: 'mechanical',
      riskBucket: 'low',
    });
    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [{
        id: 'local_backlog',
        scan: () => ({
          sourceId: 'local_backlog',
          status: 'success',
          summary: 'truncated direct fixture',
          candidates: [candidate],
          nextActions: [],
          artifacts: [],
        }),
      }],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const ledger = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8');

    expect(report.selected).toHaveLength(0);
    expect(report.skipped[0]).toMatchObject({
      stopRule: 'Unsafe or too broad',
      decisionId: expect.stringMatching(/^dec_[a-f0-9]{64}$/u),
    });
    expect(ledger).not.toContain(secretTail);
    expect(ledger).not.toContain(createHash('sha256').update(secretTail).digest('hex'));
  });

  it('redacts bounded sensitive assignments in direct candidate input', () => {
    const candidate = buildIssueScoutCandidate({
      sourceId: 'local_backlog',
      title: 'Rotate token=bounded-secret safely',
      summary: 'password=bounded-password',
      lane: 'docs_tests_tooling',
    });

    expect(candidate.title).toContain('token=[REDACTED]');
    expect(candidate.summary).toContain('password=[REDACTED]');
    expect(JSON.stringify(candidate)).not.toContain('bounded-secret');
    expect(JSON.stringify(candidate)).not.toContain('bounded-password');
  });

  it.each([16 * 1024, 32 * 1024])(
    'bounds a %i-character BACKLOG line before source sanitization',
    async (length) => {
      const secretTail = 'backlog-tail-secret';
      writeFileSync(
        join(repoPath, 'BACKLOG.md'),
        `- [ ] ${'a'.repeat(length)}tokenlike-${secretTail}\n`,
        'utf8',
      );
      const startedAt = performance.now();
      const report = await runIssueScout({
        repoPath,
        runner: runner(),
        sourceIds: ['local_backlog'],
        backlogFiles: ['BACKLOG.md'],
        existingWork: [],
        dryRun: true,
        now: new Date('2026-07-28T00:00:00.000Z'),
      });
      const elapsedMs = performance.now() - startedAt;
      const ledger = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8');

      expect(elapsedMs).toBeLessThan(2_000);
      const candidate = report.observations[0]?.candidates[0];
      expect(candidate?.title.length).toBeLessThanOrEqual(4_000);
      expect(candidate).toMatchObject({
        policyCategory: 'human_policy',
        riskBucket: 'high',
      });
      expect(report.selected).toHaveLength(0);
      expect(report.skipped[0]?.stopRule).toBe('Unsafe or too broad');
      expect(JSON.stringify(report.observations)).not.toContain(secretTail);
      expect(ledger).not.toContain(secretTail);
      expect(ledger).not.toContain(createHash('sha256').update(secretTail).digest('hex'));
    },
  );

  it.each(['field', 'fallback'] as const)(
    'bounds token-like report %s text before sanitization',
    async (variant) => {
      const secretTail = `report-${variant}-tail-secret`;
      const raw = `${'a'.repeat(32 * 1024)}tokenlike-${secretTail}`;
      mkdirSync(join(repoPath, '.devloop'), { recursive: true });
      writeFileSync(
        join(repoPath, '.devloop', 'dependency-report.json'),
        variant === 'field'
          ? JSON.stringify({ title: 'Bound report field', summary: raw })
          : raw,
        'utf8',
      );
      const startedAt = performance.now();
      const report = await runIssueScout({
        repoPath,
        runner: runner(),
        sourceIds: ['dependency_report'],
        existingWork: [],
        dryRun: true,
        now: new Date('2026-07-28T00:00:00.000Z'),
      });
      const elapsedMs = performance.now() - startedAt;
      const ledger = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8');

      expect(elapsedMs).toBeLessThan(1_000);
      const candidate = report.observations[0]?.candidates[0];
      expect(candidate?.summary.length).toBeLessThanOrEqual(4_000);
      expect(candidate).toMatchObject({
        policyCategory: 'human_policy',
        riskBucket: 'high',
      });
      expect(report.selected).toHaveLength(0);
      expect(report.skipped[0]?.stopRule).toBe('Unsafe or too broad');
      expect(JSON.stringify(report.observations)).not.toContain(secretTail);
      expect(ledger).not.toContain(secretTail);
    },
  );

  it('samples oversized report arrays without iterating secret-bearing tails', async () => {
    const secretTail = 'report-array-tail-secret';
    mkdirSync(join(repoPath, '.devloop'), { recursive: true });
    writeFileSync(
      join(repoPath, '.devloop', 'dependency-report.json'),
      JSON.stringify({
        title: 'Bound report array',
        summary: 'Bound a large changelog array',
        changelogUrls: [
          ...Array.from({ length: 9_999 }, (_, index) => `https://example.com/${index}`),
          `https://example.com/${secretTail}`,
        ],
      }),
      'utf8',
    );
    const startedAt = performance.now();
    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sourceIds: ['dependency_report'],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const elapsedMs = performance.now() - startedAt;
    const candidate = report.observations[0]?.candidates[0];
    const ledger = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8');

    expect(elapsedMs).toBeLessThan(2_000);
    expect(candidate?.laneEvidence.length).toBeLessThanOrEqual(50);
    expect(candidate?.laneEvidence.some((value) => value.includes('[OMITTED 9951 ITEMS]'))).toBe(true);
    expect(candidate).toMatchObject({
      policyCategory: 'human_policy',
      riskBucket: 'high',
    });
    expect(report.skipped[0]?.stopRule).toBe('Unsafe or too broad');
    expect(JSON.stringify(candidate)).not.toContain(secretTail);
    expect(ledger).not.toContain(secretTail);
  });

  it('escalates truncated ledger fields without persisting their raw tail', async () => {
    const secretTail = 'ledger-auth-migration-public-api-tail';
    const ledgerPath = resolveDevloopLedgerPath(repoPath, undefined);
    appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_follow_up_evidence', {
      title: 'Small docs follow-up',
      summary: `docs ${'a'.repeat(4_100)} ${secretTail}`,
      lane: 'docs_tests_tooling',
    }, new Date('2026-07-28T00:00:00.000Z')));

    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sourceIds: ['ledger_events'],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T00:01:00.000Z'),
    });
    const candidate = report.observations[0]?.candidates[0];
    const ledger = readFileSync(ledgerPath, 'utf8');

    expect(candidate).toMatchObject({
      policyCategory: 'human_policy',
      riskBucket: 'high',
    });
    expect(report.selected).toHaveLength(0);
    expect(report.skipped[0]?.stopRule).toBe('Unsafe or too broad');
    const newlyAppendedEvents = ledger.split('\n').slice(1).join('\n');
    expect(newlyAppendedEvents).not.toContain(secretTail);
    expect(newlyAppendedEvents).not.toContain(
      createHash('sha256').update(secretTail).digest('hex'),
    );
  });

  it('keeps complete bounded docs candidates mechanical and low risk', () => {
    const candidate = buildIssueScoutCandidate({
      sourceId: 'local_backlog',
      title: 'Update contributor documentation',
      summary: 'Clarify the existing local test instructions.',
      lane: 'docs_tests_tooling',
    });

    expect(candidate).toMatchObject({
      policyCategory: 'mechanical',
      riskBucket: 'low',
    });
    expect(candidate.escalationCriteria).not.toContain(
      'Source evidence was truncated or omitted; inspect the original source.',
    );
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

  it.each([
    ['approve_scope', 'approved'],
    ['revise_scope', 'human revision requested'],
    ['skip', 'human decision skipped'],
  ] as const)('routes applied %s outcomes as %s without another request', async (optionId, expected) => {
    const title = `Route terminal ${optionId} candidate`;
    const first = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [riskySource(title)],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const decisionId = first.skipped[0]?.decisionId;
    if (decisionId === undefined) throw new Error('decision missing');
    const store = new DecisionStore(repoPath);
    const projection = store.get(decisionId);
    if (projection === undefined) throw new Error('projection missing');
    const answer = store.answer({
      decisionId,
      expectedDecisionVersion: projection.request.decisionVersion,
      expectedContextHash: projection.request.contextHash,
      value: { optionId },
      rationale: `Route ${optionId}.`,
      idempotencyKey: `answer-${optionId}`,
    }, 'reviewer', {
      eventId: `evt-answer-${optionId}`,
      now: new Date('2026-07-28T00:01:00.000Z'),
    });
    const identity = {
      decisionId,
      decisionVersion: projection.request.decisionVersion,
      contextHash: projection.request.contextHash,
      answerEventId: answer.eventId,
      sanitizedSummary: `Applied ${optionId}.`,
    };
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionApplyStartedEvent(identity, {
      eventId: `evt-start-${optionId}`,
      now: new Date('2026-07-28T00:02:00.000Z'),
    }));
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionAppliedEvent(identity, {
      eventId: `evt-applied-${optionId}`,
      now: new Date('2026-07-28T00:03:00.000Z'),
    }));

    const second = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [riskySource(title)],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T01:00:00.000Z'),
    });
    const requestedCount = readFileSync(store.ledgerPath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"eventType":"devloop_decision_requested"'))
      .length;

    expect(requestedCount).toBe(1);
    if (optionId === 'approve_scope') {
      expect(second.selected).toHaveLength(1);
      expect(second.wouldCreate).toHaveLength(1);
      expect(second.skipped).toHaveLength(0);
    } else {
      expect(second.selected).toHaveLength(0);
      expect(second.skipped[0]).toMatchObject({
        stopRule: expected,
        decisionId,
      });
      expect(formatIssueScoutReport(second)).not.toContain('Unsafe or too broad');
    }
  });

  it('isolates an invalid later candidate and still records the final scout summary', async () => {
    const valid = buildIssueScoutCandidate({
      sourceId: 'local_backlog',
      title: 'Valid product decision',
      summary: 'A valid product-policy decision candidate',
      lane: 'feature_improvement',
      policyCategory: 'product_policy',
      riskBucket: 'high',
    });
    const invalid = {
      ...buildIssueScoutCandidate({
        sourceId: 'local_backlog',
        title: 'Invalid product decision',
        summary: 'An invalid product-policy decision with token=supersecret',
        lane: 'feature_improvement',
        policyCategory: 'product_policy',
        riskBucket: 'high',
      }),
      laneEvidence: Array.from({ length: 49 }, (_, index) => `lane-${index}`),
    };
    const multiSource: IssueScoutSource = {
      id: 'local_backlog',
      scan: () => ({
        sourceId: 'local_backlog',
        status: 'success',
        summary: 'multiple candidates',
        candidates: [valid, invalid],
        nextActions: [],
        artifacts: [],
      }),
    };

    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [multiSource],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const ledger = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8');

    expect(report.passed).toBe(false);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped[0]?.decisionId).toBeDefined();
    expect(report.skipped[1]).toMatchObject({
      stopRule: 'decision generation failed',
    });
    expect(report.skipped[1]?.decisionId).toBeUndefined();
    expect(ledger.match(/"eventType":"devloop_decision_requested"/gu)).toHaveLength(1);
    expect(ledger.match(/"eventType":"devloop_issue_scout"/gu)).toHaveLength(1);
    expect(ledger).not.toContain('supersecret');
  });

  it('reuses one DecisionStore for multiple risky candidates', async () => {
    const first = buildIssueScoutCandidate({
      sourceId: 'local_backlog',
      title: 'First risky candidate',
      summary: 'First product-policy decision',
      lane: 'feature_improvement',
      policyCategory: 'product_policy',
      riskBucket: 'high',
    });
    const second = buildIssueScoutCandidate({
      sourceId: 'local_backlog',
      title: 'Second risky candidate',
      summary: 'Second product-policy decision',
      lane: 'feature_improvement',
      policyCategory: 'product_policy',
      riskBucket: 'high',
    });
    const instances = new Set<DecisionStore>();
    const originalGet = DecisionStore.prototype.get;
    DecisionStore.prototype.get = function getWithInstance(decisionId) {
      instances.add(this);
      return originalGet.call(this, decisionId);
    };
    try {
      await runIssueScout({
        repoPath,
        runner: runner(),
        sources: [{
          id: 'local_backlog',
          scan: () => ({
            sourceId: 'local_backlog',
            status: 'success',
            summary: 'two risky candidates',
            candidates: [first, second],
            nextActions: [],
            artifacts: [],
          }),
        }],
        existingWork: [],
        dryRun: true,
        now: new Date('2026-07-28T00:00:00.000Z'),
      });
    } finally {
      DecisionStore.prototype.get = originalGet;
    }

    expect(instances).toHaveLength(1);
  });

  it('isolates a DecisionStore capacity failure and records the scout summary', async () => {
    const originalRequest = DecisionStore.prototype.request;
    DecisionStore.prototype.request = () => {
      throw new DecisionStoreError('ledger_capacity_exceeded');
    };
    let report: Awaited<ReturnType<typeof runIssueScout>> | undefined;
    try {
      report = await runIssueScout({
        repoPath,
        runner: runner(),
        sources: [riskySource('Capacity constrained candidate')],
        existingWork: [],
        dryRun: true,
        now: new Date('2026-07-28T00:00:00.000Z'),
      });
    } finally {
      DecisionStore.prototype.request = originalRequest;
    }
    if (report === undefined) throw new Error('report missing');
    const ledger = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8');

    expect(report.passed).toBe(false);
    expect(report.skipped[0]).toMatchObject({
      stopRule: 'decision generation failed',
      reason: 'decision generation failed: ledger_capacity_exceeded',
    });
    expect(ledger).toContain('"eventType":"devloop_issue_scout"');
    expect(ledger).not.toContain('"eventType":"devloop_decision_requested"');
  });

  it.each([
    ['at limit', ISSUE_SCOUT_MAX_CANDIDATES, true],
    ['over limit', ISSUE_SCOUT_MAX_CANDIDATES + 1, false],
  ] as const)('bounds the candidate count %s before decision writes', async (_case, count, accepted) => {
    const candidates = Array.from({ length: count }, (_, index) => buildIssueScoutCandidate({
      sourceId: 'local_backlog',
      title: `Bounded docs candidate ${index}`,
      summary: 'Small documentation candidate',
      lane: 'docs_tests_tooling',
    }));
    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [{
        id: 'local_backlog',
        scan: () => ({
          sourceId: 'local_backlog',
          status: 'success',
          summary: 'candidate count boundary',
          candidates,
          nextActions: [],
          artifacts: [],
        }),
      }],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const ledger = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8');

    expect(report.passed).toBe(accepted);
    expect(report.batchFailure?.code).toBe(accepted ? undefined : 'candidate_count_exceeded');
    expect(ledger).not.toContain('"eventType":"devloop_decision_requested"');
  });

  it('rejects a sanitized aggregate just over the byte budget without partial processing', async () => {
    const baseCandidates = Array.from({ length: 100 }, (_, index) => buildIssueScoutCandidate({
      sourceId: 'local_backlog',
      title: `Aggregate byte boundary ${index}`,
      summary: '',
      lane: 'docs_tests_tooling',
    }));
    let remainingBytes = ISSUE_SCOUT_MAX_BATCH_BYTES
      - measureIssueScoutCandidateBatchBytes(baseCandidates);
    const atLimit = baseCandidates.map((candidate) => {
      const fill = Math.min(4_000, remainingBytes);
      remainingBytes -= fill;
      return { ...candidate, summary: 'x'.repeat(fill) };
    });
    expect(remainingBytes).toBe(0);
    expect(measureIssueScoutCandidateBatchBytes(atLimit)).toBe(ISSUE_SCOUT_MAX_BATCH_BYTES);
    const expandableIndex = atLimit.findIndex((candidate) => candidate.summary.length < 4_000);
    const overLimit = atLimit.map((candidate, index) => (
      index === expandableIndex
        ? { ...candidate, summary: `${candidate.summary}x` }
        : candidate
    ));

    const exactReport = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [{
        id: 'local_backlog',
        scan: () => ({
          sourceId: 'local_backlog',
          status: 'success',
          summary: 'aggregate exact boundary',
          candidates: atLimit,
          nextActions: [],
          artifacts: [],
        }),
      }],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-27T23:00:00.000Z'),
    });
    expect(exactReport.batchFailure).toBeUndefined();

    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [{
        id: 'local_backlog',
        scan: () => ({
          sourceId: 'local_backlog',
          status: 'success',
          summary: 'aggregate byte boundary',
          candidates: overLimit,
          nextActions: [],
          artifacts: [],
        }),
      }],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const ledger = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8');

    expect(report).toMatchObject({
      passed: false,
      batchFailure: {
        code: 'candidate_bytes_exceeded',
        candidateCount: 100,
        candidateBytes: ISSUE_SCOUT_MAX_BATCH_BYTES + 1,
      },
    });
    expect(ledger).not.toContain('"eventType":"devloop_decision_requested"');
  });

  it('records one compact typed failure for 6000 invalid candidates', async () => {
    const secret = 'batch-secret-lowentropy';
    const candidates = Array.from({ length: 6_000 }, (_, index) => ({
      ...buildIssueScoutCandidate({
        sourceId: 'local_backlog',
        title: `Invalid ${secret} candidate ${index}`,
        summary: `token=${secret}`,
        lane: 'feature_improvement',
        policyCategory: 'product_policy',
        riskBucket: 'high',
      }),
      laneEvidence: Array.from({ length: 60 }, () => secret),
    }));

    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [{
        id: 'local_backlog',
        scan: () => ({
          sourceId: 'local_backlog',
          status: 'success',
          summary: `token=${secret}`,
          candidates,
          nextActions: [],
          artifacts: [],
        }),
      }],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const lines = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8')
      .trim()
      .split('\n');

    expect(report).toMatchObject({
      passed: false,
      batchFailure: {
        code: 'candidate_count_exceeded',
        candidateCount: 6_000,
      },
    });
    expect(report.message).toContain('candidate_count_exceeded');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThan(1024 * 1024);
    expect(lines[0]).toContain('"eventType":"devloop_issue_scout"');
    expect(lines[0]).not.toContain(secret);
    expect(lines[0]).not.toContain('"eventType":"devloop_decision_requested"');
  });

  it('derives batch summary digests only from non-secret structural fields', async () => {
    const run = async (secret: string, suffix: string) => {
      const isolatedRepo = join(repoPath, suffix);
      mkdirSync(isolatedRepo, { recursive: true });
      const candidates = Array.from(
        { length: ISSUE_SCOUT_MAX_CANDIDATES + 1 },
        (_, index) => buildIssueScoutCandidate({
          sourceId: 'local_backlog',
          title: `${secret} candidate ${index}`,
          summary: secret,
          lane: 'docs_tests_tooling',
        }),
      );
      await runIssueScout({
        repoPath: isolatedRepo,
        runner: runner(),
        sources: [{
          id: 'local_backlog',
          scan: () => ({
            sourceId: 'local_backlog',
            status: 'success',
            summary: secret,
            candidates,
            nextActions: [],
            artifacts: [],
          }),
        }],
        existingWork: [],
        dryRun: true,
        now: new Date('2026-07-28T00:00:00.000Z'),
      });
      const line = readFileSync(resolveDevloopLedgerPath(isolatedRepo, undefined), 'utf8').trim();
      return {
        line,
        event: JSON.parse(line) as { summaryDigest: string },
      };
    };
    const first = await run('dictionary-secret-one', 'first');
    const second = await run('dictionary-secret-two', 'second');

    expect(first.event.summaryDigest).toBe(second.event.summaryDigest);
    for (const secret of ['dictionary-secret-one', 'dictionary-secret-two']) {
      expect(`${first.line}\n${second.line}`).not.toContain(secret);
      expect(`${first.line}\n${second.line}`).not.toContain(
        createHash('sha256').update(secret, 'utf8').digest('hex'),
      );
    }
  });

  it.each([32 * 1024, 64 * 1024])(
    'preflights %i-character token-bearing fields before sanitization',
    async (length) => {
      const secret = 'dictionary-token-value';
      const oversized = `${'a'.repeat(length / 2)}token=${secret}${'a'.repeat(length / 2)}`;
      const base = buildIssueScoutCandidate({
        sourceId: 'local_backlog',
        title: 'Raw preflight candidate',
        summary: 'bounded fixture',
        lane: 'feature_improvement',
        policyCategory: 'product_policy',
        riskBucket: 'high',
      });
      const candidates = Array.from({ length: 4 }, (_, index) => ({
        ...base,
        id: `${base.id}-${index}`,
        summary: oversized,
      }));
      const startedAt = performance.now();
      const report = await runIssueScout({
        repoPath,
        runner: runner(),
        sources: [{
          id: 'local_backlog',
          scan: () => ({
            sourceId: 'local_backlog',
            status: 'success',
            summary: 'raw preflight fixture',
            candidates,
            nextActions: [],
            artifacts: [],
          }),
        }],
        existingWork: [],
        dryRun: true,
        now: new Date('2026-07-28T00:00:00.000Z'),
      });
      const elapsedMs = performance.now() - startedAt;
      const ledger = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8');

      expect(report).toMatchObject({
        passed: false,
        batchFailure: {
          code: 'candidate_invalid',
          candidateCount: 4,
        },
      });
      expect(elapsedMs).toBeLessThan(1_000);
      expect(ledger.split('\n').filter(Boolean)).toHaveLength(1);
      expect(ledger).not.toContain(secret);
      expect(ledger).not.toContain('"eventType":"devloop_decision_requested"');
    },
  );

  it('preflights oversized candidate arrays before sanitizing their elements', async () => {
    const secret = 'array-element-secret';
    const candidate = {
      ...buildIssueScoutCandidate({
        sourceId: 'local_backlog',
        title: 'Raw array preflight candidate',
        summary: 'bounded fixture',
        lane: 'feature_improvement',
        policyCategory: 'product_policy',
        riskBucket: 'high',
      }),
      laneEvidence: Array.from({ length: 51 }, () => `token=${secret}`),
    };

    const report = await runIssueScout({
      repoPath,
      runner: runner(),
      sources: [{
        id: 'local_backlog',
        scan: () => ({
          sourceId: 'local_backlog',
          status: 'success',
          summary: 'raw array preflight fixture',
          candidates: [candidate],
          nextActions: [],
          artifacts: [],
        }),
      }],
      existingWork: [],
      dryRun: true,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const ledger = readFileSync(resolveDevloopLedgerPath(repoPath, undefined), 'utf8');

    expect(report.batchFailure?.code).toBe('candidate_invalid');
    expect(ledger).not.toContain(secret);
    expect(ledger).not.toContain('"eventType":"devloop_decision_requested"');
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
