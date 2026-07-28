import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ZodError } from 'zod/v4';
import {
  createDecisionAnsweredEvent,
  createDecisionRequestedEvent,
  foldDecisionEvents,
  parseDecisionEvent,
  type CreateDecisionEventOptions,
  type DecisionAnsweredEvent,
  type DecisionAnswerValue,
  type DecisionEvent,
  type DecisionFoldResult,
  type DecisionProjection,
  type DecisionRequestedEvent,
} from './decisionEvents.js';
import { DecisionRequestSchema, type DecisionRequest } from './decisionRequest.js';
import {
  canonicalizeDevloopLedgerPath,
  canonicalizeDevloopPath,
  DevloopLedgerCapacityError,
  MAX_DEVLOOP_LEDGER_BYTES,
  MAX_DEVLOOP_LEDGER_LINE_BYTES,
  resolveDevloopLedgerPath,
  withLockedDevloopLedgerTransaction,
} from './ledger.js';
import { type DevloopFileLockOptions } from './stateStore.js';

const DECISION_EVENT_PREFIX = 'devloop_decision_';
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CONTEXT_HASH_PATTERN = /^[a-f0-9]{64}$/u;

export type DecisionStoreErrorCode =
  | 'ledger_malformed'
  | 'ledger_incompatible'
  | 'ledger_unavailable'
  | 'ledger_capacity_exceeded'
  | 'decision_not_found'
  | 'decision_quarantined'
  | 'repository_mismatch'
  | 'stale_version'
  | 'stale_context'
  | 'decision_not_open'
  | 'invalid_answer'
  | 'rationale_required'
  | 'idempotency_conflict'
  | 'request_conflict'
  | 'invalid_identifier';

const ERROR_MESSAGES: Readonly<Record<DecisionStoreErrorCode, string>> = {
  ledger_malformed: 'The decision ledger is malformed',
  ledger_incompatible: 'The decision ledger contains incompatible decision events',
  ledger_unavailable: 'The decision ledger is unavailable',
  ledger_capacity_exceeded: 'The decision ledger capacity was exceeded',
  decision_not_found: 'The decision was not found',
  decision_quarantined: 'The decision is quarantined',
  repository_mismatch: 'The decision belongs to a different repository',
  stale_version: 'The decision version is stale',
  stale_context: 'The decision context is stale',
  decision_not_open: 'The decision is not open',
  invalid_answer: 'The answer is invalid for this decision',
  rationale_required: 'A non-empty rationale is required',
  idempotency_conflict: 'The idempotency key conflicts with a persisted answer',
  request_conflict: 'The decision ID conflicts with a persisted request',
  invalid_identifier: 'A decision identifier is invalid',
};

export class DecisionStoreError extends Error {
  readonly code: DecisionStoreErrorCode;

  constructor(code: DecisionStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'DecisionStoreError';
    this.code = code;
  }
}

const INTERNAL_FAILURE_CAUSES = new WeakMap<DecisionStoreError, unknown>();

function atStoreBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof DecisionStoreError) throw error;
    if (error instanceof DevloopLedgerCapacityError) {
      throw new DecisionStoreError('ledger_capacity_exceeded');
    }

    const sanitized = new DecisionStoreError('ledger_unavailable');
    // Filesystem and lock errors often contain absolute paths or OS details.
    // Keep the original available to an attached debugger without exposing it
    // through the public error object, enumeration, logging, or serialization.
    INTERNAL_FAILURE_CAUSES.set(sanitized, error);
    throw sanitized;
  }
}

export interface DecisionAnswerInput {
  readonly decisionId: string;
  readonly expectedDecisionVersion: number;
  readonly expectedContextHash: string;
  readonly value: DecisionAnswerValue;
  readonly rationale: string;
  readonly idempotencyKey: string;
}

export interface DecisionStoreWriteOptions extends CreateDecisionEventOptions {
  readonly lock?: DevloopFileLockOptions;
}

export interface StrictDecisionLedger {
  readonly events: readonly unknown[];
  readonly fold: DecisionFoldResult;
}

function fail(code: DecisionStoreErrorCode): never {
  throw new DecisionStoreError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function eventTypeOf(value: Record<string, unknown>): string | undefined {
  const eventType = Reflect.get(value, 'eventType');
  return typeof eventType === 'string' ? eventType : undefined;
}

function assertIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length > 200
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    fail('invalid_identifier');
  }
}

function assertLedgerFileBoundary(ledgerPath: string): void {
  if (existsSync(ledgerPath)) {
    const ledgerStat = lstatSync(ledgerPath);
    if (ledgerStat.isSymbolicLink() || !ledgerStat.isFile()) fail('ledger_malformed');
  }
  const ledgerDirectory = dirname(ledgerPath);
  if (existsSync(ledgerDirectory)) {
    const directoryStat = lstatSync(ledgerDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      fail('ledger_malformed');
    }
  }
}

