import { resolve } from 'node:path';
import {
  formatActiveRunsReport,
  inspectActiveRuns,
  type ActiveRunsReport,
} from './activeRuns.js';
import {
  formatAutomationStateReport,
  summarizeAutomationState,
  type AutomationStateEvent,
  type AutomationStateReport,
} from './automationState.js';
import {
  formatPersonalLifecycleReport,
  inspectPersonalLifecycle,
  type PersonalLifecycleReport,
} from './personalLifecycle.js';
import { readRawDevloopLedgerEvents, resolveDevloopLedgerPath } from './ledger.js';

export interface PersonalStatusReport {
  passed: boolean;
  message: string;
  lifecycle: PersonalLifecycleReport;
  activeRuns: ActiveRunsReport;
  automationState: AutomationStateReport;
  nextActions: readonly string[];
  ledgerPath: string;
}

function isAutomationStateEvent(event: unknown): event is AutomationStateEvent {
  return typeof event === 'object'
    && event !== null
    && (event as { eventType?: unknown }).eventType === 'devloop_automation_state';
}

export function inspectPersonalStatus(options: {
  repoPath?: string;
  ledgerPath?: string;
  staleAfterMinutes?: number;
  now?: Date;
} = {}): PersonalStatusReport {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  const lifecycle = inspectPersonalLifecycle({ repoPath });
  const activeRuns = inspectActiveRuns({
    repoPath,
    staleAfterMinutes: options.staleAfterMinutes,
    now: options.now,
  });
  const automationEvents = readRawDevloopLedgerEvents(ledgerPath)
    .flatMap((event): AutomationStateEvent[] => isAutomationStateEvent(event) ? [event] : []);
  const automationState = summarizeAutomationState(automationEvents);
  const nextActions = [
    ...automationState.nextActions,
    ...(lifecycle.stopRequested ? ['clear stop request with devloopd reset before starting again'] : []),
    ...(activeRuns.activeRuns.some((run) => run.stale) ? ['inspect or recover stale TAKT runs'] : []),
  ];

  return {
    passed: lifecycle.passed && activeRuns.passed,
    message: lifecycle.stopRequested
      ? 'personal automation is stopped by operator request'
      : activeRuns.activeRuns.length > 0
        ? `personal automation has ${activeRuns.activeRuns.length} active run(s)`
        : 'personal automation is idle',
    lifecycle,
    activeRuns,
    automationState,
    nextActions: [...new Set(nextActions)],
    ledgerPath,
  };
}

export function formatPersonalStatusReport(report: PersonalStatusReport): string {
  const lines = [
    report.passed ? 'devloopd status passed' : 'devloopd status failed',
    report.message,
    `Ledger: ${report.ledgerPath}`,
    '',
    formatPersonalLifecycleReport(report.lifecycle),
    '',
    formatActiveRunsReport(report.activeRuns),
    '',
    formatAutomationStateReport(report.automationState),
  ];
  if (report.nextActions.length > 0) {
    lines.push('', 'Next actions:', ...report.nextActions.map((action) => `- ${action}`));
  }
  return lines.join('\n');
}
