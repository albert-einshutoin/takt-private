#!/usr/bin/env node

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { formatDevloopDoctorReport, runDevloopDoctor } from '../../devloopd/doctor.js';
import { formatActiveRunsReport, inspectActiveRuns } from '../../devloopd/activeRuns.js';
import {
  formatAutomationStateReport,
  summarizeAutomationState,
  type AutomationStateEvent,
} from '../../devloopd/automationState.js';
import { formatIssueSelectionReport, selectIssueFromScan } from '../../devloopd/issueSelector.js';
import { formatIssueScoutReport, runIssueScout, type IssueScoutSourceId } from '../../devloopd/issueScout.js';
import {
  exportDevloopLedger,
  formatExportDevloopLedgerReport,
  formatImportTaktRunReport,
  formatReconcileTaktRunsReport,
  formatTimelineReport,
  importTaktRun,
  reconcileTaktRuns,
  readRawDevloopLedgerEvents,
  renderTimeline,
} from '../../devloopd/ledger.js';
import { buildDevloopMemory, formatDevloopMemoryReport } from '../../devloopd/memory.js';
import { formatIssueScanReport, scanIssues } from '../../devloopd/issueScanner.js';
import { formatMergeGateReport, mergeIfSafe } from '../../devloopd/mergeGate.js';
import {
  formatDevloopAutomationStageReport,
  promotePullRequestAutoMerge,
  runDevloopAutomationStage,
  type DevloopAutomationStage,
} from '../../devloopd/prAutomation.js';
import { formatDevloopRunReport, runDevloopIssue } from '../../devloopd/run.js';
import {
  DEVLOOP_AUTOMATION_STAGES,
  formatStagedDevloopReport,
  runStagedDevloop,
  type StagedDevloopMode,
  type StagedDevloopSafetyProfile,
} from '../../devloopd/stagedScheduler.js';
import { formatDevloopStartReport, startDevloop } from '../../devloopd/supervisor.js';
import { getErrorMessage } from '../../shared/utils/error.js';

const require = createRequire(import.meta.url);
const { version: cliVersion } = require('../../../package.json') as { version: string };

const program = new Command();

function parsePositiveNumberOption(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseAutomationStage(value: string): DevloopAutomationStage {
  if ((DEVLOOP_AUTOMATION_STAGES as readonly string[]).includes(value)) {
    return value as DevloopAutomationStage;
  }
  throw new Error(`unknown devloopd stage: ${value}`);
}

function parseSafetyProfileOption(value: string | undefined): StagedDevloopSafetyProfile | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'smoke' || value === 'safe-default' || value === 'daemon') {
    return value;
  }
  throw new Error(`invalid safety profile: ${value}`);
}

function parseStagedModeOrStage(value: string | undefined): { mode: StagedDevloopMode; stage?: DevloopAutomationStage } {
  if (value === undefined || value === 'once') {
    return { mode: 'once' };
  }
  if (value === 'loop') {
    return { mode: 'loop' };
  }
  return { mode: 'once', stage: parseAutomationStage(value) };
}

function isAutomationStateEvent(event: unknown): event is AutomationStateEvent {
  return typeof event === 'object'
    && event !== null
    && (event as { eventType?: unknown }).eventType === 'devloop_automation_state';
}

program
  .name('devloopd')
  .description('devloopd sidecar utilities for TAKT subscription-only development loops')
  .version(cliVersion);

