import { parse } from 'yaml';
import { ProjectConfigSchema } from '../../core/models/config-schemas.js';
import {
  assertNoForbiddenSubscriptionOnlyConfigKeys,
  assertSubscriptionOnlyConfig,
} from '../../core/subscription-only/policy.js';
import {
  mergeProjectTemplateYamlDocument,
  type MergeProjectTemplateYamlDocumentOptions,
  type ProjectTemplateYamlMergeResult,
} from './yaml-document-merge.js';

export interface ProjectTemplateMergedConfigInvalid {
  readonly status: 'blocked';
  readonly code:
    | 'MERGED_CONFIG_INVALID'
    | 'MERGED_DEVLOOP_POLICY_INVALID';
  readonly document: 'merged';
  readonly path: readonly string[];
  readonly message: string;
  readonly reviewRequired: true;
  readonly diagnostics: ProjectTemplateYamlMergeResult['diagnostics'];
}

export type ProjectTemplateConfigYamlMergeResult =
  | ProjectTemplateYamlMergeResult
  | ProjectTemplateMergedConfigInvalid;

type ConfigMergeOptions = Omit<
MergeProjectTemplateYamlDocumentOptions,
'document'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

function parseMergedRecord(content: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value = parse(Buffer.from(content).toString('utf8')) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function invalid(
  code: ProjectTemplateMergedConfigInvalid['code'],
  path: readonly PropertyKey[],
  message: string,
  diagnostics: ProjectTemplateYamlMergeResult['diagnostics'],
): ProjectTemplateMergedConfigInvalid {
  return {
    status: 'blocked',
    code,
    document: 'merged',
    path: path.map(String),
    message,
    reviewRequired: true,
    diagnostics,
  };
}

export function mergeProjectTemplateConfigYaml(
  options: ConfigMergeOptions,
): ProjectTemplateConfigYamlMergeResult {
  const merged = mergeProjectTemplateYamlDocument({
    ...options,
    document: 'config.yaml',
  });
  if (merged.status !== 'merged') return merged;
  const raw = parseMergedRecord(merged.content);
  if (raw === undefined) {
    return invalid(
      'MERGED_CONFIG_INVALID',
      [],
      'merged project config must be a YAML object',
      merged.diagnostics,
    );
  }
  const parsed = ProjectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return invalid(
      'MERGED_CONFIG_INVALID',
      issue?.path ?? [],
      issue?.message ?? 'merged project config is invalid',
      merged.diagnostics,
    );
  }
  try {
    assertNoForbiddenSubscriptionOnlyConfigKeys(raw, 'merged project config');
    assertSubscriptionOnlyConfig(parsed.data);
  } catch (error) {
    return invalid(
      'MERGED_CONFIG_INVALID',
      [],
      error instanceof Error
        ? error.message
        : 'merged project config violates subscription-only policy',
      merged.diagnostics,
    );
  }
  return merged;
}

export function mergeProjectTemplateDevloopPolicyYaml(
  options: ConfigMergeOptions,
): ProjectTemplateConfigYamlMergeResult {
  const merged = mergeProjectTemplateYamlDocument({
    ...options,
    document: 'devloopd.yaml',
  });
  if (merged.status !== 'merged') return merged;
  const raw = parseMergedRecord(merged.content);
  if (raw === undefined) {
    return invalid(
      'MERGED_DEVLOOP_POLICY_INVALID',
      [],
      'merged devloop policy must be a YAML object',
      merged.diagnostics,
    );
  }
  if (raw['mode'] !== 'subscription_only') {
    return invalid(
      'MERGED_DEVLOOP_POLICY_INVALID',
      ['mode'],
      'merged devloop policy mode must be subscription_only',
      merged.diagnostics,
    );
  }
  return merged;
}
