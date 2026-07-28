import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { z } from 'zod/v4';
import type { AgentResponse } from '../core/models/index.js';
import type { IssueScoutCandidate } from './issueScout.js';
import {
  createDecisionRequest,
  type CreateDecisionRequestInput,
  type DecisionRequest,
} from './decisionRequest.js';
import {
  DecisionStore,
  DecisionStoreError,
} from './decisionStore.js';
import type {
  DecisionProjection,
  DeepReadonly,
} from './decisionEvents.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';
import type {
  DevloopAutomationAction,
  DevloopAutomationStage,
} from './prAutomation.js';

export interface IssueScoutDecisionContext {
  readonly repoPath: string;
  readonly repository?: string;
}

export interface AutomationActionDecisionContext {
  readonly repoPath: string;
  readonly repository: string;
  readonly headSha: string;
  readonly stage: DevloopAutomationStage;
}

export interface AutomationActionDecisionEligibilityInput {
  readonly type: string;
  readonly status: 'passed' | 'skipped' | 'blocked' | 'failed';
  readonly stopRule?: string;
  readonly productPolicyImpact?: {
    readonly requiresHumanReview: boolean;
  };
}

export type DecisionGenerationErrorCode =
  | 'candidate_not_escalated'
  | 'candidate_invalid'
  | 'decision_invalid'
  | 'automation_action_not_escalated';

export class DecisionGenerationError extends Error {
  readonly code: DecisionGenerationErrorCode;

  constructor(code: DecisionGenerationErrorCode) {
    super(
      code === 'candidate_not_escalated'
        ? 'The Issue Scout candidate does not require a human decision'
        : code === 'candidate_invalid'
          ? 'The Issue Scout candidate is invalid'
          : code === 'automation_action_not_escalated'
            ? 'The automation action does not require a human decision'
            : 'The Issue Scout decision is invalid',
    );
    this.name = 'DecisionGenerationError';
    this.code = code;
  }
}

export type IssueScoutDecisionOutcome =
  | 'pending'
  | 'approved'
  | 'revision_requested'
  | 'skipped';

