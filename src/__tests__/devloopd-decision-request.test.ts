import { describe, expect, it } from 'vitest';
import {
  createDecisionRequest,
  DecisionRequestSchema,
} from '../devloopd/decisionRequest.js';

const subject = {
  repoPath: '/private/worktrees/takt',
  repository: 'albert-einshutoin/takt-private',
  issueNumber: 42,
  title: 'Choose the compatibility policy',
};

const why = {
  summary: 'The proposed change modifies a public API.',
  riskCategory: 'product_policy' as const,
  reasons: ['Existing consumers may break.'],
  evidence: [{
    kind: 'policy' as const,
    reference: 'api-compatibility',
    summary: 'Public API compatibility policy',
  }],
};

const how = {
  summary: 'Resume the run with the selected policy.',
  expectedEffects: ['Rebuild the implementation plan.'],
  verification: ['Confirm the selected policy is present in the task context.'],
};

const answerRequirements = {
  rationaleRequired: true,
  minimumTextLength: 0,
  maximumTextLength: 2_000,
};

const directRunGuard = {
  strategy: 'direct_run' as const,
  expectedDecisionVersion: 1,
  runSlug: 'issue-42',
  expectedRunStatus: 'blocked',
};

describe('createDecisionRequest', () => {
  it('computes the same context hash when identity, time, and local repository path differ', () => {
    const input = {
      subject,
      why,
      how,
      kind: 'yes_no' as const,
      question: 'May the public API change?',
      options: [
        {
          id: 'yes' as const,
          title: 'Yes — allow the API change',
          description: 'Proceed with a breaking change.',
          consequences: ['Migration notes will be required.'],
          recommended: false,
        },
        {
          id: 'no' as const,
          title: 'No — preserve compatibility',
          description: 'Re-scope the implementation.',
          consequences: ['Delivery may take longer.'],
          recommended: true,
          recommendationReason: 'Preserves existing consumers.',
        },
      ],
      answerRequirements,
      resumeGuard: directRunGuard,
    };

    const first = createDecisionRequest(input, {
      decisionId: 'dec_first',
      now: new Date('2026-07-27T01:00:00.000Z'),
    });
    const second = createDecisionRequest({
      ...input,
      subject: { ...subject, repoPath: '/another/private/location' },
    }, {
      decisionId: 'dec_second',
      now: new Date('2026-07-27T02:00:00.000Z'),
    });

    expect(first.contextHash).toBe(second.contextHash);
    expect(first.decisionId).not.toBe(second.decisionId);
    expect(first.createdAt).not.toBe(second.createdAt);
  });

  it('rejects multiple recommended choice options', () => {
    expect(() => createDecisionRequest({
      subject,
      why,
      how,
      kind: 'choice',
      question: 'Choose a compatibility policy.',
      options: [
        {
          id: 'preserve',
          title: 'Preserve compatibility',
          description: 'Keep the current API.',
          consequences: [],
          recommended: true,
        },
        {
          id: 'break',
          title: 'Allow a breaking change',
          description: 'Publish a migration path.',
          consequences: [],
          recommended: true,
        },
      ],
      answerRequirements,
      resumeGuard: directRunGuard,
    })).toThrow(/recommended/i);
  });

  it('accepts text decisions without options', () => {
    const request = createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements: {
        rationaleRequired: true,
        minimumTextLength: 3,
        maximumTextLength: 2_000,
      },
      resumeGuard: directRunGuard,
    });

    expect(request.kind).toBe('text');
    expect('options' in request).toBe(false);
  });

  it('rejects text decisions that carry options', () => {
    expect(() => createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      options: [],
      answerRequirements,
      resumeGuard: directRunGuard,
    } as never)).toThrow();
  });

  it('rejects an unregistered resume strategy', () => {
    expect(() => createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements,
      resumeGuard: {
        strategy: 'shell_command',
        expectedDecisionVersion: 1,
        command: 'npm test',
      },
    } as never)).toThrow();
  });

  it('rejects yes/no option IDs other than exactly yes and no', () => {
    expect(() => createDecisionRequest({
      subject,
      why,
      how,
      kind: 'yes_no',
      question: 'May the public API change?',
      options: [
        {
          id: 'approve',
          title: 'Approve',
          description: 'Allow the change.',
          consequences: [],
          recommended: false,
        },
        {
          id: 'reject',
          title: 'Reject',
          description: 'Preserve compatibility.',
          consequences: [],
          recommended: true,
        },
      ],
      answerRequirements,
      resumeGuard: directRunGuard,
    } as never)).toThrow();
  });

  it('rejects whitespace-only public strings after sanitization', () => {
    expect(() => createDecisionRequest({
      subject: { ...subject, title: ' \n\t ' },
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements,
      resumeGuard: directRunGuard,
    })).toThrow();
  });

  it('accepts the registered PR automation stage guard with typed identifiers', () => {
    const request = createDecisionRequest({
      subject: { ...subject, prNumber: 108 },
      why,
      how,
      kind: 'choice',
      question: 'Choose the next PR automation action.',
      options: [
        {
          id: 'continue',
          title: 'Continue',
          description: 'Continue after revalidation.',
          consequences: [],
          recommended: true,
        },
        {
          id: 'stop',
          title: 'Stop',
          description: 'Keep the PR blocked.',
          consequences: [],
          recommended: false,
        },
      ],
      answerRequirements,
      resumeGuard: {
        strategy: 'pr_automation_stage',
        expectedDecisionVersion: 1,
        repository: 'albert-einshutoin/takt-private',
        prNumber: 108,
        stage: 'merge_queue',
        expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    expect(DecisionRequestSchema.parse(request).resumeGuard.strategy).toBe('pr_automation_stage');
  });
});
