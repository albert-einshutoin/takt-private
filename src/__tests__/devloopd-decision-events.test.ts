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
  DecisionGithubSyncEventSchema,
  foldDecisionEvents,
  parseDecisionEvent,
  type DecisionProjection,
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

function createVersionedRequest(
  decisionVersion: number,
  question = 'Choose a compatibility policy.',
) {
  return createDecisionRequest({
    subject: {
      repoPath: '/private/worktrees/takt',
      repository: 'albert-einshutoin/takt-private',
      runSlug: 'issue-42',
      issueNumber: 42,
      title: 'Choose the compatibility policy',
    },
    kind: 'choice',
    question,
    why: {
      summary: 'The proposed change modifies a public API.',
      riskCategory: 'product_policy',
      reasons: ['Existing consumers may break.'],
      evidence: [],
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
      expectedDecisionVersion: decisionVersion,
      runSlug: 'issue-42',
      expectedRunStatus: 'blocked',
    },
  }, {
    decisionId: request.decisionId,
    now: new Date('2026-07-27T04:00:00.000Z'),
  });
}

function createTextRequest(
  maximumTextLength: number,
  minimumTextLength = 0,
  decisionId = `dec_text_${maximumTextLength}_${minimumTextLength}`,
) {
  return createDecisionRequest({
    subject: {
      repoPath: '/private/worktrees/takt',
      runSlug: decisionId,
      title: 'Provide decision text',
    },
    kind: 'text',
    question: 'Describe the approved implementation boundary.',
    why: {
      summary: 'Automation needs an explicit human-authored boundary.',
      riskCategory: 'requirements_ambiguity',
      reasons: ['The implementation boundary is not derivable.'],
      evidence: [],
    },
    how: {
      summary: 'Resume with the approved boundary.',
      expectedEffects: ['Use the answer as decision context.'],
      verification: ['Validate the answer length before resuming.'],
    },
    answerRequirements: {
      rationaleRequired: false,
      minimumTextLength,
      maximumTextLength,
    },
    resumeGuard: {
      strategy: 'direct_run',
      expectedDecisionVersion: 1,
      runSlug: decisionId,
      expectedRunStatus: 'blocked',
    },
  }, { decisionId });
}

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
    expect(Object.isFrozen(projection?.answer?.value)).toBe(true);
    expect([...result.values()]).toHaveLength(1);
    expect(result.issues).toEqual([]);

    if (false) {
      const typedProjection = projection as DecisionProjection;
      if (typedProjection.answer !== undefined) {
        // @ts-expect-error Projection answer values are deeply readonly.
        typedProjection.answer.value = { optionId: 'break' };
      }
    }
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

  it('quarantines a decision when an unknown event version drifts after an answer', () => {
    const unknownApplied = {
      ...createDecisionAppliedEvent({
        ...identity,
        answerEventId: answered.eventId,
        sanitizedSummary: 'Future application result.',
      }, { eventId: 'evt_future_applied' }),
      schemaVersion: 2,
    };
    const result = foldDecisionEvents([requested, answered, unknownApplied]);

    expect(result.get(request.decisionId)).toBeUndefined();
    expect([...result.values()]).toEqual([]);
    expect(result.quarantinedDecisionIds).toContain(request.decisionId);
    expect(result.issues).toContainEqual(expect.objectContaining({
      eventId: 'evt_future_applied',
      decisionId: request.decisionId,
      code: 'unknown_schema_version',
    }));
  });

  it('fails the entire fold when a future event renames decisionId to aggregateId', () => {
    const result = foldDecisionEvents([
      requested,
      answered,
      {
        schemaVersion: 2,
        eventId: 'evt_future_aggregate',
        aggregateId: request.decisionId,
        eventType: 'devloop_decision_applied',
      },
    ]);

    expect(result.fatal).toBe(true);
    expect(result.get(request.decisionId)).toBeUndefined();
    expect([...result.values()]).toEqual([]);
    expect([...result]).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({
      eventId: 'evt_future_aggregate',
      code: 'unknown_schema_version',
    }));
  });

  it('fails the entire fold for an unknown version without a readable decision ID', () => {
    const result = foldDecisionEvents([
      requested,
      {
        schemaVersion: 2,
        eventId: 'evt_future_without_decision',
        eventType: 'devloop_decision_applied',
      },
    ]);

    expect(result.fatal).toBe(true);
    expect(result.get(request.decisionId)).toBeUndefined();
    expect([...result.values()]).toEqual([]);
  });

  it('quarantines only the readable decision for a malformed current-version event', () => {
    const otherRequest = createTextRequest(100, 0, 'dec_other');
    const otherRequested = createDecisionRequestedEvent(otherRequest, {
      eventId: 'evt_other_requested',
    });
    const malformed = {
      schemaVersion: 1,
      eventId: 'evt_malformed_answer',
      occurredAt: '2026-07-27T05:00:00.000Z',
      eventType: 'devloop_decision_answered',
      decisionId: request.decisionId,
    };
    const result = foldDecisionEvents([requested, otherRequested, malformed]);

    expect(result.fatal).toBe(false);
    expect(result.quarantinedDecisionIds).toContain(request.decisionId);
    expect(result.get(request.decisionId)).toBeUndefined();
    expect(result.get(otherRequest.decisionId)?.status).toBe('open');
    expect([...result.values()]).toHaveLength(1);
    expect(result.issues).toContainEqual(expect.objectContaining({
      eventId: 'evt_malformed_answer',
      decisionId: request.decisionId,
      code: 'invalid_event',
    }));
  });

  it('fails the entire fold for a malformed current-version event without a decision ID', () => {
    const result = foldDecisionEvents([
      requested,
      {
        schemaVersion: 1,
        eventId: 'evt_malformed_without_decision',
        eventType: 'devloop_decision_answered',
      },
    ]);

    expect(result.fatal).toBe(true);
    expect(result.get(request.decisionId)).toBeUndefined();
    expect([...result.values()]).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({
      eventId: 'evt_malformed_without_decision',
      code: 'invalid_event',
    }));
  });

  it('retains duplicate and unknown issues while fatally quarantining an unreadable stream', () => {
    const result = foldDecisionEvents([
      requested,
      {
        schemaVersion: 2,
        eventId: requested.eventId,
        aggregateId: request.decisionId,
        eventType: 'devloop_decision_requested',
      },
    ]);

    expect(result.fatal).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'unknown_schema_version',
      'duplicate_event_id',
    ]);
    expect(result.get(request.decisionId)).toBeUndefined();
    expect([...result.values()]).toEqual([]);
  });

  it('detects duplicate event IDs across unknown and known schema versions', () => {
    const futureRequested = {
      ...requested,
      schemaVersion: 2,
    };
    const result = foldDecisionEvents([futureRequested, requested]);

    expect(result.issues.map((issue) => issue.code)).toEqual([
      'unknown_schema_version',
      'duplicate_event_id',
    ]);
    expect(result.quarantinedDecisionIds).toContain(request.decisionId);
    expect(result.get(request.decisionId)).toBeUndefined();
  });

  it('classifies malformed payloads without schema versions as invalid events independently', () => {
    const result = foldDecisionEvents([
      {},
      null,
      'bad',
      {
        schemaVersion: 1,
        eventId: 'evt_missing_metadata',
        eventType: 'devloop_decision_answered',
      },
    ]);

    expect(result.issues).toHaveLength(4);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'invalid_event',
      'invalid_event',
      'invalid_event',
      'invalid_event',
    ]);
    expect(result.issues[3]).toMatchObject({
      eventId: 'evt_missing_metadata',
      code: 'invalid_event',
    });
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
    ['version increment', createVersionedRequest(2)],
    ['version jump', createVersionedRequest(4)],
    ['same version with a different context hash', createVersionedRequest(
      1,
      'Choose a revised compatibility policy.',
    )],
  ])('quarantines duplicate requests for the same decision ID: %s', (_case, duplicate) => {
    const duplicateEvent = createDecisionRequestedEvent(duplicate, {
      eventId: `evt_duplicate_request_${duplicate.decisionVersion}_${duplicate.contextHash.slice(0, 8)}`,
    });
    const result = foldDecisionEvents([requested, duplicateEvent]);

    expect(result.issues).toEqual([expect.objectContaining({
      eventId: duplicateEvent.eventId,
      decisionId: request.decisionId,
      code: 'duplicate_request',
    })]);
    expect(result.quarantinedDecisionIds).toContain(request.decisionId);
    expect(result.get(request.decisionId)).toBeUndefined();
    expect([...result.values()]).toEqual([]);
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

  it.each([4_000, 4_001, 5_000])(
    'accepts a %i-character text answer when the request permits it',
    (length) => {
      const textRequest = createTextRequest(10_000, 0, `dec_text_${length}`);
      const textRequested = createDecisionRequestedEvent(textRequest);
      const textAnswered = createDecisionAnsweredEvent({
        decisionId: textRequest.decisionId,
        decisionVersion: textRequest.decisionVersion,
        contextHash: textRequest.contextHash,
        value: { text: 'x'.repeat(length) },
        rationale: 'The boundary is explicit.',
        answeredBy: 'user:owner',
        idempotencyKey: `answer-text-${length}`,
      });
      const projection = foldDecisionEvents([textRequested, textAnswered])
        .get(textRequest.decisionId);

      expect(projection?.status).toBe('answered');
      expect(
        projection?.answer?.value !== undefined && 'text' in projection.answer.value
          ? projection.answer.value.text
          : undefined,
      ).toHaveLength(length);
    },
  );

  it('accepts the 100,000-character ledger boundary and rejects larger answer bodies', () => {
    const textRequest = createTextRequest(100_000);
    const baseInput = {
      decisionId: textRequest.decisionId,
      decisionVersion: textRequest.decisionVersion,
      contextHash: textRequest.contextHash,
      rationale: 'The boundary is explicit.',
      answeredBy: 'user:owner',
      idempotencyKey: 'answer-text-boundary',
    };

    const boundaryEvent = createDecisionAnsweredEvent({
      ...baseInput,
      value: { text: 'x'.repeat(100_000) },
    });
    expect(
      'text' in boundaryEvent.value ? boundaryEvent.value.text.length : undefined,
    ).toBe(100_000);
    expect(() => createDecisionAnsweredEvent({
      ...baseInput,
      value: { text: 'x'.repeat(100_001) },
    })).toThrow();
  });

  it('sanitizes secrets, control characters, and local paths in text answers', () => {
    const textRequest = createTextRequest(10_000, 0, 'dec_text_sanitized');
    const event = createDecisionAnsweredEvent({
      decisionId: textRequest.decisionId,
      decisionVersion: textRequest.decisionVersion,
      contextHash: textRequest.contextHash,
      value: {
        text: 'token=private-value\u0000 from /Users/private/worktree',
      },
      rationale: 'Sanitize before persistence.',
      answeredBy: 'user:owner',
      idempotencyKey: 'answer-text-sanitized',
    });

    expect(event.value).toEqual({
      text: 'token=[REDACTED] from [LOCAL_PATH]',
    });
  });

  it('validates text answer minimum and maximum against the active request during fold', () => {
    const textRequest = createTextRequest(10, 5, 'dec_text_fold_limits');
    const textRequested = createDecisionRequestedEvent(textRequest);
    const tooShort = createDecisionAnsweredEvent({
      decisionId: textRequest.decisionId,
      decisionVersion: textRequest.decisionVersion,
      contextHash: textRequest.contextHash,
      value: { text: 'xxxx' },
      rationale: 'Too short.',
      answeredBy: 'user:owner',
      idempotencyKey: 'answer-text-too-short',
    });
    const tooLong = createDecisionAnsweredEvent({
      decisionId: textRequest.decisionId,
      decisionVersion: textRequest.decisionVersion,
      contextHash: textRequest.contextHash,
      value: { text: 'x'.repeat(11) },
      rationale: 'Too long.',
      answeredBy: 'user:owner',
      idempotencyKey: 'answer-text-too-long',
    });

    for (const invalidAnswer of [tooShort, tooLong]) {
      const result = foldDecisionEvents([textRequested, invalidAnswer]);
      expect(result.get(textRequest.decisionId)?.status).toBe('open');
      expect(result.issues).toEqual([expect.objectContaining({
        code: 'invalid_transition',
      })]);
    }
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
    expect(Object.isFrozen(projection?.githubSync?.target)).toBe(true);
  });

  it.each([
    ['pending with comment ID', {
      status: 'pending',
      commentId: 'IC_kwDOexample',
    }],
    ['pending with error', {
      status: 'pending',
      sanitizedError: 'Not pending.',
    }],
    ['synced without comment ID', {
      status: 'synced',
    }],
    ['synced with error', {
      status: 'synced',
      commentId: 'IC_kwDOexample',
      sanitizedError: 'Contradictory success.',
    }],
    ['failed without error', {
      status: 'failed',
    }],
    ['failed with comment ID', {
      status: 'failed',
      commentId: 'IC_kwDOexample',
      sanitizedError: 'Sync failed.',
    }],
  ])('rejects an invalid GitHub sync state: %s', (_case, fields) => {
    expect(() => DecisionGithubSyncEventSchema.parse({
      ...createDecisionGithubSyncEvent({
        ...identity,
        target: {
          kind: 'issue',
          repository: 'albert-einshutoin/takt-private',
          number: 42,
        },
        status: 'pending',
      }),
      ...fields,
    })).toThrow();
  });

  it.each([
    [
      'repository',
      'https://github.com/another-owner/takt-private/issues/42#issuecomment-1',
    ],
    [
      'number',
      'https://github.com/albert-einshutoin/takt-private/issues/43#issuecomment-1',
    ],
    [
      'target kind',
      'https://github.com/albert-einshutoin/takt-private/pull/42#issuecomment-1',
    ],
    [
      'non-standard port',
      'https://github.com:444/albert-einshutoin/takt-private/issues/42#issuecomment-1',
    ],
    [
      'comment anchor',
      'https://github.com/albert-einshutoin/takt-private/issues/42#discussion_r1',
    ],
  ])('rejects a GitHub comment URL with mismatched %s', (_case, commentUrl) => {
    expect(() => createDecisionGithubSyncEvent({
      ...identity,
      target: {
        kind: 'issue',
        repository: 'albert-einshutoin/takt-private',
        number: 42,
      },
      status: 'synced',
      commentId: 'IC_kwDOexample',
      commentUrl,
    })).toThrow();
  });

  it('accepts a PR comment URL that exactly matches its GitHub target', () => {
    const event = createDecisionGithubSyncEvent({
      ...identity,
      target: {
        kind: 'pr',
        repository: 'albert-einshutoin/takt-private',
        number: 42,
      },
      status: 'synced',
      commentId: 'IC_kwDOexample',
      commentUrl: 'https://github.com/albert-einshutoin/takt-private/pull/42#issuecomment-1',
    });

    expect(event.status).toBe('synced');
  });

  it.each([
    [
      'requested',
      () => createDecisionRequestedEvent(request, {
        eventId: 'evt_deterministic',
        now: new Date('2026-07-27T03:00:00.000Z'),
      }),
    ],
    [
      'answered',
      () => createDecisionAnsweredEvent({
        ...identity,
        value: { optionId: 'preserve' },
        rationale: 'Keep compatibility.',
        answeredBy: 'user:owner',
        idempotencyKey: 'answer-deterministic',
      }, {
        eventId: 'evt_deterministic',
        now: new Date('2026-07-27T03:00:00.000Z'),
      }),
    ],
    [
      'answer_superseded',
      () => createDecisionAnswerSupersededEvent({
        ...identity,
        supersededAnswerEventId: answered.eventId,
        value: { optionId: 'break' },
        rationale: 'Use the migration path.',
        answeredBy: 'user:owner',
        idempotencyKey: 'answer-deterministic-v2',
      }, {
        eventId: 'evt_deterministic',
        now: new Date('2026-07-27T03:00:00.000Z'),
      }),
    ],
    [
      'apply_started',
      () => createDecisionApplyStartedEvent({
        ...identity,
        answerEventId: answered.eventId,
        sanitizedSummary: 'Applying.',
      }, {
        eventId: 'evt_deterministic',
        now: new Date('2026-07-27T03:00:00.000Z'),
      }),
    ],
    [
      'applied',
      () => createDecisionAppliedEvent({
        ...identity,
        answerEventId: answered.eventId,
        sanitizedSummary: 'Applied.',
      }, {
        eventId: 'evt_deterministic',
        now: new Date('2026-07-27T03:00:00.000Z'),
      }),
    ],
    [
      'apply_failed',
      () => createDecisionApplyFailedEvent({
        ...identity,
        answerEventId: answered.eventId,
        errorCode: 'APPLY_FAILED',
        sanitizedError: 'Application failed.',
      }, {
        eventId: 'evt_deterministic',
        now: new Date('2026-07-27T03:00:00.000Z'),
      }),
    ],
    [
      'revalidation_required',
      () => createDecisionRevalidationRequiredEvent({
        ...identity,
        answerEventId: answered.eventId,
        reasonCode: 'CONTEXT_CHANGED',
        sanitizedSummary: 'Context changed.',
      }, {
        eventId: 'evt_deterministic',
        now: new Date('2026-07-27T03:00:00.000Z'),
      }),
    ],
    [
      'github_sync',
      () => createDecisionGithubSyncEvent({
        ...identity,
        target: {
          kind: 'issue',
          repository: 'albert-einshutoin/takt-private',
          number: 42,
        },
        status: 'pending',
      }, {
        eventId: 'evt_deterministic',
        now: new Date('2026-07-27T03:00:00.000Z'),
      }),
    ],
  ] as const)('supports deterministic injection for the %s builder', (_name, buildEvent) => {
    const event = buildEvent();

    expect(event).toMatchObject({
      eventId: 'evt_deterministic',
      occurredAt: '2026-07-27T03:00:00.000Z',
    });
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
