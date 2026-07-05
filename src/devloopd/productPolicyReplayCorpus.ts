import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';
import { stripAnsi } from '../shared/utils/text.js';
import {
  classifyProductPolicyImpact,
  type ProductPolicyClassificationInput,
  type ProductPolicyImpact,
} from './productPolicyClassifier.js';
import {
  PRODUCT_POLICY_CLASSIFIER_EVAL_FIXTURES,
  runProductPolicyClassifierEval,
  type ProductPolicyClassifierEvalFixture,
  type ProductPolicyClassifierEvalReport,
} from './productPolicyClassifierEval.js';
import {
  readRawDevloopLedgerEvents,
  resolveDevloopLedgerPath,
  type DevloopLedgerEvent,
} from './ledger.js';
import { writeFileAtomic } from './stateStore.js';

export interface ProductPolicyReplayCaseCandidate {
  id: string;
  expectedImpact: ProductPolicyImpact | null;
  classifierImpact: ProductPolicyImpact;
  humanOverride: 'human_review' | 'auto_mergeable' | 'unknown';
  reason: string;
  source: {
    eventId: string;
    eventType: string;
    timestamp?: string;
  };
  input: ProductPolicyClassificationInput;
}

export interface ProductPolicyReplayCandidateFile {
  version: 1;
  generatedAt: string;
  sourceLedger: string;
  cases: ProductPolicyReplayCaseCandidate[];
}

export interface ProductPolicyReplayFixtureLoadReport {
  fixtures: ProductPolicyClassifierEvalFixture[];
  files: string[];
  errors: string[];
}

export interface ProductPolicyReplayCorpusReport {
  passed: boolean;
  fixtureDir: string;
  loadedFiles: string[];
  validationErrors: string[];
  eval: ProductPolicyClassifierEvalReport;
  impactDistribution: Record<ProductPolicyImpact, number>;
}

const DEFAULT_FIXTURE_DIR = join('fixtures', 'product-policy', 'replay');
const DEFAULT_CANDIDATE_OUTPUT = join('.devloop', 'product-policy-replay-candidates.json');
const DIFF_LINE_LIMIT = 80;
const DIFF_LINE_LENGTH_LIMIT = 220;

function isProductPolicyImpact(value: unknown): value is ProductPolicyImpact {
  return value === 'mechanical'
    || value === 'implementation'
    || value === 'product_policy'
    || value === 'human_policy';
}

