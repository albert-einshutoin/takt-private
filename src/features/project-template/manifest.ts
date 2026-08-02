import { ProjectTemplateValidationError } from './errors.js';
import type {
  ProjectTemplateManifestDerivationV1_1,
  ProjectTemplateManifestV1,
  ProjectTemplateManifestV1_0,
  ProjectTemplateManifestV1_1,
  DerivedTemplateSourceV1_1,
  TemplateEntry,
} from './types.js';
import {
  parseProjectTemplateRepertoireDependencies,
  type ProjectTemplateRepertoireDependencyV1,
} from './source-descriptor.js';
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
  requireSemVer,
  validateDeclaredCapabilities,
  validatePathIdentities,
} from './validation.js';

export const MAX_PROJECT_TEMPLATE_MANIFEST_NAME_LENGTH = 128;
export const MAX_PROJECT_TEMPLATE_MANIFEST_DESCRIPTION_LENGTH = 2048;

const CAPTURED_JSON_STRINGIFY = JSON.stringify;
const CAPTURED_JSON_RECEIVER = JSON;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_ARRAY_FROM = Array.from;
const CAPTURED_ARRAY_RECEIVER = Array;
const CAPTURED_STRING_TRIM = String.prototype.trim;

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
function serializeParsedManifestV1_0(manifest: ProjectTemplateManifestV1_0): string {
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

function prettyDependencies(
  dependencies: readonly ProjectTemplateRepertoireDependencyV1[],
): string {
  if (dependencies.length === 0) return '[]';
  let json = '[\n';
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index]!;
    if (index !== 0) json += ',\n';
    json += '    {\n';
    json += `      "scope": ${quote(dependency.scope)},\n`;
    json += `      "version": ${quote(dependency.version)},\n`;
    json += `      "source": ${quote(dependency.source)},\n`;
    json += `      "commit": ${quote(dependency.commit)},\n`;
    json += '      "capabilities": '
      + prettyStringArray(dependency.capabilities, 6) + '\n';
    json += '    }';
  }
  return `${json}\n  ]`;
}

