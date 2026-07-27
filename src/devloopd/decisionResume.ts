import type { DecisionProjection } from './decisionEvents.js';
import {
  createDecisionAppliedEvent,
  createDecisionApplyFailedEvent,
  createDecisionApplyStartedEvent,
  createDecisionRevalidationRequiredEvent,
} from './decisionEvents.js';
import { inspectActiveRuns } from './activeRuns.js';
import { createDefaultDevloopCommandRunner, type DevloopCommandRunner } from './commandRunner.js';
import { DecisionStore } from './decisionStore.js';
import { withLockedDevloopLedgerTransaction } from './ledger.js';
import { runDevloopIssue } from './run.js';
import { resumeDirectRunBySlug } from '../features/tasks/resume/index.js';
import { findResumableDirectRunBySlug } from '../features/tasks/resume/directRunFinder.js';
import { continuePullRequestAutomationStage } from './prAutomation.js';

export type ResumeStrategy =
  | 'rerun_issue'
  | 'resume_direct_run'
  | 'continue_pr_stage'
  | 'replan'
  | 'manual_only';

export interface ResumeContext {
  readonly store: DecisionStore;
  readonly decisionId: string;
  readonly expectedDecisionVersion: number;
  readonly expectedContextHash: string;
}

export interface ResolvedResumeContext extends ResumeContext {
  readonly projection: DecisionProjection;
  readonly strategy: ResumeStrategy;
}

export type RevalidationResult =
  | { readonly valid: true }
  | {
    readonly valid: false;
    readonly reasonCode: string;
    readonly summary: string;
  };

export type ResumeResult =
  | { readonly status: 'resumed' | 'manual'; readonly summary: string }
  | {
    readonly status: 'revalidation_required';
    readonly reasonCode: string;
    readonly summary: string;
  }
  | {
    readonly status: 'failed';
    readonly errorCode: string;
    readonly summary: string;
  };

export interface ResumeAdapter {
  readonly strategy: ResumeStrategy;
  revalidate(context: ResolvedResumeContext): Promise<RevalidationResult>;
  resume(context: ResolvedResumeContext): Promise<ResumeResult>;
}

export type ApplyDecisionResult =
  | {
    readonly status: 'applying' | 'applied';
    readonly decisionId: string;
    readonly sanitizedSummary: string;
  }
  | {
    readonly status: 'failed';
    readonly decisionId: string;
    readonly errorCode: string;
    readonly sanitizedError: string;
  }
  | {
    readonly status: 'revalidation_required';
    readonly decisionId: string;
    readonly reasonCode: string;
    readonly sanitizedSummary: string;
  };

export interface ApplyDecisionOptions {
  readonly adapters?: readonly ResumeAdapter[];
}

type ClaimResult =
  | { readonly kind: 'claimed'; readonly context: ResolvedResumeContext; readonly adapter: ResumeAdapter }
  | { readonly kind: 'result'; readonly result: ApplyDecisionResult };

const FIXED_MESSAGES = Object.freeze({
  applyStarted: 'Decision application started after acquiring the local ledger guard.',
  applied: 'The answered decision was applied.',
  failed: 'The registered resume adapter could not complete safely.',
  staleVersion: 'The decision version changed before application.',
  staleContext: 'The decision context changed before application.',
  unavailable: 'No registered resume adapter is available for this decision.',
  notAnswered: 'Only an answered decision can be applied.',
});
const PUBLIC_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const SENSITIVE_CODE_FRAGMENT_PATTERN = /(authorization|cookie|key|password|secret|token)/u;

function publicCode(value: string, fallback: string): string {
  return PUBLIC_CODE_PATTERN.test(value) && !SENSITIVE_CODE_FRAGMENT_PATTERN.test(value)
    ? value
    : fallback;
}

function transitionIdentity(projection: DecisionProjection): {
  decisionId: string;
  decisionVersion: number;
  contextHash: string;
  answerEventId: string;
} {
  const answerEventId = projection.answer?.eventId;
  if (answerEventId === undefined) {
    throw new Error('decision answer unavailable');
  }
  return {
    decisionId: projection.request.decisionId,
    decisionVersion: projection.request.decisionVersion,
    contextHash: projection.request.contextHash,
    answerEventId,
  };
}

