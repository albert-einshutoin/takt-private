import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';
import { stripAnsi } from '../shared/utils/text.js';
import type { DevloopAutomationStage } from './prAutomation.js';

const MAX_PUBLIC_TEXT_LENGTH = 4_000;
const FILE_URL_LOCAL_PATH_PATTERN = /\bfile:\/\/\/[^\s,;)"']+/giu;
const CWD_LOCAL_PATH_PATTERN = /\bcwd:\s*(?:\/[^\s,;)"']*|[A-Za-z]:[\\/][^\s,;)"']*)/giu;
const LOCAL_PATH_PATTERN = /(^|[\s("'=])(?:\/(?!\/)[^\s,;)"']*|[A-Za-z]:[\\/][^\s,;)"']*)/gu;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;
const FORMAT_CONTROL_PATTERN = /\p{Cf}/gu;

const PublicTextSchema = z.string().max(MAX_PUBLIC_TEXT_LENGTH).transform((value) => {
  const controlsRemoved = stripAnsi(value)
    .replace(CONTROL_CHARACTER_PATTERN, ' ')
    .replace(FORMAT_CONTROL_PATTERN, '');

  return sanitizeSensitiveText(controlsRemoved)
    .replace(FILE_URL_LOCAL_PATH_PATTERN, '[LOCAL_PATH]')
    .replace(CWD_LOCAL_PATH_PATTERN, 'cwd:[LOCAL_PATH]')
    .replace(LOCAL_PATH_PATTERN, '$1[LOCAL_PATH]')
    .replace(/\s+/gu, ' ')
    .trim();
}).pipe(z.string().min(1).max(MAX_PUBLIC_TEXT_LENGTH));

const IdentifierSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const CandidateIdentifierSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const RepositorySchema = z.string()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/u);
const DEVLOOP_AUTOMATION_STAGE_VALUES = [
  'issue-scout',
  'issue-to-pr',
  'pr-review',
  'review-fix',
  'pr-merge',
] as const satisfies readonly DevloopAutomationStage[];
const StageSchema = z.enum(DEVLOOP_AUTOMATION_STAGE_VALUES);

function containsUnsafeControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0x00 && codePoint <= 0x1f)
      || (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return true;
    }
  }
  return /\p{Cf}/u.test(value);
}

const RepoPathSchema = z.string()
  .min(1)
  .max(4_096)
  .regex(/^(?:\/|[A-Za-z]:[\\/])/u)
  .refine(
    (value) => !containsUnsafeControl(value),
    'repoPath contains unsafe control characters',
  );
const PublicTextListSchema = z.array(PublicTextSchema).max(50);

export const DecisionKindSchema = z.enum(['yes_no', 'choice', 'text']);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const DecisionSubjectSchema = z.object({
  repoPath: RepoPathSchema,
  repository: RepositorySchema.optional(),
  runSlug: IdentifierSchema.optional(),
  workflow: PublicTextSchema.optional(),
  step: PublicTextSchema.optional(),
  issueNumber: z.number().int().positive().optional(),
  prNumber: z.number().int().positive().optional(),
  candidateId: CandidateIdentifierSchema.optional(),
  title: PublicTextSchema,
}).strict();
export type DecisionSubject = z.infer<typeof DecisionSubjectSchema>;

export const DecisionEvidenceSchema = z.object({
  kind: z.enum(['run', 'report', 'changed_path', 'check', 'issue', 'pr', 'policy']),
  reference: PublicTextSchema,
  summary: PublicTextSchema,
}).strict();

export const DecisionWhySchema = z.object({
  summary: PublicTextSchema,
  riskCategory: z.enum([
    'product_policy',
    'human_policy',
    'requirements_ambiguity',
    'security',
    'permission',
    'external_dependency',
    'high_risk',
    'unknown',
  ]),
  reasons: z.array(PublicTextSchema).min(1).max(50),
  evidence: z.array(DecisionEvidenceSchema).max(50),
}).strict();
export type DecisionWhy = z.infer<typeof DecisionWhySchema>;

