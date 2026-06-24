import { resolve } from 'node:path';
import {
  scanIssues as defaultScanIssues,
  type IssueCandidate,
  type IssueScanPolicy,
  type IssueScanReport,
  type ScanIssuesOptions,
} from './issueScanner.js';
import {
  runDevloopIssue as defaultRunDevloopIssue,
  type DevloopRunReport,
  type RunDevloopIssueOptions,
} from './run.js';
import {
  importTaktRun as defaultImportTaktRun,
  type ImportTaktRunOptions,
  type ImportTaktRunReport,
} from './ledger.js';
import { inspectActiveRuns, type ActiveRunsReport } from './activeRuns.js';
import { selectIssueCandidates } from './issueSelector.js';
import type { DevloopCommandRunner } from './commandRunner.js';

export interface DevloopStartDependencies {
  scanIssues(options: ScanIssuesOptions): Promise<IssueScanReport>;
  runDevloopIssue(options: RunDevloopIssueOptions): Promise<DevloopRunReport>;
  importTaktRun(options: ImportTaktRunOptions): ImportTaktRunReport;
}

export type DevloopSupervisorSleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface StartDevloopOptions {
  repoPath?: string;
  repo?: string;
  workflow?: string;
  policyPath?: string;
  ledgerPath?: string;
  skipAuth?: boolean;
  autoPr?: boolean;
  quiet?: boolean;
  once?: boolean;
  maxRuns?: number;
  maxCycles?: number;
  maxActiveRuns?: number;
  intervalSeconds?: number;
  staleAfterMinutes?: number;
  abortSignal?: AbortSignal;
  sleep?: DevloopSupervisorSleep;
  issuePolicy?: Partial<IssueScanPolicy>;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
  dependencies?: Partial<DevloopStartDependencies>;
}

export interface DevloopStartIssueRun {
  candidate: IssueCandidate;
  runReport: DevloopRunReport;
  importReport?: ImportTaktRunReport;
}

export interface DevloopStartCycleReport {
  passed: boolean;
  message: string;
  activeRuns?: ActiveRunsReport;
  scan?: IssueScanReport;
  selected: IssueCandidate[];
  runs: DevloopStartIssueRun[];
}

export interface DevloopStartReport extends DevloopStartCycleReport {
  cycles?: DevloopStartCycleReport[];
  stoppedReason?: 'once' | 'max_cycles' | 'abort_signal' | 'fatal_cycle';
}

const DEFAULT_DEPENDENCIES: DevloopStartDependencies = {
  scanIssues: defaultScanIssues,
  runDevloopIssue: defaultRunDevloopIssue,
  importTaktRun: defaultImportTaktRun,
};

function resolveDependencies(dependencies: Partial<DevloopStartDependencies> | undefined): DevloopStartDependencies {
  return {
    ...DEFAULT_DEPENDENCIES,
    ...dependencies,
  };
}

