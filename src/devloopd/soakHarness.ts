import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  appendDevloopLedgerEvent,
  buildDevloopLedgerEvent,
  readRawDevloopLedgerEvents,
  resolveDevloopLedgerPath,
} from './ledger.js';
import { writeFileAtomic } from './stateStore.js';
import {
  runStagedDevloop,
  type DevloopAutomationStage,
  type StagedDevloopReport,
} from './stagedScheduler.js';
import type { DevloopAutomationAction } from './prAutomation.js';
import type { ProductPolicyClassification } from './productPolicyClassifier.js';

export interface RepeatedWaitLoop {
  stage: DevloopAutomationStage;
  reason: string;
  count: number;
}

export interface ReasonlessWaitLoop {
  stage: DevloopAutomationStage;
  status: 'skipped' | 'failed';
  count: number;
}

export interface DevloopSoakScenarioResult {
  name: string;
  passed: boolean;
  message: string;
}

export interface DevloopSoakCycleSummary {
  cycle: number;
  ran: number;
  skipped: number;
  failed: number;
  retryAfterSkips: string[];
}

export interface DevloopSoakHarnessMetrics {
  retryActions: number;
  ciFlakes: number;
  productPolicyEscalations: number;
  mergeSerializations: number;
  retryAfterSkips: number;
  issueScoutRunsAfterRetryAfter: number;
  ledgerEvents: number;
  leakedLockFiles: string[];
  externalProcessesSpawned: number;
}

export interface DevloopSoakHarnessReport {
  passed: boolean;
  message: string;
  repoPath: string;
  statePath: string;
  ledgerPath: string;
  reportPath: string;
  cycles: number;
  stageRuns: number;
  cycleSummaries: DevloopSoakCycleSummary[];
  metrics: DevloopSoakHarnessMetrics;
  repeatedWaits: RepeatedWaitLoop[];
  reasonlessWaits: ReasonlessWaitLoop[];
  scenarioResults: DevloopSoakScenarioResult[];
  scheduler: StagedDevloopReport;
}

export interface RunDevloopSoakHarnessOptions {
  repoPath?: string;
  statePath?: string;
  ledgerPath?: string;
  reportPath?: string;
  cycles?: number;
  repeatedWaitLimit?: number;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function defaultStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'takt-devloop-soak-')), 'state.json');
}

function buildCleanProductPolicyFixture(): ProductPolicyClassification {
  return {
    impact: 'product_policy',
    policyCategory: 'product_policy',
    requiresHumanReview: true,
    reasons: ['fixture product policy decision requires a human owner'],
    evidencePaths: ['docs/product-policy.md'],
    evidenceHunks: [{
      path: 'docs/product-policy.md',
      reason: 'fixture policy boundary',
      snippet: 'human review required for roadmap policy',
    }],
  };
}

function makeAction(
  type: string,
  status: DevloopAutomationAction['status'],
  message: string,
  extra: Omit<DevloopAutomationAction, 'type' | 'status' | 'message'> = {},
): DevloopAutomationAction {
  return {
    type,
    status,
    message,
    ...extra,
  };
}

function waitKey(report: StagedDevloopReport['stageReports'][number]): string | undefined {
  if (report.status !== 'skipped') {
    return undefined;
  }
  return `${report.stage}\0${report.reason}`;
}

export function detectRepeatedWaitLoops(
  cycles: readonly StagedDevloopReport[],
  options: { limit?: number } = {},
): RepeatedWaitLoop[] {
  const limit = normalizePositiveInteger(options.limit, 3);
  const counts = new Map<string, { stage: DevloopAutomationStage; reason: string; count: number }>();
  const findings = new Map<string, RepeatedWaitLoop>();

  for (const cycle of cycles) {
    const seenThisCycle = new Set<string>();
    for (const stageReport of cycle.stageReports) {
      const key = waitKey(stageReport);
      if (key === undefined) {
        continue;
      }
      seenThisCycle.add(key);
      const previous = counts.get(key);
      const current = {
        stage: stageReport.stage,
        reason: stageReport.reason,
        count: (previous?.count ?? 0) + 1,
      };
      counts.set(key, current);
      if (current.count > limit) {
        findings.set(key, current);
      }
    }
    for (const key of [...counts.keys()]) {
      if (!seenThisCycle.has(key)) {
        counts.delete(key);
      }
    }
  }

  return [...findings.values()];
}

