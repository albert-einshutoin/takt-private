import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { YAMLMap, YAMLSeq } from 'yaml';
import {
  parseProjectTemplateRepertoireCapabilityYaml,
  ProjectTemplateRepertoireCapabilityYamlError,
} from '../../infra/repertoire/project-template-repertoire-capability-yaml.js';

function bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

describe('project template repertoire capability YAML G3.3.1', () => {
  it.each([
    ['direct edit', 'steps:\n  - edit: true\n'],
    ['no edit', 'name: inspect-only\nsteps:\n  - edit: false\n'],
    ['all guarded fields', [
      'steps:',
      '  - required_permission_mode: acceptEdits',
      '    provider_options:',
      '      model: safe',
      '    parallel:',
      '      - edit: false',
      '        provider_options: {}',
      '    promotion:',
      '      - provider_options:',
      '          effort: high',
      '    overrides:',
      '      provider_options:',
      '        sandbox: workspace-write',
      '',
    ].join('\n')],
  ])('accepts workflow shape: %s', (_label, yaml) => {
    const result = parseProjectTemplateRepertoireCapabilityYaml(
      bytes(yaml),
      'workflow',
    );
    expect(result).toEqual({
      text: yaml,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      providerExtends: [],
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    'extends: base/provider.yaml\nmodel: safe\n',
    'model: safe\nsandbox: workspace-write\n',
    '{}\n',
  ])('accepts provider-options mappings', (yaml) => {
    expect(parseProjectTemplateRepertoireCapabilityYaml(
      bytes(yaml),
      'provider-options',
    )).toMatchObject({ text: yaml });
  });

  it('collects workflow and provider extends as frozen private metadata', () => {
    const workflow = parseProjectTemplateRepertoireCapabilityYaml(bytes([
      'workflow_config:',
      '  provider_options:',
      '    extends: workflow-base',
      'steps:',
      '  - provider_options:',
      '      extends: ./provider-options/step.yaml',
      '    parallel:',
      '      - overrides:',
      '          provider_options:',
      '            extends: "@other/tools/edit"',
      '',
    ].join('\n')), 'workflow');
    const provider = parseProjectTemplateRepertoireCapabilityYaml(
      bytes('extends: ../shared/base.yml\n'),
      'provider-options',
    );

    expect(workflow.providerExtends).toEqual([
      'workflow-base',
      './provider-options/step.yaml',
      '@other/tools/edit',
    ]);
    expect(provider.providerExtends).toEqual(['../shared/base.yml']);
    expect(Object.isFrozen(workflow.providerExtends)).toBe(true);
    expect(Object.isFrozen(provider.providerExtends)).toBe(true);
  });

  it.each([
    ['workflow root sequence', '- edit: true\n'],
    ['steps scalar', 'steps: invalid\n'],
    ['steps scalar item', 'steps:\n  - invalid\n'],
    ['parallel mapping', 'steps:\n  - parallel: {}\n'],
    ['parallel scalar item', 'steps:\n  - parallel:\n      - invalid\n'],
    ['edit string', 'steps:\n  - edit: "true"\n'],
    ['permission boolean', 'steps:\n  - required_permission_mode: true\n'],
    ['nested provider options sequence', 'steps:\n  - provider_options: []\n'],
    ['promotion mapping', 'steps:\n  - promotion: {}\n'],
    ['promotion scalar item', 'steps:\n  - promotion:\n      - invalid\n'],
    ['overrides sequence', 'steps:\n  - overrides: []\n'],
    ['nested malformed field', 'steps:\n  - parallel:\n      - edit: nope\n'],
    ['provider root sequence', '- model\n'],
    ['empty extends', 'extends: ""\n'],
    ['blank extends', 'extends: "   "\n'],
    ['non-string extends', 'extends: 42\n'],
  ])('rejects malformed shape: %s', (_label, yaml) => {
    const kind = _label.startsWith('provider') || _label.includes('extends')
      ? 'provider-options'
      : 'workflow';
    expect(() => parseProjectTemplateRepertoireCapabilityYaml(
      bytes(yaml),
      kind,
    )).toThrow(expect.objectContaining({ code: 'INVALID_CAPABILITY_YAML' }));
  });

  it.each([
    ['duplicate', 'steps: []\nsteps: []\n'],
    ['alias', 'steps: [*shared]\n'],
    ['anchor', 'steps: &shared []\n'],
    ['merge', 'steps:\n  - <<: {}\n'],
    ['custom tag', 'steps: !custom []\n'],
    ['standard sequence tag', 'steps: !!seq []\n'],
    ['standard scalar tag', 'name: !!str inspect\nsteps: []\n'],
    ['multi document', 'steps: []\n---\nsteps: []\n'],
    ['non-string key', '? [bad]\n: value\n'],
  ])('rejects unsafe YAML feature: %s', (_label, yaml) => {
    expect(() => parseProjectTemplateRepertoireCapabilityYaml(
      bytes(yaml),
      'workflow',
    )).toThrow(expect.objectContaining({ code: 'INVALID_YAML' }));
  });

  it('rejects excessive depth and node count', () => {
    const deep = `${'value:\n  '.repeat(33)}leaf: true\n`;
    expect(() => parseProjectTemplateRepertoireCapabilityYaml(
      bytes(deep),
      'provider-options',
    )).toThrow(expect.objectContaining({ code: 'INVALID_YAML' }));
    const many = `values:\n${Array.from(
      { length: 4100 },
      (_, index) => `  key-${index}: true`,
    ).join('\n')}\n`;
    expect(() => parseProjectTemplateRepertoireCapabilityYaml(
      bytes(many),
      'provider-options',
    )).toThrow(expect.objectContaining({ code: 'INVALID_YAML' }));
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), 'INVALID_ENCODING'],
    ['UTF-8 BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x61]), 'INVALID_YAML'],
    ['NUL', Buffer.from('name: bad\0value\n'), 'INVALID_YAML'],
    ['C0 control', Buffer.from('name: bad\u0001value\n'), 'INVALID_YAML'],
    ['DEL control', Buffer.from('name: bad\u007fvalue\n'), 'INVALID_YAML'],
    ['oversize', Buffer.alloc(1024 * 1024 + 1), 'LIMIT_EXCEEDED'],
  ])('rejects bounded byte violation: %s', (_label, input, code) => {
    expect(() => parseProjectTemplateRepertoireCapabilityYaml(
      input,
      'workflow',
    )).toThrow(expect.objectContaining({ code }));
  });

  it('snapshots mutable bytes and rejects hostile byte containers', () => {
    const input = bytes('steps:\n  - edit: true\n');
    const result = parseProjectTemplateRepertoireCapabilityYaml(
      input,
      'workflow',
    );
    input.fill(0);
    expect(result.text).toBe('steps:\n  - edit: true\n');
    expect(() => parseProjectTemplateRepertoireCapabilityYaml(
      new Proxy(bytes('steps: []\n'), {}),
      'workflow',
    )).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => parseProjectTemplateRepertoireCapabilityYaml(
      new Uint8Array(new SharedArrayBuffer(8)),
      'workflow',
    )).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    const accessor = Object.defineProperty({}, 'byteLength', {
      get() {
        throw new Error('secret accessor');
      },
    });
    expect(() => parseProjectTemplateRepertoireCapabilityYaml(
      accessor,
      'workflow',
    )).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('fails nested parser reentry closed without corrupting the outer snapshot', () => {
    const yaml = 'steps:\n  - edit: true\n';
    const secret = 'secret-capability-token';
    const originalPush = Array.prototype.push;
    let callbacks = 0;
    let nestedFailure: unknown;
    let outer: ReturnType<
      typeof parseProjectTemplateRepertoireCapabilityYaml
    > | undefined;
    try {
      Array.prototype.push = function guardedPush(...values: unknown[]) {
        callbacks += 1;
        if (nestedFailure === undefined) {
          try {
            parseProjectTemplateRepertoireCapabilityYaml(
              bytes(`steps:\n  - command: ${secret}\n`),
              'workflow',
            );
          } catch (error) {
            nestedFailure = error;
          }
        }
        return Reflect.apply(originalPush, this, values) as number;
      };
      outer = parseProjectTemplateRepertoireCapabilityYaml(
        bytes(yaml),
        'workflow',
      );
    } finally {
      Array.prototype.push = originalPush;
    }
    expect(callbacks).toBeGreaterThan(0);
    expect(nestedFailure).toBeInstanceOf(
      ProjectTemplateRepertoireCapabilityYamlError,
    );
    expect(nestedFailure).toMatchObject({ code: 'INVALID_YAML' });
    expect(String(nestedFailure)).not.toContain(secret);
    expect(outer).toMatchObject({ text: yaml });
    expect(JSON.stringify(outer)).not.toContain(secret);
  });

  it('redacts parser failures and recovers the synchronous guard', () => {
    const secret = 'secret-capability-value';
    let failure: unknown;
    try {
      parseProjectTemplateRepertoireCapabilityYaml(
        bytes(`steps: [${secret}\n`),
        'workflow',
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'INVALID_YAML' });
    expect(String(failure)).not.toContain(secret);
    expect((failure as Error).cause).toBeUndefined();
    expect(parseProjectTemplateRepertoireCapabilityYaml(
      bytes('steps: []\n'),
      'workflow',
    )).toMatchObject({ text: 'steps: []\n' });
  });

  it('does not invoke prototype getters that can rewrite invalid root items', () => {
    const replacement = new YAMLSeq();
    const original = Object.getOwnPropertyDescriptor(
      YAMLMap.prototype,
      'anchor',
    );
    let validationGetterCalls = 0;
    try {
      Object.defineProperty(YAMLMap.prototype, 'anchor', {
        configurable: true,
        get() {
          if (new Error().stack?.includes('rejectUnsafeNode')) {
            validationGetterCalls += 1;
            const items = Object.getOwnPropertyDescriptor(this, 'items')
              ?.value as unknown[] | undefined;
            const pair = items?.[0] as { value?: unknown } | undefined;
            if (pair !== undefined) pair.value = replacement;
          }
          return undefined;
        },
      });
      expect(() => parseProjectTemplateRepertoireCapabilityYaml(
        bytes('steps: invalid\n'),
        'workflow',
      )).toThrow(expect.objectContaining({
        code: 'INVALID_CAPABILITY_YAML',
      }));
    } finally {
      if (original === undefined) delete (YAMLMap.prototype as { anchor?: unknown })
        .anchor;
      else Object.defineProperty(YAMLMap.prototype, 'anchor', original);
    }
    expect(validationGetterCalls).toBe(0);
  });

  it('redacts hostile post-parser accessors and releases the guard', () => {
    const secret = 'secret-post-parser-accessor';
    const originalPush = Array.prototype.push;
    let armed = false;
    try {
      Array.prototype.push = function guardedPush(...values: unknown[]) {
        for (const candidate of values) {
          if (
            armed
            || typeof candidate !== 'object'
            || candidate === null
          ) continue;
          const key = Object.getOwnPropertyDescriptor(candidate, 'key')?.value;
          const keyValue = typeof key === 'object' && key !== null
            ? Object.getOwnPropertyDescriptor(key, 'value')?.value
            : undefined;
          const value = Object.getOwnPropertyDescriptor(candidate, 'value')
            ?.value;
          if (keyValue !== 'steps' || value === undefined) continue;
          armed = true;
          Object.defineProperty(candidate, 'value', {
            configurable: true,
            enumerable: true,
            get() {
              const stack = new Error().stack ?? '';
              if (
                stack.includes('rejectUnsafeNode')
                || stack.includes('validateWorkflowShape')
              ) throw new Error(secret);
              return value;
            },
          });
        }
        return Reflect.apply(originalPush, this, values) as number;
      };
      let thrown: unknown;
      try {
        parseProjectTemplateRepertoireCapabilityYaml(
          bytes('steps: []\n'),
          'workflow',
        );
      } catch (error) {
        thrown = error;
      }
      expect(armed).toBe(true);
      expect(thrown).toMatchObject({ code: 'INVALID_YAML' });
      expect(String(thrown)).not.toContain(secret);
      expect((thrown as Error).cause).toBeUndefined();
    } finally {
      Array.prototype.push = originalPush;
    }
    expect(parseProjectTemplateRepertoireCapabilityYaml(
      bytes('steps: []\n'),
      'workflow',
    )).toMatchObject({ text: 'steps: []\n' });
  });
});
