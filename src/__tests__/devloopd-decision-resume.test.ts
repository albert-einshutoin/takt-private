import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDecision,
  createDefaultResumeAdapters,
  type ResumeAdapter,
  type ResumeContext,
} from '../devloopd/decisionResume.js';
import { createDecisionRequest } from '../devloopd/decisionRequest.js';
import { DecisionStore } from '../devloopd/decisionStore.js';
import { readRawDevloopLedgerEvents } from '../devloopd/ledger.js';
import {
  createDecisionApplyStartedEvent,
} from '../devloopd/decisionEvents.js';
import { appendDevloopLedgerEvent } from '../devloopd/ledger.js';

describe('guarded decision resume', () => {
  let repoPath: string;
  let store: DecisionStore;
  let context: ResumeContext;
  let adapter: ResumeAdapter;
  const resume = vi.fn(async () => ({ status: 'resumed' as const, summary: 'run resumed' }));
  const revalidate = vi.fn(async () => ({ valid: true as const }));

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-decision-resume-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
    store = new DecisionStore(repoPath);
    const request = createDecisionRequest({
      subject: {
        repoPath,
        runSlug: 'run-1',
        workflow: 'default',
        step: 'approval',
        title: 'Approve blocked run',
      },
      question: 'Resume this run?',
      why: {
        summary: 'The run requires an explicit answer.',
        riskCategory: 'requirements_ambiguity',
        reasons: ['The workflow cannot choose for the user.'],
        evidence: [],
      },
      how: {
        summary: 'Resume only the guarded run.',
        expectedEffects: ['The blocked step is retried.'],
        verification: ['The run guard is checked again.'],
      },
      kind: 'yes_no',
      options: [
        {
          id: 'yes',
          title: 'Yes — resume',
          description: 'Resume this exact run.',
          consequences: [],
          recommended: false,
        },
        {
          id: 'no',
          title: 'No — remain stopped',
          description: 'Do not resume.',
          consequences: [],
          recommended: true,
        },
      ],
      answerRequirements: {
        rationaleRequired: true,
        minimumTextLength: 0,
        maximumTextLength: 2_000,
      },
      resumeGuard: {
        strategy: 'direct_run',
        expectedDecisionVersion: 1,
        runSlug: 'run-1',
        expectedRunStatus: 'aborted',
        expectedAbortKind: 'blocked',
        expectedBlockedStep: 'approval',
      },
    }, { decisionId: 'dec_resume' });
    store.request(request, { eventId: 'evt_requested' });
    store.answer({
      decisionId: request.decisionId,
      expectedDecisionVersion: request.decisionVersion,
      expectedContextHash: request.contextHash,
      value: { optionId: 'yes' },
      rationale: 'Resume with the selected policy.',
      idempotencyKey: 'answer-1',
    }, 'local:test', { eventId: 'evt_answered' });
    context = {
      store,
      decisionId: request.decisionId,
      expectedDecisionVersion: request.decisionVersion,
      expectedContextHash: request.contextHash,
    };
    adapter = {
      strategy: 'resume_direct_run',
      revalidate,
      resume,
    };
    resume.mockClear();
    revalidate.mockClear();
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('applies a valid answer exactly once and is idempotent', async () => {
    await expect(applyDecision(context, { adapters: [adapter] }))
      .resolves.toMatchObject({ status: 'applied' });
    await expect(applyDecision(context, { adapters: [adapter] }))
      .resolves.toMatchObject({ status: 'applied' });

    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(readRawDevloopLedgerEvents(store.ledgerPath).map((event) => event.eventType))
      .toEqual([
        'devloop_decision_requested',
        'devloop_decision_answered',
        'devloop_decision_apply_started',
        'devloop_decision_applied',
      ]);
  });

  it.each([
    ['decision version', { expectedDecisionVersion: 2 }],
    ['context hash', { expectedContextHash: 'f'.repeat(64) }],
  ])('marks a stale %s as requiring revalidation', async (_label, changed) => {
    const result = await applyDecision({ ...context, ...changed }, { adapters: [adapter] });

    expect(result.status).toBe('revalidation_required');
    expect(resume).not.toHaveBeenCalled();
    expect(store.get(context.decisionId)?.status).toBe('revalidation_required');
  });

  it('does not call the adapter when target revalidation fails', async () => {
    revalidate.mockResolvedValueOnce({
      valid: false,
      reasonCode: 'run_status_changed',
      summary: 'run state changed',
    });

    const result = await applyDecision(context, { adapters: [adapter] });

    expect(result).toMatchObject({
      status: 'revalidation_required',
      reasonCode: 'run_status_changed',
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it.each([
    'run_status_changed',
    'worktree_dirty',
    'active_run_changed',
    'pr_head_changed',
  ])('fails closed when %s is the only changed guard', async (reasonCode) => {
    revalidate.mockResolvedValueOnce({
      valid: false,
      reasonCode,
      summary: 'guard changed',
    });

    const result = await applyDecision(context, { adapters: [adapter] });

    expect(result).toMatchObject({ status: 'revalidation_required', reasonCode });
    expect(resume).not.toHaveBeenCalled();
  });

  it('default direct adapter rejects a changed real run status before any command', async () => {
    const projection = store.get(context.decisionId);
    if (projection === undefined) throw new Error('projection missing');
    const runnerCalls: string[] = [];
    const defaultAdapter = createDefaultResumeAdapters({
      resolveCommand: () => '/mock/git',
      async exec(_command, args) {
        runnerCalls.push(args.join(' '));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }).find((item) => item.strategy === 'resume_direct_run');
    if (defaultAdapter === undefined) throw new Error('adapter missing');

    const result = await defaultAdapter.revalidate({
      ...context,
      projection,
      strategy: 'resume_direct_run',
    });

    expect(result).toMatchObject({ valid: false, reasonCode: 'run_status_changed' });
    expect(runnerCalls).toEqual([]);
  });

  it('default direct adapter rejects a dirty real worktree without a resume command', async () => {
    const runDir = join(repoPath, '.takt', 'runs', 'run-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
      task: 'task',
      workflow: 'default',
      runSlug: 'run-1',
      runRoot: '.takt/runs/run-1',
      reportDirectory: '.takt/runs/run-1/reports',
      contextDirectory: '.takt/runs/run-1/context',
      logsDirectory: '.takt/runs/run-1/logs',
      status: 'aborted',
      startTime: '2026-07-28T00:00:00.000Z',
      abortKind: 'blocked',
      blockedStep: 'approval',
    }));
    const projection = store.get(context.decisionId);
    if (projection === undefined) throw new Error('projection missing');
    const runnerCalls: string[] = [];
    const defaultAdapter = createDefaultResumeAdapters({
      resolveCommand: () => '/mock/git',
      async exec(_command, args) {
        runnerCalls.push(args.join(' '));
        return { exitCode: 0, stdout: ' M src/file.ts\n', stderr: '' };
      },
    }).find((item) => item.strategy === 'resume_direct_run');
    if (defaultAdapter === undefined) throw new Error('adapter missing');

    const result = await defaultAdapter.revalidate({
      ...context,
      projection,
      strategy: 'resume_direct_run',
    });

    expect(result).toMatchObject({ valid: false, reasonCode: 'worktree_dirty' });
    expect(runnerCalls).toEqual(['status --porcelain']);
  });

  it('default direct adapter rejects a real active run before any command', async () => {
    for (const [slug, status] of [['run-1', 'aborted'], ['run-active', 'running']] as const) {
      const runDir = join(repoPath, '.takt', 'runs', slug);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
        task: 'task',
        workflow: 'default',
        runSlug: slug,
        runRoot: `.takt/runs/${slug}`,
        reportDirectory: `.takt/runs/${slug}/reports`,
        contextDirectory: `.takt/runs/${slug}/context`,
        logsDirectory: `.takt/runs/${slug}/logs`,
        status,
        startTime: '2026-07-28T00:00:00.000Z',
        ...(status === 'aborted' ? { abortKind: 'blocked', blockedStep: 'approval' } : {}),
      }));
    }
    const projection = store.get(context.decisionId);
    if (projection === undefined) throw new Error('projection missing');
    const runnerCalls: string[] = [];
    const defaultAdapter = createDefaultResumeAdapters({
      resolveCommand: () => '/mock/git',
      async exec(_command, args) {
        runnerCalls.push(args.join(' '));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }).find((item) => item.strategy === 'resume_direct_run');
    if (defaultAdapter === undefined) throw new Error('adapter missing');

    const result = await defaultAdapter.revalidate({
      ...context,
      projection,
      strategy: 'resume_direct_run',
    });

    expect(result).toMatchObject({ valid: false, reasonCode: 'active_run_changed' });
    expect(runnerCalls).toEqual([]);
  });

  it('allows only one of two Decision starts through the shared repository claim', async () => {
    const projection = store.get(context.decisionId);
    if (projection === undefined) throw new Error('projection missing');
    let releaseRun: (() => void) | undefined;
    const resumeRun = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return { status: 'resumed' as const };
    });
    const defaultAdapter = createDefaultResumeAdapters({
      resolveCommand: () => '/mock/git',
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }, {
      inspectActiveRuns: () => ({
        passed: true,
        message: 'no active runs',
        activeRuns: [],
        staleAfterMinutes: 180,
      }),
      resumeDirectRunBySlug: resumeRun,
    }).find((item) => item.strategy === 'resume_direct_run');
    if (defaultAdapter === undefined) throw new Error('adapter missing');
    const firstContext = {
      ...context,
      projection,
      strategy: 'resume_direct_run' as const,
    };
    const secondContext = {
      ...firstContext,
      decisionId: 'dec_resume_other',
      projection: {
        ...projection,
        request: {
          ...projection.request,
          decisionId: 'dec_resume_other',
        },
      },
    };

    const first = defaultAdapter.resume(firstContext);
    await vi.waitFor(() => expect(resumeRun).toHaveBeenCalledTimes(1));
    await expect(defaultAdapter.resume(secondContext)).resolves.toMatchObject({
      status: 'revalidation_required',
      reasonCode: 'repo_execution_claimed',
    });
    releaseRun?.();
    await expect(first).resolves.toMatchObject({ status: 'resumed' });
    expect(resumeRun).toHaveBeenCalledTimes(1);
  });

  it('default PR adapter rejects a changed real head without a mutation command', async () => {
    const expectedHeadSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const request = createDecisionRequest({
      subject: {
        repoPath,
        repository: 'owner/repo',
        prNumber: 42,
        headSha: expectedHeadSha,
        step: 'pr-review',
        title: 'Approve current PR head',
      },
      question: 'Approve this current head?',
      why: {
        summary: 'The PR changes product policy.',
        riskCategory: 'product_policy',
        reasons: ['Authentication policy changes require approval.'],
        evidence: [],
      },
      how: {
        summary: 'Continue only this PR review stage.',
        expectedEffects: ['The exact PR head is reviewed.'],
        verification: ['Checks, reviews, and head are revalidated.'],
      },
      kind: 'choice',
      options: [
        {
          id: 'approve_current_head',
          title: 'Approve current head',
          description: 'Continue this exact head.',
          consequences: [],
          recommended: false,
        },
        {
          id: 'request_changes',
          title: 'Request changes',
          description: 'Keep this head blocked.',
          consequences: [],
          recommended: true,
        },
        {
          id: 'stop',
          title: 'Stop',
          description: 'Stop automation.',
          consequences: [],
          recommended: false,
        },
      ],
      answerRequirements: {
        rationaleRequired: true,
        minimumTextLength: 1,
        maximumTextLength: 2_000,
      },
      resumeGuard: {
        strategy: 'pr_automation_stage',
        expectedDecisionVersion: 1,
        repository: 'owner/repo',
        prNumber: 42,
        stage: 'pr-review',
        expectedHeadSha,
      },
    }, { decisionId: 'dec_pr_head' });
    store.request(request);
    store.answer({
      decisionId: request.decisionId,
      expectedDecisionVersion: request.decisionVersion,
      expectedContextHash: request.contextHash,
      value: { optionId: 'approve_current_head' },
      rationale: 'Approve only the exact reviewed head.',
      idempotencyKey: 'answer-pr-head',
    }, 'local:test');
    const calls: string[] = [];
    const adapters = createDefaultResumeAdapters({
      resolveCommand: (command) => command === 'gh' ? '/mock/gh' : undefined,
      async exec(_command, args) {
        calls.push(args.join(' '));
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 42,
            headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          }),
          stderr: '',
        };
      },
    });

    const result = await applyDecision({
      store,
      decisionId: request.decisionId,
      expectedDecisionVersion: request.decisionVersion,
      expectedContextHash: request.contextHash,
    }, { adapters });

    expect(result).toMatchObject({
      status: 'revalidation_required',
      reasonCode: 'pr_head_changed',
    });
    expect(calls).toEqual([
      'pr view 42 --json number,title,body,headRefOid,mergeStateStatus,changedFiles,additions,deletions --repo owner/repo',
    ]);
    expect(calls.some((call) => call.startsWith('pr edit'))).toBe(false);
  });

  it('allows only one concurrent caller to perform the side effect', async () => {
    let release: (() => void) | undefined;
    resume.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 'resumed', summary: 'run resumed' };
    });

    const first = applyDecision(context, { adapters: [adapter] });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    const second = await applyDecision(context, { adapters: [adapter] });
    expect(second.status).toBe('applying');
    release?.();
    await expect(first).resolves.toMatchObject({ status: 'applied' });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it.each([
    'before any side effect',
    'after a side effect but before its terminal event',
  ])('reconciles a dead apply owner %s without replaying the adapter', async () => {
    const projection = store.get(context.decisionId);
    if (projection?.answer === undefined) throw new Error('answer missing');
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionApplyStartedEvent({
      decisionId: context.decisionId,
      decisionVersion: context.expectedDecisionVersion,
      contextHash: context.expectedContextHash,
      answerEventId: projection.answer.eventId,
      sanitizedSummary: 'apply claimed',
      operationId: 'op_crashed',
      ownerPid: 999_999,
      ownerStartToken: 'owner_crashed',
    }));

    const result = await applyDecision(context, {
      adapters: [adapter],
      inspectOwner: () => 'dead',
    });

    expect(result).toMatchObject({
      status: 'revalidation_required',
      reasonCode: 'apply_owner_terminated',
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it('migrates a legacy apply claim without owner fields to fail-closed revalidation', async () => {
    const projection = store.get(context.decisionId);
    if (projection?.answer === undefined) throw new Error('answer missing');
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionApplyStartedEvent({
      decisionId: context.decisionId,
      decisionVersion: context.expectedDecisionVersion,
      contextHash: context.expectedContextHash,
      answerEventId: projection.answer.eventId,
      sanitizedSummary: 'legacy apply claimed',
    }));

    const result = await applyDecision(context, { adapters: [adapter] });

    expect(result).toMatchObject({
      status: 'revalidation_required',
      reasonCode: 'apply_owner_unknown',
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it('never treats a persisted unknown process token as dead or replays its side effect', async () => {
    const projection = store.get(context.decisionId);
    if (projection?.answer === undefined) throw new Error('answer missing');
    appendDevloopLedgerEvent(store.ledgerPath, createDecisionApplyStartedEvent({
      decisionId: context.decisionId,
      decisionVersion: context.expectedDecisionVersion,
      contextHash: context.expectedContextHash,
      answerEventId: projection.answer.eventId,
      sanitizedSummary: 'apply owner could not read process start time',
      operationId: 'op_unknown_owner',
      ownerPid: process.pid,
      ownerStartToken: 'unknown_ps_unavailable',
    }));

    const result = await applyDecision(context, { adapters: [adapter] });

    expect(result).toMatchObject({
      status: 'revalidation_required',
      reasonCode: 'apply_owner_unknown',
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it('records a sanitized failure and does not retry the same answer', async () => {
    resume.mockRejectedValueOnce(new Error('token=secret internal path /private/repo'));

    const result = await applyDecision(context, { adapters: [adapter] });

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(store.get(context.decisionId)).toMatchObject({
      status: 'answered',
      applyResult: { status: 'failed' },
    });
    await applyDecision(context, { adapters: [adapter] });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('records an adapter-declared partial failure without retrying the side effect', async () => {
    resume.mockResolvedValueOnce({
      status: 'failed',
      errorCode: 'partial_external_failure',
      summary: 'The guarded operation did not complete.',
    });

    await expect(applyDecision(context, { adapters: [adapter] }))
      .resolves.toMatchObject({ status: 'failed', errorCode: 'partial_external_failure' });
    await expect(applyDecision(context, { adapters: [adapter] }))
      .resolves.toMatchObject({ status: 'failed', errorCode: 'partial_external_failure' });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('does not reflect a secret-like adapter code into the ledger', async () => {
    resume.mockResolvedValueOnce({
      status: 'failed',
      errorCode: 'token_secret_value',
      summary: 'operation failed',
    });

    const result = await applyDecision(context, { adapters: [adapter] });

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'resume_adapter_failed',
    });
    expect(JSON.stringify(readRawDevloopLedgerEvents(store.ledgerPath)))
      .not.toContain('token_secret_value');
  });

  it('fails closed when the resolved strategy has no registered adapter', async () => {
    const result = await applyDecision(context, { adapters: [] });

    expect(result).toMatchObject({
      status: 'revalidation_required',
      reasonCode: 'resume_strategy_unavailable',
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it('rejects a hostile adapter Proxy without invoking property traps or reflecting secrets', async () => {
    let getTrapCount = 0;
    let prototypeTrapCount = 0;
    const hostile = new Proxy({}, {
      get() {
        getTrapCount += 1;
        throw new Error('token=proxy-secret');
      },
      getPrototypeOf() {
        prototypeTrapCount += 1;
        throw new Error('token=prototype-secret');
      },
    }) as ResumeAdapter;

    const result = await applyDecision(context, { adapters: [hostile] });

    expect(result).toMatchObject({
      status: 'revalidation_required',
      reasonCode: 'resume_registry_invalid',
    });
    expect(getTrapCount).toBe(0);
    expect(prototypeTrapCount).toBe(0);
    expect(JSON.stringify(readRawDevloopLedgerEvents(store.ledgerPath))).not.toContain('secret');
  });
});
