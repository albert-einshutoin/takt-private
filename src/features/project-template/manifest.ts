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

const CAPTURED_JSON_STRINGIFY = JSON.stringify;
const CAPTURED_JSON_RECEIVER = JSON;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_REFLECT_APPLY = Reflect.apply;

function append<T>(values: T[], value: T): void {
  CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_DEFINE_PROPERTY,
    CAPTURED_OBJECT_RECEIVER,
    [values, `${values.length}`, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    }],
  );
}

function quote(value: string): string {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_JSON_STRINGIFY,
    CAPTURED_JSON_RECEIVER,
    [value],
  ) as string;
}

function prettyStringArray(values: readonly string[], indent: number): string {
  if (values.length === 0) return '[]';
  const itemIndent = ' '.repeat(indent + 2);
  const closeIndent = ' '.repeat(indent);
  let json = '[\n';
  for (let index = 0; index < values.length; index += 1) {
    if (index !== 0) json += ',\n';
    json += itemIndent + quote(values[index]!);
  }
  return `${json}\n${closeIndent}]`;
}

// Manifest digests historically bind JSON.stringify(..., null, 2) bytes. The
// fixed-schema writer preserves those bytes without delegating traversal,
// ordering, or coercion to post-initialization mutable collection hooks.
function serializeParsedManifest(manifest: ProjectTemplateManifestV1): string {
  let json = '{\n';
  json += `  "schemaVersion": ${quote(manifest.schemaVersion)},\n`;
  json += `  "packVersion": ${quote(manifest.packVersion)},\n`;
  json += '  "takt": {\n';
  json += `    "minVersion": ${quote(manifest.takt.minVersion)}`;
  if (manifest.takt.maxVersion !== undefined) {
    json += `,\n    "maxVersion": ${quote(manifest.takt.maxVersion)}`;
  }
  json += '\n  },\n';
  json += '  "source": {\n';
  json += `    "kind": ${quote(manifest.source.kind)},\n`;
  json += `    "uri": ${quote(manifest.source.uri)},\n`;
  json += `    "ref": ${quote(manifest.source.ref)},\n`;
  json += `    "commit": ${quote(manifest.source.commit)}\n`;
  json += '  },\n';
  if (manifest.capabilities !== undefined) {
    json += '  "capabilities": '
      + prettyStringArray(manifest.capabilities, 2) + ',\n';
  }
  json += '  "entries": ';
  if (manifest.entries.length === 0) return `${json}[]\n}`;
  json += '[\n';
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index]!;
    if (index !== 0) json += ',\n';
    json += '    {\n';
    json += `      "path": ${quote(entry.path)},\n`;
    json += `      "policy": ${quote(entry.policy)},\n`;
    json += `      "mode": ${quote(entry.mode)},\n`;
    json += `      "sha256": ${quote(entry.sha256)}`;
    if (entry.capabilities !== undefined) {
      json += ',\n      "capabilities": '
        + prettyStringArray(entry.capabilities, 6);
    }
    json += '\n    }';
  }
  return `${json}\n  ]\n}`;
}

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
  const entries: TemplateEntry[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    append(entries, parseEntry(rawEntries[index], index));
  }
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
  return serializeParsedManifest(parseProjectTemplateManifest(value));
}
