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
  const paths = new Set<string>();
  const caseInsensitivePaths = new Map<string, string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw new ProjectTemplateValidationError('DUPLICATE_ENTRY_PATH', `lock entries contains duplicate path ${entry.path}`);
    }
    const normalizedPath = entry.path.toLocaleLowerCase('en-US');
    const previousCaseVariant = caseInsensitivePaths.get(normalizedPath);
    if (previousCaseVariant !== undefined) {
      throw new ProjectTemplateValidationError('PATH_CASE_COLLISION', `${entry.path} conflicts with ${previousCaseVariant} on case-insensitive file systems`);
    }
    paths.add(entry.path);
    caseInsensitivePaths.set(normalizedPath, entry.path);
  }
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