function resultFromProjection(projection: DecisionProjection): ApplyDecisionResult {
  const applyResult = projection.applyResult;
  if (projection.status === 'applied') {
    return {
      status: 'applied',
      decisionId: projection.request.decisionId,
      sanitizedSummary: applyResult?.status === 'applied'
        ? applyResult.sanitizedSummary
        : FIXED_MESSAGES.applied,
    };
  }
  if (projection.status === 'applying') {
    return {
      status: 'applying',
      decisionId: projection.request.decisionId,
      sanitizedSummary: applyResult?.status === 'applying'
        ? applyResult.sanitizedSummary
        : FIXED_MESSAGES.applyStarted,
    };
  }
  if (projection.status === 'revalidation_required') {
    return {
      status: 'revalidation_required',
      decisionId: projection.request.decisionId,
      reasonCode: applyResult?.status === 'revalidation_required'
        ? applyResult.reasonCode
        : 'revalidation_required',
      sanitizedSummary: applyResult?.status === 'revalidation_required'
        ? applyResult.sanitizedSummary
        : FIXED_MESSAGES.unavailable,
    };
  }
  if (applyResult?.status === 'failed') {
    return {
      status: 'failed',
      decisionId: projection.request.decisionId,
      errorCode: applyResult.errorCode,
      sanitizedError: applyResult.sanitizedError,
    };
  }
  return {
    status: 'failed',
    decisionId: projection.request.decisionId,
    errorCode: 'decision_not_answered',
    sanitizedError: FIXED_MESSAGES.notAnswered,
  };
}

function strategyFor(projection: DecisionProjection): ResumeStrategy {
  const answer = projection.answer?.value;
  const optionId = answer !== undefined && 'optionId' in answer ? answer.optionId : undefined;
  switch (projection.request.resumeGuard.strategy) {
    case 'direct_run':
      return optionId === 'no' ? 'manual_only' : 'resume_direct_run';
    case 'pr_automation_stage':
      return optionId === 'approve_current_head' ? 'continue_pr_stage' : 'manual_only';
    case 'issue_scout_candidate':
      // Scout candidates are not GitHub issues yet. Both approval and revision
      // must return through the planner; treating a candidate ID as a command or
      // issue number would cross the typed resume boundary.
      return optionId === 'skip' ? 'manual_only' : 'replan';
  }
}

function appendRevalidation(
  context: ResumeContext,
  reasonCode: string,
  summary: string,
  expectedStatus: 'answered' | 'applying',
): ApplyDecisionResult {
  const safeReasonCode = publicCode(reasonCode, 'resume_revalidation_failed');
  return withLockedDevloopLedgerTransaction(context.store.ledgerPath, (transaction) => {
    const current = context.store.get(context.decisionId);
    if (current === undefined) {
      return {
        status: 'failed',
        decisionId: context.decisionId,
        errorCode: 'decision_not_found',
        sanitizedError: FIXED_MESSAGES.notAnswered,
      };
    }
    if (current.status !== expectedStatus) return resultFromProjection(current);
    const event = createDecisionRevalidationRequiredEvent({
      ...transitionIdentity(current),
      reasonCode: safeReasonCode,
      sanitizedSummary: summary,
    });
    transaction.append(event);
    return {
      status: 'revalidation_required',
      decisionId: current.request.decisionId,
      reasonCode: event.reasonCode,
      sanitizedSummary: event.sanitizedSummary,
    };
  });
}

