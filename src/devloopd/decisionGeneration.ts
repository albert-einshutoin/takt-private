import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
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
import type { DecisionProjection } from './decisionEvents.js';
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

function sameRequestIgnoringIdentity(
  left: DecisionRequest,
  right: DecisionRequest,
): boolean {
  const leftSemantic = { ...left } as Partial<DecisionRequest>;
  const rightSemantic = { ...right } as Partial<DecisionRequest>;
  Reflect.deleteProperty(leftSemantic, 'createdAt');
  Reflect.deleteProperty(leftSemantic, 'decisionId');
  Reflect.deleteProperty(rightSemantic, 'createdAt');
  Reflect.deleteProperty(rightSemantic, 'decisionId');
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
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
    if (sameRequestIgnoringTime(sameIdentity.request, request)) return sameIdentity;
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
    const provisional = createDecisionRequest(input, { now });
    const projections = options.projections ?? new Map(
      store.list().map((projection) => [projection.request.decisionId, projection]),
    );
    const sameContext = [...projections.values()].filter((projection) =>
      projection.request.contextHash === provisional.contextHash
      && sameRequestIgnoringIdentity(projection.request, provisional));
    const active = sameContext.filter((projection) => projection.status !== 'applied');
    if (active.length > 1) throw new DecisionStoreError('request_conflict');
    if (active[0] !== undefined) return active[0];

    const appliedCount = sameContext.filter(
      (projection) => projection.status === 'applied',
    ).length;
    const baseDecisionId = `dec_${provisional.contextHash}`;
    const decisionId = appliedCount === 0
      ? baseDecisionId
      : `${baseDecisionId}_r${appliedCount}`;
    const occupied = projections.get(decisionId);
    if (occupied !== undefined) throw new DecisionStoreError('request_conflict');

    const request = createDecisionRequest(input, { decisionId, now });
    const projection = store.requestAndGet(request, { now });
    if (projection.status === 'applied') {
      throw new DecisionStoreError('request_conflict');
    }
    projections.set(decisionId, projection);
    return projection;
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