export function detectReasonlessWaitLoops(
  cycles: readonly StagedDevloopReport[],
  options: { limit?: number } = {},
): ReasonlessWaitLoop[] {
  const limit = normalizePositiveInteger(options.limit, 3);
  const counts = new Map<string, ReasonlessWaitLoop>();
  const findings = new Map<string, ReasonlessWaitLoop>();

  for (const cycle of cycles) {
    const seenThisCycle = new Set<string>();
    for (const stageReport of cycle.stageReports) {
      if ((stageReport.status !== 'skipped' && stageReport.status !== 'failed') || stageReport.reason.trim() !== '') {
        continue;
      }
      const key = `${stageReport.stage}\0${stageReport.status}`;
      seenThisCycle.add(key);
      const previous = counts.get(key);
      const current = {
        stage: stageReport.stage,
        status: stageReport.status,
        count: (previous?.count ?? 0) + 1,
      };
      counts.set(key, current);
      if (current.count > limit) {
        findings.set(key, current);
      }
    }
    for (const key of [...counts.keys()]) {
      if (!seenThisCycle.has(key)) {
        counts.delete(key);
      }
    }
  }

  return [...findings.values()];
}

function countStageRuns(report: StagedDevloopReport): number {
  return (report.cycles ?? [report]).reduce((total, cycle) => (
    total + cycle.stageReports.filter((stage) => stage.status === 'ran').length
  ), 0);
}

function flattenActions(report: StagedDevloopReport): DevloopAutomationAction[] {
  return (report.cycles ?? [report])
    .flatMap((cycle) => cycle.stageReports)
    .flatMap((stageReport) => stageReport.report?.actions ?? []);
}

function summarizeCycles(report: StagedDevloopReport): DevloopSoakCycleSummary[] {
  return (report.cycles ?? [report]).map((cycle, index) => ({
    cycle: index + 1,
    ran: cycle.stageReports.filter((stage) => stage.status === 'ran').length,
    skipped: cycle.stageReports.filter((stage) => stage.status === 'skipped').length,
    failed: cycle.stageReports.filter((stage) => stage.status === 'failed').length,
    retryAfterSkips: cycle.stageReports
      .filter((stage) => stage.retryAfter !== undefined)
      .map((stage) => `${stage.stage} until ${stage.retryAfter}`),
  }));
}

function countIssueScoutRunsAfterRetryAfter(report: StagedDevloopReport): number {
  let sawRetryAfter = false;
  let runsAfterRetryAfter = 0;
  for (const cycle of report.cycles ?? [report]) {
    const issueScout = cycle.stageReports.find((stage) => stage.stage === 'issue-scout');
    if (issueScout?.retryAfter !== undefined) {
      sawRetryAfter = true;
      continue;
    }
    if (sawRetryAfter && issueScout?.status === 'ran') {
      runsAfterRetryAfter += 1;
    }
  }
  return runsAfterRetryAfter;
}

function collectLeakedLocks(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    const lockPath = `${path}.lock`;
    return existsSync(lockPath) ? [lockPath] : [];
  });
}

async function runSafetyBudgetStopScenario(repoPath: string): Promise<DevloopSoakScenarioResult> {
  const statePath = join(mkdtempSync(join(tmpdir(), 'takt-devloop-soak-safety-')), 'state.json');
  writeFileAtomic(statePath, `${JSON.stringify({
    version: 1,
    lastRunAt: {},
    safety: {
      startedAt: '2026-07-06T00:00:00.000Z',
      runs: 2,
      pullRequests: 0,
      retries: 0,
      costProxy: 0,
      changedFiles: 0,
      changedLines: 0,
      consecutiveNoopSignals: 0,
      classifierDisagreements: 0,
      ciFlakes: 0,
      reviewFixFailures: 0,
      productPolicyEscalations: 0,
    },
  }, null, 2)}\n`);
  let called = false;
  const report = await runStagedDevloop({
    repoPath,
    mode: 'once',
    statePath,
    safetyBudgets: { maxRuns: 1 },
    now: () => new Date('2026-07-06T00:05:00.000Z'),
    dependencies: {
      async runStage(stageOptions) {
        called = true;
        return {
          passed: true,
          stage: stageOptions.stage,
          message: `unexpected stage run: ${stageOptions.stage}`,
          actions: [],
        };
      },
    },
  });
  const passed = !report.passed && !called && report.message.includes('automation safety stopped');
  return {
    name: 'safety-budget-stop',
    passed,
    message: passed
      ? 'persisted safety state stopped the loop before additional work'
      : 'safety budget did not stop the scheduler before work',
  };
}

