import { randomUUID } from 'node:crypto';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type AutomationStateStage =
  | 'scout'
  | 'run'
  | 'review'
  | 'fix'
  | 'ci'
  | 'merge_queue'
  | 'eviction'
  | 'human_escalation';

export type AutomationStateStatus = 'passed' | 'skipped' | 'blocked' | 'failed';

export interface AutomationStateEvent {
  version: 1;
  eventId: string;
  eventType: 'devloop_automation_state';
  timestamp: string;
  stage: AutomationStateStage;
  status: AutomationStateStatus;
  summary: string;
  prNumber?: number;
  issueNumber?: number;
  stopRule?: string;
  nextActions: readonly string[];
  artifacts: readonly string[];
}

export interface AutomationStateReport {
  currentState: AutomationStateStatus | 'idle';
  eventCount: number;
  stageCounts: Record<AutomationStateStage, number>;
  recentEvents: readonly AutomationStateEvent[];
  nextActions: readonly string[];
}

const STAGES: readonly AutomationStateStage[] = [
  'scout',
  'run',
  'review',
  'fix',
  'ci',
  'merge_queue',
  'eviction',
  'human_escalation',
];

function compact(text: string, maxLength: number): string {
  const sanitized = sanitizeSensitiveText(text).replace(/\s+/g, ' ').trim();
  if (sanitized.length <= maxLength) {
    return sanitized;
  }
  return `${sanitized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function buildAutomationStateEvent(input: {
  stage: AutomationStateStage;
  status: AutomationStateStatus;
  summary: string;
  prNumber?: number;
  issueNumber?: number;
  stopRule?: string;
  nextActions?: readonly string[];
  artifacts?: readonly string[];
}, now: Date = new Date()): AutomationStateEvent {
  return {
    version: 1,
    eventId: `evt_${randomUUID()}`,
    eventType: 'devloop_automation_state',
    timestamp: now.toISOString(),
    stage: input.stage,
    status: input.status,
    summary: compact(input.summary, 500),
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}),
    ...(input.stopRule !== undefined ? { stopRule: input.stopRule } : {}),
    nextActions: input.nextActions?.map((action) => compact(action, 200)) ?? [],
    artifacts: input.artifacts?.map((artifact) => compact(artifact, 200)) ?? [],
  };
}

function defaultStageCounts(): Record<AutomationStateStage, number> {
  return Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<AutomationStateStage, number>;
}

function fallbackNextAction(event: AutomationStateEvent): string | undefined {
  if (event.nextActions.length > 0) {
    return undefined;
  }
  if (event.status === 'failed') return `inspect failed ${event.stage} event`;
  if (event.status === 'blocked') return `resolve blocked ${event.stage} event`;
  return undefined;
}

export function summarizeAutomationState(
  events: readonly AutomationStateEvent[],
  options: { maxRecentEvents?: number; maxSummaryLength?: number } = {},
): AutomationStateReport {
  const maxRecentEvents = options.maxRecentEvents ?? 8;
  const maxSummaryLength = options.maxSummaryLength ?? 500;
  const sorted = [...events].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const stageCounts = defaultStageCounts();
  for (const event of sorted) {
    stageCounts[event.stage] += 1;
  }
  const recentEvents = sorted.slice(-maxRecentEvents).map((event) => ({
    ...event,
    summary: compact(event.summary, maxSummaryLength),
  }));
  const latest = sorted.at(-1);
  const nextActions = [...new Set(recentEvents.flatMap((event) => [
    ...event.nextActions,
    fallbackNextAction(event),
  ].filter((action): action is string => action !== undefined)))];

  return {
    currentState: latest?.status ?? 'idle',
    eventCount: sorted.length,
    stageCounts,
    recentEvents,
    nextActions,
  };
}

export function formatAutomationStateReport(report: AutomationStateReport): string {
  const lines = [
    `devloopd automation state: ${report.currentState}`,
    `Events: ${report.eventCount}`,
    'Stage counts:',
    ...STAGES.map((stage) => `- ${stage}: ${report.stageCounts[stage]}`),
  ];
  if (report.recentEvents.length > 0) {
    lines.push('Recent events:');
    lines.push(...report.recentEvents.map((event) => {
      const ref = event.prNumber !== undefined ? ` #${event.prNumber}` : event.issueNumber !== undefined ? ` issue #${event.issueNumber}` : '';
      return `- ${event.timestamp} ${event.stage}${ref}: ${event.status} - ${event.summary}`;
    }));
  }
  if (report.nextActions.length > 0) {
    lines.push('Next actions:');
    lines.push(...report.nextActions.map((action) => `- ${action}`));
  }
  return lines.join('\n');
}
