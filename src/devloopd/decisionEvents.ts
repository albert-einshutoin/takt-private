import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';
import { stripAnsi } from '../shared/utils/text.js';
import { DecisionRequestSchema, type DecisionRequest } from './decisionRequest.js';

const MAX_PUBLIC_TEXT_LENGTH = 4_000;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;
const FORMAT_CONTROL_PATTERN = /\p{Cf}/gu;
const LOCAL_PATH_PATTERN = /(^|[\s("'=])(?:\/(?!\/)[^\s,;)"']*|[A-Za-z]:[\\/][^\s,;)"']*)/gu;
const FILE_URL_LOCAL_PATH_PATTERN = /\bfile:\/\/\/[^\s,;)"']+/giu;

const PublicTextSchema = z.string().max(MAX_PUBLIC_TEXT_LENGTH).transform((value) => (
  sanitizeSensitiveText(
    stripAnsi(value)
      .replace(CONTROL_CHARACTER_PATTERN, ' ')
      .replace(FORMAT_CONTROL_PATTERN, ''),
  )
    .replace(FILE_URL_LOCAL_PATH_PATTERN, '[LOCAL_PATH]')
    .replace(LOCAL_PATH_PATTERN, '$1[LOCAL_PATH]')
    .replace(/\s+/gu, ' ')
    .trim()
)).pipe(z.string().min(1).max(MAX_PUBLIC_TEXT_LENGTH));

const IdentifierSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const ContextHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const RepositorySchema = z.string()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/u);

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

const EventMetadataShape = {
  schemaVersion: z.literal(1),
  eventId: IdentifierSchema,
  occurredAt: z.iso.datetime(),
};

const TransitionIdentityShape = {
  decisionId: IdentifierSchema,
  decisionVersion: z.number().int().positive(),
  contextHash: ContextHashSchema,
};

export const DecisionAnswerValueSchema = z.union([
  z.object({ optionId: IdentifierSchema }).strict(),
  z.object({ text: PublicTextSchema }).strict(),
]);
export type DecisionAnswerValue = z.output<typeof DecisionAnswerValueSchema>;

const AnswerShape = {
  value: DecisionAnswerValueSchema,
  rationale: PublicTextSchema,
  answeredBy: IdentifierSchema,
  idempotencyKey: IdentifierSchema,
};

const RequestedEventRawSchema = z.object({
  ...EventMetadataShape,
  ...TransitionIdentityShape,
  eventType: z.literal('devloop_decision_requested'),
  request: DecisionRequestSchema,
}).strict().superRefine((event, context) => {
  if (
    event.decisionId !== event.request.decisionId
    || event.decisionVersion !== event.request.decisionVersion
    || event.contextHash !== event.request.contextHash
  ) {
    context.addIssue({
      code: 'custom',
      path: ['request'],
      message: 'Event identity must match the immutable decision request',
    });
  }
});

const AnsweredEventRawSchema = z.object({
  ...EventMetadataShape,
  ...TransitionIdentityShape,
  ...AnswerShape,
  eventType: z.literal('devloop_decision_answered'),
}).strict();

const AnswerSupersededEventRawSchema = z.object({
  ...EventMetadataShape,
  ...TransitionIdentityShape,
  ...AnswerShape,
  eventType: z.literal('devloop_decision_answer_superseded'),
  supersededAnswerEventId: IdentifierSchema,
}).strict();

const ApplyStartedEventRawSchema = z.object({
  ...EventMetadataShape,
  ...TransitionIdentityShape,
  eventType: z.literal('devloop_decision_apply_started'),
  answerEventId: IdentifierSchema,
  sanitizedSummary: PublicTextSchema,
}).strict();

const AppliedEventRawSchema = z.object({
  ...EventMetadataShape,
  ...TransitionIdentityShape,
  eventType: z.literal('devloop_decision_applied'),
  answerEventId: IdentifierSchema,
  sanitizedSummary: PublicTextSchema,
}).strict();

const ApplyFailedEventRawSchema = z.object({
  ...EventMetadataShape,
  ...TransitionIdentityShape,
  eventType: z.literal('devloop_decision_apply_failed'),
  answerEventId: IdentifierSchema,
  errorCode: IdentifierSchema,
  sanitizedError: PublicTextSchema,
}).strict();

const RevalidationRequiredEventRawSchema = z.object({
  ...EventMetadataShape,
  ...TransitionIdentityShape,
  eventType: z.literal('devloop_decision_revalidation_required'),
  answerEventId: IdentifierSchema,
  reasonCode: IdentifierSchema,
  sanitizedSummary: PublicTextSchema,
}).strict();