function serializeParsedManifestV1_1(manifest: ProjectTemplateManifestV1_1): string {
  let json = '{\n';
  json += `  "schemaVersion": ${quote(manifest.schemaVersion)},\n`;
  json += `  "packVersion": ${quote(manifest.packVersion)},\n`;
  json += '  "metadata": {\n';
  json += `    "name": ${quote(manifest.metadata.name)},\n`;
  json += `    "description": ${quote(manifest.metadata.description)}\n`;
  json += '  },\n';
  json += '  "derivation": {\n';
  json += `    "kind": ${quote(manifest.derivation.kind)}`;
  if (manifest.derivation.kind === 'derived') {
    json += `,\n    "operation": ${quote(manifest.derivation.operation)},\n`;
    json += `    "draftId": ${quote(manifest.derivation.draftId)},\n`;
    json += `    "editDocumentSha256": ${quote(manifest.derivation.editDocumentSha256)},\n`;
    json += '    "parent": {\n';
    json += `      "archiveSha256": ${quote(manifest.derivation.parent.archiveSha256)},\n`;
    json += `      "manifestSha256": ${quote(manifest.derivation.parent.manifestSha256)},\n`;
    json += `      "packVersion": ${quote(manifest.derivation.parent.packVersion)}\n`;
    json += '    }';
  }
  json += '\n  },\n';
  json += '  "takt": {\n';
  json += `    "minVersion": ${quote(manifest.takt.minVersion)}`;
  if (manifest.takt.maxVersion !== undefined) {
    json += `,\n    "maxVersion": ${quote(manifest.takt.maxVersion)}`;
  }
  json += '\n  },\n';
  json += '  "source": {\n';
  json += `    "kind": ${quote(manifest.source.kind)},\n`;
  if (manifest.source.kind === 'derived') {
    json += `    "method": ${quote(manifest.source.method)},\n`;
    json += `    "draftId": ${quote(manifest.source.draftId)}\n`;
  } else {
    json += `    "uri": ${quote(manifest.source.uri)},\n`;
    json += `    "ref": ${quote(manifest.source.ref)},\n`;
    json += `    "commit": ${quote(manifest.source.commit)}\n`;
  }
  json += '  },\n';
  json += '  "repertoireDependencies": '
    + prettyDependencies(manifest.repertoireDependencies) + ',\n';
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

function parseTakt(value: unknown): { minVersion: string; maxVersion?: string } {
  const takt = requireRecord(value, 'takt');
  assertAllowedKeys(takt, ['minVersion', 'maxVersion'], 'takt');
  const minVersion = requireSemVer(takt['minVersion'], 'takt.minVersion');
  const maxVersion = takt['maxVersion'] === undefined
    ? undefined
    : requireSemVer(takt['maxVersion'], 'takt.maxVersion');
  if (maxVersion !== undefined && compareSemVer(minVersion, maxVersion) > 0) {
    throw new ProjectTemplateValidationError('INVALID_VERSION_RANGE', 'takt.minVersion must not exceed takt.maxVersion', 'takt');
  }
  return { minVersion, ...(maxVersion === undefined ? {} : { maxVersion }) };
}

function parseEntries(
  value: unknown,
  capabilities: ReturnType<typeof parseCapabilities>,
): TemplateEntry[] {
  const rawEntries = requireArray(value, 'entries', MAX_TEMPLATE_ENTRIES, 'INVALID_MANIFEST');
  const entries: TemplateEntry[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    append(entries, parseEntry(rawEntries[index], index));
  }
  validatePathIdentities(entries, 'entries');
  validateDeclaredCapabilities(entries, capabilities ?? [], 'entries.capabilities');
  return entries;
}

function parseProjectTemplateManifestV1_0(
  manifest: Record<string, unknown>,
): ProjectTemplateManifestV1_0 {
  assertAllowedKeys(manifest, ['schemaVersion', 'packVersion', 'takt', 'source', 'capabilities', 'entries'], 'manifest');
  const capabilities = parseCapabilities(manifest['capabilities'], 'capabilities', 'INVALID_MANIFEST') ?? [];
  return {
    schemaVersion: '1.0',
    packVersion: requireSemVer(manifest['packVersion'], 'packVersion'),
    takt: parseTakt(manifest['takt']),
    source: parseSource(manifest['source']),
    ...(manifest['capabilities'] === undefined ? {} : { capabilities }),
    entries: parseEntries(manifest['entries'], capabilities),
  };
}

function requireManifestV1_1SchemaVersion(value: unknown): void {
  if (typeof value !== 'string' || !/^\d+\.\d+$/.test(value)) {
    throw new ProjectTemplateValidationError('INVALID_MANIFEST', 'schemaVersion must use major.minor notation', 'schemaVersion');
  }
  if (!value.startsWith('1.')) {
    throw new ProjectTemplateValidationError('UNSUPPORTED_SCHEMA_MAJOR', `schemaVersion major ${value.split('.', 1)[0]} is not supported`, 'schemaVersion');
  }
  if (value !== '1.1') {
    throw new ProjectTemplateValidationError('UNSUPPORTED_SCHEMA_VERSION', `schemaVersion version ${value} is not supported`, 'schemaVersion');
  }
}

function parseMetadataText(
  value: unknown,
  field: string,
  maxLength: number,
  options: { allowEmpty: boolean; allowLineFeed: boolean; forbidOuterWhitespace: boolean },
): string {
  if (typeof value !== 'string' || (!options.allowEmpty && value.length === 0)) {
    throw new ProjectTemplateValidationError('INVALID_MANIFEST', `${field} must be ${options.allowEmpty ? 'a string' : 'a non-empty string'}`, field);
  }
  const codePoints = CAPTURED_REFLECT_APPLY(
    CAPTURED_ARRAY_FROM,
    CAPTURED_ARRAY_RECEIVER,
    [value],
  ) as string[];
  if (codePoints.length > maxLength) {
    throw new ProjectTemplateValidationError('LIMIT_EXCEEDED', `${field} exceeds the ${maxLength} character limit`, field);
  }
  // Metadata reaches UIs and machine-readable exports. NFC plus control-free
  // text gives each user-visible identity one stable, non-spoofing byte form.
  if (
    value.normalize('NFC') !== value
    || containsForbiddenMetadataControl(value, options.allowLineFeed)
    || (options.forbidOuterWhitespace && CAPTURED_REFLECT_APPLY(
      CAPTURED_STRING_TRIM,
      value,
      [],
    ) !== value)
  ) {
    throw new ProjectTemplateValidationError('INVALID_MANIFEST', `${field} must be NFC-normalized and contain only permitted text`, field);
  }
  return value;
}

function containsForbiddenMetadataControl(value: string, allowLineFeed: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code <= 0x1F && (!allowLineFeed || code !== 0x0A))
      || (code >= 0x7F && code <= 0x9F)
    ) return true;
  }
  return false;
}

function parseMetadata(value: unknown): ProjectTemplateManifestV1_1['metadata'] {
  if (value === undefined) {
    throw new ProjectTemplateValidationError('INVALID_MANIFEST', 'metadata is required for schema 1.1', 'metadata');
  }
  const metadata = requireRecord(value, 'metadata');
  assertAllowedKeys(metadata, ['name', 'description'], 'metadata');
  return {
    name: parseMetadataText(metadata['name'], 'metadata.name', MAX_PROJECT_TEMPLATE_MANIFEST_NAME_LENGTH, {
      allowEmpty: false, allowLineFeed: false, forbidOuterWhitespace: true,
    }),
    description: parseMetadataText(metadata['description'], 'metadata.description', MAX_PROJECT_TEMPLATE_MANIFEST_DESCRIPTION_LENGTH, {
      allowEmpty: true, allowLineFeed: true, forbidOuterWhitespace: false,
    }),
  };
}

