import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ProjectTemplateReceiptKeyRegistry,
} from '../../infra/security/project-template-receipt-key-store.js';
import {
  createWin32ProjectTemplateReceiptKeyStore,
  createWindowsDpapiCurrentUserAdapter,
  runWindowsDpapiCurrentUserProcess,
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

  it('bounds ciphertext reads and rejects grow, truncate, and replacement races', async () => {
    async function attacked(attack: (path: string) => void): Promise<void> {
      const directory = join(root(), 'keys');
      const healthy = createWin32ProjectTemplateReceiptKeyStore({
        directory,
        dpapi: reversibleDpapi(),
      });
      await healthy.write(registry());
      let once = false;
      const store = createWin32ProjectTemplateReceiptKeyStore({
        directory,
        dpapi: reversibleDpapi(),
        io: {
          afterInitialFileStat(path) {
            if (once || !path.endsWith('keyring.dpapi')) return;
            once = true;
            attack(path);
          },
        },
      });
      await expect(store.read()).rejects.toThrow(/changed|identity|bounded/i);
    }
    await attacked((path) => appendFileSync(path, Buffer.alloc(64 * 1024)));
    await attacked((path) => {
      const fd = openSync(path, 'r+');
      try { ftruncateSync(fd, 1); } finally { closeSync(fd); }
    });
    await attacked((path) => {
      const replacement = `${path}.replacement`;
      copyFileSync(path, replacement);
      renameSync(replacement, path);
    });

    const directory = join(root(), 'keys');
    const healthy = createWin32ProjectTemplateReceiptKeyStore({
      directory,
      dpapi: reversibleDpapi(),
    });
    await healthy.write(registry());
    let maximumRequested = 0;
    let readBuffer: Uint8Array | undefined;
    const partial = createWin32ProjectTemplateReceiptKeyStore({
      directory,
      dpapi: reversibleDpapi(),
      io: {
        read(fd, buffer, offset, length, position) {
          maximumRequested = Math.max(maximumRequested, buffer.byteLength);
          readBuffer = buffer;
          return readSync(fd, buffer, offset, Math.min(length, 2), position);
        },
      },
    });
    expect(await partial.read()).toEqual(registry());
    expect(maximumRequested).toBeLessThanOrEqual(64 * 1024);
    expect(readBuffer?.every((byte) => byte === 0)).toBe(true);
  });

  it('does not report a false failure after a published rename', async () => {
    const directory = join(root(), 'keys');
    const unsupported = createWin32ProjectTemplateReceiptKeyStore({
      directory,
      dpapi: reversibleDpapi(),
      io: {
        fsyncDirectory() {
          throw Object.assign(new Error('unsupported'), { code: 'EINVAL' });
        },
      },
    });
    await expect(unsupported.write(registry())).resolves.toBeUndefined();

    const verifiedPublished = createWin32ProjectTemplateReceiptKeyStore({
      directory,
      dpapi: reversibleDpapi(),
      io: {
        fsyncDirectory() {
          throw Object.assign(new Error('uncertain'), { code: 'EIO' });
        },
      },
    });
    await expect(verifiedPublished.write(registry())).resolves.toBeUndefined();

    const mismatched = createWin32ProjectTemplateReceiptKeyStore({
      directory,
      dpapi: reversibleDpapi(),
      io: {
        fsyncDirectory() {
          const path = join(directory, 'keyring.dpapi');
          const ciphertext = readFileSync(path);
          const plaintext = Uint8Array.from(ciphertext, (value) => value ^ 0xa5);
          const parsed = JSON.parse(Buffer.from(plaintext).toString('utf8')) as {
            keys: Array<{ secret: string }>;
          };
          parsed.keys[0]!.secret = Buffer.alloc(32, 99).toString('base64url');
          const changed = Buffer.from(JSON.stringify(parsed), 'utf8');
          writeFileSync(path, Uint8Array.from(changed, (value) => value ^ 0xa5));
          plaintext.fill(0);
          ciphertext.fill(0);
          changed.fill(0);
          throw Object.assign(new Error('uncertain'), { code: 'EIO' });
        },
      },
    });
    await expect(mismatched.write(registry())).rejects.toThrow(/unknown/i);
  });

  it('settles DPAPI timeout once and ignores late successful close', async () => {
    const child = fakeChild();
    child.kill = () => {
      child.killed = true;
      child.emit('close', 0);
      return true;
    };
    const promise = runWindowsDpapiCurrentUserProcess(dpapiRequest(), {
      spawnProcess: () => child,
      setTimer(callback) {
        queueMicrotask(callback);
        return 1;
      },
      clearTimer() {},
    });
    await expect(promise).rejects.toThrow(/timed out/i);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    child.stdout.end(Buffer.from('BwgJ', 'ascii'));
    child.emit('close', 0);
  });

  it('rejects DPAPI spawn/error-close, empty, extra, and stderr overflow', async () => {
    async function outcome(
      emit: (child: ReturnType<typeof fakeChild>) => void,
    ): Promise<PromiseSettledResult<Uint8Array>> {
      const child = fakeChild();
      const promise = runWindowsDpapiCurrentUserProcess(dpapiRequest(), {
        spawnProcess: () => child,
        setTimer: () => 1,
        clearTimer() {},
      });
      emit(child);
      return (await Promise.allSettled([promise]))[0]!;
    }

    expect((await outcome((child) => {
      child.emit('error', new Error('spawn secret'));
      child.emit('close', 0);
    })).status).toBe('rejected');
    const exact = await outcome((child) => {
      child.stdout.end(Buffer.from('BwgJ', 'ascii'));
      child.emit('close', 0);
    });
    expect(exact).toEqual({ status: 'fulfilled', value: new Uint8Array([7, 8, 9]) });
    expect((await outcome((child) => child.emit('close', 0))).status).toBe('rejected');
    expect((await outcome((child) => {
      child.stdout.end(Buffer.alloc(64 * 1024 + 1, 65));
      child.emit('close', 0);
    })).status).toBe('rejected');
    expect((await outcome((child) => {
      child.stderr.end(Buffer.alloc(64 * 1024 + 1, 65));
      child.emit('close', 1);
    })).status).toBe('rejected');
  });

  it('zeroizes DPAPI adapter and store-owned buffers', async () => {
    let adapterInput: Uint8Array | undefined;
    let adapterOutput: Uint8Array | undefined;
    const adapter = createWindowsDpapiCurrentUserAdapter({
      async run(request) {
        adapterInput = request.input;
        adapterOutput = new Uint8Array([1]);
        return adapterOutput;
      },
    });
    await adapter.protect(new Uint8Array([4]));
    expect(adapterInput?.every((byte) => byte === 0)).toBe(true);
    expect(adapterOutput?.every((byte) => byte === 0)).toBe(true);

    let plaintext: Uint8Array | undefined;
    let ciphertext: Uint8Array | undefined;
    const store = createWin32ProjectTemplateReceiptKeyStore({
      directory: join(root(), 'keys'),
      dpapi: {
        scope: 'CurrentUser',
        async protect(value) {
          plaintext = value;
          ciphertext = Uint8Array.from(value, (byte) => byte ^ 0xa5);
          return ciphertext;
        },
        async unprotect(value) {
          return Uint8Array.from(value, (byte) => byte ^ 0xa5);
        },
      },
    });
    await store.write(registry());
    expect(plaintext?.every((byte) => byte === 0)).toBe(true);
    expect(ciphertext?.every((byte) => byte === 0)).toBe(true);
  });
});

function dpapiRequest() {
  return {
    operation: 'protect' as const,
    scope: 'CurrentUser' as const,
    input: new Uint8Array([1]),
    maxOutputBytes: 64 * 1024,
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    killed: boolean;
    kill(): boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}
