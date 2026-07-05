import { existsSync, readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import {
  classifyRecursiveAutomationLane,
  getRecursiveAutomationLaneDefinition,
  type AutomationPolicyCategory,
  type RecursiveAutomationLane,
} from './autonomyPolicy.js';
import {
  appendDevloopLedgerEvent,
  buildDevloopLedgerEvent,
  readRawDevloopLedgerEvents,
  resolveDevloopLedgerPath,
  type DevloopLedgerEvent,
} from './ledger.js';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandRunner,
} from './commandRunner.js';
import { scanIssues } from './issueScanner.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type IssueScoutSourceId =
  | 'github_issues'
  | 'local_backlog'
  | 'todo_scan'
  | 'dependency_report'
  | 'security_report'
  | 'benchmark_report'
  | 'lint_type_debt'
  | 'ledger_events';

export type IssueScoutObservationStatus = 'success' | 'warning' | 'error';
export type IssueScoutRiskBucket = 'low' | 'medium' | 'high';
export type IssueScoutStopRule =
  | 'Duplicate or already covered'
  | 'active run limit'
  | 'Unsafe or too broad'
  | 'backoff active'
  | 'no candidates';

export interface IssueScoutArtifact {
  kind: 'github' | 'file' | 'ledger' | 'command';
  path?: string;
  url?: string;
  summary: string;
}

export interface IssueScoutCandidate {
  id: string;
  sourceId: IssueScoutSourceId;
  title: string;
  summary: string;
  lane: RecursiveAutomationLane;
  policyCategory: AutomationPolicyCategory;
  riskBucket: IssueScoutRiskBucket;
  evidence: readonly IssueScoutArtifact[];
  acceptanceCriteria: readonly string[];
  verificationCommands: readonly string[];
  escalationCriteria: readonly string[];
  expectedChangedSurfaces: readonly string[];
  labels: readonly string[];
}

export interface IssueScoutObservation {
  sourceId: IssueScoutSourceId;
  status: IssueScoutObservationStatus;
  summary: string;
  candidates: readonly IssueScoutCandidate[];
  nextActions: readonly string[];
  artifacts: readonly IssueScoutArtifact[];
}

export interface ExistingIssueScoutWork {
  title: string;
  body?: string;
  branchName?: string;
  issueNumber?: number;
  prNumber?: number;
}

export interface IssueScoutSelection {
  candidate: IssueScoutCandidate;
  score: number;
  reasons: readonly string[];
}

export interface SkippedIssueScoutCandidate {
  candidate: IssueScoutCandidate;
  stopRule: IssueScoutStopRule;
  reason: string;
  retryAfter?: string;
}

export interface IssueScoutReport {
  passed: boolean;
  message: string;
  observations: readonly IssueScoutObservation[];
  selected: readonly IssueScoutSelection[];
  skipped: readonly SkippedIssueScoutCandidate[];
  wouldCreate: readonly GeneratedIssueDraft[];
  createdIssues: readonly string[];
  ledgerPath: string;
}

export interface GeneratedIssueDraft {
  title: string;
  body: string;
  labels: readonly string[];
  candidateId: string;
}

export interface IssueScoutSourceContext {
  repoPath: string;
  repo?: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
  ledgerPath: string;
  now: Date;
  backlogFiles: readonly string[];
}

export interface IssueScoutSource {
  id: IssueScoutSourceId;
  scan(context: IssueScoutSourceContext): Promise<IssueScoutObservation> | IssueScoutObservation;
}

export interface RunIssueScoutOptions {
  repoPath?: string;
  repo?: string;
  ledgerPath?: string;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
  sources?: readonly IssueScoutSource[];
  sourceIds?: readonly IssueScoutSourceId[];
  existingWork?: readonly ExistingIssueScoutWork[];
  backlogFiles?: readonly string[];
  now?: Date;
  dryRun?: boolean;
  createIssues?: boolean;
  maxSelections?: number;
}

const DEFAULT_BACKLOG_FILES = [
  'BACKLOG.md',
  'TODO.md',
  'docs/backlog.md',
  '.takt/backlog.md',
];

