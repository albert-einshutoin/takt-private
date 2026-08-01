import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPosixProjectTemplateReceiptKeyStore,
} from '../../infra/security/project-template-receipt-key-store-posix.js';
import type {
  ProjectTemplateReceiptKeyRegistry,
} from '../../infra/security/project-template-receipt-key-store.js';

const roots: string[] = [];

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'takt-receipt-keys-')));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function registry(): ProjectTemplateReceiptKeyRegistry {
  return {
    schemaVersion: 1,
    keys: [{
      keyId: 'receipt-key-11111111111111111111111111111111',
      state: 'active',
      secret: new Uint8Array(32).fill(5),
    }],
  };
}

describe('POSIX project template receipt key store', () => {
  it('durably persists a canonical bounded registry with 0700/0600 modes', async () => {
    const directory = join(root(), 'private', 'receipt-keys');
    const store = createPosixProjectTemplateReceiptKeyStore({ directory });

    await store.write(registry());

    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(directory, 'keyring.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, 'keyring.json'), 'utf8')).toBe(
      '{"schemaVersion":1,"generation":0,"keys":[{"keyId":"receipt-key-11111111111111111111111111111111","state":"active","secret":"BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU"}]}',
    );
    expect(await store.read()).toEqual(registry());
  });

  it('fails closed for symlinked directories and registry paths', async () => {
    const base = root();
    const real = join(base, 'real');
    mkdirSync(real, { mode: 0o700 });
    const linkedDirectory = join(base, 'linked');
    symlinkSync(real, linkedDirectory);

    await expect(createPosixProjectTemplateReceiptKeyStore({
      directory: linkedDirectory,
    }).read()).rejects.toThrow(/symlink|identity|canonical/i);

    const directory = join(base, 'keys');
    mkdirSync(directory, { mode: 0o700 });
    const target = join(base, 'target');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, join(directory, 'keyring.json'));
    await expect(createPosixProjectTemplateReceiptKeyStore({
      directory,
    }).read()).rejects.toThrow(/symlink|identity|canonical/i);
  });

  it('rejects insecure modes, extra hard links, and oversized registries', async () => {
    const directory = join(root(), 'keys');
    const store = createPosixProjectTemplateReceiptKeyStore({ directory });
    await store.write(registry());
    chmodSync(join(directory, 'keyring.json'), 0o644);
    await expect(store.read()).rejects.toThrow(/mode/i);

    chmodSync(join(directory, 'keyring.json'), 0o600);
    linkSync(join(directory, 'keyring.json'), join(directory, 'keyring.alias'));
    await expect(store.read()).rejects.toThrow(/nlink/i);
    rmSync(join(directory, 'keyring.alias'));

    const oversized: ProjectTemplateReceiptKeyRegistry = {
      schemaVersion: 1,
      keys: Array.from({ length: 17 }, (_, index) => ({
        keyId: `receipt-key-${index.toString(16).padStart(32, '0')}`,
        state: index === 0 ? 'active' as const : 'verify-only' as const,
        secret: new Uint8Array(32).fill(index),
      })),
    };
    await expect(store.write(oversized)).rejects.toThrow(/bounded|maximum/i);
  });

  it('keeps the last complete registry when publication fails', async () => {
    const directory = join(root(), 'keys');
    const first = registry();
    const store = createPosixProjectTemplateReceiptKeyStore({
      directory,
      io: {
        beforeRename() {
          throw new Error('simulated crash');
        },
      },
    });
    const healthy = createPosixProjectTemplateReceiptKeyStore({ directory });
    await healthy.write(first);

    await expect(store.write({
      schemaVersion: 1,
      keys: [{
        keyId: 'receipt-key-22222222222222222222222222222222',
        state: 'active',
        secret: new Uint8Array(32).fill(6),
      }],
    })).rejects.toThrow('simulated crash');
    expect(await healthy.read()).toEqual(first);
  });

  it('holds an exclusive scoped lease across store instances', async () => {
    const directory = join(root(), 'keys');
    const first = createPosixProjectTemplateReceiptKeyStore({ directory });
    const second = createPosixProjectTemplateReceiptKeyStore({ directory });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const held = first.withExclusiveLease(async () => {
      order.push('first-enter');
      await gate;
      order.push('first-exit');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const waiting = second.withExclusiveLease(() => {
      order.push('second-enter');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['first-enter']);
    release();
    await Promise.all([held, waiting]);
    expect(order).toEqual(['first-enter', 'first-exit', 'second-enter']);
  });

  it('rejects grow, truncate, chmod, replacement, and close races', async () => {
    async function attacked(
      attack: (path: string) => void,
      phase: 'afterInitialFileStat' | 'beforeFinalFileStat' =
        'afterInitialFileStat',
    ): Promise<void> {
      const directory = join(root(), 'keys');
      const healthy = createPosixProjectTemplateReceiptKeyStore({ directory });
      await healthy.write(registry());
      let once = false;
      const store = createPosixProjectTemplateReceiptKeyStore({
        directory,
        io: {
          [phase](path) {
            if (once || !path.endsWith('keyring.json')) return;
            once = true;
            attack(path);
          },
        },
      });
      await expect(store.read()).rejects.toThrow(/changed|identity|mode|bounded/i);
    }

    await attacked((path) => appendFileSync(path, Buffer.alloc(64 * 1024)));
    await attacked((path) => {
      const fd = openSync(path, 'r+');
      try {
        ftruncateSync(fd, 1);
      } finally {
        closeSync(fd);
      }
    });
    await attacked((path) => chmodSync(path, 0o644));
    await attacked((path) => {
      const replacement = `${path}.replacement`;
      copyFileSync(path, replacement);
      chmodSync(replacement, 0o600);
      renameSync(replacement, path);
    }, 'beforeFinalFileStat');

    const directory = join(root(), 'keys');
    const healthy = createPosixProjectTemplateReceiptKeyStore({ directory });
    await healthy.write(registry());
    const closeFailure = createPosixProjectTemplateReceiptKeyStore({
      directory,
      io: {
        close(fd) {
          closeSync(fd);
          throw new Error('close failure');
        },
      },
    });
    await expect(closeFailure.read()).rejects.toThrow(/close failure/i);

    let closedAfterRace = false;
    const combined = createPosixProjectTemplateReceiptKeyStore({
      directory,
      io: {
        afterInitialFileStat(path) {
          if (path.endsWith('keyring.json')) appendFileSync(path, 'x');
        },
        close(fd) {
          closeSync(fd);
          closedAfterRace = true;
          throw new Error('combined close failure');
        },
      },
    });
    const combinedResult = await Promise.allSettled([combined.read()]);
    const reason = combinedResult[0]?.status === 'rejected'
      ? combinedResult[0].reason as AggregateError
      : undefined;
    expect(reason).toBeInstanceOf(AggregateError);
    expect(reason?.errors).toHaveLength(2);
    expect(closedAfterRace).toBe(true);
  });

  it('loops partial reads without allocating beyond size plus one', async () => {
    const directory = join(root(), 'keys');
    const healthy = createPosixProjectTemplateReceiptKeyStore({ directory });
    await healthy.write(registry());
    let maximumRequested = 0;
    let readBuffer: Uint8Array | undefined;
    const partial = createPosixProjectTemplateReceiptKeyStore({
      directory,
      io: {
        read(fd, buffer, offset, length, position) {
          maximumRequested = Math.max(maximumRequested, buffer.byteLength);
          readBuffer = buffer;
          return readSync(fd, buffer, offset, Math.min(length, 3), position);
        },
      },
    });
    expect(await partial.read()).toEqual(registry());
    expect(maximumRequested).toBeLessThanOrEqual(64 * 1024);
    expect(readBuffer?.every((byte) => byte === 0)).toBe(true);
  });
});
