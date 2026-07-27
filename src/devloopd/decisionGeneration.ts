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

export type DecisionGenerationErrorCode = 'candidate_not_escalated';

export class DecisionGenerationError extends Error {
  readonly code: DecisionGenerationErrorCode;

  constructor(code: DecisionGenerationErrorCode) {
    super('The Issue Scout candidate does not require a human decision');
    this.name = 'DecisionGenerationError';
    this.code = code;
  }
}

const ACTIVE_DECISION_STATUSES = new Set<DecisionProjection['status']>([
  'open',
  'answered',
  'applying',
  'revalidation_required',
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

function evidenceFor(
  candidate: IssueScoutCandidate,
): CreateDecisionRequestInput['why']['evidence'] {
  return [
    ...candidate.evidence.map((artifact, index) => ({
      kind: artifact.kind === 'command' ? 'check' as const : 'report' as const,
      // Raw paths and URLs are routing metadata, not evidence content. Keeping
      // stable local references prevents a decision ledger from becoming a
      // second store for workstation paths or credential-bearing URLs.
      reference: `candidate-evidence-${index + 1}`,
      summary: artifact.summary,
    })),
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
      evidence: evidenceFor(candidate),
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

  const canonicalContext = {
    ...context,
    repoPath: store.repoPath,
  };
  const provisional = createDecisionRequest(buildInput(candidate, canonicalContext), { now });
  const decisionId = `dec_${provisional.contextHash}`;
  const request = createDecisionRequest(buildInput(candidate, canonicalContext), {
    decisionId,
    now,
  });
  const existing = store.list().find(
    (projection) =>
      projection.request.contextHash === request.contextHash
      && ACTIVE_DECISION_STATUSES.has(projection.status),
  );
  if (existing !== undefined) {
    if (sameRequestIgnoringTime(existing.request, request)) return existing;
    throw new DecisionStoreError('request_conflict');
  }

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