const REPORT_FILES: Readonly<Record<Extract<IssueScoutSourceId, 'dependency_report' | 'security_report' | 'benchmark_report' | 'lint_type_debt'>, {
  path: string;
  lane: RecursiveAutomationLane;
  title: string;
}>> = {
  dependency_report: {
    path: '.devloop/dependency-report.json',
    lane: 'dependencies',
    title: 'Address dependency report findings',
  },
  security_report: {
    path: '.devloop/security-report.json',
    lane: 'security_hardening',
    title: 'Address security report findings',
  },
  benchmark_report: {
    path: '.devloop/benchmark-report.json',
    lane: 'performance',
    title: 'Address benchmark regression findings',
  },
  lint_type_debt: {
    path: '.devloop/lint-type-report.json',
    lane: 'idiomatic_refactor',
    title: 'Address lint and type debt findings',
  },
};

const LANE_PRIORITY: Readonly<Record<RecursiveAutomationLane, number>> = {
  docs_tests_tooling: 0,
  security_hardening: 1,
  dependencies: 2,
  performance: 3,
  idiomatic_refactor: 4,
  feature_improvement: 5,
};

const RISK_SCORE: Readonly<Record<IssueScoutRiskBucket, number>> = {
  low: 0,
  medium: 30,
  high: 100,
};

function sanitizeText(text: string): string {
  return sanitizeSensitiveText(text).replace(/\s+/g, ' ').trim();
}

