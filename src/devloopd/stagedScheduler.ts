import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  runDevloopAutomationStage,
  type DevloopAutomationStage,
  type DevloopAutomationStageReport,
  type RunDevloopAutomationStageOptions,
} from './prAutomation.js';
import {
  evaluateAutomationSafety,
  type AutomationSafetyBudgets,
  type AutomationSafetyReport,
  type AutomationSafetyState,
} from './automationSafety.js';
import { readRawDevloopLedgerEvents, resolveDevloopLedgerPath } from './ledger.js';
import { writeFileAtomic } from './stateStore.js';

export { type DevloopAutomationStage } from './prAutomation.js';

export const DEVLOOP_AUTOMATION_STAGES = [
  'issue-scout',
  'issue-to-pr',
  'pr-review',
  'review-fix',
  'pr-merge',
] as const satisfies readonly DevloopAutomationStage[];

export type StagedDevloopMode = 'once' | 'loop';
export type StagedDevloopSafetyProfile = 'smoke' | 'safe-default' | 'daemon';

export interface StagedDevloopState {
  version: 1;
  lastRunAt: Partial<Record<DevloopAutomationStage, string>>;
  safety?: StagedDevloopSafetyState;
}

export interface StagedDevloopSafetyState {
  startedAt: string;
  runs: number;
  pullRequests: number;
  retries: number;
  costProxy: number;
  changedFiles: number;
  changedLines: number;
  consecutiveNoopSignals: number;
  classifierDisagreements: number;
  ciFlakes: number;
  reviewFixFailures: number;
  productPolicyEscalations: number;
}

export interface StagedDevloopStageReport {
  stage: DevloopAutomationStage;
  status: 'ran' | 'skipped' | 'failed';
  due: boolean;
  reason: string;
  lastRunAt?: string;
  nextRunAt?: string;
  retryAfter?: string;
  report?: DevloopAutomationStageReport;
}

export interface StagedDevloopReport {
  passed: boolean;
  mode: StagedDevloopMode;
  message: string;
  statePath: string;
  stageReports: StagedDevloopStageReport[];
  cycles?: StagedDevloopReport[];
  stateWarning?: string;
  safetyReport?: AutomationSafetyReport;
  safetyProfile?: StagedDevloopSafetyProfile;
  safetyBudgets?: AutomationSafetyBudgets;
}

export interface StagedDevloopDependencies {
  runStage(options: RunDevloopAutomationStageOptions): Promise<DevloopAutomationStageReport>;
}

export type StagedDevloopSleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface RunStagedDevloopOptions {
  repoPath?: string;
  repo?: string;
  workflow?: string;
  policyPath?: string;
  ledgerPath?: string;
  skipAuth?: boolean;
  autoPr?: boolean;
  quiet?: boolean;
  dryRun?: boolean;
  mode?: StagedDevloopMode;
  stage?: DevloopAutomationStage;
  maxCycles?: number;
  tickSeconds?: number;
  intervals?: Partial<Record<DevloopAutomationStage, number>>;
  safetyProfile?: StagedDevloopSafetyProfile;
  safetyBudgets?: AutomationSafetyBudgets;
  statePath?: string;
  now?: () => Date;
  sleep?: StagedDevloopSleep;
  abortSignal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  dependencies?: Partial<StagedDevloopDependencies>;
}

const DEFAULT_INTERVAL_SECONDS: Record<DevloopAutomationStage, number> = {
  'issue-scout': 3600,
  'issue-to-pr': 600,
  'pr-review': 900,
  'review-fix': 1800,
  'pr-merge': 600,
};

const INTERVAL_ENV_KEYS: Record<DevloopAutomationStage, string> = {
  'issue-scout': 'TAKT_LOOP_ISSUE_SCOUT_INTERVAL',
  'issue-to-pr': 'TAKT_LOOP_ISSUE_TO_PR_INTERVAL',
  'pr-review': 'TAKT_LOOP_PR_REVIEW_INTERVAL',
  'review-fix': 'TAKT_LOOP_REVIEW_FIX_INTERVAL',
  'pr-merge': 'TAKT_LOOP_PR_MERGE_INTERVAL',
};

