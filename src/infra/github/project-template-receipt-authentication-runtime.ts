import {
  createHash,
  createHmac,
  randomBytes as cryptoRandomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { types } from 'node:util';
import type {
  GithubTemplateDownloadReceiptAuthenticator,
  GithubTemplateDownloadReceiptSigningKey,
} from '../../features/project-template/github-download-receipt.js';
import type {
  GithubTemplateDownloadReceiptVerifier,
} from '../../features/project-template/github-download-receipt-storage.js';
import {
  PROJECT_TEMPLATE_RECEIPT_KEY_BYTES,
  PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_KEYS,
  validateProjectTemplateReceiptKeyRegistry,
  type ProjectTemplateReceiptKeyEntry,
  type ProjectTemplateReceiptKeyRegistry,
  type ProjectTemplateReceiptKeyStore,
} from '../security/project-template-receipt-key-store.js';

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SIGNING_INPUT_BYTES = 256 * 1024;

export interface ProjectTemplateReceiptAuthenticationRuntimeOptions {
  readonly keyStore: ProjectTemplateReceiptKeyStore;
  readonly randomBytes?: (size: number) => Uint8Array;
}

/** Internal H11 capability bundle; it is intentionally absent from barrels. */
export interface ProjectTemplateReceiptAuthenticationRuntime {
  readonly authenticator: GithubTemplateDownloadReceiptAuthenticator;
  readonly verifier: GithubTemplateDownloadReceiptVerifier;
  rotate(): Promise<string>;
  revoke(keyId: string): Promise<void>;
  dispose(): Promise<void>;
}

function runtimeFailure(message: string): Error {
  return new Error(`Project template receipt authentication ${message}`);
}

function cloneRegistry(
  registry: ProjectTemplateReceiptKeyRegistry,
): ProjectTemplateReceiptKeyRegistry {
  return {
    schemaVersion: 1,
    keys: registry.keys.map((entry) => ({
      keyId: entry.keyId,
      state: entry.state,
      ...(entry.secret === undefined ? {} : { secret: entry.secret.slice() }),
    })),
  };
}

function zeroize(registry: ProjectTemplateReceiptKeyRegistry): void {
  for (const entry of registry.keys) entry.secret?.fill(0);
}

function createKeyEntry(
  randomBytes: (size: number) => Uint8Array,
  existing: ReadonlySet<string>,
): ProjectTemplateReceiptKeyEntry {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const generated = randomBytes(PROJECT_TEMPLATE_RECEIPT_KEY_BYTES);
    if (
      !(generated instanceof Uint8Array)
      || types.isProxy(generated)
      || generated.byteLength !== PROJECT_TEMPLATE_RECEIPT_KEY_BYTES
    ) throw runtimeFailure('random source failed');
    const secret = generated.slice();
    const keyId = `receipt-key-${createHash('sha256')
      .update(secret)
      .digest('hex')
      .slice(0, 32)}`;
    if (!existing.has(keyId)) return { keyId, state: 'active', secret };
    secret.fill(0);
  }
  throw runtimeFailure('could not allocate a unique key');
}

function validateSigningInput(input: Uint8Array): void {
  if (
    !(input instanceof Uint8Array)
    || types.isProxy(input)
    || input.byteLength > MAX_SIGNING_INPUT_BYTES
  ) throw runtimeFailure('signing input is invalid');
}