export const DecisionHowSchema = z.object({
  summary: PublicTextSchema,
  expectedEffects: z.array(PublicTextSchema).min(1).max(50),
  verification: z.array(PublicTextSchema).min(1).max(50),
}).strict();
export type DecisionHow = z.infer<typeof DecisionHowSchema>;

export const DecisionOptionSchema = z.object({
  id: IdentifierSchema,
  title: PublicTextSchema,
  description: PublicTextSchema,
  consequences: PublicTextListSchema,
  recommended: z.boolean(),
  recommendationReason: PublicTextSchema.optional(),
}).strict();
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const DecisionAnswerRequirementsSchema = z.object({
  rationaleRequired: z.boolean(),
  minimumTextLength: z.number().int().nonnegative(),
  maximumTextLength: z.number().int().nonnegative().max(100_000),
}).strict().superRefine((requirements, context) => {
  if (requirements.minimumTextLength > requirements.maximumTextLength) {
    context.addIssue({
      code: 'custom',
      path: ['minimumTextLength'],
      message: 'minimumTextLength must not exceed maximumTextLength',
    });
  }
});
export type DecisionAnswerRequirements = z.infer<typeof DecisionAnswerRequirementsSchema>;

const DecisionResumeGuardCommonSchema = z.object({
  expectedDecisionVersion: z.number().int().positive(),
});

const DirectRunResumeGuardSchema = DecisionResumeGuardCommonSchema.extend({
  strategy: z.literal('direct_run'),
  runSlug: IdentifierSchema,
  expectedRunStatus: IdentifierSchema,
}).strict();

const PrAutomationStageResumeGuardSchema = DecisionResumeGuardCommonSchema.extend({
  strategy: z.literal('pr_automation_stage'),
  repository: RepositorySchema,
  prNumber: z.number().int().positive(),
  stage: StageSchema,
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40}$/iu),
}).strict();

const IssueScoutCandidateResumeGuardSchema = DecisionResumeGuardCommonSchema.extend({
  strategy: z.literal('issue_scout_candidate'),
  candidateId: CandidateIdentifierSchema,
}).strict();

export const DecisionResumeGuardSchema = z.discriminatedUnion('strategy', [
  DirectRunResumeGuardSchema,
  PrAutomationStageResumeGuardSchema,
  IssueScoutCandidateResumeGuardSchema,
]);
export type DecisionResumeGuard = z.infer<typeof DecisionResumeGuardSchema>;

const DecisionRequestCommonShape = {
  schemaVersion: z.literal(1),
  decisionId: IdentifierSchema,
  decisionVersion: z.number().int().positive(),
  subject: DecisionSubjectSchema,
  question: PublicTextSchema,
  why: DecisionWhySchema,
  how: DecisionHowSchema,
  answerRequirements: DecisionAnswerRequirementsSchema,
  resumeGuard: DecisionResumeGuardSchema,
  contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.iso.datetime(),
};

const recommendedOptionCountIsValid = (
  value: { options: readonly DecisionOption[] },
  context: z.RefinementCtx,
): void => {
  if (value.options.filter((option) => option.recommended).length > 1) {
    context.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'At most one option may be recommended',
    });
  }
};

const YesNoDecisionRequestSchema = z.object({
  ...DecisionRequestCommonShape,
  kind: z.literal('yes_no'),
  options: z.tuple([
    DecisionOptionSchema.extend({ id: z.literal('yes') }),
    DecisionOptionSchema.extend({ id: z.literal('no') }),
  ]),
}).strict().superRefine(recommendedOptionCountIsValid);

const ChoiceDecisionRequestSchema = z.object({
  ...DecisionRequestCommonShape,
  kind: z.literal('choice'),
  options: z.array(DecisionOptionSchema).min(2).max(8),
}).strict().superRefine((value, context) => {
  recommendedOptionCountIsValid(value, context);
  if (new Set(value.options.map((option) => option.id)).size !== value.options.length) {
    context.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'Choice option IDs must be unique',
    });
  }
});

