import { describe, expect, it } from 'vitest';
import {
  mergeProjectTemplateYamlDocument,
  type ProjectTemplateYamlMergeBlockedCode,
} from '../../features/project-template/yaml-document-merge.js';

const bytes = (text: string): Buffer => Buffer.from(text);

function merge(
  base: string,
  local: string,
  incoming: string,
) {
  return mergeProjectTemplateYamlDocument({
    document: 'config.yaml',
    base: bytes(base),
    local: bytes(local),
    incoming: bytes(incoming),
  });
}

describe('project template YAML document three-way merge', () => {
  it('returns the exact local bytes for a semantic no-op', () => {
    const local = Buffer.from('\uFEFF# local\r\nlanguage: en\r\n');
    const result = mergeProjectTemplateYamlDocument({
      document: 'config.yaml',
      base: bytes('language: en\n'),
      local,
      incoming: bytes('language: en\n'),
    });

    expect(result).toMatchObject({ status: 'merged', changed: false });
    expect(result.status === 'merged' && result.content.equals(local)).toBe(true);
  });

  it('edits the local document while preserving mapping order and local comments', () => {
    const result = merge(
      'language: en\nprovider: codex\n',
      '# local heading\nlanguage: en # keep this\nprovider: claude\n',
      'language: ja\nprovider: codex\ntimezone: Asia/Tokyo\n',
    );

    expect(result).toMatchObject({ status: 'merged', changed: true });
    const output = result.status === 'merged' ? result.content.toString() : '';
    expect(output).toContain('# local heading');
    expect(output).toContain('language: ja # keep this');
    expect(output).toContain('provider: claude');
    expect(output.indexOf('language:')).toBeLessThan(output.indexOf('provider:'));
    expect(output.indexOf('provider:')).toBeLessThan(output.indexOf('timezone:'));
  });

  it('adds an incoming-only mapping key', () => {
    const result = merge(
      'language: en\n',
      'language: en\n',
      'language: en\ntimezone: UTC\n',
    );

    expect(result).toMatchObject({ status: 'merged', changed: true });
    expect(result.status === 'merged' && result.content.toString())
      .toContain('timezone: UTC');
  });

  it('reports an exact leaf path when both sides changed differently', () => {
    const result = merge(
      'language: en\nprovider: codex\n',
      'language: fr\nprovider: codex\n',
      'language: ja\nprovider: codex\n',
    );

    expect(result).toEqual(expect.objectContaining({
      status: 'conflict',
      conflicts: [{ path: ['language'], reason: 'BOTH_CHANGED' }],
    }));
  });

  it('preserves an unchanged project-owned scalar against an incoming change', () => {
    const result = merge(
      'subscription_only: true\nlanguage: en\n',
      'subscription_only: true\nlanguage: en\n',
      'subscription_only: false\nlanguage: ja\n',
    );

    expect(result).toMatchObject({ status: 'merged', changed: true });
    const output = result.status === 'merged' ? result.content.toString() : '';
    expect(output).toContain('subscription_only: true');
    expect(output).toContain('language: ja');
    expect(output).not.toContain('subscription_only: false');
  });

  it('does not introduce a missing project-owned scalar from the template', () => {
    const result = merge(
      'language: en\n',
      'language: en\n',
      'language: ja\nbase_branch: release\n',
    );

    expect(result).toMatchObject({ status: 'merged', changed: true });
    const output = result.status === 'merged' ? result.content.toString() : '';
    expect(output).toContain('language: ja');
    expect(output).not.toContain('base_branch');
  });

  it('treats an unregistered sequence atomically', () => {
    const result = merge(
      'future_values: [base]\n',
      'future_values: [local]\n',
      'future_values: [incoming]\n',
    );

    expect(result).toEqual(expect.objectContaining({
      status: 'conflict',
      conflicts: [{ path: ['future_values'], reason: 'BOTH_CHANGED' }],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'UNKNOWN_SEQUENCE_ATOMIC' }),
      ]),
    }));
  });

  it('uses registered set rules for independent sequence additions', () => {
    const result = merge(
      'allowed_providers: [codex]\n',
      'allowed_providers: [codex, claude]\n',
      'allowed_providers: [codex, copilot]\n',
    );

    expect(result).toMatchObject({ status: 'merged', changed: true });
    const output = result.status === 'merged' ? result.content.toString() : '';
    expect(output).toContain('codex');
    expect(output).toContain('claude');
    expect(output).toContain('copilot');
  });

  it('does not remove a forbidden provider through an incoming update', () => {
    const result = merge(
      'forbidden_providers: [openai]\n',
      'forbidden_providers: [openai]\n',
      'forbidden_providers: []\n',
    );

    expect(result).toMatchObject({ status: 'merged', changed: false });
    expect(result.status === 'merged' && result.content.toString())
      .toContain('openai');
  });

  it('preserves ordered project gates while appending incoming gates', () => {
    const result = merge(
      'workflow_overrides:\n  quality_gates:\n    - npm test\n',
      'workflow_overrides:\n  quality_gates:\n    - npm test\n    - npm run lint\n',
      'workflow_overrides:\n  quality_gates:\n    - npm run e2e\n',
    );

    expect(result).toMatchObject({ status: 'merged', changed: true });
    const output = result.status === 'merged' ? result.content.toString() : '';
    expect(output).toContain('npm test');
    expect(output).toContain('npm run lint');
    expect(output).toContain('npm run e2e');
  });

  it('preserves local sequence item presentation while appending a gate', () => {
    const result = merge(
      'workflow_overrides:\n  quality_gates:\n    - npm test\n',
      'workflow_overrides:\n  quality_gates:\n    # project contract\n    - "npm test" # keep local style\n',
      'workflow_overrides:\n  quality_gates:\n    - npm test\n    - npm run e2e\n',
    );

    expect(result).toMatchObject({ status: 'merged', changed: true });
    const output = result.status === 'merged' ? result.content.toString() : '';
    expect(output).toContain('# project contract');
    expect(output).toContain('"npm test" # keep local style');
    expect(output).toContain('npm run e2e');
  });

  it('uses runtime quality-gate identity instead of duplicating defaults', () => {
    const result = merge(
      'workflow_overrides:\n  quality_gates: []\n',
      'workflow_overrides:\n  quality_gates:\n'
        + '    - { type: command, command: npm test }\n',
      'workflow_overrides:\n  quality_gates:\n'
        + '    - { type: command, command: npm test, cwd: ., timeout_ms: 300000 }\n',
    );

    expect(result).toMatchObject({ status: 'merged', changed: false });
    const output = result.status === 'merged' ? result.content.toString() : '';
    expect(output.match(/command: npm test/g)).toHaveLength(1);
    expect(output).not.toContain('timeout_ms');
  });

  it('keeps global-only local configuration and blocks incoming credentials', () => {
    const globalOnly = merge(
      'logging:\n  level: info\n',
      'logging:\n  level: info\n',
      'logging:\n  level: debug\n',
    );
    expect(globalOnly).toMatchObject({
      status: 'merged',
      changed: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'GLOBAL_ONLY_IGNORED' }),
      ]),
    });

    expect(merge(
      'language: en\n',
      'language: en\n',
      'language: en\nopenai_api_key: unsafe\n',
    )).toMatchObject({
      status: 'blocked',
      code: 'FORBIDDEN_PATH',
      document: 'incoming',
    });

    expect(merge(
      'openai_api_key: unsafe\n',
      'language: ja\n',
      'openai_api_key: unsafe\n',
    )).toMatchObject({
      status: 'blocked',
      code: 'FORBIDDEN_PATH',
      document: 'incoming',
    });

    expect(merge(
      'provider_options: {}\n',
      'provider_options: {}\n',
      'provider_options:\n  codex:\n    credentials:\n      - api:\n          key: unsafe\n',
    )).toMatchObject({
      status: 'blocked',
      code: 'FORBIDDEN_PATH',
      document: 'incoming',
    });
  });

  it.each([
    ['anchor', 'value: &shared x\n', 'ALIAS_OR_ANCHOR'],
    ['alias', 'value: &shared x\ncopy: *shared\n', 'ALIAS_OR_ANCHOR'],
    ['merge key', 'item:\n  <<: { value: x }\n', 'MERGE_KEY'],
    ['custom tag', 'value: !custom x\n', 'CUSTOM_TAG'],
    ['multi document', 'value: one\n---\nvalue: two\n', 'MULTI_DOCUMENT'],
    ['YAML directive', '%YAML 1.2\n---\nvalue: one\n', 'YAML_DIRECTIVE'],
    ['duplicate key', 'value: one\nvalue: two\n', 'INVALID_YAML'],
  ] as const)(
    'fails closed for %s input',
    (_name, unsafe, code) => {
      const result = merge('value: base\n', 'value: base\n', unsafe);
      expect(result).toMatchObject({
        status: 'blocked',
        code: code satisfies ProjectTemplateYamlMergeBlockedCode,
        document: 'incoming',
      });
    },
  );

  it('preserves local BOM, CRLF, and missing final newline', () => {
    const local = '\uFEFFlanguage: en\r\nprovider: codex';
    const result = mergeProjectTemplateYamlDocument({
      document: 'config.yaml',
      base: bytes('language: en\nprovider: codex\n'),
      local: bytes(local),
      incoming: bytes('language: ja\nprovider: codex\n'),
    });

    expect(result).toMatchObject({ status: 'merged', changed: true });
    const output = result.status === 'merged' ? result.content.toString() : '';
    expect(output.startsWith('\uFEFF')).toBe(true);
    expect(output).toContain('\r\n');
    expect(output.replace(/\r\n/g, '')).not.toContain('\n');
    expect(output.endsWith('\n')).toBe(false);
  });

  it('preserves a local final newline after an edit', () => {
    const result = merge('language: en\n', 'language: en\n', 'language: ja\n');
    expect(result.status === 'merged' && result.content.toString().endsWith('\n'))
      .toBe(true);
  });

  it('blocks an edit with mixed local line endings instead of normalizing it', () => {
    const result = mergeProjectTemplateYamlDocument({
      document: 'config.yaml',
      base: bytes('language: en\n'),
      local: bytes('language: en\r\nprovider: codex\n'),
      incoming: bytes('language: ja\nprovider: codex\n'),
    });

    expect(result).toMatchObject({
      status: 'blocked',
      code: 'MIXED_EOL_UNSUPPORTED',
      document: 'local',
      reviewRequired: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'MIXED_EOL' }),
      ]),
    });
  });
});
