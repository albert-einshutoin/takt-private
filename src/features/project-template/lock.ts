import { ProjectTemplateValidationError } from './errors.js';
import {
  parseProjectTemplateManifestV1_1Derivation,
  parseProjectTemplateManifestV1_1Source,
  validateProjectTemplateManifestV1_1SourceAndDerivation,
} from './manifest.js';
import {
  parseProjectTemplateRepertoireDependencies,
} from './source-descriptor.js';
import type {
  TemplateLockEntry,
  TemplateLockV1,
  TemplateLockV1_0,
  TemplateLockV1_1,
} from './types.js';
import {
  assertAllowedKeys,
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

const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REGEXP_EXEC = RegExp.prototype.exec;
const LOCK_SCHEMA_VERSION_PATTERN = /^(\d+)\.(\d+)$/;

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

function parseLockEntry(value: unknown, index: number): TemplateLockEntry {
  const field = `lock.entries[${index}]`;
  const entry = requireRecord(value, field);
  assertAllowedKeys(entry, ['path', 'policy', 'mode', 'sha256', 'capabilities'], field);
  const capabilities = parseCapabilities(entry['capabilities'], `${field}.capabilities`, 'INVALID_LOCK');
  if (capabilities === undefined) {
    throw new ProjectTemplateValidationError('INVALID_LOCK', `${field}.capabilities is required`, `${field}.capabilities`);
  }
  return {
    path: parsePortablePath(entry['path'], `${field}.path`),
    policy: parsePolicy(entry['policy'], `${field}.policy`, 'INVALID_LOCK'),
    mode: parsePosixMode(entry['mode'], `${field}.mode`),
    sha256: parseSha256(entry['sha256'], `${field}.sha256`),
    capabilities,
  };
}

function requireLockSchemaVersion(value: unknown): '1.0' | '1.1' {
  if (typeof value !== 'string') {
    throw new ProjectTemplateValidationError('INVALID_LOCK', 'lock.schemaVersion must be a string', 'lock.schemaVersion');
  }
  const match = CAPTURED_REFLECT_APPLY(
    CAPTURED_REGEXP_EXEC,
    LOCK_SCHEMA_VERSION_PATTERN,
    [value],
  ) as RegExpExecArray | null;
  if (match === null) {
    throw new ProjectTemplateValidationError('INVALID_LOCK', 'lock.schemaVersion must use major.minor notation', 'lock.schemaVersion');
  }
  if (match[1] !== '1') {
    throw new ProjectTemplateValidationError('UNSUPPORTED_SCHEMA_MAJOR', `lock.schemaVersion major ${match[1]} is not supported`, 'lock.schemaVersion');
  }
  if (value !== '1.0' && value !== '1.1') {
    throw new ProjectTemplateValidationError('UNSUPPORTED_SCHEMA_VERSION', `lock.schemaVersion version ${value} is not supported`, 'lock.schemaVersion');
  }
  return value;
}

function parseLockBase(
  lock: Record<string, unknown>,
): Omit<TemplateLockV1_0, 'schemaVersion' | 'source'> {
  const rawEntries = requireArray(lock['entries'], 'lock.entries', MAX_TEMPLATE_ENTRIES, 'INVALID_LOCK');
  const capabilities = parseCapabilities(lock['capabilities'], 'lock.capabilities', 'INVALID_LOCK');
  if (capabilities === undefined) {
    throw new ProjectTemplateValidationError('INVALID_LOCK', 'lock.capabilities is required', 'lock.capabilities');
  }
  const entries: TemplateLockEntry[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    append(entries, parseLockEntry(rawEntries[index], index));
  }
  validatePathIdentities(entries, 'lock.entries');
  validateDeclaredCapabilities(entries, capabilities, 'lock.entries.capabilities');
  return {
    manifestSha256: parseSha256(lock['manifestSha256'], 'lock.manifestSha256'),
    packVersion: requireSemVer(lock['packVersion'], 'lock.packVersion'),
    capabilities,
    entries,
  };
}

function parseTemplateLockV1_0(lock: Record<string, unknown>): TemplateLockV1_0 {
  assertAllowedKeys(lock, ['schemaVersion', 'manifestSha256', 'packVersion', 'source', 'capabilities', 'entries'], 'lock');
  return {
    schemaVersion: '1.0',
    ...parseLockBase(lock),
    source: parseSource(lock['source']),
  };
}

function parseTemplateLockV1_1(lock: Record<string, unknown>): TemplateLockV1_1 {
  assertAllowedKeys(
    lock,
    ['schemaVersion', 'manifestSha256', 'packVersion', 'source', 'derivation', 'repertoireDependencies', 'capabilities', 'entries'],
    'lock',
  );
  const source = parseProjectTemplateManifestV1_1Source(lock['source']);
  const derivation = parseProjectTemplateManifestV1_1Derivation(lock['derivation']);
  validateProjectTemplateManifestV1_1SourceAndDerivation(source, derivation);
  return {
    schemaVersion: '1.1',
    ...parseLockBase(lock),
    source,
    derivation,
    repertoireDependencies: parseProjectTemplateRepertoireDependencies(
      lock['repertoireDependencies'],
      'lock.repertoireDependencies',
    ),
  };
}

export function parseTemplateLock(value: unknown): TemplateLockV1 {
  const lock = requireRecord(value, 'lock');
  return requireLockSchemaVersion(lock['schemaVersion']) === '1.0'
    ? parseTemplateLockV1_0(lock)
    : parseTemplateLockV1_1(lock);
}

export function serializeTemplateLock(value: unknown): string {
  return JSON.stringify(parseTemplateLock(value), null, 2);
}
