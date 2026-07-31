import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import { ProjectTemplateValidationError } from '../../features/project-template/errors.js';
import { parseProjectTemplateManifest } from '../../features/project-template/manifest.js';
import {
  calculateProjectTemplateSourceDescriptorSha256,
  MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES,
  parseProjectTemplateRepertoireDependencies,
  parseProjectTemplateSourceDescriptor,
  parseProjectTemplateSourceDescriptorJson,
  PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_PATH,
  projectTemplateSourceDescriptorV1JsonSchema,
  serializeProjectTemplateSourceDescriptor,
} from '../../features/project-template/source-descriptor.js';

const SHA256 = 'a'.repeat(64);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function validDescriptor(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    pack: {
      version: '1.2.3',
      releaseTag: 'v1.2.3',
      assetName: 'project-template.taktpack',
      checksumAssetName: 'project-template.taktpack.sha256',
      sha256: SHA256,
    },
    repertoireDependencies: [
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

describe('project template source descriptor', () => {
  it('parses, canonically serializes, hashes, and round-trips version 1', () => {
    expect(PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_PATH)
      .toBe('.takt-template-source.json');

    const parsed = parseProjectTemplateSourceDescriptor(validDescriptor());
    const serialized = serializeProjectTemplateSourceDescriptor(parsed);

    expect(parsed).toEqual(validDescriptor());
    expect(serialized).toBe(`${JSON.stringify(validDescriptor(), null, 2)}`);
    expect(parseProjectTemplateSourceDescriptor(JSON.parse(serialized)))
      .toEqual(parsed);
    expect(calculateProjectTemplateSourceDescriptorSha256(parsed)).toBe(
      createHash('sha256').update(serialized, 'utf8').digest('hex'),
    );
  });

  it('does not depend on mutable Array iterators or Set methods', () => {
    const dependencies = validDescriptor()['repertoireDependencies'];
    const originalIterator = Array.prototype[Symbol.iterator];
    const originalSetHas = Set.prototype.has;
    const originalSetAdd = Set.prototype.add;
    let iteratorCalls = 0;
    let setCalls = 0;
    let parsed;
    try {
      Array.prototype[Symbol.iterator] = function poisonedIterator(): never {
        iteratorCalls += 1;
        throw new Error('mutable Array iterator invoked');
      };
      Set.prototype.has = function poisonedHas(): never {
        setCalls += 1;
        throw new Error('mutable Set.has invoked');
      };
      Set.prototype.add = function poisonedAdd(): never {
        setCalls += 1;
        throw new Error('mutable Set.add invoked');
      };
      parsed = parseProjectTemplateRepertoireDependencies(dependencies);
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
      Set.prototype.has = originalSetHas;
      Set.prototype.add = originalSetAdd;
    }
    expect(iteratorCalls).toBe(0);
    expect(setCalls).toBe(0);
    expect(parsed).toHaveLength(2);
  });

  it('builds internal data descriptors without inherited get/set hooks', () => {
    const validDependencies = validDescriptor()['repertoireDependencies'];
    const invalidDependencies = (
      validDescriptor()['repertoireDependencies']
    ) as Array<Record<string, unknown>>;
    invalidDependencies[0]!['commit'] = 'short';
    let calls = 0;
    let reentryCalls = 0;
    let reentering = false;
    let parsed;
    let validFailure: unknown;
    let invalidFailure: unknown;
    const originalGet = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'get',
    );
    const originalSet = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'set',
    );
    const poison = () => {
      calls += 1;
      if (!reentering) {
        reentryCalls += 1;
        reentering = true;
        try {
          parseProjectTemplateRepertoireDependencies([]);
        } finally {
          reentering = false;
        }
      }
      return () => undefined;
    };

    Object.defineProperties(Object.prototype, {
      get: { configurable: true, get: poison },
      set: { configurable: true, get: poison },
    });
    try {
      try {
        parsed = parseProjectTemplateRepertoireDependencies(
          validDependencies,
        );
      } catch (error) {
        validFailure = error;
      }
      try {
        parseProjectTemplateRepertoireDependencies(invalidDependencies);
      } catch (error) {
        invalidFailure = error;
      }
    } finally {
      Reflect.deleteProperty(Object.prototype, 'get');
      Reflect.deleteProperty(Object.prototype, 'set');
      if (originalGet !== undefined) {
        Object.defineProperty(Object.prototype, 'get', originalGet);
      }
      if (originalSet !== undefined) {
        Object.defineProperty(Object.prototype, 'set', originalSet);
      }
    }

    expect(calls).toBe(0);
    expect(reentryCalls).toBe(0);
    expect(validFailure).toBeUndefined();
    expect(parsed?.[0]?.scope).toBe('@acme/alpha');
    expect(invalidFailure).toMatchObject({
      name: 'ProjectTemplateValidationError',
      code: 'INVALID_SOURCE',
    });
  });

  it('uses captured receivers for shared dependency parsing', () => {
    const intrinsicObject = Object;
    const intrinsicReflect = Reflect;
    const defineProperty = intrinsicObject.defineProperty;
    const objectDescriptor = intrinsicObject.getOwnPropertyDescriptor(
      globalThis,
      'Object',
    )!;
    const reflectDescriptor = intrinsicObject.getOwnPropertyDescriptor(
      globalThis,
      'Reflect',
    )!;
    const dependencies = validDescriptor()['repertoireDependencies'];
    let objectCalls = 0;
    let reflectCalls = 0;
    let reentryCalls = 0;
    let attemptedReentry = false;
    let parsed;
    let failure: unknown;
    const attemptReentry = () => {
      if (attemptedReentry) return;
      attemptedReentry = true;
      reentryCalls += 1;
      try {
        parseProjectTemplateRepertoireDependencies([]);
      } catch {
        // Calling the nested parser boundary is itself the violation.
      }
    };
    const objectGetter = () => {
      objectCalls += 1;
      attemptReentry();
      return intrinsicObject;
    };
    const reflectGetter = () => {
      reflectCalls += 1;
      attemptReentry();
      return intrinsicReflect;
    };
    const poisonedObjectDescriptor = {
      configurable: true,
      get: objectGetter,
    };
    const poisonedReflectDescriptor = {
      configurable: true,
      get: reflectGetter,
    };

    try {
      defineProperty(globalThis, 'Object', poisonedObjectDescriptor);
      defineProperty(globalThis, 'Reflect', poisonedReflectDescriptor);
      try {
        parsed = parseProjectTemplateRepertoireDependencies(dependencies);
      } catch (error) {
        failure = error;
      }
    } finally {
      defineProperty(globalThis, 'Object', objectDescriptor);
      defineProperty(globalThis, 'Reflect', reflectDescriptor);
    }

    expect(objectCalls).toBe(0);
    expect(reflectCalls).toBe(0);
    expect(reentryCalls).toBe(0);
    expect(failure).toBeUndefined();
    expect(parsed?.[0]?.scope).toBe('@acme/alpha');
  });

  it('rejects a hostile dependency field without coercing it', () => {
    const dependencies = validDescriptor()['repertoireDependencies'];
    let coercionCalls = 0;
    let reentryCalls = 0;
    let attemptedReentry = false;
    const hostileField = {
      [Symbol.toPrimitive]() {
        coercionCalls += 1;
        if (!attemptedReentry) {
          attemptedReentry = true;
          reentryCalls += 1;
          parseProjectTemplateRepertoireDependencies([]);
        }
        return 'request.dependencies';
      },
    };

    expect(() => parseProjectTemplateRepertoireDependencies(
      dependencies,
      hostileField as never,
    )).toThrow(expect.objectContaining({
      name: 'ProjectTemplateValidationError',
      code: 'INVALID_SOURCE',
    }));
    expect(coercionCalls).toBe(0);
    expect(reentryCalls).toBe(0);
  });

  it('rejects an oversized dependency array before descriptor enumeration', async () => {
    const oversized: unknown[] = [];
    oversized.length = 1_000_000_000;
    let hostileLengthCalls = 0;
    const hostileLength = new Proxy([], {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'length') hostileLengthCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const originalDescriptors = Object.getOwnPropertyDescriptors;
    let descriptorCalls = 0;
    Object.getOwnPropertyDescriptors = ((value: object) => {
      if (value === oversized) descriptorCalls += 1;
      return originalDescriptors(value);
    }) as typeof Object.getOwnPropertyDescriptors;
    vi.resetModules();
    let fresh;
    try {
      fresh = await import(
        '../../features/project-template/source-descriptor.js'
      );
    } finally {
      Object.getOwnPropertyDescriptors = originalDescriptors;
    }

    const originalIterator = Array.prototype[Symbol.iterator];
    let iteratorCalls = 0;
    let failure: unknown;
    let hostileFailure: unknown;
    try {
      Array.prototype[Symbol.iterator] = function poisonedIterator(): never {
        iteratorCalls += 1;
        throw new Error('oversized dependency iterator invoked');
      };
      fresh.parseProjectTemplateRepertoireDependencies(oversized);
    } catch (error) {
      failure = error;
    }
    try {
      fresh.parseProjectTemplateRepertoireDependencies(hostileLength);
    } catch (error) {
      hostileFailure = error;
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }
    expect(descriptorCalls).toBe(0);
    expect(iteratorCalls).toBe(0);
    expect(hostileLengthCalls).toBe(0);
    expect(failure).toMatchObject({
      name: 'ProjectTemplateValidationError',
      code: 'LIMIT_EXCEEDED',
    });
    expect(hostileFailure).toMatchObject({
      name: 'ProjectTemplateValidationError',
      code: 'NON_PLAIN_OBJECT',
    });
  });

  it.each([
    ['top-level', (value: Record<string, unknown>) => {
      value['unexpected'] = true;
    }],
    ['pack', (value: Record<string, unknown>) => {
      (value['pack'] as Record<string, unknown>)['unexpected'] = true;
    }],
    ['dependency', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['unexpected'] = true;
    }],
  ])('rejects unknown keys at the %s boundary', (_label, mutate) => {
    const value = validDescriptor();
    mutate(value);
    expectDescriptorError(value, 'UNKNOWN_KEY');
  });

  it('rejects non-plain objects, accessors, and sparse dependency arrays', () => {
    expectDescriptorError(new Date(), 'NON_PLAIN_OBJECT');

    const accessor = validDescriptor();
    Object.defineProperty(accessor['pack'], 'version', {
      enumerable: true,
      get: () => '1.2.3',
    });
    expectDescriptorError(accessor, 'NON_PLAIN_OBJECT');

    const sparse = validDescriptor();
    const dependencies = new Array(2);
    dependencies[1] = dependencyAt(sparse, 0);
    sparse['repertoireDependencies'] = dependencies;
    expectDescriptorError(sparse, 'NON_PLAIN_OBJECT');
  });

  it.each([
    ['pack.version', (value: Record<string, unknown>) => {
      packOf(value)['version'] = 'v1.2.3';
    }],
    ['dependency.version', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['version'] = '2.0';
    }],
  ])('requires strict SemVer for %s', (_field, mutate) => {
    const value = validDescriptor();
    mutate(value);
    expectDescriptorError(value, 'INVALID_SEMVER');
  });

  it.each(['1.2.3', 'v1.2.3'])(
    'binds pack.releaseTag %s to pack.version',
    (releaseTag) => {
      const value = validDescriptor();
      packOf(value)['releaseTag'] = releaseTag;
      expect(parseProjectTemplateSourceDescriptor(value).pack.releaseTag)
        .toBe(releaseTag);
    },
  );

  it('rejects a portable release tag that does not match pack.version', () => {
    const value = validDescriptor();
    for (const releaseTag of ['v1.2.4', 'release+1']) {
      packOf(value)['releaseTag'] = releaseTag;
      expect(() => parseProjectTemplateSourceDescriptor(value)).toThrow(
        expect.objectContaining({
          code: 'INVALID_SOURCE',
          message: expect.stringContaining('must equal pack.version'),
        }),
      );
    }
  });

  it.each(['1.2.3+build.1', 'v1.2.3+build.1'])(
    'represents pack build metadata with releaseTag %s',
    (releaseTag) => {
      const value = validDescriptor();
      packOf(value)['version'] = '1.2.3+build.1';
      packOf(value)['releaseTag'] = releaseTag;
      expect(parseProjectTemplateSourceDescriptor(value).pack).toMatchObject({
        version: '1.2.3+build.1',
        releaseTag,
      });
    },
  );

  it.each([
    'release/v1',
    'リリース',
    'release\u202E1',
    'release%2Fv1',
  ])('rejects a non-portable release tag: %s', (releaseTag) => {
    const value = validDescriptor();
    packOf(value)['releaseTag'] = releaseTag;
    expectDescriptorError(value, 'INVALID_SOURCE');
  });

  it.each([
    ['assetName', 'template.zip'],
    ['checksumAssetName', 'other.taktpack.sha256'],
    ['sha256', 'A'.repeat(64)],
  ])('rejects an invalid pack %s', (field, invalidValue) => {
    const value = validDescriptor();
    packOf(value)[field] = invalidValue;
    expectDescriptorError(
      value,
      field === 'sha256' ? 'INVALID_HASH' : 'INVALID_SOURCE',
    );
  });

  it('accepts legitimate repeated dots in pack asset names', () => {
    const value = validDescriptor();
    packOf(value)['assetName'] = 'project..template.taktpack';
    packOf(value)['checksumAssetName'] =
      'project..template.taktpack.sha256';
    expect(parseProjectTemplateSourceDescriptor(value).pack.assetName)
      .toBe('project..template.taktpack');
  });

  it('accepts exactly 128 repertoire dependencies', () => {
    const value = validDescriptor();
    value['repertoireDependencies'] = createDependencies(128);
    expect(
      parseProjectTemplateSourceDescriptor(value).repertoireDependencies,
    ).toHaveLength(128);
  });

  it('limits repertoire dependencies to 128 entries', () => {
    const value = validDescriptor();
    value['repertoireDependencies'] = createDependencies(129);
    expectDescriptorError(value, 'LIMIT_EXCEEDED');
  });

  it.each([
    '2.0.0',
    'v2.0.0',
    'refs/tags/2.0.0',
    'refs/tags/v2.0.0',
  ])('binds dependency source tag %s to dependency.version', (ref) => {
    const value = validDescriptor();
    dependencyAt(value, 0)['source'] = `github:acme/alpha@${ref}`;
    expect(parseProjectTemplateSourceDescriptor(value)
      .repertoireDependencies[0]!.source).toBe(
      `github:acme/alpha@${ref}`,
    );
  });

  it.each([
    '2.0.0+build.1',
    'v2.0.0+build.1',
    'refs/tags/2.0.0+build.1',
    'refs/tags/v2.0.0+build.1',
  ])('represents dependency build metadata in tag %s', (ref) => {
    const value = validDescriptor();
    dependencyAt(value, 0)['version'] = '2.0.0+build.1';
    dependencyAt(value, 0)['source'] = `github:acme/alpha@${ref}`;
    expect(parseProjectTemplateSourceDescriptor(value)
      .repertoireDependencies[0]).toMatchObject({
      version: '2.0.0+build.1',
      source: `github:acme/alpha@${ref}`,
    });
  });

  it.each([
    ['non-canonical scope', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['scope'] = '@Acme/alpha';
    }],
    ['source without explicit ref', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['source'] = 'github:acme/alpha';
    }],
    ['source coordinate mismatch', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['source'] = 'github:acme/other@v2.0.0';
    }],
    ['non-tag source ref', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['source'] = 'github:acme/alpha@main';
    }],
    ['mismatched source tag', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['source'] = 'github:acme/alpha@v2.0.1';
    }],
    ['uppercase commit', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['commit'] = COMMIT.toUpperCase();
    }],
    ['unsupported capability', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['capabilities'] = ['execute'];
    }],
    ['duplicate capability', (value: Record<string, unknown>) => {
      dependencyAt(value, 0)['capabilities'] = ['edit', 'edit'];
    }],
  ])('rejects a dependency with %s', (_label, mutate) => {
    const value = validDescriptor();
    mutate(value);
    expectDescriptorError(value, 'INVALID_SOURCE');
  });

  it.each([
    '0123456789abcdef0123456789abcdef0123456',
    '0123456789abcdef0123456789abcdef012345678',
    'g123456789abcdef0123456789abcdef01234567',
  ])('rejects a dependency commit that is not lowercase hex40: %s', (commit) => {
    const value = validDescriptor();
    dependencyAt(value, 0)['commit'] = commit;
    expectDescriptorError(value, 'INVALID_SOURCE');
  });

  it('rejects duplicate scopes and non-canonical dependency order', () => {
    const duplicate = validDescriptor();
    dependencyAt(duplicate, 1)['scope'] = '@acme/alpha';
    dependencyAt(duplicate, 1)['source'] =
      'github:acme/alpha@refs/tags/v3.1.0';
    expectDescriptorError(duplicate, 'INVALID_SOURCE');

    const reversed = validDescriptor();
    (reversed['repertoireDependencies'] as unknown[]).reverse();
    expectDescriptorError(reversed, 'INVALID_SOURCE');
  });

  it('keeps dependencies out of manifest v1 and keeps schema 1.1 unsupported', () => {
    const manifest = validManifest();
    manifest['dependencies'] = [];
    expectManifestError(manifest, 'UNKNOWN_KEY');

    const futureManifest = validManifest();
    futureManifest['schemaVersion'] = '1.1';
    expectManifestError(futureManifest, 'UNSUPPORTED_SCHEMA_VERSION');
  });

  it.each([
    [undefined],
    [1],
    ['1.1'],
    ['invalid'],
  ])('uses descriptor taxonomy for schemaVersion %j', (schemaVersion) => {
    const value = validDescriptor();
    if (schemaVersion === undefined) {
      delete value['schemaVersion'];
    } else {
      value['schemaVersion'] = schemaVersion;
    }
    expectDescriptorError(value, 'INVALID_SOURCE_DESCRIPTOR');
  });

  it('parses bounded UTF-8 bytes and strings through the strict JSON boundary', () => {
    const json = serializeProjectTemplateSourceDescriptor(validDescriptor());
    expect(parseProjectTemplateSourceDescriptorJson(json))
      .toEqual(validDescriptor());
    expect(parseProjectTemplateSourceDescriptorJson(
      new TextEncoder().encode(json),
    )).toEqual(validDescriptor());
    expect(calculateProjectTemplateSourceDescriptorSha256(validDescriptor()))
      .toBe(createHash('sha256').update(json, 'utf8').digest('hex'));
  });

  it.each([
    ['minified whitespace', () => JSON.stringify(validDescriptor())],
    ['key order', () => {
      const value = validDescriptor();
      return JSON.stringify({
        pack: value['pack'],
        schemaVersion: value['schemaVersion'],
        repertoireDependencies: value['repertoireDependencies'],
      }, null, 2);
    }],
    ['duplicate key', () => serializeProjectTemplateSourceDescriptor(
      validDescriptor(),
    ).replace(
      '"schemaVersion": "1.0"',
      '"schemaVersion": "1.0",\n  "schemaVersion": "1.0"',
    )],
    ['trailing newline', () => (
      `${serializeProjectTemplateSourceDescriptor(validDescriptor())}\n`
    )],
  ])('rejects non-canonical raw JSON with %s', (_label, createJson) => {
    expect(() => parseProjectTemplateSourceDescriptorJson(createJson()))
      .toThrow(expect.objectContaining({
        code: 'INVALID_SOURCE_DESCRIPTOR',
        message: expect.stringContaining('canonical'),
      }));
  });

  it('enforces 64 KiB before decoding or parsing raw descriptor input', () => {
    expect(MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES).toBe(64 * 1024);

    expect(() => parseProjectTemplateSourceDescriptorJson(
      ' '.repeat(MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES),
    )).toThrow(expect.objectContaining({
      code: 'INVALID_SOURCE_DESCRIPTOR',
      message: expect.not.stringContaining('exceeds'),
    }));
    expect(() => parseProjectTemplateSourceDescriptorJson(
      ' '.repeat(MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES + 1),
    )).toThrow(expect.objectContaining({
      code: 'INVALID_SOURCE_DESCRIPTOR',
      message: expect.stringContaining('exceeds'),
    }));
  });

  it('rejects invalid UTF-8 and invalid JSON before strict parsing', () => {
    expect(() => parseProjectTemplateSourceDescriptorJson(
      Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    )).toThrow(expect.objectContaining({
      code: 'INVALID_SOURCE_DESCRIPTOR',
    }));
    expect(() => parseProjectTemplateSourceDescriptorJson('{"schemaVersion":'))
      .toThrow(expect.objectContaining({
        code: 'INVALID_SOURCE_DESCRIPTOR',
      }));
    const canonical = new TextEncoder().encode(
      serializeProjectTemplateSourceDescriptor(validDescriptor()),
    );
    expect(() => parseProjectTemplateSourceDescriptorJson(
      Uint8Array.from([0xef, 0xbb, 0xbf, ...canonical]),
    )).toThrow(expect.objectContaining({
      code: 'INVALID_SOURCE_DESCRIPTOR',
    }));
  });

  it('publishes a draft-07 schema with parser parity for structural rules', () => {
    const validate = new Ajv({ allErrors: true })
      .compile(projectTemplateSourceDescriptorV1JsonSchema);
    const cases: unknown[] = [
      validDescriptor(),
      descriptorWithBuildMetadata(),
      { ...validDescriptor(), unexpected: true },
      {
        ...validDescriptor(),
        pack: { ...packOf(validDescriptor()), sha256: 'A'.repeat(64) },
      },
      {
        ...validDescriptor(),
        repertoireDependencies: createDependencies(129),
      },
      {
        ...validDescriptor(),
        repertoireDependencies: [{
          ...dependencyAt(validDescriptor(), 0),
          commit: 'g'.repeat(40),
        }],
      },
    ];

    expect(projectTemplateSourceDescriptorV1JsonSchema.$schema)
      .toBe('http://json-schema.org/draft-07/schema#');
    for (const value of cases) {
      const parserAccepts = descriptorAccepts(value);
      expect(validate(value), JSON.stringify(validate.errors))
        .toBe(parserAccepts);
    }
  });

  it('binds the descriptor hash to every canonical field', () => {
    const original = validDescriptor();
    const changed = validDescriptor();
    dependencyAt(changed, 0)['commit'] =
      '1123456789abcdef0123456789abcdef01234567';
    expect(calculateProjectTemplateSourceDescriptorSha256(changed))
      .not.toBe(calculateProjectTemplateSourceDescriptorSha256(original));
  });
});