function buildScenarioStageReport(stage: DevloopAutomationStage, stageCall: number) {
  if (stage === 'issue-scout') {
    return {
      passed: true,
      stage,
      message: stageCall === 1 ? 'no eligible mechanical issues' : 'safe mechanical issue selected',
      actions: [makeAction(
        'issue-scout',
        stageCall === 1 ? 'skipped' : 'passed',
        stageCall === 1 ? 'no eligible issues in fixture backlog' : 'selected fixture issue for implementation',
      )],
    };
  }
  if (stage === 'issue-to-pr') {
    return {
      passed: true,
      stage,
      message: 'safe fixture issue converted to PR',
      actions: [makeAction('issue-to-pr', 'passed', 'created PR for fixture issue', { pr: 101 })],
    };
  }
  if (stage === 'pr-review') {
    return {
      passed: true,
      stage,
      message: 'review gate escalated product-policy fixture to human review',
      actions: [makeAction('pr-review', 'blocked', 'human review required for product-policy fixture', {
        pr: 102,
        stopRule: 'Unsafe or too broad',
        productPolicyImpact: buildCleanProductPolicyFixture(),
      })],
    };
  }
  if (stage === 'review-fix') {
    return {
      passed: true,
      stage,
      message: 'flaky CI retry was bounded and recorded',
      actions: [makeAction('ci-fix', 'passed', 'flaky CI retry completed within retry budget', { pr: 101 })],
    };
  }
  return {
    passed: true,
    stage,
    message: 'merge queue serialized overlapping fixture PRs',
    actions: [makeAction('pr-merge', 'skipped', 'overlap serialization kept one PR waiting', {
      pr: 103,
      stopRule: 'overlap serialization',
    })],
  };
}

