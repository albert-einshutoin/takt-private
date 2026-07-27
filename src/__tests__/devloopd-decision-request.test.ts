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
  step: 'compatibility',
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
  expectedRunStatus: 'aborted',
  expectedAbortKind: 'blocked',
  expectedBlockedStep: 'compatibility',
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

  it('binds direct-run resume to an aborted blocked step', () => {
    const request = createDecisionRequest({
      subject: { ...subject, step: 'review' },
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements,
      resumeGuard: {
        strategy: 'direct_run',
        expectedDecisionVersion: 1,
        runSlug: 'issue-42',
        expectedRunStatus: 'aborted',
        expectedAbortKind: 'blocked',
        expectedBlockedStep: 'review',
      },
    });

    expect(request.resumeGuard).toMatchObject({
      strategy: 'direct_run',
      runSlug: 'issue-42',
      expectedRunStatus: 'aborted',
      expectedAbortKind: 'blocked',
      expectedBlockedStep: 'review',
    });
  });

  it('rejects a direct-run guard whose blocked step differs from the subject', () => {
    expect(() => createDecisionRequest({
      subject: { ...subject, step: 'plan' },
      why,
      how,
      kind: 'text',
      question: 'Describe the intended compatibility policy.',
      answerRequirements,
      resumeGuard: {
        strategy: 'direct_run',
        expectedDecisionVersion: 1,
        runSlug: 'issue-42',
        expectedRunStatus: 'aborted',
        expectedAbortKind: 'blocked',
        expectedBlockedStep: 'review',
      },
    })).toThrow(/blocked step|expectedBlockedStep|subject.step/iu);
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

  it('accepts only a candidate-bound issue scout resume guard', () => {
    const request = createDecisionRequest({
      subject: {
        ...subject,
        candidateId: 'local_backlog:compatibility-policy',
      },
      why,
      how,
      kind: 'choice',
      question: 'Choose how Issue Scout should proceed.',
      options: [
        {
          id: 'approve_scope',
          title: 'Approve scope',
          description: 'Keep the proposed scope.',
          consequences: ['Issue Scout will re-plan the candidate.'],
          recommended: false,
        },
        {
          id: 'revise_scope',
          title: 'Revise scope',
          description: 'Narrow the proposed scope.',
          consequences: ['Issue Scout will keep the candidate blocked.'],
          recommended: true,
        },
        {
          id: 'skip',
          title: 'Skip',
          description: 'Do not create an issue.',
          consequences: ['The candidate stays stopped.'],
          recommended: false,
        },
      ],
      answerRequirements,
      resumeGuard: {
        strategy: 'issue_scout_candidate',
        expectedDecisionVersion: 1,
        candidateId: 'local_backlog:compatibility-policy',
      },
    });

    expect(request.resumeGuard).toEqual({
      strategy: 'issue_scout_candidate',
      expectedDecisionVersion: 1,
      candidateId: 'local_backlog:compatibility-policy',
    });
  });

  it.each([
    ['text decision', {
      kind: 'text',
    }],
    ['two choices', {
      kind: 'choice',
      options: [
        {
          id: 'approve_scope',
          title: 'Approve scope',
          description: 'Keep the proposed scope.',
          consequences: [],
          recommended: false,
        },
        {
          id: 'skip',
          title: 'Skip',
          description: 'Do not create an issue.',
          consequences: [],
          recommended: true,
        },
      ],
    }],
    ['four choices', {
      kind: 'choice',
      options: [
        {
          id: 'approve_scope',
          title: 'Approve scope',
          description: 'Keep the proposed scope.',
          consequences: [],
          recommended: false,
        },
        {
          id: 'revise_scope',
          title: 'Revise scope',
          description: 'Narrow the proposed scope.',
          consequences: [],
          recommended: true,
        },
        {
          id: 'skip',
          title: 'Skip',
          description: 'Do not create an issue.',
          consequences: [],
          recommended: false,
        },
        {
          id: 'defer',
          title: 'Defer',
          description: 'Wait for later.',
          consequences: [],
          recommended: false,
        },
      ],
    }],
  ])('rejects an issue scout guard attached to a %s', (_case, decisionShape) => {
    expect(() => createDecisionRequest({
      subject: {
        ...subject,
        candidateId: 'local_backlog:compatibility-policy',
      },
      why,
      how,
      question: 'Choose how Issue Scout should proceed.',
      answerRequirements,
      resumeGuard: {
        strategy: 'issue_scout_candidate',
        expectedDecisionVersion: 1,
        candidateId: 'local_backlog:compatibility-policy',
      },
      ...decisionShape,
    } as never)).toThrow(/approve_scope|choice|Issue Scout/i);
  });

  it('rejects a persisted issue scout request whose decision shape is not canonical', () => {
    const request = createDecisionRequest({
      subject: {
        ...subject,
        candidateId: 'local_backlog:compatibility-policy',
      },
      why,
      how,
      kind: 'choice',
      question: 'Choose how Issue Scout should proceed.',
      options: [
        {
          id: 'approve_scope',
          title: 'Approve scope',
          description: 'Keep the proposed scope.',
          consequences: [],
          recommended: false,
        },
        {
          id: 'revise_scope',
          title: 'Revise scope',
          description: 'Narrow the proposed scope.',
          consequences: [],
          recommended: true,
        },
        {
          id: 'skip',
          title: 'Skip',
          description: 'Do not create an issue.',
          consequences: [],
          recommended: false,
        },
      ],
      answerRequirements,
      resumeGuard: {
        strategy: 'issue_scout_candidate',
        expectedDecisionVersion: 1,
        candidateId: 'local_backlog:compatibility-policy',
      },
    });
    const persisted = { ...request } as Record<string, unknown>;
    Reflect.deleteProperty(persisted, 'options');
    persisted.kind = 'text';
    const parsed = DecisionRequestSchema.safeParse(persisted);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /Issue Scout.*choice/i.test(issue.message))).toBe(true);
    }
  });

  it('rejects an issue scout guard whose candidate differs from the subject', () => {
    expect(() => createDecisionRequest({
      subject: {
        ...subject,
        candidateId: 'local_backlog:compatibility-policy',
      },
      why,
      how,
      kind: 'text',
      question: 'Explain how Issue Scout should proceed.',
      answerRequirements,
      resumeGuard: {
        strategy: 'issue_scout_candidate',
        expectedDecisionVersion: 1,
        candidateId: 'local_backlog:different-candidate',
      },
    })).toThrow(/candidateId/i);
  });

  it('rejects command payloads on issue scout guards', () => {
    expect(() => createDecisionRequest({
      subject: {
        ...subject,
        candidateId: 'local_backlog:compatibility-policy',
      },
      why,
      how,
      kind: 'text',
      question: 'Explain how Issue Scout should proceed.',
      answerRequirements,
      resumeGuard: {
        strategy: 'issue_scout_candidate',
        expectedDecisionVersion: 1,
        candidateId: 'local_backlog:compatibility-policy',
        command: 'rm -rf /',
        args: ['--force'],
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
    const headSha = '0123456789abcdef0123456789abcdef01234567';
    const request = createDecisionRequest({
      subject: { ...subject, prNumber: 108, headSha, step: stage },
      why,
      how,
      kind: 'choice',
      question: 'Choose the next PR automation action.',
      options: [
        {
          id: 'approve_current_head',
          title: 'Approve current head',
          description: 'Continue this stage after revalidation.',
          consequences: [],
          recommended: true,
        },
        {
          id: 'request_changes',
          title: 'Request changes',
          description: 'Keep the PR blocked until the current head changes.',
          consequences: [],
          recommended: false,
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
        expectedHeadSha: headSha,
      },
    });

    expect(DecisionRequestSchema.parse(request).resumeGuard.strategy).toBe('pr_automation_stage');
  });

  it('rejects PR automation choices that do not use the exact current-head policy options', () => {
    expect(() => createDecisionRequest({
      subject: {
        ...subject,
        prNumber: 108,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        step: 'pr-review',
      },
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
        stage: 'pr-review',
        expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      },
    })).toThrow(/approve_current_head|options/i);
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
    ['missing repository', {
      ...subject,
      repository: undefined,
      prNumber: 108,
      headSha: '0123456789abcdef0123456789abcdef01234567',
      step: 'pr-merge',
    }],
    ['different repository', {
      ...subject,
      repository: 'example/other',
      prNumber: 108,
      headSha: '0123456789abcdef0123456789abcdef01234567',
      step: 'pr-merge',
    }],
    ['missing PR number', {
      ...subject,
      prNumber: undefined,
      headSha: '0123456789abcdef0123456789abcdef01234567',
      step: 'pr-merge',
    }],
    ['different PR number', {
      ...subject,
      prNumber: 109,
      headSha: '0123456789abcdef0123456789abcdef01234567',
      step: 'pr-merge',
    }],
    ['missing head SHA', { ...subject, prNumber: 108, step: 'pr-merge' }],
    ['different head SHA', {
      ...subject,
      prNumber: 108,
      headSha: '1123456789abcdef0123456789abcdef01234567',
      step: 'pr-merge',
    }],
    ['missing step', {
      ...subject,
      prNumber: 108,
      headSha: '0123456789abcdef0123456789abcdef01234567',
    }],
    ['different step', {
      ...subject,
      prNumber: 108,
      headSha: '0123456789abcdef0123456789abcdef01234567',
      step: 'pr-review',
    }],
  ])('rejects a PR automation request with a %s', (_case, invalidSubject) => {
    const request = createDecisionRequest({
      subject: {
        ...subject,
        prNumber: 108,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        step: 'pr-merge',
      },
      why,
      how,
      kind: 'choice',
      question: 'Describe the intended compatibility policy.',
      options: [
        {
          id: 'approve_current_head',
          title: 'Approve current head',
          description: 'Continue this stage after revalidation.',
          consequences: [],
          recommended: false,
        },
        {
          id: 'request_changes',
          title: 'Request changes',
          description: 'Keep this head blocked until it changes.',
          consequences: [],
          recommended: true,
        },
        {
          id: 'stop',
          title: 'Stop',
          description: 'Keep automation stopped.',
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
        stage: 'pr-merge',
        expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    expect(() => DecisionRequestSchema.parse({
      ...request,
      subject: invalidSubject,
    })).toThrow(/repository|prNumber|headSha|step/i);
  });

  it('rejects an invalid subject head SHA before creating a PR automation decision', () => {
    expect(() => createDecisionRequest({
      subject: {
        ...subject,
        prNumber: 108,
        headSha: 'abc123',
        step: 'pr-merge',
      },
      why,
      how,
      kind: 'choice',
      question: 'Choose the next PR automation action.',
      options: [
        {
          id: 'approve_current_head',
          title: 'Approve current head',
          description: 'Continue this stage after revalidation.',
          consequences: [],
          recommended: false,
        },
        {
          id: 'request_changes',
          title: 'Request changes',
          description: 'Keep this head blocked until it changes.',
          consequences: [],
          recommended: true,
        },
        {
          id: 'stop',
          title: 'Stop',
          description: 'Keep automation stopped.',
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
        stage: 'pr-merge',
        expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      },
    })).toThrow(/headSha|invalid/i);
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