const WORKFLOW_DECISION_TEXT_MAX = 4_000;
const WORKFLOW_DECISION_REASON_MAX = 50;
const WORKFLOW_DECISION_EVIDENCE_MAX = 50;
const WORKFLOW_DECISION_AGGREGATE_BYTES_MAX = 64 * 1_024;
const WORKFLOW_DECISION_NODE_MAX = 512;
const WORKFLOW_DECISION_DEPTH_MAX = 8;
const WORKFLOW_DECISION_ARRAY_MAX = 50;
const WORKFLOW_DECISION_OBJECT_KEYS_MAX = 50;
// Reject instead of cleaning structured blocker fields. Cleaning can change the
// meaning of a human question, while accepting provider prose would make the
// feature bridge guess whether a blocked step is asking for authorization.
// eslint-disable-next-line no-control-regex
const WORKFLOW_UNSAFE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u;
const WORKFLOW_SECRET_PATTERN = /(?:\b(?:api[_-]?key|authorization|bearer|cookie|password|private[_-]?key|secret|session(?:[_-]?id)?|token)\s*[:=]|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk-(?:proj-)?|gh[opusr]_|xox[baprs]-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/iu;
const WORKFLOW_LOCAL_PATH_PATTERN = /(?:\bfile:\/\/\/|\b(?:path|cwd)\s*:\s*(?:\/|[A-Za-z]:[\\/]|\\\\)|(?:^|[\s("'=])(?:\/(?!\/)\S+|[A-Za-z]:[\\/]\S+|\\\\[^\\\s]+\\\S+))/iu;
const WORKFLOW_COMMAND_PATTERN = /(?:^|\s)(?:npm|pnpm|yarn|git|gh|bash|sh|curl)\s+\S+/iu;

function hasUnsafeWorkflowDecisionUrl(value: string): boolean {
  // Decision public text does not need URLs. Reject the scheme delimiter at
  // any position so prefixes such as "_http://" cannot evade a word boundary.
  return value.includes('://');
}

function isWorkflowDecisionTextSafe(value: string): boolean {
  return (
    !WORKFLOW_UNSAFE_CONTROL_PATTERN.test(value)
    && !WORKFLOW_SECRET_PATTERN.test(value)
    && !WORKFLOW_LOCAL_PATH_PATTERN.test(value)
    && !hasUnsafeWorkflowDecisionUrl(value)
    && !WORKFLOW_COMMAND_PATTERN.test(value)
    && sanitizeSensitiveText(value) === value
  );
}

const WorkflowDecisionPublicTextSchema = z.string()
  .min(1)
  .max(WORKFLOW_DECISION_TEXT_MAX)
  .refine(isWorkflowDecisionTextSafe, 'unsafe workflow decision text');

const WorkflowDecisionEvidenceSchema = z.object({
  kind: z.enum(['run', 'report', 'changed_path', 'check', 'issue', 'pr', 'policy']),
  reference: WorkflowDecisionPublicTextSchema.max(500),
  summary: WorkflowDecisionPublicTextSchema,
}).strict();

const WorkflowDecisionWhySchema = z.object({
  summary: WorkflowDecisionPublicTextSchema,
  reasons: z.array(WorkflowDecisionPublicTextSchema)
    .min(1)
    .max(WORKFLOW_DECISION_REASON_MAX),
  evidence: z.array(WorkflowDecisionEvidenceSchema)
    .max(WORKFLOW_DECISION_EVIDENCE_MAX),
}).strict();

const WorkflowTextAnswerSchema = z.object({
  kind: z.literal('text'),
  minimumTextLength: z.number().int().min(1).max(WORKFLOW_DECISION_TEXT_MAX),
  maximumTextLength: z.number().int().min(1).max(WORKFLOW_DECISION_TEXT_MAX),
  rationaleRequired: z.boolean(),
}).strict().refine(
  (value) => value.minimumTextLength <= value.maximumTextLength,
  'minimumTextLength must not exceed maximumTextLength',
);

const WorkflowYesNoAnswerSchema = z.object({
  kind: z.literal('yes_no'),
  rationaleRequired: z.boolean(),
}).strict();

const WorkflowHumanDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  category: z.enum([
    'requirements_ambiguity',
    'permission',
    'external_dependency',
  ]),
  question: WorkflowDecisionPublicTextSchema,
  why: WorkflowDecisionWhySchema,
  answer: z.discriminatedUnion('kind', [
    WorkflowTextAnswerSchema,
    WorkflowYesNoAnswerSchema,
  ]),
}).strict().superRefine((value, context) => {
  if (
    value.category === 'requirements_ambiguity'
    && value.answer.kind !== 'text'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['answer', 'kind'],
      message: 'requirements ambiguity requires an explicit bounded text answer',
    });
  }
});

export type WorkflowHumanDecision =
  DeepReadonly<z.output<typeof WorkflowHumanDecisionSchema>>;

function deepFreezeWorkflowDecision<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) {
      deepFreezeWorkflowDecision(nestedValue);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export type WorkflowDecisionClassification =
  | {
    readonly classification: 'eligible';
    readonly eligible: true;
    readonly decision: WorkflowHumanDecision;
  }
  | {
    readonly classification: 'ordinary_ineligible';
    readonly eligible: false;
    readonly issue:
      | 'not_blocked'
      | 'provider_runtime_failure'
      | 'missing_structured_output';
  }
  | {
    readonly classification: 'invalid_contract';
    readonly eligible: false;
    readonly issue: 'invalid_structured_output';
  };

export interface WorkflowBlockDecisionInput {
  readonly response: AgentResponse;
  readonly stepName: string;
  readonly workflowName: string;
  readonly repoPath: string;
  readonly runSlug: string;
  readonly issueNumber?: number;
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== 'object'
    || nodeTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type HumanDecisionPayloadRead =
  | { readonly status: 'found'; readonly value: unknown }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' };

function readHumanDecisionPayload(structuredOutput: unknown): HumanDecisionPayloadRead {
  if (structuredOutput === undefined) return { status: 'missing' };
  if (!isPlainDataRecord(structuredOutput)) return { status: 'invalid' };
  const descriptors = Object.getOwnPropertyDescriptors(structuredOutput);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length > WORKFLOW_DECISION_OBJECT_KEYS_MAX
    || keys.some((key) => typeof key !== 'string')
    || keys.some((key) => {
      const descriptor = descriptors[key as string];
      return descriptor === undefined
        || !Object.hasOwn(descriptor, 'value')
        || !descriptor.enumerable;
    })
  ) {
    return { status: 'invalid' };
  }
  const descriptor = descriptors.humanDecision;
  if (descriptor === undefined) return { status: 'missing' };
  return { status: 'found', value: descriptor.value };
}

function isBoundedSafeWorkflowDecisionPayload(root: unknown): boolean {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{
    value: root,
    depth: 0,
  }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    nodes += 1;
    if (
      nodes > WORKFLOW_DECISION_NODE_MAX
      || entry.depth > WORKFLOW_DECISION_DEPTH_MAX
    ) {
      return false;
    }

    const value = entry.value;
    if (
      value !== null
      && (typeof value === 'object' || typeof value === 'function')
      && nodeTypes.isProxy(value)
    ) {
      return false;
    }
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (
        bytes > WORKFLOW_DECISION_AGGREGATE_BYTES_MAX
        || !isWorkflowDecisionTextSafe(value)
      ) {
        return false;
      }
      continue;
    }
    if (
      value === null
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
    ) {
      bytes += Buffer.byteLength(String(value), 'utf8');
      if (bytes > WORKFLOW_DECISION_AGGREGATE_BYTES_MAX) return false;
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);

    if (Array.isArray(value)) {
      if (value.length > WORKFLOW_DECISION_ARRAY_MAX) return false;
      bytes += 2 + Math.max(0, value.length - 1);
      if (bytes > WORKFLOW_DECISION_AGGREGATE_BYTES_MAX) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (
        Object.getPrototypeOf(value) !== Array.prototype
        || keys.length !== value.length + 1
        || keys.some((key) => typeof key !== 'string')
      ) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined
          || !Object.hasOwn(descriptor, 'value')
          || !descriptor.enumerable
        ) {
          return false;
        }
        stack.push({ value: descriptor.value, depth: entry.depth + 1 });
      }
      continue;
    }

    if (!isPlainDataRecord(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length > WORKFLOW_DECISION_OBJECT_KEYS_MAX
      || keys.some((key) => typeof key !== 'string')
    ) {
      return false;
    }
    bytes += 2 + Math.max(0, keys.length - 1);
    for (const key of keys as string[]) {
      bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
      const descriptor = descriptors[key];
      if (
        bytes > WORKFLOW_DECISION_AGGREGATE_BYTES_MAX
        || descriptor === undefined
        || !Object.hasOwn(descriptor, 'value')
        || !descriptor.enumerable
      ) {
        return false;
      }
      stack.push({ value: descriptor.value, depth: entry.depth + 1 });
    }
  }

  return true;
}

