import { ProjectTemplateValidationError } from './errors.js';
import type {
  ProjectTemplateManifestV1,
  TemplateCapability,
  TemplateEntry,
  TemplateEntryPolicy,
} from './types.js';
import {
  assertAllowedKeys,
  isExecutableMode,
  parseCapabilities,
  parsePosixMode,
  parsePortablePath,
  parseSha256,
  parseSource,
  requireRecord,
  requireSemVer,
  requireString,
} from './validation.js';

function parseEntry(value: unknown): TemplateEntry {
  const entry = requireRecord(value, 'entry');
  assertAllowedKeys(entry, ['path', 'policy', 'mode', 'sha256', 'capabilities'], 'entry');
  const policy = requireString(entry['policy'], 'entry.policy');
  if (policy !== 'managed' && policy !== 'merge' && policy !== 'scaffold' && policy !== 'excluded') {
    throw new ProjectTemplateValidationError('INVALID_ENTRY', 'entry.policy is not supported');
  }
  return {
    path: parsePortablePath(entry['path'], 'entry.path'),
    policy: policy as TemplateEntryPolicy,
    mode: parsePosixMode(entry['mode'], 'entry.mode'),
    sha256: parseSha256(entry['sha256'], 'entry.sha256'),
    ...(entry['capabilities'] === undefined ? {} : { capabilities: parseCapabilities(entry['capabilities'], 'entry.capabilities') }),
  };
}

function validateEntrySet(entries: TemplateEntry[], manifestCapabilities: TemplateCapability[]): void {
  const paths = new Map<string, TemplateEntry>();
  const caseInsensitivePaths = new Map<string, string>();
  const declaredCapabilities = new Set(manifestCapabilities);

  for (const entry of entries) {
    const duplicate = paths.get(entry.path);
    if (duplicate) {
      if (duplicate.policy !== entry.policy) {
        throw new ProjectTemplateValidationError('POLICY_CONFLICT', `entries for ${entry.path} have conflicting policies`);
      }
      throw new ProjectTemplateValidationError('DUPLICATE_ENTRY_PATH', `entries contains duplicate path ${entry.path}`);
    }
    const previousCaseVariant = caseInsensitivePaths.get(entry.path.toLocaleLowerCase('en-US'));
    if (previousCaseVariant !== undefined) {
      throw new ProjectTemplateValidationError('PATH_CASE_COLLISION', `${entry.path} conflicts with ${previousCaseVariant} on case-insensitive file systems`);
    }
    paths.set(entry.path, entry);
    caseInsensitivePaths.set(entry.path.toLocaleLowerCase('en-US'), entry.path);

    const entryCapabilities = entry.capabilities ?? [];
    // Executable bits alter what applying a template can run. Requiring a
    // declaration at both levels makes the preview explicit and auditable.
    if (isExecutableMode(entry.mode) && !entryCapabilities.includes('executable')) {
      throw new ProjectTemplateValidationError('UNDECLARED_CAPABILITY', `${entry.path} is executable but does not declare executable capability`);
    }
    for (const capability of entryCapabilities) {
      if (!declaredCapabilities.has(capability)) {
        throw new ProjectTemplateValidationError('UNDECLARED_CAPABILITY', `${entry.path} uses ${capability} without a manifest declaration`);
      }
    }
  }
}

/**
 * Parses the manifest without reading from disk. Callers can therefore reject
 * an unsafe pack during preview, before any project state is modified.
 */
export function parseProjectTemplateManifest(value: unknown): ProjectTemplateManifestV1 {
  const manifest = requireRecord(value, 'manifest');
  assertAllowedKeys(manifest, ['schemaVersion', 'packVersion', 'takt', 'source', 'capabilities', 'entries'], 'manifest');
  if (manifest['schemaVersion'] !== '1.0') {
    throw new ProjectTemplateValidationError('UNSUPPORTED_SCHEMA_MAJOR', 'schemaVersion major 1 is required');
  }
  const takt = requireRecord(manifest['takt'], 'takt');
  assertAllowedKeys(takt, ['minVersion', 'maxVersion'], 'takt');
  if (!Array.isArray(manifest['entries'])) {
    throw new ProjectTemplateValidationError('INVALID_MANIFEST', 'entries must be an array');
  }

  const capabilities = parseCapabilities(manifest['capabilities'], 'capabilities') ?? [];
  const entries = manifest['entries'].map(parseEntry);
  validateEntrySet(entries, capabilities);

  const maxVersion = takt['maxVersion'];
  return {
    schemaVersion: '1.0',
    packVersion: requireSemVer(manifest['packVersion'], 'packVersion'),
    takt: {
      minVersion: requireSemVer(takt['minVersion'], 'takt.minVersion'),
      ...(maxVersion === undefined ? {} : { maxVersion: requireSemVer(maxVersion, 'takt.maxVersion') }),
    },
    source: parseSource(manifest['source']),
    ...(manifest['capabilities'] === undefined ? {} : { capabilities }),
    entries,
  };
}

/** Serializes only a validated canonical manifest for stable interchange. */
export function serializeProjectTemplateManifest(value: unknown): string {
  return JSON.stringify(parseProjectTemplateManifest(value), null, 2);
}