const TextDecisionRequestSchema = z.object({
  ...DecisionRequestCommonShape,
  kind: z.literal('text'),
}).strict();

const RATIONALE_REQUIRED_RISK_CATEGORIES = new Set<DecisionWhy['riskCategory']>([
  'product_policy',
  'human_policy',
  'security',
  'permission',
  'high_risk',
]);

interface DecisionSafetyContext {
  kind: DecisionKind;
  options?: readonly DecisionOption[];
  subject: DecisionSubject;
  why: DecisionWhy;
  answerRequirements: DecisionAnswerRequirements;
  resumeGuard: DecisionResumeGuard;
}

function validateDecisionSafetyContext(
  value: DecisionSafetyContext,
  context: z.RefinementCtx,
): void {
  if (
    RATIONALE_REQUIRED_RISK_CATEGORIES.has(value.why.riskCategory)
    && !value.answerRequirements.rationaleRequired
  ) {
    context.addIssue({
      code: 'custom',
      path: ['answerRequirements', 'rationaleRequired'],
      message: `rationaleRequired must be true for ${value.why.riskCategory}`,
    });
  }

  if (value.resumeGuard.strategy === 'direct_run') {
    if (
      value.subject.runSlug === undefined
      || value.subject.runSlug !== value.resumeGuard.runSlug
    ) {
      context.addIssue({
        code: 'custom',
        path: ['subject', 'runSlug'],
        message: 'subject.runSlug must match the direct-run resume guard',
      });
    }
    return;
  }

  if (value.resumeGuard.strategy === 'issue_scout_candidate') {
    if (
      value.kind !== 'choice'
      || value.options?.length !== 3
      || value.options[0]?.id !== 'approve_scope'
      || value.options[1]?.id !== 'revise_scope'
      || value.options[2]?.id !== 'skip'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Issue Scout decisions must be a choice with exactly approve_scope, revise_scope, and skip options',
      });
    }
    if (
      value.subject.candidateId === undefined
      || value.subject.candidateId !== value.resumeGuard.candidateId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['subject', 'candidateId'],
        message: 'subject.candidateId must match the Issue Scout resume guard',
      });
    }
    return;
  }

  if (
    value.kind !== 'choice'
    || value.options?.length !== 3
    || value.options[0]?.id !== 'approve_current_head'
    || value.options[1]?.id !== 'request_changes'
    || value.options[2]?.id !== 'stop'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'PR automation decisions must be a choice with exactly approve_current_head, request_changes, and stop options',
    });
  }
  if (
    value.subject.repository === undefined
    || value.subject.repository !== value.resumeGuard.repository
  ) {
    context.addIssue({
      code: 'custom',
      path: ['subject', 'repository'],
      message: 'subject.repository must match the PR automation resume guard',
    });
  }
  if (
    value.subject.prNumber === undefined
    || value.subject.prNumber !== value.resumeGuard.prNumber
  ) {
    context.addIssue({
      code: 'custom',
      path: ['subject', 'prNumber'],
      message: 'subject.prNumber must match the PR automation resume guard',
    });
  }
}

// Strict unions keep an answer shape tied to its decision kind, so an ambiguous
// payload can never resume automation through the wrong adapter.
const DecisionRequestUnionSchema = z.discriminatedUnion('kind', [
  YesNoDecisionRequestSchema,
  ChoiceDecisionRequestSchema,
  TextDecisionRequestSchema,
]);
const DecisionRequestValidationSchema = DecisionRequestUnionSchema.superRefine((value, context) => {
  validateDecisionSafetyContext(value, context);
  if (value.decisionVersion !== value.resumeGuard.expectedDecisionVersion) {
    context.addIssue({
      code: 'custom',
      path: ['decisionVersion'],
      message: 'decisionVersion must match resumeGuard.expectedDecisionVersion',
    });
  }
  if (value.contextHash !== hashDecisionContext(value)) {
    context.addIssue({
      code: 'custom',
      path: ['contextHash'],
      message: 'contextHash must match the normalized semantic decision context',
    });
  }
});

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