function parseStrictDecisionLedger(ledgerPath: string): StrictDecisionLedger {
  assertLedgerFileBoundary(ledgerPath);
  if (!existsSync(ledgerPath)) {
    const fold = foldDecisionEvents([]);
    return Object.freeze({ events: Object.freeze([]), fold });
  }

  if (statSync(ledgerPath).size > MAX_DEVLOOP_LEDGER_BYTES) fail('ledger_malformed');
  const content = readFileSync(ledgerPath, 'utf8');
  if (content.length > 0 && !content.endsWith('\n')) fail('ledger_malformed');
  const events: unknown[] = [];

  for (const rawLine of content.split('\n')) {
    if (rawLine.trim().length === 0) continue;
    if (
      Buffer.byteLength(rawLine, 'utf8') > MAX_DEVLOOP_LEDGER_LINE_BYTES
    ) {
      fail('ledger_malformed');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      fail('ledger_malformed');
    }
    if (!isPlainRecord(parsed)) fail('ledger_malformed');
    const eventType = eventTypeOf(parsed);
    if (eventType === undefined) fail('ledger_malformed');
    if (eventType.startsWith(DECISION_EVENT_PREFIX)) events.push(parsed);
  }

  const fold = foldDecisionEvents(events);
  return Object.freeze({
    events: Object.freeze(events),
    fold,
  });
}

function sameValue(left: DecisionAnswerValue, right: DecisionAnswerValue): boolean {
  if ('optionId' in left && 'optionId' in right) return left.optionId === right.optionId;
  if ('text' in left && 'text' in right) return left.text === right.text;
  return false;
}