export function classifyWorkflowDecisionBlock(
  response: AgentResponse,
): WorkflowDecisionClassification {
  try {
    if (nodeTypes.isProxy(response)) {
      return {
        classification: 'invalid_contract',
        eligible: false,
        issue: 'invalid_structured_output',
      };
    }
    if (response.status !== 'blocked') {
      return {
        classification: 'ordinary_ineligible',
        eligible: false,
        issue: 'not_blocked',
      };
    }
    if (
      response.error !== undefined
      || response.errorKind !== undefined
      || response.failureCategory !== undefined
      || response.rateLimitInfo !== undefined
    ) {
      return {
        classification: 'ordinary_ineligible',
        eligible: false,
        issue: 'provider_runtime_failure',
      };
    }

    const payload = readHumanDecisionPayload(response.structuredOutput);
    if (payload.status === 'missing') {
      return {
        classification: 'ordinary_ineligible',
        eligible: false,
        issue: 'missing_structured_output',
      };
    }
    if (
      payload.status === 'invalid'
      || !isBoundedSafeWorkflowDecisionPayload(payload.value)
    ) {
      return {
        classification: 'invalid_contract',
        eligible: false,
        issue: 'invalid_structured_output',
      };
    }
    const parsed = WorkflowHumanDecisionSchema.safeParse(payload.value);
    if (!parsed.success) {
      return {
        classification: 'invalid_contract',
        eligible: false,
        issue: 'invalid_structured_output',
      };
    }
    return {
      classification: 'eligible',
      eligible: true,
      decision: deepFreezeWorkflowDecision(parsed.data),
    };
  } catch {
    // Provider-owned objects can contain proxies or hostile accessors. Parsing
    // failure must remain a local classification issue, never a workflow crash.
    return {
      classification: 'invalid_contract',
      eligible: false,
      issue: 'invalid_structured_output',
    };
  }
}

export function parseWorkflowHumanDecision(
  response: AgentResponse,
): WorkflowHumanDecision | undefined {
  const classification = classifyWorkflowDecisionBlock(response);
  return classification.eligible ? classification.decision : undefined;
}

const MAX_CANDIDATE_TEXT_LENGTH = 4_000;
const MAX_CANDIDATE_ARRAY_LENGTH = 50;
const MAX_CANDIDATE_BYTES = 256 * 1024;
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/u;
const HEAD_SHA_PATTERN = /^[a-f0-9]{40}$/iu;
const ALLOWED_EVIDENCE_HOSTS = new Set([
  'api.github.com',
  'cve.org',
  'github.com',
  'nvd.nist.gov',
  'www.cve.org',
]);
const MECHANICAL_AUTOMATION_STOP_RULES = new Set([
  'active run limit',
  'Duplicate or already covered',
  'checks failed',
  'attempt budget exhausted',
  'head mismatch',
  'overlap serialization',
]);

export function isAutomationActionDecisionEligible(
  action: AutomationActionDecisionEligibilityInput,
): boolean {
  if (action.status !== 'blocked') return false;
  if (
    action.stopRule !== undefined
    && MECHANICAL_AUTOMATION_STOP_RULES.has(action.stopRule)
  ) {
    return false;
  }
  return action.productPolicyImpact?.requiresHumanReview === true
    || action.stopRule === 'Unsafe or too broad'
    || action.stopRule === 'human review required'
    || action.type === 'current-head-blocked';
}

function riskCategoryFor(
  candidate: IssueScoutCandidate,
): DecisionRequest['why']['riskCategory'] {
  if (candidate.policyCategory === 'product_policy') return 'product_policy';
  if (candidate.policyCategory === 'human_policy') return 'human_policy';
  if (candidate.riskBucket === 'high') return 'high_risk';
  return 'unknown';
}

function reasonsFor(candidate: IssueScoutCandidate): string[] {
  const reasons = [
    `Policy category: ${candidate.policyCategory}.`,
    `Risk bucket: ${candidate.riskBucket}.`,
    ...candidate.escalationCriteria.map((criterion) => `Escalation criterion: ${criterion}`),
    ...candidate.laneEvidence.map((evidence) => `Lane evidence: ${evidence}`),
  ];
  if (candidate.expectedChangedSurfaces.length > 0) {
    reasons.push(`Expected changed surfaces: ${candidate.expectedChangedSurfaces.join(', ')}.`);
  }
  return reasons;
}

