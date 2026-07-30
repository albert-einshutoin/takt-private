import { describe, expect, it } from 'vitest';
import {
  mergeProjectTemplateConfigYaml,
  mergeProjectTemplateDevloopPolicyYaml,
} from '../../features/project-template/config-yaml-merge.js';

const bytes = (value: string): Buffer => Buffer.from(value);

describe('project template config YAML merge adapters', () => {
  it('preserves local provider routing while adding a safe template default', () => {
    const result = mergeProjectTemplateConfigYaml({
      base: bytes('provider_routing:\n  personas:\n    planner: codex\n'),
      local: bytes('provider_routing:\n  personas:\n    planner: claude\n'),
      incoming: bytes(
        'provider_routing:\n  personas:\n    planner: codex\n'
        + 'timezone: Asia/Tokyo\n',
      ),
    });

    expect(result).toMatchObject({ status: 'merged', changed: true });
    const content = result.status === 'merged' ? result.content.toString() : '';
    expect(content).toContain('planner: claude');
    expect(content).toContain('timezone: Asia/Tokyo');
  });

  it('reports an exact provider routing both-change conflict', () => {
    const result = mergeProjectTemplateConfigYaml({
      base: bytes('provider_routing:\n  personas:\n    planner: codex\n'),
      local: bytes('provider_routing:\n  personas:\n    planner: claude\n'),
      incoming: bytes('provider_routing:\n  personas:\n    planner: cursor\n'),
    });

    expect(result).toMatchObject({
      status: 'conflict',
      conflicts: [{
        path: ['provider_routing', 'personas', 'planner'],
        reason: 'BOTH_CHANGED',
      }],
    });
  });

  it('rejects a merged config that fails the runtime project schema', () => {
    const result = mergeProjectTemplateConfigYaml({
      base: bytes('concurrency: 2\n'),
      local: bytes('concurrency: 2\n'),
      incoming: bytes('concurrency: 999\n'),
    });

    expect(result).toMatchObject({
      status: 'blocked',
      code: 'MERGED_CONFIG_INVALID',
      path: ['concurrency'],
    });
  });

  it('runs subscription-only policy validation on merged output', () => {
    const result = mergeProjectTemplateConfigYaml({
      base: bytes('subscription_only: true\n'),
      local: bytes('subscription_only: true\n'),
      incoming: bytes(
        'subscription_only: true\n'
        + 'allowed_providers: [openai]\n',
      ),
    });

    expect(result).toMatchObject({
      status: 'blocked',
      code: 'MERGED_CONFIG_INVALID',
    });
  });

  it('rejects an incoming API provider introduced into an otherwise safe effective policy', () => {
    const safe = 'subscription_only: true\nprovider: codex-cli\n';
    const result = mergeProjectTemplateConfigYaml({
      base: bytes(safe),
      local: bytes(safe),
      incoming: bytes('subscription_only: true\nprovider: codex\n'),
    });

    expect(result).toMatchObject({
      status: 'blocked',
      code: 'MERGED_CONFIG_INVALID',
    });
    expect(result.status === 'blocked' ? result.message : '')
      .toMatch(/provider.*codex/i);
  });

  it('preserves unknown keys but routes them to a validator error', () => {
    const result = mergeProjectTemplateConfigYaml({
      base: bytes('language: en\n'),
      local: bytes('language: en\nfuture_policy: keep-me\n'),
      incoming: bytes('language: ja\n'),
    });

    expect(result).toMatchObject({
      status: 'blocked',
      code: 'MERGED_CONFIG_INVALID',
      path: [],
    });
  });

  it('requires subscription_only mode in devloop policy', () => {
    expect(mergeProjectTemplateDevloopPolicyYaml({
      base: bytes('mode: subscription_only\n'),
      local: bytes('mode: subscription_only\n'),
      incoming: bytes('mode: unsafe\n'),
    })).toMatchObject({
      status: 'blocked',
      code: 'MERGED_DEVLOOP_POLICY_INVALID',
      path: ['mode'],
    });
  });

  it('preserves valid devloop project policy extensions', () => {
    const result = mergeProjectTemplateDevloopPolicyYaml({
      base: bytes('mode: subscription_only\n'),
      local: bytes('mode: subscription_only\nproject_budget: strict\n'),
      incoming: bytes('mode: subscription_only\n'),
    });

    expect(result).toMatchObject({ status: 'merged', changed: false });
    expect(result.status === 'merged' && result.content.toString())
      .toContain('project_budget: strict');
  });
});