// Persisted requests and newly created requests share one immutable public parse path,
// so callers cannot mutate a validated context without invalidating its hash contract.
export const DecisionRequestSchema = DecisionRequestValidationSchema
  .transform((value) => deepFreeze(value));
export type DecisionRequest = z.output<typeof DecisionRequestSchema>;

const CreateDecisionRequestCommonShape = {
  subject: DecisionSubjectSchema,
  question: PublicTextSchema,
  why: DecisionWhySchema,
  how: DecisionHowSchema,
  answerRequirements: DecisionAnswerRequirementsSchema,
  resumeGuard: DecisionResumeGuardSchema,
};

const CreateDecisionRequestInputUnionSchema = z.discriminatedUnion('kind', [
  z.object({
    ...CreateDecisionRequestCommonShape,
    kind: z.literal('yes_no'),
    options: YesNoDecisionRequestSchema.shape.options,
  }).strict().superRefine(recommendedOptionCountIsValid),
  z.object({
    ...CreateDecisionRequestCommonShape,
    kind: z.literal('choice'),
    options: ChoiceDecisionRequestSchema.shape.options,
  }).strict().superRefine((value, context) => {
    recommendedOptionCountIsValid(value, context);
    if (new Set(value.options.map((option) => option.id)).size !== value.options.length) {
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Choice option IDs must be unique',
      });
    }
  }),
  z.object({
    ...CreateDecisionRequestCommonShape,
    kind: z.literal('text'),
  }).strict(),
]);
export const CreateDecisionRequestInputSchema = CreateDecisionRequestInputUnionSchema
  .superRefine(validateDecisionSafetyContext);
export type CreateDecisionRequestInput = z.input<typeof CreateDecisionRequestInputSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item !== undefined) {
          result[key] = canonicalize(item);
        }
        return result;
      }, {});
  }
  return value;
}

type SemanticDecisionContext = {
  subject: DecisionSubject;
  question: string;
  why: DecisionWhy;
  how: DecisionHow;
  answerRequirements: DecisionAnswerRequirements;
  resumeGuard: DecisionResumeGuard;
} & (
  | { kind: 'text' }
  | { kind: 'yes_no' | 'choice'; options: readonly DecisionOption[] }
);

function hashDecisionContext(input: SemanticDecisionContext): string {
  const publicSubject = { ...input.subject };
  Reflect.deleteProperty(publicSubject, 'repoPath');
  const canonicalContext = {
    subject: publicSubject,
    question: input.question,
    why: input.why,
    how: input.how,
    kind: input.kind,
    ...(input.kind === 'text' ? {} : { options: input.options }),
    answerRequirements: input.answerRequirements,
    resumeGuard: input.resumeGuard,
  };

  // Stable semantic hashes deduplicate repeated scheduler requests without
  // binding a public decision to local paths, generated IDs, or wall-clock time.
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(canonicalContext)), 'utf8')
    .digest('hex');
}

export interface CreateDecisionRequestOptions {
  decisionId?: string;
  now?: Date;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function createDecisionRequest(
  input: CreateDecisionRequestInput,
  options: CreateDecisionRequestOptions = {},
): DecisionRequest {
  const normalized = CreateDecisionRequestInputSchema.parse(input);
  const request = {
    schemaVersion: 1 as const,
    decisionId: options.decisionId ?? `dec_${randomUUID()}`,
    decisionVersion: normalized.resumeGuard.expectedDecisionVersion,
    ...normalized,
    contextHash: hashDecisionContext(normalized),
    createdAt: (options.now ?? new Date()).toISOString(),
  };

  return DecisionRequestSchema.parse(request);
}