function safeRelativePath(repoPath: string, path: string): string | undefined {
  const portablePath = path.replaceAll('\\', '/');
  if (isAbsolute(portablePath)) return undefined;
  const resolvedPath = resolve(repoPath, portablePath);
  const relativePath = relative(repoPath, resolvedPath).replaceAll('\\', '/');
  if (
    relativePath.length === 0
    || relativePath === '..'
    || relativePath.startsWith('../')
    || isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return relativePath;
}

function safeEvidenceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || (url.port !== '' && url.port !== '443')
      || !ALLOWED_EVIDENCE_HOSTS.has(url.hostname.toLowerCase())
    ) {
      return undefined;
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function opaqueEvidenceReference(
  candidate: IssueScoutCandidate,
  index: number,
): string {
  const artifact = candidate.evidence[index];
  // Opaque references intentionally identify only the structural slot. Raw
  // paths, URLs, and credentials must never become an offline dictionary oracle.
  const digest = createHash('sha256')
    .update(`${candidate.sourceId}\0${artifact?.kind ?? 'unknown'}\0${index}`, 'utf8')
    .digest('hex');
  return `redacted-${candidate.sourceId}-${artifact?.kind ?? 'unknown'}-${index + 1}-${digest}`;
}

function sanitizedEvidenceSummary(summary: string): string {
  const sensitiveSanitized = sanitizeSensitiveText(summary);
  let controlSanitized = '';
  let segmentStart = 0;
  for (let index = 0; index < sensitiveSanitized.length; index += 1) {
    const code = sensitiveSanitized.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      controlSanitized += `${sensitiveSanitized.slice(segmentStart, index)} `;
      segmentStart = index + 1;
    }
  }
  controlSanitized += sensitiveSanitized.slice(segmentStart);
  return controlSanitized
    .replace(/\bhttps?:\/\/[^\s)\]}]+/giu, '[REDACTED URL]')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, '[REDACTED PATH]')
    .replace(/\/(?:[^/\s]+\/)+[^,\s.;)\]}]*/gu, '[REDACTED PATH]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_CANDIDATE_TEXT_LENGTH);
}

function evidenceFor(
  candidate: IssueScoutCandidate,
  repoPath: string,
): CreateDecisionRequestInput['why']['evidence'] {
  return [
    ...candidate.evidence.map((artifact, index) => {
      const safeReference = (
        artifact.path === undefined
          ? undefined
          : safeRelativePath(repoPath, artifact.path)
      ) ?? (
        artifact.url === undefined
          ? undefined
          : safeEvidenceUrl(artifact.url)
      );
      const redacted = safeReference === undefined;
      const summary = sanitizedEvidenceSummary(artifact.summary);
      return {
        kind: artifact.kind === 'command' ? 'check' as const : 'report' as const,
        reference: safeReference ?? opaqueEvidenceReference(candidate, index),
        summary: redacted
          ? `${summary} (reference redacted)`
          : summary,
      };
    }),
    ...candidate.acceptanceCriteria.map((criterion, index) => ({
      kind: 'policy' as const,
      reference: `acceptance-criterion-${index + 1}`,
      summary: criterion,
    })),
    ...candidate.expectedChangedSurfaces.map((surface, index) => ({
      kind: 'changed_path' as const,
      reference: `expected-surface-${index + 1}`,
      summary: surface,
    })),
  ];
}

function collectCandidateStrings(value: unknown, strings: string[], arrays: unknown[][]): void {
  if (typeof value === 'string') {
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    arrays.push(value);
    for (const item of value) collectCandidateStrings(item, strings, arrays);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectCandidateStrings(item, strings, arrays);
  }
}

export function validateIssueScoutDecisionCandidate(
  candidate: IssueScoutCandidate,
): void {
  const strings: string[] = [];
  const arrays: unknown[][] = [];
  collectCandidateStrings(candidate, strings, arrays);
  const reasonCount = 2
    + candidate.escalationCriteria.length
    + candidate.laneEvidence.length
    + (candidate.expectedChangedSurfaces.length > 0 ? 1 : 0);
  const evidenceCount = candidate.evidence.length
    + candidate.acceptanceCriteria.length
    + candidate.expectedChangedSurfaces.length;
  const verificationCount = candidate.verificationCommands.length > 0
    ? candidate.verificationCommands.length
    : candidate.acceptanceCriteria.length;
  if (
    strings.some((value) => value.length > MAX_CANDIDATE_TEXT_LENGTH)
    || arrays.some((value) => value.length > MAX_CANDIDATE_ARRAY_LENGTH)
    || reasonCount > MAX_CANDIDATE_ARRAY_LENGTH
    || evidenceCount > MAX_CANDIDATE_ARRAY_LENGTH
    || verificationCount < 1
    || verificationCount > MAX_CANDIDATE_ARRAY_LENGTH
    || Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_CANDIDATE_BYTES
  ) {
    throw new DecisionGenerationError('candidate_invalid');
  }
}

