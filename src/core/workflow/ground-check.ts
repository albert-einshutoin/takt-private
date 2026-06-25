import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AgentWorkflowStep,
  Language,
  StepProviderOptions,
} from '../models/types.js';
import type { StepProviderInfo } from './types.js';
import { getReportFiles } from './evaluation/rule-utils.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import type { ProviderType } from '../../shared/types/provider.js';

export type GroundCheckDecision = 'valid' | 'need_recheck';

export interface ResolvedGroundCheckConfig {
  enabled: true;
  provider: ProviderType | undefined;
  model: string | undefined;
  providerOptions: StepProviderOptions | undefined;
}

export interface ReviewerReportSnapshot {
  fileName: string;
  filePath: string;
  content: string;
  groundCheckFileName: string;
}

const GROUND_CHECK_TAG_PATTERN = /\[GROUND_CHECK:([A-Z_]+)\]/g;

type ProviderOptionsKey = keyof StepProviderOptions;
type GroundCheckOptions = NonNullable<NonNullable<StepProviderOptions['opencode']>['groundCheck']>;

function providerOptionsKeyForProvider(provider: ProviderType | undefined): ProviderOptionsKey | undefined {
  switch (provider) {
    case 'codex':
    case 'codex-cli':
      return 'codex';
    case 'opencode':
    case 'opencode-cli':
      return 'opencode';
    case 'claude':
    case 'claude-sdk':
      return 'claude';
    case 'claude-terminal':
      return 'claudeTerminal';
    case 'copilot':
      return 'copilot';
    case 'cursor':
    case 'cursor-cli':
      return 'cursor';
    case 'kiro':
      return 'kiro';
    case 'agy-cli':
    case 'mock':
    case undefined:
      return undefined;
  }
}

function groundCheckForProvider(
  providerOptions: StepProviderOptions | undefined,
  provider: ProviderType | undefined,
): GroundCheckOptions | undefined {
  const key = providerOptionsKeyForProvider(provider);
  if (!key) {
    return undefined;
  }
  return providerOptions?.[key]?.groundCheck;
}

function hasProviderLeaf(value: object): boolean {
  return Object.keys(value).length > 0;
}

function withoutGroundCheck<T extends { groundCheck?: unknown }>(providerOptions: T): Omit<T, 'groundCheck'> {
  const result = { ...providerOptions };
  delete result.groundCheck;
  return result;
}

