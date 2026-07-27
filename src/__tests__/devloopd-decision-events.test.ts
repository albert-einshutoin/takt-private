import { describe, expect, it } from 'vitest';
import { createDecisionRequest } from '../devloopd/decisionRequest.js';
import {
  createDecisionAnsweredEvent,
  createDecisionAnswerSupersededEvent,
  createDecisionAppliedEvent,
  createDecisionApplyFailedEvent,
  createDecisionApplyStartedEvent,
  createDecisionGithubSyncEvent,
  createDecisionRequestedEvent,
  createDecisionRevalidationRequiredEvent,
  DecisionEventSchema,
  foldDecisionEvents,
  parseDecisionEvent,
} from '../devloopd/decisionEvents.js';

const request = createDecisionRequest({
  subject: {
    repoPath: '/private/worktrees/takt',
    repository: 'albert-einshutoin/takt-private',
    runSlug: 'issue-42',
    issueNumber: 42,
    title: 'Choose the compatibility policy',
  },
  kind: 'choice',
  question: 'Choose a compatibility policy.',
  why: {
    summary: 'The proposed change modifies a public API.',
    riskCategory: 'product_policy',
    reasons: ['Existing consumers may break.'],
    evidence: [{
      kind: 'policy',
      reference: 'api-compatibility',
      summary: 'Public API compatibility policy',
    }],
  },
  how: {
    summary: 'Resume the run with the selected policy.',
    expectedEffects: ['Rebuild the implementation plan.'],
    verification: ['Confirm the selected policy is present in the task context.'],
  },
  options: [
    {
      id: 'preserve',
      title: 'Preserve compatibility',
      description: 'Keep the current API.',
      consequences: [],
      recommended: true,
      recommendationReason: 'Protect existing consumers.',
    },
    {
      id: 'break',
      title: 'Allow a breaking change',
      description: 'Publish a migration path.',
      consequences: [],
      recommended: false,
    },
  ],
  answerRequirements: {
    rationaleRequired: true,
    minimumTextLength: 0,
    maximumTextLength: 2_000,
  },
  resumeGuard: {
    strategy: 'direct_run',
    expectedDecisionVersion: 1,
    runSlug: 'issue-42',
    expectedRunStatus: 'blocked',
  },
}, {
  decisionId: 'dec_42',
  now: new Date('2026-07-27T01:00:00.000Z'),
});

const identity = {
  decisionId: request.decisionId,
  decisionVersion: request.decisionVersion,
  contextHash: request.contextHash,
};

const requested = createDecisionRequestedEvent(request, {
  eventId: 'evt_requested',
  now: new Date('2026-07-27T01:01:00.000Z'),
});

const answered = createDecisionAnsweredEvent({
  ...identity,
  value: { optionId: 'preserve' },
  rationale: 'Compatibility is required for existing users.',
  answeredBy: 'user:owner',
  idempotencyKey: 'answer-42-v1',
}, {
  eventId: 'evt_answered',
  now: new Date('2026-07-27T01:02:00.000Z'),
});

