import { ProjectTemplateValidationError } from './errors.js';
import type { TemplateLockV1 } from './types.js';
import {
  assertAllowedKeys,
  parsePosixMode,
  parsePortablePath,
  parseSha256,
  parseSource,
  requireRecord,
  requireSemVer,
} from './validation.js';

/** Parses a lock file without resolving a source or writing to the project. */
export function parseTemplateLock(value: unknown): TemplateLockV1 {
  const lock = requireRecord(value, 'lock', 'INVALID_LOCK');
  assertAllowedKeys(lock, ['schemaVersion', 'packVersion', 'source', 'entries'], 'lock');
  if (lock['schemaVersion'] !== '1.0') {
    throw new ProjectTemplateValidationError('UNSUPPORTED_SCHEMA_MAJOR', 'lock schemaVersion major 1 is required');
  }
  if (!Array.isArray(lock['entries'])) {
    throw new ProjectTemplateValidationError('INVALID_LOCK', 'lock.entries must be an array');
  }
  const entries = lock['entries'].map((value) => {
    const entry = requireRecord(value, 'lock entry', 'INVALID_LOCK');
    assertAllowedKeys(entry, ['path', 'mode', 'sha256'], 'lock entry');
    return {
      path: parsePortablePath(entry['path'], 'lock entry.path'),
      mode: parsePosixMode(entry['mode'], 'lock entry.mode'),
      sha256: parseSha256(entry['sha256'], 'lock entry.sha256'),
    };
  });
  return {
    schemaVersion: '1.0',
    packVersion: requireSemVer(lock['packVersion'], 'lock.packVersion'),
    source: parseSource(lock['source'], 'INVALID_LOCK'),
    entries,
  };
}

export function serializeTemplateLock(value: unknown): string {
  return JSON.stringify(parseTemplateLock(value), null, 2);
}
