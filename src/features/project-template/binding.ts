import { createHash } from 'node:crypto';
import { ProjectTemplateValidationError } from './errors.js';
import { parseProjectTemplateManifest, serializeProjectTemplateManifest } from './manifest.js';
import { parseTemplateLock } from './lock.js';
import type { ProjectTemplateManifestV1, TemplateLockV1 } from './types.js';

const CAPTURED_CREATE_HASH = createHash;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const MANIFEST_HASH_SAMPLE = CAPTURED_CREATE_HASH('sha256');
// Capture method identities once so a reviewed manifest cannot be rebound by
// later prototype mutation between parsing and composition.
const CAPTURED_HASH_UPDATE = MANIFEST_HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = MANIFEST_HASH_SAMPLE.digest;

export function calculateProjectTemplateManifestSha256(value: unknown): string {
  const hash = CAPTURED_CREATE_HASH('sha256');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [
    serializeProjectTemplateManifest(value),
    'utf8',
  ]);
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_HASH_DIGEST,
    hash,
    ['hex'],
  ) as string;
}

function assertLockMatch(condition: boolean, field: string): void {
  if (!condition) {
    throw new ProjectTemplateValidationError('LOCK_MISMATCH', `lock does not match manifest at ${field}`, field);
  }
}

function canonicalCapabilities(value: readonly string[] | undefined): string {
  return JSON.stringify(value ?? []);
}

/**
 * Verifies every apply-relevant field as well as the canonical digest. Field
 * checks provide useful diagnostics; the digest guards against future fields
 * accidentally being omitted from this comparison.
 */
export function validateManifestLockPair(manifestValue: unknown, lockValue: unknown): void {
  const manifest: ProjectTemplateManifestV1 = parseProjectTemplateManifest(manifestValue);
  const lock: TemplateLockV1 = parseTemplateLock(lockValue);
  assertLockMatch(lock.packVersion === manifest.packVersion, 'packVersion');
  assertLockMatch(JSON.stringify(lock.source) === JSON.stringify(manifest.source), 'source');
  assertLockMatch(canonicalCapabilities(lock.capabilities) === canonicalCapabilities(manifest.capabilities), 'capabilities');
  assertLockMatch(lock.entries.length === manifest.entries.length, 'entries.length');
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const manifestEntry = manifest.entries[index]!;
    const lockEntry = lock.entries[index]!;
    assertLockMatch(lockEntry.path === manifestEntry.path, `entries[${index}].path`);
    assertLockMatch(lockEntry.policy === manifestEntry.policy, `entries[${index}].policy`);
    assertLockMatch(lockEntry.mode === manifestEntry.mode, `entries[${index}].mode`);
    assertLockMatch(lockEntry.sha256 === manifestEntry.sha256, `entries[${index}].sha256`);
    assertLockMatch(
      canonicalCapabilities(lockEntry.capabilities) === canonicalCapabilities(manifestEntry.capabilities),
      `entries[${index}].capabilities`,
    );
  }
  assertLockMatch(lock.manifestSha256 === calculateProjectTemplateManifestSha256(manifest), 'manifestSha256');
}