function parseDerivation(value: unknown): ProjectTemplateManifestDerivationV1_1 {
  const derivation = requireRecord(value, 'derivation');
  if (derivation['kind'] === 'root') {
    assertAllowedKeys(derivation, ['kind'], 'derivation');
    return { kind: 'root' };
  }
  if (derivation['kind'] !== 'derived') {
    throw new ProjectTemplateValidationError('INVALID_MANIFEST', 'derivation.kind must be root or derived', 'derivation.kind');
  }
  assertAllowedKeys(
    derivation,
    ['kind', 'operation', 'draftId', 'editDocumentSha256', 'parent'],
    'derivation',
  );
  if (derivation['operation'] !== 'editor-save') {
    throw new ProjectTemplateValidationError('INVALID_MANIFEST', 'derivation.operation must be editor-save', 'derivation.operation');
  }
  const parent = requireRecord(derivation['parent'], 'derivation.parent');
  assertAllowedKeys(parent, ['archiveSha256', 'manifestSha256', 'packVersion'], 'derivation.parent');
  return {
    kind: 'derived',
    operation: 'editor-save',
    draftId: parseSha256(derivation['draftId'], 'derivation.draftId'),
    editDocumentSha256: parseSha256(
      derivation['editDocumentSha256'],
      'derivation.editDocumentSha256',
    ),
    parent: {
      archiveSha256: parseSha256(parent['archiveSha256'], 'derivation.parent.archiveSha256'),
      manifestSha256: parseSha256(parent['manifestSha256'], 'derivation.parent.manifestSha256'),
      packVersion: requireSemVer(parent['packVersion'], 'derivation.parent.packVersion'),
    },
  };
}

function parseV1_1Source(
  value: unknown,
): ProjectTemplateManifestV1_1['source'] {
  const source = requireRecord(value, 'source');
  if (source['kind'] !== 'derived') return parseSource(source);
  assertAllowedKeys(source, ['kind', 'method', 'draftId'], 'source');
  if (source['method'] !== 'takt-editor-v1') {
    throw new ProjectTemplateValidationError('INVALID_SOURCE', 'source.method must be takt-editor-v1', 'source.method');
  }
  return {
    kind: 'derived',
    method: 'takt-editor-v1',
    draftId: parseSha256(source['draftId'], 'source.draftId'),
  } satisfies DerivedTemplateSourceV1_1;
}

function parseProjectTemplateManifestV1_1(
  manifest: Record<string, unknown>,
): ProjectTemplateManifestV1_1 {
  assertAllowedKeys(
    manifest,
    ['schemaVersion', 'packVersion', 'metadata', 'derivation', 'takt', 'source', 'repertoireDependencies', 'capabilities', 'entries'],
    'manifest',
  );
  requireManifestV1_1SchemaVersion(manifest['schemaVersion']);
  const capabilities = parseCapabilities(manifest['capabilities'], 'capabilities', 'INVALID_MANIFEST') ?? [];
  const derivation = parseDerivation(manifest['derivation']);
  const source = parseV1_1Source(manifest['source']);
  if (
    (derivation.kind === 'derived' && source.kind !== 'derived')
    || (derivation.kind === 'root' && source.kind === 'derived')
  ) {
    throw new ProjectTemplateValidationError('INVALID_MANIFEST', 'source.kind must match derivation.kind', 'source.kind');
  }
  if (
    derivation.kind === 'derived'
    && source.kind === 'derived'
    && source.draftId !== derivation.draftId
  ) {
    throw new ProjectTemplateValidationError('INVALID_MANIFEST', 'source.draftId must equal derivation.draftId', 'source.draftId');
  }
  return {
    schemaVersion: '1.1',
    packVersion: requireSemVer(manifest['packVersion'], 'packVersion'),
    metadata: parseMetadata(manifest['metadata']),
    derivation,
    takt: parseTakt(manifest['takt']),
    source,
    repertoireDependencies: parseProjectTemplateRepertoireDependencies(
      manifest['repertoireDependencies'],
      'manifest.repertoireDependencies',
    ),
    ...(manifest['capabilities'] === undefined ? {} : { capabilities }),
    entries: parseEntries(manifest['entries'], capabilities),
  };
}

export function parseProjectTemplateManifest(value: unknown): ProjectTemplateManifestV1 {
  const manifest = requireRecord(value, 'manifest');
  return manifest['schemaVersion'] === '1.0'
    ? parseProjectTemplateManifestV1_0(manifest)
    : parseProjectTemplateManifestV1_1(manifest);
}

/** Canonical serialization is the byte input used by the manifest digest. */
export function serializeProjectTemplateManifest(value: unknown): string {
  const manifest = parseProjectTemplateManifest(value);
  return manifest.schemaVersion === '1.0'
    ? serializeParsedManifestV1_0(manifest)
    : serializeParsedManifestV1_1(manifest);
}
