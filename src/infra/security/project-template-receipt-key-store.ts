import { types } from 'node:util';

export const PROJECT_TEMPLATE_RECEIPT_KEY_BYTES = 32;
export const PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES = 64 * 1024;
export const PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_KEYS = 16;

const KEY_ID_PATTERN = /^receipt-key-[a-f0-9]{32}$/;

export type ProjectTemplateReceiptKeyState =
  | 'active'
  | 'verify-only'
  | 'revoked';

export interface ProjectTemplateReceiptKeyEntry {
  readonly keyId: string;
  readonly state: ProjectTemplateReceiptKeyState;
  readonly secret?: Uint8Array;
}

export interface ProjectTemplateReceiptKeyRegistry {
  readonly schemaVersion: 1;
  readonly keys: readonly ProjectTemplateReceiptKeyEntry[];
}

export interface ProjectTemplateReceiptKeySnapshot {
  readonly generation: number;
  readonly registry: ProjectTemplateReceiptKeyRegistry;
}

export interface ProjectTemplateReceiptKeyStoreLease {
  readonly snapshot: ProjectTemplateReceiptKeySnapshot | undefined;
  compareAndSwap(
    expectedGeneration: number | undefined,
    registry: ProjectTemplateReceiptKeyRegistry,
  ): Promise<ProjectTemplateReceiptKeySnapshot | undefined>;
}

export interface ProjectTemplateReceiptKeyParseOwnershipSeam {
  readonly onOwnedSecretBuffer?: (buffer: Uint8Array) => void;
}

/** Internal persistence port. It deliberately has no import/export operation. */
export interface ProjectTemplateReceiptKeyStore {
  read(): Promise<ProjectTemplateReceiptKeyRegistry | undefined>;
  write(registry: ProjectTemplateReceiptKeyRegistry): Promise<void>;
  withExclusiveLease<T>(
    operation: (lease: ProjectTemplateReceiptKeyStoreLease) => Promise<T> | T,
  ): Promise<T>;
  dispose(): Promise<void>;
}

export class ProjectTemplateReceiptKeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectTemplateReceiptKeyStoreError';
  }
}

interface SerializedEntry {
  readonly keyId: string;
  readonly state: ProjectTemplateReceiptKeyState;
  readonly secret?: string;
}

function encodeSecret(secret: Uint8Array): string {
  const bytes = Buffer.from(secret);
  try {
    return bytes.toString('base64url');
  } finally {
    bytes.fill(0);
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new ProjectTemplateReceiptKeyStoreError('Invalid key registry record');
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) throw new ProjectTemplateReceiptKeyStoreError('Invalid key registry record');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new ProjectTemplateReceiptKeyStoreError('Invalid key registry record');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function validKeyId(keyId: unknown): keyId is string {
  return typeof keyId === 'string' && KEY_ID_PATTERN.test(keyId);
}

function cloneEntry(entry: ProjectTemplateReceiptKeyEntry): ProjectTemplateReceiptKeyEntry {
  return Object.freeze({
    keyId: entry.keyId,
    state: entry.state,
    ...(entry.secret === undefined ? {} : { secret: Uint8Array.from(entry.secret) }),
  });
}

export function validateProjectTemplateReceiptKeyRegistry(
  registry: ProjectTemplateReceiptKeyRegistry,
): ProjectTemplateReceiptKeyRegistry {
  const record = exactRecord(registry, ['schemaVersion', 'keys']);
  if (record['schemaVersion'] !== 1 || !Array.isArray(record['keys'])) {
    throw new ProjectTemplateReceiptKeyStoreError('Invalid key registry schema');
  }
  if (record['keys'].length > PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_KEYS) {
    throw new ProjectTemplateReceiptKeyStoreError(
      'Key registry exceeds the bounded maximum',
    );
  }
  const seen = new Set<string>();
  let active = 0;
  const keys: ProjectTemplateReceiptKeyEntry[] = [];
  try {
    for (const value of record['keys']) {
      const candidate = exactRecord(
        value,
        typeof value === 'object'
          && value !== null
          && Reflect.ownKeys(value).includes('secret')
          ? ['keyId', 'state', 'secret']
          : ['keyId', 'state'],
      );
      const keyId = candidate['keyId'];
      const state = candidate['state'];
      const secret = candidate['secret'];
      if (!validKeyId(keyId) || seen.has(keyId)) {
        throw new ProjectTemplateReceiptKeyStoreError('Invalid or duplicate key id');
      }
      if (state !== 'active' && state !== 'verify-only' && state !== 'revoked') {
        throw new ProjectTemplateReceiptKeyStoreError('Invalid key state');
      }
      if (state === 'revoked') {
        if (secret !== undefined) {
          throw new ProjectTemplateReceiptKeyStoreError('Revoked keys retain no secret');
        }
      } else if (
        !(secret instanceof Uint8Array)
        || types.isProxy(secret)
        || secret.byteLength !== PROJECT_TEMPLATE_RECEIPT_KEY_BYTES
      ) {
        throw new ProjectTemplateReceiptKeyStoreError('Invalid key secret');
      }
      seen.add(keyId);
      if (state === 'active') active += 1;
      keys.push(cloneEntry({
        keyId,
        state,
        ...(secret === undefined ? {} : { secret }),
      }));
    }
    if (keys.length > 0 && active !== 1) {
      throw new ProjectTemplateReceiptKeyStoreError(
        'Key registry must contain exactly one active key',
      );
    }
    return Object.freeze({ schemaVersion: 1, keys: Object.freeze(keys) });
  } catch (error) {
    for (const key of keys) key.secret?.fill(0);
    throw error;
  }
}

export function serializeProjectTemplateReceiptKeyRegistry(
  registry: ProjectTemplateReceiptKeyRegistry,
): Uint8Array {
  const validated = validateProjectTemplateReceiptKeyRegistry(registry);
  try {
    const keys: SerializedEntry[] = validated.keys.map((entry) => ({
      keyId: entry.keyId,
      state: entry.state,
      ...(entry.secret === undefined
        ? {}
        : { secret: encodeSecret(entry.secret) }),
    }));
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, keys }), 'utf8');
    if (bytes.byteLength > PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES) {
      bytes.fill(0);
      throw new ProjectTemplateReceiptKeyStoreError(
        'Serialized key registry exceeds the bounded maximum',
      );
    }
    return bytes;
  } finally {
    for (const key of validated.keys) key.secret?.fill(0);
  }
}

