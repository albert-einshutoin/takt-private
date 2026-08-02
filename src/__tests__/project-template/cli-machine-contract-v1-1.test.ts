import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseProjectTemplateCliEnvelopeJson } from '../../features/project-template/cli-machine-contract.js';
import {
  PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1,
  ProjectTemplateCliV1_1ContractError,
  createProjectTemplateCliV1_1Success,
  parseProjectTemplateCliV1_1EnvelopeJson,
  presentProjectTemplateCliV1_1Envelope,
} from '../../features/project-template/cli-machine-contract-v1-1.js';

const FIXTURE_ROOT = join(
  import.meta.dirname,
  '../fixtures/project-template/cli-schema-1.1',
);
const HASH = 'a'.repeat(64);

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_ROOT, name), 'utf8');
}

describe('project template CLI machine contract schema 1.1', () => {
  it.each([
    'inspect.json',
    'export.json',
    'diff.json',
    'apply-dry-run.json',
    'list.json',
  ])('round-trips the closed TaktDesk fixture %s canonically', (name) => {
    const parsed = parseProjectTemplateCliV1_1EnvelopeJson(fixture(name));

    expect(PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1).toBe('1.1');
    expect(parseProjectTemplateCliV1_1EnvelopeJson(
      presentProjectTemplateCliV1_1Envelope(parsed),
    )).toEqual(parsed);
  });

  it('keeps the schema 1.0 decoder unchanged and version-specific', () => {
    expect(() => parseProjectTemplateCliEnvelopeJson(fixture('inspect.json'))).toThrow();
    expect(() => parseProjectTemplateCliV1_1EnvelopeJson(
      fixture('inspect.json').replace('"1.1"', '"1.0"'),
    )).toThrow(ProjectTemplateCliV1_1ContractError);
  });

  it.each([
    ['unknown root key', (value: Record<string, unknown>) => { value.extra = true; }],
    ['flat detail field', (value: Record<string, any>) => { value.result.manifestId = HASH; }],
    ['unknown action', (value: Record<string, any>) => { value.result.detail.targets.items[0].action = 'replace'; }],
    ['duplicate target id', (value: Record<string, any>) => {
      value.result.detail.targets.items[1].targetId = value.result.detail.targets.items[0].targetId;
    }],
    ['foreign child manifest', (value: Record<string, any>) => {
      value.result.detail.targets.items[0].manifestId = '0'.repeat(64);
    }],
    ['foreign conflict target', (value: Record<string, any>) => {
      value.result.detail.conflicts.items[0].targetId = '0'.repeat(64);
    }],
    ['action count mismatch', (value: Record<string, any>) => { value.result.detail.actionCounts.add = 2; }],
    ['conflict count mismatch', (value: Record<string, any>) => { value.result.conflictCount = 0; }],
  ])('fails closed for %s', (_name, mutate) => {
    const value = JSON.parse(fixture('diff.json')) as Record<string, unknown>;
    mutate(value);

    expect(() => createProjectTemplateCliV1_1Success(value as never)).toThrow(
      ProjectTemplateCliV1_1ContractError,
    );
  });

  it('requires explicit truncation and PARTIAL_RESULT for bounded detail collections', () => {
    const value = JSON.parse(fixture('inspect.json')) as Record<string, any>;
    value.result.entryCount = 2;
    value.result.detail.targets.totalCount = 2;
    value.result.detail.targets.truncated = true;
    value.warnings = [{ code: 'PARTIAL_RESULT' }];
    expect(createProjectTemplateCliV1_1Success(value as never)).toMatchObject({
      warnings: [{ code: 'PARTIAL_RESULT' }],
    });

    value.warnings = [];
    expect(() => createProjectTemplateCliV1_1Success(value as never)).toThrow();
    value.warnings = [{ code: 'PARTIAL_RESULT' }];
    value.result.detail.targets.items = Array.from(
      { length: 257 },
      (_, index) => ({
        targetId: index.toString(16).padStart(64, '0'),
        manifestId: HASH,
        path: `entry-${index}.yaml`,
        policy: 'managed',
        capabilities: [],
      }),
    );
    value.result.detail.targets.totalCount = 257;
    expect(() => createProjectTemplateCliV1_1Success(value as never)).toThrow();
  });

  it('accepts the bounded per-capability warning aggregate up to 4096 x 3', () => {
    const value = JSON.parse(fixture('diff.json')) as Record<string, any>;
    value.result.detail.capabilityWarnings.totalCount = 12_288;
    value.result.detail.capabilityWarnings.truncated = true;
    value.warnings = [{ code: 'PARTIAL_RESULT' }];

    expect(createProjectTemplateCliV1_1Success(value as never)).toMatchObject({
      result: { detail: { capabilityWarnings: { totalCount: 12_288, truncated: true } } },
    });

    value.result.detail.capabilityWarnings.totalCount = 12_289;
    expect(() => createProjectTemplateCliV1_1Success(value as never)).toThrow(
      ProjectTemplateCliV1_1ContractError,
    );
  });

  it('rejects hostile getters, proxies, cycles, and sparse arrays without invoking traps', () => {
    const getter = vi.fn(() => fixture('inspect.json'));
    const accessor = Object.defineProperty({}, 'schemaVersion', {
      enumerable: true,
      get: getter,
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const proxyGetter = vi.fn(() => '1.1');
    const proxy = new Proxy({}, { get: proxyGetter });
    const sparse = JSON.parse(fixture('inspect.json')) as Record<string, any>;
    sparse.result.detail.targets.items = Array(2);

    for (const value of [accessor, cycle, proxy, sparse]) {
      expect(() => createProjectTemplateCliV1_1Success(value as never)).toThrow(
        ProjectTemplateCliV1_1ContractError,
      );
    }
    expect(getter).not.toHaveBeenCalled();
    expect(proxyGetter).not.toHaveBeenCalled();
  });

  it('rejects absolute local paths, credential-like values, and source identity mismatch', () => {
    const value = JSON.parse(fixture('apply-dry-run.json')) as Record<string, any>;
    value.result.detail.source.uri = '/Users/alice/private.taktpack';
    expect(() => createProjectTemplateCliV1_1Success(value as never)).toThrow();

    delete value.result.detail.source.uri;
    value.result.detail.source.sourceId = `ghp_${'x'.repeat(36)}`;
    expect(() => createProjectTemplateCliV1_1Success(value as never)).toThrow();

    value.result.detail.source.sourceId = 'c'.repeat(64);
    value.result.detail.source.manifestId = '0'.repeat(64);
    expect(() => createProjectTemplateCliV1_1Success(value as never)).toThrow();
  });

  it('keeps the closed DTO boundary after ambient intrinsic poisoning', () => {
    const valid = JSON.parse(fixture('inspect.json')) as Record<string, unknown>;
    const withSecret = JSON.parse(fixture('inspect.json')) as Record<string, unknown>;
    withSecret.localAuthority = 'LOCAL_SECRET';
    const poison = () => { throw new Error('ambient intrinsic must not run'); };
    const targets: readonly (readonly [object, PropertyKey])[] = [
      [Object, 'keys'],
      [Object, 'hasOwn'],
      [Object, 'fromEntries'],
      [Array, 'isArray'],
      [Array.prototype, 'map'],
      [Array.prototype, 'some'],
      [Array.prototype, 'reduce'],
      [Array.prototype, 'push'],
      [Number, 'isSafeInteger'],
      [RegExp.prototype, 'test'],
      [Set.prototype, 'has'],
      [Set.prototype, 'add'],
      [Map.prototype, 'get'],
      [Map.prototype, 'set'],
    ];
    const descriptors: PropertyDescriptor[] = new Array(targets.length);
    for (let index = 0; index < targets.length; index += 1) {
      const [target, key] = targets[index]!;
      descriptors[index] = Object.getOwnPropertyDescriptor(target, key)!;
    }

    let accepted: ReturnType<typeof createProjectTemplateCliV1_1Success> | undefined;
    let rejectedUnknown = false;
    try {
      for (let index = 0; index < targets.length; index += 1) {
        const [target, key] = targets[index]!;
        Object.defineProperty(target, key, {
          ...descriptors[index],
          value: poison,
        });
      }
      accepted = createProjectTemplateCliV1_1Success(valid as never);
      try {
        createProjectTemplateCliV1_1Success(withSecret as never);
      } catch (error) {
        rejectedUnknown = error instanceof ProjectTemplateCliV1_1ContractError;
      }
    } finally {
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        const [target, key] = targets[index]!;
        Object.defineProperty(target, key, descriptors[index]!);
      }
    }

    expect(accepted).toMatchObject({ schemaVersion: '1.1', status: 'success' });
    expect(accepted).not.toBe(valid);
    expect(rejectedUnknown).toBe(true);
    expect(JSON.stringify(accepted)).not.toContain('LOCAL_SECRET');
  });
});