describe('decision event fold', () => {
  it('folds requested to answered without mutating the immutable request or answer value', () => {
    const before = structuredClone(request);
    const result = foldDecisionEvents([requested, answered]);
    const projection = result.get(request.decisionId);

    expect(projection?.status).toBe('answered');
    expect(projection?.answer).toMatchObject({
      eventId: 'evt_answered',
      value: { optionId: 'preserve' },
      rationale: 'Compatibility is required for existing users.',
    });
    expect(projection?.request).toEqual(before);
    expect(request).toEqual(before);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection?.request)).toBe(true);
    expect([...result.values()]).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it('folds apply_started to applied for the fixed answer event', () => {
    const started = createDecisionApplyStartedEvent({
      ...identity,
      answerEventId: answered.eventId,
      sanitizedSummary: 'Applying the selected compatibility policy.',
    }, { eventId: 'evt_apply_started' });
    const applied = createDecisionAppliedEvent({
      ...identity,
      answerEventId: answered.eventId,
      sanitizedSummary: 'Compatibility policy applied and verified.',
    }, { eventId: 'evt_applied' });

    const projection = foldDecisionEvents([requested, answered, started, applied])
      .get(request.decisionId);

    expect(projection?.status).toBe('applied');
    expect(projection?.applyResult).toEqual({
      status: 'applied',
      eventId: 'evt_applied',
      answerEventId: 'evt_answered',
      sanitizedSummary: 'Compatibility policy applied and verified.',
    });
  });

  it('keeps an answered decision retryable and exposes a sanitized apply failure', () => {
    const started = createDecisionApplyStartedEvent({
      ...identity,
      answerEventId: answered.eventId,
      sanitizedSummary: 'Applying the selected compatibility policy.',
    }, { eventId: 'evt_apply_started' });
    const failed = createDecisionApplyFailedEvent({
      ...identity,
      answerEventId: answered.eventId,
      errorCode: 'HEAD_CHANGED',
      sanitizedError: 'The expected branch head changed.',
    }, { eventId: 'evt_apply_failed' });

    const projection = foldDecisionEvents([requested, answered, started, failed])
      .get(request.decisionId);

    expect(projection?.status).toBe('answered');
    expect(projection?.answer?.eventId).toBe('evt_answered');
    expect(projection?.applyResult).toEqual({
      status: 'failed',
      eventId: 'evt_apply_failed',
      answerEventId: 'evt_answered',
      errorCode: 'HEAD_CHANGED',
      sanitizedError: 'The expected branch head changed.',
    });
  });

  it('folds revalidation_required from applying without discarding the answer', () => {
    const started = createDecisionApplyStartedEvent({
      ...identity,
      answerEventId: answered.eventId,
      sanitizedSummary: 'Applying the selected compatibility policy.',
    });
    const revalidation = createDecisionRevalidationRequiredEvent({
      ...identity,
      answerEventId: answered.eventId,
      reasonCode: 'CONTEXT_CHANGED',
      sanitizedSummary: 'Repository context changed before application completed.',
    }, { eventId: 'evt_revalidate' });

    const projection = foldDecisionEvents([requested, answered, started, revalidation])
      .get(request.decisionId);

    expect(projection?.status).toBe('revalidation_required');
    expect(projection?.answer?.eventId).toBe('evt_answered');
    expect(projection?.applyResult).toMatchObject({
      status: 'revalidation_required',
      eventId: 'evt_revalidate',
      answerEventId: 'evt_answered',
      reasonCode: 'CONTEXT_CHANGED',
    });
  });

  it('supersedes an unapplied answer while retaining the prior answer event identity', () => {
    const superseded = createDecisionAnswerSupersededEvent({
      ...identity,
      supersededAnswerEventId: answered.eventId,
      value: { optionId: 'break' },
      rationale: 'A versioned migration path is now approved.',
      answeredBy: 'user:owner',
      idempotencyKey: 'answer-42-v2',
    }, { eventId: 'evt_answer_v2' });

    const projection = foldDecisionEvents([requested, answered, superseded])
      .get(request.decisionId);

    expect(projection?.status).toBe('answered');
    expect(projection?.answer).toMatchObject({
      eventId: 'evt_answer_v2',
      supersededAnswerEventId: 'evt_answered',
      value: { optionId: 'break' },
    });
  });

  it('reports unknown schema versions instead of silently ignoring them', () => {
    const result = foldDecisionEvents([{
      ...requested,
      schemaVersion: 2,
      eventId: 'evt_future',
    }]);

    expect(result.get(request.decisionId)).toBeUndefined();
    expect(result.issues).toEqual([expect.objectContaining({
      eventId: 'evt_future',
      code: 'unknown_schema_version',
    })]);
  });

  it('reports duplicate event IDs and applies an event only once', () => {
    const result = foldDecisionEvents([requested, answered, answered]);

    expect(result.get(request.decisionId)?.status).toBe('answered');
    expect(result.issues).toEqual([expect.objectContaining({
      eventId: answered.eventId,
      code: 'duplicate_event_id',
    })]);
  });

  it.each([
    [
      'version_mismatch',
      { ...answered, eventId: 'evt_wrong_version', decisionVersion: 2 },
    ],
    [
      'context_hash_mismatch',
      { ...answered, eventId: 'evt_wrong_hash', contextHash: 'a'.repeat(64) },
    ],
    [
      'invalid_transition',
      createDecisionAppliedEvent({
        ...identity,
        answerEventId: answered.eventId,
        sanitizedSummary: 'Attempted without starting.',
      }, { eventId: 'evt_invalid_transition' }),
    ],
  ])('reports %s and leaves the open state unchanged', (code, event) => {
    const result = foldDecisionEvents([requested, event]);

    expect(result.get(request.decisionId)?.status).toBe('open');
    expect(result.get(request.decisionId)?.answer).toBeUndefined();
    expect(result.issues).toEqual([expect.objectContaining({ code })]);
  });

  it('rejects a transition for the wrong answer event without changing applying state', () => {
    const started = createDecisionApplyStartedEvent({
      ...identity,
      answerEventId: answered.eventId,
      sanitizedSummary: 'Applying the selected compatibility policy.',
    });
    const applied = createDecisionAppliedEvent({
      ...identity,
      answerEventId: 'evt_other_answer',
      sanitizedSummary: 'Wrong answer.',
    });
    const result = foldDecisionEvents([requested, answered, started, applied]);

    expect(result.get(request.decisionId)?.status).toBe('applying');
    expect(result.issues).toEqual([expect.objectContaining({
      code: 'answer_event_mismatch',
    })]);
  });

  it('folds GitHub sync independently without changing the main status', () => {
    const pending = createDecisionGithubSyncEvent({
      ...identity,
      target: {
        kind: 'issue',
        repository: 'albert-einshutoin/takt-private',
        number: 42,
      },
      status: 'pending',
    });
    const synced = createDecisionGithubSyncEvent({
      ...identity,
      target: pending.target,
      status: 'synced',
      commentId: 'IC_kwDOexample',
      commentUrl: 'https://github.com/albert-einshutoin/takt-private/issues/42#issuecomment-1',
    }, { eventId: 'evt_github_synced' });

    const projection = foldDecisionEvents([requested, answered, pending, synced])
      .get(request.decisionId);

    expect(projection?.status).toBe('answered');
    expect(projection?.githubSync).toMatchObject({
      eventId: 'evt_github_synced',
      status: 'synced',
      target: { kind: 'issue', number: 42 },
      commentId: 'IC_kwDOexample',
    });
  });

  it('supports deterministic event ID and timestamp injection in every builder path', () => {
    const event = createDecisionAnsweredEvent({
      ...identity,
      value: { optionId: 'preserve' },
      rationale: 'Keep compatibility.',
      answeredBy: 'user:owner',
      idempotencyKey: 'answer-deterministic',
    }, {
      eventId: 'evt_deterministic',
      now: new Date('2026-07-27T03:00:00.000Z'),
    });

    expect(event.eventId).toBe('evt_deterministic');
    expect(event.occurredAt).toBe('2026-07-27T03:00:00.000Z');
    expect(parseDecisionEvent(event).success).toBe(true);
    expect(DecisionEventSchema.parse(event)).toEqual(event);
  });

  it('fails closed for command-bearing or kind-unsafe ledger payloads', () => {
    expect(parseDecisionEvent({ ...answered, command: 'npm test' }).success).toBe(false);
    expect(parseDecisionEvent({
      ...answered,
      value: { text: 'preserve', optionId: 'preserve' },
    }).success).toBe(false);
  });

  it('forbids answer changes after application', () => {
    const started = createDecisionApplyStartedEvent({
      ...identity,
      answerEventId: answered.eventId,
      sanitizedSummary: 'Applying.',
    });
    const applied = createDecisionAppliedEvent({
      ...identity,
      answerEventId: answered.eventId,
      sanitizedSummary: 'Applied.',
    });
    const superseded = createDecisionAnswerSupersededEvent({
      ...identity,
      supersededAnswerEventId: answered.eventId,
      value: { optionId: 'break' },
      rationale: 'Too late.',
      answeredBy: 'user:owner',
      idempotencyKey: 'answer-after-applied',
    });
    const result = foldDecisionEvents([requested, answered, started, applied, superseded]);

    expect(result.get(request.decisionId)?.answer?.eventId).toBe(answered.eventId);
    expect(result.get(request.decisionId)?.status).toBe('applied');
    expect(result.issues).toEqual([expect.objectContaining({
      code: 'invalid_transition',
    })]);
  });
});
