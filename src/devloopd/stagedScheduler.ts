import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  runDevloopAutomationStage,
  type DevloopAutomationStage,
  type DevloopAutomationStageReport,
  type RunDevloopAutomationStageOptions,
} from './prAutomation.js';

export { type DevloopAutomationStage } from './prAutomation.js';

export const DEVLOOP_AUTOMATION_STAGES = [
  'issue-scout',
  'issue-to-pr',
  'pr-review',
  'review-fix',
  'pr-merge',
] as const satisfies readonly DevloopAutomationStage[];

export type StagedDevloopMode = 'once' | 'loop';

export interface StagedDevloopState {
  version: 1;
  lastRunAt: Partial<Record<DevloopAutomationStage, string>>;
}

export interface StagedDevloopStageReport {
  stage: DevloopAutomationStage;
  status: 'ran' | 'skipped' | 'failed';
  due: boolean;
  reason: string;
  lastRunAt?: string;
  nextRunAt?: string;
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

function defaultStatePath(repoPath: string): string {
  return resolve(repoPath, '.takt/staged-devloop-state.json');
}

function emptyState(): StagedDevloopState {
  return {
    version: 1,
    lastRunAt: {},
  };
}

function readState(statePath: string): { state: StagedDevloopState; warning?: string } {
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
      },
    };
  } catch {
    return { state: emptyState(), warning: `malformed staged devloop state: ${statePath}` };
  }
}

function writeState(statePath: string, state: StagedDevloopState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  // The scheduler uses JSON instead of shell-sourced env so a crashed loop can
  // resume deterministically without executing untrusted state file content.
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
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

async function runStagedDevloopCycle(options: RunStagedDevloopOptions): Promise<StagedDevloopReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const mode = options.mode ?? 'once';
  const statePath = resolve(options.statePath ?? env.TAKT_LOOP_STAGE_STATE ?? defaultStatePath(repoPath));
  const intervals = resolveIntervals(env, options.intervals);
  const dependencies = resolveDependencies(options.dependencies);
  const now = options.now?.() ?? new Date();
  const { state, warning } = readState(statePath);
  const targetStages = options.stage === undefined ? DEVLOOP_AUTOMATION_STAGES : [options.stage];
  const stageReports: StagedDevloopStageReport[] = [];

  for (const stage of targetStages) {
    const lastRun = parseTimestamp(state.lastRunAt[stage]);
    const stageNextRunAt = nextRunAt(lastRun, intervals[stage]);
    const due = options.stage !== undefined || isDue(lastRun, intervals[stage], now);
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
    state.lastRunAt[stage] = now.toISOString();
    stageReports.push({
      stage,
      status: stageReport.passed ? 'ran' : 'failed',
      due: true,
      reason: stageReport.message,
      ...(lastRun !== undefined ? { lastRunAt: lastRun.toISOString() } : {}),
      report: stageReport,
    });
  }

  writeState(statePath, state);
  const passed = stageReports.every((stageReport) => stageReport.status !== 'failed');
  return {
    passed,
    mode,
    message: `${stageReports.filter((stageReport) => stageReport.status === 'ran').length} staged devloop stage(s) ran`,
    statePath,
    stageReports,
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
  for (const stage of report.stageReports) {
    lines.push(`- ${stage.stage}: ${stage.status} - ${stage.reason}`);
  }
  if (report.cycles !== undefined) {
    lines.push(`Cycles: ${report.cycles.length}`);
  }
  return lines.join('\n');
}
