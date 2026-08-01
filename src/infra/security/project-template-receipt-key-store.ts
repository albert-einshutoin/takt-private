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

/** Internal persistence port. It deliberately has no import/export operation. */
export interface ProjectTemplateReceiptKeyStore {
  read(): Promise<ProjectTemplateReceiptKeyRegistry | undefined>;
  write(registry: ProjectTemplateReceiptKeyRegistry): Promise<void>;
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
  const keys = record['keys'].map((value) => {
    const candidate = exactRecord(
      value,
      Reflect.ownKeys(value as object).includes('secret')
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
    return cloneEntry({ keyId, state, ...(secret === undefined ? {} : { secret }) });
  });
  if (keys.length > 0 && active !== 1) {
    throw new ProjectTemplateReceiptKeyStoreError(
      'Key registry must contain exactly one active key',
    );
  }
  return Object.freeze({ schemaVersion: 1, keys: Object.freeze(keys) });
}

export function serializeProjectTemplateReceiptKeyRegistry(
  registry: ProjectTemplateReceiptKeyRegistry,
): Uint8Array {
  const validated = validateProjectTemplateReceiptKeyRegistry(registry);
  const keys: SerializedEntry[] = validated.keys.map((entry) => ({
    keyId: entry.keyId,
    state: entry.state,
    ...(entry.secret === undefined
      ? {}
      : { secret: Buffer.from(entry.secret).toString('base64url') }),
  }));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, keys }), 'utf8');
  if (bytes.byteLength > PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES) {
    throw new ProjectTemplateReceiptKeyStoreError(
      'Serialized key registry exceeds the bounded maximum',
    );
  }
  return bytes;
}

export function parseProjectTemplateReceiptKeyRegistry(
  bytes: Uint8Array,
): ProjectTemplateReceiptKeyRegistry {
  if (bytes.byteLength > PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES) {
    throw new ProjectTemplateReceiptKeyStoreError(
      'Key registry exceeds the bounded maximum',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new ProjectTemplateReceiptKeyStoreError('Invalid key registry JSON');
  }
  const record = exactRecord(parsed, ['schemaVersion', 'keys']);
  if (record['schemaVersion'] !== 1 || !Array.isArray(record['keys'])) {
    throw new ProjectTemplateReceiptKeyStoreError('Invalid key registry schema');
  }
  const keys = record['keys'].map((value): ProjectTemplateReceiptKeyEntry => {
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
      secret = Uint8Array.from(Buffer.from(encoded, 'base64url'));
    }
    return {
      keyId: entry['keyId'] as string,
      state: entry['state'] as ProjectTemplateReceiptKeyState,
      ...(secret === undefined ? {} : { secret }),
    };
  });
  return validateProjectTemplateReceiptKeyRegistry({ schemaVersion: 1, keys });
}
