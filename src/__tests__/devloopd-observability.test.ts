import { describe, expect, it } from 'vitest';
import {
  buildAutomationStateEvent,
  formatAutomationStateReport,
  summarizeAutomationState,
} from '../devloopd/automationState.js';

describe('devloopd automation state observability', () => {
  it('summarizes compact loop state with redaction and next actions', () => {
    const events = [
      buildAutomationStateEvent({
        stage: 'scout',
        status: 'passed',
        summary: 'selected issue token=secret-value',
        nextActions: ['run issue-to-pr'],
      }, new Date('2026-07-05T00:00:00.000Z')),
      buildAutomationStateEvent({
        stage: 'merge_queue',
        status: 'blocked',
        summary: 'PR #10 evicted for overlap',
        prNumber: 10,
        stopRule: 'conflict eviction',
        nextActions: ['repair PR #10'],
      }, new Date('2026-07-05T00:01:00.000Z')),
    ];

    const report = summarizeAutomationState(events);

    expect(report.eventCount).toBe(2);
    expect(report.currentState).toBe('blocked');
    expect(report.stageCounts.merge_queue).toBe(1);
    expect(report.nextActions).toEqual(['run issue-to-pr', 'repair PR #10']);
    expect(formatAutomationStateReport(report)).toContain('token=[REDACTED]');
  });

  it('truncates large logs before they enter compact reports', () => {
    const report = summarizeAutomationState([
      buildAutomationStateEvent({
        stage: 'ci',
        status: 'failed',
        summary: 'x'.repeat(2_000),
      }, new Date('2026-07-05T00:00:00.000Z')),
    ], { maxSummaryLength: 80 });

    expect(report.recentEvents[0]?.summary.length).toBeLessThanOrEqual(81);
    expect(report.nextActions).toEqual(['inspect failed ci event']);
  });
});