function sanitizeReplayText(value: string): string {
  return sanitizeSensitiveText(stripAnsi(value))
    .replace(/\/Users\/[^"'\s`)]+/g, '[LOCAL_PATH]')
    .replace(/\/Volumes\/[^"'\s`)]+/g, '[LOCAL_PATH]')
    .replace(/\/home\/[^"'\s`)]+/g, '[LOCAL_PATH]')
    .replace(/\/private\/var\/folders\/[^"'\s`)]+/g, '[LOCAL_PATH]')
    .replace(/[A-Za-z]:\\Users\\[^"'\s`)]+/g, '[LOCAL_PATH]')
    .trim();
}

function sanitizeChangedPath(path: string): string {
  const sanitized = sanitizeReplayText(path)
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '');
  return sanitized.length === 0 ? '[REDACTED_PATH]' : sanitized;
}

function truncateLine(line: string): string {
  return line.length <= DIFF_LINE_LENGTH_LIMIT
    ? line
    : `${line.slice(0, DIFF_LINE_LENGTH_LIMIT - 3)}...`;
}

function sanitizeDiffShape(diff: string | undefined): string | undefined {
  if (diff === undefined || diff.trim().length === 0) {
    return undefined;
  }
  const lines = diff.split('\n').flatMap((line) => {
    if (line.startsWith('diff --git ')) {
      return [sanitizeReplayText(line)];
    }
    if (line.startsWith('@@')) {
      return [sanitizeReplayText(line)];
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return [`+${truncateLine(sanitizeReplayText(line.slice(1)))}`];
    }
    return [];
  }).slice(0, DIFF_LINE_LIMIT);
  return lines.length === 0 ? undefined : lines.join('\n');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(sanitizeChangedPath).filter(Boolean)
    : [];
}

function inputFromEvent(event: DevloopLedgerEvent): ProductPolicyClassificationInput | undefined {
  const input = event.input;
  const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : event;
  const changedPaths = stringArray(source.changedPaths);
  if (changedPaths.length === 0) {
    return undefined;
  }
  return {
    changedPaths,
    ...(typeof source.title === 'string' ? { title: sanitizeReplayText(source.title) } : {}),
    ...(typeof source.body === 'string' ? { body: sanitizeReplayText(source.body).slice(0, 1_000) } : {}),
    ...(typeof source.diff === 'string' ? { diff: sanitizeDiffShape(source.diff) } : {}),
  };
}

function impactFromEvent(event: DevloopLedgerEvent, input: ProductPolicyClassificationInput): ProductPolicyImpact {
  const impact = event.productPolicyImpact;
  if (typeof impact === 'object' && impact !== null && isProductPolicyImpact((impact as { impact?: unknown }).impact)) {
    return (impact as { impact: ProductPolicyImpact }).impact;
  }
  if (isProductPolicyImpact(event.productPolicyImpact)) {
    return event.productPolicyImpact;
  }
  return classifyProductPolicyImpact(input).impact;
}

function reasonFromEvent(event: DevloopLedgerEvent, input: ProductPolicyClassificationInput): string {
  const impact = event.productPolicyImpact;
  if (typeof impact === 'object' && impact !== null && Array.isArray((impact as { reasons?: unknown }).reasons)) {
    const reasons = (impact as { reasons: unknown[] }).reasons
      .filter((reason): reason is string => typeof reason === 'string')
      .map(sanitizeReplayText);
    if (reasons.length > 0) {
      return reasons.join('; ');
    }
  }
  if (typeof event.summary === 'string') {
    return sanitizeReplayText(event.summary);
  }
  if (typeof event.message === 'string') {
    return sanitizeReplayText(event.message);
  }
  return classifyProductPolicyImpact(input).reasons.map(sanitizeReplayText).join('; ');
}

function humanOverrideFromEvent(event: DevloopLedgerEvent): ProductPolicyReplayCaseCandidate['humanOverride'] {
  if (event.stage === 'human_escalation' || event.status === 'blocked') {
    return 'human_review';
  }
  if (event.status === 'passed' || event.status === 'merged' || event.status === 'auto_mergeable') {
    return 'auto_mergeable';
  }
  return 'unknown';
}

function replayIdForEvent(event: DevloopLedgerEvent): string {
  const base = typeof event.replayId === 'string'
    ? event.replayId
    : `${event.eventType}-${event.eventId}`;
  return sanitizeReplayText(base)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'replay-case';
}

export function collectProductPolicyReplayCandidatesFromEvents(
  events: readonly DevloopLedgerEvent[],
  options: { limit?: number } = {},
): ProductPolicyReplayCaseCandidate[] {
  const limit = options.limit ?? 100;
  const candidates: ProductPolicyReplayCaseCandidate[] = [];
  for (const event of events.slice().reverse()) {
    const input = inputFromEvent(event);
    if (input === undefined) {
      continue;
    }
    const classifierImpact = impactFromEvent(event, input);
    candidates.push({
      id: replayIdForEvent(event),
      expectedImpact: null,
      classifierImpact,
      humanOverride: humanOverrideFromEvent(event),
      reason: reasonFromEvent(event, input),
      source: {
        eventId: event.eventId,
        eventType: event.eventType,
        ...(typeof event.timestamp === 'string' ? { timestamp: event.timestamp } : {}),
      },
      input,
    });
    if (candidates.length >= limit) {
      break;
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

export function buildProductPolicyReplayCandidateFile(options: {
  repoPath: string;
  ledgerPath?: string;
  limit?: number;
  now?: Date;
}): ProductPolicyReplayCandidateFile {
  const repoPath = resolve(options.repoPath);
  const ledgerPath = resolveDevloopLedgerPath(repoPath, options.ledgerPath);
  return {
    version: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    sourceLedger: ledgerPath,
    cases: collectProductPolicyReplayCandidatesFromEvents(
      readRawDevloopLedgerEvents(ledgerPath),
      { limit: options.limit },
    ),
  };
}

export function writeProductPolicyReplayCandidateFile(options: {
  repoPath: string;
  ledgerPath?: string;
  outputPath?: string;
  limit?: number;
  now?: Date;
}): { path: string; file: ProductPolicyReplayCandidateFile } {
  const repoPath = resolve(options.repoPath);
  const outputPath = resolve(repoPath, options.outputPath ?? DEFAULT_CANDIDATE_OUTPUT);
  const file = buildProductPolicyReplayCandidateFile({
    repoPath,
    ledgerPath: options.ledgerPath,
    limit: options.limit,
    now: options.now,
  });
  writeFileAtomic(outputPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return { path: outputPath, file };
}

function parseFixtureCase(raw: unknown, filePath: string, index: number): {
  fixture?: ProductPolicyClassifierEvalFixture;
  error?: string;
} {
  if (typeof raw !== 'object' || raw === null) {
    return { error: `${filePath} case ${index} must be an object` };
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
    return { error: `${filePath} case ${index} is missing id` };
  }
  if (!isProductPolicyImpact(candidate.expectedImpact)) {
    return { error: `${filePath} case ${candidate.id} needs explicit expectedImpact` };
  }
  const input = candidate.input;
  if (typeof input !== 'object' || input === null) {
    return { error: `${filePath} case ${candidate.id} is missing input` };
  }
  const changedPaths = stringArray((input as { changedPaths?: unknown }).changedPaths);
  if (changedPaths.length === 0) {
    return { error: `${filePath} case ${candidate.id} needs at least one changed path` };
  }
  return {
    fixture: {
      id: sanitizeReplayText(candidate.id),
      expectedImpact: candidate.expectedImpact,
      input: {
        changedPaths,
        ...(typeof (input as { title?: unknown }).title === 'string' ? { title: sanitizeReplayText((input as { title: string }).title) } : {}),
        ...(typeof (input as { body?: unknown }).body === 'string' ? { body: sanitizeReplayText((input as { body: string }).body).slice(0, 1_000) } : {}),
        ...(typeof (input as { diff?: unknown }).diff === 'string' ? { diff: sanitizeDiffShape((input as { diff: string }).diff) } : {}),
      },
    },
  };
}

export function loadProductPolicyReplayFixtureDirectory(fixtureDir: string): ProductPolicyReplayFixtureLoadReport {
  const dir = resolve(fixtureDir);
  if (!existsSync(dir)) {
    return { fixtures: [], files: [], errors: [] };
  }
  const files = readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => join(dir, entry))
    .sort((left, right) => left.localeCompare(right));
  const fixtures: ProductPolicyClassifierEvalFixture[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { cases?: unknown };
      if (!Array.isArray(parsed.cases)) {
        errors.push(`${file} must contain a cases array`);
        continue;
      }
      parsed.cases.forEach((raw, index) => {
        const result = parseFixtureCase(raw, file, index);
        if (result.fixture !== undefined) {
          fixtures.push(result.fixture);
        }
        if (result.error !== undefined) {
          errors.push(result.error);
        }
      });
    } catch (error) {
      errors.push(`${file} could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { fixtures, files, errors };
}

function impactDistribution(report: ProductPolicyClassifierEvalReport): Record<ProductPolicyImpact, number> {
  return {
    mechanical: report.categoryCounts.mechanical.actual,
    implementation: report.categoryCounts.implementation.actual,
    product_policy: report.categoryCounts.product_policy.actual,
    human_policy: report.categoryCounts.human_policy.actual,
  };
}

export function runProductPolicyReplayCorpus(options: {
  repoPath?: string;
  fixtureDir?: string;
  thresholds?: { maxFalsePositives?: number; maxFalseNegatives?: number };
} = {}): ProductPolicyReplayCorpusReport {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const fixtureDir = resolve(repoPath, options.fixtureDir ?? DEFAULT_FIXTURE_DIR);
  const loaded = loadProductPolicyReplayFixtureDirectory(fixtureDir);
  const evalReport = runProductPolicyClassifierEval({
    fixtures: PRODUCT_POLICY_CLASSIFIER_EVAL_FIXTURES,
    replayFixtures: loaded.fixtures,
    thresholds: options.thresholds,
  });
  return {
    passed: loaded.errors.length === 0 && evalReport.passed,
    fixtureDir,
    loadedFiles: loaded.files,
    validationErrors: loaded.errors,
    eval: evalReport,
    impactDistribution: impactDistribution(evalReport),
  };
}

export function formatProductPolicyReplayCandidateFile(path: string, file: ProductPolicyReplayCandidateFile): string {
  return [
    'devloopd product-policy collect-replay-cases completed',
    `Output: ${path}`,
    `Source ledger: ${file.sourceLedger}`,
    `Cases: ${file.cases.length}`,
    'Next: review each candidate, set expectedImpact explicitly, and move curated cases into fixtures/product-policy/replay/*.json.',
  ].join('\n');
}

export function formatProductPolicyReplayCorpusReport(report: ProductPolicyReplayCorpusReport): string {
  const lines = [
    report.passed ? 'devloopd product-policy replay passed' : 'devloopd product-policy replay failed',
    `Fixture dir: ${report.fixtureDir}`,
    `Loaded files: ${report.loadedFiles.length === 0 ? 'none' : report.loadedFiles.map((file) => basename(file)).join(', ')}`,
    `Total cases: ${report.eval.total}`,
    `False positives: ${report.eval.falsePositives}`,
    `False negatives: ${report.eval.falseNegatives}`,
    `Impact distribution: mechanical=${report.impactDistribution.mechanical}, implementation=${report.impactDistribution.implementation}, product_policy=${report.impactDistribution.product_policy}, human_policy=${report.impactDistribution.human_policy}`,
  ];
  if (report.validationErrors.length > 0) {
    lines.push('Validation errors:', ...report.validationErrors.map((error) => `- ${error}`));
  }
  if (report.eval.mismatches.length > 0) {
    lines.push('Mismatches:', ...report.eval.mismatches.map((mismatch) => (
      `- ${mismatch.id}: expected ${mismatch.expectedImpact}, actual ${mismatch.actualImpact} (${mismatch.reasons.join('; ')})`
    )));
  }
  return lines.join('\n');
}