export const DecisionGithubTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('issue'),
    repository: RepositorySchema,
    number: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('pr'),
    repository: RepositorySchema,
    number: z.number().int().positive(),
  }).strict(),
]);
export type DecisionGithubTarget = z.output<typeof DecisionGithubTargetSchema>;

const GithubSyncEventRawSchema = z.object({
  ...EventMetadataShape,
  ...TransitionIdentityShape,
  eventType: z.literal('devloop_decision_github_sync'),
  target: DecisionGithubTargetSchema,
  status: z.enum(['pending', 'synced', 'failed']),
  commentId: IdentifierSchema.optional(),
  commentUrl: z.url({ protocol: /^https$/u, hostname: /^github\.com$/u }).optional(),
  sanitizedError: PublicTextSchema.optional(),
}).strict().superRefine((event, context) => {
  if (event.status === 'synced' && event.commentId === undefined && event.commentUrl === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'A synced event must identify the resulting GitHub comment',
    });
  }
  if (event.status === 'failed' && event.sanitizedError === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['sanitizedError'],
      message: 'A failed event must contain a sanitized error',
    });
  }
});

export const DecisionRequestedEventSchema = RequestedEventRawSchema.transform(deepFreeze);
export type DecisionRequestedEvent = z.output<typeof DecisionRequestedEventSchema>;
export const DecisionAnsweredEventSchema = AnsweredEventRawSchema.transform(deepFreeze);
export type DecisionAnsweredEvent = z.output<typeof DecisionAnsweredEventSchema>;
export const DecisionAnswerSupersededEventSchema =
  AnswerSupersededEventRawSchema.transform(deepFreeze);
export type DecisionAnswerSupersededEvent =
  z.output<typeof DecisionAnswerSupersededEventSchema>;
export const DecisionApplyStartedEventSchema = ApplyStartedEventRawSchema.transform(deepFreeze);
export type DecisionApplyStartedEvent = z.output<typeof DecisionApplyStartedEventSchema>;
export const DecisionAppliedEventSchema = AppliedEventRawSchema.transform(deepFreeze);
export type DecisionAppliedEvent = z.output<typeof DecisionAppliedEventSchema>;
export const DecisionApplyFailedEventSchema = ApplyFailedEventRawSchema.transform(deepFreeze);
export type DecisionApplyFailedEvent = z.output<typeof DecisionApplyFailedEventSchema>;
export const DecisionRevalidationRequiredEventSchema =
  RevalidationRequiredEventRawSchema.transform(deepFreeze);
export type DecisionRevalidationRequiredEvent =
  z.output<typeof DecisionRevalidationRequiredEventSchema>;
export const DecisionGithubSyncEventSchema = GithubSyncEventRawSchema.transform(deepFreeze);
export type DecisionGithubSyncEvent = z.output<typeof DecisionGithubSyncEventSchema>;

// Answers, application attempts, and public synchronization are separate events because
// each has a different retry/idempotency boundary. In particular, a failed application
// must never erase the human answer or make GitHub availability part of decision safety.
export const DecisionEventSchema = z.union([
  DecisionRequestedEventSchema,
  DecisionAnsweredEventSchema,
  DecisionAnswerSupersededEventSchema,
  DecisionApplyStartedEventSchema,
  DecisionAppliedEventSchema,
  DecisionApplyFailedEventSchema,
  DecisionRevalidationRequiredEventSchema,
  DecisionGithubSyncEventSchema,
]);
export type DecisionEvent = z.output<typeof DecisionEventSchema>;

export function parseDecisionEvent(value: unknown): ReturnType<typeof DecisionEventSchema.safeParse> {
  return DecisionEventSchema.safeParse(value);
}

export interface CreateDecisionEventOptions {
  eventId?: string;
  now?: Date;
}

function metadata(options: CreateDecisionEventOptions): {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
} {
  return {
    schemaVersion: 1,
    eventId: options.eventId ?? `evt_${randomUUID()}`,
    occurredAt: (options.now ?? new Date()).toISOString(),
  };
}

type TransitionIdentity = {
  decisionId: string;
  decisionVersion: number;
  contextHash: string;
};

type AnswerInput = TransitionIdentity & {
  value: DecisionAnswerValue;
  rationale: string;
  answeredBy: string;
  idempotencyKey: string;
};

