import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProjectTemplateValidationError } from '../../features/project-template/errors.js';
import {
  calculateProjectTemplateRepertoireDependencyLockSha256,
  MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES,
  parseProjectTemplateRepertoireDependencyLock,
  parseProjectTemplateRepertoireDependencyLockJson,
  PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
  serializeProjectTemplateRepertoireDependencyLock,
} from '../../features/project-template/repertoire-dependency-lock.js';

const SOURCE_DESCRIPTOR_SHA256 = 'a'.repeat(64);
const MANIFEST_SHA256 = 'b'.repeat(64);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function validLock(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    sourceDescriptorSha256: SOURCE_DESCRIPTOR_SHA256,
    manifestSha256: MANIFEST_SHA256,
    dependencies: [
      {
        scope: '@acme/alpha',
        version: '2.0.0',
        source: 'github:acme/alpha@refs/tags/v2.0.0',
        commit: COMMIT,
        capabilities: ['edit'],
      },
      {
        scope: '@acme/zeta',
        version: '3.1.0',
        source: 'github:acme/zeta@v3.1.0',
        commit: 'abcdef0123456789abcdef0123456789abcdef01',
        capabilities: [],
      },
    ],
  };
}

describe('project template repertoire dependency lock', () => {
  it('parses, deeply freezes, canonically serializes, hashes, and snapshots v1', () => {
    expect(PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH)
      .toBe('.takt-template-repertoire-lock.json');
    const input = validLock();
    const parsed = parseProjectTemplateRepertoireDependencyLock(input);
    const serialized = serializeProjectTemplateRepertoireDependencyLock(input);

    dependencyAt(input, 0)['commit'] = 'f'.repeat(40);
    (input['dependencies'] as unknown[]).length = 0;

    expect(parsed).toEqual(validLock());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.dependencies)).toBe(true);
    expect(Object.isFrozen(parsed.dependencies[0])).toBe(true);
    expect(Object.isFrozen(parsed.dependencies[0]!.capabilities)).toBe(true);
    expect(serialized).toBe(JSON.stringify(validLock(), null, 2));
    expect(calculateProjectTemplateRepertoireDependencyLockSha256(validLock()))
      .toBe(createHash('sha256').update(serialized, 'utf8').digest('hex'));
  });

  it('accepts an empty canonical dependency lock', () => {
    const value = validLock();
    value['dependencies'] = [];

    expect(parseProjectTemplateRepertoireDependencyLock(value).dependencies)
      .toEqual([]);
  });

  it.each([
    ['top-level path', (value: Record<string, unknown>) => {
      value['path'] = '.takt';
    }],
    ['import timestamp', (value: Record<string, unknown>) => {
      value['imported_at'] = '2026-07-31T00:00:00.000Z';
    }],
    ['package bytes', (value: Record<string, unknown>) => {
      value['package'] = { bytes: 'secret' };
    }],
    ['dependency bytes', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['bytes'] = 'secret';
    }],
    ['dependency secret', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['secret'] = 'token';
    }],
  ])('rejects prohibited or unknown data: %s', (_label, mutate) => {
    const value = validLock();
    mutate(value);
    expectLockError(value, 'UNKNOWN_KEY');
  });

  it.each([
    [undefined, 'INVALID_LOCK'],
    [1, 'INVALID_LOCK'],
    ['invalid', 'INVALID_LOCK'],
    ['1.1', 'UNSUPPORTED_SCHEMA_VERSION'],
    ['2.0', 'UNSUPPORTED_SCHEMA_MAJOR'],
  ])('rejects malformed or future schemaVersion %j', (schemaVersion, code) => {
    const value = validLock();
    if (schemaVersion === undefined) {
      delete value['schemaVersion'];
    } else {
      value['schemaVersion'] = schemaVersion;
    }
    expectLockError(value, code);
  });

  it.each([
    ['source descriptor hash', 'sourceDescriptorSha256'],
    ['manifest hash', 'manifestSha256'],
  ])('requires a lowercase SHA-256 for %s', (_label, field) => {
    for (const invalid of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
      const value = validLock();
      value[field] = invalid;
      expectLockError(value, 'INVALID_HASH');
    }
  });

  it.each([
    ['scope mismatch', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['scope'] = '@acme/other';
    }],
    ['version mismatch', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['version'] = '2.0.1';
    }],
    ['branch source', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['source'] = 'github:acme/alpha@main';
    }],
    ['uppercase commit', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['commit'] = COMMIT.toUpperCase();
    }],
    ['short commit', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['commit'] = COMMIT.slice(1);
    }],
    ['unsupported capability', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['capabilities'] = ['execute'];
    }],
    ['duplicate capability', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['capabilities'] = ['edit', 'edit'];
    }],
  ])('reuses descriptor dependency invariants: %s', (_label, mutate) => {
    const value = validLock();
    mutate(value);
    expectLockError(value);
  });

  it('rejects duplicate and non-ASCII-canonical scope ordering', () => {
    const duplicate = validLock();
    dependencyAt(duplicate, 1)['scope'] = '@acme/alpha';
    dependencyAt(duplicate, 1)['source'] = 'github:acme/alpha@v3.1.0';
    expectLockError(duplicate, 'INVALID_SOURCE');

    const reversed = validLock();
    (reversed['dependencies'] as unknown[]).reverse();
    expectLockError(reversed, 'INVALID_SOURCE');
  });

  it('accepts 128 dependencies and rejects 129', () => {
    const atLimit = validLock();
    atLimit['dependencies'] = createDependencies(128);
    expect(parseProjectTemplateRepertoireDependencyLock(atLimit).dependencies)
      .toHaveLength(128);

    const overLimit = validLock();
    overLimit['dependencies'] = createDependencies(129);
    expectLockError(overLimit, 'LIMIT_EXCEEDED');
  });

  it('rejects accessors, proxies, coercion objects, and sparse arrays', () => {
    const accessor = validLock();
    Object.defineProperty(accessor, 'manifestSha256', {
      enumerable: true,
      get: () => MANIFEST_SHA256,
    });
    expectLockError(accessor, 'NON_PLAIN_OBJECT');

    expectLockError(new Proxy(validLock(), {}), 'NON_PLAIN_OBJECT');

    const proxiedDependency = validLock();
    const dependency = dependencyAt(proxiedDependency, 0);
    (proxiedDependency['dependencies'] as unknown[])[0] =
      new Proxy(dependency, {});
    expectLockError(proxiedDependency, 'NON_PLAIN_OBJECT');

    const coercion = validLock();
    coercion['manifestSha256'] = {
      toString: () => MANIFEST_SHA256,
    };
    expectLockError(coercion, 'INVALID_HASH');

    const sparse = validLock();
    const dependencies = new Array(2);
    dependencies[1] = dependencyAt(sparse, 0);
    sparse['dependencies'] = dependencies;
    expectLockError(sparse, 'NON_PLAIN_OBJECT');
  });

  it('parses only bounded fatal UTF-8 canonical JSON', () => {
    const json = serializeProjectTemplateRepertoireDependencyLock(validLock());
    expect(parseProjectTemplateRepertoireDependencyLockJson(json))
      .toEqual(validLock());
    expect(parseProjectTemplateRepertoireDependencyLockJson(
      new TextEncoder().encode(json),
    )).toEqual(validLock());

    expect(() => parseProjectTemplateRepertoireDependencyLockJson(
      JSON.stringify(validLock()),
    )).toThrow(expect.objectContaining({
      code: 'INVALID_LOCK',
      message: expect.stringContaining('canonical'),
    }));
    expect(() => parseProjectTemplateRepertoireDependencyLockJson(
      Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    )).toThrow(expect.objectContaining({ code: 'INVALID_LOCK' }));
    expect(() => parseProjectTemplateRepertoireDependencyLockJson(
      '{"schemaVersion":',
    )).toThrow(expect.objectContaining({ code: 'INVALID_LOCK' }));
    expect(() => parseProjectTemplateRepertoireDependencyLockJson(
      json.replace(
        '"schemaVersion": "1.0"',
        '"schemaVersion": "1.0",\n  "schemaVersion": "1.0"',
      ),
    )).toThrow(expect.objectContaining({ code: 'INVALID_LOCK' }));
    expect(() => parseProjectTemplateRepertoireDependencyLockJson(
      Uint8Array.from([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode(json),
      ]),
    )).toThrow(expect.objectContaining({ code: 'INVALID_LOCK' }));
    expect(() => parseProjectTemplateRepertoireDependencyLockJson(
      `${json}\n`,
    )).toThrow(expect.objectContaining({ code: 'INVALID_LOCK' }));
  });

  it('enforces the raw lock byte bound before decoding or parsing', () => {
    expect(MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES)
      .toBe(256 * 1024);
    expect(() => parseProjectTemplateRepertoireDependencyLockJson(
      ' '.repeat(MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES),
    )).toThrow(expect.objectContaining({
      code: 'INVALID_LOCK',
      message: expect.not.stringContaining('exceeds'),
    }));
    expect(() => parseProjectTemplateRepertoireDependencyLockJson(
      ' '.repeat(MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES + 1),
    )).toThrow(expect.objectContaining({
      code: 'LIMIT_EXCEEDED',
      message: expect.stringContaining('exceeds'),
    }));
  });
});

function dependencyAt(
  value: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  return (value['dependencies'] as Array<Record<string, unknown>>)[index]!;
}

function expectLockError(value: unknown, code?: string): void {
  expect(() => parseProjectTemplateRepertoireDependencyLock(value)).toThrow(
    expect.objectContaining<Partial<ProjectTemplateValidationError>>({
      name: 'ProjectTemplateValidationError',
      ...(code === undefined ? {} : { code }),
    }),
  );
}

function createDependencies(count: number): Array<Record<string, unknown>> {
  const dependency = dependencyAt(validLock(), 0);
  return Array.from({ length: count }, (_, index) => {
    const repo = `repo-${String(index).padStart(3, '0')}`;
    return {
      ...dependency,
      scope: `@acme/${repo}`,
      source: `github:acme/${repo}@v2.0.0`,
    };
  });
}
