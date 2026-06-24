import type { IssueCandidate, IssueScanReport } from './issueScanner.js';

export interface IssueSelectorOptions {
  maxSelections?: number;
  allowAutoPrOnly?: boolean;
}

export interface IssueSelectionReport {
  passed: boolean;
  message: string;
  scan: IssueScanReport;
  selected: IssueCandidate[];
}

function normalizeMaxSelections(value: number | undefined): number | undefined {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function candidatePriority(candidate: IssueCandidate): number {
  if (candidate.mode === 'auto_merge_candidate') return 0;
  if (candidate.mode === 'auto_pr_only') return 1;
  return 2;
}

export function selectIssueCandidates(
  candidates: readonly IssueCandidate[],
  options: IssueSelectorOptions = {},
): IssueCandidate[] {
  const maxSelections = normalizeMaxSelections(options.maxSelections);
  if (maxSelections === undefined) {
    return [];
  }

  const allowAutoPrOnly = options.allowAutoPrOnly !== false;
  return candidates
    .filter((candidate) => allowAutoPrOnly || candidate.mode !== 'auto_pr_only')
    .map((candidate, index) => ({ candidate, index }))
    // Keep selection deterministic and auditable: prefer low-risk auto-merge candidates, then preserve scanner order.
    .sort((left, right) =>
      candidatePriority(left.candidate) - candidatePriority(right.candidate) || left.index - right.index,
    )
    .slice(0, maxSelections)
    .map((entry) => entry.candidate);
}

export function selectIssueFromScan(
  scan: IssueScanReport,
  options: IssueSelectorOptions = {},
): IssueSelectionReport {
  if (!scan.passed) {
    return {
      passed: false,
      message: scan.message,
      scan,
      selected: [],
    };
  }

  const selected = selectIssueCandidates(scan.candidates, options);
  return {
    passed: selected.length > 0,
    message: selected.length > 0
      ? `Selected ${selected.length} issue candidate(s)`
      : 'No issue candidates selected',
    scan,
    selected,
  };
}

function formatCandidate(candidate: IssueCandidate): string {
  return `#${candidate.number} [${candidate.mode}/${candidate.mechanicalRisk}] ${candidate.title} - ${candidate.reason}`;
}

export function formatIssueSelectionReport(report: IssueSelectionReport): string {
  const lines = [
    report.passed ? 'devloopd select-issue passed' : 'devloopd select-issue failed',
    report.message,
    `Scan: ${report.scan.message}`,
  ];

  if (report.selected.length > 0) {
    lines.push('Selected:');
    lines.push(...report.selected.map((candidate) => `- ${formatCandidate(candidate)}`));
  }
  if (report.scan.retryAfterSeconds !== undefined) {
    lines.push(`Retry after: ${report.scan.retryAfterSeconds}s`);
  }

  return lines.join('\n');
}
