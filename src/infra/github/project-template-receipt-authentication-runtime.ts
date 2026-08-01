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
  type ProjectTemplateReceiptKeyEntry,
  type ProjectTemplateReceiptKeyRegistry,
  type ProjectTemplateReceiptKeyStore,
} from '../security/project-template-receipt-key-store.js';

const KEY_ID_PATTERN = /^receipt-key-[a-f0-9]{32}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SIGNING_INPUT_BYTES = 256 * 1024;
const CAS_ATTEMPTS = 4;

export interface ProjectTemplateReceiptAuthenticationRuntimeOptions {
  readonly keyStore: ProjectTemplateReceiptKeyStore;
  readonly randomBytes?: (size: number) => Uint8Array;
}

/** Internal H11 capability bundle; intentionally absent from public barrels. */
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

function zeroizeRegistry(registry: ProjectTemplateReceiptKeyRegistry): void {
  for (const key of registry.keys) key.secret?.fill(0);
}

function cloneEntry(entry: ProjectTemplateReceiptKeyEntry): ProjectTemplateReceiptKeyEntry {
  return {
    keyId: entry.keyId,
    state: entry.state,
    ...(entry.secret === undefined ? {} : { secret: Uint8Array.from(entry.secret) }),
  };
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
    ) {
      if (generated instanceof Uint8Array && !types.isProxy(generated)) {
        generated.fill(0);
      }
      throw runtimeFailure('random source failed');
    }
    const secret = Uint8Array.from(generated);
    let retained = false;
    try {
      const keyId = `receipt-key-${createHash('sha256')
        .update(secret)
        .digest('hex')
        .slice(0, 32)}`;
      if (!existing.has(keyId)) {
        retained = true;
        return { keyId, state: 'active', secret };
      }
    } finally {
      // Why: injected and native random sources both transfer ephemeral bytes;
      // the runtime retains only its explicitly owned copy.
      generated.fill(0);
      if (!retained) secret.fill(0);
    }
  }
  throw runtimeFailure('could not allocate a unique key');
}

function validInput(input: unknown): input is Uint8Array {
  return input instanceof Uint8Array
    && !types.isProxy(input)
    && input.byteLength <= MAX_SIGNING_INPUT_BYTES;
}

function snapshotVerifyRequest(request: unknown): {
  readonly keyId: string;
  readonly input: Uint8Array;
  readonly tag: string;
} | undefined {
  try {
    if (
      typeof request !== 'object'
      || request === null
      || types.isProxy(request)
      || Object.getPrototypeOf(request) !== Object.prototype
    ) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(request);
    const keys = Reflect.ownKeys(request);
    if (
      keys.length !== 3
      || keys.some((key) => typeof key !== 'string'
        || !['keyId', 'input', 'tag'].includes(key))
      || descriptors['keyId'] === undefined
      || descriptors['input'] === undefined
      || descriptors['tag'] === undefined
      || !('value' in descriptors['keyId'])
      || !('value' in descriptors['input'])
      || !('value' in descriptors['tag'])
    ) return undefined;
    const keyId = descriptors['keyId'].value as unknown;
    const input = descriptors['input'].value as unknown;
    const tag = descriptors['tag'].value as unknown;
    if (
      typeof keyId !== 'string'
      || !KEY_ID_PATTERN.test(keyId)
      || !validInput(input)
      || typeof tag !== 'string'
      || !SHA256_HEX_PATTERN.test(tag)
    ) return undefined;
    return { keyId, input, tag };
  } catch {
    return undefined;
  }
}

