import { createHash } from 'node:crypto';
import { ProjectTemplateValidationError } from './errors.js';
import { parseProjectTemplateManifest, serializeProjectTemplateManifest } from './manifest.js';
import { parseTemplateLock } from './lock.js';
import type {
  ProjectTemplateManifestDerivationV1_1,
  ProjectTemplateManifest,
  TemplateLock,
} from './types.js';

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
  lock: TemplateLock['source'],
  manifest: ProjectTemplateManifest['source'],
): boolean {
  // Source identity is fixed-schema evidence. Explicit comparisons keep
  // toJSON or serializer hooks from changing which repository/ref was bound.
  if (lock.kind !== manifest.kind) return false;
  if (lock.kind === 'derived' || manifest.kind === 'derived') {
    return lock.kind === 'derived'
      && manifest.kind === 'derived'
      && lock.method === manifest.method
      && lock.draftId === manifest.draftId;
  }
  return lock.uri === manifest.uri
    && lock.ref === manifest.ref
    && lock.commit === manifest.commit;
}

function derivationsMatch(
  lock: ProjectTemplateManifestDerivationV1_1,
  manifest: ProjectTemplateManifestDerivationV1_1,
): boolean {
  if (lock.kind !== manifest.kind) return false;
  if (lock.kind === 'root' || manifest.kind === 'root') {
    return lock.kind === 'root' && manifest.kind === 'root';
  }
  return lock.operation === manifest.operation
    && lock.draftId === manifest.draftId
    && lock.editDocumentSha256 === manifest.editDocumentSha256
    && lock.parent.archiveSha256 === manifest.parent.archiveSha256
    && lock.parent.manifestSha256 === manifest.parent.manifestSha256
    && lock.parent.packVersion === manifest.parent.packVersion;
}

function repertoireDependenciesMatch(
  lock: TemplateLock & { readonly schemaVersion: '1.1' },
  manifest: Extract<ProjectTemplateManifest, { readonly schemaVersion: '1.1' }>,
): boolean {
  if (lock.repertoireDependencies.length !== manifest.repertoireDependencies.length) return false;
  for (let index = 0; index < lock.repertoireDependencies.length; index += 1) {
    const lockDependency = lock.repertoireDependencies[index]!;
    const manifestDependency = manifest.repertoireDependencies[index]!;
    if (
      lockDependency.scope !== manifestDependency.scope
      || lockDependency.version !== manifestDependency.version
      || lockDependency.source !== manifestDependency.source
      || lockDependency.commit !== manifestDependency.commit
      || !capabilitiesMatch(lockDependency.capabilities, manifestDependency.capabilities)
    ) return false;
  }
  return true;
}

/**
 * Verifies every apply-relevant field as well as the canonical digest. Field
 * checks provide useful diagnostics; the digest guards against future fields
 * accidentally being omitted from this comparison.
 */
export function validateManifestLockPair(manifestValue: unknown, lockValue: unknown): void {
  const manifest: ProjectTemplateManifest = parseProjectTemplateManifest(manifestValue);
  const lock: TemplateLock = parseTemplateLock(lockValue);
  assertLockMatch(lock.schemaVersion === manifest.schemaVersion, 'schemaVersion');
  assertLockMatch(lock.packVersion === manifest.packVersion, 'packVersion');
  if (manifest.schemaVersion === '1.1' && lock.schemaVersion === '1.1') {
    assertLockMatch(derivationsMatch(lock.derivation, manifest.derivation), 'derivation');
    assertLockMatch(
      repertoireDependenciesMatch(lock, manifest),
      'repertoireDependencies',
    );
  }
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
