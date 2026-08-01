import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ProjectTemplateReceiptKeyRegistry,
  ProjectTemplateReceiptKeyStore,
} from '../../infra/security/project-template-receipt-key-store.js';
import {
  createProjectTemplateReceiptAuthenticationRuntime,
} from '../../infra/github/project-template-receipt-authentication-runtime.js';

function memoryStore(): ProjectTemplateReceiptKeyStore & {
  registry?: ProjectTemplateReceiptKeyRegistry;
  generation?: number;
  disposed: boolean;
} {
  let tail = Promise.resolve();
  return {
    disposed: false,
    async read() {
      return this.registry === undefined
        ? undefined
        : structuredClone(this.registry);
    },
    async write(registry) {
      this.registry = structuredClone(registry);
      this.generation = (this.generation ?? -1) + 1;
    },
    async withExclusiveLease(operation) {
      const run = tail.then(async () => operation({
        snapshot: this.registry === undefined ? undefined : {
          generation: this.generation!,
          registry: structuredClone(this.registry),
        },
        compareAndSwap: async (expectedGeneration, registry) => {
          if (expectedGeneration !== this.generation) return undefined;
          this.generation = (this.generation ?? -1) + 1;
          this.registry = structuredClone(registry);
          return {
            generation: this.generation,
            registry: structuredClone(this.registry),
          };
        },
      }));
      tail = run.then(() => undefined, () => undefined);
      return await run;
    },
    async dispose() {
      this.disposed = true;
    },
  };
}

