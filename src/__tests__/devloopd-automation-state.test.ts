import { describe, expect, it } from 'vitest';
import {
  buildAutomationStateEvent,
  formatAutomationStateReport,
  summarizeAutomationState,
} from '../devloopd/automationState.js';

describe('devloopd automation decision correlation', () => {
  it('preserves a decision ID through event construction, summary, and formatting', () => {
    const event = buildAutomationStateEvent({
      stage: 'human_escalation',
      status: 'blocked',
      summary: 'A product owner decision is required.',
      prNumber: 77,
      decisionId: 'dec_0123456789abcdef',
    }, new Date('2026-07-28T00:00:00.000Z'));
    const report = summarizeAutomationState([event]);

    expect(event.decisionId).toBe('dec_0123456789abcdef');
    expect(report.recentEvents[0]?.decisionId).toBe('dec_0123456789abcdef');
    expect(formatAutomationStateReport(report)).toContain('decision: dec_0123456789abcdef');
  });
});
