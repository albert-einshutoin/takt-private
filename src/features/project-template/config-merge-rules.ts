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
  readonly sequenceIdentity: 'canonical' | 'quality-gate';
}

export interface RegisteredProjectTemplateConfigMergeRule
  extends ProjectTemplateConfigMergeRule {
  readonly document: ProjectTemplateConfigDocument | '*';
  readonly pattern: readonly string[];
}

function rule(
  document: RegisteredProjectTemplateConfigMergeRule['document'],
  pattern: string,
  ownership: ProjectTemplateConfigOwnership,
  options: {
    sequencePolicy?: ProjectTemplateConfigSequencePolicy;
    reviewRequired?: boolean;
    sequenceIdentity?: 'canonical' | 'quality-gate';
  } = {},
): RegisteredProjectTemplateConfigMergeRule {
  return {
    document,
    pattern: pattern.split('.'),
    ownership,
    sequencePolicy: options.sequencePolicy ?? 'atomic',
    known: true,
    // Project-owned values can change execution, credentials usage, or
    // external side effects as the config schema evolves. Default them to an
    // approval boundary; only explicitly monotonic restrictions opt out.
    reviewRequired: options.reviewRequired ?? ownership === 'project-owned',
    sequenceIdentity: options.sequenceIdentity ?? 'canonical',
  };
}