const DEFAULT_SAFETY_BUDGETS: AutomationSafetyBudgets = {
  maxConsecutiveNoopSignals: 3,
  maxClassifierDisagreements: 3,
  maxCiFlakes: 5,
  maxReviewFixFailures: 3,
  maxProductPolicyEscalations: 5,
};

const SAFETY_PROFILE_ENV_KEY = 'TAKT_LOOP_SAFETY_PROFILE';

const SAFETY_PROFILE_BUDGETS: Record<StagedDevloopSafetyProfile, AutomationSafetyBudgets> = {
  smoke: {
    ...DEFAULT_SAFETY_BUDGETS,
    maxRuns: 5,
    maxDurationSeconds: 5 * 60,
    maxPullRequests: 3,
    maxRetries: 5,
  },
  'safe-default': {
    ...DEFAULT_SAFETY_BUDGETS,
    maxRuns: 100,
    maxDurationSeconds: 8 * 60 * 60,
    maxPullRequests: 25,
    maxRetries: 50,
  },
  daemon: {
    ...DEFAULT_SAFETY_BUDGETS,
  },
};

const SAFETY_BUDGET_ENV_KEYS: Record<keyof AutomationSafetyBudgets, string> = {
  maxRuns: 'TAKT_LOOP_MAX_RUNS',
  maxPullRequests: 'TAKT_LOOP_MAX_PULL_REQUESTS',
  maxRetries: 'TAKT_LOOP_MAX_RETRIES',
  maxCostProxy: 'TAKT_LOOP_MAX_COST_PROXY',
  maxDurationSeconds: 'TAKT_LOOP_MAX_DURATION_SECONDS',
  maxChangedFiles: 'TAKT_LOOP_MAX_CHANGED_FILES',
  maxChangedLines: 'TAKT_LOOP_MAX_CHANGED_LINES',
  maxConsecutiveNoopSignals: 'TAKT_LOOP_MAX_CONSECUTIVE_NOOP_SIGNALS',
  maxClassifierDisagreements: 'TAKT_LOOP_MAX_CLASSIFIER_DISAGREEMENTS',
  maxCiFlakes: 'TAKT_LOOP_MAX_CI_FLAKES',
  maxReviewFixFailures: 'TAKT_LOOP_MAX_REVIEW_FIX_FAILURES',
  maxProductPolicyEscalations: 'TAKT_LOOP_MAX_PRODUCT_POLICY_ESCALATIONS',
};

const DEFAULT_DEPENDENCIES: StagedDevloopDependencies = {
  runStage: runDevloopAutomationStage,
};