export function stripGroundCheckFromProviderOptions(
  providerOptions: StepProviderOptions | undefined,
): StepProviderOptions | undefined {
  if (!providerOptions) {
    return undefined;
  }

  // groundCheck controls TAKT orchestration, not provider runtime behavior, so
  // strip it before handing providerOptions to SDK/CLI adapters.
  const result: StepProviderOptions = {};
  if (providerOptions.codex) {
    const codex = withoutGroundCheck(providerOptions.codex);
    if (hasProviderLeaf(codex)) {
      result.codex = codex;
    }
  }
  if (providerOptions.opencode) {
    const opencode = withoutGroundCheck(providerOptions.opencode);
    if (hasProviderLeaf(opencode)) {
      result.opencode = opencode;
    }
  }
  if (providerOptions.claude) {
    const claude = withoutGroundCheck(providerOptions.claude);
    if (hasProviderLeaf(claude)) {
      result.claude = claude;
    }
  }
  if (providerOptions.claudeTerminal) {
    const claudeTerminal = withoutGroundCheck(providerOptions.claudeTerminal);
    if (hasProviderLeaf(claudeTerminal)) {
      result.claudeTerminal = claudeTerminal;
    }
  }
  if (providerOptions.copilot) {
    const copilot = withoutGroundCheck(providerOptions.copilot);
    if (hasProviderLeaf(copilot)) {
      result.copilot = copilot;
    }
  }
  if (providerOptions.cursor) {
    const cursor = withoutGroundCheck(providerOptions.cursor);
    if (hasProviderLeaf(cursor)) {
      result.cursor = cursor;
    }
  }
  if (providerOptions.kiro) {
    const kiro = withoutGroundCheck(providerOptions.kiro);
    if (hasProviderLeaf(kiro)) {
      result.kiro = kiro;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function resolveGroundCheckConfig(
  providerInfo: Pick<StepProviderInfo, 'provider' | 'model' | 'providerOptions'>,
): ResolvedGroundCheckConfig | undefined {
  const groundCheck = groundCheckForProvider(providerInfo.providerOptions, providerInfo.provider);
  if (groundCheck?.enabled !== true) {
    return undefined;
  }

  return {
    enabled: true,
    provider: groundCheck.provider ?? providerInfo.provider,
    model: groundCheck.model ?? providerInfo.model,
    providerOptions: stripGroundCheckFromProviderOptions(
      groundCheck.providerOptions ?? providerInfo.providerOptions,
    ),
  };
}

export function parseGroundCheckDecision(content: string): GroundCheckDecision {
  const tags = [...content.matchAll(GROUND_CHECK_TAG_PATTERN)].map((match) => match[1]);
  if (tags.length !== 1) {
    // Ambiguous or missing judge tags must not let an ungrounded report advance.
    return 'need_recheck';
  }
  if (tags[0] === 'VALID') {
    return 'valid';
  }
  if (tags[0] === 'NEED_RECHECK') {
    return 'need_recheck';
  }
  return 'need_recheck';
}

export function buildGroundCheckReportFileName(fileName: string): string {
  return fileName.endsWith('.md')
    ? `${fileName.slice(0, -3)}.ground-check.md`
    : `${fileName}.ground-check.md`;
}

export function readReviewerReportSnapshots(
  reportDir: string,
  step: AgentWorkflowStep,
): ReviewerReportSnapshot[] {
  return getReportFiles(step.outputContracts).map((fileName) => {
    const filePath = resolve(reportDir, fileName);
    if (!existsSync(filePath)) {
      throw new Error(`Ground-check requires reviewer report file, but it was not found: ${fileName}`);
    }
    return {
      fileName,
      filePath,
      content: readFileSync(filePath, 'utf-8'),
      groundCheckFileName: buildGroundCheckReportFileName(fileName),
    };
  });
}

export function buildGroundCheckStep(
  reviewerStep: AgentWorkflowStep,
  config: ResolvedGroundCheckConfig,
): AgentWorkflowStep {
  return {
    name: `${reviewerStep.name}-ground-check`,
    personaDisplayName: 'ground-check',
    instruction: '',
    session: 'refresh',
    edit: false,
    requiredPermissionMode: 'readonly',
    provider: config.provider,
    model: config.model,
    providerOptions: config.providerOptions,
    directProviderOptions: config.providerOptions,
  };
}

export function buildGroundCheckEvidenceBundle(params: {
  task: string;
  phase1Instruction: string;
  reviewerResponse: string;
  reports: readonly ReviewerReportSnapshot[];
}): string {
  return [
    '# Task',
    params.task,
    '',
    '# Reviewer Instruction',
    params.phase1Instruction,
    '',
    '# Reviewer Phase 1 Response',
    params.reviewerResponse,
    '',
    '# Reviewer Reports',
    ...params.reports.flatMap((report) => [
      `## ${report.fileName}`,
      `Path: ${report.filePath}`,
      report.content,
    ]),
  ].join('\n');
}

export function buildGroundCheckPrompt(params: {
  language: Language | undefined;
  workflowName: string;
  stepName: string;
  evidenceBundle: string;
}): string {
  return loadTemplate('perform_ground_check_message', params.language ?? 'en', {
    workflowName: params.workflowName,
    stepName: params.stepName,
    evidenceBundle: params.evidenceBundle,
  });
}

export function buildGroundRecheckPrompt(params: {
  language: Language | undefined;
  workflowName: string;
  stepName: string;
  evidenceBundle: string;
  groundCheckReport: string;
}): string {
  return loadTemplate('perform_ground_recheck_message', params.language ?? 'en', {
    workflowName: params.workflowName,
    stepName: params.stepName,
    evidenceBundle: params.evidenceBundle,
    groundCheckReport: params.groundCheckReport,
  });
}
