import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv';
import {
  parseProjectTemplateManifest,
  serializeProjectTemplateManifest,
} from '../../features/project-template/manifest.js';
import { ProjectTemplateValidationError } from '../../features/project-template/errors.js';
import { projectTemplateManifestV1_1JsonSchema } from '../../features/project-template/schema.js';

const fixturePath = (name: string): string => fileURLToPath(
  new URL(`../fixtures/project-template/manifest-v1.1/${name}`, import.meta.url),
);

const readFixture = (name: string): Record<string, unknown> => JSON.parse(
  readFileSync(fixturePath(name), 'utf8'),
) as Record<string, unknown>;

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

describe('project template manifest v1.1', () => {
  it('accepts root and editor-save derived manifests without changing their semantic fields', () => {
    const root = parseProjectTemplateManifest(readFixture('root.json'));
    const derived = parseProjectTemplateManifest(readFixture('derived.json'));

    expect(root).toMatchObject({
      schemaVersion: '1.1',
      metadata: { name: 'Team workflow defaults' },
      derivation: { kind: 'root' },
      repertoireDependencies: [],
    });
    expect(derived).toMatchObject({
      schemaVersion: '1.1',
      derivation: {
        kind: 'derived',
        operation: 'editor-save',
        draftId: 'aa81b5c1de5ed1316a38e2c054461e762b16ba33537eca44e4dca8f530003366',
        parent: { packVersion: '1.2.4' },
      },
      repertoireDependencies: [{ scope: '@acme/editor-tools' }],
    });
    expect(JSON.parse(serializeProjectTemplateManifest(derived))).toEqual(readFixture('derived.json'));
  });

  it('keeps the draft-07 structure in parity with both v1.1 derivation branches', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(projectTemplateManifestV1_1JsonSchema);
    expect(validate(readFixture('root.json')), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(readFixture('derived.json')), JSON.stringify(validate.errors)).toBe(true);

    const rootWithDerivedSource = readFixture('root.json');
    rootWithDerivedSource['source'] = readFixture('derived.json')['source'];
    expect(validate(rootWithDerivedSource)).toBe(false);

    const derivedWithRootSource = readFixture('derived.json');
    derivedWithRootSource['source'] = readFixture('root.json')['source'];
    expect(validate(derivedWithRootSource)).toBe(false);
  });

  it('keeps existing v1.0 canonical serialization byte-stable', () => {
    const v1 = {
      schemaVersion: '1.0',
      packVersion: '1.2.3',
      takt: { minVersion: '0.48.0' },
      source: {
        kind: 'local', uri: '.', ref: 'workspace',
        commit: '0123456789abcdef0123456789abcdef01234567',
      },
      entries: [],
    };

    expect(serializeProjectTemplateManifest(v1)).toBe(`{
  "schemaVersion": "1.0",
  "packVersion": "1.2.3",
  "takt": {
    "minVersion": "0.48.0"
  },
  "source": {
    "kind": "local",
    "uri": ".",
    "ref": "workspace",
    "commit": "0123456789abcdef0123456789abcdef01234567"
  },
  "entries": []
}`);
  });

  it('accepts an empty multiline description but rejects whitespace-padded names', () => {
    const emptyDescription = readFixture('root.json');
    (emptyDescription['metadata'] as Record<string, unknown>)['description'] = '';
    expect(parseProjectTemplateManifest(emptyDescription)).toMatchObject({
      metadata: { description: '' },
    });

    const paddedName = readFixture('root.json');
    (paddedName['metadata'] as Record<string, unknown>)['name'] = ' Team workflow defaults ';
    expectValidationCode(paddedName, 'INVALID_MANIFEST');

    const ajv = new Ajv({ allErrors: true, strict: false });
    expect(ajv.compile(projectTemplateManifestV1_1JsonSchema)(paddedName)).toBe(false);
  });

  it('enforces metadata code-point bounds and the C0/C1 control policy', () => {
    const atBounds = readFixture('root.json');
    (atBounds['metadata'] as Record<string, unknown>)['name'] = 'n'.repeat(128);
    (atBounds['metadata'] as Record<string, unknown>)['description'] = 'd'.repeat(2048);
    expect(parseProjectTemplateManifest(atBounds)).toMatchObject({ schemaVersion: '1.1' });

    const longName = readFixture('root.json');
    (longName['metadata'] as Record<string, unknown>)['name'] = 'n'.repeat(129);
    expectValidationCode(longName, 'LIMIT_EXCEEDED');

    const longDescription = readFixture('root.json');
    (longDescription['metadata'] as Record<string, unknown>)['description'] = 'd'.repeat(2049);
    expectValidationCode(longDescription, 'LIMIT_EXCEEDED');

    const c1Control = readFixture('root.json');
    (c1Control['metadata'] as Record<string, unknown>)['description'] = 'unsafe\u0085description';
    expectValidationCode(c1Control, 'INVALID_MANIFEST');
  });

  it.each([
    ['bidirectional override', 'safe\u202Efdp.exe'],
    ['zero-width separator', 'safe\u200Bname'],
    ['line separator', 'safe\u2028name'],
    ['paragraph separator', 'safe\u2029name'],
    ['unpaired high surrogate', 'safe\uD800name'],
    ['unpaired low surrogate', 'safe\uDC00name'],
  ])('rejects metadata containing %s in both parser and JSON schema', (_label, name) => {
    const value = readFixture('root.json');
    (value['metadata'] as Record<string, unknown>)['name'] = name;
    expectValidationCode(value, 'INVALID_MANIFEST');

    const ajv = new Ajv({ allErrors: true, strict: false });
    expect(ajv.compile(projectTemplateManifestV1_1JsonSchema)(value)).toBe(false);
  });

  it('accepts a valid surrogate pair in both parser and JSON schema', () => {
    const value = readFixture('root.json');
    (value['metadata'] as Record<string, unknown>)['name'] = 'Safe \u{1F680} template';
    expect(parseProjectTemplateManifest(value)).toMatchObject({ schemaVersion: '1.1' });

    const ajv = new Ajv({ allErrors: true, strict: false });
    expect(ajv.compile(projectTemplateManifestV1_1JsonSchema)(value)).toBe(true);
  });

  it.each([
    ['missing metadata', (value: Record<string, unknown>) => { delete value['metadata']; }, 'INVALID_MANIFEST'],
    ['metadata control character', (value: Record<string, unknown>) => {
      (value['metadata'] as Record<string, unknown>)['description'] = 'unsafe\u0000description';
    }, 'INVALID_MANIFEST'],
    ['metadata non-NFC text', (value: Record<string, unknown>) => {
      (value['metadata'] as Record<string, unknown>)['name'] = 'cafe\u0301';
    }, 'INVALID_MANIFEST'],
    ['top-level current archive self hash', (value: Record<string, unknown>) => {
      value['archiveSha256'] = 'c'.repeat(64);
    }, 'UNKNOWN_KEY'],
  ])('rejects %s', (_label, change, code) => {
    const value = readFixture('root.json');
    change(value);
    expectValidationCode(value, code);
  });

  it('requires exact derivation branches and a complete immutable parent identity', () => {
    const missingParent = readFixture('derived.json');
    delete ((missingParent['derivation'] as Record<string, unknown>)['parent'] as Record<string, unknown>)['archiveSha256'];
    expectValidationCode(missingParent, 'MISSING_HASH');

    const unsupportedReason = readFixture('derived.json');
    (unsupportedReason['derivation'] as Record<string, unknown>)['operation'] = 'import';
    expectValidationCode(unsupportedReason, 'INVALID_MANIFEST');

    const mismatchedDraft = readFixture('derived.json');
    (mismatchedDraft['source'] as Record<string, unknown>)['draftId'] = 'e'.repeat(64);
    expectValidationCode(mismatchedDraft, 'INVALID_MANIFEST');

    const forgedDraft = readFixture('derived.json');
    (forgedDraft['source'] as Record<string, unknown>)['draftId'] = 'e'.repeat(64);
    (forgedDraft['derivation'] as Record<string, unknown>)['draftId'] = 'e'.repeat(64);
    expectValidationCode(forgedDraft, 'INVALID_MANIFEST');

    const derivedFromRemote = readFixture('derived.json');
    derivedFromRemote['source'] = readFixture('root.json')['source'];
    expectValidationCode(derivedFromRemote, 'INVALID_MANIFEST');
  });

  it('does not consult mutable string prototypes while validating metadata', () => {
    const normalize = Object.getOwnPropertyDescriptor(String.prototype, 'normalize')!;
    const trim = Object.getOwnPropertyDescriptor(String.prototype, 'trim')!;
    const charCodeAt = Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')!;
    const iterator = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)!;
    const hook = vi.fn(() => {
      throw new Error('poisoned string intrinsic');
    });
    const iteratorHook = function iteratorHook(this: string) {
      if (this.length > 128) return [][Symbol.iterator]();
      return Reflect.apply(iterator.value as () => StringIterator<string>, this, []);
    };
    try {
      Object.defineProperty(String.prototype, 'normalize', { ...normalize, value: hook });
      Object.defineProperty(String.prototype, 'trim', { ...trim, value: hook });
      Object.defineProperty(String.prototype, 'charCodeAt', { ...charCodeAt, value: hook });
      Object.defineProperty(String.prototype, Symbol.iterator, { ...iterator, value: iteratorHook });
      expect(() => parseProjectTemplateManifest(readFixture('root.json'))).not.toThrow();
      const longName = readFixture('root.json');
      (longName['metadata'] as Record<string, unknown>)['name'] = 'n'.repeat(129);
      expectValidationCode(longName, 'LIMIT_EXCEEDED');
    } finally {
      Object.defineProperty(String.prototype, 'normalize', normalize);
      Object.defineProperty(String.prototype, 'trim', trim);
      Object.defineProperty(String.prototype, 'charCodeAt', charCodeAt);
      Object.defineProperty(String.prototype, Symbol.iterator, iterator);
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('uses the canonical repertoire dependency parser, including stable order and unique scopes', () => {
    const unordered = readFixture('derived.json');
    (unordered['repertoireDependencies'] as Array<Record<string, unknown>>).unshift({
      scope: '@acme/z-tool',
      version: '1.0.0',
      source: 'github:acme/z-tool@v1.0.0',
      commit: '1234567890abcdef1234567890abcdef12345678',
      capabilities: [],
    });
    expectValidationCode(unordered, 'INVALID_SOURCE');

    const duplicate = readFixture('derived.json');
    (duplicate['repertoireDependencies'] as Array<Record<string, unknown>>).push({
      ...(duplicate['repertoireDependencies'] as Array<Record<string, unknown>>)[0]!,
    });
    expectValidationCode(duplicate, 'INVALID_SOURCE');
  });
});
