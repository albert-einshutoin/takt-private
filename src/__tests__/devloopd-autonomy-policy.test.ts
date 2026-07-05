import { describe, expect, it } from 'vitest';
import {
  classifyRecursiveAutomationLane,
  listRecursiveAutomationLanes,
} from '../devloopd/autonomyPolicy.js';

describe('devloopd recursive automation policy', () => {
  it('defines every recursive automation lane with verification and escalation rules', () => {
    const lanes = listRecursiveAutomationLanes();

    expect(lanes.map((lane) => lane.lane)).toEqual([
      'feature_improvement',
      'performance',
      'dependencies',
      'security_hardening',
      'idiomatic_refactor',
      'docs_tests_tooling',
    ]);
    expect(lanes.every((lane) => lane.allowedWork.length > 0)).toBe(true);
    expect(lanes.every((lane) => lane.humanReviewEscalation.length > 0)).toBe(true);
    expect(lanes.every((lane) => lane.defaultVerification.length > 0)).toBe(true);
  });

  it.each([
    ['feature_improvement', 'Improve existing workflow routing'],
    ['performance', 'Reduce benchmark latency and memory allocations'],
    ['dependencies', 'Update dependency lockfile evidence'],
    ['security_hardening', 'Apply security hardening for secret redaction'],
    ['idiomatic_refactor', 'Refactor to more idiomatic TypeScript types'],
    ['docs_tests_tooling', 'Add docs and tests for devloopd'],
  ] as const)('routes %s work from text evidence', (lane, title) => {
    const result = classifyRecursiveAutomationLane({ title });

    expect(result.lane).toBe(lane);
    expect(result.requiresHumanReview).toBe(false);
  });

  it('escalates lane taxonomy and product-direction changes to human review', () => {
    const result = classifyRecursiveAutomationLane({
      title: 'Change lane taxonomy for billing roadmap work',
      labels: ['lane:performance'],
    });

    expect(result.lane).toBe('performance');
    expect(result.requiresHumanReview).toBe(true);
    expect(result.reasons.join('\n')).toContain('policy escalation');
  });
});