function buildInput(
  candidate: IssueScoutCandidate,
  context: IssueScoutDecisionContext,
): CreateDecisionRequestInput {
  const highRisk = candidate.riskBucket === 'high';
  return {
    kind: 'choice',
    subject: {
      repoPath: context.repoPath,
      ...(context.repository === undefined ? {} : { repository: context.repository }),
      candidateId: candidate.id,
      title: candidate.title,
    },
    question: `Issue Scout candidate "${candidate.title}" should proceed under which scope policy?`,
    why: {
      summary: `${candidate.summary} Issue Scout stopped this candidate until a human chooses a safe scope.`,
      riskCategory: riskCategoryFor(candidate),
      reasons: reasonsFor(candidate),
      evidence: evidenceFor(candidate, context.repoPath),
    },
    how: {
      summary: 'Pass the selected scope policy back to Issue Scout and re-plan this candidate before any issue is created.',
      expectedEffects: [
        'approve_scope keeps the candidate scope and requires Issue Scout to revalidate it.',
        'revise_scope requires a narrower plan before Issue Scout may continue.',
        'skip leaves the candidate stopped and prevents issue creation.',
      ],
      verification: candidate.verificationCommands.length > 0
        ? [...candidate.verificationCommands]
        : [...candidate.acceptanceCriteria],
    },
    options: [
      {
        id: 'approve_scope',
        title: 'Approve the proposed scope',
        description: 'Allow Issue Scout to re-plan using the candidate scope as written.',
        consequences: [
          'The candidate is revalidated before issue creation.',
          'Acceptance criteria and verification remain mandatory.',
        ],
        recommended: false,
      },
      {
        id: 'revise_scope',
        title: 'Revise to a safer scope',
        description: 'Require Issue Scout to narrow or clarify the candidate before continuing.',
        consequences: [
          'Issue creation stays blocked until the revised scope is revalidated.',
          'The revised plan must preserve the stated acceptance criteria.',
        ],
        recommended: highRisk,
        ...(highRisk
          ? { recommendationReason: 'High-risk candidates should be narrowed before automation resumes.' }
          : {}),
      },
      {
        id: 'skip',
        title: 'Skip this candidate',
        description: 'Keep the candidate stopped without creating an issue.',
        consequences: [
          'Issue Scout will not schedule this candidate from the current decision.',
          'A materially changed candidate may be evaluated again later.',
        ],
        recommended: false,
      },
    ],
    answerRequirements: {
      rationaleRequired: true,
      minimumTextLength: 1,
      maximumTextLength: 2_000,
    },
    resumeGuard: {
      strategy: 'issue_scout_candidate',
      expectedDecisionVersion: 1,
      candidateId: candidate.id,
    },
  };
}

export function classifyIssueScoutDecision(
  projection: DecisionProjection,
): IssueScoutDecisionOutcome {
  if (projection.status !== 'applied') return 'pending';
  const value = projection.answer?.value;
  if (
    projection.request.resumeGuard.strategy !== 'issue_scout_candidate'
    || projection.request.kind !== 'choice'
    || value === undefined
    || !('optionId' in value)
    || !projection.request.options.some((option) => option.id === value.optionId)
  ) {
    throw new DecisionGenerationError('decision_invalid');
  }
  switch (value.optionId) {
    case 'approve_scope':
      return 'approved';
    case 'revise_scope':
      return 'revision_requested';
    case 'skip':
      return 'skipped';
    default:
      throw new DecisionGenerationError('decision_invalid');
  }
}

function sameRequestIgnoringTime(
  left: DecisionRequest,
  right: DecisionRequest,
): boolean {
  const leftWithoutTime = { ...left } as Partial<DecisionRequest>;
  const rightWithoutTime = { ...right } as Partial<DecisionRequest>;
  Reflect.deleteProperty(leftWithoutTime, 'createdAt');
  Reflect.deleteProperty(rightWithoutTime, 'createdAt');
  return JSON.stringify(leftWithoutTime) === JSON.stringify(rightWithoutTime);
}

