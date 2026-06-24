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
import type { DevloopCommandRunner } from './commandRunner.js';

export interface DevloopStartDependencies {
  scanIssues(options: ScanIssuesOptions): Promise<IssueScanReport>;
  runDevloopIssue(options: RunDevloopIssueOptions): Promise<DevloopRunReport>;
  importTaktRun(options: ImportTaktRunOptions): ImportTaktRunReport;
}

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

export interface DevloopStartReport {
  passed: boolean;
  message: string;
  scan?: IssueScanReport;
  selected: IssueCandidate[];
  runs: DevloopStartIssueRun[];
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

function candidatePriority(candidate: IssueCandidate): number {
  if (candidate.mode === 'auto_merge_candidate') return 0;
  if (candidate.mode === 'auto_pr_only') return 1;
  return 2;
}

function selectCandidates(candidates: readonly IssueCandidate[], maxRuns: number): IssueCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    // Prefer low-risk mechanically mergeable issues, but keep gh ordering within the same risk bucket.
    .sort((left, right) =>
      candidatePriority(left.candidate) - candidatePriority(right.candidate) || left.index - right.index,
    )
    .slice(0, maxRuns)
    .map((entry) => entry.candidate);
}

function normalizeMaxRuns(value: number | undefined): number | undefined {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function makeReport(message: string, passed = false): DevloopStartReport {
  return {
    passed,
    message,
    selected: [],
    runs: [],
  };
}

export async function startDevloop(options: StartDevloopOptions = {}): Promise<DevloopStartReport> {
  if (options.once !== true) {
    return makeReport('long-running daemon mode is not implemented yet; pass --once for a finite scan/run/import cycle');
  }

  const maxRuns = normalizeMaxRuns(options.maxRuns);
  if (maxRuns === undefined) {
    return makeReport(`maxRuns must be a positive integer: ${String(options.maxRuns)}`);
  }

  const repoPath = resolve(options.repoPath ?? process.cwd());
  const dependencies = resolveDependencies(options.dependencies);
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
      scan,
      selected: [],
      runs: [],
    };
  }

  const selected = selectCandidates(scan.candidates, maxRuns);
  if (selected.length === 0) {
    return {
      passed: false,
      message: 'no eligible issue candidates found',
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
        scan,
        selected,
        runs,
      };
    }
  }

  return {
    passed: true,
    message: `completed ${runs.length} issue run(s)`,
    scan,
    selected,
    runs,
  };
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
