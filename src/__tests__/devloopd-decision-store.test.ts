import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDecisionRequest, type DecisionRequest } from '../devloopd/decisionRequest.js';
import {
  createDecisionAnsweredEvent,
  createDecisionRequestedEvent,
} from '../devloopd/decisionEvents.js';
import { DecisionStore, DecisionStoreError } from '../devloopd/decisionStore.js';
import {
  MAX_DEVLOOP_LEDGER_BYTES,
  MAX_DEVLOOP_LEDGER_LINE_BYTES,
} from '../devloopd/ledger.js';

function makeRequest(
  repoPath: string,
  overrides: {
    decisionId?: string;
    kind?: 'choice' | 'text';
    rationaleRequired?: boolean;
    minimumTextLength?: number;
    maximumTextLength?: number;
  } = {},
): DecisionRequest {
  const decisionId = overrides.decisionId ?? 'dec_store';
  const common = {
    subject: {
      repoPath,
      runSlug: decisionId,
      title: 'Choose the safe implementation boundary',
    },
    question: 'Which implementation boundary is approved?',
    why: {
      summary: 'Automation cannot infer this product decision.',
      riskCategory: 'requirements_ambiguity' as const,
      reasons: ['The available evidence supports multiple valid outcomes.'],
      evidence: [],
    },
    how: {
      summary: 'Resume with the approved boundary.',
      expectedEffects: ['Apply only the approved change.'],
      verification: ['Verify the decision guard before resuming.'],
    },
    answerRequirements: {
      rationaleRequired: overrides.rationaleRequired ?? true,
      minimumTextLength: overrides.minimumTextLength ?? 3,
      maximumTextLength: overrides.maximumTextLength ?? 20,
    },
    resumeGuard: {
      strategy: 'direct_run' as const,
      expectedDecisionVersion: 1,
      runSlug: decisionId,
      expectedRunStatus: 'blocked',
    },
  };

  return overrides.kind === 'text'
    ? createDecisionRequest({ ...common, kind: 'text' }, {
      decisionId,
      now: new Date('2026-07-28T00:00:00.000Z'),
    })
    : createDecisionRequest({
      ...common,
      kind: 'choice',
      options: [
        {
          id: 'safe',
          title: 'Keep the safe boundary',
          description: 'Do not broaden the implementation.',
          consequences: [],
          recommended: true,
        },
        {
          id: 'broad',
          title: 'Broaden the boundary',
          description: 'Include the adjacent behavior.',
          consequences: [],
          recommended: false,
        },
      ],
    }, {
      decisionId,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
}

function answerFor(request: DecisionRequest) {
  return {
    decisionId: request.decisionId,
    expectedDecisionVersion: request.decisionVersion,
    expectedContextHash: request.contextHash,
    value: { optionId: 'safe' },
    rationale: 'Least privilege.',
    idempotencyKey: 'answer-store-v1',
  } as const;
}

function makeOversizedRequest(repoPath: string): DecisionRequest {
  // A three-byte UTF-8 character reaches the byte cap with fewer schema
  // elements, keeping this real-limit regression materially faster.
  const maximumText = 'あ'.repeat(4_000);
  const decisionId = 'dec_oversized';
  return createDecisionRequest({
    subject: {
      repoPath,
      runSlug: decisionId,
      title: maximumText,
    },
    kind: 'choice',
    question: maximumText,
    why: {
      summary: maximumText,
      riskCategory: 'requirements_ambiguity',
      reasons: [maximumText],
      evidence: [],
    },
    how: {
      summary: maximumText,
      expectedEffects: [maximumText],
      verification: [maximumText],
    },
    options: Array.from({ length: 2 }, (_, index) => ({
      id: `option-${index}`,
      title: maximumText,
      description: maximumText,
      consequences: Array.from({ length: 50 }, () => maximumText),
      recommended: index === 0,
    })),
    answerRequirements: {
      rationaleRequired: false,
      minimumTextLength: 0,
      maximumTextLength: 20,
    },
    resumeGuard: {
      strategy: 'direct_run',
      expectedDecisionVersion: 1,
      runSlug: decisionId,
      expectedRunStatus: 'blocked',
    },
  }, {
    decisionId,
    now: new Date('2026-07-28T00:00:00.000Z'),
  });
}

function buildStrictGenericLedger(totalBytes: number): string {
  const maxLineWithNewline = MAX_DEVLOOP_LEDGER_LINE_BYTES + 1;
  const emptyLine = `${JSON.stringify({
    eventType: 'generic_capacity_filler',
    padding: '',
  })}\n`;
  const minimumLineBytes = Buffer.byteLength(emptyLine, 'utf8');
  const chunks: string[] = [];
  let remaining = totalBytes;

  while (remaining > 0) {
    let lineBytes = Math.min(maxLineWithNewline, remaining);
    const tailBytes = remaining - lineBytes;
    if (tailBytes > 0 && tailBytes < minimumLineBytes) {
      lineBytes -= minimumLineBytes - tailBytes;
    }
    if (lineBytes < minimumLineBytes) throw new Error('Invalid ledger fixture size');
    const paddingBytes = lineBytes - minimumLineBytes;
    chunks.push(`${JSON.stringify({
      eventType: 'generic_capacity_filler',
      padding: 'x'.repeat(paddingBytes),
    })}\n`);
    remaining -= lineBytes;
  }

  return chunks.join('');
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('Expected DecisionStoreError');
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionStoreError);
    expect((error as DecisionStoreError).code).toBe(code);
  }
}