function packOf(value: Record<string, unknown>): Record<string, unknown> {
  return value['pack'] as Record<string, unknown>;
}

function dependencyAt(
  value: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  return (value['repertoireDependencies'] as Array<Record<string, unknown>>)[index]!;
}

function expectDescriptorError(value: unknown, code: string): void {
  expect(() => parseProjectTemplateSourceDescriptor(value)).toThrow(
    expect.objectContaining<Partial<ProjectTemplateValidationError>>({
      name: 'ProjectTemplateValidationError',
      code,
    }),
  );
}

function descriptorAccepts(value: unknown): boolean {
  try {
    parseProjectTemplateSourceDescriptor(value);
    return true;
  } catch {
    return false;
  }
}

function createDependencies(count: number): Array<Record<string, unknown>> {
  const dependency = dependencyAt(validDescriptor(), 0);
  return Array.from({ length: count }, (_, index) => {
    const repo = `repo-${String(index).padStart(3, '0')}`;
    return {
      ...dependency,
      scope: `@acme/${repo}`,
      source: `github:acme/${repo}@v2.0.0`,
    };
  });
}

function descriptorWithBuildMetadata(): Record<string, unknown> {
  const value = validDescriptor();
  packOf(value)['version'] = '1.2.3+build.1';
  packOf(value)['releaseTag'] = 'v1.2.3+build.1';
  dependencyAt(value, 0)['version'] = '2.0.0+build.1';
  dependencyAt(value, 0)['source'] =
    'github:acme/alpha@refs/tags/v2.0.0+build.1';
  return value;
}

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    packVersion: '1.2.3',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'github',
      uri: 'https://github.com/acme/template',
      ref: 'v1.2.3',
      commit: COMMIT,
    },
    entries: [],
  };
}

function expectManifestError(value: unknown, code: string): void {
  expect(() => parseProjectTemplateManifest(value)).toThrow(
    expect.objectContaining<Partial<ProjectTemplateValidationError>>({
      name: 'ProjectTemplateValidationError',
      code,
    }),
  );
}
