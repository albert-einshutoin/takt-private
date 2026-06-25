/**
 * Provider-neutral formatting utilities for issues and PRs.
 *
 * These functions operate on the generic Issue / PrReviewData types
 * from git/types.ts and contain no provider-specific logic.
 */

import type { CreatePrOptions, Issue, PrReviewComment, PrReviewData } from './types.js';

export const TAKT_MANAGED_PR_MARKER = '<!-- takt:managed -->';

export function stripTaktManagedPrMarker(body: string): string {
  return body
    .split(TAKT_MANAGED_PR_MARKER)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function isTaktManagedPrBody(body: string | null | undefined): boolean {
  if (!body) {
    return false;
  }
  const normalizedBody = body.trimEnd();
  return /(?:^|\n\n)<!-- takt:managed -->$/.test(normalizedBody);
}

function appendTaktManagedPrMarker(body: string): string {
  const strippedBody = stripTaktManagedPrMarker(body);
  return `${strippedBody}\n\n${TAKT_MANAGED_PR_MARKER}`;
}

export function buildTaktManagedPrOptions(body: string): Pick<CreatePrOptions, 'body'> {
  return {
    body: appendTaktManagedPrMarker(body),
  };
}

/**
 * Format an issue into task text for workflow execution.
 *
 * Output format:
 * ```
 * ## Issue #6: Fix authentication bug
 *
 * {body}
 *
 * ### Labels
 * bug, priority:high
 *
 * ### Comments
 * **user1**: Comment body...
 * ```
 */
export function formatIssueAsTask(issue: Issue): string {
  const parts: string[] = [];

  parts.push(`## Issue #${issue.number}: ${issue.title}`);

  if (issue.body) {
    parts.push('');
    parts.push(issue.body);
  }

  if (issue.labels.length > 0) {
    parts.push('');
    parts.push('### Labels');
    parts.push(issue.labels.join(', '));
  }

  if (issue.comments.length > 0) {
    parts.push('');
    parts.push('### Comments');
    for (const comment of issue.comments) {
      parts.push(`**${comment.author}**: ${comment.body}`);
    }
  }

  return parts.join('\n');
}

/** Regex to match `#N` patterns (issue numbers) */
const ISSUE_NUMBER_REGEX = /^#(\d+)$/;

/**
 * Parse `#N` patterns from argument strings.
 * Returns issue numbers found, or empty array if none.
 *
 * Each argument must be exactly `#N` (no mixed text).
 * Examples:
 *   ['#6'] → [6]
 *   ['#6', '#7'] → [6, 7]
 *   ['Fix bug'] → []
 *   ['#6', 'and', '#7'] → [] (mixed, not all are issue refs)
 */
export function parseIssueNumbers(args: string[]): number[] {
  if (args.length === 0) return [];

  const numbers: number[] = [];
  for (const arg of args) {
    const match = arg.match(ISSUE_NUMBER_REGEX);
    if (!match?.[1]) return []; // Not all args are issue refs
    numbers.push(Number.parseInt(match[1], 10));
  }

  return numbers;
}

/**
 * Check if a single task string is an issue reference (`#N`).
 */
export function isIssueReference(task: string): boolean {
  return ISSUE_NUMBER_REGEX.test(task.trim());
}

const REVIEW_THREAD_POLICY = [
  '以下のレビューコメントは review thread state ごとに分類されています。',
  'Active Review Threads を主な修正対象にしてください。',
  'Outdated But Unresolved Review Threads は、現在のコードにまだ当てはまるか確認し、当てはまらなければスキップ理由を明記してください。',
  'Resolved / Outdated のコメントは原則として修正対象にせず、現在のコードに同じ問題が明確に残っている場合のみ報告してください。',
  '各コメントについて、対応したか、スキップしたか、理由を最後に要約してください。',
];

function formatPrReviewComment(review: PrReviewComment): string {
  const lines = [`**${review.author}**: ${review.body}`];

  if (review.path) {
    const location = review.line !== undefined
      ? `  File: ${review.path}, Line: ${review.line}`
      : `  File: ${review.path}`;
    lines.push(location);
  }
  if (review.url) {
    lines.push(`  URL: ${review.url}`);
  }

  return lines.join('\n');
}

function formatResolvedPrReviewComment(review: PrReviewComment): string {
  const lines = [formatPrReviewComment(review)];

  if (review.resolvedBy) {
    lines.push(`  Resolved by: ${review.resolvedBy}`);
  }
  if (review.isOutdated !== undefined) {
    lines.push(`  Outdated: ${review.isOutdated ? 'yes' : 'no'}`);
  }

  return lines.join('\n');
}

function normalizePrCommentBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function summarizePrCommentBody(body: string): string {
  const normalized = normalizePrCommentBody(body);
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function isBotAuthor(author: string): boolean {
  const normalized = author.toLowerCase();
  return normalized.endsWith('[bot]') || normalized.endsWith('-bot') || normalized.includes('coderabbit');
}

function formatReviewLocation(review: PrReviewComment): string {
  if (!review.path) {
    return '';
  }
  return review.line !== undefined ? ` at ${review.path}:${review.line}` : ` at ${review.path}`;
}

function appendPrFixFocusedSections(
  parts: string[],
  prReview: PrReviewData,
  groups: {
    summaries: PrReviewComment[];
    active: PrReviewComment[];
    outdatedUnresolved: PrReviewComment[];
    resolved: PrReviewComment[];
    legacyInlineComments: PrReviewComment[];
  },
): void {
  const currentFixRequirements: string[] = [];
  const needsCurrentCodeRecheck: string[] = [];

  for (const comment of prReview.comments) {
    // Bot/generated material is kept for audit below, because generated review text often repeats stale context.
    if (isBotAuthor(comment.author)) {
      continue;
    }
    currentFixRequirements.push(
      `- Conversation comment from ${comment.author}: ${summarizePrCommentBody(comment.body)}`,
    );
  }

  for (const review of groups.active) {
    if (isBotAuthor(review.author)) {
      continue;
    }
    currentFixRequirements.push(
      `- Active review thread from ${review.author}${formatReviewLocation(review)}: ${summarizePrCommentBody(review.body)}`,
    );
  }

  for (const review of groups.outdatedUnresolved) {
    // Outdated unresolved threads can still be real issues, but only after latest-code verification.
    if (isBotAuthor(review.author)) {
      continue;
    }
    needsCurrentCodeRecheck.push(
      `- Outdated unresolved thread from ${review.author}${formatReviewLocation(review)}: ${summarizePrCommentBody(review.body)}`,
    );
  }

  for (const review of groups.legacyInlineComments) {
    if (isBotAuthor(review.author)) {
      continue;
    }
    needsCurrentCodeRecheck.push(
      `- Legacy inline review comment from ${review.author}${formatReviewLocation(review)}: ${summarizePrCommentBody(review.body)}`,
    );
  }

  const botReferenceCount = [
    ...prReview.comments,
    ...groups.summaries,
    ...groups.active,
    ...groups.outdatedUnresolved,
    ...groups.resolved,
    ...groups.legacyInlineComments,
  ].filter((comment) => isBotAuthor(comment.author)).length;

  parts.push('');
  parts.push('### Current Fix Requirements');
  if (currentFixRequirements.length > 0) {
    parts.push(...currentFixRequirements);
  } else {
    parts.push('- No current fix requirement could be classified deterministically. Inspect the recheck and reference sections before editing.');
  }

  parts.push('');
  parts.push('### Needs Current-Code Recheck');
  if (needsCurrentCodeRecheck.length > 0) {
    parts.push(...needsCurrentCodeRecheck);
  } else {
    parts.push('- No unresolved outdated or legacy inline review comments were found.');
  }

  parts.push('');
  parts.push('### Triage Notes');
  if (groups.resolved.length > 0) {
    // Resolved threads are preserved for audit but should not become work unless current code proves the issue still exists.
    parts.push(`- ${groups.resolved.length} resolved/outdated thread${groups.resolved.length === 1 ? '' : 's'} retained as reference only; do not treat it as current work unless the same issue is verified in the latest diff.`);
  }
  if (botReferenceCount > 0) {
    parts.push(`- ${botReferenceCount} bot/generated item(s) kept under reference context; do not promote them to implementation requirements without current-code evidence.`);
  }
  if (groups.summaries.length > 0) {
    parts.push(`- ${groups.summaries.length} review summar${groups.summaries.length === 1 ? 'y is' : 'ies are'} retained as reference; verify concrete findings against the latest base...head diff.`);
  }
  if (groups.resolved.length === 0 && botReferenceCount === 0 && groups.summaries.length === 0) {
    parts.push('- Deterministic triage found no resolved, bot-generated, or summary-only review material.');
  }

  parts.push('');
  parts.push('### Reference Context');
  parts.push('- Review summaries, resolved threads, bot comments, PR description, conversation history, and changed files are preserved below for audit.');
}

function appendReviewSection(
  parts: string[],
  title: string,
  reviews: PrReviewComment[],
  formatReview: (review: PrReviewComment) => string,
): void {
  if (reviews.length === 0) {
    return;
  }

  parts.push('');
  parts.push(title);
  for (const review of reviews) {
    parts.push(formatReview(review));
  }
}

function appendPrContextSection(parts: string[], prReview: PrReviewData): void {
  const baseRefName = prReview.baseRefName?.trim();
  parts.push('');
  parts.push('### PR Context');
  parts.push('This task is derived from a PR. Judge the current PR-wide cumulative diff, not only a single commit, the current working tree, or an earlier gathered snapshot.');
  parts.push('');
  parts.push(`- PR: #${prReview.number}`);
  parts.push(`- Base: ${baseRefName || '(unavailable)'}`);
  parts.push(`- Head: ${prReview.headRefName}`);
  parts.push(`- Diff range: ${baseRefName ? `${baseRefName}...${prReview.headRefName}` : '(unavailable)'}`);
  if (!baseRefName) {
    parts.push('- Base note: PR base branch was unavailable when this task was created; resolve the current PR base before relying on diff assumptions.');
  }
  // review-target.md is a gather-time artifact, so PR follow-up agents must not
  // use it as a substitute for the latest base...head diff.
  parts.push('Use the latest base...head diff as the primary evidence. Previous reports and review-target.md are snapshots/reference material only.');
}

/**
 * Format PR review data into task text for workflow execution.
 */
export function formatPrReviewAsTask(prReview: PrReviewData): string {
  const parts: string[] = [];

  parts.push(`## PR #${prReview.number} Review Comments: ${prReview.title}`);
  appendPrContextSection(parts, prReview);

  if (prReview.body) {
    parts.push('');
    parts.push('### PR Description');
    parts.push(prReview.body);
  }

  const summaries: PrReviewComment[] = [];
  const active: PrReviewComment[] = [];
  const outdatedUnresolved: PrReviewComment[] = [];
  const resolved: PrReviewComment[] = [];
  const legacyInlineComments: PrReviewComment[] = [];

  for (const review of prReview.reviews) {
    switch (review.threadState) {
      case 'active':
        active.push(review);
        break;
      case 'outdated-unresolved':
        outdatedUnresolved.push(review);
        break;
      case 'resolved':
        resolved.push(review);
        break;
      case undefined:
        if (review.path === undefined) {
          summaries.push(review);
        } else {
          legacyInlineComments.push(review);
        }
        break;
    }
  }

  const hasThreadState = active.length > 0 || outdatedUnresolved.length > 0 || resolved.length > 0;
  appendPrFixFocusedSections(parts, prReview, {
    summaries,
    active,
    outdatedUnresolved,
    resolved,
    legacyInlineComments,
  });

  if (hasThreadState) {
    parts.push('');
    parts.push('### Review Policy');
    parts.push(...REVIEW_THREAD_POLICY);
  }

  appendReviewSection(parts, '### Review Summaries', summaries, formatPrReviewComment);
  appendReviewSection(parts, '### Active Review Threads', active, formatPrReviewComment);
  appendReviewSection(parts, '### Outdated But Unresolved Review Threads', outdatedUnresolved, formatPrReviewComment);
  appendReviewSection(parts, '### Resolved / Outdated Review Threads', resolved, formatResolvedPrReviewComment);
  appendReviewSection(parts, '### Review Comments', legacyInlineComments, formatPrReviewComment);

  if (prReview.comments.length > 0) {
    parts.push('');
    parts.push('### Conversation Comments');
    for (const comment of prReview.comments) {
      parts.push(`**${comment.author}**: ${comment.body}`);
    }
  }

  if (prReview.files.length > 0) {
    parts.push('');
    parts.push('### Changed Files');
    for (const file of prReview.files) {
      parts.push(`- ${file}`);
    }
  }

  return parts.join('\n');
}

/**
 * Build PR body from issues and execution report.
 * Supports multiple issues (adds "Closes #N" for each).
 */
export function buildPrBody(issues: Issue[] | undefined, report: string, orderContent?: string): string {
  const parts: string[] = [];
  const summary = issues && issues.length > 0
    ? issues[0]!.body || issues[0]!.title
    : orderContent?.trim()
      ? orderContent
      : undefined;

  parts.push('## Summary');
  if (summary) {
    parts.push('');
    parts.push(summary);
  }

  parts.push('');
  parts.push('## Execution Report');
  parts.push('');
  parts.push(report);

  if (issues && issues.length > 0) {
    parts.push('');
    parts.push(issues.map((issue) => `Closes #${issue.number}`).join('\n'));
  }

  return parts.join('\n');
}