describe('project template receipt authentication runtime', () => {
  it('issues an H9-compatible same-key authenticator and verifier', async () => {
    const store = memoryStore();
    const runtime = await createProjectTemplateReceiptAuthenticationRuntime({
      keyStore: store,
      randomBytes: () => Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    });
    const signingKey = await runtime.authenticator.acquireSigningKey() as {
      readonly keyId: string;
      sign(input: Uint8Array): Promise<unknown>;
    };
    const input = new TextEncoder().encode('canonical receipt');
    const tag = await signingKey.sign(input);

    expect(tag).toBe(createHmac('sha256', Buffer.from(
      Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    )).update(input).digest('hex'));
    expect(await runtime.verifier.verify({
      keyId: signingKey.keyId,
      input,
      tag: tag as string,
    })).toBe('valid');
    expect(await runtime.verifier.verify({
      keyId: signingKey.keyId,
      input: new TextEncoder().encode('tampered'),
      tag: tag as string,
    })).toBe('invalid');
  });

  it('makes each signing lease single-use', async () => {
    const runtime = await createProjectTemplateReceiptAuthenticationRuntime({
      keyStore: memoryStore(),
      randomBytes: () => new Uint8Array(32).fill(7),
    });
    const lease = await runtime.authenticator.acquireSigningKey() as {
      sign(input: Uint8Array): Promise<unknown>;
    };

    await lease.sign(new Uint8Array([1]));
    await expect(lease.sign(new Uint8Array([1]))).rejects.toThrow(
      /signing lease is no longer available/i,
    );
  });

  it('persists keys across restart and rotates active keys to verify-only', async () => {
    const store = memoryStore();
    let seed = 1;
    const randomBytes = () => new Uint8Array(32).fill(seed++);
    const first = await createProjectTemplateReceiptAuthenticationRuntime({
      keyStore: store,
      randomBytes,
    });
    const oldLease = await first.authenticator.acquireSigningKey() as {
      readonly keyId: string;
      sign(input: Uint8Array): Promise<unknown>;
    };
    const input = new Uint8Array([4, 2]);
    const oldTag = await oldLease.sign(input) as string;
    const newKeyId = await first.rotate();
    const newLease = await first.authenticator.acquireSigningKey() as {
      readonly keyId: string;
      sign(input: Uint8Array): Promise<unknown>;
    };
    const newTag = await newLease.sign(input) as string;

    expect(newLease.keyId).toBe(newKeyId);
    expect(newLease.keyId).not.toBe(oldLease.keyId);
    await first.dispose();

    const restarted = await createProjectTemplateReceiptAuthenticationRuntime({
      keyStore: store,
      randomBytes,
    });
    expect(await restarted.verifier.verify({
      keyId: oldLease.keyId,
      input,
      tag: oldTag,
    })).toBe('valid');
    expect(await restarted.verifier.verify({
      keyId: newLease.keyId,
      input,
      tag: newTag,
    })).toBe('valid');
    expect((await restarted.authenticator.acquireSigningKey() as {
      readonly keyId: string;
    }).keyId).toBe(newKeyId);
  });

  it('persists explicit revocation and zeroizes authority on dispose', async () => {
    const store = memoryStore();
    let seed = 9;
    const runtime = await createProjectTemplateReceiptAuthenticationRuntime({
      keyStore: store,
      randomBytes: () => new Uint8Array(32).fill(seed++),
    });
    const lease = await runtime.authenticator.acquireSigningKey() as {
      readonly keyId: string;
      sign(input: Uint8Array): Promise<unknown>;
    };
    const input = new Uint8Array([9]);
    const tag = await lease.sign(input) as string;
    await runtime.revoke(lease.keyId);

    expect(await runtime.verifier.verify({
      keyId: lease.keyId,
      input,
      tag,
    })).toBe('invalid');
    await runtime.dispose();
    expect(store.disposed).toBe(true);
    await expect(runtime.authenticator.acquireSigningKey()).rejects.toThrow(
      /disposed/i,
    );
    const restarted = await createProjectTemplateReceiptAuthenticationRuntime({
      keyStore: store,
      randomBytes: () => new Uint8Array(32).fill(seed++),
    });
    expect(await restarted.verifier.verify({
      keyId: lease.keyId,
      input,
      tag,
    })).toBe('invalid');
  });

  it('treats malformed tags as invalid without calling an unequal-length compare', async () => {
    const runtime = await createProjectTemplateReceiptAuthenticationRuntime({
      keyStore: memoryStore(),
      randomBytes: () => new Uint8Array(32).fill(3),
    });
    const lease = await runtime.authenticator.acquireSigningKey() as {
      readonly keyId: string;
    };

    await expect(runtime.verifier.verify({
      keyId: lease.keyId,
      input: new Uint8Array([1]),
      tag: 'not-a-sha256-tag',
    })).resolves.toBe('invalid');
    await expect(runtime.verifier.verify({
      keyId: 'malformed',
      input: new Uint8Array([1]),
      tag: '0'.repeat(64),
    })).resolves.toBe('invalid');
    await expect(runtime.verifier.verify({
      keyId: 'receipt-key-ffffffffffffffffffffffffffffffff',
      input: new Uint8Array([1]),
      tag: '0'.repeat(64),
    })).resolves.toBe('unavailable');
    await expect(runtime.verifier.verify({
      keyId: lease.keyId,
      input: new Uint8Array(256 * 1024 + 1),
      tag: '0'.repeat(64),
    })).resolves.toBe('invalid');
    await expect(runtime.revoke('malformed')).rejects.toThrow(/argument/i);
  });

  it('serializes concurrent runtime init, signing, rotation, and revocation', async () => {
    const store = memoryStore();
    let seed = 20;
    const randomBytes = () => new Uint8Array(32).fill(seed++);
    const [first, second] = await Promise.all([
      createProjectTemplateReceiptAuthenticationRuntime({ keyStore: store, randomBytes }),
      createProjectTemplateReceiptAuthenticationRuntime({ keyStore: store, randomBytes }),
    ]);
    const input = new Uint8Array([8, 8]);
    const firstLease = await first.authenticator.acquireSigningKey() as {
      readonly keyId: string;
      sign(input: Uint8Array): Promise<unknown>;
    };
    const firstTag = await firstLease.sign(input) as string;
    const [rotatedKey] = await Promise.all([first.rotate(), second.rotate()]);
    const revokedLease = await first.authenticator.acquireSigningKey() as {
      readonly keyId: string;
      sign(input: Uint8Array): Promise<unknown>;
    };
    const revokedTag = await revokedLease.sign(input) as string;
    await Promise.all([first.rotate(), second.revoke(revokedLease.keyId)]);

    const restarted = await createProjectTemplateReceiptAuthenticationRuntime({
      keyStore: store,
      randomBytes,
    });
    expect(await restarted.verifier.verify({
      keyId: firstLease.keyId,
      input,
      tag: firstTag,
    })).toBe('valid');
    expect(await restarted.verifier.verify({
      keyId: revokedLease.keyId,
      input,
      tag: revokedTag,
    })).toBe('invalid');
    expect(store.registry?.keys.filter((key) => key.state === 'active')).toHaveLength(1);
    expect(store.registry?.keys.some((key) => key.keyId === rotatedKey)).toBe(true);
  });
});