function sameRequest(left: DecisionRequest, right: DecisionRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectionBelongsToRepo(projection: DecisionProjection, repoPath: string): boolean {
  return canonicalizeDevloopPath(projection.request.subject.repoPath) === repoPath;
}

function validateAnswerValue(request: DecisionRequest, value: DecisionAnswerValue): void {
  if (!isPlainRecord(value)) fail('invalid_answer');
  if (request.kind === 'text') {
    const text = Reflect.get(value, 'text');
    if (
      !Object.hasOwn(value, 'text')
      || typeof text !== 'string'
      || Object.keys(value).length !== 1
    ) {
      fail('invalid_answer');
    }
    if (
      text.length < request.answerRequirements.minimumTextLength
      || text.length > request.answerRequirements.maximumTextLength
    ) {
      fail('invalid_answer');
    }
    return;
  }
  const optionId = Reflect.get(value, 'optionId');
  if (
    !Object.hasOwn(value, 'optionId')
    || typeof optionId !== 'string'
    || Object.keys(value).length !== 1
    || !request.options.some((option) => option.id === optionId)
  ) {
    fail('invalid_answer');
  }
}

function findAnsweredEvent(
  events: readonly DecisionEvent[],
  eventId: string,
): DecisionAnsweredEvent | undefined {
  return events.find(
    (event): event is DecisionAnsweredEvent =>
      event.eventType === 'devloop_decision_answered' && event.eventId === eventId,
  );
}

function parsedDecisionEvents(events: readonly unknown[]): readonly DecisionEvent[] {
  return events.flatMap((event) => {
    const parsed = parseDecisionEvent(event);
    return parsed.success ? [parsed.data] : [];
  });
}

export class DecisionStore {
  readonly repoPath: string;
  readonly ledgerPath: string;

  constructor(repoPath: string, ledgerPath?: string) {
    this.repoPath = canonicalizeDevloopPath(resolve(repoPath));
    this.ledgerPath = canonicalizeDevloopLedgerPath(
      resolveDevloopLedgerPath(this.repoPath, ledgerPath),
    );
  }

  readStrict(): StrictDecisionLedger {
    return atStoreBoundary(() => {
      const strict = parseStrictDecisionLedger(this.ledgerPath);
      if (strict.fold.fatal) fail('ledger_incompatible');
      return strict;
    });
  }

  list(): readonly DecisionProjection[] {
    return atStoreBoundary(() => {
      const strict = this.readStrict();
      return Object.freeze(
        [...strict.fold].filter((projection) => projectionBelongsToRepo(projection, this.repoPath)),
      );
    });
  }

  get(decisionId: string): DecisionProjection | undefined {
    return atStoreBoundary(() => {
      assertIdentifier(decisionId);
      return this.list().find((projection) => projection.request.decisionId === decisionId);
    });
  }

  request(
    request: DecisionRequest,
    options: DecisionStoreWriteOptions = {},
  ): DecisionRequestedEvent {
    return atStoreBoundary(() =>
      withLockedDevloopLedgerTransaction(this.ledgerPath, (transaction) => {
        const normalized = this.normalizeRequest(request);
        const strict = parseStrictDecisionLedger(this.ledgerPath);
        if (strict.fold.fatal) fail('ledger_incompatible');
        if (strict.fold.quarantinedDecisionIds.includes(normalized.decisionId)) {
          fail('decision_quarantined');
        }

        const decisionEvents = parsedDecisionEvents(strict.events);
        const existing = decisionEvents.find(
          (event): event is DecisionRequestedEvent =>
            event.eventType === 'devloop_decision_requested'
            && event.decisionId === normalized.decisionId,
        );
        if (existing !== undefined) {
          const existingNormalized = this.normalizeRequest(existing.request);
          if (sameRequest(existingNormalized, normalized)) return existing;
          fail('request_conflict');
        }

        const event = createDecisionRequestedEvent(normalized, options);
        transaction.append(event);
        return event;
      }, options.lock),
    );
  }

  answer(
    input: DecisionAnswerInput,
    actor: string,
    options: DecisionStoreWriteOptions = {},
  ): DecisionAnsweredEvent {
    assertIdentifier(input.decisionId);
    assertIdentifier(input.idempotencyKey);
    assertIdentifier(actor);
    if (typeof input.rationale !== 'string') fail('invalid_answer');
    if (!Number.isInteger(input.expectedDecisionVersion) || input.expectedDecisionVersion <= 0) {
      fail('stale_version');
    }
    if (!CONTEXT_HASH_PATTERN.test(input.expectedContextHash)) fail('stale_context');

    return atStoreBoundary(() => withLockedDevloopLedgerTransaction(
      this.ledgerPath,
      (transaction) => {
      const strict = parseStrictDecisionLedger(this.ledgerPath);
      if (strict.fold.fatal) fail('ledger_incompatible');
      if (strict.fold.quarantinedDecisionIds.includes(input.decisionId)) {
        fail('decision_quarantined');
      }

      const projection = strict.fold.get(input.decisionId);
      if (projection === undefined || !projectionBelongsToRepo(projection, this.repoPath)) {
        fail('decision_not_found');
      }
      if (projection.request.decisionVersion !== input.expectedDecisionVersion) {
        fail('stale_version');
      }
      if (projection.request.contextHash !== input.expectedContextHash) fail('stale_context');
      validateAnswerValue(projection.request, input.value);

      let candidate: DecisionAnsweredEvent;
      try {
        candidate = createDecisionAnsweredEvent({
          decisionId: input.decisionId,
          decisionVersion: input.expectedDecisionVersion,
          contextHash: input.expectedContextHash,
          value: input.value,
          rationale: input.rationale,
          answeredBy: actor,
          idempotencyKey: input.idempotencyKey,
        }, options);
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        const rationaleIsInvalid = error.issues.some(
          (issue) => issue.path[0] === 'rationale',
        );
        if (
          rationaleIsInvalid
          && projection.request.answerRequirements.rationaleRequired
        ) {
          fail('rationale_required');
        }
        // The current event schema requires persisted rationale even when the
        // request does not. Reject empty sanitized input instead of inventing
        // words that the human did not provide.
        fail('invalid_answer');
      }
      // Event serialization sanitizes public text. Re-check the persisted form
      // so a control sequence or redaction cannot shrink a text answer below
      // the request guard after the pre-validation passed.
      validateAnswerValue(projection.request, candidate.value);

      const parsedEvents = parsedDecisionEvents(strict.events);
      const persistedWithKey = parsedEvents.filter(
        (event): event is DecisionAnsweredEvent =>
          event.eventType === 'devloop_decision_answered'
          && event.idempotencyKey === candidate.idempotencyKey,
      );
      if (persistedWithKey.length > 0) {
        const persisted = persistedWithKey[0];
        if (
          persistedWithKey.length === 1
          && persisted !== undefined
          && projection.answer?.eventId === persisted.eventId
          && persisted.decisionId === candidate.decisionId
          && persisted.decisionVersion === candidate.decisionVersion
          && persisted.contextHash === candidate.contextHash
          && sameValue(persisted.value, candidate.value)
          && persisted.rationale === candidate.rationale
          && persisted.answeredBy === candidate.answeredBy
        ) {
          return persisted;
        }
        fail('idempotency_conflict');
      }

      if (projection.answer !== undefined) {
        const persisted = findAnsweredEvent(
          parsedEvents,
          projection.answer.eventId,
        );
        if (
          persisted !== undefined
          && persisted.idempotencyKey === candidate.idempotencyKey
        ) {
          if (
            persisted.decisionId === candidate.decisionId
            && persisted.decisionVersion === candidate.decisionVersion
            && persisted.contextHash === candidate.contextHash
            && sameValue(persisted.value, candidate.value)
            && persisted.rationale === candidate.rationale
            && persisted.answeredBy === candidate.answeredBy
          ) {
            return persisted;
          }
          fail('idempotency_conflict');
        }
        fail('decision_not_open');
      }
      if (projection.status !== 'open') fail('decision_not_open');

      transaction.append(candidate);
      return candidate;
      },
      options.lock,
    ));
  }

  private normalizeRequest(request: DecisionRequest): DecisionRequest {
    let parsed: DecisionRequest;
    try {
      parsed = DecisionRequestSchema.parse({
        ...request,
        subject: {
          ...request.subject,
          repoPath: canonicalizeDevloopPath(request.subject.repoPath),
        },
      });
    } catch {
      fail('request_conflict');
    }
    if (parsed.subject.repoPath !== this.repoPath) fail('repository_mismatch');
    return parsed;
  }
}
