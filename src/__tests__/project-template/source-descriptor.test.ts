import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProjectTemplateValidationError } from '../../features/project-template/errors.js';
import { parseProjectTemplateManifest } from '../../features/project-template/manifest.js';
import {
  calculateProjectTemplateSourceDescriptorSha256,
  parseProjectTemplateSourceDescriptor,
  PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_PATH,
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

  it.each([
    'release/v1',
    'release+1',
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
    ['assetName', 'template..v1.taktpack'],
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

  it('limits repertoire dependencies to 128 entries', () => {
    const value = validDescriptor();
    const dependency = dependencyAt(value, 0);
    value['repertoireDependencies'] = Array.from(
      { length: 129 },
      (_, index) => ({
        ...dependency,
        scope: `@acme/repo-${String(index).padStart(3, '0')}`,
        source: `github:acme/repo-${String(index).padStart(3, '0')}@v2.0.0`,
      }),
    );
    expectDescriptorError(value, 'LIMIT_EXCEEDED');
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
