import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseProjectTemplateManifest,
  parseTemplateLock,
  ProjectTemplateValidationError,
  projectTemplateManifestV1JsonSchema,
  serializeTemplateLock,
} from '../../features/project-template/index.js';

const fixturePath = (name: string): string => fileURLToPath(
  new URL(`../fixtures/project-template/${name}`, import.meta.url),
);

const readFixture = (name: string): unknown => JSON.parse(readFileSync(fixturePath(name), 'utf8'));

const validManifest = (): Record<string, unknown> => readFixture('valid-manifest.json') as Record<string, unknown>;

function expectValidationCode(value: unknown, code: string): void {
  try {
    parseProjectTemplateManifest(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectTemplateValidationError);
    expect((error as ProjectTemplateValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected validation error ${code}`);
}

describe('project template manifest public contract', () => {
  it('should parse and serialize a version 1 manifest without losing its provenance or entry policy', async () => {
    const publicApi = (await import('../../index.js')) as unknown as Record<string, unknown>;
    expect(typeof publicApi['parseProjectTemplateManifest']).toBe('function');
    expect(typeof publicApi['serializeProjectTemplateManifest']).toBe('function');

    const parse = publicApi['parseProjectTemplateManifest'] as (value: unknown) => unknown;
    const serialize = publicApi['serializeProjectTemplateManifest'] as (value: unknown) => string;
    const manifest = {
      schemaVersion: '1.0',
      packVersion: '1.2.3',
      takt: { minVersion: '0.48.0', maxVersion: '0.49.0' },
      source: {
        kind: 'github',
        uri: 'github:example/project-template',
        ref: 'v1.2.3',
        commit: '0123456789abcdef0123456789abcdef01234567',
      },
      capabilities: ['executable'],
      entries: [
        {
          path: '.takt/hooks/prepare.sh',
          policy: 'managed',
          mode: '0755',
          sha256: 'a'.repeat(64),
          capabilities: ['executable'],
        },
      ],
    };

    expect(JSON.parse(serialize(parse(manifest)))).toEqual(manifest);
  });

  it('should expose a JSON Schema contract that requires portable manifest provenance', () => {
    expect(projectTemplateManifestV1JsonSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(projectTemplateManifestV1JsonSchema.required).toEqual([
      'schemaVersion', 'packVersion', 'takt', 'source', 'entries',
    ]);
  });

  it('should parse a good fixture and reject a bad fixture with a typed error code', () => {
    expect(parseProjectTemplateManifest(validManifest()).packVersion).toBe('1.2.3');
    expectValidationCode(readFixture('unknown-key-manifest.json'), 'UNKNOWN_KEY');
  });

  it('should reject an unknown schema major version', () => {
    const manifest = validManifest();
    manifest['schemaVersion'] = '2.0';
    expectValidationCode(manifest, 'UNSUPPORTED_SCHEMA_MAJOR');
  });

  it('should reject unknown keys at every contract boundary', () => {
    const manifest = validManifest();
    manifest['notInTheContract'] = true;
    expectValidationCode(manifest, 'UNKNOWN_KEY');
  });

  it('should reject a duplicate entry path', () => {
    const manifest = validManifest();
    const entries = manifest['entries'] as unknown[];
    entries.push({ ...entries[0] as Record<string, unknown> });
    expectValidationCode(manifest, 'DUPLICATE_ENTRY_PATH');
  });

  it('should reject an entry policy conflict', () => {
    const manifest = validManifest();
    const entries = manifest['entries'] as unknown[];
    entries.push({ ...(entries[0] as Record<string, unknown>), policy: 'merge' });
    expectValidationCode(manifest, 'POLICY_CONFLICT');
  });

  it('should reject case-colliding entry paths', () => {
    const manifest = validManifest();
    const entries = manifest['entries'] as unknown[];
    entries.push({ ...(entries[0] as Record<string, unknown>), path: '.takt/HOOKS/prepare.sh' });
    expectValidationCode(manifest, 'PATH_CASE_COLLISION');
  });

  it.each([
    ['packVersion', (manifest: Record<string, unknown>) => { manifest['packVersion'] = '1.2'; }],
    ['takt.minVersion', (manifest: Record<string, unknown>) => {
      (manifest['takt'] as Record<string, unknown>)['minVersion'] = 'v0.48.0';
    }],
    ['takt.maxVersion', (manifest: Record<string, unknown>) => {
      (manifest['takt'] as Record<string, unknown>)['maxVersion'] = '0.49';
    }],
  ])('should reject invalid SemVer in %s', (_field, change) => {
    const manifest = validManifest();
    change(manifest);
    expectValidationCode(manifest, 'INVALID_SEMVER');
  });

  it('should reject an entry with no SHA-256 digest', () => {
    const manifest = validManifest();
    delete ((manifest['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['sha256'];
    expectValidationCode(manifest, 'MISSING_HASH');
  });

  it.each([
    '/absolute/path',
    '../outside',
    '.takt/../outside',
    'C:\\Windows\\system32',
    '\\\\server\\share\\template',
    '.takt\\hooks\\prepare.sh',
  ])('should reject an unsafe POSIX or Windows path: %s', (path) => {
    const manifest = validManifest();
    (manifest['entries'] as Array<Record<string, unknown>>)[0]!['path'] = path;
    expectValidationCode(manifest, 'INVALID_PATH');
  });

  it('should reject an invalid POSIX mode', () => {
    const manifest = validManifest();
    (manifest['entries'] as Array<Record<string, unknown>>)[0]!['mode'] = '755';
    expectValidationCode(manifest, 'INVALID_MODE');
  });

  it('should require executable capability declarations for executable entries', () => {
    const manifest = validManifest();
    manifest['capabilities'] = [];
    delete ((manifest['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['capabilities'];
    expectValidationCode(manifest, 'UNDECLARED_CAPABILITY');
  });

  it('should require every entry capability to be declared by the manifest', () => {
    const manifest = validManifest();
    manifest['capabilities'] = [];
    expectValidationCode(manifest, 'UNDECLARED_CAPABILITY');
  });

  it('should validate and round-trip a lock pinned to the source commit', () => {
    const lock = {
      schemaVersion: '1.0',
      packVersion: '1.2.3',
      source: {
        kind: 'github',
        uri: 'github:example/project-template',
        ref: 'v1.2.3',
        commit: '0123456789abcdef0123456789abcdef01234567',
      },
      entries: [{
        path: '.takt/hooks/prepare.sh',
        mode: '0755',
        sha256: 'a'.repeat(64),
      }],
    };

    expect(JSON.parse(serializeTemplateLock(parseTemplateLock(lock)))).toEqual(lock);
  });
});
