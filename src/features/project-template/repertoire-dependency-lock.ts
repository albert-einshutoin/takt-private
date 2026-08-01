import { createHash } from 'node:crypto';
import { TextDecoder, types } from 'node:util';
import { ProjectTemplateValidationError } from './errors.js';
import {
  parseProjectTemplateRepertoireDependencies,
  type ProjectTemplateRepertoireDependencyV1,
} from './source-descriptor.js';

export const PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH =
  '.takt-template-repertoire-lock.json';
export const MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES =
  256 * 1024;

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;
const SCHEMA_VERSION_PATTERN = /^(\d+)\.(\d+)$/;
const INTRINSIC_OBJECT_RECEIVER = Object;
const INTRINSIC_JSON_RECEIVER = JSON;
const INTRINSIC_REFLECT_RECEIVER = Reflect;
const INTRINSIC_REFLECT_APPLY = Reflect.apply;
const INTRINSIC_OBJECT_CREATE = Object.create;
const INTRINSIC_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const INTRINSIC_OBJECT_FREEZE = Object.freeze;
const INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  Object.getOwnPropertyDescriptor;
const INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const INTRINSIC_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const INTRINSIC_OBJECT_SET_PROTOTYPE_OF = Object.setPrototypeOf;
const INTRINSIC_OBJECT_PROTOTYPE = Object.prototype;
const INTRINSIC_REFLECT_OWN_KEYS = Reflect.ownKeys;
const INTRINSIC_JSON_PARSE = JSON.parse;
const INTRINSIC_JSON_STRINGIFY = JSON.stringify;
const INTRINSIC_REGEXP_EXEC = RegExp.prototype.exec;
const INTRINSIC_REGEXP_TEST = RegExp.prototype.test;
const INTRINSIC_TYPES_IS_PROXY = types.isProxy;
const INTRINSIC_NUMBER = Number;
const INTRINSIC_STRING = String;
const INTRINSIC_BUFFER_RECEIVER = Buffer;
const INTRINSIC_BUFFER_BYTE_LENGTH = Buffer.byteLength;
const INTRINSIC_CREATE_HASH = createHash;
const HASH_SAMPLE = INTRINSIC_CREATE_HASH('sha256');
const INTRINSIC_HASH_UPDATE = HASH_SAMPLE.update;
const INTRINSIC_HASH_DIGEST = HASH_SAMPLE.digest;
const PRISTINE_UINT8_ARRAY = Uint8Array;
const PRISTINE_UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const PRISTINE_TEXT_DECODER = TextDecoder;
const TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = (() => {
  const getter =
    INTRINSIC_REFLECT_APPLY(
      INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      INTRINSIC_OBJECT_RECEIVER,
      [TYPED_ARRAY_PROTOTYPE, 'byteLength'],
    )?.get;
  if (getter === undefined) {
    throw new Error('TypedArray byteLength intrinsic is unavailable');
  }
  return getter;
})();

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
  const lock = snapshotLockRecord(value);
  const parsed: ProjectTemplateRepertoireDependencyLockV1 = {
    schemaVersion: parseSchemaVersion(lock['schemaVersion']),
    sourceDescriptorSha256: parseLockSha256(
      lock['sourceDescriptorSha256'],
      'repertoireDependencyLock.sourceDescriptorSha256',
    ),
    manifestSha256: parseLockSha256(
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
  for (let index = 0; index < parsed.dependencies.length; index += 1) {
    const dependency = parsed.dependencies[index]!;
    intrinsicFreeze(dependency.capabilities);
    intrinsicFreeze(dependency);
  }
  intrinsicFreeze(parsed.dependencies);
  return intrinsicFreeze(parsed);
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
    assertByteLimit(INTRINSIC_REFLECT_APPLY(
      INTRINSIC_BUFFER_BYTE_LENGTH,
      INTRINSIC_BUFFER_RECEIVER,
      [input, 'utf8'],
    ) as number);
    json = input;
  } else if (
    typeof input === 'object'
    && input !== null
    && INTRINSIC_REFLECT_APPLY(INTRINSIC_TYPES_IS_PROXY, types, [input])
  ) {
    invalidLock('repertoire dependency lock input must not be a Proxy');
  } else if (
    typeof input === 'object'
    && input !== null
    && INTRINSIC_REFLECT_APPLY(
      INTRINSIC_OBJECT_GET_PROTOTYPE_OF,
      INTRINSIC_OBJECT_RECEIVER,
      [input],
    ) === PRISTINE_UINT8_ARRAY_PROTOTYPE
  ) {
    const bytes = snapshotPristineBytes(input);
    try {
      const decoder = new PRISTINE_TEXT_DECODER('utf-8', {
        fatal: true,
        // Preserve a BOM so canonical equality rejects a second byte form.
        ignoreBOM: true,
      });
      json = INTRINSIC_REFLECT_APPLY(
        TEXT_DECODER_DECODE,
        decoder,
        [bytes],
      ) as string;
    } catch {
      invalidLock('repertoire dependency lock bytes must be valid UTF-8');
    }
  } else {
    invalidLock('repertoire dependency lock input must be a string or Uint8Array');
  }

  let value: unknown;
  try {
    value = INTRINSIC_REFLECT_APPLY(
      INTRINSIC_JSON_PARSE,
      INTRINSIC_JSON_RECEIVER,
      [json],
    ) as unknown;
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

function snapshotPristineBytes(value: object): Uint8Array {
  let byteLength: number;
  try {
    // Calling the captured intrinsic getter performs the internal-slot brand
    // check without consulting an own/inherited `byteLength` property.
    byteLength = INTRINSIC_REFLECT_APPLY(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
  } catch {
    invalidLock('repertoire dependency lock bytes must be a pristine Uint8Array');
  }
  assertByteLimit(byteLength);

  const descriptors = intrinsicOwnDescriptors(value);
  const ownKeys = intrinsicOwnKeys(descriptors);
  let hasUnsafeProperty = false;
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (
      typeof key !== 'string'
      || !intrinsicRegExpTest(ARRAY_INDEX_PATTERN, key)
      || INTRINSIC_NUMBER(key) >= byteLength
    ) {
      hasUnsafeProperty = true;
      break;
    }
    const descriptor = descriptors[key]!;
    if (!('value' in descriptor) || typeof descriptor.value !== 'number') {
      hasUnsafeProperty = true;
      break;
    }
  }
  if (hasUnsafeProperty || ownKeys.length !== byteLength) {
    invalidLock(
      'repertoire dependency lock bytes must not contain extra properties',
    );
  }
  // Decode only a local byte-for-byte snapshot. A SharedArrayBuffer resize or
  // mutation after descriptor capture cannot change the canonical JSON bytes.
  const snapshot = new PRISTINE_UINT8_ARRAY(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    snapshot[index] = descriptors[String(index)]!.value as number;
  }
  return snapshot;
}

export function serializeProjectTemplateRepertoireDependencyLock(
  value: unknown,
): string {
  const parsed = parseProjectTemplateRepertoireDependencyLock(value);
  return INTRINSIC_REFLECT_APPLY(
    INTRINSIC_JSON_STRINGIFY,
    INTRINSIC_JSON_RECEIVER,
    [createSerializationSnapshot(parsed), null, 2],
  ) as string;
}

export function calculateProjectTemplateRepertoireDependencyLockSha256(
  value: unknown,
): string {
  const hash = INTRINSIC_CREATE_HASH('sha256');
  INTRINSIC_REFLECT_APPLY(INTRINSIC_HASH_UPDATE, hash, [
    serializeProjectTemplateRepertoireDependencyLock(value),
    'utf8',
  ]);
  return INTRINSIC_REFLECT_APPLY(
    INTRINSIC_HASH_DIGEST,
    hash,
    ['hex'],
  ) as string;
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

function intrinsicRegExpTest(pattern: RegExp, value: string): boolean {
  return INTRINSIC_REFLECT_APPLY(
    INTRINSIC_REGEXP_TEST,
    pattern,
    [value],
  ) as boolean;
}

function intrinsicOwnDescriptors(
  value: object,
): Record<PropertyKey, PropertyDescriptor> {
  return INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    INTRINSIC_OBJECT_RECEIVER,
    [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
}

function intrinsicOwnKeys(value: object): PropertyKey[] {
  return INTRINSIC_REFLECT_APPLY(
    INTRINSIC_REFLECT_OWN_KEYS,
    INTRINSIC_REFLECT_RECEIVER,
    [value],
  ) as PropertyKey[];
}

function intrinsicFreeze<T>(value: T): T {
  return INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_FREEZE,
    INTRINSIC_OBJECT_RECEIVER,
    [value],
  ) as T;
}

function snapshotLockRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || INTRINSIC_REFLECT_APPLY(INTRINSIC_TYPES_IS_PROXY, types, [value])
  ) {
    throw new ProjectTemplateValidationError(
      'NON_PLAIN_OBJECT',
      'repertoireDependencyLock must be a plain own-property object',
      'repertoireDependencyLock',
    );
  }
  const prototype = INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_GET_PROTOTYPE_OF,
    INTRINSIC_OBJECT_RECEIVER,
    [value],
  );
  if (prototype !== INTRINSIC_OBJECT_PROTOTYPE && prototype !== null) {
    throw new ProjectTemplateValidationError(
      'NON_PLAIN_OBJECT',
      'repertoireDependencyLock must be a plain own-property object',
      'repertoireDependencyLock',
    );
  }
  const descriptors = intrinsicOwnDescriptors(value);
  const keys = intrinsicOwnKeys(descriptors);
  const snapshot = INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_CREATE,
    INTRINSIC_OBJECT_RECEIVER,
    [null],
  ) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string' || !isLockKey(key)) {
      throw new ProjectTemplateValidationError(
        'UNKNOWN_KEY',
        'repertoireDependencyLock contains a key outside schema 1.0',
        'repertoireDependencyLock',
      );
    }
    const descriptor = descriptors[key]!;
    if (!('value' in descriptor)) {
      throw new ProjectTemplateValidationError(
        'NON_PLAIN_OBJECT',
        'repertoireDependencyLock must not contain accessors',
        'repertoireDependencyLock',
      );
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function isLockKey(value: string): boolean {
  return value === 'schemaVersion'
    || value === 'sourceDescriptorSha256'
    || value === 'manifestSha256'
    || value === 'dependencies';
}

function parseSchemaVersion(value: unknown): '1.0' {
  const field = 'repertoireDependencyLock.schemaVersion';
  if (typeof value !== 'string') {
    throw new ProjectTemplateValidationError(
      'INVALID_LOCK', `${field} must be a string`, field,
    );
  }
  const match = INTRINSIC_REFLECT_APPLY(
    INTRINSIC_REGEXP_EXEC,
    SCHEMA_VERSION_PATTERN,
    [value],
  ) as RegExpExecArray | null;
  if (match === null) {
    throw new ProjectTemplateValidationError(
      'INVALID_LOCK', `${field} must use major.minor notation`, field,
    );
  }
  if (match[1] !== '1') {
    throw new ProjectTemplateValidationError(
      'UNSUPPORTED_SCHEMA_MAJOR', `${field} major is not supported`, field,
    );
  }
  if (value !== '1.0') {
    throw new ProjectTemplateValidationError(
      'UNSUPPORTED_SCHEMA_VERSION', `${field} version is not supported`, field,
    );
  }
  return '1.0';
}

function parseLockSha256(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') {
    throw new ProjectTemplateValidationError(
      'MISSING_HASH', `${field} is required to make imports reproducible`, field,
    );
  }
  if (typeof value !== 'string' || !intrinsicRegExpTest(SHA256_PATTERN, value)) {
    throw new ProjectTemplateValidationError(
      'INVALID_HASH', `${field} must be a lowercase SHA-256 digest`, field,
    );
  }
  return value;
}

