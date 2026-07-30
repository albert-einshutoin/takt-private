export type ProjectTemplateConfigDocument = 'config.yaml' | 'devloopd.yaml';

export type ProjectTemplateConfigOwnership =
  | 'template-managed'
  | 'project-owned'
  | 'global-only'
  | 'forbidden';

export type ProjectTemplateConfigSequencePolicy =
  | 'atomic'
  | 'unordered-set'
  | 'monotonic-set'
  | 'ordered-keyed';

export interface ProjectTemplateConfigMergeRule {
  readonly ownership: ProjectTemplateConfigOwnership;
  readonly sequencePolicy: ProjectTemplateConfigSequencePolicy;
  readonly known: boolean;
  readonly reviewRequired: boolean;
}

interface RegisteredConfigMergeRule extends ProjectTemplateConfigMergeRule {
  readonly document: ProjectTemplateConfigDocument | '*';
  readonly pattern: readonly string[];
}

function rule(
  document: RegisteredConfigMergeRule['document'],
  pattern: string,
  ownership: ProjectTemplateConfigOwnership,
  options: {
    sequencePolicy?: ProjectTemplateConfigSequencePolicy;
    reviewRequired?: boolean;
  } = {},
): RegisteredConfigMergeRule {
  return {
    document,
    pattern: pattern.split('.'),
    ownership,
    sequencePolicy: options.sequencePolicy ?? 'atomic',
    known: true,
    reviewRequired: options.reviewRequired ?? false,
  };
}

const SEQUENCE_RULES = [
  rule('config.yaml', 'allowed_providers', 'project-owned', {
    sequencePolicy: 'unordered-set',
    reviewRequired: true,
  }),
  rule('config.yaml', 'forbidden_providers', 'project-owned', {
    sequencePolicy: 'monotonic-set',
  }),
  rule('config.yaml', 'workflow_overrides.quality_gates', 'project-owned', {
    sequencePolicy: 'ordered-keyed',
  }),
  rule('config.yaml', 'workflow_overrides.steps.*.quality_gates', 'project-owned', {
    sequencePolicy: 'ordered-keyed',
  }),
  rule('config.yaml', 'workflow_overrides.personas.*.quality_gates', 'project-owned', {
    sequencePolicy: 'ordered-keyed',
  }),
  rule('config.yaml', 'assistant.init_files', 'project-owned', {
    sequencePolicy: 'ordered-keyed',
  }),
  rule('config.yaml', 'rate_limit_fallback.switch_chain', 'project-owned', {
    sequencePolicy: 'atomic',
  }),
  rule('config.yaml', 'submodules', 'project-owned', {
    sequencePolicy: 'atomic',
  }),
  rule('config.yaml', 'disabled_builtins', 'project-owned', {
    sequencePolicy: 'unordered-set',
  }),
  rule('devloopd.yaml', 'policy.quality_gates', 'project-owned', {
    sequencePolicy: 'ordered-keyed',
  }),
] as const;

export const CONFIG_SEQUENCE_RULES: readonly ProjectTemplateConfigMergeRule[] =
  SEQUENCE_RULES;

