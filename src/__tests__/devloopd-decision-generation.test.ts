import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDecisionForIssueScoutCandidate } from '../devloopd/decisionGeneration.js';
import { createDecisionRequest } from '../devloopd/decisionRequest.js';
import { DecisionStore, DecisionStoreError } from '../devloopd/decisionStore.js';
import type { IssueScoutCandidate } from '../devloopd/issueScout.js';

function candidate(
  policyCategory: IssueScoutCandidate['policyCategory'] = 'product_policy',
  riskBucket: IssueScoutCandidate['riskBucket'] = 'medium',
): IssueScoutCandidate {
  return {
    id: 'local_backlog:choose-release-policy',
    sourceId: 'local_backlog',
    title: 'Choose the public release policy',
    summary: 'The candidate would change which users receive preview builds.',
    lane: 'feature_improvement',
    policyCategory,
    riskBucket,
    evidence: [{
      kind: 'file',
      path: '/Users/private/worktree/SECRET.md',
      url: 'file:///Users/private/worktree/SECRET.md',
      summary: 'Release requirements from token=hidden',
    }],
    acceptanceCriteria: [
      'Preserve the existing stable-channel promise.',
      'Add tests for preview eligibility.',
    ],
    verificationCommands: ['npm test -- release-policy'],
    escalationCriteria: ['Escalate changes to public product commitments.'],
    expectedChangedSurfaces: ['release policy', '/Users/private/internal.ts'],
    labels: ['lane:feature-improvement'],
    laneEvidence: ['policy=preview-release', 'source=/Users/private/source.json'],
  };
}

