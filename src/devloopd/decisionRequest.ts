import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

const LOCAL_PATH_PATTERN = /(^|[\s("'=])(?:\/(?:Users|home|Volumes|private|tmp|var|opt)\/[^\s,;)"']+|[A-Za-z]:\\[^\s,;)"']+)/gu;

const PublicTextSchema = z.string().transform((value) => (
  sanitizeSensitiveText(value)
    .replace(LOCAL_PATH_PATTERN, '$1[LOCAL_PATH]')
    .replace(/\s+/gu, ' ')
    .trim()
)).pipe(z.string().min(1));

const IdentifierSchema = z.string().trim().min(1).max(200);
const PublicTextListSchema = z.array(PublicTextSchema).max(50);

export const DecisionKindSchema = z.enum(['yes_no', 'choice', 'text']);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const DecisionSubjectSchema = z.object({
  repoPath: z.string().trim().min(1),
  repository: IdentifierSchema.optional(),
  runSlug: IdentifierSchema.optional(),
  workflow: PublicTextSchema.optional(),
  step: PublicTextSchema.optional(),
  issueNumber: z.number().int().positive().optional(),
  prNumber: z.number().int().positive().optional(),
  candidateId: IdentifierSchema.optional(),
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
  repository: IdentifierSchema,
  prNumber: z.number().int().positive(),
  stage: IdentifierSchema,
  expectedHeadSha: z.string().trim().regex(/^[a-f0-9]{40}$/iu),
}).strict();

export const DecisionResumeGuardSchema = z.discriminatedUnion('strategy', [
  DirectRunResumeGuardSchema,
  PrAutomationStageResumeGuardSchema,
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

// Strict unions keep an answer shape tied to its decision kind, so an ambiguous
// payload can never resume automation through the wrong adapter.
export const DecisionRequestSchema = z.discriminatedUnion('kind', [
  YesNoDecisionRequestSchema,
  ChoiceDecisionRequestSchema,
  TextDecisionRequestSchema,
]);
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

const CreateDecisionRequestCommonShape = {
  subject: DecisionSubjectSchema,
  question: PublicTextSchema,
  why: DecisionWhySchema,
  how: DecisionHowSchema,
  answerRequirements: DecisionAnswerRequirementsSchema,
  resumeGuard: DecisionResumeGuardSchema,
};

export const CreateDecisionRequestInputSchema = z.discriminatedUnion('kind', [
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
export type CreateDecisionRequestInput = z.input<typeof CreateDecisionRequestInputSchema>;

function hashDecisionContext(input: z.output<typeof CreateDecisionRequestInputSchema>): string {
  const publicSubject = { ...input.subject };
  Reflect.deleteProperty(publicSubject, 'repoPath');
  const canonicalContext = {
    ...input,
    subject: publicSubject,
  };

  // Stable semantic hashes deduplicate repeated scheduler requests without
  // binding a public decision to local paths, generated IDs, or wall-clock time.
  return createHash('sha256')
    .update(JSON.stringify(canonicalContext), 'utf8')
    .digest('hex');
}

export interface CreateDecisionRequestOptions {
  decisionId?: string;
  now?: Date;
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
