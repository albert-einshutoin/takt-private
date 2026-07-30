import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from '../../core/models/config-schemas.js';
import { assertSubscriptionOnlyConfig } from '../../core/subscription-only/policy.js';
import { mergeProjectTemplateConfigYaml } from '../../features/project-template/config-yaml-merge.js';

const fixtureRoot = join(
  import.meta.dirname,
  '../fixtures/project-template/config-merge',
);

function fixture(...segments: string[]): Buffer {
  return readFileSync(join(fixtureRoot, ...segments));
}

describe.each([
  ['suisui', 'suisui-planner', 'swift test'],
  ['mockport', 'mockport-planner', 'go test ./...'],
  ['qzt', 'qzt-planner', 'cargo test --all'],
] as const)('%s project config merge fixture', (project, model, qualityGate) => {
  it('preserves provider, gate, and security customizations while adding defaults', () => {
    const result = mergeProjectTemplateConfigYaml({
      base: fixture('base.yaml'),
      local: fixture(project, 'local.yaml'),
      incoming: fixture('incoming.yaml'),
    });

    expect(result).toMatchObject({ status: 'merged', changed: true });
    if (result.status !== 'merged') return;
    const text = result.content.toString('utf8');
    expect(text).toContain(`model: ${model}`);
    expect(text).toContain(qualityGate);
    expect(text).toContain('claude-sdk');
    expect(text).toContain('minimal_output: true');
    expect(text).toContain('timezone: Asia/Tokyo');

    // This is the same schema and effective subscription-only policy used by
    // runtime config loading, so fixture success cannot mask an unsafe route.
    const parsed = ProjectConfigSchema.parse(parse(text) as unknown);
    expect(() => assertSubscriptionOnlyConfig(parsed)).not.toThrow();
  });
});