function claimApplication(
  context: ResumeContext,
  adapters: ReadonlyMap<ResumeStrategy, ResumeAdapter>,
): ClaimResult {
  return withLockedDevloopLedgerTransaction(context.store.ledgerPath, (transaction) => {
    const projection = context.store.get(context.decisionId);
    if (projection === undefined) {
      return {
        kind: 'result',
        result: {
          status: 'failed',
          decisionId: context.decisionId,
          errorCode: 'decision_not_found',
          sanitizedError: FIXED_MESSAGES.notAnswered,
        },
      };
    }
    if (projection.status !== 'answered') {
      return { kind: 'result', result: resultFromProjection(projection) };
    }
    if (projection.applyResult?.status === 'failed') {
      // An adapter may have failed after a partial external side effect. Never
      // retry automatically from the same answer; a new explicit decision is
      // required to establish a fresh idempotency and revalidation boundary.
      return { kind: 'result', result: resultFromProjection(projection) };
    }
    if (projection.request.decisionVersion !== context.expectedDecisionVersion) {
      const event = createDecisionRevalidationRequiredEvent({
        ...transitionIdentity(projection),
        reasonCode: 'decision_version_changed',
        sanitizedSummary: FIXED_MESSAGES.staleVersion,
      });
      transaction.append(event);
      return {
        kind: 'result',
        result: {
          status: 'revalidation_required',
          decisionId: projection.request.decisionId,
          reasonCode: event.reasonCode,
          sanitizedSummary: event.sanitizedSummary,
        },
      };
    }
    if (projection.request.contextHash !== context.expectedContextHash) {
      const event = createDecisionRevalidationRequiredEvent({
        ...transitionIdentity(projection),
        reasonCode: 'decision_context_changed',
        sanitizedSummary: FIXED_MESSAGES.staleContext,
      });
      transaction.append(event);
      return {
        kind: 'result',
        result: {
          status: 'revalidation_required',
          decisionId: projection.request.decisionId,
          reasonCode: event.reasonCode,
          sanitizedSummary: event.sanitizedSummary,
        },
      };
    }

    const strategy = strategyFor(projection);
    const adapter = adapters.get(strategy);
    if (adapter === undefined) {
      const event = createDecisionRevalidationRequiredEvent({
        ...transitionIdentity(projection),
        reasonCode: 'resume_strategy_unavailable',
        sanitizedSummary: FIXED_MESSAGES.unavailable,
      });
      transaction.append(event);
      return {
        kind: 'result',
        result: {
          status: 'revalidation_required',
          decisionId: projection.request.decisionId,
          reasonCode: event.reasonCode,
          sanitizedSummary: event.sanitizedSummary,
        },
      };
    }

    // The claim is persisted before any external check or side effect. A second
    // process therefore observes "applying" and cannot execute the adapter.
    transaction.append(createDecisionApplyStartedEvent({
      ...transitionIdentity(projection),
      sanitizedSummary: FIXED_MESSAGES.applyStarted,
    }));
    return {
      kind: 'claimed',
      adapter,
      context: Object.freeze({ ...context, projection, strategy }),
    };
  });
}

function appendApplied(context: ResolvedResumeContext, summary: string): ApplyDecisionResult {
  return withLockedDevloopLedgerTransaction(context.store.ledgerPath, (transaction) => {
    const current = context.store.get(context.decisionId);
    if (current === undefined || current.status !== 'applying') {
      return current === undefined
        ? {
          status: 'failed',
          decisionId: context.decisionId,
          errorCode: 'decision_not_found',
          sanitizedError: FIXED_MESSAGES.failed,
        }
        : resultFromProjection(current);
    }
    const event = createDecisionAppliedEvent({
      ...transitionIdentity(current),
      sanitizedSummary: summary,
    });
    transaction.append(event);
    return {
      status: 'applied',
      decisionId: current.request.decisionId,
      sanitizedSummary: event.sanitizedSummary,
    };
  });
}

function appendFailed(
  context: ResolvedResumeContext,
  errorCode: string,
  summary: string,
): ApplyDecisionResult {
  const safeErrorCode = publicCode(errorCode, 'resume_adapter_failed');
  return withLockedDevloopLedgerTransaction(context.store.ledgerPath, (transaction) => {
    const current = context.store.get(context.decisionId);
    if (current === undefined || current.status !== 'applying') {
      return current === undefined
        ? {
          status: 'failed',
          decisionId: context.decisionId,
          errorCode: 'decision_not_found',
          sanitizedError: FIXED_MESSAGES.failed,
        }
        : resultFromProjection(current);
    }
    const event = createDecisionApplyFailedEvent({
      ...transitionIdentity(current),
      errorCode: safeErrorCode,
      sanitizedError: summary,
    });
    transaction.append(event);
    return {
      status: 'failed',
      decisionId: current.request.decisionId,
      errorCode: event.errorCode,
      sanitizedError: event.sanitizedError,
    };
  });
}

function adaptersByStrategy(adapters: readonly ResumeAdapter[]): ReadonlyMap<ResumeStrategy, ResumeAdapter> {
  const registry = new Map<ResumeStrategy, ResumeAdapter>();
  for (const adapter of adapters) {
    if (registry.has(adapter.strategy)) {
      throw new Error(`Duplicate resume adapter: ${adapter.strategy}`);
    }
    registry.set(adapter.strategy, adapter);
  }
  return registry;
}

