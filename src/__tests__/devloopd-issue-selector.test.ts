import { describe, expect, it } from 'vitest';
import {
  formatIssueSelectionReport,
  selectIssueCandidates,
  selectIssueFromScan,
} from '../devloopd/issueSelector.js';
import type { IssueCandidate, IssueScanReport } from '../devloopd/issueScanner.js';

function candidate(input: Partial<IssueCandidate> & { number: number; mode: IssueCandidate['mode'] }): IssueCandidate {
  return {
    number: input.number,
    title: input.title ?? `Issue ${input.number}`,
    url: input.url ?? `https://github.com/owner/repo/issues/${input.number}`,
    labels: input.labels ?? ['agent:ready'],
    updatedAt: input.updatedAt ?? '2026-06-24T00:00:00Z',
    comments: input.comments ?? 0,
    mechanicalRisk: input.mechanicalRisk ?? (input.mode === 'auto_merge_candidate' ? 'low' : 'medium'),
    mode: input.mode,
    reason: input.reason ?? 'test candidate',
  };
}

function scanReport(candidates: IssueCandidate[]): IssueScanReport {
  return {
    passed: true,
    message: `Found ${candidates.length} candidate issue(s)`,
    candidates,
    skipped: [],
  };
}

describe('devloopd issue selector', () => {
  it('prefers auto-merge candidates while preserving scan order inside each risk bucket', () => {
    const selected = selectIssueCandidates([
      candidate({ number: 200, mode: 'auto_pr_only' }),
      candidate({ number: 123, mode: 'auto_merge_candidate' }),
      candidate({ number: 124, mode: 'auto_merge_candidate' }),
    ], { maxSelections: 2 });

    expect(selected.map((item) => item.number)).toEqual([123, 124]);
  });

  it('can disable medium-risk auto-pr-only candidates', () => {
    const selected = selectIssueCandidates([
      candidate({ number: 200, mode: 'auto_pr_only' }),
    ], { allowAutoPrOnly: false });

    expect(selected).toEqual([]);
  });

  it('builds a selection report from an issue scan report', () => {
    const report = selectIssueFromScan(scanReport([
      candidate({ number: 200, mode: 'auto_pr_only' }),
      candidate({ number: 123, mode: 'auto_merge_candidate' }),
    ]));

    expect(report.passed).toBe(true);
    expect(report.selected.map((item) => item.number)).toEqual([123]);
    expect(formatIssueSelectionReport(report)).toContain('#123');
  });

  it('does not select when the scan failed', () => {
    const report = selectIssueFromScan({
      passed: false,
      message: 'gh issue list rate limited',
      candidates: [],
      skipped: [],
      failureKind: 'rate_limited',
      retryAfterSeconds: 60,
    });

    expect(report.passed).toBe(false);
    expect(report.selected).toEqual([]);
    expect(formatIssueSelectionReport(report)).toContain('gh issue list rate limited');
  });
});