export function createDecisionRequestedEvent(
  request: DecisionRequest,
  options: CreateDecisionEventOptions = {},
): DecisionRequestedEvent {
  return DecisionRequestedEventSchema.parse({
    ...metadata(options),
    eventType: 'devloop_decision_requested',
    decisionId: request.decisionId,
    decisionVersion: request.decisionVersion,
    contextHash: request.contextHash,
    request,
  });
}

export function createDecisionAnsweredEvent(
  input: AnswerInput,
  options: CreateDecisionEventOptions = {},
): DecisionAnsweredEvent {
  return DecisionAnsweredEventSchema.parse({
    ...metadata(options),
    eventType: 'devloop_decision_answered',
    ...input,
  });
}

export function createDecisionAnswerSupersededEvent(
  input: AnswerInput & { supersededAnswerEventId: string },
  options: CreateDecisionEventOptions = {},
): DecisionAnswerSupersededEvent {
  return DecisionAnswerSupersededEventSchema.parse({
    ...metadata(options),
    eventType: 'devloop_decision_answer_superseded',
    ...input,
  });
}

type ApplyStartedInput = TransitionIdentity & {
  answerEventId: string;
  sanitizedSummary: string;
};

export function createDecisionApplyStartedEvent(
  input: ApplyStartedInput,
  options: CreateDecisionEventOptions = {},
): DecisionApplyStartedEvent {
  return DecisionApplyStartedEventSchema.parse({
    ...metadata(options),
    eventType: 'devloop_decision_apply_started',
    ...input,
  });
}

export function createDecisionAppliedEvent(
  input: ApplyStartedInput,
  options: CreateDecisionEventOptions = {},
): DecisionAppliedEvent {
  return DecisionAppliedEventSchema.parse({
    ...metadata(options),
    eventType: 'devloop_decision_applied',
    ...input,
  });
}

export function createDecisionApplyFailedEvent(
  input: TransitionIdentity & {
    answerEventId: string;
    errorCode: string;
    sanitizedError: string;
  },
  options: CreateDecisionEventOptions = {},
): DecisionApplyFailedEvent {
  return DecisionApplyFailedEventSchema.parse({
    ...metadata(options),
    eventType: 'devloop_decision_apply_failed',
    ...input,
  });
}

export function createDecisionRevalidationRequiredEvent(
  input: TransitionIdentity & {
    answerEventId: string;
    reasonCode: string;
    sanitizedSummary: string;
  },
  options: CreateDecisionEventOptions = {},
): DecisionRevalidationRequiredEvent {
  return DecisionRevalidationRequiredEventSchema.parse({
    ...metadata(options),
    eventType: 'devloop_decision_revalidation_required',
    ...input,
  });
}

export function createDecisionGithubSyncEvent(
  input: TransitionIdentity & {
    target: DecisionGithubTarget;
    status: 'pending' | 'synced' | 'failed';
    commentId?: string;
    commentUrl?: string;
    sanitizedError?: string;
  },
  options: CreateDecisionEventOptions = {},
): DecisionGithubSyncEvent {
  return DecisionGithubSyncEventSchema.parse({
    ...metadata(options),
    eventType: 'devloop_decision_github_sync',
    ...input,
  });
}

export interface DecisionProjectionAnswer {
  readonly eventId: string;
  readonly value: DecisionAnswerValue;
  readonly rationale: string;
  readonly answeredBy: string;
  readonly idempotencyKey: string;
  readonly supersededAnswerEventId?: string;
}

export type DecisionApplyResult =
  | {
    readonly status: 'applying' | 'applied';
    readonly eventId: string;
    readonly answerEventId: string;
    readonly sanitizedSummary: string;
  }
  | {
    readonly status: 'failed';
    readonly eventId: string;
    readonly answerEventId: string;
    readonly errorCode: string;
    readonly sanitizedError: string;
  }
  | {
    readonly status: 'revalidation_required';
    readonly eventId: string;
    readonly answerEventId: string;
    readonly reasonCode: string;
    readonly sanitizedSummary: string;
  };

export interface DecisionGithubSyncProjection {
  readonly eventId: string;
  readonly target: DecisionGithubTarget;
  readonly status: 'pending' | 'synced' | 'failed';
  readonly commentId?: string;
  readonly commentUrl?: string;
  readonly sanitizedError?: string;
}

export interface DecisionProjection {
  readonly request: DecisionRequest;
  readonly status: 'open' | 'answered' | 'applying' | 'applied' | 'revalidation_required';
  readonly answer?: DecisionProjectionAnswer;
  readonly applyResult?: DecisionApplyResult;
  readonly githubSync?: DecisionGithubSyncProjection;
}

