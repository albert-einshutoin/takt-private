import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ProjectTemplateReceiptKeyRegistry,
} from '../../infra/security/project-template-receipt-key-store.js';
import {
  createWin32ProjectTemplateReceiptKeyStore,
  createWindowsDpapiCurrentUserAdapter,
  type ProjectTemplateReceiptDpapiAdapter,
} from '../../infra/security/project-template-receipt-key-store-win32.js';

const roots: string[] = [];

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'takt-receipt-dpapi-')));
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
      keyId: 'receipt-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      state: 'active',
      secret: new Uint8Array(32).fill(11),
    }],
  };
}

function reversibleDpapi(): ProjectTemplateReceiptDpapiAdapter {
  return {
    scope: 'CurrentUser',
    async protect(plaintext) {
      return Uint8Array.from(plaintext, (value) => value ^ 0xa5);
    },
    async unprotect(ciphertext) {
      return Uint8Array.from(ciphertext, (value) => value ^ 0xa5);
    },
  };
}

describe('Windows project template receipt key store', () => {
  it('stores only DPAPI CurrentUser ciphertext and restarts from it', async () => {
    const directory = join(root(), 'keys');
    const store = createWin32ProjectTemplateReceiptKeyStore({
      directory,
      dpapi: reversibleDpapi(),
    });

    await store.write(registry());

    const persisted = readFileSync(join(directory, 'keyring.dpapi'));
    expect(persisted.includes(Buffer.from(
      'receipt-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ))).toBe(false);
    expect(persisted.includes(Buffer.alloc(32, 11))).toBe(false);
    expect(await createWin32ProjectTemplateReceiptKeyStore({
      directory,
      dpapi: reversibleDpapi(),
    }).read()).toEqual(registry());
  });

  it('has no plaintext fallback when DPAPI protection fails', async () => {
    const directory = join(root(), 'keys');
    const secretText = Buffer.alloc(32, 11).toString('base64url');
    const store = createWin32ProjectTemplateReceiptKeyStore({
      directory,
      dpapi: {
        scope: 'CurrentUser',
        async protect() {
          throw new Error(`DPAPI failed for ${secretText}`);
        },
        async unprotect() {
          throw new Error('not used');
        },
      },
    });

    await expect(store.write(registry())).rejects.not.toThrow(secretText);
    expect(() => readFileSync(join(directory, 'keyring.dpapi'))).toThrow();
  });

  it('invokes the DPAPI runner with CurrentUser scope and bounded stdin/output', async () => {
    const calls: Array<{
      operation: string;
      scope: string;
      input: Uint8Array;
      maxOutputBytes: number;
    }> = [];
    const adapter = createWindowsDpapiCurrentUserAdapter({
      async run(request) {
        calls.push({ ...request, input: request.input.slice() });
        return new Uint8Array([7, 8, 9]);
      },
    });

    await expect(adapter.protect(new Uint8Array([1, 2]))).resolves.toEqual(
      new Uint8Array([7, 8, 9]),
    );
    expect(calls).toEqual([{
      operation: 'protect',
      scope: 'CurrentUser',
      input: new Uint8Array([1, 2]),
      maxOutputBytes: 64 * 1024,
    }]);
    await expect(adapter.protect(new Uint8Array(64 * 1024 + 1))).rejects.toThrow(
      /maximum|bounded/i,
    );
  });

  it('rejects reparse-like path indirection before reading ciphertext', async () => {
    const base = root();
    const real = join(base, 'real');
    mkdirSync(real);
    const linked = join(base, 'linked');
    symlinkSync(real, linked, 'dir');

    await expect(createWin32ProjectTemplateReceiptKeyStore({
      directory: linked,
      dpapi: reversibleDpapi(),
    }).read()).rejects.toThrow(/reparse|identity|symlink/i);
  });
});
