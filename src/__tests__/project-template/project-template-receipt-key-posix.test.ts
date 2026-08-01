import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPosixProjectTemplateReceiptKeyStore,
} from '../../infra/security/project-template-receipt-key-store-posix.js';
import {
  parseProjectTemplateReceiptKeyRegistry,
  type ProjectTemplateReceiptKeyEntry,
  type ProjectTemplateReceiptKeyRegistry,
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
    let readPasses = 0;
    const hashes: Uint8Array[] = [];
    const partial = createPosixProjectTemplateReceiptKeyStore({
      directory,
      io: {
        read(fd, buffer, offset, length, position) {
          maximumRequested = Math.max(maximumRequested, buffer.byteLength);
          readBuffer = buffer;
          if (position === 0) readPasses += 1;
          return readSync(fd, buffer, offset, Math.min(length, 3), position);
        },
        onHashBuffer(buffer) { hashes.push(buffer); },
      },
    });
    expect(await partial.read()).toEqual(registry());
    expect(maximumRequested).toBeLessThanOrEqual(64 * 1024);
    expect(readBuffer?.every((byte) => byte === 0)).toBe(true);
    expect(readPasses).toBe(2);
    expect(hashes).toHaveLength(2);
    expect(hashes.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  });

  it('never unlinks another owner lock after timeout or path replacement', async () => {
    const directory = join(root(), 'keys');
    const owner = createPosixProjectTemplateReceiptKeyStore({ directory });
    const waiter = createPosixProjectTemplateReceiptKeyStore({
      directory,
      leasePolicy: { attempts: 2, waitMs: 1 },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = owner.withExclusiveLease(async () => gate);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(waiter.withExclusiveLease(() => undefined)).rejects.toThrow(
      /lease is unavailable/i,
    );
    const third = createPosixProjectTemplateReceiptKeyStore({
      directory,
      leasePolicy: { attempts: 2, waitMs: 1 },
    });
    await expect(third.withExclusiveLease(() => undefined)).rejects.toThrow(
      /lease is unavailable/i,
    );

    const lockPath = join(directory, '.keyring.lock');
    unlinkSync(lockPath);
    writeFileSync(lockPath, 'replacement-owner\n', { mode: 0o600 });
    release();
    await held;
    expect(readFileSync(lockPath, 'utf8')).toBe('replacement-owner\n');
  });

  it('rejects same-size in-place registry changes after initial fstat', async () => {
    const directory = join(root(), 'keys');
    const healthy = createPosixProjectTemplateReceiptKeyStore({ directory });
    await healthy.write(registry());
    let changed = false;
    const raced = createPosixProjectTemplateReceiptKeyStore({
      directory,
      io: {
        afterInitialFileStat(path) {
          if (changed || !path.endsWith('keyring.json')) return;
          changed = true;
          const bytes = readFileSync(path);
          const text = bytes.toString('utf8').replace('"generation":0', '"generation":1');
          expect(Buffer.byteLength(text)).toBe(bytes.byteLength);
          writeFileSync(path, text);
          bytes.fill(0);
        },
      },
    });
    await expect(raced.read()).rejects.toThrow(/changed/i);

    await healthy.write(registry());
    let pass = 0;
    const betweenReads = createPosixProjectTemplateReceiptKeyStore({
      directory,
      io: {
        read(fd, buffer, offset, length, position) {
          if (position === 0) pass += 1;
          if (pass === 2 && position === 0) {
            const bytes = readFileSync(join(directory, 'keyring.json'));
            const text = bytes.toString('utf8')
              .replace('"generation":1', '"generation":2');
            writeFileSync(join(directory, 'keyring.json'), text);
            bytes.fill(0);
          }
          return readSync(fd, buffer, offset, length, position);
        },
      },
    });
    await expect(betweenReads.read()).rejects.toThrow(/changed/i);
  });

  it('zeroizes every parse-owned decoded secret on success and partial failure', () => {
    const owned: Uint8Array[] = [];
    const secret = Buffer.alloc(32, 7).toString('base64url');
    const valid = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      keys: [{
        keyId: 'receipt-key-77777777777777777777777777777777',
        state: 'active',
        secret,
      }],
    }));
    const parsed = parseProjectTemplateReceiptKeyRegistry(valid, {
      onOwnedSecretBuffer(buffer) { owned.push(buffer); },
    });
    expect(parsed.keys[0]?.secret?.[0]).toBe(7);
    expect(owned.length).toBeGreaterThanOrEqual(2);
    expect(owned.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);

    owned.length = 0;
    expect(() => parseProjectTemplateReceiptKeyRegistry(valid, {
      onOwnedSecretBuffer(buffer) {
        owned.push(buffer);
        if (owned.length === 2) throw new Error('ownership seam failure');
      },
    })).toThrow('ownership seam failure');
    expect(owned.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);

    owned.length = 0;
    const invalid = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      keys: [
        {
          keyId: 'receipt-key-77777777777777777777777777777777',
          state: 'active',
          secret,
        },
        {
          keyId: 'receipt-key-88888888888888888888888888888888',
          state: 'verify-only',
          secret: 'invalid',
        },
      ] satisfies Array<Partial<ProjectTemplateReceiptKeyEntry>>,
    }));
    expect(() => parseProjectTemplateReceiptKeyRegistry(invalid, {
      onOwnedSecretBuffer(buffer) { owned.push(buffer); },
    })).toThrow(/encoded key secret/i);
    expect(owned.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    valid.fill(0);
    invalid.fill(0);
  });

  it('recovers only an old POSIX lock owned by a confirmed dead process', async () => {
    const directory = join(root(), 'keys');
    const healthy = createPosixProjectTemplateReceiptKeyStore({ directory });
    await healthy.write(registry());
    const lockPath = join(directory, '.keyring.lock');
    const ownerRecord = (createdAtMs: number) => JSON.stringify({
      pid: 424242,
      createdAtMs,
      token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    writeFileSync(lockPath, ownerRecord(1), { mode: 0o600 });
    const deadOwner = createPosixProjectTemplateReceiptKeyStore({
      directory,
      leasePolicy: {
        attempts: 3,
        waitMs: 1,
        staleAfterMs: 100,
        now: () => 1_000,
        isProcessAlive: () => false,
      },
    });
    await expect(deadOwner.read()).resolves.toEqual(registry());
    expect(existsSync(lockPath)).toBe(false);

    const rejected = async (
      content: string,
      isProcessAlive: () => boolean,
    ) => {
      writeFileSync(lockPath, content, { mode: 0o600 });
      const store = createPosixProjectTemplateReceiptKeyStore({
        directory,
        leasePolicy: {
          attempts: 2,
          waitMs: 1,
          staleAfterMs: 100,
          now: () => 1_000,
          isProcessAlive,
        },
      });
      await expect(store.read()).rejects.toThrow(/lease is unavailable/i);
      expect(readFileSync(lockPath, 'utf8')).toBe(content);
      unlinkSync(lockPath);
    };
    await rejected(ownerRecord(1), () => true);
    await rejected(ownerRecord(950), () => false);
    await rejected('{malformed', () => false);

    writeFileSync(lockPath, ownerRecord(1), { mode: 0o600 });
    const replaced = createPosixProjectTemplateReceiptKeyStore({
      directory,
      io: {
        beforeStaleLockUnlink(path) {
          unlinkSync(path);
          writeFileSync(path, 'replacement-owner\n', { mode: 0o600 });
        },
      },
      leasePolicy: {
        attempts: 2,
        waitMs: 1,
        staleAfterMs: 100,
        now: () => 1_000,
        isProcessAlive: () => false,
      },
    });
    await expect(replaced.read()).rejects.toThrow(/lease is unavailable/i);
    expect(readFileSync(lockPath, 'utf8')).toBe('replacement-owner\n');
  });

  it('preserves a same-inode lock that becomes live and young before stale recovery', async () => {
    const directory = join(root(), 'keys');
    const healthy = createPosixProjectTemplateReceiptKeyStore({ directory });
    await healthy.write(registry());
    const lockPath = join(directory, '.keyring.lock');
    const staleRecord = JSON.stringify({
      pid: 424242,
      createdAtMs: 1,
      token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const liveRecord = JSON.stringify({
      pid: 515151,
      createdAtMs: 999,
      token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    writeFileSync(lockPath, staleRecord, { mode: 0o600 });
    let mutated = false;
    const store = createPosixProjectTemplateReceiptKeyStore({
      directory,
      io: {
        beforeStaleLockUnlink(path) {
          if (mutated) return;
          mutated = true;
          writeFileSync(path, liveRecord);
        },
      },
      leasePolicy: {
        attempts: 2,
        waitMs: 1,
        staleAfterMs: 100,
        now: () => 1_000,
        isProcessAlive: (pid) => pid === 515151,
      },
    });

    await expect(store.read()).rejects.toThrow(/lease is unavailable/i);
    expect(readFileSync(lockPath, 'utf8')).toBe(liveRecord);
    expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);
  });

  it('preserves a same-inode lock whose mode changes before stale recovery', async () => {
    const directory = join(root(), 'keys');
    const healthy = createPosixProjectTemplateReceiptKeyStore({ directory });
    await healthy.write(registry());
    const lockPath = join(directory, '.keyring.lock');
    const staleRecord = JSON.stringify({
      pid: 424242,
      createdAtMs: 1,
      token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    writeFileSync(lockPath, staleRecord, { mode: 0o600 });
    let mutated = false;
    const store = createPosixProjectTemplateReceiptKeyStore({
      directory,
      io: {
        beforeStaleLockUnlink(path) {
          if (mutated) return;
          mutated = true;
          chmodSync(path, 0o644);
        },
      },
      leasePolicy: {
        attempts: 2,
        waitMs: 1,
        staleAfterMs: 100,
        now: () => 1_000,
        isProcessAlive: () => false,
      },
    });

    await expect(store.read()).rejects.toThrow(/lease is unavailable/i);
    expect(readFileSync(lockPath, 'utf8')).toBe(staleRecord);
    expect(lstatSync(lockPath).mode & 0o777).toBe(0o644);
  });

  it('zeroizes the first POSIX hash when its observer throws', async () => {
    const directory = join(root(), 'keys');
    const healthy = createPosixProjectTemplateReceiptKeyStore({ directory });
    await healthy.write(registry());
    let observed: Uint8Array | undefined;
    const store = createPosixProjectTemplateReceiptKeyStore({
      directory,
      io: {
        onHashBuffer(buffer) {
          observed = buffer;
          throw new Error('hash observer failure');
        },
      },
    });
    await expect(store.read()).rejects.toThrow('hash observer failure');
    expect(observed).toHaveLength(32);
    expect(observed?.every((byte) => byte === 0)).toBe(true);
  });
});