const SEQUENCE_RULES = [
  rule('config.yaml', 'allowed_providers', 'project-owned', {
    sequencePolicy: 'unordered-set',
    reviewRequired: true,
  }),
  rule('config.yaml', 'forbidden_providers', 'project-owned', {
    sequencePolicy: 'monotonic-set',
    reviewRequired: false,
  }),
  rule('config.yaml', 'workflow_overrides.quality_gates', 'project-owned', {
    sequencePolicy: 'ordered-keyed',
    sequenceIdentity: 'quality-gate',
    reviewRequired: true,
  }),
  rule('config.yaml', 'workflow_overrides.steps.*.quality_gates', 'project-owned', {
    sequencePolicy: 'ordered-keyed',
    sequenceIdentity: 'quality-gate',
    reviewRequired: true,
  }),
  rule('config.yaml', 'workflow_overrides.personas.*.quality_gates', 'project-owned', {
    sequencePolicy: 'ordered-keyed',
    sequenceIdentity: 'quality-gate',
    reviewRequired: true,
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
  rule('config.yaml', 'runtime.prepare', 'project-owned', {
    sequencePolicy: 'atomic',
    reviewRequired: true,
  }),
  rule('config.yaml', 'provider_options.opencode.allowed_tools', 'project-owned', {
    sequencePolicy: 'unordered-set',
    reviewRequired: true,
  }),
  rule('config.yaml', 'provider_options.claude.allowed_tools', 'project-owned', {
    sequencePolicy: 'unordered-set',
    reviewRequired: true,
  }),
  rule(
    'config.yaml',
    'provider_options.claude.sandbox.excluded_commands',
    'project-owned',
    { sequencePolicy: 'monotonic-set' },
  ),
  rule('config.yaml', 'provider_options.*.allowed_tools', 'project-owned', {
    sequencePolicy: 'unordered-set',
    reviewRequired: true,
  }),
  rule('devloopd.yaml', 'policy.quality_gates', 'project-owned', {
    sequencePolicy: 'ordered-keyed',
    sequenceIdentity: 'quality-gate',
    reviewRequired: true,
  }),
] as const;

export const CONFIG_SEQUENCE_RULES:
readonly RegisteredProjectTemplateConfigMergeRule[] =
  SEQUENCE_RULES;

const REGISTERED_RULES:
readonly RegisteredProjectTemplateConfigMergeRule[] = [
  ...SEQUENCE_RULES,
  rule('config.yaml', 'provider_routing.**', 'project-owned'),
  rule('config.yaml', 'provider_routing', 'project-owned'),
  rule('config.yaml', 'persona_providers.**', 'project-owned'),
  rule('config.yaml', 'persona_providers', 'project-owned'),
  rule('config.yaml', 'takt_providers.**', 'project-owned'),
  rule('config.yaml', 'takt_providers', 'project-owned'),
  rule('config.yaml', 'provider_options.codex.network_access', 'project-owned', {
    reviewRequired: true,
  }),
  rule('config.yaml', 'provider_options.opencode.network_access', 'project-owned', {
    reviewRequired: true,
  }),
  rule(
    'config.yaml',
    'provider_options.claude.sandbox.allow_unsandboxed_commands',
    'project-owned',
    { reviewRequired: true },
  ),
  rule('config.yaml', 'provider_options.**', 'project-owned'),
  rule('config.yaml', 'provider_options', 'project-owned'),
  rule('config.yaml', 'base_branch', 'project-owned'),
  rule('config.yaml', 'branch_name_strategy', 'project-owned'),
  rule('config.yaml', 'pipeline.**', 'project-owned'),
  rule('config.yaml', 'pipeline', 'project-owned'),
  rule('config.yaml', 'workflow_command_gates.custom_scripts', 'project-owned', {
    reviewRequired: true,
  }),
  rule('config.yaml', 'workflow_command_gates.**', 'project-owned'),
  rule('config.yaml', 'workflow_command_gates', 'project-owned'),
  rule('config.yaml', 'workflow_runtime_prepare.custom_scripts', 'project-owned', {
    reviewRequired: true,
  }),
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
  rule('config.yaml', 'workflow_arpeggio.custom_data_source_modules', 'project-owned', {
    reviewRequired: true,
  }),
  rule('config.yaml', 'workflow_arpeggio.custom_merge_inline_js', 'project-owned', {
    reviewRequired: true,
  }),
  rule('config.yaml', 'workflow_arpeggio.custom_merge_files', 'project-owned', {
    reviewRequired: true,
  }),
  rule('config.yaml', 'workflow_arpeggio.**', 'project-owned'),
  rule('config.yaml', 'workflow_arpeggio', 'project-owned'),
  rule('config.yaml', 'sync_conflict_resolver.auto_approve_tools', 'project-owned', {
    reviewRequired: true,
  }),
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
  rule('config.yaml', 'language', 'template-managed'),
  rule('config.yaml', 'timezone', 'template-managed'),
  rule('config.yaml', 'minimal_output', 'template-managed'),
  rule('config.yaml', 'task_poll_interval_ms', 'template-managed'),
  rule('config.yaml', 'interactive_preview_steps', 'template-managed'),
  rule('config.yaml', 'sync_project_local_takt_on_retry', 'project-owned'),
  rule('config.yaml', 'logging.**', 'global-only'),
  rule('config.yaml', 'logging', 'global-only'),
  rule('config.yaml', 'worktree_dir', 'global-only'),
  rule('config.yaml', 'bookmarks_file', 'global-only'),
  rule('config.yaml', 'workflow_categories_file', 'global-only'),
  rule('config.yaml', 'analytics.events_path', 'global-only'),
  rule('config.yaml', 'notification_sound_events.**', 'global-only'),
  rule('config.yaml', 'notification_sound_events', 'global-only'),
  rule('config.yaml', 'notification_sound', 'global-only'),
  rule('config.yaml', 'disabled_builtins', 'global-only'),
  rule('config.yaml', 'enable_builtin_workflows', 'global-only'),
  rule('config.yaml', 'prevent_sleep', 'global-only'),
  rule('config.yaml', 'auto_fetch', 'global-only'),
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

function canonicalCredentialSegment(rawSegment: string): string {
  return rawSegment
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isCredentialPath(path: readonly string[]): boolean {
  const segments = path.map(canonicalCredentialSegment).filter(Boolean);
  // Inspect both individual keys and their joined path. YAML permits a secret
  // label to be split across mappings (`api: { key: ... }`), which must not
  // bypass the same deny rule as `api_key`.
  const candidates = [...segments, segments.join('_')];
  return candidates.some((candidate) => (
    /(?:^|_)(?:api_key|access_key|private_key|client_secret|refresh_token|secret|token|password|credentials?)(?:$|_)/u
      .test(candidate)
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
      sequenceIdentity: 'canonical',
    };
  }
  if (isCredentialPath(path)) {
    return {
      ownership: 'forbidden',
      sequencePolicy: 'atomic',
      known: true,
      reviewRequired: true,
      sequenceIdentity: 'canonical',
    };
  }
  if (isCliPath(path)) {
    return {
      ownership: 'global-only',
      sequencePolicy: 'atomic',
      known: true,
      reviewRequired: true,
      sequenceIdentity: 'canonical',
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
      sequenceIdentity: registered.sequenceIdentity,
    };
  }
  // Unknown project keys remain local and visible. Treating an unknown
  // sequence atomically avoids inventing order or weakening a future policy.
  return {
    ownership: 'project-owned',
    sequencePolicy: 'atomic',
    known: false,
    reviewRequired: true,
    sequenceIdentity: 'canonical',
  };
}
