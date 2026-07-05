import { describe, expect, it } from 'vitest';
import {
  AGY_MERGEABILITY_REVIEW_MARKER,
  CODEX_HUMAN_REVIEW_MARKER,
  evaluateDualLlmApproval,
  formatReviewGateComment,
  parseReviewGateComment,
} from '../devloopd/prReviewGate.js';

describe('devloopd PR review gate', () => {
  it('approves only when agy and Codex approved the current head', () => {
    const report = evaluateDualLlmApproval({
      headSha: 'abc123',
      comments: [
        { body: `${AGY_MERGEABILITY_REVIEW_MARKER}\nHead SHA: \`abc123\`\n\nMergeable: YES\nReason: ok` },
        { body: `${CODEX_HUMAN_REVIEW_MARKER}\nHead SHA: \`abc123\`\n\nCodex-Human-Review: APPROVED\nReason: ok` },
      ],
    });

    expect(report.approved).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it('ignores stale approvals after a new commit', () => {
    const report = evaluateDualLlmApproval({
      headSha: 'new456',
      comments: [
        { body: `${AGY_MERGEABILITY_REVIEW_MARKER}\nHead SHA: \`old123\`\n\nMergeable: YES\nReason: ok` },
        { body: `${CODEX_HUMAN_REVIEW_MARKER}\nHead SHA: \`old123\`\n\nCodex-Human-Review: APPROVED\nReason: ok` },
      ],
    });

    expect(report.approved).toBe(false);
    expect(report.reasons).toContain('agy approval is stale for current head new456');
    expect(report.reasons).toContain('codex approval is stale for current head new456');
  });

  it('blocks disagreement between reviewers', () => {
    const report = evaluateDualLlmApproval({
      headSha: 'abc123',
      comments: [
        { body: `${AGY_MERGEABILITY_REVIEW_MARKER}\nHead SHA: \`abc123\`\n\nMergeable: YES\nReason: ok` },
        { body: `${CODEX_HUMAN_REVIEW_MARKER}\nHead SHA: \`abc123\`\n\nCodex-Human-Review: BLOCKED\nReason: unsafe` },
      ],
    });

    expect(report.approved).toBe(false);
    expect(report.reasons).toContain('codex blocked current head abc123');
  });

  it('reports missing reviewers distinctly', () => {
    const report = evaluateDualLlmApproval({
      headSha: 'abc123',
      comments: [
        { body: `${AGY_MERGEABILITY_REVIEW_MARKER}\nHead SHA: \`abc123\`\n\nMergeable: YES\nReason: ok` },
      ],
    });

    expect(report.approved).toBe(false);
    expect(report.reasons).toContain('codex approval is missing for current head abc123');
  });

  it('parses and emits machine-readable reviewer markers', () => {
    const body = formatReviewGateComment({
      reviewer: 'agy',
      headSha: 'abc123',
      decision: 'approved',
      body: 'Mergeable: YES\nReason: ok',
    });

    expect(parseReviewGateComment(body)).toMatchObject({
      reviewer: 'agy',
      headSha: 'abc123',
      decision: 'approved',
    });
    expect(body).toContain('takt-loop-review-gate:v1 reviewer=agy decision=approved head=abc123');
  });
});
