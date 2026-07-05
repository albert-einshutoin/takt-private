export const AGY_MERGEABILITY_REVIEW_MARKER = '<!-- takt-loop-mergeability-review -->';
export const CODEX_HUMAN_REVIEW_MARKER = '<!-- takt-loop-codex-human-review -->';
export const REVIEW_GATE_MARKER_PREFIX = 'takt-loop-review-gate:v1';

export type ReviewGateReviewer = 'agy' | 'codex';
export type ReviewGateDecision = 'approved' | 'blocked';
export type ReviewGateReviewerState = ReviewGateDecision | 'missing' | 'stale';

export interface ReviewGateCommentInput {
  body: string;
  createdAt?: string;
}

export interface ParsedReviewGateComment {
  reviewer: ReviewGateReviewer;
  decision: ReviewGateDecision;
  headSha: string;
  body: string;
  createdAt?: string;
}

export interface DualLlmReviewerReport {
  state: ReviewGateReviewerState;
  headSha?: string;
}

export interface DualLlmApprovalReport {
  approved: boolean;
  headSha: string;
  reasons: string[];
  reviewers: Record<ReviewGateReviewer, DualLlmReviewerReport>;
}

export interface FormatReviewGateCommentOptions {
  reviewer: ReviewGateReviewer;
  decision: ReviewGateDecision;
  headSha: string;
  body: string;
}

function parseMarkerAttributes(body: string): Record<string, string> | undefined {
  const marker = body.match(/<!--\s*takt-loop-review-gate:v1\s+([^>]*)-->/u);
  const rawAttributes = marker?.[1]?.trim();
  if (!rawAttributes) {
    return undefined;
  }

  const attributes: Record<string, string> = {};
  for (const part of rawAttributes.split(/\s+/u)) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = part.slice(0, separatorIndex);
    const value = part.slice(separatorIndex + 1).replace(/^["'`]|["'`]$/gu, '');
    attributes[key] = value;
  }
  return attributes;
}

function parseHeadSha(body: string): string | undefined {
  const match = body.match(/^Head SHA:\s*`?([A-Za-z0-9._/-]+)`?\s*$/imu);
  return match?.[1];
}

function parseLegacyDecision(body: string): { reviewer: ReviewGateReviewer; decision: ReviewGateDecision } | undefined {
  if (body.includes(AGY_MERGEABILITY_REVIEW_MARKER)) {
    const match = body.match(/^Mergeable:\s*(YES|NO)\s*$/imu);
    if (match?.[1] === 'YES') {
      return { reviewer: 'agy', decision: 'approved' };
    }
    if (match?.[1] === 'NO') {
      return { reviewer: 'agy', decision: 'blocked' };
    }
  }

  if (body.includes(CODEX_HUMAN_REVIEW_MARKER)) {
    const match = body.match(/^Codex-Human-Review:\s*(APPROVED|BLOCKED)\s*$/imu);
    if (match?.[1] === 'APPROVED') {
      return { reviewer: 'codex', decision: 'approved' };
    }
    if (match?.[1] === 'BLOCKED') {
      return { reviewer: 'codex', decision: 'blocked' };
    }
  }

  return undefined;
}

function parseReviewer(value: string | undefined): ReviewGateReviewer | undefined {
  if (value === 'agy' || value === 'codex') {
    return value;
  }
  return undefined;
}

function parseDecision(value: string | undefined): ReviewGateDecision | undefined {
  if (value === 'approved' || value === 'blocked') {
    return value;
  }
  return undefined;
}

export function parseReviewGateComment(body: string, createdAt?: string): ParsedReviewGateComment | undefined {
  const attributes = parseMarkerAttributes(body);
  const markerReviewer = parseReviewer(attributes?.reviewer);
  const markerDecision = parseDecision(attributes?.decision);
  const markerHeadSha = attributes?.head;
  if (markerReviewer !== undefined && markerDecision !== undefined && markerHeadSha !== undefined && markerHeadSha.length > 0) {
    return {
      reviewer: markerReviewer,
      decision: markerDecision,
      headSha: markerHeadSha,
      body,
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  }

  const legacy = parseLegacyDecision(body);
  const legacyHeadSha = parseHeadSha(body);
  if (legacy === undefined || legacyHeadSha === undefined) {
    return undefined;
  }

  return {
    ...legacy,
    headSha: legacyHeadSha,
    body,
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function latestReview(
  comments: readonly ParsedReviewGateComment[],
  reviewer: ReviewGateReviewer,
  headSha?: string,
): ParsedReviewGateComment | undefined {
  const matches = comments.filter((comment) => comment.reviewer === reviewer && (headSha === undefined || comment.headSha === headSha));
  return matches.at(-1);
}

function evaluateReviewer(
  parsedComments: readonly ParsedReviewGateComment[],
  reviewer: ReviewGateReviewer,
  headSha: string,
): { report: DualLlmReviewerReport; reason?: string } {
  const current = latestReview(parsedComments, reviewer, headSha);
  if (current !== undefined) {
    if (current.decision === 'approved') {
      return { report: { state: 'approved', headSha } };
    }
    return {
      report: { state: 'blocked', headSha },
      reason: `${reviewer} blocked current head ${headSha}`,
    };
  }

  const anyForReviewer = latestReview(parsedComments, reviewer);
  if (anyForReviewer !== undefined) {
    return {
      report: { state: 'stale', headSha: anyForReviewer.headSha },
      reason: `${reviewer} approval is stale for current head ${headSha}`,
    };
  }

  return {
    report: { state: 'missing' },
    reason: `${reviewer} approval is missing for current head ${headSha}`,
  };
}

export function evaluateDualLlmApproval(options: {
  headSha: string;
  comments: readonly ReviewGateCommentInput[];
}): DualLlmApprovalReport {
  const parsedComments = options.comments.flatMap((comment) => {
    const parsed = parseReviewGateComment(comment.body, comment.createdAt);
    return parsed === undefined ? [] : [parsed];
  });

  const agy = evaluateReviewer(parsedComments, 'agy', options.headSha);
  const codex = evaluateReviewer(parsedComments, 'codex', options.headSha);
  const reasons = [agy.reason, codex.reason].filter((reason): reason is string => reason !== undefined);

  return {
    approved: agy.report.state === 'approved' && codex.report.state === 'approved',
    headSha: options.headSha,
    reasons,
    reviewers: {
      agy: agy.report,
      codex: codex.report,
    },
  };
}

export function formatReviewGateComment(options: FormatReviewGateCommentOptions): string {
  const legacyMarker = options.reviewer === 'agy'
    ? AGY_MERGEABILITY_REVIEW_MARKER
    : CODEX_HUMAN_REVIEW_MARKER;
  const structuredMarker = `<!-- ${REVIEW_GATE_MARKER_PREFIX} reviewer=${options.reviewer} decision=${options.decision} head=${options.headSha} -->`;

  return [
    structuredMarker,
    legacyMarker,
    `Reviewer: \`${options.reviewer}\``,
    `Decision: \`${options.decision}\``,
    `Head SHA: \`${options.headSha}\``,
    '',
    options.body.trim(),
    '',
  ].join('\n');
}
