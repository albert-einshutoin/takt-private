import { createHash } from 'node:crypto';
import { TextDecoder, types } from 'node:util';
import { ProjectTemplateValidationError } from './errors.js';
import {
  parseProjectTemplateRepertoireDependencies,
  type ProjectTemplateRepertoireDependencyV1,
} from './source-descriptor.js';
import {
  assertAllowedKeys,
  parseSha256,
  requireRecord,
  requireSchemaVersionV1,
} from './validation.js';

export const PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH =
  '.takt-template-repertoire-lock.json';
export const MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES =
  256 * 1024;

export interface ProjectTemplateRepertoireDependencyLockV1 {
  readonly schemaVersion: '1.0';
  readonly sourceDescriptorSha256: string;
  readonly manifestSha256: string;
  readonly dependencies: readonly ProjectTemplateRepertoireDependencyV1[];
}

/**
 * Parses the project companion lock without accepting install paths, timestamps,
 * package bytes, or credentials. Dependencies pass through the descriptor's
 * parser so reviewed source and persisted state cannot drift semantically.
 */
export function parseProjectTemplateRepertoireDependencyLock(
  value: unknown,
): ProjectTemplateRepertoireDependencyLockV1 {
  rejectProxy(value, 'repertoireDependencyLock');
  const lock = requireRecord(value, 'repertoireDependencyLock');
  assertAllowedKeys(
    lock,
    [
      'schemaVersion',
      'sourceDescriptorSha256',
      'manifestSha256',
      'dependencies',
    ],
    'repertoireDependencyLock',
  );
  const parsed: ProjectTemplateRepertoireDependencyLockV1 = {
    schemaVersion: requireSchemaVersionV1(
      lock['schemaVersion'],
      'repertoireDependencyLock.schemaVersion',
      'INVALID_LOCK',
    ),
    sourceDescriptorSha256: parseSha256(
      lock['sourceDescriptorSha256'],
      'repertoireDependencyLock.sourceDescriptorSha256',
    ),
    manifestSha256: parseSha256(
      lock['manifestSha256'],
      'repertoireDependencyLock.manifestSha256',
    ),
    dependencies: parseProjectTemplateRepertoireDependencies(
      lock['dependencies'],
      'repertoireDependencyLock.dependencies',
    ),
  };
  // The lock is safe to retain across UI review only as an immutable snapshot
  // detached from caller-owned objects and arrays.
  return deepFreeze(parsed);
}

/**
 * Parses the sole persisted representation: bounded bytes, fatal UTF-8, and
 * canonical JSON. This rejects duplicate-key and whitespace aliases before a
 * digest or approval can refer to different bytes.
 */
export function parseProjectTemplateRepertoireDependencyLockJson(
  input: string | Uint8Array,
): ProjectTemplateRepertoireDependencyLockV1 {
  let json: string;
  if (typeof input === 'string') {
    assertByteLimit(Buffer.byteLength(input, 'utf8'));
    json = input;
  } else if (
    typeof input === 'object'
    && input !== null
    && types.isProxy(input)
  ) {
    invalidLock('repertoire dependency lock input must not be a Proxy');
  } else if (input instanceof Uint8Array) {
    assertByteLimit(input.byteLength);
    try {
      json = new TextDecoder('utf-8', {
        fatal: true,
        // Preserve a BOM so canonical equality rejects a second byte form.
        ignoreBOM: true,
      }).decode(input);
    } catch {
      invalidLock('repertoire dependency lock bytes must be valid UTF-8');
    }
  } else {
    invalidLock('repertoire dependency lock input must be a string or Uint8Array');
  }

  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    invalidLock('repertoire dependency lock must contain valid JSON');
  }
  const parsed = parseProjectTemplateRepertoireDependencyLock(value);
  if (serializeProjectTemplateRepertoireDependencyLock(parsed) !== json) {
    invalidLock(
      'repertoire dependency lock JSON must use the canonical serialized representation',
    );
  }
  return parsed;
}

export function serializeProjectTemplateRepertoireDependencyLock(
  value: unknown,
): string {
  return JSON.stringify(parseProjectTemplateRepertoireDependencyLock(value), null, 2);
}

export function calculateProjectTemplateRepertoireDependencyLockSha256(
  value: unknown,
): string {
  return createHash('sha256')
    .update(serializeProjectTemplateRepertoireDependencyLock(value), 'utf8')
    .digest('hex');
}

function assertByteLimit(byteLength: number): void {
  if (byteLength > MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES) {
    throw new ProjectTemplateValidationError(
      'LIMIT_EXCEEDED',
      `repertoire dependency lock exceeds the ${MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES} byte limit`,
      'repertoireDependencyLock',
    );
  }
}

function invalidLock(message: string): never {
  throw new ProjectTemplateValidationError(
    'INVALID_LOCK',
    message,
    'repertoireDependencyLock',
  );
}

function rejectProxy(value: unknown, field: string): void {
  if (
    typeof value === 'object'
    && value !== null
    && types.isProxy(value)
  ) {
    throw new ProjectTemplateValidationError(
      'NON_PLAIN_OBJECT',
      `${field} must not be a Proxy`,
      field,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
