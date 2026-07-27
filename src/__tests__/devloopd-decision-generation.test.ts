import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyIssueScoutDecision,
  ensureDecisionForAutomationAction,
  ensureDecisionForAutomationActions,
  ensureDecisionForIssueScoutCandidate,
  isAutomationActionDecisionEligible,
} from '../devloopd/decisionGeneration.js';
import { createDecisionRequest } from '../devloopd/decisionRequest.js';
import { DecisionStore, DecisionStoreError } from '../devloopd/decisionStore.js';
import {
  createDecisionAppliedEvent,
  createDecisionApplyStartedEvent,
} from '../devloopd/decisionEvents.js';
import { appendDevloopLedgerEvent } from '../devloopd/ledger.js';
import type { IssueScoutCandidate } from '../devloopd/issueScout.js';
import type { DevloopAutomationAction } from '../devloopd/prAutomation.js';

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

  function applyDecision(optionId: 'approve_scope' | 'revise_scope' | 'skip') {
    const projection = ensureDecisionForIssueScoutCandidate(
      store,
      candidate(),
      { repoPath },
      new Date('2026-07-28T00:00:00.000Z'),
    );
    const answer = store.answer({
      decisionId: projection.request.decisionId,
      expectedDecisionVersion: projection.request.decisionVersion,
      expectedContextHash: projection.request.contextHash,
      value: { optionId },
      rationale: `Choose ${optionId} for this candidate.`,
      idempotencyKey: `answer-${optionId}`,
    }, 'reviewer', {
      eventId: `evt-answer-${optionId}`,
      now: new Date('2026-07-28T00:01:00.000Z'),
    });
    const identity = {
      decisionId: projection.request.decisionId,
      decisionVersion: projection.request.decisionVersion,
      contextHash: projection.request.contextHash,
      answerEventId: answer.eventId,
      sanitizedSummary: `Applied ${optionId}.`,
    };
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionApplyStartedEvent(identity, {
      eventId: `evt-start-${optionId}`,
      now: new Date('2026-07-28T00:02:00.000Z'),
    }));
    const applying = store.get(projection.request.decisionId);
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionAppliedEvent(identity, {
      eventId: `evt-applied-${optionId}`,
      now: new Date('2026-07-28T00:03:00.000Z'),
    }));
    const applied = store.get(projection.request.decisionId);
    if (applying === undefined || applied === undefined) throw new Error('projection missing');
    return { projection, applying, applied };
  }

  it.each([
    ['approve_scope', 'approved'],
    ['revise_scope', 'revision_requested'],
    ['skip', 'skipped'],
  ] as const)('classifies applied %s decisions as %s', (optionId, expected) => {
    const { projection, applying, applied } = applyDecision(optionId);

    expect(classifyIssueScoutDecision(projection)).toBe('pending');
    expect(classifyIssueScoutDecision(applying)).toBe('pending');
    expect(classifyIssueScoutDecision(applied)).toBe(expected);
  });

  it('creates a concrete three-option product-policy decision', () => {
    const projection = ensureDecisionForIssueScoutCandidate(
      store,
      candidate(),
      {
        repoPath: store.repoPath,
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

  it('rejects candidates whose generated reason list exceeds the schema bound', () => {
    const oversized = {
      ...candidate(),
      laneEvidence: Array.from({ length: 49 }, (_, index) => `evidence-${index}`),
    };

    expect(() => ensureDecisionForIssueScoutCandidate(
      store,
      oversized,
      { repoPath },
      new Date('2026-07-28T00:00:00.000Z'),
    )).toThrowError(expect.objectContaining({
      name: 'DecisionGenerationError',
      code: 'candidate_invalid',
    }));
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it.each([
    ['single text bound', {
      ...candidate(),
      summary: 'x'.repeat(4_001),
    }],
    ['aggregate UTF-8 bound', {
      ...candidate(),
      labels: Array.from({ length: 50 }, () => 'あ'.repeat(4_000)),
    }],
  ])('rejects candidates beyond the %s', (_case, invalidCandidate) => {
    expect(() => ensureDecisionForIssueScoutCandidate(
      store,
      invalidCandidate,
      { repoPath },
      new Date('2026-07-28T00:00:00.000Z'),
    )).toThrowError(expect.objectContaining({
      code: 'candidate_invalid',
    }));
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it('keeps safe references and replaces unsafe references with opaque digests', () => {
    const withReferences = {
      ...candidate(),
      evidence: [
        {
          kind: 'file' as const,
          path: 'docs/release-policy.md',
          summary: 'Repository policy file',
        },
        {
          kind: 'github' as const,
          url: 'https://user:password@github.com/albert-einshutoin/takt-private/issues/42?token=secret#note',
          summary: 'Tracked GitHub issue',
        },
        {
          kind: 'file' as const,
          path: '/Users/private/secret.txt',
          summary: 'External file reference',
        },
      ],
    };

    const projection = ensureDecisionForIssueScoutCandidate(
      store,
      withReferences,
      { repoPath },
      new Date('2026-07-28T00:00:00.000Z'),
    );
    const serialized = JSON.stringify(projection.request.why.evidence);
    const references = projection.request.why.evidence.map((item) => item.reference);

    expect(references).toContain('docs/release-policy.md');
    expect(references).toContain('https://github.com/albert-einshutoin/takt-private/issues/42');
    expect(references.some((reference) => /^redacted-local_backlog-file-3-[a-f0-9]{64}$/u.test(reference))).toBe(true);
    expect(serialized).toContain('reference redacted');
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('user:password');
    expect(serialized).not.toContain('/Users/private');
  });

  it('does not derive opaque references from raw secret-bearing evidence', () => {
    const requestFor = (secret: string, path: string) => {
      const isolatedStore = new DecisionStore(join(repoPath, secret));
      return ensureDecisionForIssueScoutCandidate(
        isolatedStore,
        {
          ...candidate(),
          evidence: [{
            kind: 'file',
            path,
            url: `https://outside.example.invalid/report?token=${secret}`,
            summary: `token=${secret}\u0000 from ${path}`,
          }],
        },
        { repoPath: isolatedStore.repoPath },
        new Date('2026-07-28T00:00:00.000Z'),
      ).request.why.evidence[0];
    };
    const first = requestFor('lowentropy-one', '/Users/private/first-secret.txt');
    const second = requestFor('lowentropy-two', '/Users/private/second-secret.txt');
    const serialized = JSON.stringify([first, second]);
    const forbiddenDigests = [
      'lowentropy-one',
      'lowentropy-two',
      '/Users/private/first-secret.txt',
      '/Users/private/second-secret.txt',
    ].map((value) => createHash('sha256').update(value, 'utf8').digest('hex'));

    expect(first?.reference).toBe(second?.reference);
    expect(serialized).not.toContain('lowentropy-one');
    expect(serialized).not.toContain('lowentropy-two');
    expect(serialized).not.toContain('/Users/private');
    for (const digest of forbiddenDigests) expect(serialized).not.toContain(digest);
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

  it('uses deterministic lookup without scanning every decision projection', () => {
    let getCalls = 0;
    const originalGet = store.get.bind(store);
    store.get = (decisionId) => {
      getCalls += 1;
      return originalGet(decisionId);
    };

    ensureDecisionForIssueScoutCandidate(
      store,
      candidate(),
      { repoPath },
      new Date('2026-07-28T00:00:00.000Z'),
    );

    expect(getCalls).toBe(2);
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

describe('ensureDecisionForAutomationAction', () => {
  let repoPath: string;
  let store: DecisionStore;
  const headSha = '0123456789abcdef0123456789abcdef01234567';
  const context = () => ({
    repoPath,
    repository: 'albert-einshutoin/takt-private',
    headSha,
    stage: 'pr-review' as const,
  });
  const action = (overrides: Partial<DevloopAutomationAction> = {}): DevloopAutomationAction => ({
    type: 'promote-auto-merge',
    status: 'blocked',
    pr: 77,
    headSha,
    stopRule: 'human review required',
    message: 'The public authentication policy needs an owner decision.',
    productPolicyImpact: {
      impact: 'product_policy',
      policyCategory: 'product_policy',
      requiresHumanReview: true,
      reasons: ['Authentication eligibility would change for existing users.'],
      evidencePaths: ['src/routes/auth.ts'],
      evidenceHunks: [],
    },
    ...overrides,
  });

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-pr-decision-generation-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
    store = new DecisionStore(repoPath);
  });

  afterEach(() => {
    if (existsSync(repoPath)) {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('creates a current-head, stage-scoped PR policy choice', () => {
    const projection = ensureDecisionForAutomationAction(
      store,
      action(),
      context(),
      new Date('2026-07-28T00:00:00.000Z'),
    );

    expect(projection.request).toMatchObject({
      kind: 'choice',
      subject: {
        repoPath: store.repoPath,
        repository: 'albert-einshutoin/takt-private',
        prNumber: 77,
        headSha,
        step: 'pr-review',
      },
      why: {
        riskCategory: 'product_policy',
      },
      answerRequirements: {
        rationaleRequired: true,
      },
      resumeGuard: {
        strategy: 'pr_automation_stage',
        repository: 'albert-einshutoin/takt-private',
        prNumber: 77,
        stage: 'pr-review',
        expectedHeadSha: headSha,
      },
    });
    expect(projection.request.kind === 'choice'
      ? projection.request.options.map((option) => option.id)
      : []).toEqual(['approve_current_head', 'request_changes', 'stop']);
    expect(projection.request.why.reasons.join('\n')).toContain(
      'Authentication eligibility would change for existing users.',
    );
    expect(projection.request.how.summary).toContain('current head');
    expect(projection.request.how.verification.join('\n')).toMatch(/head SHA|checks|review/iu);
  });

  it('creates a decision for an explicit current-head review block', () => {
    const projection = ensureDecisionForAutomationAction(
      store,
      action({
        type: 'current-head-blocked',
        stopRule: 'Mergeable: NO',
        productPolicyImpact: undefined,
        message: 'The current head remains blocked by the recorded human review.',
      }),
      context(),
    );

    expect(projection.request.why.riskCategory).toBe('human_policy');
    expect(projection.request.why.reasons.join('\n')).toContain('Mergeable: NO');
  });

  it.each([
    action(),
    action({ productPolicyImpact: undefined, stopRule: 'Unsafe or too broad' }),
    action({ productPolicyImpact: undefined, stopRule: 'human review required' }),
    action({
      type: 'current-head-blocked',
      productPolicyImpact: undefined,
      stopRule: 'Mergeable: NO',
    }),
  ])('recognizes explicit human stops as Decision-eligible', (eligibleAction) => {
    expect(isAutomationActionDecisionEligible(eligibleAction)).toBe(true);
  });

  it.each([
    action({ status: 'passed' }),
    action({ status: 'skipped' }),
    action({ productPolicyImpact: undefined, stopRule: 'checks failed' }),
    action({ productPolicyImpact: undefined, stopRule: 'head mismatch' }),
    action({ productPolicyImpact: undefined, stopRule: 'attempt budget exhausted' }),
    action({ productPolicyImpact: undefined, stopRule: 'overlap serialization' }),
    action({
      type: 'codex-review',
      status: 'failed',
      productPolicyImpact: undefined,
      stopRule: undefined,
      message: 'provider command failed',
    }),
  ])('rejects non-human automation actions before writing the ledger', (ineligibleAction) => {
    expect(isAutomationActionDecisionEligible(ineligibleAction)).toBe(false);
    expect(() => ensureDecisionForAutomationAction(
      store,
      ineligibleAction,
      context(),
    )).toThrowError(expect.objectContaining({
      code: 'automation_action_not_escalated',
    }));
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it('deduplicates the same action and creates a different decision for a new head', () => {
    const first = ensureDecisionForAutomationAction(store, action(), context());
    const repeated = ensureDecisionForAutomationAction(store, action(), context());
    const movedHeadSha = '1123456789abcdef0123456789abcdef01234567';
    const moved = ensureDecisionForAutomationAction(store, action({ headSha: movedHeadSha }), {
      ...context(),
      headSha: movedHeadSha,
    });

    expect(repeated.request.decisionId).toBe(first.request.decisionId);
    expect(moved.request.decisionId).not.toBe(first.request.decisionId);
    const requested = readFileSync(store.ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { eventType: string })
      .filter((event) => event.eventType === 'devloop_decision_requested');
    expect(requested).toHaveLength(2);
  });

  it.each([
    ['missing repository', { repository: undefined }],
    ['invalid repository', { repository: 'not-a-repository' }],
    ['missing head', { headSha: undefined }],
    ['short head', { headSha: 'abc123' }],
  ])('fails closed for %s without writing a bogus request', (_case, invalid) => {
    expect(() => ensureDecisionForAutomationAction(
      store,
      action(),
      { ...context(), ...invalid } as never,
    )).toThrowError(expect.objectContaining({ code: 'candidate_invalid' }));
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it('fails closed when an eligible action does not retain its evaluated head', () => {
    expect(() => ensureDecisionForAutomationAction(
      store,
      action({ headSha: undefined }),
      context(),
    )).toThrowError(expect.objectContaining({ code: 'candidate_invalid' }));
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it('does not retain raw secrets, local paths, diffs, or commands', () => {
    const projection = ensureDecisionForAutomationAction(
      store,
      action({
        message: [
          'token=super-secret',
          'cwd: /Users/private/worktree',
          'diff --git a/secret.ts b/secret.ts',
          'npm test -- --token super-secret',
        ].join('\n'),
        dualLlmApproval: {
          approved: false,
          headSha,
          reasons: ['Run gh pr diff 77 --patch from /Users/private/worktree'],
          approvals: [],
        },
      }),
      context(),
    );
    const serialized = JSON.stringify(projection.request);

    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('diff --git');
    expect(serialized).not.toContain('npm test');
    expect(serialized).not.toContain('gh pr diff');
  });

  it('keeps truncated public context as a high-risk decision with an origin check', () => {
    const projection = ensureDecisionForAutomationAction(
      store,
      action({ message: `Owner context: ${'x'.repeat(5_000)}` }),
      context(),
    );

    expect(projection.request.why.riskCategory).toBe('high_risk');
    expect(projection.request.why.reasons.join('\n')).toContain('authoritative PR');
  });

  it('aggregates same-guard actions into one Decision with every blocking reason', () => {
    const actions = [
      action({
        type: 'human-review-hold',
        message: 'Product owner approval is missing.',
      }),
      action({
        type: 'current-head-blocked',
        productPolicyImpact: undefined,
        stopRule: 'Mergeable: NO',
        message: 'Current-head security review remains blocked.',
        dualLlmApproval: {
          approved: false,
          headSha,
          reasons: ['Codex review requires a narrower permission boundary.'],
          approvals: [],
        },
      }),
    ];

    const projection = ensureDecisionForAutomationActions(store, actions, context());
    const repeated = ensureDecisionForAutomationActions(store, actions, context());
    const serializedWhy = JSON.stringify(projection.request.why);

    expect(repeated.request.decisionId).toBe(projection.request.decisionId);
    expect(serializedWhy).toContain('Product owner approval is missing.');
    expect(serializedWhy).toContain('Current-head security review remains blocked.');
    expect(serializedWhy).toContain('narrower permission boundary');
    const requested = readFileSync(store.ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { eventType: string })
      .filter((event) => event.eventType === 'devloop_decision_requested');
    expect(requested).toHaveLength(1);
  });

  it('converges stale scheduler indexes across different persistence timestamps', () => {
    const first = ensureDecisionForAutomationActions(
      store,
      [action()],
      context(),
      new Date('2026-07-28T00:00:00.000Z'),
      { projections: new Map() },
    );
    const second = ensureDecisionForAutomationActions(
      store,
      [action()],
      context(),
      new Date('2026-07-28T00:05:00.000Z'),
      { projections: new Map() },
    );

    expect(second.request.decisionId).toBe(first.request.decisionId);
    expect(second.request.createdAt).toBe(first.request.createdAt);
    expect(readFileSync(store.ledgerPath, 'utf8').match(/devloop_decision_requested/gu))
      .toHaveLength(1);
  });

  it('opens a deterministic recurrence after an applied Decision without reusing approval', () => {
    const first = ensureDecisionForAutomationAction(store, action(), context());
    const answer = store.answer({
      decisionId: first.request.decisionId,
      expectedDecisionVersion: first.request.decisionVersion,
      expectedContextHash: first.request.contextHash,
      value: { optionId: 'approve_current_head' },
      rationale: 'Approve this exact head after review.',
      idempotencyKey: 'answer-pr-first',
    }, 'reviewer');
    const identity = {
      decisionId: first.request.decisionId,
      decisionVersion: first.request.decisionVersion,
      contextHash: first.request.contextHash,
      answerEventId: answer.eventId,
      sanitizedSummary: 'Applied current-head approval.',
    };
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionApplyStartedEvent(identity));
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionAppliedEvent(identity));

    const recurrence = ensureDecisionForAutomationAction(store, action(), context());
    const repeated = ensureDecisionForAutomationAction(store, action(), context());

    expect(recurrence.status).toBe('open');
    expect(recurrence.answer).toBeUndefined();
    expect(recurrence.request.decisionId).toMatch(
      new RegExp(`^${first.request.decisionId}_r1$`, 'u'),
    );
    expect(repeated.request.decisionId).toBe(recurrence.request.decisionId);

    const recurrenceAnswer = store.answer({
      decisionId: recurrence.request.decisionId,
      expectedDecisionVersion: recurrence.request.decisionVersion,
      expectedContextHash: recurrence.request.contextHash,
      value: { optionId: 'request_changes' },
      rationale: 'The same stop recurred and now requires changes.',
      idempotencyKey: 'answer-pr-recurrence',
    }, 'reviewer');
    const recurrenceIdentity = {
      decisionId: recurrence.request.decisionId,
      decisionVersion: recurrence.request.decisionVersion,
      contextHash: recurrence.request.contextHash,
      answerEventId: recurrenceAnswer.eventId,
      sanitizedSummary: 'Applied recurrence answer.',
    };
    appendDevloopLedgerEvent(
      store.ledgerPath,
      createDecisionApplyStartedEvent(recurrenceIdentity),
    );
    appendDevloopLedgerEvent(
      store.ledgerPath,
      createDecisionAppliedEvent(recurrenceIdentity),
    );

    const secondRecurrence = ensureDecisionForAutomationAction(store, action(), context());
    expect(secondRecurrence.status).toBe('open');
    expect(secondRecurrence.request.decisionId).toBe(`${first.request.decisionId}_r2`);
  });

  it('fails closed when the deterministic recurrence id is occupied by another request', () => {
    const first = ensureDecisionForAutomationAction(store, action(), context());
    if (first.request.kind !== 'choice') throw new Error('expected choice Decision');
    const answer = store.answer({
      decisionId: first.request.decisionId,
      expectedDecisionVersion: first.request.decisionVersion,
      expectedContextHash: first.request.contextHash,
      value: { optionId: 'approve_current_head' },
      rationale: 'Approve this exact head after review.',
      idempotencyKey: 'answer-pr-collision-base',
    }, 'reviewer');
    const identity = {
      decisionId: first.request.decisionId,
      decisionVersion: first.request.decisionVersion,
      contextHash: first.request.contextHash,
      answerEventId: answer.eventId,
      sanitizedSummary: 'Applied current-head approval.',
    };
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionApplyStartedEvent(identity));
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionAppliedEvent(identity));

    const occupiedRecurrence = createDecisionRequest({
      kind: 'choice',
      subject: {
        ...first.request.subject,
        title: 'Conflicting recurrence request',
      },
      question: first.request.question,
      why: first.request.why,
      how: first.request.how,
      options: first.request.options,
      answerRequirements: first.request.answerRequirements,
      resumeGuard: first.request.resumeGuard,
    }, {
      decisionId: `${first.request.decisionId}_r1`,
    });
    store.request(occupiedRecurrence);

    expect(() => ensureDecisionForAutomationAction(
      store,
      action(),
      context(),
    )).toThrowError(expect.objectContaining({
      code: 'request_conflict',
    }));
  });
});
