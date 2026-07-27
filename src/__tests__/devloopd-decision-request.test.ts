import { describe, expect, it } from 'vitest';
import {
  CreateDecisionRequestInputSchema,
  createDecisionRequest,
  DecisionRequestSchema,
} from '../devloopd/decisionRequest.js';

const subject = {
  repoPath: '/private/worktrees/takt',
  repository: 'albert-einshutoin/takt-private',
  runSlug: 'issue-42',
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

  it.each([
    'issue-scout',
    'issue-to-pr',
    'pr-review',
    'review-fix',
    'pr-merge',
  ] as const)('accepts the registered %s PR automation stage', (stage) => {
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
        stage,
        expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    expect(DecisionRequestSchema.parse(request).resumeGuard.strategy).toBe('pr_automation_stage');
  });

  it('rejects automation-state labels that are not PR automation stages', () => {
    expect(() => createDecisionRequest({
      subject: { ...subject, prNumber: 108 },
      why,
      how,
      kind: 'text',
      question: 'Choose the next PR automation action.',
      answerRequirements,
      resumeGuard: {
        strategy: 'pr_automation_stage',
        expectedDecisionVersion: 1,
        repository: 'albert-einshutoin/takt-private',
        prNumber: 108,
        stage: 'merge_queue',
        expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      },
    } as never)).toThrow();
  });

  it('rejects a request whose decision version differs from its resume guard', () => {
    const request = createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements,
      resumeGuard: directRunGuard,
    });

    expect(() => DecisionRequestSchema.parse({
      ...request,
      decisionVersion: 2,
    })).toThrow(/decisionVersion/i);
  });

  it.each([
    ['missing', { ...subject, runSlug: undefined }],
    ['different', { ...subject, runSlug: 'issue-99' }],
  ])('rejects a direct-run request with a %s subject run slug', (_case, invalidSubject) => {
    const request = createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements,
      resumeGuard: directRunGuard,
    });

    expect(() => DecisionRequestSchema.parse({
      ...request,
      subject: invalidSubject,
    })).toThrow(/runSlug/i);
  });

  it.each([
    ['missing repository', { ...subject, repository: undefined, prNumber: 108 }],
    ['different repository', { ...subject, repository: 'example/other', prNumber: 108 }],
    ['missing PR number', { ...subject, prNumber: undefined }],
    ['different PR number', { ...subject, prNumber: 109 }],
  ])('rejects a PR automation request with a %s', (_case, invalidSubject) => {
    const request = createDecisionRequest({
      subject: { ...subject, prNumber: 108 },
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements,
      resumeGuard: {
        strategy: 'pr_automation_stage',
        expectedDecisionVersion: 1,
        repository: 'albert-einshutoin/takt-private',
        prNumber: 108,
        stage: 'pr-merge',
        expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    expect(() => DecisionRequestSchema.parse({
      ...request,
      subject: invalidSubject,
    })).toThrow(/repository|prNumber/i);
  });

  it('deep-freezes generated decisions and public schema parse results', () => {
    const request = createDecisionRequest({
      subject,
      why,
      how,
      kind: 'yes_no',
      question: 'May the public API change?',
      options: [
        {
          id: 'yes',
          title: 'Allow the change',
          description: 'Proceed.',
          consequences: ['Publish migration notes.'],
          recommended: false,
        },
        {
          id: 'no',
          title: 'Preserve compatibility',
          description: 'Re-scope the change.',
          consequences: [],
          recommended: true,
        },
      ],
      answerRequirements,
      resumeGuard: directRunGuard,
    });

    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.options)).toBe(true);
    expect(Object.isFrozen(request.options[0])).toBe(true);
    expect(() => {
      (request as unknown as { question: string }).question = 'Mutated';
    }).toThrow(TypeError);
    expect(() => {
      (request.options[0] as unknown as { title: string }).title = 'Mutated';
    }).toThrow(TypeError);

    const parsed = DecisionRequestSchema.parse(JSON.parse(JSON.stringify(request)));
    const originalContextHash = parsed.contextHash;

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.subject)).toBe(true);
    expect(Object.isFrozen(parsed.options)).toBe(true);
    expect(Object.isFrozen(parsed.options[0])).toBe(true);
    expect(() => {
      (parsed as unknown as { contextHash: string }).contextHash = '0'.repeat(64);
    }).toThrow(TypeError);
    expect(() => {
      (parsed.options[0] as unknown as { title: string }).title = 'Mutated';
    }).toThrow(TypeError);
    expect(parsed.contextHash).toBe(originalContextHash);
    expect(() => DecisionRequestSchema.parse({
      ...JSON.parse(JSON.stringify(request)),
      contextHash: '0'.repeat(64),
    })).toThrow(/contextHash/i);
  });

  it('rejects persisted requests whose semantic context no longer matches the hash', () => {
    const request = createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements,
      resumeGuard: directRunGuard,
    });

    expect(() => DecisionRequestSchema.parse({
      ...JSON.parse(JSON.stringify(request)),
      question: 'A different semantic question.',
    })).toThrow(/contextHash/i);
  });

  it('redacts POSIX and Windows absolute paths without changing URLs', () => {
    const request = createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: 'Review /root and C:\\Users\\alice\\secret, keep https://example.com/docs.',
      answerRequirements,
      resumeGuard: directRunGuard,
    });

    expect(request.question).toBe(
      'Review [LOCAL_PATH] and [LOCAL_PATH], keep https://example.com/docs.',
    );
  });

  it('redacts file URLs and cwd-prefixed local paths while preserving public URLs', () => {
    const request = createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: [
        'Read file:///root/.ssh/id_rsa',
        'from cwd:/root/.ssh/id_rsa',
        'and keep https://example.com/docs.',
      ].join(' '),
      answerRequirements,
      resumeGuard: directRunGuard,
    });

    expect(request.question).toBe(
      'Read [LOCAL_PATH] from cwd:[LOCAL_PATH] and keep https://example.com/docs.',
    );
  });

  it('removes ANSI, C0, C1, and Unicode format controls from public text', () => {
    const request = createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: '\u001b[31mAllow\u001b[0m\u0000\u0085\u202E change?',
      answerRequirements,
      resumeGuard: directRunGuard,
    });

    expect(request.question).toBe('Allow change?');
    expect(request.question).not.toMatch(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/u);
  });

  it('removes format controls before redacting sensitive assignments', () => {
    const secret = 'ghp_1234567890abcdef';
    const request = createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: `api\u200B_key=${secret}`,
      answerRequirements,
      resumeGuard: directRunGuard,
    });

    expect(request.question).toBe('api_key=[REDACTED]');
    expect(request.question).not.toContain(secret);
  });

  it('rejects public text beyond its explicit maximum length', () => {
    expect(() => createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: 'a'.repeat(4_001),
      answerRequirements,
      resumeGuard: directRunGuard,
    })).toThrow();
  });

  it('rejects identifier control characters without echoing their value in errors', () => {
    const injectedHeader = 'issue-42\r\nX-Injected: secret';
    const parsed = CreateDecisionRequestInputSchema.safeParse({
      subject,
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements,
      resumeGuard: {
        ...directRunGuard,
        runSlug: injectedHeader,
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).not.toContain('X-Injected');
      expect(JSON.stringify(parsed.error.issues)).not.toContain('secret');
    }

    expect(() => createDecisionRequest({
      subject,
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements,
      resumeGuard: directRunGuard,
    }, {
      decisionId: 'dec_ok\r\nX-Injected: secret',
    })).toThrow();
  });

  it.each([
    'product_policy',
    'human_policy',
    'security',
    'permission',
    'high_risk',
  ] as const)('requires rationale for %s decisions', (riskCategory) => {
    expect(() => createDecisionRequest({
      subject,
      why: { ...why, riskCategory },
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements: {
        ...answerRequirements,
        rationaleRequired: false,
      },
      resumeGuard: directRunGuard,
    })).toThrow(/rationaleRequired/i);
  });

  it('allows rationale to remain optional for requirements ambiguity', () => {
    const request = createDecisionRequest({
      subject,
      why: { ...why, riskCategory: 'requirements_ambiguity' },
      how,
      kind: 'text',
      question: 'Describe the missing requirement.',
      answerRequirements: {
        ...answerRequirements,
        rationaleRequired: false,
      },
      resumeGuard: directRunGuard,
    });

    expect(request.answerRequirements.rationaleRequired).toBe(false);
  });
});