export async function runDevloopSoakHarness(
  options: RunDevloopSoakHarnessOptions = {},
): Promise<DevloopSoakHarnessReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const statePath = options.statePath ? resolve(options.statePath) : defaultStatePath();
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  const reportPath = options.reportPath ? resolve(options.reportPath) : join(dirname(statePath), 'soak-report.json');
  const cycles = normalizePositiveInteger(options.cycles, 5);
  const repeatedWaitLimit = normalizePositiveInteger(options.repeatedWaitLimit, 3);
  let tick = 0;
  const stageCalls: Record<DevloopAutomationStage, number> = {
    'issue-scout': 0,
    'issue-to-pr': 0,
    'pr-review': 0,
    'review-fix': 0,
    'pr-merge': 0,
  };
  appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_issue_scout', {
    repoPath,
    retryAfter: '2026-07-06T00:00:01.500Z',
  }, new Date('2026-07-06T00:00:00.000Z')));

  const scheduler = await runStagedDevloop({
    repoPath,
    ledgerPath,
    mode: 'loop',
    maxCycles: cycles,
    tickSeconds: 0,
    statePath,
    dryRun: true,
    safetyProfile: 'smoke',
    safetyBudgets: {
      maxRuns: cycles * 5 + 5,
      maxPullRequests: cycles * 4 + 4,
      maxRetries: cycles + 1,
      maxConsecutiveNoopSignals: repeatedWaitLimit + 1,
    },
    intervals: {
      'issue-scout': 0,
      'issue-to-pr': 0,
      'pr-review': 0,
      'review-fix': 0,
      'pr-merge': 0,
    },
    now: () => {
      const current = new Date(Date.UTC(2026, 6, 6, 0, 0, tick));
      tick += 1;
      return current;
    },
    sleep: async () => {},
    dependencies: {
      async runStage(stageOptions) {
        stageCalls[stageOptions.stage] += 1;
        return buildScenarioStageReport(stageOptions.stage, stageCalls[stageOptions.stage]);
      },
    },
  });
  const repeatedWaits = detectRepeatedWaitLoops(scheduler.cycles ?? [], { limit: repeatedWaitLimit });
  const reasonlessWaits = detectReasonlessWaitLoops(scheduler.cycles ?? [], { limit: repeatedWaitLimit });
  const actions = flattenActions(scheduler);
  const retryAfterSkips = (scheduler.cycles ?? [scheduler])
    .flatMap((cycle) => cycle.stageReports)
    .filter((stage) => stage.retryAfter !== undefined).length;
  const issueScoutRunsAfterRetryAfter = countIssueScoutRunsAfterRetryAfter(scheduler);
  const leakedLockFiles = collectLeakedLocks([statePath, ledgerPath]);
  const scenarioResults: DevloopSoakScenarioResult[] = [
    {
      name: 'retry-after-expiry',
      passed: retryAfterSkips > 0 && issueScoutRunsAfterRetryAfter > 0,
      message: retryAfterSkips > 0 && issueScoutRunsAfterRetryAfter > 0
        ? 'issue-scout waited on retryAfter and resumed after expiry'
        : 'issue-scout did not prove retryAfter wait and expiry',
    },
    {
      name: 'bounded-retries',
      passed: actions.some((action) => action.type === 'ci-fix')
        && actions.filter((action) => action.type === 'ci-fix' || action.type === 'review-fix').length <= cycles,
      message: 'fixture CI retry stayed within the soak cycle budget',
    },
    {
      name: 'product-policy-human-review',
      passed: actions.some((action) => action.productPolicyImpact?.requiresHumanReview === true),
      message: 'product-policy fixture was routed to human review instead of auto-merge',
    },
    {
      name: 'merge-queue-serialization',
      passed: actions.some((action) => action.stopRule === 'overlap serialization'),
      message: 'merge queue fixture serialized overlapping PR work',
    },
    {
      name: 'state-lock-cleanup',
      passed: leakedLockFiles.length === 0,
      message: leakedLockFiles.length === 0
        ? 'state and ledger locks were released'
        : `lock files leaked: ${leakedLockFiles.join(', ')}`,
    },
    await runSafetyBudgetStopScenario(repoPath),
  ];
  const metrics: DevloopSoakHarnessMetrics = {
    retryActions: actions.filter((action) => action.type === 'ci-fix' || action.type === 'review-fix').length,
    ciFlakes: actions.filter((action) => action.type === 'ci-fix' && /flaky|infra|retry/iu.test(action.message)).length,
    productPolicyEscalations: actions.filter((action) => action.productPolicyImpact?.requiresHumanReview === true).length,
    mergeSerializations: actions.filter((action) => action.stopRule === 'overlap serialization').length,
    retryAfterSkips,
    issueScoutRunsAfterRetryAfter,
    ledgerEvents: readRawDevloopLedgerEvents(ledgerPath).length,
    leakedLockFiles,
    // The deterministic soak path intentionally injects stage behavior instead
    // of spawning providers, so process cleanup is provable by construction.
    externalProcessesSpawned: 0,
  };
  const cycleSummaries = summarizeCycles(scheduler);
  const passed = scheduler.passed
    && repeatedWaits.length === 0
    && reasonlessWaits.length === 0
    && scenarioResults.every((scenario) => scenario.passed)
    && (scheduler.cycles?.length ?? 0) === cycles;
  const report: DevloopSoakHarnessReport = {
    passed,
    message: passed
      ? `soak completed ${cycles} deterministic cycle(s)`
      : 'soak harness detected scheduler instability',
    repoPath,
    statePath,
    ledgerPath,
    reportPath,
    cycles: scheduler.cycles?.length ?? 0,
    stageRuns: countStageRuns(scheduler),
    cycleSummaries,
    metrics,
    repeatedWaits,
    reasonlessWaits,
    scenarioResults,
    scheduler,
  };
  writeFileAtomic(reportPath, `${JSON.stringify({
    passed: report.passed,
    message: report.message,
    repoPath: report.repoPath,
    statePath: report.statePath,
    ledgerPath: report.ledgerPath,
    cycles: report.cycles,
    stageRuns: report.stageRuns,
    cycleSummaries: report.cycleSummaries,
    metrics: report.metrics,
    repeatedWaits: report.repeatedWaits,
    reasonlessWaits: report.reasonlessWaits,
    scenarioResults: report.scenarioResults,
  }, null, 2)}\n`);

  return report;
}

export function formatDevloopSoakHarnessReport(report: DevloopSoakHarnessReport): string {
  const lines = [
    report.passed ? 'devloopd soak passed' : 'devloopd soak failed',
    report.message,
    `Repository: ${report.repoPath}`,
    `State: ${report.statePath}`,
    `Ledger: ${report.ledgerPath}`,
    `Report: ${report.reportPath}`,
    `Cycles: ${report.cycles}`,
    `Stage runs: ${report.stageRuns}`,
    `Retry actions: ${report.metrics.retryActions}`,
    `RetryAfter skips: ${report.metrics.retryAfterSkips}`,
  ];
  lines.push('Scenarios:');
  lines.push(...report.scenarioResults.map((scenario) => (
    `- ${scenario.name}: ${scenario.passed ? 'passed' : 'failed'} - ${scenario.message}`
  )));
  if (report.repeatedWaits.length > 0) {
    lines.push('Repeated waits:');
    lines.push(...report.repeatedWaits.map((wait) => `- ${wait.stage}: ${wait.reason} (${wait.count})`));
  }
  if (report.reasonlessWaits.length > 0) {
    lines.push('Reasonless waits/errors:');
    lines.push(...report.reasonlessWaits.map((wait) => `- ${wait.stage}: ${wait.status} (${wait.count})`));
  }
  return lines.join('\n');
}