export function serializeProjectTemplateReceiptKeySnapshot(
  snapshot: ProjectTemplateReceiptKeySnapshot,
): Uint8Array {
  if (
    !Number.isSafeInteger(snapshot.generation)
    || snapshot.generation < 0
  ) throw new ProjectTemplateReceiptKeyStoreError('Invalid key registry generation');
  const registry = validateProjectTemplateReceiptKeyRegistry(snapshot.registry);
  try {
    const keys: SerializedEntry[] = registry.keys.map((entry) => ({
      keyId: entry.keyId,
      state: entry.state,
      ...(entry.secret === undefined
        ? {}
        : { secret: encodeSecret(entry.secret) }),
    }));
    const bytes = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      generation: snapshot.generation,
      keys,
    }), 'utf8');
    if (bytes.byteLength > PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES) {
      bytes.fill(0);
      throw new ProjectTemplateReceiptKeyStoreError(
        'Serialized key registry exceeds the bounded maximum',
      );
    }
    return bytes;
  } finally {
    for (const key of registry.keys) key.secret?.fill(0);
  }
}

export function parseProjectTemplateReceiptKeyRegistry(
  bytes: Uint8Array,
  ownership?: ProjectTemplateReceiptKeyParseOwnershipSeam,
): ProjectTemplateReceiptKeyRegistry {
  if (bytes.byteLength > PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES) {
    throw new ProjectTemplateReceiptKeyStoreError(
      'Key registry exceeds the bounded maximum',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ProjectTemplateReceiptKeyStoreError('Invalid key registry JSON');
  }
  const record = exactRecord(parsed, ['schemaVersion', 'keys']);
  if (record['schemaVersion'] !== 1 || !Array.isArray(record['keys'])) {
    throw new ProjectTemplateReceiptKeyStoreError('Invalid key registry schema');
  }
  const keys: ProjectTemplateReceiptKeyEntry[] = [];
  try {
    for (const value of record['keys']) {
      const hasSecret = typeof value === 'object'
        && value !== null
        && Reflect.ownKeys(value).includes('secret');
      const entry = exactRecord(
        value,
        hasSecret ? ['keyId', 'state', 'secret'] : ['keyId', 'state'],
      );
      const encoded = entry['secret'];
      let secret: Uint8Array | undefined;
      if (encoded !== undefined) {
        if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
          throw new ProjectTemplateReceiptKeyStoreError('Invalid encoded key secret');
        }
        const decoded = Buffer.from(encoded, 'base64url');
        try {
          ownership?.onOwnedSecretBuffer?.(decoded);
          const ownedSecret = Uint8Array.from(decoded);
          try {
            ownership?.onOwnedSecretBuffer?.(ownedSecret);
            secret = ownedSecret;
          } catch (error) {
            ownedSecret.fill(0);
            throw error;
          }
        } finally {
          decoded.fill(0);
        }
      }
      keys.push({
        keyId: entry['keyId'] as string,
        state: entry['state'] as ProjectTemplateReceiptKeyState,
        ...(secret === undefined ? {} : { secret }),
      });
    }
    return validateProjectTemplateReceiptKeyRegistry({ schemaVersion: 1, keys });
  } finally {
    for (const key of keys) key.secret?.fill(0);
  }
}

export function parseProjectTemplateReceiptKeySnapshot(
  bytes: Uint8Array,
): ProjectTemplateReceiptKeySnapshot {
  if (bytes.byteLength > PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES) {
    throw new ProjectTemplateReceiptKeyStoreError(
      'Key registry exceeds the bounded maximum',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ProjectTemplateReceiptKeyStoreError('Invalid key registry JSON');
  }
  const record = exactRecord(parsed, ['schemaVersion', 'generation', 'keys']);
  const generation = record['generation'];
  if (
    record['schemaVersion'] !== 1
    || !Number.isSafeInteger(generation)
    || (generation as number) < 0
  ) throw new ProjectTemplateReceiptKeyStoreError('Invalid key registry generation');
  const legacyBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    keys: record['keys'],
  }), 'utf8');
  try {
    return Object.freeze({
      generation: generation as number,
      registry: parseProjectTemplateReceiptKeyRegistry(legacyBytes),
    });
  } finally {
    legacyBytes.fill(0);
  }
}