export async function applyDecision(
  context: ResumeContext,
  options: ApplyDecisionOptions = {},
): Promise<ApplyDecisionResult> {
  const adapters = options.adapters ?? createDefaultResumeAdapters();
  const claim = claimApplication(context, adaptersByStrategy(adapters));
  if (claim.kind === 'result') return claim.result;

  try {
    const revalidation = await claim.adapter.revalidate(claim.context);
    if (!revalidation.valid) {
      return appendRevalidation(
        claim.context,
        revalidation.reasonCode,
        revalidation.summary,
        'applying',
      );
    }

    const resumed = await claim.adapter.resume(claim.context);
    if (resumed.status === 'revalidation_required') {
      return appendRevalidation(
        claim.context,
        resumed.reasonCode,
        resumed.summary,
        'applying',
      );
    }
    if (resumed.status === 'failed') {
      return appendFailed(claim.context, resumed.errorCode, resumed.summary);
    }
    return appendApplied(claim.context, resumed.summary);
  } catch {
    // Never inspect hostile Proxy/Error properties. Public failures stay fixed,
    // while the answer returns to "answered" and automatic retry remains denied.
    return appendFailed(claim.context, 'resume_adapter_failed', FIXED_MESSAGES.failed);
  }
}

function fixedValid(): Promise<RevalidationResult> {
  return Promise.resolve({ valid: true });
}

function fixedManual(): Promise<ResumeResult> {
  return Promise.resolve({
    status: 'manual',
    summary: 'The answer was recorded; this strategy does not resume work automatically.',
  });
}

function defaultRunner(): DevloopCommandRunner {
  return createDefaultDevloopCommandRunner();
}

async function inspectCleanWorktree(
  repoPath: string,
  runner: DevloopCommandRunner,
): Promise<RevalidationResult> {
  const git = runner.resolveCommand('git', process.env);
  if (git === undefined) {
    return {
      valid: false,
      reasonCode: 'git_unavailable',
      summary: 'Git state could not be revalidated.',
    };
  }
  const result = await runner.exec(git, ['status', '--porcelain'], {
    cwd: repoPath,
    env: process.env,
  });
  if (result.exitCode !== 0 || result.stdout.trim() !== '') {
    return {
      valid: false,
      reasonCode: result.exitCode === 0 ? 'worktree_dirty' : 'git_state_unavailable',
      summary: result.exitCode === 0
        ? 'The worktree changed after the decision was requested.'
        : 'Git state could not be revalidated.',
    };
  }
  return { valid: true };
}