export type DecisionFoldIssueCode =
  | 'unknown_schema_version'
  | 'duplicate_event_id'
  | 'invalid_event'
  | 'request_missing'
  | 'duplicate_request'
  | 'version_mismatch'
  | 'context_hash_mismatch'
  | 'answer_event_mismatch'
  | 'invalid_transition';

export interface DecisionFoldIssue {
  readonly eventId: string;
  readonly decisionId?: string;
  readonly code: DecisionFoldIssueCode;
  readonly message: string;
}

export interface DecisionFoldResult extends Iterable<DecisionProjection> {
  readonly issues: readonly DecisionFoldIssue[];
  get(decisionId: string): DecisionProjection | undefined;
  values(): IterableIterator<DecisionProjection>;
}

type MutableProjection = {
  request: DecisionRequest;
  status: DecisionProjection['status'];
  answer?: DecisionProjectionAnswer;
  applyResult?: DecisionApplyResult;
  githubSync?: DecisionGithubSyncProjection;
};

function rawString(
  value: unknown,
  key: 'eventId' | 'decisionId',
  fallback?: string,
): string | undefined {
  if (value === null || typeof value !== 'object') return fallback;
  const candidate = Reflect.get(value, key);
  return typeof candidate === 'string' ? candidate : fallback;
}

function issueFor(
  event: { eventId: string; decisionId?: string },
  code: DecisionFoldIssueCode,
  message: string,
): DecisionFoldIssue {
  return deepFreeze({
    eventId: event.eventId,
    ...(event.decisionId === undefined ? {} : { decisionId: event.decisionId }),
    code,
    message,
  });
}

function answerMatchesRequest(
  request: DecisionRequest,
  value: DecisionAnswerValue,
): boolean {
  if (request.kind === 'text') {
    return 'text' in value
      && value.text.length >= request.answerRequirements.minimumTextLength
      && value.text.length <= request.answerRequirements.maximumTextLength;
  }
  return 'optionId' in value
    && request.options.some((option) => option.id === value.optionId);
}

function projectAnswer(
  event: DecisionAnsweredEvent | DecisionAnswerSupersededEvent,
): DecisionProjectionAnswer {
  return deepFreeze({
    eventId: event.eventId,
    value: event.value,
    rationale: event.rationale,
    answeredBy: event.answeredBy,
    idempotencyKey: event.idempotencyKey,
    ...(event.eventType === 'devloop_decision_answer_superseded'
      ? { supersededAnswerEventId: event.supersededAnswerEventId }
      : {}),
  });
}

function applyTransition(
  projection: MutableProjection,
  event: Exclude<DecisionEvent, DecisionRequestedEvent | DecisionGithubSyncEvent>,
): DecisionFoldIssue | undefined {
  if (
    event.eventType !== 'devloop_decision_answered'
    && event.eventType !== 'devloop_decision_answer_superseded'
    && projection.answer !== undefined
    && projection.answer?.eventId !== event.answerEventId
  ) {
    return issueFor(event, 'answer_event_mismatch', 'The event references a non-active answer');
  }

  switch (event.eventType) {
    case 'devloop_decision_answered':
      if (projection.status !== 'open' || !answerMatchesRequest(projection.request, event.value)) {
        return issueFor(event, 'invalid_transition', 'The answer is invalid for the open request');
      }
      projection.answer = projectAnswer(event);
      projection.status = 'answered';
      return undefined;
    case 'devloop_decision_answer_superseded':
      if (
        projection.status !== 'answered'
        || projection.applyResult !== undefined
        || projection.answer?.eventId !== event.supersededAnswerEventId
        || !answerMatchesRequest(projection.request, event.value)
      ) {
        return issueFor(event, 'invalid_transition', 'The active unapplied answer cannot be superseded');
      }
      projection.answer = projectAnswer(event);
      return undefined;
    case 'devloop_decision_apply_started':
      if (projection.status !== 'answered') {
        return issueFor(event, 'invalid_transition', 'Application can only start from answered');
      }
      projection.status = 'applying';
      projection.applyResult = deepFreeze({
        status: 'applying',
        eventId: event.eventId,
        answerEventId: event.answerEventId,
        sanitizedSummary: event.sanitizedSummary,
      });
      return undefined;
    case 'devloop_decision_applied':
      if (projection.status !== 'applying') {
        return issueFor(event, 'invalid_transition', 'Application can only complete from applying');
      }
      projection.status = 'applied';
      projection.applyResult = deepFreeze({
        status: 'applied',
        eventId: event.eventId,
        answerEventId: event.answerEventId,
        sanitizedSummary: event.sanitizedSummary,
      });
      return undefined;
    case 'devloop_decision_apply_failed':
      if (projection.status !== 'applying') {
        return issueFor(event, 'invalid_transition', 'Application can only fail from applying');
      }
      projection.status = 'answered';
      projection.applyResult = deepFreeze({
        status: 'failed',
        eventId: event.eventId,
        answerEventId: event.answerEventId,
        errorCode: event.errorCode,
        sanitizedError: event.sanitizedError,
      });
      return undefined;
    case 'devloop_decision_revalidation_required':
      if (projection.status !== 'answered' && projection.status !== 'applying') {
        return issueFor(
          event,
          'invalid_transition',
          'Revalidation can only be requested for an answered or applying decision',
        );
      }
      projection.status = 'revalidation_required';
      projection.applyResult = deepFreeze({
        status: 'revalidation_required',
        eventId: event.eventId,
        answerEventId: event.answerEventId,
        reasonCode: event.reasonCode,
        sanitizedSummary: event.sanitizedSummary,
      });
      return undefined;
  }
}