const REGISTERED_RULES: readonly RegisteredConfigMergeRule[] = [
  ...SEQUENCE_RULES,
  rule('config.yaml', 'provider_routing.**', 'project-owned'),
  rule('config.yaml', 'provider_routing', 'project-owned'),
  rule('config.yaml', 'persona_providers.**', 'project-owned'),
  rule('config.yaml', 'persona_providers', 'project-owned'),
  rule('config.yaml', 'takt_providers.**', 'project-owned'),
  rule('config.yaml', 'takt_providers', 'project-owned'),
  rule('config.yaml', 'provider_options.**', 'project-owned'),
  rule('config.yaml', 'provider_options', 'project-owned'),
  rule('config.yaml', 'base_branch', 'project-owned'),
  rule('config.yaml', 'branch_name_strategy', 'project-owned'),
  rule('config.yaml', 'pipeline.**', 'project-owned'),
  rule('config.yaml', 'pipeline', 'project-owned'),
  rule('config.yaml', 'workflow_command_gates.**', 'project-owned'),
  rule('config.yaml', 'workflow_command_gates', 'project-owned'),
  rule('config.yaml', 'workflow_runtime_prepare.**', 'project-owned'),
  rule('config.yaml', 'workflow_runtime_prepare', 'project-owned'),
  rule('config.yaml', 'runtime.**', 'project-owned'),
  rule('config.yaml', 'runtime', 'project-owned'),
  rule('config.yaml', 'workflow_mcp_servers.**', 'project-owned', {
    reviewRequired: true,
  }),
  rule('config.yaml', 'workflow_mcp_servers', 'project-owned', {
    reviewRequired: true,
  }),
  rule('config.yaml', 'workflow_arpeggio.**', 'project-owned'),
  rule('config.yaml', 'workflow_arpeggio', 'project-owned'),
  rule('config.yaml', 'sync_conflict_resolver.**', 'project-owned'),
  rule('config.yaml', 'sync_conflict_resolver', 'project-owned'),
  rule('config.yaml', 'vcs_provider', 'project-owned'),
  rule('config.yaml', 'auto_pr', 'project-owned'),
  rule('config.yaml', 'draft_pr', 'project-owned'),
  rule('config.yaml', 'allow_git_hooks', 'project-owned', { reviewRequired: true }),
  rule('config.yaml', 'allow_git_filters', 'project-owned', { reviewRequired: true }),
  rule('config.yaml', 'subscription_only', 'project-owned'),
  rule('config.yaml', 'provider', 'project-owned'),
  rule('config.yaml', 'model', 'project-owned'),
  rule('config.yaml', 'concurrency', 'project-owned'),
  rule('config.yaml', 'with_submodules', 'project-owned'),
  rule('config.yaml', 'auto_fetch', 'template-managed'),
  rule('config.yaml', 'language', 'template-managed'),
  rule('config.yaml', 'timezone', 'template-managed'),
  rule('config.yaml', 'minimal_output', 'template-managed'),
  rule('config.yaml', 'task_poll_interval_ms', 'template-managed'),
  rule('config.yaml', 'interactive_preview_steps', 'template-managed'),
  rule('config.yaml', 'sync_project_local_takt_on_retry', 'template-managed'),
  rule('config.yaml', 'logging.**', 'global-only'),
  rule('config.yaml', 'logging', 'global-only'),
  rule('config.yaml', 'worktree_dir', 'global-only'),
  rule('config.yaml', 'bookmarks_file', 'global-only'),
  rule('config.yaml', 'workflow_categories_file', 'global-only'),
  rule('config.yaml', 'analytics.events_path', 'global-only'),
  rule('config.yaml', 'notification_sound_events.**', 'global-only'),
  rule('config.yaml', 'notification_sound_events', 'global-only'),
  rule('config.yaml', 'notification_sound', 'global-only'),
  rule('devloopd.yaml', '**', 'project-owned'),
];

function matchesPattern(
  pattern: readonly string[],
  path: readonly string[],
): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    const segment = pattern[index];
    if (segment === '**') return index <= path.length;
    if (segment !== '*' && segment !== path[index]) return false;
  }
  return pattern.length === path.length;
}

function isCredentialPath(path: readonly string[]): boolean {
  return path.some((segment) => (
    segment === 'api_key'
    || segment.endsWith('_api_key')
    || segment.endsWith('_token')
    || segment === 'token'
    || segment === 'secret'
    || segment === 'password'
  ));
}

function isCliPath(path: readonly string[]): boolean {
  return path.some((segment) => segment.endsWith('_cli_path'));
}

export function resolveProjectTemplateConfigMergeRule(
  document: ProjectTemplateConfigDocument,
  path: readonly string[],
): ProjectTemplateConfigMergeRule {
  if (path.length === 0) {
    return {
      ownership: 'project-owned',
      sequencePolicy: 'atomic',
      known: false,
      reviewRequired: true,
    };
  }
  if (isCredentialPath(path)) {
    return {
      ownership: 'forbidden',
      sequencePolicy: 'atomic',
      known: true,
      reviewRequired: true,
    };
  }
  if (isCliPath(path)) {
    return {
      ownership: 'global-only',
      sequencePolicy: 'atomic',
      known: true,
      reviewRequired: true,
    };
  }
  const registered = REGISTERED_RULES.find((candidate) => (
    (candidate.document === '*' || candidate.document === document)
    && matchesPattern(candidate.pattern, path)
  ));
  if (registered !== undefined) {
    return {
      ownership: registered.ownership,
      sequencePolicy: registered.sequencePolicy,
      known: registered.known,
      reviewRequired: registered.reviewRequired,
    };
  }
  // Unknown project keys remain local and visible. Treating an unknown
  // sequence atomically avoids inventing order or weakening a future policy.
  return {
    ownership: 'project-owned',
    sequencePolicy: 'atomic',
    known: false,
    reviewRequired: true,
  };
}
