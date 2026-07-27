import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  classifyWorkflowDecisionBlock,
  classifyIssueScoutDecision,
  ensureDecisionForAutomationAction,
  ensureDecisionForAutomationActions,
  ensureDecisionForIssueScoutCandidate,
  ensureDecisionForWorkflowBlock,
  isAutomationActionDecisionEligible,
  parseWorkflowHumanDecision,
} from '../devloopd/decisionGeneration.js';
import { createDecisionRequest } from '../devloopd/decisionRequest.js';
import { DecisionStore, DecisionStoreError } from '../devloopd/decisionStore.js';
import {
  createDecisionAppliedEvent,
  createDecisionApplyStartedEvent,
  createDecisionRevalidationRequiredEvent,
} from '../devloopd/decisionEvents.js';
import { appendDevloopLedgerEvent } from '../devloopd/ledger.js';
import type { IssueScoutCandidate } from '../devloopd/issueScout.js';
import type { DevloopAutomationAction } from '../devloopd/prAutomation.js';
import type { AgentResponse } from '../core/models/index.js';

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
        step: 'unrelated-step',
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
        expectedRunStatus: 'aborted',
        expectedAbortKind: 'blocked',
        expectedBlockedStep: 'unrelated-step',
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
    expect(recurrence.request.decisionVersion).toBe(first.request.decisionVersion + 1);
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
    expect(secondRecurrence.request.decisionVersion).toBe(recurrence.request.decisionVersion + 1);
  });

  it('opens a new version after an interrupted apply requires revalidation', () => {
    const first = ensureDecisionForAutomationAction(store, action(), context());
    const answer = store.answer({
      decisionId: first.request.decisionId,
      expectedDecisionVersion: first.request.decisionVersion,
      expectedContextHash: first.request.contextHash,
      value: { optionId: 'approve_current_head' },
      rationale: 'Approve only the current guarded head.',
      idempotencyKey: 'answer-pr-interrupted',
    }, 'reviewer');
    const identity = {
      decisionId: first.request.decisionId,
      decisionVersion: first.request.decisionVersion,
      contextHash: first.request.contextHash,
      answerEventId: answer.eventId,
    };
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionApplyStartedEvent({
      ...identity,
      sanitizedSummary: 'Apply claimed.',
      operationId: 'op_interrupted',
      ownerPid: 999_999,
      ownerStartToken: 'owner_interrupted',
    }));
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionRevalidationRequiredEvent({
      ...identity,
      reasonCode: 'apply_owner_terminated',
      sanitizedSummary: 'Apply owner terminated.',
    }));

    const recurrence = ensureDecisionForAutomationAction(store, action(), context());

    expect(recurrence.status).toBe('open');
    expect(recurrence.request.decisionId).toBe(`${first.request.decisionId}_r1`);
    expect(recurrence.request.decisionVersion).toBe(first.request.decisionVersion + 1);
    expect(recurrence.answer).toBeUndefined();
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

function blockedResponse(humanDecision?: unknown): AgentResponse {
  return {
    persona: 'planner',
    status: 'blocked',
    content: '質問: 実装範囲を確認してください。理由: 要求が曖昧です。',
    timestamp: new Date('2026-07-28T00:00:00.000Z'),
    ...(humanDecision === undefined
      ? {}
      : { structuredOutput: { humanDecision } }),
  };
}

const workflowWhy = {
  summary: 'Two mutually exclusive compatibility behaviors are possible.',
  reasons: ['The task does not identify which behavior is required.'],
  evidence: [{
    kind: 'run' as const,
    reference: 'planner-output',
    summary: 'The planner recorded both behaviors as valid.',
  }],
};

function workflowHumanDecision(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    category: 'permission',
    question: 'May the workflow continue with the requested external action?',
    why: workflowWhy,
    answer: { kind: 'yes_no', rationaleRequired: true },
    ...overrides,
  };
}

