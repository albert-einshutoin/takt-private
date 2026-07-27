import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDecision,
  type ResumeAdapter,
  type ResumeContext,
} from '../devloopd/decisionResume.js';
import { createDecisionRequest } from '../devloopd/decisionRequest.js';
import { DecisionStore } from '../devloopd/decisionStore.js';
import { readRawDevloopLedgerEvents } from '../devloopd/ledger.js';

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
});