export function foldDecisionEvents(events: readonly unknown[]): DecisionFoldResult {
  const projections = new Map<string, MutableProjection>();
  const issues: DecisionFoldIssue[] = [];
  const seenEventIds = new Set<string>();

  for (const rawEvent of events) {
    const eventId = rawString(rawEvent, 'eventId', '[unknown-event]') ?? '[unknown-event]';
    const decisionId = rawString(rawEvent, 'decisionId');
    if (seenEventIds.has(eventId)) {
      issues.push(issueFor({ eventId, decisionId }, 'duplicate_event_id', 'Duplicate event ID'));
      continue;
    }
    seenEventIds.add(eventId);

    if (
      rawEvent !== null
      && typeof rawEvent === 'object'
      && Reflect.get(rawEvent, 'schemaVersion') !== 1
    ) {
      issues.push(issueFor(
        { eventId, decisionId },
        'unknown_schema_version',
        'Unsupported decision event schema version',
      ));
      continue;
    }

    const parsed = parseDecisionEvent(rawEvent);
    if (!parsed.success) {
      issues.push(issueFor(
        { eventId, decisionId },
        'invalid_event',
        'Decision event failed strict validation',
      ));
      continue;
    }
    const event = parsed.data;

    if (event.eventType === 'devloop_decision_requested') {
      if (projections.has(event.decisionId)) {
        issues.push(issueFor(event, 'duplicate_request', 'Decision request already exists'));
        continue;
      }
      projections.set(event.decisionId, {
        request: event.request,
        status: 'open',
      });
      continue;
    }

    const projection = projections.get(event.decisionId);
    if (projection === undefined) {
      issues.push(issueFor(event, 'request_missing', 'No active decision request exists'));
      continue;
    }
    if (event.decisionVersion !== projection.request.decisionVersion) {
      issues.push(issueFor(event, 'version_mismatch', 'Decision version does not match'));
      continue;
    }
    if (event.contextHash !== projection.request.contextHash) {
      issues.push(issueFor(event, 'context_hash_mismatch', 'Decision context hash does not match'));
      continue;
    }

    if (event.eventType === 'devloop_decision_github_sync') {
      projection.githubSync = deepFreeze({
        eventId: event.eventId,
        target: event.target,
        status: event.status,
        ...(event.commentId === undefined ? {} : { commentId: event.commentId }),
        ...(event.commentUrl === undefined ? {} : { commentUrl: event.commentUrl }),
        ...(event.sanitizedError === undefined
          ? {}
          : { sanitizedError: event.sanitizedError }),
      });
      continue;
    }

    const transitionIssue = applyTransition(projection, event);
    if (transitionIssue !== undefined) issues.push(transitionIssue);
  }

  const frozenProjections = new Map<string, DecisionProjection>();
  for (const [decisionId, projection] of projections) {
    frozenProjections.set(decisionId, deepFreeze({ ...projection }));
  }
  const frozenIssues = deepFreeze(issues);
  const result: DecisionFoldResult = {
    issues: frozenIssues,
    get(decisionId: string): DecisionProjection | undefined {
      return frozenProjections.get(decisionId);
    },
    values(): IterableIterator<DecisionProjection> {
      return frozenProjections.values();
    },
    [Symbol.iterator](): IterableIterator<DecisionProjection> {
      return frozenProjections.values();
    },
  };
  return Object.freeze(result);
}