function sameLogicalDecisionContext(
  left: DecisionRequest,
  right: DecisionRequest,
): boolean {
  const normalize = (request: DecisionRequest): unknown => {
    const semantic = { ...request } as Record<string, unknown>;
    Reflect.deleteProperty(semantic, 'createdAt');
    Reflect.deleteProperty(semantic, 'decisionId');
    Reflect.deleteProperty(semantic, 'decisionVersion');
    Reflect.deleteProperty(semantic, 'contextHash');
    semantic.resumeGuard = {
      ...request.resumeGuard,
      expectedDecisionVersion: 0,
    };
    return semantic;
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function decisionCanReuseAnswer(projection: DecisionProjection): boolean {
  return projection.status === 'open'
    || projection.status === 'applying'
    || (projection.status === 'answered' && projection.applyResult === undefined);
}

function inputWithDecisionVersion(
  input: CreateDecisionRequestInput,
  expectedDecisionVersion: number,
): CreateDecisionRequestInput {
  return {
    ...input,
    resumeGuard: {
      ...input.resumeGuard,
      expectedDecisionVersion,
    },
  } as CreateDecisionRequestInput;
}

function ensureDeterministicDecision(
  store: DecisionStore,
  input: CreateDecisionRequestInput,
  now: Date,
): DecisionProjection {
  const provisional = createDecisionRequest(input, { now });
  const decisionId = `dec_${provisional.contextHash}`;
  const request = createDecisionRequest(input, { decisionId, now });
  // The semantic hash determines the lookup key. DecisionStore currently folds
  // the ledger for each direct lookup, so batch callers use the indexed path below.
  const sameIdentity = store.get(decisionId);
  if (sameIdentity !== undefined) {
    if (sameRequestIgnoringTime(sameIdentity.request, request)) {
      if (
        sameIdentity.status === 'revalidation_required'
        || (
          sameIdentity.status === 'answered'
          && sameIdentity.applyResult?.status === 'failed'
        )
      ) {
        return ensureRecurringDecision(store, input, now);
      }
      return sameIdentity;
    }
    throw new DecisionStoreError('request_conflict');
  }

  try {
    store.request(request, { now });
  } catch (error) {
    if (!(error instanceof DecisionStoreError) || error.code !== 'request_conflict') {
      throw error;
    }
    const concurrent = store.get(decisionId);
    if (
      concurrent === undefined
      || !sameRequestIgnoringTime(concurrent.request, request)
    ) {
      throw error;
    }
    return concurrent;
  }

  const projection = store.get(decisionId);
  if (projection === undefined) {
    throw new DecisionStoreError('decision_not_found');
  }
  return projection;
}

function ensureRecurringDecision(
  store: DecisionStore,
  input: CreateDecisionRequestInput,
  now: Date,
  projections: Map<string, DecisionProjection> = new Map(
    store.list().map((projection) => [projection.request.decisionId, projection]),
  ),
): DecisionProjection {
  const provisional = createDecisionRequest(input, { now });
  const sameContext = [...projections.values()].filter((projection) =>
    sameLogicalDecisionContext(projection.request, provisional));
  const active = sameContext.filter(decisionCanReuseAnswer);
  if (active.length > 1) throw new DecisionStoreError('request_conflict');
  if (active[0] !== undefined) return active[0];

  const terminalCount = sameContext.length;
  const nextVersion = sameContext.reduce(
    (maximum, projection) => Math.max(maximum, projection.request.decisionVersion),
    0,
  ) + 1;
  const baseDecisionId = `dec_${provisional.contextHash}`;
  const decisionId = terminalCount === 0
    ? baseDecisionId
    : `${baseDecisionId}_r${terminalCount}`;
  if (projections.has(decisionId)) {
    throw new DecisionStoreError('request_conflict');
  }

  const request = createDecisionRequest(
    inputWithDecisionVersion(input, nextVersion),
    { decisionId, now },
  );
  const projection = store.requestAndGet(request, { now });
  if (projection.status === 'applied') {
    throw new DecisionStoreError('request_conflict');
  }
  projections.set(decisionId, projection);
  return projection;
}

function workflowDecisionInput(
  decision: WorkflowHumanDecision,
  input: WorkflowBlockDecisionInput,
  repoPath: string,
): CreateDecisionRequestInput {
  const rationaleRequired = decision.category === 'permission'
    || decision.category === 'requirements_ambiguity'
    || decision.answer.rationaleRequired;
  const common = {
    subject: {
      repoPath,
      runSlug: input.runSlug,
      workflow: input.workflowName,
      step: input.stepName,
      ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
      title: `${input.workflowName} / ${input.stepName} requires a human decision`,
    },
    question: decision.question,
    why: {
      ...decision.why,
      reasons: [...decision.why.reasons],
      evidence: decision.why.evidence.map((item) => ({ ...item })),
      riskCategory: decision.category,
    },
    how: {
      summary: 'Add the explicit answer to the blocked run context, then resume only this run after revalidation.',
      expectedEffects: [
        'The answer is added to the blocked run context.',
        'The stopped step is retried only after the direct-run guard is revalidated.',
      ],
      verification: [
        'Revalidate that the exact run is still blocked before applying the answer.',
        'Revalidate the answer against the stopped step before direct-run resume.',
      ],
    },
    answerRequirements: {
      rationaleRequired,
      minimumTextLength: decision.answer.kind === 'text'
        ? decision.answer.minimumTextLength
        : 0,
      maximumTextLength: decision.answer.kind === 'text'
        ? decision.answer.maximumTextLength
        : WORKFLOW_DECISION_TEXT_MAX,
    },
    resumeGuard: {
      strategy: 'direct_run' as const,
      expectedDecisionVersion: 1,
      runSlug: input.runSlug,
      expectedRunStatus: 'aborted' as const,
      expectedAbortKind: 'blocked' as const,
      expectedBlockedStep: input.stepName,
    },
  };

  if (decision.answer.kind === 'text') {
    return {
      ...common,
      kind: 'text',
    };
  }

  return {
    ...common,
    kind: 'yes_no',
    options: [
      {
        id: 'yes',
        title: 'Yes — allow this blocked run to be reconsidered',
        description: 'Record an explicit yes answer for this exact blocked context.',
        consequences: [
          'The run may resume only after its blocked state and answer are revalidated.',
        ],
        recommended: false,
      },
      {
        id: 'no',
        title: 'No — keep this run blocked',
        description: 'Record an explicit no answer and do not authorize the requested action.',
        consequences: [
          'The current run remains blocked unless a new valid decision is requested.',
        ],
        recommended: decision.category === 'permission',
        ...(decision.category === 'permission'
          ? { recommendationReason: 'Permission remains denied unless a human explicitly approves it.' }
          : {}),
      },
    ],
  };
}

export function ensureDecisionForWorkflowBlock(
  store: DecisionStore,
  input: WorkflowBlockDecisionInput,
  now: Date = new Date(),
): DecisionProjection | undefined {
  const decision = parseWorkflowHumanDecision(input.response);
  if (decision === undefined) return undefined;

  try {
    return ensureRecurringDecision(
      store,
      workflowDecisionInput(decision, input, store.repoPath),
      now,
    );
  } catch (error) {
    if (error instanceof DecisionStoreError) throw error;
    throw new DecisionGenerationError('candidate_invalid');
  }
}

export function ensureDecisionForIssueScoutCandidate(
  store: DecisionStore,
  candidate: IssueScoutCandidate,
  context: IssueScoutDecisionContext,
  now: Date = new Date(),
): DecisionProjection {
  if (
    candidate.policyCategory !== 'product_policy'
    && candidate.policyCategory !== 'human_policy'
    && candidate.riskBucket !== 'high'
  ) {
    throw new DecisionGenerationError('candidate_not_escalated');
  }
  validateIssueScoutDecisionCandidate(candidate);

  const canonicalContext = {
    ...context,
    repoPath: store.repoPath,
  };
  try {
    createDecisionRequest(buildInput(candidate, canonicalContext), { now });
  } catch {
    throw new DecisionGenerationError('candidate_invalid');
  }
  return ensureDeterministicDecision(
    store,
    buildInput(candidate, canonicalContext),
    now,
  );
}

const RAW_COMMAND_PATTERN = /(?:^|\b(?:run|execute|command)\s+)(?:npm|pnpm|yarn|git|gh|bash|sh|curl)\s+[^\n.;]*/gimu;
const RAW_COMMAND_FIELD_PATTERN = /\b(?:command|args)\s*[:=]\s*[^\n.;]*/giu;
const RAW_DIFF_PATTERN = /(?:^|\s)(?:diff --git|@@\s|---\s+[ab]\/|\+\+\+\s+[ab]\/)[^\n]*/giu;
const LOCAL_PATH_PATTERN = /(?:\/(?:[^/\s]+\/)+[^,\s.;)\]}]*|[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*)/gu;

