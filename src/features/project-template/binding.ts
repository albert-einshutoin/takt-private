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

function capabilitiesMatch(
  lockCapabilities: readonly string[],
  manifestCapabilities: readonly string[] | undefined,
): boolean {
  const expected = manifestCapabilities ?? [];
  if (lockCapabilities.length !== expected.length) return false;
  for (let index = 0; index < lockCapabilities.length; index += 1) {
    if (lockCapabilities[index] !== expected[index]) return false;
  }
  return true;
}

function sourcesMatch(
  lock: TemplateLockV1['source'],
  manifest: ProjectTemplateManifestV1['source'],
): boolean {
  // Source identity is fixed-schema evidence. Explicit comparisons keep
  // toJSON or serializer hooks from changing which repository/ref was bound.
  return lock.kind === manifest.kind
    && lock.uri === manifest.uri
    && lock.ref === manifest.ref
    && lock.commit === manifest.commit;
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
  assertLockMatch(sourcesMatch(lock.source, manifest.source), 'source');
  assertLockMatch(
    capabilitiesMatch(lock.capabilities, manifest.capabilities),
    'capabilities',
  );
  assertLockMatch(lock.entries.length === manifest.entries.length, 'entries.length');
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const manifestEntry = manifest.entries[index]!;
    const lockEntry = lock.entries[index]!;
    assertLockMatch(lockEntry.path === manifestEntry.path, `entries[${index}].path`);
    assertLockMatch(lockEntry.policy === manifestEntry.policy, `entries[${index}].policy`);
    assertLockMatch(lockEntry.mode === manifestEntry.mode, `entries[${index}].mode`);
    assertLockMatch(lockEntry.sha256 === manifestEntry.sha256, `entries[${index}].sha256`);
    assertLockMatch(
      capabilitiesMatch(lockEntry.capabilities, manifestEntry.capabilities),
      `entries[${index}].capabilities`,
    );
  }
  assertLockMatch(lock.manifestSha256 === calculateProjectTemplateManifestSha256(manifest), 'manifestSha256');
}
