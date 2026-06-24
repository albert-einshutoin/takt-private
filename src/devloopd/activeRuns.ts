import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readRunMetaBySlug, type RunMeta } from '../core/workflow/run/run-meta.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export interface InspectActiveRunsOptions {
  repoPath?: string;
  staleAfterMinutes?: number;
  now?: Date;
}

export interface ActiveRunRecord {
  slug: string;
  task: string;
  workflow: string;
  startTime: string;
  updatedAt?: string;
  currentStep?: string;
  currentIteration?: number;
  ageMinutes: number;
  idleMinutes: number;
  stale: boolean;
}

export interface ActiveRunsReport {
  passed: boolean;
  message: string;
  activeRuns: ActiveRunRecord[];
  staleAfterMinutes: number;
}

const DEFAULT_STALE_AFTER_MINUTES = 180;

function resolveRepoPath(repoPath: string | undefined): string {
  return resolve(repoPath ?? process.cwd());
}

function normalizeStaleAfterMinutes(value: number | undefined): number | undefined {
  if (value === undefined) return DEFAULT_STALE_AFTER_MINUTES;
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function minutesBetween(now: Date, timestamp: string): number {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - parsed) / 60_000));
}

function sanitizeText(text: string): string {
  return sanitizeSensitiveText(text).replace(/\s+/g, ' ').trim();
}

function toActiveRunRecord(
  slug: string,
  meta: RunMeta,
  now: Date,
  staleAfterMinutes: number,
): ActiveRunRecord {
  const lastProgressAt = meta.updatedAt ?? meta.startTime;
  const idleMinutes = minutesBetween(now, lastProgressAt);
  return {
    slug,
    task: sanitizeText(meta.task),
    workflow: meta.workflow,
    startTime: meta.startTime,
    updatedAt: meta.updatedAt,
    currentStep: meta.currentStep,
    currentIteration: meta.currentIteration,
    ageMinutes: minutesBetween(now, meta.startTime),
    idleMinutes,
    stale: idleMinutes >= staleAfterMinutes,
  };
}

function runningSortKey(run: ActiveRunRecord): string {
  return run.updatedAt ?? run.startTime;
}

export function inspectActiveRuns(options: InspectActiveRunsOptions = {}): ActiveRunsReport {
  const staleAfterMinutes = normalizeStaleAfterMinutes(options.staleAfterMinutes);
  if (staleAfterMinutes === undefined) {
    return {
      passed: false,
      message: `staleAfterMinutes must be a positive integer: ${String(options.staleAfterMinutes)}`,
      activeRuns: [],
      staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES,
    };
  }

  const repoPath = resolveRepoPath(options.repoPath);
  const runsDir = join(repoPath, '.takt', 'runs');
  if (!existsSync(runsDir)) {
    return {
      passed: true,
      message: 'No active TAKT runs found',
      activeRuns: [],
      staleAfterMinutes,
    };
  }

  const now = options.now ?? new Date();
  const activeRuns = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const meta = readRunMetaBySlug(repoPath, entry.name);
      if (!meta || meta.status !== 'running') {
        return [];
      }
      return [toActiveRunRecord(entry.name, meta, now, staleAfterMinutes)];
    })
    .sort((left, right) => runningSortKey(right).localeCompare(runningSortKey(left)));

  return {
    passed: true,
    message: activeRuns.length > 0
      ? `Found ${activeRuns.length} active TAKT run(s)`
      : 'No active TAKT runs found',
    activeRuns,
    staleAfterMinutes,
  };
}

function formatStep(run: ActiveRunRecord): string {
  if (run.currentStep === undefined) {
    return 'step: unknown';
  }
  if (run.currentIteration === undefined) {
    return `step: ${run.currentStep}`;
  }
  return `step: ${run.currentStep}#${run.currentIteration}`;
}

export function formatActiveRunsReport(report: ActiveRunsReport): string {
  const lines = [
    report.passed ? 'devloopd active-runs passed' : 'devloopd active-runs failed',
    report.message,
    `Stale threshold: ${report.staleAfterMinutes} minute(s)`,
  ];

  for (const run of report.activeRuns) {
    const state = run.stale ? 'stale' : 'active';
    lines.push(
      `- ${run.slug} [${state}] ${run.workflow} - ${run.task}`,
      `  ${formatStep(run)}, age: ${run.ageMinutes}m, idle: ${run.idleMinutes}m`,
    );
  }

  return lines.join('\n');
}