describe('DecisionStore', () => {
  let repoPath: string;
  let otherRepoPath: string;
  let ledgerPath: string;

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-decision-store-${randomUUID()}`);
    otherRepoPath = join(tmpdir(), `takt-decision-store-other-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(otherRepoPath, { recursive: true });
    ledgerPath = join(repoPath, '.devloop', 'ledger.jsonl');
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(otherRepoPath, { recursive: true, force: true });
  });

  it('persists a request and answer, then reloads the answered projection', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);

    store.request(request, {
      eventId: 'evt_store_requested',
      now: new Date('2026-07-28T00:01:00.000Z'),
    });
    const answered = store.answer(answerFor(request), 'user:owner', {
      eventId: 'evt_store_answered',
      now: new Date('2026-07-28T00:02:00.000Z'),
    });

    expect(answered.eventId).toBe('evt_store_answered');
    expect(new DecisionStore(repoPath).get(request.decisionId)).toMatchObject({
      status: 'answered',
      answer: { eventId: 'evt_store_answered', answeredBy: 'user:owner' },
    });
    expect(statSync(join(repoPath, '.devloop')).mode & 0o777).toBe(0o700);
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
  });

  it('does not create a ledger for reads and deduplicates identical requests', () => {
    const store = new DecisionStore(repoPath);
    expect(store.list()).toEqual([]);
    expect(existsSync(ledgerPath)).toBe(false);

    const request = makeRequest(repoPath);
    const first = store.request(request, { eventId: 'evt_request_first' });
    const retried = store.request(request, { eventId: 'evt_request_retry' });

    expect(retried.eventId).toBe(first.eventId);
    expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(1);
    const conflicting = makeRequest(repoPath, { decisionId: request.decisionId, kind: 'text' });
    expectCode(() => store.request(conflicting), 'request_conflict');
    expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('returns the original answer for an identical idempotent retry without appending', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);
    store.request(request, { eventId: 'evt_requested' });
    const first = store.answer(answerFor(request), 'user:owner', { eventId: 'evt_first' });
    const lineCount = readFileSync(ledgerPath, 'utf8').trim().split('\n').length;

    const retried = store.answer(answerFor(request), 'user:owner', { eventId: 'evt_second' });

    expect(retried.eventId).toBe(first.eventId);
    expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(lineCount);
  });

  it('rejects idempotency conflicts and a second key without appending', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);
    store.request(request);
    store.answer(answerFor(request), 'user:owner');
    const before = readFileSync(ledgerPath, 'utf8');

    expectCode(() => store.answer({
      ...answerFor(request),
      value: { optionId: 'broad' },
    }, 'user:owner'), 'idempotency_conflict');
    expectCode(() => store.answer(answerFor(request), 'user:other'), 'idempotency_conflict');
    expectCode(() => store.answer({
      ...answerFor(request),
      idempotencyKey: 'answer-store-v2',
    }, 'user:owner'), 'decision_not_open');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it('treats idempotency keys as ledger-wide answer identities', () => {
    const firstRequest = makeRequest(repoPath, { decisionId: 'dec_first' });
    const secondRequest = makeRequest(repoPath, { decisionId: 'dec_second' });
    const store = new DecisionStore(repoPath);
    store.request(firstRequest);
    store.request(secondRequest);
    store.answer(answerFor(firstRequest), 'user:owner');
    const before = readFileSync(ledgerPath, 'utf8');

    expectCode(() => store.answer({
      ...answerFor(secondRequest),
      idempotencyKey: answerFor(firstRequest).idempotencyKey,
    }, 'user:owner'), 'idempotency_conflict');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it('rejects invalid answer shapes, stale guards, and missing rationale without appending', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);
    store.request(request);
    const before = readFileSync(ledgerPath, 'utf8');

    expectCode(() => store.answer({
      ...answerFor(request),
      value: { optionId: 'missing' },
    }, 'user:owner'), 'invalid_answer');
    expectCode(() => store.answer({
      ...answerFor(request),
      value: { text: 'wrong kind' },
    }, 'user:owner'), 'invalid_answer');
    expectCode(() => store.answer({
      ...answerFor(request),
      expectedDecisionVersion: 2,
    }, 'user:owner'), 'stale_version');
    expectCode(() => store.answer({
      ...answerFor(request),
      expectedContextHash: '0'.repeat(64),
    }, 'user:owner'), 'stale_context');
    expectCode(() => store.answer({
      ...answerFor(request),
      rationale: ' \u001b[31m ',
    }, 'user:owner'), 'rationale_required');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it('validates text answer lengths and the non-required empty rationale event boundary', () => {
    const request = makeRequest(repoPath, {
      decisionId: 'dec_text',
      kind: 'text',
      rationaleRequired: false,
      minimumTextLength: 3,
      maximumTextLength: 5,
    });
    const store = new DecisionStore(repoPath);
    store.request(request);
    const input = {
      decisionId: request.decisionId,
      expectedDecisionVersion: request.decisionVersion,
      expectedContextHash: request.contextHash,
      rationale: '',
      idempotencyKey: 'answer-text-v1',
    };
    const before = readFileSync(ledgerPath, 'utf8');

    expectCode(() => store.answer({ ...input, value: { text: 'no' } }, 'user:owner'), 'invalid_answer');
    expectCode(() => store.answer({ ...input, value: { text: 'too-long' } }, 'user:owner'), 'invalid_answer');
    expectCode(
      () => store.answer({ ...input, value: { text: '\u0000ok' }, rationale: 'Reason.' }, 'user:owner'),
      'invalid_answer',
    );
    // The current persisted event contract requires non-empty rationale. Do not
    // invent a synthetic human rationale when the optional input is empty.
    expectCode(() => store.answer({ ...input, value: { text: 'okay' } }, 'user:owner'), 'invalid_answer');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it('fails closed on malformed, future-schema, and quarantined decision streams', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);
    store.request(request);
    writeFileSync(ledgerPath, `${readFileSync(ledgerPath, 'utf8')}${JSON.stringify({
      schemaVersion: 2,
      eventId: 'evt_future',
      eventType: 'devloop_decision_answered',
      decisionId: request.decisionId,
    })}\n`);
    const before = readFileSync(ledgerPath, 'utf8');
    expectCode(() => store.answer(answerFor(request), 'user:owner'), 'decision_quarantined');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);

    writeFileSync(ledgerPath, `${before}${JSON.stringify({
      schemaVersion: 2,
      eventId: 'evt_fatal',
      eventType: 'devloop_decision_unknown',
    })}\n`);
    expectCode(() => store.request(makeRequest(repoPath, { decisionId: 'dec_new' })), 'ledger_incompatible');
  });

  it('fails closed on a partial JSON tail without appending', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);
    store.request(request);
    writeFileSync(ledgerPath, '{"partial":', { flag: 'a' });
    const before = readFileSync(ledgerPath, 'utf8');

    expectCode(() => store.answer(answerFor(request), 'user:owner'), 'ledger_malformed');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it('requires a terminal newline for every non-empty ledger', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);
    store.request(request);
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').trimEnd());
    const before = readFileSync(ledgerPath, 'utf8');

    expectCode(() => store.answer(answerFor(request), 'user:owner'), 'ledger_malformed');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it('accepts CRLF-terminated ledger lines', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);
    store.request(request);
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replace(/\n/gu, '\r\n'));

    expect(store.get(request.decisionId)?.status).toBe('open');
  });

  it('fails closed on a primitive JSON ledger line without appending', () => {
    mkdirSync(join(repoPath, '.devloop'), { recursive: true });
    writeFileSync(ledgerPath, '42\n');
    const store = new DecisionStore(repoPath);
    const before = readFileSync(ledgerPath, 'utf8');

    expectCode(() => store.request(makeRequest(repoPath)), 'ledger_malformed');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it('does not expose ledger paths or answer text in typed errors', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);
    store.request(request);
    const secretAnswer = 'secret-answer-that-must-not-leak';

    try {
      store.answer({
        ...answerFor(request),
        value: { optionId: secretAnswer },
      }, 'user:owner');
      throw new Error('Expected DecisionStoreError');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionStoreError);
      expect((error as Error).message).not.toContain(repoPath);
      expect((error as Error).message).not.toContain(secretAnswer);
    }
  });

  it('refuses a ledger replaced with a symlink after store construction', () => {
    const victimPath = join(repoPath, 'victim.jsonl');
    const store = new DecisionStore(repoPath);
    mkdirSync(join(repoPath, '.devloop'), { recursive: true });
    writeFileSync(victimPath, 'preserve-me');
    symlinkSync(victimPath, ledgerPath);

    expectCode(() => store.request(makeRequest(repoPath)), 'ledger_malformed');
    expect(readFileSync(victimPath, 'utf8')).toBe('preserve-me');
  });

  it('sanitizes request lock timeout failures and does not append', () => {
    mkdirSync(join(repoPath, '.devloop'), { recursive: true });
    writeFileSync(`${ledgerPath}.lock`, JSON.stringify({ secret: 'do-not-leak' }));
    const store = new DecisionStore(repoPath);

    try {
      store.request(makeRequest(repoPath), {
        lock: { timeoutMs: 1, staleMs: 60_000 },
      });
      throw new Error('Expected DecisionStoreError');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionStoreError);
      expect((error as DecisionStoreError).code).toBe('ledger_unavailable');
      expect((error as Error).message).not.toContain(repoPath);
      expect((error as Error).message).not.toContain(ledgerPath);
      expect((error as Error).message).not.toContain('do-not-leak');
      expect(JSON.stringify(error)).not.toContain(repoPath);
      expect(JSON.stringify(error)).not.toContain('do-not-leak');
    }
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('sanitizes answer lock timeout failures and does not append', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);
    store.request(request);
    const before = readFileSync(ledgerPath, 'utf8');
    writeFileSync(`${ledgerPath}.lock`, JSON.stringify({ secret: 'do-not-leak' }));

    try {
      store.answer(answerFor(request), 'user:owner', {
        lock: { timeoutMs: 1, staleMs: 60_000 },
      });
      throw new Error('Expected DecisionStoreError');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionStoreError);
      expect((error as DecisionStoreError).code).toBe('ledger_unavailable');
      expect((error as Error).message).not.toContain(repoPath);
      expect((error as Error).message).not.toContain(ledgerPath);
      expect((error as Error).message).not.toContain('do-not-leak');
    }
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it('classifies an invalid server-side timestamp as ledger unavailable', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);
    store.request(request);
    const before = readFileSync(ledgerPath, 'utf8');

    expectCode(
      () => store.answer(answerFor(request), 'user:owner', { now: new Date('invalid') }),
      'ledger_unavailable',
    );
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it('rejects duplicate ledger-wide idempotency keys even when retrying the first answer', () => {
    const request = makeRequest(repoPath);
    const store = new DecisionStore(repoPath);
    store.request(request);
    const first = store.answer(answerFor(request), 'user:owner', {
      eventId: 'evt_first_duplicate_key',
    });
    const conflicting = createDecisionAnsweredEvent({
      decisionId: request.decisionId,
      decisionVersion: request.decisionVersion,
      contextHash: request.contextHash,
      value: { optionId: 'broad' },
      rationale: 'Broader behavior.',
      answeredBy: 'user:owner',
      idempotencyKey: first.idempotencyKey,
    }, { eventId: 'evt_second_duplicate_key' });
    writeFileSync(ledgerPath, `${JSON.stringify(conflicting)}\n`, { flag: 'a' });
    const before = readFileSync(ledgerPath, 'utf8');

    expectCode(() => store.answer(answerFor(request), 'user:owner'), 'idempotency_conflict');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it('canonicalizes repository and ledger aliases to one lock identity', () => {
    const repoAlias = join(otherRepoPath, 'repo-alias');
    symlinkSync(repoPath, repoAlias, 'dir');
    mkdirSync(join(repoPath, 'shared-ledger'), { recursive: true });
    const ledgerDirectoryAlias = join(otherRepoPath, 'ledger-alias');
    symlinkSync(join(repoPath, 'shared-ledger'), ledgerDirectoryAlias, 'dir');
    const canonical = new DecisionStore(repoPath, join(repoPath, 'shared-ledger', 'events.jsonl'));
    const aliased = new DecisionStore(repoAlias, join(ledgerDirectoryAlias, 'events.jsonl'));

    expect(aliased.repoPath).toBe(canonical.repoPath);
    expect(aliased.ledgerPath).toBe(canonical.ledgerPath);
    const request = makeRequest(repoPath, { decisionId: 'dec_alias' });
    canonical.request(request);
    writeFileSync(`${canonical.ledgerPath}.lock`, '{}');
    expectCode(
      () => aliased.request(makeRequest(repoPath, { decisionId: 'dec_alias_2' }), {
        lock: { timeoutMs: 1, staleMs: 60_000 },
      }),
      'ledger_unavailable',
    );
  });

  it('rejects a schema-valid request above the line limit without poisoning the ledger', () => {
    const store = new DecisionStore(repoPath);
    const oversized = makeOversizedRequest(repoPath);
    const serialized = JSON.stringify(createDecisionRequestedEvent(oversized));
    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(MAX_DEVLOOP_LEDGER_LINE_BYTES);

    expectCode(() => store.request(oversized), 'ledger_capacity_exceeded');
    expect(existsSync(ledgerPath)).toBe(false);

    const normal = makeRequest(repoPath, { decisionId: 'dec_after_capacity_rejection' });
    store.request(normal);
    expect(store.get(normal.decisionId)?.status).toBe('open');
  }, 60_000);

  it('rejects an append crossing the total byte limit without changing a strict ledger', () => {
    const request = makeRequest(repoPath, { decisionId: 'dec_total_capacity' });
    const options = {
      eventId: 'evt_total_capacity',
      now: new Date('2026-07-28T00:10:00.000Z'),
    };
    const appendBytes = Buffer.byteLength(
      `${JSON.stringify(createDecisionRequestedEvent(request, options))}\n`,
      'utf8',
    );
    const existingBytes = MAX_DEVLOOP_LEDGER_BYTES - appendBytes + 1;
    const content = buildStrictGenericLedger(existingBytes);
    expect(Buffer.byteLength(content, 'utf8')).toBe(existingBytes);
    mkdirSync(join(repoPath, '.devloop'), { recursive: true, mode: 0o700 });
    writeFileSync(ledgerPath, content, { mode: 0o600 });
    const beforeStat = statSync(ledgerPath);

    expectCode(() => storeRequest(), 'ledger_capacity_exceeded');
    const afterStat = statSync(ledgerPath);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    function storeRequest(): unknown {
      return new DecisionStore(repoPath).request(request, options);
    }
  });

  it('isolates shared ledgers by repository and coexists with generic events', () => {
    mkdirSync(join(repoPath, '.devloop'), { recursive: true });
    writeFileSync(ledgerPath, `${JSON.stringify({
      version: 1,
      eventId: 'evt_generic',
      eventType: 'devloop_issue_scout',
      timestamp: '2026-07-28T00:00:00.000Z',
    })}\n`);
    const store = new DecisionStore(repoPath, ledgerPath);
    expectCode(
      () => store.request(makeRequest(otherRepoPath, { decisionId: 'dec_other' })),
      'repository_mismatch',
    );

    const otherStore = new DecisionStore(otherRepoPath, ledgerPath);
    const otherRequest = makeRequest(otherRepoPath, { decisionId: 'dec_other' });
    otherStore.request(otherRequest);
    expect(store.list()).toEqual([]);
    expect(store.get(otherRequest.decisionId)).toBeUndefined();
    expectCode(() => store.answer(answerFor(otherRequest), 'user:owner'), 'decision_not_found');
    expect(existsSync(ledgerPath)).toBe(true);
  });
});