function normalizeKey(text: string): string {
  return sanitizeText(text).toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function slug(text: string): string {
  return normalizeKey(text).replaceAll(' ', '-').slice(0, 64);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function labelsForLane(lane: RecursiveAutomationLane, category: AutomationPolicyCategory): string[] {
  const label = lane.replaceAll('_', '-');
  return unique([
    'automation',
    'recursive-automation',
    `lane:${label}`,
    category === 'mechanical' ? 'mechanical' : 'auto-recursive',
  ]);
}

function riskForCandidate(input: {
  lane: RecursiveAutomationLane;
  policyCategory: AutomationPolicyCategory;
  title: string;
  summary: string;
}): IssueScoutRiskBucket {
  if (input.policyCategory === 'product_policy' || input.policyCategory === 'human_policy') {
    return 'high';
  }
  const text = `${input.title}\n${input.summary}`;
  if (/\b(cross[- ]?module|migration|public api|auth|billing|pricing|retention|infra)\b/iu.test(text)) {
    return 'high';
  }
  if (input.lane === 'feature_improvement' || input.lane === 'security_hardening' || input.lane === 'dependencies') {
    return 'medium';
  }
  return 'low';
}

export function buildIssueScoutCandidate(input: {
  sourceId: IssueScoutSourceId;
  title: string;
  summary: string;
  lane?: RecursiveAutomationLane;
  evidence?: readonly IssueScoutArtifact[];
  acceptanceCriteria?: readonly string[];
  verificationCommands?: readonly string[];
  expectedChangedSurfaces?: readonly string[];
}): IssueScoutCandidate {
  const laneClassification = classifyRecursiveAutomationLane({
    title: input.title,
    body: input.summary,
    labels: input.lane === undefined ? [] : [`lane:${input.lane}`],
  });
  const lane = input.lane ?? laneClassification.lane;
  const definition = getRecursiveAutomationLaneDefinition(lane);
  const policyCategory = laneClassification.requiresHumanReview ? 'human_policy' : definition.policyCategory;
  const riskBucket = riskForCandidate({
    lane,
    policyCategory,
    title: input.title,
    summary: input.summary,
  });

  return {
    id: `${input.sourceId}:${slug(input.title)}`,
    sourceId: input.sourceId,
    title: sanitizeText(input.title),
    summary: sanitizeText(input.summary),
    lane,
    policyCategory,
    riskBucket,
    evidence: input.evidence ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [
      'Keep the change scoped to the evidence in this issue.',
      'Add or update tests/docs for the changed behavior.',
      'Do not change product direction, public contracts, pricing, auth, retention, or security posture without human approval.',
    ],
    verificationCommands: input.verificationCommands ?? definition.defaultVerification,
    escalationCriteria: definition.humanReviewEscalation,
    expectedChangedSurfaces: input.expectedChangedSurfaces ?? definition.expectedChangedSurfaces,
    labels: labelsForLane(lane, policyCategory),
  };
}

function makeObservation(input: {
  sourceId: IssueScoutSourceId;
  status: IssueScoutObservationStatus;
  summary: string;
  candidates?: readonly IssueScoutCandidate[];
  nextActions?: readonly string[];
  artifacts?: readonly IssueScoutArtifact[];
}): IssueScoutObservation {
  return {
    sourceId: input.sourceId,
    status: input.status,
    summary: input.summary,
    candidates: input.candidates ?? [],
    nextActions: input.nextActions ?? [],
    artifacts: input.artifacts ?? [],
  };
}

async function scanGithubIssues(context: IssueScoutSourceContext): Promise<IssueScoutObservation> {
  const report = await scanIssues({
    repoPath: context.repoPath,
    repo: context.repo,
    env: context.env,
    runner: context.runner,
  });
  if (!report.passed) {
    return makeObservation({
      sourceId: 'github_issues',
      status: 'warning',
      summary: report.message,
      nextActions: report.retryAfterSeconds === undefined ? ['retry after GitHub CLI is available'] : [`retry after ${report.retryAfterSeconds}s`],
    });
  }

  const candidates = report.candidates.map((issue) => buildIssueScoutCandidate({
    sourceId: 'github_issues',
    title: issue.title,
    summary: `Existing GitHub issue #${issue.number}: ${issue.reason}`,
    lane: issue.mode === 'auto_merge_candidate' ? 'docs_tests_tooling' : undefined,
    evidence: [{ kind: 'github', url: issue.url, summary: `GitHub issue #${issue.number}` }],
    acceptanceCriteria: [
      `Resolve or advance GitHub issue #${issue.number}.`,
      'Keep changes inside the issue scope and existing product behavior.',
      'Escalate to human review if the implementation changes public policy or product commitments.',
    ],
  }));

  return makeObservation({
    sourceId: 'github_issues',
    status: 'success',
    summary: report.message,
    candidates,
    artifacts: candidates.flatMap((candidate) => candidate.evidence),
  });
}

function parseBacklogLine(line: string): string | undefined {
  const checkbox = /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/u.exec(line);
  if (checkbox?.[1]) return checkbox[1];
  const bullet = /^\s*[-*]\s+(?:TODO|FIXME|BUG|PERF|SECURITY)?[:\s-]+(.+)$/iu.exec(line);
  if (bullet?.[1]) return bullet[1];
  return undefined;
}

function scanLocalBacklog(context: IssueScoutSourceContext): IssueScoutObservation {
  const candidates: IssueScoutCandidate[] = [];
  const artifacts: IssueScoutArtifact[] = [];

  for (const file of context.backlogFiles) {
    const filePath = resolve(context.repoPath, file);
    if (!existsSync(filePath)) {
      continue;
    }
    const relativePath = relative(context.repoPath, filePath);
    const content = readFileSync(filePath, 'utf-8');
    artifacts.push({ kind: 'file', path: relativePath, summary: `local backlog file ${relativePath}` });
    content.split('\n').forEach((line, index) => {
      const title = parseBacklogLine(line);
      if (title === undefined) {
        return;
      }
      candidates.push(buildIssueScoutCandidate({
        sourceId: 'local_backlog',
        title,
        summary: `${relativePath}:${index + 1} backlog item`,
        evidence: [{ kind: 'file', path: `${relativePath}:${index + 1}`, summary: sanitizeText(line) }],
      }));
    });
  }

  if (artifacts.length === 0) {
    return makeObservation({
      sourceId: 'local_backlog',
      status: 'warning',
      summary: `no local backlog files found: ${context.backlogFiles.join(', ')}`,
      nextActions: ['add a backlog file or rely on other issue-scout sources'],
    });
  }

  return makeObservation({
    sourceId: 'local_backlog',
    status: 'success',
    summary: `found ${candidates.length} backlog candidate(s)`,
    candidates,
    artifacts,
  });
}

async function scanTodoComments(context: IssueScoutSourceContext): Promise<IssueScoutObservation> {
  const rgCommand = context.runner.resolveCommand('rg', context.env);
  if (rgCommand === undefined) {
    return makeObservation({
      sourceId: 'todo_scan',
      status: 'warning',
      summary: 'command not found: rg',
      nextActions: ['install ripgrep or skip todo_scan'],
    });
  }

  const result = await context.runner.exec(
    rgCommand,
    ['--line-number', '--no-heading', '--glob', '!node_modules/**', '--glob', '!dist/**', '\\b(TODO|FIXME|PERF|SECURITY|dependency)\\b'],
    { cwd: context.repoPath, env: context.env, timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0 && result.stdout.trim().length === 0) {
    return makeObservation({
      sourceId: 'todo_scan',
      status: 'success',
      summary: 'no TODO/FIXME candidates found',
    });
  }

  const candidates = result.stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 25)
    .map((line) => {
      const [path = 'unknown', lineNumber = '0', ...rest] = line.split(':');
      const text = rest.join(':').trim();
      return buildIssueScoutCandidate({
        sourceId: 'todo_scan',
        title: `Address ${basename(path)} TODO at line ${lineNumber}`,
        summary: text,
        evidence: [{ kind: 'file', path: `${path}:${lineNumber}`, summary: text }],
      });
    });

  return makeObservation({
    sourceId: 'todo_scan',
    status: 'success',
    summary: `found ${candidates.length} TODO/FIXME candidate(s)`,
    candidates,
    artifacts: candidates.flatMap((candidate) => candidate.evidence),
  });
}

function readReportSource(sourceId: Extract<IssueScoutSourceId, 'dependency_report' | 'security_report' | 'benchmark_report' | 'lint_type_debt'>): IssueScoutSource {
  return {
    id: sourceId,
    scan(context) {
      const config = REPORT_FILES[sourceId];
      const filePath = resolve(context.repoPath, config.path);
      if (!existsSync(filePath)) {
        return makeObservation({
          sourceId,
          status: 'warning',
          summary: `report not found: ${config.path}`,
          nextActions: [`write ${config.path} before enabling ${sourceId}`],
        });
      }
      const raw = sanitizeText(readFileSync(filePath, 'utf-8')).slice(0, 2_000);
      const candidate = buildIssueScoutCandidate({
        sourceId,
        title: config.title,
        summary: raw || `${config.path} exists but is empty`,
        lane: config.lane,
        evidence: [{ kind: 'file', path: config.path, summary: `${sourceId} report` }],
      });
      return makeObservation({
        sourceId,
        status: 'success',
        summary: `loaded ${config.path}`,
        candidates: [candidate],
        artifacts: candidate.evidence,
      });
    },
  };
}

function scanLedgerEvents(context: IssueScoutSourceContext): IssueScoutObservation {
  const events = readRawDevloopLedgerEvents(context.ledgerPath);
  const repairFailures = events
    .filter((event) => event.eventType === 'devloop_repair_attempt' && event.status === 'failed')
    .slice(-5);
  const candidates = repairFailures.map((event) => buildIssueScoutCandidate({
    sourceId: 'ledger_events',
    title: `Investigate repeated repair failure for PR #${String(event.prNumber ?? 'unknown')}`,
    summary: String(event.reason ?? event.blockerSummary ?? 'repair attempt failed'),
    lane: 'idiomatic_refactor',
    evidence: [{ kind: 'ledger', summary: `ledger event ${event.eventId}` }],
  }));

  return makeObservation({
    sourceId: 'ledger_events',
    status: 'success',
    summary: `read ${events.length} ledger event(s)`,
    candidates,
    artifacts: [{ kind: 'ledger', path: context.ledgerPath, summary: 'devloop ledger' }],
  });
}

export function createIssueScoutSourceRegistry(): readonly IssueScoutSource[] {
  return [
    { id: 'github_issues', scan: scanGithubIssues },
    { id: 'local_backlog', scan: scanLocalBacklog },
    { id: 'todo_scan', scan: scanTodoComments },
    readReportSource('dependency_report'),
    readReportSource('security_report'),
    readReportSource('benchmark_report'),
    readReportSource('lint_type_debt'),
    { id: 'ledger_events', scan: scanLedgerEvents },
  ];
}

export function scoreIssueScoutCandidate(candidate: IssueScoutCandidate): IssueScoutSelection {
  const verificationCost = Math.min(candidate.verificationCommands.length * 5, 20);
  const blastRadius = Math.min(candidate.expectedChangedSurfaces.length * 2, 12);
  const score = RISK_SCORE[candidate.riskBucket] + LANE_PRIORITY[candidate.lane] + verificationCost + blastRadius;
  return {
    candidate,
    score,
    reasons: [
      `risk=${candidate.riskBucket}`,
      `lane=${candidate.lane}`,
      `verification=${candidate.verificationCommands.length}`,
      `surfaces=${candidate.expectedChangedSurfaces.length}`,
    ],
  };
}

function candidateKey(candidate: IssueScoutCandidate): string {
  return normalizeKey(`${candidate.lane} ${candidate.title}`);
}

function existingWorkKeys(existingWork: readonly ExistingIssueScoutWork[]): Set<string> {
  const keys = new Set<string>();
  for (const item of existingWork) {
    keys.add(normalizeKey(item.title));
    if (item.body !== undefined) keys.add(normalizeKey(item.body).slice(0, 120));
    if (item.branchName !== undefined) keys.add(normalizeKey(item.branchName));
  }
  return keys;
}

function isDuplicate(candidate: IssueScoutCandidate, keys: Set<string>): boolean {
  const key = candidateKey(candidate);
  if (keys.has(key) || keys.has(normalizeKey(candidate.title))) {
    return true;
  }
  const branchSlug = slug(candidate.title);
  return [...keys].some((existing) => existing.includes(key) || existing.includes(branchSlug));
}

function latestBackoff(candidate: IssueScoutCandidate, events: readonly DevloopLedgerEvent[], now: Date): string | undefined {
  const key = candidateKey(candidate);
  const topLevel = events
    .filter((event) => event.eventType === 'devloop_issue_scout')
    .filter((event) => event.candidateKey === key && typeof event.retryAfter === 'string')
    .map((event) => String(event.retryAfter));
  const nested = events
    .filter((event) => event.eventType === 'devloop_issue_scout')
    .flatMap((event) => Array.isArray(event.skipped) ? event.skipped : [])
    .flatMap((item) => {
      const skipped = item as { candidateKey?: unknown; retryAfter?: unknown };
      return skipped.candidateKey === key && typeof skipped.retryAfter === 'string' ? [skipped.retryAfter] : [];
    });
  const matching = [...topLevel, ...nested]
    .sort()
    .at(-1);
  if (matching === undefined) {
    return undefined;
  }
  return Date.parse(matching) > now.getTime() ? matching : undefined;
}

export function generateMaintenanceIssue(candidate: IssueScoutCandidate): GeneratedIssueDraft {
  const body = [
    `## Lane`,
    candidate.lane.replaceAll('_', '-'),
    '',
    '## Evidence',
    candidate.evidence.length > 0
      ? candidate.evidence.map((item) => `- ${item.path ?? item.url ?? item.kind}: ${item.summary}`).join('\n')
      : '- issue-scout generated this from a typed source observation',
    '',
    '## Acceptance Criteria',
    candidate.acceptanceCriteria.map((item) => `- ${item}`).join('\n'),
    '',
    '## Verification',
    candidate.verificationCommands.map((item) => `- \`${item}\``).join('\n'),
    '',
    '## Product-Policy Escalation',
    candidate.escalationCriteria.map((item) => `- Stop for human review if this work touches ${item}.`).join('\n'),
    '',
    '## Expected Changed Surfaces',
    candidate.expectedChangedSurfaces.map((item) => `- \`${item}\``).join('\n'),
  ].join('\n');

  return {
    title: candidate.title,
    body,
    labels: candidate.labels,
    candidateId: candidate.id,
  };
}

async function loadExistingWork(context: IssueScoutSourceContext, provided: readonly ExistingIssueScoutWork[] | undefined): Promise<readonly ExistingIssueScoutWork[]> {
  if (provided !== undefined) {
    return provided;
  }
  const ghCommand = context.runner.resolveCommand('gh', context.env);
  if (ghCommand === undefined) {
    return [];
  }
  const items: ExistingIssueScoutWork[] = [];
  const common = context.repo === undefined ? [] : ['--repo', context.repo];
  const issueResult = await context.runner.exec(
    ghCommand,
    ['issue', 'list', '--state', 'open', '--json', 'number,title,body', '--limit', '100', ...common],
    { cwd: context.repoPath, env: context.env, timeoutMs: 30_000 },
  );
  if (issueResult.exitCode === 0) {
    try {
      const parsed = JSON.parse(issueResult.stdout) as Array<{ number?: number; title?: string; body?: string }>;
      for (const issue of parsed) {
        if (issue.title !== undefined) {
          items.push({ title: issue.title, body: issue.body, issueNumber: issue.number });
        }
      }
    } catch {
      // Existing work only improves dedupe. Invalid GitHub JSON must not fail issue-scout discovery.
    }
  }
  const prResult = await context.runner.exec(
    ghCommand,
    ['pr', 'list', '--state', 'open', '--json', 'number,title,body,headRefName', '--limit', '100', ...common],
    { cwd: context.repoPath, env: context.env, timeoutMs: 30_000 },
  );
  if (prResult.exitCode === 0) {
    try {
      const parsed = JSON.parse(prResult.stdout) as Array<{ number?: number; title?: string; body?: string; headRefName?: string }>;
      for (const pr of parsed) {
        if (pr.title !== undefined) {
          items.push({ title: pr.title, body: pr.body, branchName: pr.headRefName, prNumber: pr.number });
        }
      }
    } catch {
      // Keep discovery deterministic even if one optional dedupe query fails.
    }
  }
  return items;
}

async function createGithubIssue(options: {
  draft: GeneratedIssueDraft;
  context: IssueScoutSourceContext;
}): Promise<string | undefined> {
  const ghCommand = options.context.runner.resolveCommand('gh', options.context.env);
  if (ghCommand === undefined) {
    return undefined;
  }
  const args = [
    'issue',
    'create',
    '--title',
    options.draft.title,
    '--body',
    options.draft.body,
  ];
  for (const label of options.draft.labels) {
    args.push('--label', label);
  }
  if (options.context.repo !== undefined) {
    args.push('--repo', options.context.repo);
  }
  const result = await options.context.runner.exec(ghCommand, args, {
    cwd: options.context.repoPath,
    env: options.context.env,
    timeoutMs: 60_000,
  });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

export async function runIssueScout(options: RunIssueScoutOptions = {}): Promise<IssueScoutReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  const now = options.now ?? new Date();
  const registry = options.sources ?? createIssueScoutSourceRegistry();
  const enabledSourceIds = new Set<IssueScoutSourceId>(options.sourceIds ?? registry.map((source) => source.id));
  const context: IssueScoutSourceContext = {
    repoPath,
    repo: options.repo,
    env,
    runner,
    ledgerPath,
    now,
    backlogFiles: options.backlogFiles ?? DEFAULT_BACKLOG_FILES,
  };

  const observations = await Promise.all(registry
    .filter((source) => enabledSourceIds.has(source.id))
    .map((source) => Promise.resolve(source.scan(context))));
  const candidates = observations.flatMap((observation) => observation.candidates);
  const existing = await loadExistingWork(context, options.existingWork);
  const keys = existingWorkKeys(existing);
  const ledgerEvents = readRawDevloopLedgerEvents(ledgerPath);
  const skipped: SkippedIssueScoutCandidate[] = [];
  const eligible: IssueScoutCandidate[] = [];

  for (const candidate of candidates) {
    const retryAfter = latestBackoff(candidate, ledgerEvents, now);
    if (retryAfter !== undefined) {
      skipped.push({ candidate, stopRule: 'backoff active', reason: 'candidate is still in retry backoff', retryAfter });
      continue;
    }
    if (candidate.policyCategory === 'product_policy' || candidate.policyCategory === 'human_policy' || candidate.riskBucket === 'high') {
      skipped.push({ candidate, stopRule: 'Unsafe or too broad', reason: `${candidate.policyCategory} work requires human review` });
      continue;
    }
    if (isDuplicate(candidate, keys)) {
      skipped.push({ candidate, stopRule: 'Duplicate or already covered', reason: 'matching issue, PR, branch, or ledger key already exists' });
      continue;
    }
    eligible.push(candidate);
    keys.add(candidateKey(candidate));
  }

  const selected = eligible
    .map(scoreIssueScoutCandidate)
    .sort((left, right) => left.score - right.score || left.candidate.title.localeCompare(right.candidate.title))
    .slice(0, options.maxSelections ?? 3);
  const wouldCreate = selected.map((selection) => generateMaintenanceIssue(selection.candidate));
  const createdIssues: string[] = [];

  if (options.createIssues === true && options.dryRun !== true) {
    for (const draft of wouldCreate) {
      const created = await createGithubIssue({ draft, context });
      if (created !== undefined) {
        createdIssues.push(created);
      }
    }
  }

  const retryAfter = selected.length === 0 ? new Date(now.getTime() + 60 * 60 * 1000).toISOString() : undefined;
  appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_issue_scout', {
    repoPath,
    observations: observations.map((observation) => ({
      sourceId: observation.sourceId,
      status: observation.status,
      summary: observation.summary,
      candidates: observation.candidates.length,
    })),
    candidateCount: candidates.length,
    selected: selected.map((selection) => ({
      candidateId: selection.candidate.id,
      candidateKey: candidateKey(selection.candidate),
      score: selection.score,
      lane: selection.candidate.lane,
    })),
    skipped: skipped.map((item) => ({
      candidateId: item.candidate.id,
      candidateKey: candidateKey(item.candidate),
      stopRule: item.stopRule,
      reason: item.reason,
      retryAfter: item.retryAfter,
    })),
    stopRule: selected.length === 0 ? 'no candidates' : undefined,
    retryAfter,
  }, now));

  return {
    passed: observations.every((observation) => observation.status !== 'error'),
    message: selected.length > 0
      ? `issue-scout selected ${selected.length} candidate(s)`
      : 'issue-scout found no eligible candidates',
    observations,
    selected,
    skipped,
    wouldCreate,
    createdIssues,
    ledgerPath,
  };
}

export function formatIssueScoutReport(report: IssueScoutReport): string {
  const lines = [
    report.passed ? 'devloopd issue-scout passed' : 'devloopd issue-scout failed',
    report.message,
    `Ledger: ${report.ledgerPath}`,
  ];
  for (const observation of report.observations) {
    lines.push(`- ${observation.sourceId}: ${observation.status} - ${observation.summary}`);
  }
  if (report.wouldCreate.length > 0) {
    lines.push('Would create:');
    lines.push(...report.wouldCreate.map((draft) => `- ${draft.title} [${draft.labels.join(', ')}]`));
  }
  if (report.createdIssues.length > 0) {
    lines.push('Created:');
    lines.push(...report.createdIssues.map((url) => `- ${url}`));
  }
  if (report.skipped.length > 0) {
    lines.push('Skipped:');
    lines.push(...report.skipped.map((item) => `- ${item.candidate.title}: ${item.stopRule} - ${item.reason}`));
  }
  return lines.join('\n');
}
