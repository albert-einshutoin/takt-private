import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
      keyId: 'receipt-key-1',
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
      '{"schemaVersion":1,"keys":[{"keyId":"receipt-key-1","state":"active","secret":"BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU"}]}',
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
        keyId: `receipt-key-${index}`,
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
        keyId: 'receipt-key-2',
        state: 'active',
        secret: new Uint8Array(32).fill(6),
      }],
    })).rejects.toThrow('simulated crash');
    expect(await healthy.read()).toEqual(first);
  });
});