export function createDefaultResumeAdapters(
  runner: DevloopCommandRunner = defaultRunner(),
): readonly ResumeAdapter[] {
  return Object.freeze([
    {
      strategy: 'rerun_issue',
      async revalidate(context) {
        if (context.projection.request.subject.issueNumber === undefined) {
          return {
            valid: false,
            reasonCode: 'issue_target_missing',
            summary: 'The decision does not contain a typed issue target.',
          };
        }
        return inspectCleanWorktree(context.store.repoPath, runner);
      },
      async resume(context) {
        // Re-check immediately before starting the issue pipeline. This narrows
        // the gap between the earlier guard and the external process spawn.
        const clean = await inspectCleanWorktree(context.store.repoPath, runner);
        if (!clean.valid) return { status: 'revalidation_required', ...clean };
        const issue = context.projection.request.subject.issueNumber;
        if (issue === undefined) {
          return {
            status: 'revalidation_required',
            reasonCode: 'issue_target_missing',
            summary: 'The decision does not contain a typed issue target.',
          };
        }
        const report = await runDevloopIssue({
          repoPath: context.store.repoPath,
          issue,
          repo: context.projection.request.subject.repository,
          runner,
        });
        return report.passed
          ? { status: 'resumed', summary: 'The guarded issue pipeline completed.' }
          : {
            status: 'failed',
            errorCode: 'issue_pipeline_failed',
            summary: 'The guarded issue pipeline did not complete.',
          };
      },
    },
    {
      strategy: 'resume_direct_run',
      async revalidate(context) {
        const guard = context.projection.request.resumeGuard;
        if (guard.strategy !== 'direct_run') {
          return {
            valid: false,
            reasonCode: 'resume_guard_mismatch',
            summary: 'The decision guard does not describe a direct run.',
          };
        }
        const run = findResumableDirectRunBySlug(context.store.repoPath, guard.runSlug);
        if (
          run === null
          || run.meta.status !== guard.expectedRunStatus
          || run.meta.abortKind !== guard.expectedAbortKind
          || run.meta.blockedStep !== guard.expectedBlockedStep
        ) {
          return {
            valid: false,
            reasonCode: 'run_status_changed',
            summary: 'The guarded run is no longer at the expected blocked state.',
          };
        }
        const active = inspectActiveRuns({ repoPath: context.store.repoPath });
        if (!active.passed || active.activeRuns.length > 0) {
          return {
            valid: false,
            reasonCode: 'active_run_changed',
            summary: 'Another run is active or the active-run state is unavailable.',
          };
        }
        return inspectCleanWorktree(context.store.repoPath, runner);
      },
      async resume(context) {
        const guard = context.projection.request.resumeGuard;
        if (guard.strategy !== 'direct_run') {
          return {
            status: 'revalidation_required',
            reasonCode: 'resume_guard_mismatch',
            summary: 'The decision guard does not describe a direct run.',
          };
        }
        const active = inspectActiveRuns({ repoPath: context.store.repoPath });
        if (!active.passed || active.activeRuns.length > 0) {
          return {
            status: 'revalidation_required',
            reasonCode: 'active_run_changed',
            summary: 'Another run is active or the active-run state is unavailable.',
          };
        }
        const clean = await inspectCleanWorktree(context.store.repoPath, runner);
        if (!clean.valid) return { status: 'revalidation_required', ...clean };
        const resumed = await resumeDirectRunBySlug(
          context.store.repoPath,
          guard.runSlug,
          {
            expectedStatus: guard.expectedRunStatus,
            expectedAbortKind: guard.expectedAbortKind,
            expectedBlockedStep: guard.expectedBlockedStep,
            decisionAnswer: context.projection.answer,
          },
        );
        if (resumed.status === 'revalidation_required') {
          return {
            status: 'revalidation_required',
            reasonCode: 'run_status_changed',
            summary: 'The guarded run changed immediately before resume.',
          };
        }
        return resumed.status === 'resumed'
          ? { status: 'resumed', summary: 'The guarded direct run completed.' }
          : {
            status: 'failed',
            errorCode: 'direct_run_failed',
            summary: 'The guarded direct run did not complete.',
          };
      },
    },
    {
      strategy: 'continue_pr_stage',
      async revalidate(context) {
        const guard = context.projection.request.resumeGuard;
        return guard.strategy === 'pr_automation_stage'
          ? { valid: true }
          : {
            valid: false,
            reasonCode: 'resume_guard_mismatch',
            summary: 'The decision guard does not describe a PR automation stage.',
          };
      },
      async resume(context) {
        const guard = context.projection.request.resumeGuard;
        if (guard.strategy !== 'pr_automation_stage') {
          return {
            status: 'revalidation_required',
            reasonCode: 'resume_guard_mismatch',
            summary: 'The decision guard does not describe a PR automation stage.',
          };
        }
        const report = await continuePullRequestAutomationStage({
          repoPath: context.store.repoPath,
          repo: guard.repository,
          pr: guard.prNumber,
          stage: guard.stage,
          expectedHeadSha: guard.expectedHeadSha,
          runner,
        });
        if (report.revalidationRequired) {
          return {
            status: 'revalidation_required',
            reasonCode: report.reasonCode ?? 'pr_state_changed',
            summary: report.message,
          };
        }
        return report.passed
          ? { status: 'resumed', summary: 'The guarded PR stage completed.' }
          : {
            status: 'failed',
            errorCode: 'pr_stage_failed',
            summary: 'The guarded PR stage did not complete.',
          };
      },
    },
    {
      strategy: 'replan',
      async revalidate(context) {
        return inspectCleanWorktree(context.store.repoPath, runner);
      },
      async resume(context) {
        const clean = await inspectCleanWorktree(context.store.repoPath, runner);
        if (!clean.valid) return { status: 'revalidation_required', ...clean };
        // Issue Scout consumes only applied typed projections on its next pass:
        // approve_scope re-enters candidate planning, while revise_scope remains
        // stopped for a new candidate. Marking this hand-off applied is the
        // registered replan operation; no prompt or arbitrary command is run.
        return {
          status: 'resumed',
          summary: 'The typed answer is ready for the next guarded planning pass.',
        };
      },
    },
    {
      strategy: 'manual_only',
      revalidate: fixedValid,
      resume: fixedManual,
    },
  ]);
}
