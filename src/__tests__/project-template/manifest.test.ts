import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import * as projectTemplate from '../../features/project-template/index.js';
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
        uri: 'https://github.com/example/project-template',
        ref: 'v1.2.3',
        commit: '0123456789abcdef0123456789abcdef01234567',
      },
      capabilities: ['executable'],
      entries: [
        {
          path: 'hooks/prepare.sh',
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
    expect(projectTemplateManifestV1JsonSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
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
    entries.push({ ...(entries[0] as Record<string, unknown>), path: 'HOOKS/prepare.sh' });
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
    '.takt/hooks/prepare.sh',
    'workflows/CON.yaml',
    'workflows/task.yaml:secret',
    'workflows/task.yaml.',
    'workflows/task.yaml ',
    'workflows/ta\u0001sk.yaml',
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

  it('should reject NFC and NFD path collisions', () => {
    const manifest = validManifest();
    const entry = (manifest['entries'] as Array<Record<string, unknown>>)[0]!;
    entry['path'] = 'workflows/caf\u00e9.yaml';
    (manifest['entries'] as Array<Record<string, unknown>>).push({
      ...entry,
      path: 'workflows/cafe\u0301.yaml',
    });
    expectValidationCode(manifest, 'PATH_NORMALIZATION_COLLISION');
  });

  it('should reject non-plain objects before reading inherited values', () => {
    const manifest = validManifest();
    Object.setPrototypeOf(manifest, { injected: true });
    expectValidationCode(manifest, 'NON_PLAIN_OBJECT');
  });

  it('should reject sparse or extended arrays as non-JSON input', () => {
    const manifest = validManifest();
    manifest['entries'] = new Array(1);
    expectValidationCode(manifest, 'NON_PLAIN_OBJECT');

    const extendedEntries = [
      ...((validManifest()['entries']) as unknown[]),
    ] as unknown[] & { metadata?: string };
    extendedEntries.metadata = 'not-json-array-data';
    const secondManifest = validManifest();
    secondManifest['entries'] = extendedEntries;
    expectValidationCode(secondManifest, 'NON_PLAIN_OBJECT');
  });

  it('should enforce bounded entry and string counts before expensive validation', () => {
    const tooManyEntries = validManifest();
    tooManyEntries['entries'] = Array.from({ length: 4097 }, (_, index) => ({
      path: `workflows/${index}.yaml`,
      policy: 'managed',
      mode: '0644',
      sha256: 'a'.repeat(64),
    }));
    expectValidationCode(tooManyEntries, 'LIMIT_EXCEEDED');

    const longRef = validManifest();
    (longRef['source'] as Record<string, unknown>)['ref'] = 'x'.repeat(257);
    expectValidationCode(longRef, 'LIMIT_EXCEEDED');
  });

  it('should reject a TAKT version range whose minimum exceeds its maximum', () => {
    const manifest = validManifest();
    manifest['takt'] = { minVersion: '2.0.0', maxVersion: '1.9.9' };
    expectValidationCode(manifest, 'INVALID_VERSION_RANGE');
  });

  it.each([
    ['github', 'github:example/project-template', 'v1.2.3'],
    ['github', 'https://github.com/example/project-template.git', 'v1.2.3'],
    ['git', 'ssh://git@example.com/project/template.git', 'main'],
    ['git', 'https://example.com/project.git?token=secret', 'main'],
    ['local', '/Users/example/template', 'workspace'],
    ['local', '../template', 'workspace'],
    ['local', 'templates/default', 'main'],
  ])('should reject non-canonical %s source provenance', (kind, uri, ref) => {
    const manifest = validManifest();
    manifest['source'] = {
      kind,
      uri,
      ref,
      commit: '0123456789abcdef0123456789abcdef01234567',
    };
    expectValidationCode(manifest, 'INVALID_SOURCE');
  });

  it.each(['.', '.takt/templates/default'])('should accept a portable local source uri: %s', (uri) => {
    const manifest = validManifest();
    manifest['source'] = {
      kind: 'local',
      uri,
      ref: 'workspace',
      commit: '0123456789abcdef0123456789abcdef01234567',
    };
    expect(parseProjectTemplateManifest(manifest).source).toMatchObject({ kind: 'local', uri });
  });

  it('should validate and round-trip a lock pinned to the source commit', () => {
    const lock = {
      schemaVersion: '1.0',
      packVersion: '1.2.3',
      source: {
        kind: 'github',
        uri: 'https://github.com/example/project-template',
        ref: 'v1.2.3',
        commit: '0123456789abcdef0123456789abcdef01234567',
      },
      manifestSha256: 'b'.repeat(64),
      capabilities: ['executable'],
      entries: [{
        path: 'hooks/prepare.sh',
        policy: 'managed',
        mode: '0755',
        sha256: 'a'.repeat(64),
        capabilities: ['executable'],
      }],
    };

    expect(JSON.parse(serializeTemplateLock(parseTemplateLock(lock)))).toEqual(lock);
  });

  it('should reject duplicate and case-colliding paths in a lock', () => {
    const lock = {
      schemaVersion: '1.0',
      packVersion: '1.2.3',
      source: {
        kind: 'github',
        uri: 'https://github.com/example/project-template',
        ref: 'v1.2.3',
        commit: '0123456789abcdef0123456789abcdef01234567',
      },
      manifestSha256: 'b'.repeat(64),
      capabilities: [],
      entries: [
        { path: 'config.json', policy: 'managed', mode: '0644', sha256: 'a'.repeat(64), capabilities: [] },
        { path: 'config.json', policy: 'managed', mode: '0644', sha256: 'b'.repeat(64), capabilities: [] },
      ],
    };

    expect(() => parseTemplateLock(lock)).toThrow(expect.objectContaining({ code: 'DUPLICATE_ENTRY_PATH' }));
    lock.entries[1]!.path = 'CONFIG.json';
    expect(() => parseTemplateLock(lock)).toThrow(expect.objectContaining({ code: 'PATH_CASE_COLLISION' }));
  });

  it('should reject undeclared executable capability in a standalone lock', () => {
    const manifest = parseProjectTemplateManifest(validManifest());
    const lock = {
      schemaVersion: '1.0',
      manifestSha256: 'b'.repeat(64),
      packVersion: manifest.packVersion,
      source: manifest.source,
      capabilities: [],
      entries: manifest.entries.map((entry) => ({
        path: entry.path,
        policy: entry.policy,
        mode: entry.mode,
        sha256: entry.sha256,
        capabilities: [],
      })),
    };
    expect(() => parseTemplateLock(lock)).toThrow(expect.objectContaining({ code: 'UNDECLARED_CAPABILITY' }));
  });

  it('should bind a lock to the canonical manifest and reject any drift', () => {
    const api = projectTemplate as unknown as Record<string, unknown>;
    expect(typeof api['calculateProjectTemplateManifestSha256']).toBe('function');
    expect(typeof api['validateManifestLockPair']).toBe('function');
    const calculate = api['calculateProjectTemplateManifestSha256'] as (value: unknown) => string;
    const validatePair = api['validateManifestLockPair'] as (manifest: unknown, lock: unknown) => void;
    const manifest = parseProjectTemplateManifest(validManifest());
    const lock = {
      schemaVersion: '1.0',
      manifestSha256: calculate(manifest),
      packVersion: manifest.packVersion,
      source: manifest.source,
      capabilities: manifest.capabilities ?? [],
      entries: manifest.entries.map((entry) => ({
        path: entry.path,
        policy: entry.policy,
        mode: entry.mode,
        sha256: entry.sha256,
        capabilities: entry.capabilities ?? [],
      })),
    };

    expect(() => validatePair(manifest, lock)).not.toThrow();
    lock.entries[0]!.policy = 'scaffold';
    expect(() => validatePair(manifest, lock)).toThrow(expect.objectContaining({ code: 'LOCK_MISMATCH' }));
  });

  it('should keep draft-07 manifest and lock schemas in parity with the fixture corpus', () => {
    const api = projectTemplate as unknown as Record<string, unknown>;
    const lockSchema = api['projectTemplateLockV1JsonSchema'];
    expect(lockSchema).toBeTypeOf('object');
    const ajv = new Ajv({ allErrors: true });
    const validateManifestSchema = ajv.compile(projectTemplateManifestV1JsonSchema);
    const validateLockSchema = ajv.compile(lockSchema as object);
    const manifest = validManifest();
    expect(validateManifestSchema(manifest), JSON.stringify(validateManifestSchema.errors)).toBe(true);
    expect(() => parseProjectTemplateManifest(manifest)).not.toThrow();

    const badManifest = readFixture('unknown-key-manifest.json');
    expect(validateManifestSchema(badManifest)).toBe(false);
    expect(() => parseProjectTemplateManifest(badManifest)).toThrow();

    const singleFieldBadCorpus = [
      (value: Record<string, unknown>) => {
        (value['entries'] as Array<Record<string, unknown>>)[0]!['path'] = '.takt/config.yaml';
      },
      (value: Record<string, unknown>) => {
        (value['source'] as Record<string, unknown>)['uri'] = 'github:example/project-template';
      },
      (value: Record<string, unknown>) => {
        (value['source'] as Record<string, unknown>)['ref'] = 'x'.repeat(257);
      },
      (value: Record<string, unknown>) => {
        value['packVersion'] = 'v1.2.3';
      },
      (value: Record<string, unknown>) => {
        delete (value['entries'] as Array<Record<string, unknown>>)[0]!['sha256'];
      },
    ];
    for (const mutate of singleFieldBadCorpus) {
      const invalid = validManifest();
      mutate(invalid);
      expect(validateManifestSchema(invalid), JSON.stringify(validateManifestSchema.errors)).toBe(false);
      expect(() => parseProjectTemplateManifest(invalid)).toThrow(ProjectTemplateValidationError);
    }

    const parsed = parseProjectTemplateManifest(manifest);
    const calculate = api['calculateProjectTemplateManifestSha256'] as (value: unknown) => string;
    const lock = {
      schemaVersion: '1.0',
      manifestSha256: calculate(parsed),
      packVersion: parsed.packVersion,
      source: parsed.source,
      capabilities: parsed.capabilities ?? [],
      entries: parsed.entries.map((entry) => ({ ...entry, capabilities: entry.capabilities ?? [] })),
    };
    expect(validateLockSchema(lock), JSON.stringify(validateLockSchema.errors)).toBe(true);
    expect(() => parseTemplateLock(lock)).not.toThrow();
    delete (lock.entries[0] as Partial<(typeof lock.entries)[number]>).policy;
    expect(validateLockSchema(lock)).toBe(false);
    expect(() => parseTemplateLock(lock)).toThrow();
  });
});