function sanitizeAutomationDecisionText(
  value: string,
  maxLength = MAX_CANDIDATE_TEXT_LENGTH,
): {
  text: string;
  incomplete: boolean;
} {
  let controlsRemoved = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    controlsRemoved += (
      (codePoint >= 0x00 && codePoint <= 0x1f)
      || (codePoint >= 0x7f && codePoint <= 0x9f)
    ) ? ' ' : character;
  }
  const sensitiveSanitized = sanitizeSensitiveText(controlsRemoved)
    .replace(RAW_DIFF_PATTERN, ' [REDACTED DIFF]')
    .replace(RAW_COMMAND_PATTERN, '[REDACTED COMMAND]')
    .replace(RAW_COMMAND_FIELD_PATTERN, '[REDACTED COMMAND]')
    .replace(LOCAL_PATH_PATTERN, '[REDACTED PATH]')
    .replace(/\s+/gu, ' ')
    .trim();
  const incomplete = sensitiveSanitized.length > maxLength;
  return {
    text: sensitiveSanitized.slice(0, maxLength)
      || 'The automation action requires a human policy decision.',
    incomplete,
  };
}

function automationDecisionInput(
  actions: readonly (DevloopAutomationAction & { readonly pr: number })[],
  context: AutomationActionDecisionContext,
): CreateDecisionRequestInput {
  const action = actions[0];
  if (action === undefined) {
    throw new DecisionGenerationError('candidate_invalid');
  }
  const sourceReasons = [...new Set(actions.flatMap((item) => [
    `Automation action ${item.type}: ${item.message}`,
    ...(item.stopRule === undefined ? [] : [`Stop rule: ${item.stopRule}.`]),
    ...(item.productPolicyImpact?.reasons ?? []),
    ...(item.dualLlmApproval?.reasons ?? []),
  ]))].sort();
  const sanitizedMessage = sanitizeAutomationDecisionText(
    actions.map((item) => item.message).join(' '),
    MAX_CANDIDATE_TEXT_LENGTH - 400,
  );
  const sanitizedReasons = sourceReasons.slice(0, MAX_CANDIDATE_ARRAY_LENGTH - 1)
    .map((reason) => sanitizeAutomationDecisionText(reason));
  const incomplete = sanitizedMessage.incomplete
    || sourceReasons.length > MAX_CANDIDATE_ARRAY_LENGTH - 1
    || sanitizedReasons.some((reason) => reason.incomplete);
  const reasons = sanitizedReasons.map((reason) => reason.text);
  if (reasons.length === 0) {
    reasons.push(`Automation action ${action.type} cannot continue without a human policy choice.`);
  }
  if (incomplete) {
    reasons.push('Public context was bounded or truncated; inspect the authoritative PR and review records before answering.');
  }
  const productPolicy = actions.some(
    (item) => item.productPolicyImpact?.requiresHumanReview === true,
  );

  return {
    kind: 'choice',
    subject: {
      repoPath: context.repoPath,
      repository: context.repository,
      prNumber: action.pr,
      headSha: context.headSha,
      title: `PR #${action.pr} requires a ${context.stage} policy decision`,
      step: context.stage,
    },
    question: `How should PR #${action.pr} proceed at ${context.stage} for the current head?`,
    why: {
      summary: `${sanitizedMessage.text} Automation remains stopped until a human selects an explicit current-head policy.`,
      riskCategory: incomplete
        ? 'high_risk'
        : productPolicy
          ? 'product_policy'
          : 'human_policy',
      reasons,
      evidence: [{
        kind: 'pr',
        reference: `PR #${action.pr}`,
        summary: `Current-head policy stop recorded at ${context.stage}.`,
      }],
    },
    how: {
      summary: `Revalidate the current head and apply the selected policy only to ${context.stage}; do not resume another stage from this decision.`,
      expectedEffects: [
        'approve_current_head permits only this stage to resume after all current-head guards pass again.',
        'request_changes keeps this head blocked until the PR changes and is reviewed again.',
        'stop keeps automation stopped for this PR and stage.',
      ],
      verification: [
        `Confirm PR #${action.pr} still points to the expected head SHA before applying the answer.`,
        'Confirm required checks pass for the expected head SHA.',
        'Confirm current-head review and product-policy gates match the selected policy.',
      ],
    },
    options: [
      {
        id: 'approve_current_head',
        title: 'Approve the current head',
        description: `Allow ${context.stage} to resume only after current-head revalidation.`,
        consequences: ['No later stage is implicitly approved.', 'A changed head requires a new decision.'],
        recommended: false,
      },
      {
        id: 'request_changes',
        title: 'Request changes',
        description: 'Keep this head blocked and require a revised PR head.',
        consequences: ['Automation stays stopped for this head.', 'The revised head must pass checks and review again.'],
        recommended: productPolicy || incomplete,
        ...(productPolicy || incomplete
          ? { recommendationReason: 'Policy-impacting or incomplete context should be revised or verified before automation resumes.' }
          : {}),
      },
      {
        id: 'stop',
        title: 'Stop automation',
        description: 'Keep this PR and stage stopped without requesting a code change.',
        consequences: ['No automation stage resumes from this answer.'],
        recommended: false,
      },
    ],
    answerRequirements: {
      rationaleRequired: true,
      minimumTextLength: 1,
      maximumTextLength: 2_000,
    },
    resumeGuard: {
      strategy: 'pr_automation_stage',
      expectedDecisionVersion: 1,
      repository: context.repository,
      prNumber: action.pr,
      stage: context.stage,
      expectedHeadSha: context.headSha,
    },
  };
}

