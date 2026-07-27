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

export interface IssueScoutDecisionContext {
  readonly repoPath: string;
  readonly repository?: string;
}

export type DecisionGenerationErrorCode =
  | 'candidate_not_escalated'
  | 'candidate_invalid'
  | 'decision_invalid';

export class DecisionGenerationError extends Error {
  readonly code: DecisionGenerationErrorCode;

  constructor(code: DecisionGenerationErrorCode) {
    super(code === 'candidate_not_escalated'
      ? 'The Issue Scout candidate does not require a human decision'
      : code === 'candidate_invalid'
        ? 'The Issue Scout candidate is invalid'
        : 'The Issue Scout decision is invalid');
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
const ALLOWED_EVIDENCE_HOSTS = new Set([
  'api.github.com',
  'cve.org',
  'github.com',
  'nvd.nist.gov',
  'www.cve.org',
]);

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
  rawReference: string,
): string {
  const artifact = candidate.evidence[index];
  const digest = createHash('sha256')
    .update(`${candidate.sourceId}\0${artifact?.kind ?? 'unknown'}\0${rawReference}`, 'utf8')
    .digest('hex');
  return `redacted-${candidate.sourceId}-${artifact?.kind ?? 'unknown'}-${index + 1}-${digest}`;
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
      const rawReference = artifact.path ?? artifact.url ?? artifact.summary;
      return {
        kind: artifact.kind === 'command' ? 'check' as const : 'report' as const,
        reference: safeReference ?? opaqueEvidenceReference(candidate, index, rawReference),
        summary: redacted
          ? `${artifact.summary} (reference redacted)`
          : artifact.summary,
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
  let provisional: DecisionRequest;
  try {
    provisional = createDecisionRequest(buildInput(candidate, canonicalContext), { now });
  } catch {
    throw new DecisionGenerationError('candidate_invalid');
  }
  const decisionId = `dec_${provisional.contextHash}`;
  const request = createDecisionRequest(buildInput(candidate, canonicalContext), { decisionId, now });
  // The semantic hash fully determines the ID. A direct lookup avoids repeatedly
  // folding and scanning every projection for each candidate in a scheduler tick.
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
    // Another scheduler tick can win between list() and request(). Re-read the
    // locked ledger and accept only the exact semantic request; an ID collision
    // with different content remains fail-closed.
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