describe('ensureDecisionForIssueScoutCandidate', () => {
  let repoPath: string;
  let store: DecisionStore;

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-decision-generation-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
    store = new DecisionStore(repoPath);
  });

  afterEach(() => {
    if (existsSync(repoPath)) {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('creates a concrete three-option product-policy decision', () => {
    const projection = ensureDecisionForIssueScoutCandidate(
      store,
      candidate(),
      {
        repoPath,
        repository: 'albert-einshutoin/takt-private',
      },
      new Date('2026-07-28T00:00:00.000Z'),
    );

    expect(projection.status).toBe('open');
    expect(projection.request).toMatchObject({
      kind: 'choice',
      subject: {
        repository: 'albert-einshutoin/takt-private',
        candidateId: 'local_backlog:choose-release-policy',
        title: 'Choose the public release policy',
      },
      why: {
        riskCategory: 'product_policy',
      },
      answerRequirements: {
        rationaleRequired: true,
      },
      resumeGuard: {
        strategy: 'issue_scout_candidate',
        candidateId: 'local_backlog:choose-release-policy',
      },
    });
    expect(projection.request.question).toContain('Choose the public release policy');
    expect(projection.request.why.reasons.join('\n')).toContain('product_policy');
    expect(projection.request.why.reasons.join('\n')).toContain('medium');
    expect(projection.request.why.evidence.map((item) => item.summary).join('\n'))
      .toContain('Preserve the existing stable-channel promise.');
    expect(projection.request.kind === 'choice'
      ? projection.request.options.map((option) => option.id)
      : []).toEqual(['approve_scope', 'revise_scope', 'skip']);
    expect(projection.request.how.summary).toContain('Issue Scout');
    expect(projection.request.how.verification).toContain('npm test -- release-policy');
  });

  it.each([
    ['human_policy', 'medium', 'human_policy'],
    ['auto_recursive', 'high', 'high_risk'],
  ] as const)('maps %s/%s candidates to %s', (policyCategory, riskBucket, expected) => {
    const projection = ensureDecisionForIssueScoutCandidate(
      store,
      candidate(policyCategory, riskBucket),
      { repoPath },
      new Date('2026-07-28T00:00:00.000Z'),
    );

    expect(projection.request.why.riskCategory).toBe(expected);
    if (riskBucket === 'high' && projection.request.kind === 'choice') {
      expect(projection.request.options.filter((option) => option.recommended)).toHaveLength(1);
      expect(projection.request.options.find((option) => option.recommended)?.id).not.toBe('approve_scope');
    }
  });

  it.each([
    ['auto_recursive'],
    ['mechanical'],
  ] as const)('rejects a low-risk %s candidate before writing the ledger', (policyCategory) => {
    expect(() => ensureDecisionForIssueScoutCandidate(
      store,
      candidate(policyCategory, 'low'),
      { repoPath },
      new Date('2026-07-28T00:00:00.000Z'),
    )).toThrowError(expect.objectContaining({
      name: 'DecisionGenerationError',
      code: 'candidate_not_escalated',
    }));
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it('deduplicates scheduler ticks with a deterministic decision ID', () => {
    const first = ensureDecisionForIssueScoutCandidate(
      store,
      candidate(),
      { repoPath },
      new Date('2026-07-28T00:00:00.000Z'),
    );
    const second = ensureDecisionForIssueScoutCandidate(
      store,
      candidate(),
      { repoPath },
      new Date('2026-07-28T01:00:00.000Z'),
    );

    expect(second.request.decisionId).toBe(first.request.decisionId);
    expect(second.request.contextHash).toBe(first.request.contextHash);
    const requestedLines = readFileSync(store.ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { eventType: string })
      .filter((event) => event.eventType === 'devloop_decision_requested');
    expect(requestedLines).toHaveLength(1);
  });

  it('converges when another caller persists the same request immediately before a conflict', () => {
    const originalRequest = store.request.bind(store);
    let wrappedCalls = 0;
    store.request = (request, options) => {
      wrappedCalls += 1;
      originalRequest(request, options);
      throw new DecisionStoreError('request_conflict');
    };

    const projection = ensureDecisionForIssueScoutCandidate(
      store,
      candidate(),
      { repoPath },
      new Date('2026-07-28T00:00:00.000Z'),
    );

    expect(wrappedCalls).toBe(1);
    expect(projection.status).toBe('open');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.request.contextHash).toBe(projection.request.contextHash);
  });

  it('fails closed when the deterministic ID is occupied by a different context', () => {
    const targetRepoPath = join(repoPath, 'target-context');
    mkdirSync(targetRepoPath, { recursive: true });
    const target = ensureDecisionForIssueScoutCandidate(
      new DecisionStore(targetRepoPath),
      candidate(),
      { repoPath: targetRepoPath },
      new Date('2026-07-28T00:00:00.000Z'),
    );
    const existing = createDecisionRequest({
      kind: 'text',
      subject: {
        repoPath,
        runSlug: 'unrelated-run',
        title: 'Unrelated run decision',
      },
      question: 'Describe how the unrelated run should proceed.',
      why: {
        summary: 'An unrelated run needs clarification.',
        riskCategory: 'requirements_ambiguity',
        reasons: ['The unrelated run has incomplete requirements.'],
        evidence: [],
      },
      how: {
        summary: 'Resume only the unrelated run.',
        expectedEffects: ['The unrelated run plan is updated.'],
        verification: ['Verify the unrelated run context.'],
      },
      answerRequirements: {
        rationaleRequired: false,
        minimumTextLength: 1,
        maximumTextLength: 2_000,
      },
      resumeGuard: {
        strategy: 'direct_run',
        expectedDecisionVersion: 1,
        runSlug: 'unrelated-run',
        expectedRunStatus: 'blocked',
      },
    }, {
      decisionId: target.request.decisionId,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    store.request(existing, { now: new Date('2026-07-28T00:00:00.000Z') });

    expect(() => ensureDecisionForIssueScoutCandidate(
      store,
      candidate(),
      { repoPath },
      new Date('2026-07-28T01:00:00.000Z'),
    )).toThrowError(expect.objectContaining({
      code: 'request_conflict',
    }));
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.request.contextHash).toBe(existing.contextHash);
    expect(store.list()[0]?.request.subject.candidateId).toBeUndefined();
  });

  it('sanitizes paths and secrets without persisting executable guard payloads', () => {
    const projection = ensureDecisionForIssueScoutCandidate(
      store,
      candidate(),
      { repoPath },
      new Date('2026-07-28T00:00:00.000Z'),
    );
    const serialized = JSON.stringify(projection.request);

    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('hidden');
    expect(serialized).not.toContain('"command"');
    expect(serialized).not.toContain('"args"');
    expect(serialized).toContain('[LOCAL_PATH]');
  });
});