export async function createProjectTemplateReceiptAuthenticationRuntime(
  options: ProjectTemplateReceiptAuthenticationRuntimeOptions,
): Promise<ProjectTemplateReceiptAuthenticationRuntime> {
  const store = options.keyStore;
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  if (
    typeof store !== 'object'
    || store === null
    || typeof store.withExclusiveLease !== 'function'
    || typeof store.dispose !== 'function'
    || typeof randomBytes !== 'function'
  ) throw runtimeFailure('options are invalid');
  let disposed = false;

  function available(): void {
    if (disposed) throw runtimeFailure('runtime is disposed');
  }

  async function initialize(): Promise<void> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const initialized = await store.withExclusiveLease(async (lease) => {
        if (lease.snapshot !== undefined) return true;
        const initial = createKeyEntry(randomBytes, new Set());
        const registry = { schemaVersion: 1 as const, keys: [initial] };
        try {
          const written = await lease.compareAndSwap(undefined, registry);
          if (written !== undefined) zeroizeRegistry(written.registry);
          return written !== undefined;
        } finally {
          zeroizeRegistry(registry);
        }
      });
      if (initialized) return;
    }
    throw runtimeFailure('key registry CAS retry limit exceeded');
  }
  await initialize();

  const authenticator: GithubTemplateDownloadReceiptAuthenticator =
    Object.freeze({
      async acquireSigningKey(): Promise<GithubTemplateDownloadReceiptSigningKey> {
        available();
        const keyId = await store.withExclusiveLease((lease) => {
          const active = lease.snapshot?.registry.keys.find(
            (entry) => entry.state === 'active',
          );
          if (active?.secret === undefined) throw runtimeFailure('active key is unavailable');
          return active.keyId;
        });
        let consumed = false;
        return Object.freeze({
          keyId,
          async sign(input: Uint8Array): Promise<string> {
            if (consumed) throw runtimeFailure('signing lease is no longer available');
            consumed = true;
            available();
            if (!validInput(input)) throw runtimeFailure('signing input is invalid');
            return await store.withExclusiveLease((lease) => {
              const current = lease.snapshot?.registry.keys.find(
                (entry) => entry.keyId === keyId,
              );
              if (current?.state !== 'active' || current.secret === undefined) {
                throw runtimeFailure('signing lease is no longer available');
              }
              return createHmac('sha256', current.secret).update(input).digest('hex');
            });
          },
        });
      },
    });

  const verifier: GithubTemplateDownloadReceiptVerifier = Object.freeze({
    async verify(
      request: Parameters<GithubTemplateDownloadReceiptVerifier['verify']>[0],
    ) {
      available();
      const verifiedRequest = snapshotVerifyRequest(request);
      if (verifiedRequest === undefined) return 'invalid';
      return await store.withExclusiveLease((lease) => {
        const key = lease.snapshot?.registry.keys.find(
          (entry) => entry.keyId === verifiedRequest.keyId,
        );
        if (key === undefined) return 'unavailable' as const;
        if (key.state === 'revoked' || key.secret === undefined) return 'invalid' as const;
        const provided = Buffer.from(verifiedRequest.tag, 'hex');
        const expected = createHmac('sha256', key.secret)
          .update(verifiedRequest.input)
          .digest();
        try {
          return timingSafeEqual(expected, provided) ? 'valid' as const : 'invalid' as const;
        } finally {
          provided.fill(0);
          expected.fill(0);
        }
      });
    },
  });

  async function commitMutation<T>(
    mutate: (registry: ProjectTemplateReceiptKeyRegistry) => {
      readonly registry: ProjectTemplateReceiptKeyRegistry;
      readonly result: T;
    },
  ): Promise<T> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const outcome = await store.withExclusiveLease(async (lease) => {
        available();
        if (lease.snapshot === undefined) throw runtimeFailure('key registry is unavailable');
        const mutation = mutate(lease.snapshot.registry);
        try {
          const written = await lease.compareAndSwap(
            lease.snapshot.generation,
            mutation.registry,
          );
          if (written !== undefined) zeroizeRegistry(written.registry);
          return written === undefined
            ? { committed: false as const }
            : { committed: true as const, result: mutation.result };
        } finally {
          zeroizeRegistry(mutation.registry);
        }
      });
      if (outcome.committed) return outcome.result;
    }
    throw runtimeFailure('key registry CAS retry limit exceeded');
  }

  return Object.freeze({
    authenticator,
    verifier,
    async rotate() {
      return await commitMutation((current) => {
        const nextActive = createKeyEntry(
          randomBytes,
          new Set(current.keys.map((entry) => entry.keyId)),
        );
        let keys = current.keys.map((entry) => entry.state === 'active'
          ? { ...cloneEntry(entry), state: 'verify-only' as const }
          : cloneEntry(entry));
        if (keys.length >= PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_KEYS) {
          const removable = keys.findIndex((entry) => entry.state === 'verify-only');
          if (removable < 0) throw runtimeFailure('key registry has no rotation space');
          keys[removable]?.secret?.fill(0);
          keys = keys.filter((_, index) => index !== removable);
        }
        keys.push(nextActive);
        return {
          registry: { schemaVersion: 1, keys },
          result: nextActive.keyId,
        };
      });
    },
    async revoke(keyId: string) {
      if (!KEY_ID_PATTERN.test(keyId)) throw runtimeFailure('revoke argument is invalid');
      await commitMutation((current) => {
        const target = current.keys.find((entry) => entry.keyId === keyId);
        if (target === undefined) throw runtimeFailure('key is unavailable');
        if (target.state === 'revoked') {
          return { registry: {
            schemaVersion: 1,
            keys: current.keys.map(cloneEntry),
          }, result: undefined };
        }
        let keys = current.keys.map((entry): ProjectTemplateReceiptKeyEntry =>
          entry.keyId === keyId
            ? { keyId: entry.keyId, state: 'revoked' }
            : cloneEntry(entry));
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
        return { registry: { schemaVersion: 1, keys }, result: undefined };
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Reflect.apply(store.dispose, store, []);
    },
  });
}
