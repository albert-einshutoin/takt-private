import { describe, expect, it } from 'vitest';
import {
  CONFIG_SEQUENCE_RULES,
  resolveProjectTemplateConfigMergeRule,
} from '../../features/project-template/config-merge-rules.js';

describe('project template config merge rules', () => {
  it.each([
    ['provider_routing', 'project-owned'],
    ['provider_routing.personas.planner.provider', 'project-owned'],
    ['allowed_providers', 'project-owned'],
    ['forbidden_providers', 'project-owned'],
    ['base_branch', 'project-owned'],
    ['workflow_command_gates.custom_scripts', 'project-owned'],
    ['runtime.prepare', 'project-owned'],
    ['workflow_mcp_servers.stdio', 'project-owned'],
  ] as const)('classifies %s as %s', (path, ownership) => {
    expect(resolveProjectTemplateConfigMergeRule('config.yaml', path.split('.')))
      .toMatchObject({ ownership, known: true });
  });

  it.each([
    'anthropic_api_key',
    'openai_api_key',
    'copilot_github_token',
    'provider_options.codex.api_key',
  ])('forbids credential-bearing path %s', (path) => {
    expect(resolveProjectTemplateConfigMergeRule('config.yaml', path.split('.')))
      .toMatchObject({ ownership: 'forbidden', known: true });
  });

  it.each([
    'codex_cli_path',
    'claude_cli_path',
    'worktree_dir',
    'logging',
    'logging.debug',
    'bookmarks_file',
    'analytics.events_path',
    'notification_sound',
    'notification_sound_events.workflow_abort',
  ])('keeps machine-local path %s global-only', (path) => {
    expect(resolveProjectTemplateConfigMergeRule('config.yaml', path.split('.')))
      .toMatchObject({ ownership: 'global-only', known: true });
  });

  it('preserves unknown project keys with a warning and atomic sequence fallback', () => {
    expect(resolveProjectTemplateConfigMergeRule(
      'config.yaml',
      ['future_product_policy', 'values'],
    )).toEqual({
      ownership: 'project-owned',
      sequencePolicy: 'atomic',
      known: false,
      reviewRequired: true,
    });
  });

  it.each([
    ['allowed_providers', 'unordered-set'],
    ['forbidden_providers', 'monotonic-set'],
    ['workflow_overrides.quality_gates', 'ordered-keyed'],
    ['workflow_overrides.steps.review.quality_gates', 'ordered-keyed'],
    ['assistant.init_files', 'ordered-keyed'],
    ['rate_limit_fallback.switch_chain', 'atomic'],
    ['submodules', 'atomic'],
  ] as const)('assigns explicit sequence policy %s => %s', (path, policy) => {
    expect(resolveProjectTemplateConfigMergeRule('config.yaml', path.split('.')))
      .toMatchObject({ sequencePolicy: policy, known: true });
  });

  it('exports only explicit known sequence rules', () => {
    expect(CONFIG_SEQUENCE_RULES.length).toBeGreaterThanOrEqual(7);
    expect(CONFIG_SEQUENCE_RULES.every((rule) => rule.known)).toBe(true);
  });

  it('keeps devloop policy and gates project-owned', () => {
    expect(resolveProjectTemplateConfigMergeRule(
      'devloopd.yaml',
      ['policy', 'quality_gates'],
    )).toMatchObject({
      ownership: 'project-owned',
      sequencePolicy: 'ordered-keyed',
      known: true,
    });
  });
});
