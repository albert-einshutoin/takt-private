import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
import {
  classifyIssueScoutDecision,
  DecisionGenerationError,
  ensureDecisionForIssueScoutCandidate,
  validateIssueScoutDecisionCandidate,
} from './decisionGeneration.js';
import { DecisionStore, DecisionStoreError } from './decisionStore.js';

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
  | 'human revision requested'
  | 'human decision skipped'
  | 'decision generation failed'
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
  laneEvidence: readonly string[];
}

export type DependencyUpdateKind = 'patch' | 'minor' | 'major' | 'breaking' | 'unknown';

export interface RecursiveLaneCandidateInput {
  sourceId: IssueScoutSourceId;
  title: string;
  summary: string;
  lane: RecursiveAutomationLane;
  evidence?: readonly IssueScoutArtifact[];
  baselineMetric?: string;
  targetMetric?: string;
  verificationCommand?: string;
  changelogUrls?: readonly string[];
  advisoryUrls?: readonly string[];
  currentVersion?: string;
  targetVersion?: string;
  updateKind?: DependencyUpdateKind;
  threatEvidence?: string;
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
  decisionId?: string;
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
  batchFailure?: IssueScoutBatchFailure;
}

export type IssueScoutBatchFailureCode =
  | 'candidate_count_exceeded'
  | 'candidate_invalid'
  | 'candidate_bytes_exceeded';

