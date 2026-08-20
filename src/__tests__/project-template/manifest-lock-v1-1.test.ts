import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  calculateProjectTemplateManifestSha256,
  validateManifestLockPair,
} from '../../features/project-template/binding.js';
import { ProjectTemplateValidationError } from '../../features/project-template/errors.js';
import { parseTemplateLock, serializeTemplateLock } from '../../features/project-template/lock.js';
import { projectTemplateLockV1_1JsonSchema } from '../../features/project-template/schema.js';
import { calculateProjectTemplateDraftId } from '../../features/project-template/template-editor-draft-identity.js';

const fixturePath = (name: string): string => fileURLToPath(
  new URL(`../fixtures/project-template/manifest-v1.1/${name}`, import.meta.url),
);

function manifest(name: 'root.json' | 'derived.json'): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as Record<string, unknown>;
}

function lockFor(value: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: '1.1',
    manifestSha256: calculateProjectTemplateManifestSha256(value),
    packVersion: value['packVersion'],
    source: structuredClone(value['source']),
    derivation: structuredClone(value['derivation']),
    repertoireDependencies: structuredClone(value['repertoireDependencies']),
    capabilities: value['capabilities'] ?? [],
    entries: (value['entries'] as Array<Record<string, unknown>>).map((entry) => ({
      ...entry,
      capabilities: entry['capabilities'] ?? [],
    })),
  };
}

function expectLockMismatch(action: () => void, field: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectTemplateValidationError);
    expect((error as ProjectTemplateValidationError).code).toBe('LOCK_MISMATCH');
    expect((error as ProjectTemplateValidationError).field).toBe(field);
    return;
  }
  throw new Error(`Expected LOCK_MISMATCH at ${field}`);
}

describe('project template manifest lock v1.1', () => {
  it('round-trips an editor-derived lock without metadata duplication', () => {
    const lock = lockFor(manifest('derived.json'));
    const parsed = parseTemplateLock(lock);

    expect(parsed).toMatchObject({
      schemaVersion: '1.1',
      source: { kind: 'derived', method: 'takt-editor-v1' },
      derivation: { kind: 'derived', operation: 'editor-save' },
      repertoireDependencies: [{ scope: '@acme/editor-tools' }],
    });
    expect(parsed).not.toHaveProperty('metadata');
    expect(JSON.parse(serializeTemplateLock(lock))).toEqual(lock);
  });

  it('keeps the v1.1 JSON schema aligned with the strict parser', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(projectTemplateLockV1_1JsonSchema);
    const lock = lockFor(manifest('derived.json'));

    expect(validate(lock), JSON.stringify(validate.errors)).toBe(true);
    expect(() => parseTemplateLock(lock)).not.toThrow();

    const mismatchedSource = lockFor(manifest('derived.json'));
    mismatchedSource['source'] = manifest('root.json')['source'];
    expect(validate(mismatchedSource)).toBe(false);

    delete lock['derivation'];
    expect(validate(lock)).toBe(false);
    expect(() => parseTemplateLock(lock)).toThrow(ProjectTemplateValidationError);
  });

  it('binds source, derivation, dependencies, and digest to the exact v1.1 manifest', () => {
    const value = manifest('derived.json');
    const valid = lockFor(value);
    expect(() => validateManifestLockPair(value, valid)).not.toThrow();

    const root = manifest('root.json');
    const source = lockFor(root);
    (source['source'] as Record<string, unknown>)['commit'] = 'e'.repeat(40);
    expectLockMismatch(() => validateManifestLockPair(root, source), 'source');

    const derivation = lockFor(value);
    const changedDerivation = derivation['derivation'] as Record<string, unknown>;
    changedDerivation['editDocumentSha256'] = 'e'.repeat(64);
    const parent = changedDerivation['parent'] as Record<string, unknown>;
    const draftId = calculateProjectTemplateDraftId({
      parentArchiveSha256: parent['archiveSha256'] as string,
      parentManifestSha256: parent['manifestSha256'] as string,
      parentPackVersion: parent['packVersion'] as string,
      editDocumentSha256: changedDerivation['editDocumentSha256'] as string,
    });
    changedDerivation['draftId'] = draftId;
    (derivation['source'] as Record<string, unknown>)['draftId'] = draftId;
    expectLockMismatch(() => validateManifestLockPair(value, derivation), 'derivation');

    const dependencies = lockFor(value);
    ((dependencies['repertoireDependencies'] as Array<Record<string, unknown>>)[0]!)['commit'] = 'f'.repeat(40);
    expectLockMismatch(() => validateManifestLockPair(value, dependencies), 'repertoireDependencies');

    const digest = lockFor(value);
    digest['manifestSha256'] = 'f'.repeat(64);
    expectLockMismatch(() => validateManifestLockPair(value, digest), 'manifestSha256');
  });

  it('rejects cross-version manifest and lock pairs as LOCK_MISMATCH', () => {
    const v1_1Manifest = manifest('root.json');
    const v1_0Lock = {
      schemaVersion: '1.0',
      manifestSha256: calculateProjectTemplateManifestSha256(v1_1Manifest),
      packVersion: v1_1Manifest['packVersion'],
      source: v1_1Manifest['source'],
      capabilities: [],
      entries: [],
    };

    expectLockMismatch(() => validateManifestLockPair(v1_1Manifest, v1_0Lock), 'schemaVersion');
  });
});