export async function createProjectTemplateReceiptAuthenticationRuntime(
  options: ProjectTemplateReceiptAuthenticationRuntimeOptions,
): Promise<ProjectTemplateReceiptAuthenticationRuntime> {
  const store = options.keyStore;
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  if (
    typeof store !== 'object'
    || store === null
    || typeof store.read !== 'function'
    || typeof store.write !== 'function'
    || typeof store.dispose !== 'function'
    || typeof randomBytes !== 'function'
  ) throw runtimeFailure('options are invalid');

  const loaded = await Reflect.apply(store.read, store, []);
  let registry = loaded === undefined
    ? ({ schemaVersion: 1, keys: [] } as const)
    : validateProjectTemplateReceiptKeyRegistry(loaded);
  let disposed = false;
  let mutation = Promise.resolve();

  async function persist(next: ProjectTemplateReceiptKeyRegistry): Promise<void> {
    const validated = validateProjectTemplateReceiptKeyRegistry(next);
    await Reflect.apply(store.write, store, [cloneRegistry(validated)]);
    const previous = registry;
    registry = validated;
    // Why: superseded snapshots can otherwise retain revoked or rotated
    // copies even though the live authority moved to the new snapshot.
    zeroize(previous);
  }

  async function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutation.then(operation, operation);
    mutation = result.then(() => undefined, () => undefined);
    return await result;
  }

  if (registry.keys.length === 0) {
    const initial = createKeyEntry(randomBytes, new Set());
    await persist({ schemaVersion: 1, keys: [initial] });
    initial.secret?.fill(0);
  }

  function requireAvailable(): void {
    if (disposed) throw runtimeFailure('runtime is disposed');
  }

  function activeEntry(): ProjectTemplateReceiptKeyEntry {
    requireAvailable();
    const active = registry.keys.find((entry) => entry.state === 'active');
    if (active?.secret === undefined) throw runtimeFailure('active key is unavailable');
    return active;
  }

  const authenticator: GithubTemplateDownloadReceiptAuthenticator =
    Object.freeze({
      async acquireSigningKey(): Promise<GithubTemplateDownloadReceiptSigningKey> {
        const keyId = activeEntry().keyId;
        let consumed = false;
        return Object.freeze({
          keyId,
          async sign(input: Uint8Array): Promise<string> {
            if (consumed) throw runtimeFailure('signing lease is no longer available');
            // Why: consume before validation/HMAC so exceptions cannot turn one
            // authority into a retryable multi-use signing oracle.
            consumed = true;
            requireAvailable();
            validateSigningInput(input);
            const current = registry.keys.find((entry) => entry.keyId === keyId);
            if (current?.state !== 'active' || current.secret === undefined) {
              throw runtimeFailure('signing lease is no longer available');
            }
            return createHmac('sha256', current.secret).update(input).digest('hex');
          },
        });
      },
    });

  const verifier: GithubTemplateDownloadReceiptVerifier = Object.freeze({
    async verify(
      request: Parameters<GithubTemplateDownloadReceiptVerifier['verify']>[0],
    ) {
      requireAvailable();
      if (
        typeof request !== 'object'
        || request === null
        || typeof request.keyId !== 'string'
        || !(request.input instanceof Uint8Array)
        || types.isProxy(request.input)
        || typeof request.tag !== 'string'
      ) return 'invalid';
      const key = registry.keys.find((entry) => entry.keyId === request.keyId);
      if (key === undefined) return 'unavailable';
      if (key.state === 'revoked' || key.secret === undefined) return 'invalid';
      if (!SHA256_HEX_PATTERN.test(request.tag)) return 'invalid';
      const provided = Buffer.from(request.tag, 'hex');
      const expected = createHmac('sha256', key.secret)
        .update(request.input)
        .digest();
      // Both buffers are fixed at 32 bytes before timingSafeEqual is called.
      return timingSafeEqual(expected, provided) ? 'valid' : 'invalid';
    },
  });

  return Object.freeze({
    authenticator,
    verifier,
    async rotate() {
      return await serializeMutation(async () => {
        requireAvailable();
        const nextActive = createKeyEntry(
          randomBytes,
          new Set(registry.keys.map((entry) => entry.keyId)),
        );
        let keys: ProjectTemplateReceiptKeyEntry[] = registry.keys.map((entry) => entry.state === 'active'
          ? { ...entry, secret: entry.secret?.slice(), state: 'verify-only' as const }
          : { ...entry, secret: entry.secret?.slice() });
        if (keys.length >= PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_KEYS) {
          const removable = keys.findIndex((entry) => entry.state === 'verify-only');
          if (removable < 0) throw runtimeFailure('key registry has no rotation space');
          keys[removable]?.secret?.fill(0);
          keys = keys.filter((_, index) => index !== removable);
        }
        keys.push(nextActive);
        try {
          await persist({ schemaVersion: 1, keys });
          return nextActive.keyId;
        } finally {
          zeroize({ schemaVersion: 1, keys });
        }
      });
    },
    async revoke(keyId: string) {
      await serializeMutation(async () => {
        requireAvailable();
        const target = registry.keys.find((entry) => entry.keyId === keyId);
        if (target === undefined) throw runtimeFailure('key is unavailable');
        if (target.state === 'revoked') return;
        let keys = registry.keys.map((entry): ProjectTemplateReceiptKeyEntry =>
          entry.keyId === keyId
            ? { keyId: entry.keyId, state: 'revoked' }
            : { ...entry, secret: entry.secret?.slice() });
        if (target.state === 'active') {
          const replacement = createKeyEntry(
            randomBytes,
            new Set(keys.map((entry) => entry.keyId)),
          );
          if (keys.length >= PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_KEYS) {
            const removable = keys.findIndex((entry) => entry.state === 'verify-only');
            if (removable < 0) throw runtimeFailure('key registry has no revocation space');
            keys[removable]?.secret?.fill(0);
            keys = keys.filter((_, index) => index !== removable);
          }
          keys.push(replacement);
        }
        try {
          await persist({ schemaVersion: 1, keys });
        } finally {
          zeroize({ schemaVersion: 1, keys });
        }
      });
    },
    async dispose() {
      await serializeMutation(async () => {
        if (disposed) return;
        disposed = true;
        try {
          await Reflect.apply(store.dispose, store, []);
        } finally {
          zeroize(registry);
          registry = Object.freeze({ schemaVersion: 1, keys: Object.freeze([]) });
        }
      });
    },
  });
}