export interface IssueScoutBatchFailure {
  code: IssueScoutBatchFailureCode;
  candidateCount: number;
  candidateBytes?: number;
  maxCandidateCount: number;
  maxBatchBytes: number;
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

export const ISSUE_SCOUT_MAX_CANDIDATES = 256;
export const ISSUE_SCOUT_MAX_BATCH_BYTES = 256 * 1024;
export const ISSUE_SCOUT_MAX_CANDIDATE_TEXT_LENGTH = 4_000;
const ISSUE_SCOUT_MAX_CANDIDATE_TEXT_BYTES = 16 * 1024;
const ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH = 50;
const ISSUE_SCOUT_MAX_SKIPPED_SUMMARY = 50;
const ISSUE_SCOUT_MAX_OBSERVATION_SUMMARY = 50;
const ISSUE_SCOUT_SUMMARY_TEXT_LENGTH = 512;
const SOURCE_TEXT_TRUNCATION_MARKER = ' [TRUNCATED]';
const SOURCE_ARRAY_OMISSION_MARKER = (count: number) => `[OMITTED ${count} ITEMS]`;
const SOURCE_EVIDENCE_INCOMPLETE_REASON =
  'Source evidence was truncated or omitted; inspect the original source.';
const ISSUE_SCOUT_MAX_SOURCE_TEXT_LENGTH = 3_000;

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

function sourceTextIsIncomplete(text: string): boolean {
  return text.includes(SOURCE_TEXT_TRUNCATION_MARKER.trim())
    || /\[OMITTED \d+ ITEMS\]/u.test(text);
}

function boundSourceTextWithStatus(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= ISSUE_SCOUT_MAX_SOURCE_TEXT_LENGTH) {
    return { text, truncated: sourceTextIsIncomplete(text) };
  }
  const prefixLength = ISSUE_SCOUT_MAX_SOURCE_TEXT_LENGTH
    - SOURCE_TEXT_TRUNCATION_MARKER.length;
  return {
    text: `${text.slice(0, prefixLength)}${SOURCE_TEXT_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function boundSourceText(text: string): string {
  return boundSourceTextWithStatus(text).text;
}

function sanitizeText(text: string): string {
  // Bound raw source text before any broad secret or normalization regex runs.
  // The deterministic marker contains no attacker-controlled suffix.
  return sanitizeSensitiveText(boundSourceText(text)).replace(/\s+/g, ' ').trim();
}

function sanitizeBatchText(text: string): string {
  // The generic sanitizer has deliberately broad assignment matching. Avoid
  // feeding it large benign strings when no sensitive syntax is even present.
  const sensitiveSanitized = /(?:api[_-]?key|access[_-]?key|token|password|secret|authorization|cookie|private[_-]?key|sk-|ghp_|xox|:\/\/|(?:^|\s)(?:-u|--user|--proxy-user))/iu.test(text)
    ? sanitizeSensitiveText(text)
    : text;
  let controlSanitized = '';
  let segmentStart = 0;
  for (let index = 0; index < sensitiveSanitized.length; index += 1) {
    const code = sensitiveSanitized.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      controlSanitized += `${sensitiveSanitized.slice(segmentStart, index)} `;
      segmentStart = index + 1;
    }
  }
  controlSanitized += sensitiveSanitized.slice(segmentStart);
  return controlSanitized
    .replace(/\bhttps?:\/\/[^\s)\]}]+/giu, '[REDACTED URL]')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, '[REDACTED PATH]')
    .replace(/\/(?:[^/\s]+\/)+[^,\s.;)\]}]*/gu, '[REDACTED PATH]')
    .replace(/\s+/gu, ' ')
    .trim();
}

class IssueScoutCandidatePreflightError extends Error {
  readonly code: IssueScoutBatchFailureCode;
  readonly candidateBytes?: number;

  constructor(code: IssueScoutBatchFailureCode, candidateBytes?: number) {
    super(`Issue Scout candidate preflight failed: ${code}`);
    this.name = 'IssueScoutCandidatePreflightError';
    this.code = code;
    this.candidateBytes = candidateBytes;
  }
}

export function measureIssueScoutCandidateBatchBytes(
  candidates: readonly IssueScoutCandidate[],
): number {
  if (candidates.length > ISSUE_SCOUT_MAX_CANDIDATES) {
    throw new IssueScoutCandidatePreflightError('candidate_count_exceeded');
  }
  let bytes = 0;
  const addString = (value: unknown): void => {
    // Length and array shape checks intentionally precede sanitization. This
    // prevents broad secret-matching regexes from receiving attacker-sized text.
    if (typeof value !== 'string' || value.length > ISSUE_SCOUT_MAX_CANDIDATE_TEXT_LENGTH) {
      throw new IssueScoutCandidatePreflightError('candidate_invalid', bytes);
    }
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (valueBytes > ISSUE_SCOUT_MAX_CANDIDATE_TEXT_BYTES) {
      throw new IssueScoutCandidatePreflightError('candidate_invalid', bytes);
    }
    bytes += valueBytes;
    if (bytes > ISSUE_SCOUT_MAX_BATCH_BYTES) {
      throw new IssueScoutCandidatePreflightError('candidate_bytes_exceeded', bytes);
    }
  };
  const addStringArray = (values: unknown): void => {
    if (!Array.isArray(values) || values.length > ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH) {
      throw new IssueScoutCandidatePreflightError('candidate_invalid', bytes);
    }
    for (const value of values) addString(value);
  };

  for (const candidate of candidates) {
    addString(candidate.id);
    addString(candidate.sourceId);
    addString(candidate.title);
    addString(candidate.summary);
    addString(candidate.lane);
    addString(candidate.policyCategory);
    addString(candidate.riskBucket);
    if (
      !Array.isArray(candidate.evidence)
      || candidate.evidence.length > ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH
    ) {
      throw new IssueScoutCandidatePreflightError('candidate_invalid', bytes);
    }
    for (const artifact of candidate.evidence) {
      if (artifact === null || typeof artifact !== 'object') {
        throw new IssueScoutCandidatePreflightError('candidate_invalid', bytes);
      }
      addString(artifact.kind);
      if (artifact.path !== undefined) addString(artifact.path);
      if (artifact.url !== undefined) addString(artifact.url);
      addString(artifact.summary);
    }
    addStringArray(candidate.acceptanceCriteria);
    addStringArray(candidate.verificationCommands);
    addStringArray(candidate.escalationCriteria);
    addStringArray(candidate.expectedChangedSurfaces);
    addStringArray(candidate.labels);
    addStringArray(candidate.laneEvidence);
  }
  return bytes;
}

function issueScoutSummaryDigest(input: {
  observations: readonly IssueScoutObservation[];
  candidateCount: number;
  selected: readonly IssueScoutSelection[];
  skipped: readonly SkippedIssueScoutCandidate[];
  batchFailure?: IssueScoutBatchFailure;
}): string {
  // Only bounded structural fields enter this public digest. Candidate IDs,
  // titles, paths, URLs, and other attacker-controlled secrets are excluded.
  const observationCounts: Record<string, number> = {};
  for (const observation of input.observations) {
    const key = `${observation.sourceId}:${observation.status}`;
    observationCounts[key] = (observationCounts[key] ?? 0) + 1;
  }
  const structuralSummary = {
    observationCounts,
    observationCount: input.observations.length,
    candidateCount: input.candidateCount,
    selected: input.selected.map((selection) => ({
      sourceId: selection.candidate.sourceId,
      lane: selection.candidate.lane,
      riskBucket: selection.candidate.riskBucket,
      score: selection.score,
    })),
    skipped: input.skipped.slice(0, ISSUE_SCOUT_MAX_SKIPPED_SUMMARY).map((item) => ({
      sourceId: item.candidate.sourceId,
      lane: item.candidate.lane,
      stopRule: item.stopRule,
    })),
    skippedCount: input.skipped.length,
    batchFailure: input.batchFailure,
  };
  return createHash('sha256').update(JSON.stringify(structuralSummary), 'utf8').digest('hex');
}

function normalizeKey(text: string): string {
  return sanitizeText(text).toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function normalizeSanitizedKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function slug(text: string): string {
  return normalizeKey(text).replaceAll(' ', '-').slice(0, 64);
}

function slugFromSanitizedText(text: string): string {
  return normalizeSanitizedKey(text).replaceAll(' ', '-').slice(0, 64);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown> | undefined, names: readonly string[]): string | undefined {
  if (record === undefined) return undefined;
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string') {
      const bounded = boundSourceText(value);
      if (bounded.trim().length > 0) return sanitizeText(bounded);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
  }
  return undefined;
}

function readStringArrayField(record: Record<string, unknown> | undefined, names: readonly string[]): string[] {
  if (record === undefined) return [];
  const values: string[] = [];
  for (const name of names) {
    if (values.length >= ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH) break;
    const value = record[name];
    if (typeof value === 'string') {
      const bounded = boundSourceText(value);
      if (bounded.trim().length > 0) values.push(sanitizeText(bounded));
      continue;
    }
    if (Array.isArray(value)) {
      const remaining = ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH - values.length;
      const sampleCount = value.length > remaining
        ? Math.max(0, remaining - 1)
        : remaining;
      for (let index = 0; index < Math.min(value.length, sampleCount); index += 1) {
        const item = value[index];
        if (typeof item === 'string') {
          const bounded = boundSourceText(item);
          if (bounded.trim().length > 0) values.push(sanitizeText(bounded));
        } else if (typeof item === 'number' || typeof item === 'boolean') {
          values.push(String(item));
        }
      }
      const omittedCount = value.length - sampleCount;
      if (omittedCount > 0 && values.length < ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH) {
        values.push(SOURCE_ARRAY_OMISSION_MARKER(omittedCount));
      }
    }
  }
  return unique(values);
}

function parseReportRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) return parsed;
    if (Array.isArray(parsed)) {
      return parsed.find(isRecord);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeDependencyUpdateKind(value: string | undefined): DependencyUpdateKind | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase().replace(/[^a-z]+/gu, '_').replace(/^_+|_+$/gu, '');
  if (normalized === 'patch' || normalized === 'minor' || normalized === 'major' || normalized === 'breaking' || normalized === 'unknown') {
    return normalized;
  }
  return undefined;
}

function readRecursiveLane(value: unknown): RecursiveAutomationLane | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replaceAll('-', '_');
  if (
    normalized === 'feature_improvement'
    || normalized === 'performance'
    || normalized === 'dependencies'
    || normalized === 'security_hardening'
    || normalized === 'idiomatic_refactor'
    || normalized === 'docs_tests_tooling'
  ) {
    return normalized;
  }
  return undefined;
}

function parseVersionMajorMinorPatch(version: string | undefined): [number, number, number] | undefined {
  if (version === undefined) return undefined;
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function classifyDependencyUpdateKind(input: {
  currentVersion?: string;
  targetVersion?: string;
  summary?: string;
  updateKind?: DependencyUpdateKind;
}): DependencyUpdateKind {
  if (input.updateKind !== undefined && input.updateKind !== 'unknown') {
    return input.updateKind;
  }
  if (/\b(breaking|major migration|incompatible)\b/iu.test(
    boundSourceText(input.summary ?? ''),
  )) {
    return 'breaking';
  }
  const current = parseVersionMajorMinorPatch(input.currentVersion);
  const target = parseVersionMajorMinorPatch(input.targetVersion);
  if (current === undefined || target === undefined) {
    return 'unknown';
  }
  if (target[0] > current[0]) return 'major';
  if (target[1] > current[1]) return 'minor';
  if (target[2] > current[2]) return 'patch';
  return 'unknown';
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

function normalizeCandidateSourceText(value: string): {
  text: string;
  incomplete: boolean;
} {
  const bounded = boundSourceTextWithStatus(value);
  return {
    text: sanitizeText(bounded.text),
    incomplete: bounded.truncated,
  };
}

function normalizeCandidateSourceArray(values: readonly string[]): {
  values: string[];
  incomplete: boolean;
} {
  const oversized = values.length > ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH;
  const sampleCount = oversized
    ? ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH - 1
    : values.length;
  let incomplete = oversized;
  const normalized = values.slice(0, sampleCount).map((value) => {
    const item = normalizeCandidateSourceText(value);
    incomplete ||= item.incomplete;
    return item.text;
  });
  if (oversized) {
    normalized.push(SOURCE_ARRAY_OMISSION_MARKER(values.length - sampleCount));
  }
  return { values: normalized, incomplete };
}

function normalizeCandidateEvidence(values: readonly IssueScoutArtifact[]): {
  values: IssueScoutArtifact[];
  incomplete: boolean;
} {
  const oversized = values.length > ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH;
  const sampleCount = oversized
    ? ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH - 1
    : values.length;
  let incomplete = oversized;
  const normalized = values.slice(0, sampleCount).map((artifact) => {
    const summary = normalizeCandidateSourceText(artifact.summary);
    const path = artifact.path === undefined
      ? undefined
      : normalizeCandidateSourceText(artifact.path);
    const url = artifact.url === undefined
      ? undefined
      : normalizeCandidateSourceText(artifact.url);
    incomplete ||= summary.incomplete || path?.incomplete === true || url?.incomplete === true;
    return {
      kind: artifact.kind,
      summary: summary.text,
      ...(path === undefined ? {} : { path: path.text }),
      ...(url === undefined ? {} : { url: url.text }),
    };
  });
  return { values: normalized, incomplete };
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
  policyCategory?: AutomationPolicyCategory;
  riskBucket?: IssueScoutRiskBucket;
  laneEvidence?: readonly string[];
}): IssueScoutCandidate {
  const normalizedTitle = normalizeCandidateSourceText(input.title);
  const normalizedSummary = normalizeCandidateSourceText(input.summary);
  const title = normalizedTitle.text;
  const summary = normalizedSummary.text;
  const laneClassification = classifyRecursiveAutomationLane({
    title,
    body: summary,
    labels: input.lane === undefined ? [] : [`lane:${input.lane}`],
  });
  const lane = input.lane ?? laneClassification.lane;
  const definition = getRecursiveAutomationLaneDefinition(lane);
  const evidence = normalizeCandidateEvidence(input.evidence ?? []);
  const acceptanceCriteria = normalizeCandidateSourceArray(input.acceptanceCriteria ?? [
    'Keep the change scoped to the evidence in this issue.',
    'Add or update tests/docs for the changed behavior.',
    'Do not change product direction, public contracts, pricing, auth, retention, or security posture without human approval.',
  ]);
  const verificationCommands = normalizeCandidateSourceArray(
    input.verificationCommands ?? definition.defaultVerification,
  );
  const expectedChangedSurfaces = normalizeCandidateSourceArray(
    input.expectedChangedSurfaces ?? definition.expectedChangedSurfaces,
  );
  const laneEvidence = normalizeCandidateSourceArray(input.laneEvidence ?? []);
  const sourceEvidenceIncomplete = normalizedTitle.incomplete
    || normalizedSummary.incomplete
    || evidence.incomplete
    || acceptanceCriteria.incomplete
    || verificationCommands.incomplete
    || expectedChangedSurfaces.incomplete
    || laneEvidence.incomplete;
  const policyCategory = sourceEvidenceIncomplete
    ? 'human_policy'
    : input.policyCategory
      ?? (laneClassification.requiresHumanReview ? 'human_policy' : definition.policyCategory);
  const riskBucket = sourceEvidenceIncomplete
    ? 'high'
    : input.riskBucket ?? riskForCandidate({
      lane,
      policyCategory,
      title,
      summary,
    });
  const decisionAcceptanceCriteria = sourceEvidenceIncomplete
    ? acceptanceCriteria.values.slice(0, 20)
    : acceptanceCriteria.values;
  const decisionExpectedChangedSurfaces = sourceEvidenceIncomplete
    ? expectedChangedSurfaces.values.slice(0, 10)
    : expectedChangedSurfaces.values;
  const evidenceCapacity = ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH
    - decisionAcceptanceCriteria.length
    - decisionExpectedChangedSurfaces.length;
  const decisionEvidence = sourceEvidenceIncomplete
    ? [
      ...evidence.values.slice(0, Math.max(0, evidenceCapacity - 1)),
      { kind: 'ledger' as const, summary: SOURCE_EVIDENCE_INCOMPLETE_REASON },
    ]
    : evidence.values;
  const escalationCriteria = sourceEvidenceIncomplete
    ? [...definition.humanReviewEscalation, SOURCE_EVIDENCE_INCOMPLETE_REASON]
    : definition.humanReviewEscalation;
  const laneEvidenceCapacity = ISSUE_SCOUT_MAX_CANDIDATE_ARRAY_LENGTH
    - 2
    - escalationCriteria.length
    - (decisionExpectedChangedSurfaces.length > 0 ? 1 : 0);
  const explicitIncompleteLaneEvidence = laneEvidence.values.find(sourceTextIsIncomplete);
  const decisionLaneEvidence = sourceEvidenceIncomplete
    ? [
      ...laneEvidence.values
        .filter((value) => !sourceTextIsIncomplete(value))
        .slice(0, Math.max(
          0,
          laneEvidenceCapacity - (explicitIncompleteLaneEvidence === undefined ? 1 : 2),
        )),
      ...(explicitIncompleteLaneEvidence === undefined ? [] : [explicitIncompleteLaneEvidence]),
      'sourceEvidence=truncated_or_omitted',
    ]
    : laneEvidence.values;

  return {
    // A bounded prefix can collide with another truncated source. Such
    // candidates are always human/high-risk, so the ID can route review but
    // can never authorize automatic issue creation.
    id: `${input.sourceId}:${slugFromSanitizedText(title)}`,
    sourceId: input.sourceId,
    title,
    summary,
    lane,
    policyCategory,
    riskBucket,
    evidence: decisionEvidence,
    acceptanceCriteria: decisionAcceptanceCriteria,
    verificationCommands: verificationCommands.values,
    escalationCriteria,
    expectedChangedSurfaces: decisionExpectedChangedSurfaces,
    labels: labelsForLane(lane, policyCategory),
    laneEvidence: decisionLaneEvidence,
  };
}

function laneSpecificAcceptance(input: RecursiveLaneCandidateInput, updateKind: DependencyUpdateKind): string[] {
  switch (input.lane) {
    case 'feature_improvement':
      return [
        'Use only concrete evidence from failing UX tests, accepted TODOs, issue comments, or narrow behavior-gap reports.',
        'Keep the improvement scoped to existing accepted behavior.',
        'Create follow-up improvement issues only when new concrete evidence remains after the PR.',
        'Escalate product direction, new commitments, pricing, public API, auth, or security-posture changes to human review.',
      ];
    case 'performance':
      return [
        `Record baseline metric: ${input.baselineMetric ?? 'required before implementation'}.`,
        `Record target metric: ${input.targetMetric ?? 'required before implementation'}.`,
        'Preserve public behavior and API compatibility.',
        'Include before/after performance evidence in the PR body or devloop ledger.',
      ];
    case 'dependencies':
      return [
        `Classify update kind as ${updateKind}; breaking or major updates require human review.`,
        'Include changelog or advisory links when available.',
        'Run tests, build, lint, and relevant smoke checks for safe updates.',
        'Document rollback criteria for failed compatibility or security checks.',
      ];
    case 'security_hardening':
      return [
        `Record threat/risk evidence: ${input.threatEvidence ?? 'static analysis, advisory, unsafe default, secret hygiene, or hardening gap required'}.`,
        'Distinguish security posture changes from implementation hardening.',
        'Escalate posture changes to human review.',
        'Include verification commands that prove the hardening behavior.',
      ];
    case 'idiomatic_refactor':
      return [
        'Start from lint/type debt, duplicated patterns, obsolete APIs, unnecessary complexity, or language-specific best-practice evidence.',
        'Require characterization tests or existing tests before behavior-preserving refactors.',
        'Add why-comments only for business logic, memory, efficiency, or non-obvious implementation choices.',
        'Escalate any product behavior change to human review.',
      ];
    case 'docs_tests_tooling':
      return [
        'Keep changes mechanical and limited to docs, tests, fixtures, linting, formatting, or local tooling.',
        'Escalate docs that change product promises or tooling that changes release/security policy.',
      ];
  }
}

function laneSpecificVerification(input: RecursiveLaneCandidateInput): string[] {
  if (input.verificationCommand !== undefined) {
    return [input.verificationCommand];
  }
  switch (input.lane) {
    case 'dependencies':
      return ['npm run lint', 'npm run build', 'npm test', 'npm audit --audit-level=high'];
    case 'performance':
      return ['npm test -- issue-scout', 'npm run build'];
    case 'security_hardening':
      return ['npm test -- issue-scout product-policy-classifier', 'npm audit --audit-level=high'];
    default:
      return [...getRecursiveAutomationLaneDefinition(input.lane).defaultVerification];
  }
}

function laneEvidence(input: RecursiveLaneCandidateInput, updateKind: DependencyUpdateKind): string[] {
  return [
    input.baselineMetric !== undefined ? `baseline=${input.baselineMetric}` : undefined,
    input.targetMetric !== undefined ? `target=${input.targetMetric}` : undefined,
    input.currentVersion !== undefined ? `current=${input.currentVersion}` : undefined,
    input.targetVersion !== undefined ? `targetVersion=${input.targetVersion}` : undefined,
    updateKind !== 'unknown' ? `updateKind=${updateKind}` : undefined,
    ...(input.changelogUrls ?? []).map((url) => `changelog=${url}`),
    ...(input.advisoryUrls ?? []).map((url) => `advisory=${url}`),
    input.threatEvidence !== undefined ? `threat=${input.threatEvidence}` : undefined,
  ].filter((value): value is string => value !== undefined);
}

export function buildRecursiveLaneCandidate(input: RecursiveLaneCandidateInput): IssueScoutCandidate {
  const updateKind = input.lane === 'dependencies'
    ? classifyDependencyUpdateKind(input)
    : 'unknown';
  const humanReviewedDependency = updateKind === 'major' || updateKind === 'breaking';
  return buildIssueScoutCandidate({
    sourceId: input.sourceId,
    title: input.title,
    summary: input.summary,
    lane: input.lane,
    evidence: input.evidence,
    acceptanceCriteria: laneSpecificAcceptance(input, updateKind),
    verificationCommands: laneSpecificVerification(input),
    policyCategory: humanReviewedDependency ? 'human_policy' : undefined,
    riskBucket: humanReviewedDependency ? 'high' : undefined,
    laneEvidence: laneEvidence(input, updateKind),
  });
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
      const boundedLine = boundSourceText(line);
      const title = parseBacklogLine(boundedLine);
      if (title === undefined) {
        return;
      }
      candidates.push(buildIssueScoutCandidate({
        sourceId: 'local_backlog',
        title,
        summary: `${relativePath}:${index + 1} backlog item`,
        evidence: [{ kind: 'file', path: `${relativePath}:${index + 1}`, summary: sanitizeText(boundedLine) }],
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
    .map((line) => boundSourceText(line).trim())
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
      const rawContent = readFileSync(filePath, 'utf-8');
      const record = parseReportRecord(rawContent);
      const boundedRawSummary = boundSourceTextWithStatus(rawContent);
      const sanitizedRawSummary = sanitizeText(boundedRawSummary.text);
      const rawSummary = boundedRawSummary.truncated
        ? `${sanitizedRawSummary.slice(
          0,
          2_000 - SOURCE_TEXT_TRUNCATION_MARKER.length,
        )}${SOURCE_TEXT_TRUNCATION_MARKER}`
        : sanitizedRawSummary.slice(0, 2_000);
      // Report producers are intentionally schema-light; accepting common field aliases keeps the loop
      // useful while preserving typed lane evidence in the generated issue.
      const candidate = buildRecursiveLaneCandidate({
        sourceId,
        title: readStringField(record, ['title', 'name']) ?? config.title,
        summary: (readStringField(record, ['summary', 'description', 'reason', 'finding']) ?? rawSummary)
          || `${config.path} exists but is empty`,
        lane: config.lane,
        evidence: [{ kind: 'file', path: config.path, summary: `${sourceId} report` }],
        baselineMetric: config.lane === 'performance'
          ? readStringField(record, ['baselineMetric', 'baseline_metric', 'baseline'])
          : undefined,
        targetMetric: config.lane === 'performance'
          ? readStringField(record, ['targetMetric', 'target_metric', 'target'])
          : undefined,
        verificationCommand: readStringField(record, ['verificationCommand', 'verification_command', 'verification', 'verify']),
        changelogUrls: config.lane === 'dependencies'
          ? readStringArrayField(record, ['changelogUrls', 'changelog_urls', 'changelogs', 'changelog'])
          : undefined,
        advisoryUrls: config.lane === 'dependencies' || config.lane === 'security_hardening'
          ? readStringArrayField(record, ['advisoryUrls', 'advisory_urls', 'advisories', 'advisory'])
          : undefined,
        currentVersion: config.lane === 'dependencies'
          ? readStringField(record, ['currentVersion', 'current_version', 'current'])
          : undefined,
        targetVersion: config.lane === 'dependencies'
          ? readStringField(record, ['targetVersion', 'target_version', 'target', 'newVersion', 'new_version'])
          : undefined,
        updateKind: config.lane === 'dependencies'
          ? normalizeDependencyUpdateKind(readStringField(record, ['updateKind', 'update_kind', 'kind']))
          : undefined,
        threatEvidence: config.lane === 'security_hardening'
          ? readStringField(record, ['threatEvidence', 'threat_evidence', 'threat', 'risk'])
          : undefined,
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
  const repairCandidates = repairFailures.map((event) => buildRecursiveLaneCandidate({
    sourceId: 'ledger_events',
    title: `Investigate repeated repair failure for PR #${String(event.prNumber ?? 'unknown')}`,
    summary: String(event.reason ?? event.blockerSummary ?? 'repair attempt failed'),
    lane: 'idiomatic_refactor',
    evidence: [{ kind: 'ledger', summary: `ledger event ${event.eventId}` }],
  }));
  const followUpCandidates = events
    .filter((event) => event.eventType === 'devloop_follow_up_evidence' || event.eventType === 'devloop_recursive_follow_up')
    .slice(-10)
    .map((event) => {
      const lane = readRecursiveLane(event.lane) ?? 'feature_improvement';
      const evidence = readStringField(event, ['evidence', 'evidencePath', 'evidence_path', 'source']) ?? `ledger event ${event.eventId}`;
      return buildRecursiveLaneCandidate({
        sourceId: 'ledger_events',
        title: readStringField(event, ['title']) ?? `Follow up ${String(event.eventId)}`,
        summary: readStringField(event, ['summary', 'reason', 'description']) ?? evidence,
        lane,
        evidence: [{ kind: 'ledger', summary: evidence }],
        baselineMetric: readStringField(event, ['baselineMetric', 'baseline_metric', 'baseline']),
        targetMetric: readStringField(event, ['targetMetric', 'target_metric', 'target']),
        verificationCommand: readStringField(event, ['verificationCommand', 'verification_command', 'verification', 'verify']),
        changelogUrls: readStringArrayField(event, ['changelogUrls', 'changelog_urls', 'changelog']),
        advisoryUrls: readStringArrayField(event, ['advisoryUrls', 'advisory_urls', 'advisory']),
        currentVersion: readStringField(event, ['currentVersion', 'current_version', 'current']),
        targetVersion: readStringField(event, ['targetVersion', 'target_version', 'target']),
        updateKind: normalizeDependencyUpdateKind(readStringField(event, ['updateKind', 'update_kind', 'kind'])),
        threatEvidence: readStringField(event, ['threatEvidence', 'threat_evidence', 'threat', 'risk']),
      });
    });
  const candidates = [...repairCandidates, ...followUpCandidates];

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
  // Backoff/dedupe needs a stable routing key, not the full attacker-controlled
  // title. Bounding it prevents a single near-budget candidate from amplifying
  // sanitizer and comparison work in the per-candidate loop.
  return normalizeKey(`${candidate.lane} ${candidate.title.slice(0, 4_000)}`);
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
  const boundedTitle = candidate.title.slice(0, 4_000);
  if (keys.has(key) || keys.has(normalizeKey(boundedTitle))) {
    return true;
  }
  const branchSlug = slug(boundedTitle);
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
    ...(candidate.laneEvidence.length > 0
      ? [
          '## Lane Evidence',
          candidate.laneEvidence.map((item) => `- ${item}`).join('\n'),
          '',
        ]
      : []),
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
  const candidateCount = observations.reduce(
    (count, observation) => count + observation.candidates.length,
    0,
  );
  // Sources have already materialized their candidate arrays. Validate the
  // whole run here, before any decision write or per-candidate derivative
  // arrays can amplify an oversized or adversarial source response.
  const candidates = candidateCount <= ISSUE_SCOUT_MAX_CANDIDATES
    ? observations.flatMap((observation) => observation.candidates)
    : [];
  let preflightFailure: IssueScoutCandidatePreflightError | undefined;
  if (candidateCount <= ISSUE_SCOUT_MAX_CANDIDATES) {
    try {
      measureIssueScoutCandidateBatchBytes(candidates);
    } catch (error) {
      preflightFailure = error instanceof IssueScoutCandidatePreflightError
        ? error
        : new IssueScoutCandidatePreflightError('candidate_invalid');
    }
  }
  const batchFailure: IssueScoutBatchFailure | undefined = (
    candidateCount > ISSUE_SCOUT_MAX_CANDIDATES
      ? {
        code: 'candidate_count_exceeded',
        candidateCount,
        maxCandidateCount: ISSUE_SCOUT_MAX_CANDIDATES,
        maxBatchBytes: ISSUE_SCOUT_MAX_BATCH_BYTES,
      }
      : preflightFailure !== undefined
        ? {
          code: preflightFailure.code,
          candidateCount,
          ...(preflightFailure.candidateBytes === undefined
            ? {}
            : { candidateBytes: preflightFailure.candidateBytes }),
          maxCandidateCount: ISSUE_SCOUT_MAX_CANDIDATES,
          maxBatchBytes: ISSUE_SCOUT_MAX_BATCH_BYTES,
        }
        : undefined
  );
  if (batchFailure !== undefined) {
    const summaryDigest = issueScoutSummaryDigest({
      observations,
      candidateCount,
      selected: [],
      skipped: [],
      batchFailure,
    });
    appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_issue_scout', {
      observations: observations.slice(0, ISSUE_SCOUT_MAX_OBSERVATION_SUMMARY).map((observation) => ({
        sourceId: observation.sourceId,
        status: observation.status,
        candidateCount: observation.candidates.length,
      })),
      observationCount: observations.length,
      omittedObservationCount: Math.max(0, observations.length - ISSUE_SCOUT_MAX_OBSERVATION_SUMMARY),
      candidateCount,
      selected: [],
      selectedCount: 0,
      skipped: [],
      skippedCount: 0,
      omittedSkippedCount: 0,
      stopRule: 'batch limit exceeded',
      batchFailure,
      summaryDigest,
    }, now));
    return {
      passed: false,
      message: `issue-scout batch failed: ${batchFailure.code}`,
      observations,
      selected: [],
      skipped: [],
      wouldCreate: [],
      createdIssues: [],
      ledgerPath,
      batchFailure,
    };
  }
  const existing = await loadExistingWork(context, options.existingWork);
  const keys = existingWorkKeys(existing);
  const ledgerEvents = readRawDevloopLedgerEvents(ledgerPath);
  const skipped: SkippedIssueScoutCandidate[] = [];
  const eligible: IssueScoutCandidate[] = [];
  const decisionStore = new DecisionStore(repoPath, ledgerPath);
  const invalidDecisionCandidates = new Set<IssueScoutCandidate>();
  for (const candidate of candidates) {
    if (
      candidate.policyCategory !== 'product_policy'
      && candidate.policyCategory !== 'human_policy'
      && candidate.riskBucket !== 'high'
    ) {
      continue;
    }
    try {
      validateIssueScoutDecisionCandidate(candidate);
    } catch {
      invalidDecisionCandidates.add(candidate);
    }
  }

  for (const candidate of candidates) {
    const retryAfter = latestBackoff(candidate, ledgerEvents, now);
    if (retryAfter !== undefined) {
      skipped.push({ candidate, stopRule: 'backoff active', reason: 'candidate is still in retry backoff', retryAfter });
      continue;
    }
    if (isDuplicate(candidate, keys)) {
      skipped.push({ candidate, stopRule: 'Duplicate or already covered', reason: 'matching issue, PR, branch, or ledger key already exists' });
      continue;
    }
    if (candidate.policyCategory === 'product_policy' || candidate.policyCategory === 'human_policy' || candidate.riskBucket === 'high') {
      if (invalidDecisionCandidates.has(candidate)) {
        skipped.push({
          candidate,
          stopRule: 'decision generation failed',
          reason: 'decision generation failed: candidate_invalid',
        });
        continue;
      }
      try {
        // dryRun controls GitHub mutation, but the local decision ledger is the
        // durable human-approval boundary and must exist before this skip returns.
        const decision = ensureDecisionForIssueScoutCandidate(
          decisionStore,
          candidate,
          {
            repoPath,
            ...(options.repo === undefined ? {} : { repository: options.repo }),
          },
          now,
        );
        const outcome = classifyIssueScoutDecision(decision);
        if (outcome === 'approved') {
          eligible.push(candidate);
          keys.add(candidateKey(candidate));
          continue;
        }
        if (outcome === 'revision_requested') {
          skipped.push({
            candidate,
            stopRule: 'human revision requested',
            reason: 'the applied decision requires a revised candidate scope',
            decisionId: decision.request.decisionId,
          });
          continue;
        }
        if (outcome === 'skipped') {
          skipped.push({
            candidate,
            stopRule: 'human decision skipped',
            reason: 'the applied decision skips this candidate',
            decisionId: decision.request.decisionId,
          });
          continue;
        }
        skipped.push({
          candidate,
          stopRule: 'Unsafe or too broad',
          reason: `${candidate.policyCategory} work requires human review`,
          decisionId: decision.request.decisionId,
        });
      } catch (error) {
        const errorCode = (
          error instanceof DecisionGenerationError
          || error instanceof DecisionStoreError
        ) ? error.code : 'unknown';
        skipped.push({
          candidate,
          stopRule: 'decision generation failed',
          reason: `decision generation failed: ${errorCode}`,
        });
      }
      continue;
    }
    eligible.push(candidate);
    keys.add(candidateKey(candidate));
  }

  const selected = eligible
    .map(scoreIssueScoutCandidate)
    .sort((left, right) => left.score - right.score || left.candidate.title.localeCompare(right.candidate.title))
    .slice(0, Math.min(Math.max(options.maxSelections ?? 3, 0), 3));
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
  const decisionFailureCount = skipped.filter(
    (item) => item.stopRule === 'decision generation failed',
  ).length;
  const skippedSummary = skipped
    .slice(0, ISSUE_SCOUT_MAX_SKIPPED_SUMMARY)
    .map((item, index) => ({
      candidateRef: `${item.candidate.sourceId}:${item.candidate.lane}:${index + 1}`,
      // This sanitized correlation key preserves retry backoff across runs.
      candidateKey: candidateKey(item.candidate),
      stopRule: item.stopRule,
      reason: sanitizeBatchText(item.reason).slice(0, ISSUE_SCOUT_SUMMARY_TEXT_LENGTH),
      retryAfter: item.retryAfter,
      decisionId: item.decisionId,
    }));
  const summaryDigest = issueScoutSummaryDigest({
    observations,
    candidateCount,
    selected,
    skipped,
  });
  appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_issue_scout', {
    observations: observations.slice(0, ISSUE_SCOUT_MAX_OBSERVATION_SUMMARY).map((observation) => ({
      sourceId: observation.sourceId,
      status: observation.status,
      candidateCount: observation.candidates.length,
    })),
    observationCount: observations.length,
    omittedObservationCount: Math.max(0, observations.length - ISSUE_SCOUT_MAX_OBSERVATION_SUMMARY),
    candidateCount,
    selected: selected.map((selection, index) => ({
      candidateRef: `${selection.candidate.sourceId}:${selection.candidate.lane}:${index + 1}`,
      score: selection.score,
      lane: selection.candidate.lane,
    })),
    selectedCount: selected.length,
    skipped: skippedSummary,
    skippedCount: skipped.length,
    omittedSkippedCount: skipped.length - skippedSummary.length,
    stopRule: selected.length === 0 ? 'no candidates' : undefined,
    retryAfter,
    decisionFailureCount,
    summaryDigest,
  }, now));

  const baseMessage = selected.length > 0
    ? `issue-scout selected ${selected.length} candidate(s)`
    : 'issue-scout found no eligible candidates';
  return {
    passed: observations.every((observation) => observation.status !== 'error')
      && decisionFailureCount === 0,
    message: decisionFailureCount === 0
      ? baseMessage
      : `${baseMessage}; isolated ${decisionFailureCount} decision generation failure(s)`,
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
    lines.push(...report.skipped.map((item) => (
      `- ${item.candidate.title}: ${item.stopRule} - ${item.reason}`
      + (item.decisionId === undefined
        ? ''
        : item.stopRule === 'Unsafe or too broad'
          ? ` (Decision: ${item.decisionId}; status: pending)`
          : ` (Decision: ${item.decisionId}; outcome: ${item.stopRule})`)
    )));
  }
  return lines.join('\n');
}
