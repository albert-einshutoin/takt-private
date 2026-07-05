import { describe, expect, it } from 'vitest';
import { evaluateAutomationSafety } from '../devloopd/automationSafety.js';

describe('devloopd automation safety budgets', () => {
  it('stops when hard budgets are exceeded', () => {
    const report = evaluateAutomationSafety({
      budgets: {
        maxRuns: 3,
        maxPullRequests: 2,
        maxRetries: 2,
        maxCostProxy: 100,
        maxDurationSeconds: 3600,
        maxChangedFiles: 20,
        maxChangedLines: 500,
      },
      state: {
        startedAt: '2026-07-05T00:00:00.000Z',
        now: '2026-07-05T00:10:00.000Z',
        runs: 4,
        pullRequests: 1,
        retries: 0,
        costProxy: 10,
        changedFiles: 4,
        changedLines: 80,
      },
    });

    expect(report.allowed).toBe(false);
    expect(report.stopRule).toBe('budget exceeded');
    expect(report.reasons).toContain('runs exceeded: 4 > 3');
  });

  it('treats repeated no-op completion as a stop signal', () => {
    const report = evaluateAutomationSafety({
      budgets: { maxConsecutiveNoopSignals: 2 },
      state: {
        startedAt: '2026-07-05T00:00:00.000Z',
        now: '2026-07-05T00:00:30.000Z',
        consecutiveNoopSignals: 2,
      },
    });

    expect(report.allowed).toBe(false);
    expect(report.stopRule).toBe('completion signal');
  });

  it('circuit-breaks repeated classifier, CI, review-fix, and policy failures', () => {
    const report = evaluateAutomationSafety({
      budgets: {
        maxClassifierDisagreements: 1,
        maxCiFlakes: 2,
        maxReviewFixFailures: 1,
        maxProductPolicyEscalations: 1,
      },
      state: {
        startedAt: '2026-07-05T00:00:00.000Z',
        now: '2026-07-05T00:00:30.000Z',
        classifierDisagreements: 2,
        ciFlakes: 3,
        reviewFixFailures: 2,
        productPolicyEscalations: 2,
      },
    });

    expect(report.allowed).toBe(false);
    expect(report.stopRule).toBe('circuit breaker');
    expect(report.reasons).toContain('classifier disagreements exceeded: 2 > 1');
    expect(report.reasons).toContain('CI flakes exceeded: 3 > 2');
  });
});