function resolveDependencies(dependencies: Partial<StagedDevloopDependencies> | undefined): StagedDevloopDependencies {
  return {
    ...DEFAULT_DEPENDENCIES,
    ...dependencies,
  };
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function resolveIntervals(
  env: NodeJS.ProcessEnv,
  explicit: Partial<Record<DevloopAutomationStage, number>> | undefined,
): Record<DevloopAutomationStage, number> {
  const intervals = { ...DEFAULT_INTERVAL_SECONDS };
  for (const stage of DEVLOOP_AUTOMATION_STAGES) {
    const envValue = parsePositiveNumber(env[INTERVAL_ENV_KEYS[stage]]);
    const explicitValue = explicit?.[stage];
    if (explicitValue !== undefined && Number.isFinite(explicitValue) && explicitValue >= 0) {
      intervals[stage] = explicitValue;
    } else if (envValue !== undefined) {
      intervals[stage] = envValue;
    }
  }
  return intervals;
}

function isSafetyProfile(value: string | undefined): value is StagedDevloopSafetyProfile {
  return value === 'smoke' || value === 'safe-default' || value === 'daemon';
}

function resolveSafetyProfile(
  env: NodeJS.ProcessEnv,
  explicit: StagedDevloopSafetyProfile | undefined,
): { profile: StagedDevloopSafetyProfile } | { error: string } {
  if (explicit !== undefined) {
    return { profile: explicit };
  }
  const envProfile = env[SAFETY_PROFILE_ENV_KEY];
  if (envProfile === undefined || envProfile.trim() === '') {
    return { profile: 'safe-default' };
  }
  if (isSafetyProfile(envProfile)) {
    return { profile: envProfile };
  }
  return { error: `invalid ${SAFETY_PROFILE_ENV_KEY}: ${envProfile}` };
}

function resolveSafetyBudgets(
  env: NodeJS.ProcessEnv,
  explicit: AutomationSafetyBudgets | undefined,
  profile: StagedDevloopSafetyProfile,
): AutomationSafetyBudgets {
  const budgets: AutomationSafetyBudgets = { ...SAFETY_PROFILE_BUDGETS[profile] };
  for (const [key, envKey] of Object.entries(SAFETY_BUDGET_ENV_KEYS) as Array<[keyof AutomationSafetyBudgets, string]>) {
    const envValue = parsePositiveNumber(env[envKey]);
    const explicitValue = explicit?.[key];
    if (explicitValue !== undefined && Number.isFinite(explicitValue) && explicitValue >= 0) {
      budgets[key] = explicitValue;
    } else if (envValue !== undefined) {
      budgets[key] = envValue;
    }
  }
  return budgets;
}

function defaultStatePath(repoPath: string): string {
  return resolve(repoPath, '.takt/staged-devloop-state.json');
}

function emptyState(): StagedDevloopState {
  return {
    version: 1,
    lastRunAt: {},
  };
}

function normalizeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeSafetyState(value: unknown, now: Date): StagedDevloopSafetyState {
  const candidate = typeof value === 'object' && value !== null ? value as Partial<StagedDevloopSafetyState> : {};
  const startedAt = typeof candidate.startedAt === 'string' && !Number.isNaN(Date.parse(candidate.startedAt))
    ? candidate.startedAt
    : now.toISOString();
  return {
    startedAt,
    runs: normalizeNumber(candidate.runs),
    pullRequests: normalizeNumber(candidate.pullRequests),
    retries: normalizeNumber(candidate.retries),
    costProxy: normalizeNumber(candidate.costProxy),
    changedFiles: normalizeNumber(candidate.changedFiles),
    changedLines: normalizeNumber(candidate.changedLines),
    consecutiveNoopSignals: normalizeNumber(candidate.consecutiveNoopSignals),
    classifierDisagreements: normalizeNumber(candidate.classifierDisagreements),
    ciFlakes: normalizeNumber(candidate.ciFlakes),
    reviewFixFailures: normalizeNumber(candidate.reviewFixFailures),
    productPolicyEscalations: normalizeNumber(candidate.productPolicyEscalations),
  };
}

function readState(statePath: string, now: Date = new Date()): { state: StagedDevloopState; warning?: string } {
  if (!existsSync(statePath)) {
    return { state: emptyState() };
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as Partial<StagedDevloopState>;
    if (parsed.version !== 1 || parsed.lastRunAt === undefined || typeof parsed.lastRunAt !== 'object') {
      return { state: emptyState(), warning: `malformed staged devloop state: ${statePath}` };
    }
    return {
      state: {
        version: 1,
        lastRunAt: parsed.lastRunAt,
        ...(parsed.safety !== undefined ? { safety: normalizeSafetyState(parsed.safety, now) } : {}),
      },
    };
  } catch {
    return { state: emptyState(), warning: `malformed staged devloop state: ${statePath}` };
  }
}

function writeState(statePath: string, state: StagedDevloopState): void {
  // The scheduler uses JSON instead of shell-sourced env so a crashed loop can
  // resume deterministically without executing untrusted state file content.
  writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function parseTimestamp(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function nextRunAt(lastRunAt: Date | undefined, intervalSeconds: number): Date | undefined {
  if (lastRunAt === undefined) {
    return undefined;
  }
  return new Date(lastRunAt.getTime() + intervalSeconds * 1000);
}

function isDue(lastRunAt: Date | undefined, intervalSeconds: number, now: Date): boolean {
  if (lastRunAt === undefined) {
    return true;
  }
  return now.getTime() - lastRunAt.getTime() >= intervalSeconds * 1000;
}

interface ActiveRetryAfter {
  retryAfter: string;
  eventType: string;
  reason: string;
}

function parseFutureTimestamp(value: unknown, now: Date): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}

function activeRetryAfterForStage(input: {
  stage: DevloopAutomationStage;
  repoPath: string;
  ledgerPath?: string;
  now: Date;
}): ActiveRetryAfter | undefined {
  const ledgerPath = resolveDevloopLedgerPath(input.repoPath, input.ledgerPath);
  const events = readRawDevloopLedgerEvents(ledgerPath).slice().reverse();
  for (const event of events) {
    if (input.stage === 'issue-scout' && event.eventType === 'devloop_issue_scout') {
      const retryAfter = parseFutureTimestamp(event.retryAfter, input.now);
      if (retryAfter !== undefined) {
        return {
          retryAfter,
          eventType: event.eventType,
          reason: 'issue-scout ledger retryAfter is active',
        };
      }
    }
    if (input.stage === 'pr-merge' && event.eventType === 'devloop_ci_retry' && event.prNumber === undefined) {
      const retryAfter = parseFutureTimestamp(event.retryAfter, input.now);
      if (retryAfter !== undefined) {
        return {
          retryAfter,
          eventType: event.eventType,
          reason: 'unscoped CI retryAfter is active',
        };
      }
    }
  }
  return undefined;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted === true) {
    return Promise.resolve();
  }
  return new Promise((resolveSleep) => {
    const timeout = setTimeout(resolveSleep, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      resolveSleep();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function validateMaxCycles(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function toAutomationSafetyState(safety: StagedDevloopSafetyState, now: Date): AutomationSafetyState {
  return {
    ...safety,
    now: now.toISOString(),
  };
}

function isNoopStageReport(report: DevloopAutomationStageReport): boolean {
  return report.actions.length === 0
    || report.actions.every((action) => action.status === 'skipped'
      && (action.stopRule === 'Duplicate or already covered' || /no actions|no eligible|not passing yet/iu.test(action.message)));
}

function updateSafetyAfterStage(
  safety: StagedDevloopSafetyState,
  report: DevloopAutomationStageReport,
): StagedDevloopSafetyState {
  const prNumbers = new Set(report.actions.flatMap((action) => action.pr === undefined ? [] : [action.pr]));
  const reviewFixFailures = report.actions.filter((action) => action.type === 'review-fix' && (action.status === 'failed' || action.status === 'blocked')).length;
  const ciFlakes = report.actions.filter((action) => action.type === 'ci-fix' && /flaky|infra|retry/iu.test(action.message)).length;
  const productPolicyEscalations = report.actions.filter((action) => action.productPolicyImpact?.requiresHumanReview === true
    || action.stopRule === 'Unsafe or too broad').length;

  return {
    ...safety,
    runs: safety.runs + 1,
    pullRequests: safety.pullRequests + prNumbers.size,
    retries: safety.retries + report.actions.filter((action) => action.type === 'review-fix' || action.type === 'ci-fix').length,
    ciFlakes: safety.ciFlakes + ciFlakes,
    reviewFixFailures: safety.reviewFixFailures + reviewFixFailures,
    productPolicyEscalations: safety.productPolicyEscalations + productPolicyEscalations,
  };
}

function updateCycleNoopSignal(
  safety: StagedDevloopSafetyState,
  stageReports: readonly StagedDevloopStageReport[],
): StagedDevloopSafetyState {
  const ranReports = stageReports.flatMap((stageReport) => stageReport.report === undefined ? [] : [stageReport.report]);
  if (ranReports.length === 0) {
    return safety;
  }
  return {
    ...safety,
    // Completion is a property of a whole scheduler cycle. Counting every
    // no-op stage would stop a healthy five-stage cycle before the next tick.
    consecutiveNoopSignals: ranReports.every(isNoopStageReport) ? safety.consecutiveNoopSignals + 1 : 0,
  };
}

async function runStagedDevloopCycle(options: RunStagedDevloopOptions): Promise<StagedDevloopReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const mode = options.mode ?? 'once';
  const statePath = resolve(options.statePath ?? env.TAKT_LOOP_STAGE_STATE ?? defaultStatePath(repoPath));
  const intervals = resolveIntervals(env, options.intervals);
  const profile = resolveSafetyProfile(env, options.safetyProfile);
  if ('error' in profile) {
    return {
      passed: false,
      mode,
      message: profile.error,
      statePath,
      stageReports: [],
    };
  }
  const safetyBudgets = resolveSafetyBudgets(env, options.safetyBudgets, profile.profile);
  const dependencies = resolveDependencies(options.dependencies);
  const now = options.now?.() ?? new Date();
  const { state, warning } = readState(statePath, now);
  let safety = normalizeSafetyState(state.safety, now);
  const initialSafetyReport = evaluateAutomationSafety({
    budgets: safetyBudgets,
    state: toAutomationSafetyState(safety, now),
  });
  if (!initialSafetyReport.allowed) {
    state.safety = safety;
    writeState(statePath, state);
    return {
      passed: false,
      mode,
      message: `automation safety stopped: ${initialSafetyReport.reasons.join('; ')}`,
      statePath,
      stageReports: [],
      safetyReport: initialSafetyReport,
      safetyProfile: profile.profile,
      safetyBudgets,
      ...(warning !== undefined ? { stateWarning: warning } : {}),
    };
  }
  const targetStages = options.stage === undefined ? DEVLOOP_AUTOMATION_STAGES : [options.stage];
  const stageReports: StagedDevloopStageReport[] = [];

  for (const stage of targetStages) {
    const lastRun = parseTimestamp(state.lastRunAt[stage]);
    const stageNextRunAt = nextRunAt(lastRun, intervals[stage]);
    const activeRetryAfter = activeRetryAfterForStage({
      stage,
      repoPath,
      ledgerPath: options.ledgerPath,
      now,
    });
    const due = options.stage !== undefined || isDue(lastRun, intervals[stage], now);
    if (activeRetryAfter !== undefined && options.stage === undefined) {
      stageReports.push({
        stage,
        status: 'skipped',
        due: false,
        reason: `${activeRetryAfter.reason} until ${activeRetryAfter.retryAfter}`,
        retryAfter: activeRetryAfter.retryAfter,
        ...(lastRun !== undefined ? { lastRunAt: lastRun.toISOString() } : {}),
        nextRunAt: activeRetryAfter.retryAfter,
      });
      continue;
    }
    if (!due) {
      stageReports.push({
        stage,
        status: 'skipped',
        due: false,
        reason: `not due until ${stageNextRunAt?.toISOString() ?? 'unknown'}`,
        ...(lastRun !== undefined ? { lastRunAt: lastRun.toISOString() } : {}),
        ...(stageNextRunAt !== undefined ? { nextRunAt: stageNextRunAt.toISOString() } : {}),
      });
      continue;
    }

    const stageReport = await dependencies.runStage({
      stage,
      repoPath,
      repo: options.repo,
      workflow: options.workflow,
      policyPath: options.policyPath,
      ledgerPath: options.ledgerPath,
      skipAuth: options.skipAuth,
      autoPr: options.autoPr,
      quiet: options.quiet,
      dryRun: options.dryRun,
      env,
    });
    safety = updateSafetyAfterStage(safety, stageReport);
    state.lastRunAt[stage] = now.toISOString();
    state.safety = safety;
    stageReports.push({
      stage,
      status: stageReport.passed ? 'ran' : 'failed',
      due: true,
      reason: stageReport.message,
      ...(lastRun !== undefined ? { lastRunAt: lastRun.toISOString() } : {}),
      report: stageReport,
    });
  }

  safety = updateCycleNoopSignal(safety, stageReports);
  state.safety = safety;
  writeState(statePath, state);
  const safetyReport = evaluateAutomationSafety({
    budgets: safetyBudgets,
    state: toAutomationSafetyState(safety, now),
  });
  const passed = stageReports.every((stageReport) => stageReport.status !== 'failed');
  return {
    passed: passed && safetyReport.allowed,
    mode,
    message: safetyReport.allowed
      ? `${stageReports.filter((stageReport) => stageReport.status === 'ran').length} staged devloop stage(s) ran`
      : `automation safety stopped: ${safetyReport.reasons.join('; ')}`,
    statePath,
    stageReports,
    safetyReport,
    safetyProfile: profile.profile,
    safetyBudgets,
    ...(warning !== undefined ? { stateWarning: warning } : {}),
  };
}

export async function runStagedDevloop(options: RunStagedDevloopOptions = {}): Promise<StagedDevloopReport> {
  const mode = options.mode ?? 'once';
  if (options.stage !== undefined || mode === 'once') {
    return runStagedDevloopCycle({ ...options, mode: 'once' });
  }

  const maxCycles = validateMaxCycles(options.maxCycles);
  if (options.maxCycles !== undefined && maxCycles === undefined) {
    return {
      passed: false,
      mode,
      message: `maxCycles must be a positive integer: ${String(options.maxCycles)}`,
      statePath: resolve(options.statePath ?? defaultStatePath(resolve(options.repoPath ?? process.cwd()))),
      stageReports: [],
    };
  }

  const tickSeconds = options.tickSeconds ?? parsePositiveNumber((options.env ?? process.env).TAKT_LOOP_TICK_SECONDS) ?? 60;
  if (!Number.isFinite(tickSeconds) || tickSeconds < 0) {
    return {
      passed: false,
      mode,
      message: `tickSeconds must be a non-negative number: ${String(tickSeconds)}`,
      statePath: resolve(options.statePath ?? defaultStatePath(resolve(options.repoPath ?? process.cwd()))),
      stageReports: [],
    };
  }

  const sleep = options.sleep ?? defaultSleep;
  const cycles: StagedDevloopReport[] = [];
  while (options.abortSignal?.aborted !== true) {
    const cycle = await runStagedDevloopCycle({ ...options, mode });
    cycles.push(cycle);
    if (!cycle.passed) {
      break;
    }
    if (maxCycles !== undefined && cycles.length >= maxCycles) {
      break;
    }
    await sleep(tickSeconds * 1000, options.abortSignal);
  }

  const lastCycle = cycles.at(-1);
  return {
    passed: cycles.length > 0 && cycles.every((cycle) => cycle.passed),
    mode,
    message: `staged devloop stopped after ${cycles.length} cycle(s)`,
    statePath: lastCycle?.statePath ?? resolve(options.statePath ?? defaultStatePath(resolve(options.repoPath ?? process.cwd()))),
    stageReports: lastCycle?.stageReports ?? [],
    cycles,
    ...(lastCycle?.safetyProfile !== undefined ? { safetyProfile: lastCycle.safetyProfile } : {}),
    ...(lastCycle?.safetyBudgets !== undefined ? { safetyBudgets: lastCycle.safetyBudgets } : {}),
    ...(lastCycle?.stateWarning !== undefined ? { stateWarning: lastCycle.stateWarning } : {}),
  };
}

export function formatStagedDevloopReport(report: StagedDevloopReport): string {
  const lines = [
    report.passed ? 'devloopd staged passed' : 'devloopd staged failed',
    report.message,
    `State: ${report.statePath}`,
  ];
  if (report.stateWarning !== undefined) {
    lines.push(`State warning: ${report.stateWarning}`);
  }
  if (report.safetyProfile !== undefined) {
    lines.push(`Safety profile: ${report.safetyProfile}`);
  }
  if (report.safetyReport !== undefined && !report.safetyReport.allowed) {
    lines.push(`Safety stop: ${report.safetyReport.stopRule ?? 'unknown'} - ${report.safetyReport.reasons.join('; ')}`);
  }
  for (const stage of report.stageReports) {
    lines.push(`- ${stage.stage}: ${stage.status} - ${stage.reason}`);
  }
  if (report.cycles !== undefined) {
    lines.push(`Cycles: ${report.cycles.length}`);
  }
  return lines.join('\n');
}
