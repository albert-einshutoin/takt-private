import { ProjectTemplateValidationError } from './errors.js';
import type { TemplateLockEntry, TemplateLockV1 } from './types.js';
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
  requireSchemaVersionV1,
  requireSemVer,
  validateDeclaredCapabilities,
  validatePathIdentities,
} from './validation.js';

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

export function parseTemplateLock(value: unknown): TemplateLockV1 {
  const lock = requireRecord(value, 'lock');
  assertAllowedKeys(lock, ['schemaVersion', 'manifestSha256', 'packVersion', 'source', 'capabilities', 'entries'], 'lock');
  requireSchemaVersionV1(lock['schemaVersion'], 'lock.schemaVersion', 'INVALID_LOCK');
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
    schemaVersion: '1.0',
    manifestSha256: parseSha256(lock['manifestSha256'], 'lock.manifestSha256'),
    packVersion: requireSemVer(lock['packVersion'], 'lock.packVersion'),
    source: parseSource(lock['source']),
    capabilities,
    entries,
  };
}

export function serializeTemplateLock(value: unknown): string {
  return JSON.stringify(parseTemplateLock(value), null, 2);
}