program
  .command('doctor')
  .description('Check local subscription-only provider readiness')
  .option('--subscription-only', 'Require TAKT subscription-only policy checks')
  .option('--repo <path>', 'Repository path to inspect', process.cwd())
  .option('--policy <path>', 'devloopd policy YAML path')
  .option('--verbose', 'Show passing checks')
  .option('--skip-auth', 'Skip GitHub CLI auth status check')
  .option('--smoke-cli', 'Run bounded real CLI smoke checks for subscription-only providers')
  .option('--smoke-timeout-ms <ms>', 'Per-provider CLI smoke timeout in milliseconds')
  .action(async (options: {
    subscriptionOnly?: boolean;
    repo: string;
    policy?: string;
    verbose?: boolean;
    skipAuth?: boolean;
    smokeCli?: boolean;
    smokeTimeoutMs?: string;
  }) => {
    const parsedSmokeTimeoutMs = options.smokeTimeoutMs === undefined ? undefined : Number(options.smokeTimeoutMs);
    const smokeTimeoutMs = parsedSmokeTimeoutMs !== undefined
      && Number.isFinite(parsedSmokeTimeoutMs)
      && parsedSmokeTimeoutMs > 0
      ? parsedSmokeTimeoutMs
      : undefined;
    const report = await runDevloopDoctor({
      repoPath: resolve(options.repo),
      policyPath: options.policy ? resolve(options.policy) : undefined,
      subscriptionOnly: options.subscriptionOnly === true,
      verbose: options.verbose === true,
      skipAuth: options.skipAuth === true,
      smokeCli: options.smokeCli === true,
      smokeTimeoutMs,
    });

    console.log(formatDevloopDoctorReport(report, { verbose: options.verbose === true }));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('run')
  .description('Run a GitHub issue through TAKT after subscription-only readiness checks')
  .requiredOption('--issue <number>', 'GitHub issue number')
  .option('--repo <owner/repo>', 'GitHub repository for TAKT PR operations')
  .option('--workflow <path>', 'TAKT workflow name or path', '.takt/workflows/subscription-devloop.yaml')
  .option('--policy <path>', 'devloopd policy YAML path')
  .option('--skip-auth', 'Skip GitHub CLI auth status check')
  .option('--no-auto-pr', 'Do not pass --auto-pr to TAKT')
  .option('--no-quiet', 'Do not pass --quiet to TAKT')
  .option('--cwd <path>', 'Repository path to run in', process.cwd())
  .option('--verbose', 'Show doctor passing checks')
  .action(async (options: {
    issue: string;
    repo?: string;
    workflow: string;
    policy?: string;
    skipAuth?: boolean;
    autoPr?: boolean;
    quiet?: boolean;
    cwd: string;
    verbose?: boolean;
  }) => {
    const report = await runDevloopIssue({
      repoPath: resolve(options.cwd),
      issue: options.issue,
      repo: options.repo,
      workflow: options.workflow,
      policyPath: options.policy ? resolve(options.policy) : undefined,
      skipAuth: options.skipAuth === true,
      autoPr: options.autoPr !== false,
      quiet: options.quiet !== false,
    });

    console.log(formatDevloopRunReport(report, { verbose: options.verbose === true }));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('import-takt-run')
  .description('Import TAKT run metadata and artifacts into the devloop ledger')
  .option('--latest', 'Import the latest TAKT run')
  .option('--run <slug>', 'TAKT run slug to import')
  .option('--issue <number>', 'GitHub issue number to associate with the imported run', (value: string) => Number(value))
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .action((options: {
    latest?: boolean;
    run?: string;
    issue?: number;
    cwd: string;
    ledger?: string;
  }) => {
    const report = importTaktRun({
      repoPath: resolve(options.cwd),
      latest: options.latest === true,
      runSlug: options.run,
      issue: Number.isFinite(options.issue) ? options.issue : undefined,
      ledgerPath: options.ledger,
    });

    console.log(formatImportTaktRunReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('timeline')
  .description('Render imported TAKT runs from the devloop ledger')
  .option('--issue <number>', 'Filter by GitHub issue number', (value: string) => Number(value))
  .option('--run <slug>', 'Filter by TAKT run slug')
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .action((options: {
    issue?: number;
    run?: string;
    cwd: string;
    ledger?: string;
  }) => {
    const report = renderTimeline({
      repoPath: resolve(options.cwd),
      issue: Number.isFinite(options.issue) ? options.issue : undefined,
      runSlug: options.run,
      ledgerPath: options.ledger,
    });

    console.log(formatTimelineReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('automation-state')
  .description('Render compact staged automation state from the devloop ledger')
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .option('--recent <count>', 'Maximum recent events to include', (value: string) => Number(value))
  .action((options: {
    cwd: string;
    ledger?: string;
    recent?: number;
  }) => {
    const repoPath = resolve(options.cwd);
    const ledgerPath = options.ledger ? resolve(repoPath, options.ledger) : undefined;
    const events = readRawDevloopLedgerEvents(ledgerPath ?? resolve(repoPath, '.devloop', 'ledger.jsonl'))
      .flatMap((event): AutomationStateEvent[] => isAutomationStateEvent(event) ? [event] : []);
    const report = summarizeAutomationState(events, {
      maxRecentEvents: Number.isFinite(options.recent) ? options.recent : undefined,
    });

    console.log(formatAutomationStateReport(report));
  });

program
  .command('reconcile-runs')
  .description('Import missing completed TAKT runs into the devloop ledger')
  .option('--issue <number>', 'GitHub issue number to associate with imported runs', (value: string) => Number(value))
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .action((options: {
    issue?: number;
    cwd: string;
    ledger?: string;
  }) => {
    const report = reconcileTaktRuns({
      repoPath: resolve(options.cwd),
      issue: Number.isFinite(options.issue) ? options.issue : undefined,
      ledgerPath: options.ledger,
    });

    console.log(formatReconcileTaktRunsReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('export-ledger')
  .description('Export filtered devloop ledger events to a JSONL backup')
  .option('--issue <number>', 'Filter by GitHub issue number', (value: string) => Number(value))
  .option('--run <slug>', 'Filter by TAKT run slug')
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .requiredOption('--output <path>', 'Output JSONL path. Relative paths must stay inside cwd')
  .option('--force', 'Overwrite an existing output file')
  .action((options: {
    issue?: number;
    run?: string;
    cwd: string;
    ledger?: string;
    output: string;
    force?: boolean;
  }) => {
    const report = exportDevloopLedger({
      repoPath: resolve(options.cwd),
      issue: Number.isFinite(options.issue) ? options.issue : undefined,
      runSlug: options.run,
      ledgerPath: options.ledger,
      outputPath: options.output,
      force: options.force === true,
    });

    console.log(formatExportDevloopLedgerReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('memory')
  .description('Render or write compact devloop project memory from imported runs')
  .option('--issue <number>', 'Filter by GitHub issue number', (value: string) => Number(value))
  .option('--limit <count>', 'Maximum imported runs to include', (value: string) => Number(value))
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .option('--output <path>', 'Memory output path relative to cwd or absolute path')
  .option('--write', 'Write memory to .devloop/memory.md instead of rendering only')
  .action((options: {
    issue?: number;
    limit?: number;
    cwd: string;
    ledger?: string;
    output?: string;
    write?: boolean;
  }) => {
    const report = buildDevloopMemory({
      repoPath: resolve(options.cwd),
      ledgerPath: options.ledger,
      outputPath: options.output,
      issue: Number.isFinite(options.issue) ? options.issue : undefined,
      limit: options.limit,
      write: options.write === true,
    });

    console.log(formatDevloopMemoryReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('merge-if-safe')
  .description('Enable GitHub auto-merge only after mechanical merge gates pass')
  .requiredOption('--pr <number-or-url>', 'Pull request number or URL')
  .option('--repo <owner/repo>', 'GitHub repository')
  .option('--expected-head <sha>', 'Expected PR head SHA')
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .action(async (options: {
    pr: string;
    repo?: string;
    expectedHead?: string;
    cwd: string;
  }) => {
    const report = await mergeIfSafe({
      pr: options.pr,
      repo: options.repo,
      expectedHeadSha: options.expectedHead,
      repoPath: resolve(options.cwd),
    });

    console.log(formatMergeGateReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('promote-auto-merge')
  .description('Add the auto-merge label only after current-head agy and Codex approvals')
  .requiredOption('--pr <number>', 'Pull request number')
  .option('--repo <owner/repo>', 'GitHub repository')
  .option('--cwd <path>', 'Repository path to run gh from', process.cwd())
  .option('--label <name>', 'Auto-merge label to add', 'agent:auto-merge')
  .option('--dry-run', 'Do not mutate labels')
  .action(async (options: {
    pr: string;
    repo?: string;
    cwd: string;
    label: string;
    dryRun?: boolean;
  }) => {
    const report = await promotePullRequestAutoMerge({
      pr: Number(options.pr),
      repo: options.repo,
      repoPath: resolve(options.cwd),
      label: options.label,
      dryRun: options.dryRun === true,
    });
    console.log(`${report.type}: ${report.status} - ${report.message}`);
    if (report.dualLlmApproval) {
      console.log(`Dual LLM approval: ${report.dualLlmApproval.approved ? 'approved' : 'not approved'}`);
      for (const reason of report.dualLlmApproval.reasons) {
        console.log(`- ${reason}`);
      }
    }
    if (report.productPolicyImpact) {
      console.log(`Product policy impact: ${report.productPolicyImpact.impact}`);
      for (const reason of report.productPolicyImpact.reasons) {
        console.log(`- ${reason}`);
      }
    }
    if (report.status === 'failed' || report.status === 'blocked') {
      process.exitCode = 1;
    }
  });

program
  .command('scan-issues')
  .description('Scan GitHub issues and apply mechanical devloop backlog policy')
  .option('--repo <owner/repo>', 'GitHub repository')
  .option('--cwd <path>', 'Repository path to run gh from', process.cwd())
  .action(async (options: {
    repo?: string;
    cwd: string;
  }) => {
    const report = await scanIssues({
      repoPath: resolve(options.cwd),
      repo: options.repo,
    });

    console.log(formatIssueScanReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('issue-scout')
  .description('Discover recursive maintenance work from typed devloopd issue sources')
  .option('--repo <owner/repo>', 'GitHub repository')
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .option('--source <id...>', 'Limit issue-scout to one or more source IDs')
  .option('--max-selections <count>', 'Maximum generated issue candidates to select', (value: string) => Number(value))
  .option('--dry-run', 'Print would-create issues without mutating GitHub')
  .option('--create', 'Create selected GitHub issues. Use with care; dry-run remains non-mutating')
  .action(async (options: {
    repo?: string;
    cwd: string;
    ledger?: string;
    source?: string[];
    maxSelections?: number;
    dryRun?: boolean;
    create?: boolean;
  }) => {
    const report = await runIssueScout({
      repoPath: resolve(options.cwd),
      repo: options.repo,
      ledgerPath: options.ledger,
      sourceIds: options.source as IssueScoutSourceId[] | undefined,
      maxSelections: Number.isFinite(options.maxSelections) ? options.maxSelections : undefined,
      dryRun: options.dryRun === true,
      createIssues: options.create === true,
    });

    console.log(formatIssueScoutReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('select-issue')
  .description('Scan GitHub issues and select the safest mechanical devloop candidate')
  .option('--repo <owner/repo>', 'GitHub repository')
  .option('--cwd <path>', 'Repository path to run gh from', process.cwd())
  .option('--max-selections <count>', 'Maximum issue candidates to select', (value: string) => Number(value))
  .option('--no-auto-pr-only', 'Do not select medium-risk auto_pr_only candidates')
  .action(async (options: {
    repo?: string;
    cwd: string;
    maxSelections?: number;
    autoPrOnly?: boolean;
  }) => {
    const scan = await scanIssues({
      repoPath: resolve(options.cwd),
      repo: options.repo,
    });
    const report = selectIssueFromScan(scan, {
      maxSelections: options.maxSelections,
      allowAutoPrOnly: options.autoPrOnly !== false,
    });

    console.log(formatIssueSelectionReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('stage')
  .description('Run one explicit devloop automation stage')
  .argument('<stage>', `Stage: ${DEVLOOP_AUTOMATION_STAGES.join(', ')}`)
  .option('--repo <owner/repo>', 'GitHub repository')
  .option('--cwd <path>', 'Repository path to run in', process.cwd())
  .option('--workflow <path>', 'TAKT workflow name or path', '.takt/workflows/subscription-devloop.yaml')
  .option('--policy <path>', 'devloopd policy YAML path')
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .option('--skip-auth', 'Skip GitHub CLI auth status check')
  .option('--no-auto-pr', 'Do not pass --auto-pr to TAKT')
  .option('--no-quiet', 'Do not pass --quiet to TAKT')
  .option('--dry-run', 'Do not mutate GitHub state')
  .action(async (stageValue: string, options: {
    repo?: string;
    cwd: string;
    workflow: string;
    policy?: string;
    ledger?: string;
    skipAuth?: boolean;
    autoPr?: boolean;
    quiet?: boolean;
    dryRun?: boolean;
  }) => {
    const report = await runDevloopAutomationStage({
      stage: parseAutomationStage(stageValue),
      repoPath: resolve(options.cwd),
      repo: options.repo,
      workflow: options.workflow,
      policyPath: options.policy ? resolve(options.policy) : undefined,
      ledgerPath: options.ledger,
      skipAuth: options.skipAuth === true,
      autoPr: options.autoPr !== false,
      quiet: options.quiet !== false,
      dryRun: options.dryRun === true,
    });

    console.log(formatDevloopAutomationStageReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('staged')
  .description('Run the staged devloop scheduler in devloopd')
  .argument('[mode-or-stage]', 'once, loop, or an explicit stage', 'once')
  .option('--repo <owner/repo>', 'GitHub repository')
  .option('--cwd <path>', 'Repository path to run in', process.cwd())
  .option('--workflow <path>', 'TAKT workflow name or path', '.takt/workflows/subscription-devloop.yaml')
  .option('--policy <path>', 'devloopd policy YAML path')
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .option('--skip-auth', 'Skip GitHub CLI auth status check')
  .option('--no-auto-pr', 'Do not pass --auto-pr to TAKT')
  .option('--no-quiet', 'Do not pass --quiet to TAKT')
  .option('--dry-run', 'Do not mutate GitHub state')
  .option('--state <path>', 'Structured staged scheduler state file')
  .option('--safety-profile <profile>', 'Safety profile: smoke, safe-default, or daemon')
  .option('--max-cycles <count>', 'Stop loop after a finite number of scheduler cycles', (value: string) => Number(value))
  .option('--tick-seconds <count>', 'Seconds between loop ticks', (value: string) => Number(value))
  .option('--issue-scout-interval <seconds>', 'issue-scout interval')
  .option('--issue-to-pr-interval <seconds>', 'issue-to-pr interval')
  .option('--pr-review-interval <seconds>', 'pr-review interval')
  .option('--review-fix-interval <seconds>', 'review-fix interval')
  .option('--pr-merge-interval <seconds>', 'pr-merge interval')
  .action(async (modeOrStage: string, options: {
    repo?: string;
    cwd: string;
    workflow: string;
    policy?: string;
    ledger?: string;
    skipAuth?: boolean;
    autoPr?: boolean;
    quiet?: boolean;
    dryRun?: boolean;
    state?: string;
    safetyProfile?: string;
    maxCycles?: number;
    tickSeconds?: number;
    issueScoutInterval?: string;
    issueToPrInterval?: string;
    prReviewInterval?: string;
    reviewFixInterval?: string;
    prMergeInterval?: string;
  }) => {
    const parsed = parseStagedModeOrStage(modeOrStage);
    const report = await runStagedDevloop({
      repoPath: resolve(options.cwd),
      repo: options.repo,
      workflow: options.workflow,
      policyPath: options.policy ? resolve(options.policy) : undefined,
      ledgerPath: options.ledger,
      skipAuth: options.skipAuth === true,
      autoPr: options.autoPr !== false,
      quiet: options.quiet !== false,
      dryRun: options.dryRun === true,
      statePath: options.state ? resolve(options.state) : undefined,
      safetyProfile: parseSafetyProfileOption(options.safetyProfile),
      maxCycles: options.maxCycles,
      tickSeconds: options.tickSeconds,
      mode: parsed.mode,
      stage: parsed.stage,
      intervals: {
        'issue-scout': parsePositiveNumberOption(options.issueScoutInterval),
        'issue-to-pr': parsePositiveNumberOption(options.issueToPrInterval),
        'pr-review': parsePositiveNumberOption(options.prReviewInterval),
        'review-fix': parsePositiveNumberOption(options.reviewFixInterval),
        'pr-merge': parsePositiveNumberOption(options.prMergeInterval),
      },
    });

    console.log(formatStagedDevloopReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('active-runs')
  .description('Inspect currently running TAKT runs and stale run state')
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .option('--stale-after-minutes <count>', 'Minutes without metadata update before a run is stale', (value: string) => Number(value))
  .action((options: {
    cwd: string;
    staleAfterMinutes?: number;
  }) => {
    const report = inspectActiveRuns({
      repoPath: resolve(options.cwd),
      staleAfterMinutes: options.staleAfterMinutes,
    });

    console.log(formatActiveRunsReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('start')
  .description('Run the subscription-only devloop supervisor')
  .option('--repo <owner/repo>', 'GitHub repository')
  .option('--once', 'Run one finite scan/run/import cycle and exit')
  .option('--max-cycles <count>', 'Stop after a finite number of daemon cycles', (value: string) => Number(value))
  .option('--interval-seconds <count>', 'Seconds to wait between daemon cycles', (value: string) => Number(value))
  .option('--workflow <path>', 'TAKT workflow name or path', '.takt/workflows/subscription-devloop.yaml')
  .option('--policy <path>', 'devloopd policy YAML path')
  .option('--skip-auth', 'Skip GitHub CLI auth status check')
  .option('--no-auto-pr', 'Do not pass --auto-pr to TAKT')
  .option('--no-quiet', 'Do not pass --quiet to TAKT')
  .option('--cwd <path>', 'Repository path to run in', process.cwd())
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .option('--max-active-runs <count>', 'Maximum active TAKT runs allowed before start refuses to scan', (value: string) => Number(value))
  .option('--stale-after-minutes <count>', 'Minutes without metadata update before active-runs marks a run stale', (value: string) => Number(value))
  .action(async (options: {
    repo?: string;
    once?: boolean;
    maxCycles?: number;
    intervalSeconds?: number;
    workflow: string;
    policy?: string;
    skipAuth?: boolean;
    autoPr?: boolean;
    quiet?: boolean;
    cwd: string;
    ledger?: string;
    maxActiveRuns?: number;
    staleAfterMinutes?: number;
  }) => {
    const report = await startDevloop({
      repoPath: resolve(options.cwd),
      repo: options.repo,
      once: options.once === true,
      maxCycles: options.maxCycles,
      intervalSeconds: options.intervalSeconds,
      workflow: options.workflow,
      policyPath: options.policy ? resolve(options.policy) : undefined,
      skipAuth: options.skipAuth === true,
      autoPr: options.autoPr !== false,
      quiet: options.quiet !== false,
      ledgerPath: options.ledger,
      maxActiveRuns: options.maxActiveRuns,
      staleAfterMinutes: options.staleAfterMinutes,
    });

    console.log(formatDevloopStartReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(getErrorMessage(error));
  process.exit(1);
});