describe('ensureDecisionForWorkflowBlock', () => {
  let repoPath: string;
  let store: DecisionStore;

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-workflow-decision-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
    store = new DecisionStore(repoPath);
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('creates a run-, step-, issue-correlated text Decision for requirements ambiguity', () => {
    const response = blockedResponse({
      schemaVersion: 1,
      category: 'requirements_ambiguity',
      question: 'Should compatibility preserve the legacy behavior or use the new behavior?',
      why: workflowWhy,
      answer: {
        kind: 'text',
        minimumTextLength: 3,
        maximumTextLength: 500,
        rationaleRequired: true,
      },
    });

    const projection = ensureDecisionForWorkflowBlock(store, {
      response,
      stepName: 'plan',
      workflowName: 'takt-default',
      repoPath,
      runSlug: 'run-42',
      issueNumber: 42,
    }, new Date('2026-07-28T00:00:00.000Z'));

    expect(projection?.request).toMatchObject({
      kind: 'text',
      subject: {
        repoPath: store.repoPath,
        runSlug: 'run-42',
        workflow: 'takt-default',
        step: 'plan',
        issueNumber: 42,
      },
      why: { riskCategory: 'requirements_ambiguity' },
      answerRequirements: {
        rationaleRequired: true,
        minimumTextLength: 3,
        maximumTextLength: 500,
      },
      resumeGuard: {
        strategy: 'direct_run',
        runSlug: 'run-42',
        expectedRunStatus: 'aborted',
        expectedAbortKind: 'blocked',
        expectedBlockedStep: 'plan',
      },
    });
    expect(projection?.request.how.summary).toContain('blocked run context');
    expect(projection?.request.how.verification.join('\n')).toMatch(/revalidate/iu);
  });

  it.each([
    ['permission', 'May the workflow publish the prepared release artifact?'],
    ['external_dependency', 'Is the external sandbox account now available?'],
  ] as const)('creates explicit yes/no buttons for %s', (category, question) => {
    const projection = ensureDecisionForWorkflowBlock(store, {
      response: blockedResponse({
        schemaVersion: 1,
        category,
        question,
        why: workflowWhy,
        answer: { kind: 'yes_no', rationaleRequired: category === 'permission' },
      }),
      stepName: 'release',
      workflowName: 'takt-default',
      repoPath,
      runSlug: `run-${category}`,
    });

    expect(projection?.request.kind).toBe('yes_no');
    if (projection?.request.kind !== 'yes_no') throw new Error('expected yes/no Decision');
    expect(projection.request.options.map((option) => option.id)).toEqual(['yes', 'no']);
    expect(projection.request.answerRequirements.rationaleRequired)
      .toBe(category === 'permission');
  });

  it('allows an explicitly bounded text answer for an external dependency', () => {
    const parsed = parseWorkflowHumanDecision(blockedResponse({
      schemaVersion: 1,
      category: 'external_dependency',
      question: 'Provide the approved external ticket reference.',
      why: workflowWhy,
      answer: {
        kind: 'text',
        minimumTextLength: 3,
        maximumTextLength: 100,
        rationaleRequired: false,
      },
    }));

    expect(parsed?.answer.kind).toBe('text');
  });

  it('does not infer a Decision from plain blocked prose', () => {
    const response = blockedResponse();

    expect(classifyWorkflowDecisionBlock(response)).toEqual({
      classification: 'ordinary_ineligible',
      eligible: false,
      issue: 'missing_structured_output',
    });
    expect(ensureDecisionForWorkflowBlock(store, {
      response,
      stepName: 'plan',
      workflowName: 'takt-default',
      repoPath,
      runSlug: 'run-plain',
    })).toBeUndefined();
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['date', new Date('2026-07-28T00:00:00.000Z')],
    ['inherited object', Object.create({ humanDecision: workflowHumanDecision() })],
  ])('rejects a non-plain structuredOutput without throwing: %s', (_name, structuredOutput) => {
    const response = {
      ...blockedResponse(),
      structuredOutput,
    } as AgentResponse;

    expect(() => classifyWorkflowDecisionBlock(response)).not.toThrow();
    expect(classifyWorkflowDecisionBlock(response)).toEqual({
      classification: 'invalid_contract',
      eligible: false,
      issue: 'invalid_structured_output',
    });
    expect(ensureDecisionForWorkflowBlock(store, {
      response,
      stepName: 'plan',
      workflowName: 'takt-default',
      repoPath,
      runSlug: 'run-non-plain',
    })).toBeUndefined();
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it('accepts a null-prototype structuredOutput containing an own humanDecision', () => {
    const structuredOutput = Object.create(null) as Record<string, unknown>;
    structuredOutput.humanDecision = workflowHumanDecision();
    const response = {
      ...blockedResponse(),
      structuredOutput,
    };

    expect(classifyWorkflowDecisionBlock(response).eligible).toBe(true);
  });

  it.each([
    ['response', 'response'],
    ['structured output', 'structuredOutput'],
    ['human decision', 'humanDecision'],
    ['nested node', 'nested'],
  ] as const)('rejects a %s Proxy without invoking any trap', (_name, target) => {
    let trapCount = 0;
    const proxyHandler: ProxyHandler<object> = {
      get(object, key, receiver) {
        trapCount += 1;
        return Reflect.get(object, key, receiver);
      },
      getPrototypeOf(object) {
        trapCount += 1;
        return Reflect.getPrototypeOf(object);
      },
      ownKeys(object) {
        trapCount += 1;
        return Reflect.ownKeys(object);
      },
      getOwnPropertyDescriptor(object, key) {
        trapCount += 1;
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    };
    const decision = workflowHumanDecision();
    let response: AgentResponse;
    if (target === 'response') {
      response = new Proxy(blockedResponse(decision), proxyHandler);
    } else if (target === 'structuredOutput') {
      response = {
        ...blockedResponse(),
        structuredOutput: new Proxy({ humanDecision: decision }, proxyHandler),
      };
    } else if (target === 'humanDecision') {
      response = blockedResponse(new Proxy(decision, proxyHandler));
    } else {
      response = blockedResponse({
        ...decision,
        why: {
          ...workflowWhy,
          reasons: [new Proxy({ unsafe: true }, proxyHandler)],
        },
      });
    }

    expect(classifyWorkflowDecisionBlock(response)).toMatchObject({
      classification: 'invalid_contract',
      issue: 'invalid_structured_output',
    });
    expect(trapCount).toBe(0);
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it.each([
    { error: 'provider failed' },
    { errorKind: 'rate_limit' as const },
    { failureCategory: 'provider_error' as const },
    { failureCategory: 'stream_idle_timeout' as const },
  ])('rejects provider/runtime failures even when a payload is present: %o', (failure) => {
    const response = {
      ...blockedResponse({
        schemaVersion: 1,
        category: 'permission',
        question: 'May the workflow continue?',
        why: workflowWhy,
        answer: { kind: 'yes_no', rationaleRequired: true },
      }),
      ...failure,
    };

    expect(classifyWorkflowDecisionBlock(response).eligible).toBe(false);
    expect(ensureDecisionForWorkflowBlock(store, {
      response,
      stepName: 'plan',
      workflowName: 'takt-default',
      repoPath,
      runSlug: 'run-provider',
    })).toBeUndefined();
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it('rejects rateLimitInfo even without errorKind or failureCategory', () => {
    const response = {
      ...blockedResponse(workflowHumanDecision()),
      rateLimitInfo: {
        provider: 'mock' as const,
        detectedAt: new Date('2026-07-28T00:00:00.000Z'),
        source: 'sdk_error' as const,
      },
    };

    expect(classifyWorkflowDecisionBlock(response)).toEqual({
      classification: 'ordinary_ineligible',
      eligible: false,
      issue: 'provider_runtime_failure',
    });
    expect(ensureDecisionForWorkflowBlock(store, {
      response,
      stepName: 'plan',
      workflowName: 'takt-default',
      repoPath,
      runSlug: 'run-rate-info',
    })).toBeUndefined();
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it('rejects an HTTP OAuth callback URL without persisting its code', () => {
    const oauthCode = 'oauth-code-must-not-leak';
    const response = blockedResponse(workflowHumanDecision({
      question: `Review http://localhost/callback?code=${oauthCode}`,
    }));

    expect(classifyWorkflowDecisionBlock(response)).toMatchObject({
      classification: 'invalid_contract',
      issue: 'invalid_structured_output',
    });
    expect(ensureDecisionForWorkflowBlock(store, {
      response,
      stepName: 'review',
      workflowName: 'takt-default',
      repoPath,
      runSlug: 'run-oauth-url',
    })).toBeUndefined();
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it.each([
    '_http://localhost/callback?code=oauth-prefixed',
    'prefix_http://localhost/callback?code=oauth-prefixed',
    '(http://localhost/callback?code=oauth-prefixed)',
  ])('rejects a prefixed HTTP OAuth callback without persisting it: %s', (question) => {
    const response = blockedResponse(workflowHumanDecision({ question }));

    expect(classifyWorkflowDecisionBlock(response)).toMatchObject({
      classification: 'invalid_contract',
      issue: 'invalid_structured_output',
    });
    expect(ensureDecisionForWorkflowBlock(store, {
      response,
      stepName: 'review',
      workflowName: 'takt-default',
      repoPath,
      runSlug: 'run-prefixed-oauth-url',
    })).toBeUndefined();
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it.each([
    ['unknown schema', { schemaVersion: 2 }],
    ['extra command', { command: 'npm publish' }],
    ['invalid answer kind', { answer: { kind: 'choice' } }],
  ])('classifies invalid structured output safely: %s', (_name, override) => {
    const response = blockedResponse({
      schemaVersion: 1,
      category: 'permission',
      question: 'May the workflow continue?',
      why: workflowWhy,
      answer: { kind: 'yes_no', rationaleRequired: true },
      ...override,
    });

    expect(() => classifyWorkflowDecisionBlock(response)).not.toThrow();
    expect(classifyWorkflowDecisionBlock(response)).toEqual({
      classification: 'invalid_contract',
      eligible: false,
      issue: 'invalid_structured_output',
    });
  });

  it('deduplicates active blocks and opens a recurrence after the prior Decision is applied', () => {
    const input = {
      response: blockedResponse({
        schemaVersion: 1,
        category: 'permission',
        question: 'May the workflow publish the release artifact?',
        why: workflowWhy,
        answer: { kind: 'yes_no', rationaleRequired: true },
      }),
      stepName: 'release',
      workflowName: 'takt-default',
      repoPath,
      runSlug: 'run-recurrence',
    };
    const first = ensureDecisionForWorkflowBlock(store, input)!;
    const repeated = ensureDecisionForWorkflowBlock(store, input)!;
    expect(repeated.request.decisionId).toBe(first.request.decisionId);

    const answer = store.answer({
      decisionId: first.request.decisionId,
      expectedDecisionVersion: first.request.decisionVersion,
      expectedContextHash: first.request.contextHash,
      value: { optionId: 'yes' },
      rationale: 'Release owner approved this exact blocked run.',
      idempotencyKey: 'answer-workflow-first',
    }, 'reviewer');
    const identity = {
      decisionId: first.request.decisionId,
      decisionVersion: first.request.decisionVersion,
      contextHash: first.request.contextHash,
      answerEventId: answer.eventId,
      sanitizedSummary: 'Applied blocked workflow answer.',
    };
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionApplyStartedEvent(identity));
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionAppliedEvent(identity));

    const recurrence = ensureDecisionForWorkflowBlock(store, input)!;
    expect(recurrence.status).toBe('open');
    expect(recurrence.request.decisionId).toBe(`${first.request.decisionId}_r1`);
  });

  it('rejects unsafe, secret-bearing, path-bearing, ANSI, and oversized fields without leaking', () => {
    for (const question of [
      'token=super-secret',
      '/Users/private/project/secret.txt',
      '\u001b[31mapprove\u001b[0m',
      'x'.repeat(4_001),
    ]) {
      const response = blockedResponse({
        schemaVersion: 1,
        category: 'permission',
        question,
        why: workflowWhy,
        answer: { kind: 'yes_no', rationaleRequired: true },
      });
      const classification = classifyWorkflowDecisionBlock(response);
      expect(classification).toEqual({
        classification: 'invalid_contract',
        eligible: false,
        issue: 'invalid_structured_output',
      });
    }
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it('accepts bounded adversarial-looking text without secret assignment syntax', () => {
    const tokenLikeText = 'tokenish-context '.repeat(300).slice(0, 3_999);
    const response = blockedResponse(workflowHumanDecision({
      question: tokenLikeText,
    }));

    expect(() => classifyWorkflowDecisionBlock(response)).not.toThrow();
    expect(classifyWorkflowDecisionBlock(response)).toMatchObject({
      classification: 'eligible',
    });
  });

  it.each([
    ['question', (value: string) => workflowHumanDecision({ question: value })],
    ['why summary', (value: string) => workflowHumanDecision({
      why: { ...workflowWhy, summary: value },
    })],
    ['reason', (value: string) => workflowHumanDecision({
      why: { ...workflowWhy, reasons: [value] },
    })],
    ['evidence reference', (value: string) => workflowHumanDecision({
      why: {
        ...workflowWhy,
        evidence: [{ ...workflowWhy.evidence[0], reference: value }],
      },
    })],
    ['evidence summary', (value: string) => workflowHumanDecision({
      why: {
        ...workflowWhy,
        evidence: [{ ...workflowWhy.evidence[0], summary: value }],
      },
    })],
  ])('applies the same safe text policy to %s', (_field, buildDecision) => {
    const unsafeValues = [
      'AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF',
      'token=workflow-secret',
      'password: workflow-secret',
      'Cookie: session=workflow-secret',
      'Authorization: Bearer workflow-secret',
      '-----BEGIN PRIVATE KEY-----',
      'file:///Users/private/workflow.txt',
      'path:/Users/private/workflow.txt',
      'cwd:/root/private-workflow',
      '/root/private-workflow',
      String.raw`C:\Users\private\workflow.txt`,
      String.raw`\\server\share\workflow.txt`,
      'https://user:password@github.com/example/repo',
      'https://github.com/example/repo?token=workflow-secret',
      '\u001b[31munsafe\u001b[0m',
      'unsafe\u202Etext',
    ];

    for (const value of unsafeValues) {
      const response = blockedResponse(buildDecision(value));
      expect(classifyWorkflowDecisionBlock(response)).toEqual({
        classification: 'invalid_contract',
        eligible: false,
        issue: 'invalid_structured_output',
      });
      expect(ensureDecisionForWorkflowBlock(store, {
        response,
        stepName: 'plan',
        workflowName: 'takt-default',
        repoPath,
        runSlug: 'run-unsafe-field',
      })).toBeUndefined();
    }
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it('rejects cyclic, accessor-bearing, and aggregate-oversized payloads without throwing', () => {
    const cyclic = workflowHumanDecision() as Record<string, unknown>;
    cyclic.cycle = cyclic;
    let getterCalls = 0;
    const accessor = workflowHumanDecision();
    Object.defineProperty(accessor, 'hidden', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not execute provider getter');
      },
    });
    const oversized = {
      ...workflowHumanDecision(),
      padding: Array.from({ length: 140 }, () => 'x'.repeat(2_000)),
    };
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(280_000);

    for (const humanDecision of [cyclic, accessor, oversized]) {
      const response = blockedResponse(humanDecision);
      expect(() => classifyWorkflowDecisionBlock(response)).not.toThrow();
      expect(classifyWorkflowDecisionBlock(response)).toEqual({
        classification: 'invalid_contract',
        eligible: false,
        issue: 'invalid_structured_output',
      });
      expect(ensureDecisionForWorkflowBlock(store, {
        response,
        stepName: 'plan',
        workflowName: 'takt-default',
        repoPath,
        runSlug: 'run-untrusted-payload',
      })).toBeUndefined();
    }
    expect(getterCalls).toBe(0);
    expect(existsSync(store.ledgerPath)).toBe(false);
  });

  it('accepts a bounded aggregate payload near the workflow contract limit', () => {
    const repeatedSafeText = 'Context remains ambiguous and needs an explicit owner choice. ';
    const decision = workflowHumanDecision({
      question: repeatedSafeText.repeat(20),
      why: {
        summary: repeatedSafeText.repeat(20),
        reasons: Array.from({ length: 19 }, () => repeatedSafeText.repeat(20)),
        evidence: Array.from({ length: 15 }, (_, index) => ({
          kind: 'run',
          reference: `bounded-evidence-${index + 1}`,
          summary: repeatedSafeText.repeat(20),
        })),
      },
    });
    const response = blockedResponse(decision);

    const aggregateBytes = Buffer.byteLength(JSON.stringify(decision), 'utf8');
    expect(aggregateBytes).toBeGreaterThan(40 * 1_024);
    expect(aggregateBytes).toBeLessThan(64 * 1_024);
    expect(classifyWorkflowDecisionBlock(response).eligible).toBe(true);
    expect(ensureDecisionForWorkflowBlock(store, {
      response,
      stepName: 'plan',
      workflowName: 'takt-default',
      repoPath,
      runSlug: 'run-bounded-aggregate',
    })?.status).toBe('open');
  });

  it('returns a deeply readonly and frozen parsed workflow Decision', () => {
    const parsed = parseWorkflowHumanDecision(blockedResponse(workflowHumanDecision()));
    if (parsed === undefined) throw new Error('expected parsed Decision');

    expectTypeOf(parsed.why.reasons).toEqualTypeOf<readonly string[]>();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.why)).toBe(true);
    expect(Object.isFrozen(parsed.why.reasons)).toBe(true);
    expect(() => {
      (parsed.why.reasons as string[]).push('mutated');
    }).toThrow();
    if (false) {
      // @ts-expect-error parsed decisions are deeply readonly
      parsed.why.summary = 'mutated';
    }
  });

  it('enforces the 64 KiB aggregate boundary on a valid multibyte schema shape', () => {
    const buildAtQuestionLength = (length: number) => workflowHumanDecision({
      question: '境'.repeat(length),
      why: {
        summary: '境'.repeat(1_000),
        reasons: Array.from({ length: 19 }, () => '境'.repeat(1_000)),
        evidence: [],
      },
    });
    let low = 1;
    let high = 2_000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const bytes = Buffer.byteLength(JSON.stringify(buildAtQuestionLength(middle)), 'utf8');
      if (bytes > 64 * 1_024) high = middle;
      else low = middle + 1;
    }
    const above = buildAtQuestionLength(low);
    const below = buildAtQuestionLength(low - 1);
    const belowBytes = Buffer.byteLength(JSON.stringify(below), 'utf8');
    const aboveBytes = Buffer.byteLength(JSON.stringify(above), 'utf8');

    expect(belowBytes).toBeLessThanOrEqual(64 * 1_024);
    expect(aboveBytes).toBeGreaterThan(64 * 1_024);
    expect(aboveBytes - belowBytes).toBe(3);
    expect(classifyWorkflowDecisionBlock(blockedResponse(above))).toMatchObject({
      classification: 'invalid_contract',
    });
    expect(existsSync(store.ledgerPath)).toBe(false);
    expect(classifyWorkflowDecisionBlock(blockedResponse(below))).toMatchObject({
      classification: 'eligible',
    });
  });
});