function defineDataProperty(
  target: object,
  key: PropertyKey,
  value: unknown,
): void {
  const descriptor = INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_CREATE,
    INTRINSIC_OBJECT_RECEIVER,
    [null],
  ) as PropertyDescriptor;
  descriptor.configurable = true;
  descriptor.enumerable = true;
  descriptor.value = value;
  descriptor.writable = true;
  INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_DEFINE_PROPERTY,
    INTRINSIC_OBJECT_RECEIVER,
    [target, key, descriptor],
  );
}

function nullRecord(): Record<string, unknown> {
  return INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_CREATE,
    INTRINSIC_OBJECT_RECEIVER,
    [null],
  ) as Record<string, unknown>;
}

function nullArray(): unknown[] {
  const value: unknown[] = [];
  INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_SET_PROTOTYPE_OF,
    INTRINSIC_OBJECT_RECEIVER,
    [value, null],
  );
  return value;
}

function createSerializationSnapshot(
  lock: ProjectTemplateRepertoireDependencyLockV1,
): Record<string, unknown> {
  const root = nullRecord();
  defineDataProperty(root, 'schemaVersion', lock.schemaVersion);
  defineDataProperty(root, 'sourceDescriptorSha256', lock.sourceDescriptorSha256);
  defineDataProperty(root, 'manifestSha256', lock.manifestSha256);
  const dependencies = nullArray();
  for (let index = 0; index < lock.dependencies.length; index += 1) {
    const dependency = lock.dependencies[index]!;
    const item = nullRecord();
    defineDataProperty(item, 'scope', dependency.scope);
    defineDataProperty(item, 'version', dependency.version);
    defineDataProperty(item, 'source', dependency.source);
    defineDataProperty(item, 'commit', dependency.commit);
    const capabilities = nullArray();
    for (let capabilityIndex = 0;
      capabilityIndex < dependency.capabilities.length;
      capabilityIndex += 1) {
      defineDataProperty(
        capabilities,
        INTRINSIC_STRING(capabilityIndex),
        dependency.capabilities[capabilityIndex],
      );
    }
    defineDataProperty(item, 'capabilities', capabilities);
    defineDataProperty(dependencies, INTRINSIC_STRING(index), item);
  }
  defineDataProperty(root, 'dependencies', dependencies);
  return root;
}