function normalizeMaxRuns(value: number | undefined): number | undefined {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function normalizeMaxActiveRuns(value: number | undefined): number | undefined {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function normalizeMaxCycles(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function normalizeIntervalMilliseconds(value: number | undefined): number | undefined {
  if (value === undefined) return 60_000;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1000);
}

function makeReport(message: string, passed = false): DevloopStartReport {
  return {
    passed,
    message,
    selected: [],
    runs: [],
  };
}

function makeCycleReport(message: string, passed = false): DevloopStartCycleReport {
  return {
    passed,
    message,
    selected: [],
    runs: [],
  };
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted === true) {
    return Promise.resolve();
  }

  return new Promise((resolveSleep) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function aggregateCycleReports(
  cycles: DevloopStartCycleReport[],
  stoppedReason: DevloopStartReport['stoppedReason'],
): DevloopStartReport {
  const selected = cycles.flatMap((cycle) => cycle.selected);
  const runs = cycles.flatMap((cycle) => cycle.runs);
  return {
    passed: cycles.length > 0,
    message: cycles.length > 0
      ? `daemon stopped after ${cycles.length} cycle(s)`
      : 'daemon stopped before running any cycle',
    ...(cycles.at(-1)?.activeRuns ? { activeRuns: cycles.at(-1)?.activeRuns } : {}),
    ...(cycles.at(-1)?.scan ? { scan: cycles.at(-1)?.scan } : {}),
    selected,
    runs,
    cycles,
    stoppedReason,
  };
}

function delayForNextCycle(cycle: DevloopStartCycleReport, intervalMilliseconds: number): number {
  if (cycle.scan?.failureKind === 'rate_limited' && cycle.scan.retryAfterSeconds !== undefined) {
    return Math.max(0, cycle.scan.retryAfterSeconds * 1000);
  }
  return intervalMilliseconds;
}

function isFatalDaemonCycle(cycle: DevloopStartCycleReport): boolean {
  return !cycle.passed && cycle.runs.some((run) => !run.runReport.passed || run.importReport?.passed === false);
}

async function runDevloopCycle(options: StartDevloopOptions): Promise<DevloopStartCycleReport> {
  const maxRuns = normalizeMaxRuns(options.maxRuns);
  if (maxRuns === undefined) {
    return makeCycleReport(`maxRuns must be a positive integer: ${String(options.maxRuns)}`);
  }
  const maxActiveRuns = normalizeMaxActiveRuns(options.maxActiveRuns);
  if (maxActiveRuns === undefined) {
    return makeCycleReport(`maxActiveRuns must be a positive integer: ${String(options.maxActiveRuns)}`);
  }

  const repoPath = resolve(options.repoPath ?? process.cwd());
  const dependencies = resolveDependencies(options.dependencies);
  const activeRuns = inspectActiveRuns({
    repoPath,
    staleAfterMinutes: options.staleAfterMinutes,
  });
  if (!activeRuns.passed) {
    return {
      passed: false,
      message: activeRuns.message,
      activeRuns,
      selected: [],
      runs: [],
    };
  }
  if (activeRuns.activeRuns.length >= maxActiveRuns) {
    return {
      passed: false,
      message: `active run limit reached: ${activeRuns.activeRuns.length}/${maxActiveRuns}`,
      activeRuns,
      selected: [],
      runs: [],
    };
  }
  const scan = await dependencies.scanIssues({
    repoPath,
    repo: options.repo,
    policy: options.issuePolicy,
    env: options.env,
    runner: options.runner,
  });

  if (!scan.passed) {
    return {
      passed: false,
      message: 'issue scan failed; no TAKT runs started',
      activeRuns,
      scan,
      selected: [],
      runs: [],
    };
  }

  const selected = selectIssueCandidates(scan.candidates, { maxSelections: maxRuns });
  if (selected.length === 0) {
    return {
      passed: false,
      message: 'no eligible issue candidates found',
      activeRuns,
      scan,
      selected,
      runs: [],
    };
  }

  const runs: DevloopStartIssueRun[] = [];
  for (const candidate of selected) {
    const runReport = await dependencies.runDevloopIssue({
      repoPath,
      issue: candidate.number,
      repo: options.repo,
      workflow: options.workflow,
      policyPath: options.policyPath,
      skipAuth: options.skipAuth,
      autoPr: options.autoPr,
      quiet: options.quiet,
      env: options.env,
      runner: options.runner,
    });

    if (!runReport.passed) {
      runs.push({ candidate, runReport });
      return {
        passed: false,
        message: 'devloopd start stopped after a failed issue run',
        activeRuns,
        scan,
        selected,
        runs,
      };
    }

    const importReport = dependencies.importTaktRun({
      repoPath,
      latest: true,
      issue: candidate.number,
      ledgerPath: options.ledgerPath,
    });
    runs.push({ candidate, runReport, importReport });

    if (!importReport.passed) {
      return {
        passed: false,
        message: 'devloopd start stopped after a failed run import',
        activeRuns,
        scan,
        selected,
        runs,
      };
    }
  }

  return {
    passed: true,
    message: `completed ${runs.length} issue run(s)`,
    activeRuns,
    scan,
    selected,
    runs,
  };
}

export async function startDevloop(options: StartDevloopOptions = {}): Promise<DevloopStartReport> {
  const intervalMilliseconds = normalizeIntervalMilliseconds(options.intervalSeconds);
  if (intervalMilliseconds === undefined) {
    return makeReport(`intervalSeconds must be a non-negative number: ${String(options.intervalSeconds)}`);
  }
  const maxCycles = normalizeMaxCycles(options.once === true ? 1 : options.maxCycles);
  if (options.once !== true && options.maxCycles !== undefined && maxCycles === undefined) {
    return makeReport(`maxCycles must be a positive integer: ${String(options.maxCycles)}`);
  }

  if (options.once === true) {
    const cycle = await runDevloopCycle(options);
    return { ...cycle, stoppedReason: 'once' };
  }

  const sleep = options.sleep ?? defaultSleep;
  const cycles: DevloopStartCycleReport[] = [];
  while (options.abortSignal?.aborted !== true) {
    const cycle = await runDevloopCycle(options);
    cycles.push(cycle);

    if (isFatalDaemonCycle(cycle)) {
      return aggregateCycleReports(cycles, 'fatal_cycle');
    }
    if (maxCycles !== undefined && cycles.length >= maxCycles) {
      return aggregateCycleReports(cycles, 'max_cycles');
    }

    await sleep(delayForNextCycle(cycle, intervalMilliseconds), options.abortSignal);
  }

  return aggregateCycleReports(cycles, 'abort_signal');
}

function formatCandidate(candidate: IssueCandidate): string {
  return `#${candidate.number} [${candidate.mode}/${candidate.mechanicalRisk}] ${candidate.title}`;
}

export function formatDevloopStartReport(report: DevloopStartReport): string {
  const lines = [
    report.passed ? 'devloopd start passed' : 'devloopd start failed',
    report.message,
  ];

  if (report.scan) {
    lines.push(`Scan: ${report.scan.message}`);
  }
  if (report.cycles) {
    lines.push(`Cycles: ${report.cycles.length}`);
  }
  if (report.activeRuns && report.activeRuns.activeRuns.length > 0) {
    lines.push(`Active runs: ${report.activeRuns.activeRuns.length}`);
  }
  if (report.selected.length > 0) {
    lines.push('Selected:');
    lines.push(...report.selected.map((candidate) => `- ${formatCandidate(candidate)}`));
  }
  for (const run of report.runs) {
    lines.push(`Run #${run.candidate.number}: ${run.runReport.message}`);
    if (run.importReport) {
      lines.push(`Import #${run.candidate.number}: ${run.importReport.message}`);
      lines.push(`Ledger: ${run.importReport.ledgerPath}`);
    }
  }

  return lines.join('\n');
}