export function ensureDecisionForAutomationAction(
  store: DecisionStore,
  action: DevloopAutomationAction,
  context: AutomationActionDecisionContext,
  now: Date = new Date(),
): DecisionProjection {
  return ensureDecisionForAutomationActions(store, [action], context, now);
}

export interface EnsureAutomationDecisionOptions {
  readonly projections?: Map<string, DecisionProjection>;
}

export function ensureDecisionForAutomationActions(
  store: DecisionStore,
  actions: readonly DevloopAutomationAction[],
  context: AutomationActionDecisionContext,
  now: Date = new Date(),
  options: EnsureAutomationDecisionOptions = {},
): DecisionProjection {
  if (
    actions.length === 0
    || actions.some((action) => !isAutomationActionDecisionEligible(action))
  ) {
    throw new DecisionGenerationError('automation_action_not_escalated');
  }
  const pr = actions[0]?.pr;
  if (
    pr === undefined
    || actions.some((action) => action.pr !== pr)
    || actions.some((action) => action.headSha !== context.headSha)
    || !REPOSITORY_PATTERN.test(context.repository)
    || !HEAD_SHA_PATTERN.test(context.headSha)
  ) {
    throw new DecisionGenerationError('candidate_invalid');
  }

  try {
    const input = automationDecisionInput(
      actions.map((action) => ({ ...action, pr })),
      { ...context, repoPath: store.repoPath },
    );
    const projections = options.projections ?? new Map(
      store.list().map((projection) => [projection.request.decisionId, projection]),
    );
    return ensureRecurringDecision(store, input, now, projections);
  } catch (error) {
    if (
      error instanceof DecisionStoreError
      || error instanceof DecisionGenerationError
    ) {
      throw error;
    }
    throw new DecisionGenerationError('candidate_invalid');
  }
}
