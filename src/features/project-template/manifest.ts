import { ProjectTemplateValidationError } from './errors.js';
import type { ProjectTemplateManifestV1, TemplateEntry } from './types.js';
import {
  assertAllowedKeys,
  compareSemVer,
  MAX_TEMPLATE_ENTRIES,
  parseCapabilities,
  parsePolicy,
  parsePosixMode,
  parsePortablePath,
  parseSha256,
  parseSource,
  requireArray,
  requireRecord,
  requireSchemaVersionV1,
  requireSemVer,
  validateDeclaredCapabilities,
  validatePathIdentities,
} from './validation.js';

function parseEntry(value: unknown, index: number): TemplateEntry {
  const field = `entries[${index}]`;
  const entry = requireRecord(value, field);
  assertAllowedKeys(entry, ['path', 'policy', 'mode', 'sha256', 'capabilities'], field);
  return {
    path: parsePortablePath(entry['path'], `${field}.path`),
    policy: parsePolicy(entry['policy'], `${field}.policy`),
    mode: parsePosixMode(entry['mode'], `${field}.mode`),
    sha256: parseSha256(entry['sha256'], `${field}.sha256`),
    ...(entry['capabilities'] === undefined ? {} : {
      capabilities: parseCapabilities(entry['capabilities'], `${field}.capabilities`),
    }),
  };
}

export function parseProjectTemplateManifest(value: unknown): ProjectTemplateManifestV1 {
  const manifest = requireRecord(value, 'manifest');
  assertAllowedKeys(manifest, ['schemaVersion', 'packVersion', 'takt', 'source', 'capabilities', 'entries'], 'manifest');
  requireSchemaVersionV1(manifest['schemaVersion'], 'schemaVersion', 'INVALID_MANIFEST');
  const takt = requireRecord(manifest['takt'], 'takt');
  assertAllowedKeys(takt, ['minVersion', 'maxVersion'], 'takt');
  const rawEntries = requireArray(manifest['entries'], 'entries', MAX_TEMPLATE_ENTRIES, 'INVALID_MANIFEST');
  const capabilities = parseCapabilities(manifest['capabilities'], 'capabilities', 'INVALID_MANIFEST') ?? [];
  const entries = rawEntries.map(parseEntry);
  validatePathIdentities(entries, 'entries');
  validateDeclaredCapabilities(entries, capabilities, 'entries.capabilities');

  const minVersion = requireSemVer(takt['minVersion'], 'takt.minVersion');
  const maxVersion = takt['maxVersion'] === undefined
    ? undefined
    : requireSemVer(takt['maxVersion'], 'takt.maxVersion');
  if (maxVersion !== undefined && compareSemVer(minVersion, maxVersion) > 0) {
    throw new ProjectTemplateValidationError('INVALID_VERSION_RANGE', 'takt.minVersion must not exceed takt.maxVersion', 'takt');
  }

  return {
    schemaVersion: '1.0',
    packVersion: requireSemVer(manifest['packVersion'], 'packVersion'),
    takt: { minVersion, ...(maxVersion === undefined ? {} : { maxVersion }) },
    source: parseSource(manifest['source']),
    ...(manifest['capabilities'] === undefined ? {} : { capabilities }),
    entries,
  };
}

/** Canonical serialization is the byte input used by the manifest digest. */
export function serializeProjectTemplateManifest(value: unknown): string {
  return JSON.stringify(parseProjectTemplateManifest(value), null, 2);
}
