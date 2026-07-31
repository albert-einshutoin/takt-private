import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { acquireRepertoireCoordinationLease } from '../../features/repertoire/coordination-lease.js';
import {
  REPERTOIRE_READ_PERMIT_LOCK_ORDER,
  assertActiveRepertoireReadPermit,
  prepareRepertoireRead,
  withRepertoireReadPermit,
  type RepertoireReadPermit,
} from '../../features/repertoire/read-permit.js';

describe('repertoire read permit private boundary', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('binds opaque authority to one root and revokes escaped permits', async () => {
    const root = makeRoot(roots);
    const otherRoot = makeRoot(roots);
    let escaped: RepertoireReadPermit | undefined;

    await withRepertoireReadPermit({ globalConfigDir: root }, (permit) => {
      escaped = permit;
      expect(Reflect.ownKeys(permit)).toEqual([]);
      expect(Object.getPrototypeOf(permit)).toBeNull();
      expect(Object.isFrozen(permit)).toBe(true);
      expect(() => assertActiveRepertoireReadPermit(permit, root)).not.toThrow();
      expect(() => assertActiveRepertoireReadPermit(permit, otherRoot)).toThrow(
        expect.objectContaining({ code: 'UNSAFE_STATE' }),
      );
    });

    expect(() => assertActiveRepertoireReadPermit(escaped, root)).toThrow(
      expect.objectContaining({ code: 'UNSAFE_STATE' }),
    );
  });

  it('rejects forged, cloned, and cross-realm objects', async () => {
    const root = makeRoot(roots);
    await withRepertoireReadPermit({ globalConfigDir: root }, (permit) => {
      for (const candidate of [
        {},
        { ...permit },
        runInNewContext('({})') as object,
      ]) {
        expect(() => assertActiveRepertoireReadPermit(candidate, root)).toThrow(
          expect.objectContaining({ code: 'UNSAFE_STATE' }),
        );
      }
    });
  });

  it('keeps async callback authority and its reader lease active until settlement', async () => {
    const root = makeRoot(roots);
    const gate = deferred<void>();
    const entered = deferred<void>();
    const running = withRepertoireReadPermit({ globalConfigDir: root }, async (permit) => {
      entered.resolve();
      await gate.promise;
      assertActiveRepertoireReadPermit(permit, root);
      return 'done';
    });

    await entered.promise;
    expect(activeReaderFiles(root)).toHaveLength(1);
    gate.resolve();
    await expect(running).resolves.toBe('done');
    expect(activeReaderFiles(root)).toEqual([]);
  });

  it('releases a sync-prepared Promise before that Promise settles', async () => {
    const root = makeRoot(roots);
    const gate = deferred<void>();
    const prepared = deferred<void>();
    const running = prepareRepertoireRead({ globalConfigDir: root }, (permit) => {
      assertActiveRepertoireReadPermit(permit, root);
      prepared.resolve();
      return (async () => {
        await gate.promise;
        assertActiveRepertoireReadPermit(permit, root);
        return 'unreachable';
      })();
    });

    await prepared.promise;
    expect(activeReaderFiles(root)).toEqual([]);
    gate.resolve();
    await expect(running).rejects.toMatchObject({ code: 'UNSAFE_STATE' });
  });

  it('preserves callback throws and rejections after releasing the lease', async () => {
    const root = makeRoot(roots);
    const thrown = new Error('callback throw');
    await expect(withRepertoireReadPermit({ globalConfigDir: root }, () => {
      throw thrown;
    })).rejects.toBe(thrown);
    expect(activeReaderFiles(root)).toEqual([]);

    const rejected = new Error('callback reject');
    await expect(withRepertoireReadPermit({ globalConfigDir: root }, async () => {
      throw rejected;
    })).rejects.toBe(rejected);
    expect(activeReaderFiles(root)).toEqual([]);

    const preparation = new Error('preparation throw');
    await expect(prepareRepertoireRead({ globalConfigDir: root }, () => {
      throw preparation;
    })).rejects.toBe(preparation);
    expect(activeReaderFiles(root)).toEqual([]);
  });

  it('does not invoke the callback when read lease acquisition fails', async () => {
    const root = makeRoot(roots);
    chmodSync(root, 0o755);
    let calls = 0;
    await expect(withRepertoireReadPermit({ globalConfigDir: root }, () => {
      calls += 1;
    })).rejects.toMatchObject({ code: 'UNSAFE_STATE' });
    expect(calls).toBe(0);
  });

  it('redacts a release-only failure and does not expose its filesystem cause', async () => {
    const root = makeRoot(roots);
    let caught: unknown;
    try {
      await withRepertoireReadPermit({ globalConfigDir: root }, () => {
        const [claim] = activeReaderFiles(root);
        writeFileSync(claim!, `${readFileSync(claim!, 'utf8')} /secret/release`);
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'UNSAFE_STATE' });
    expect(caught).not.toHaveProperty('cause');
    expect(String(caught)).not.toContain('/secret/release');
  });

  it('does not replace a callback failure with a simultaneous release failure', async () => {
    const root = makeRoot(roots);
    const primary = new Error('primary callback failure');
    await expect(withRepertoireReadPermit({ globalConfigDir: root }, () => {
      const [claim] = activeReaderFiles(root);
      writeFileSync(claim!, `${readFileSync(claim!, 'utf8')} corrupt`);
      throw primary;
    })).rejects.toBe(primary);
  });

  it('honors writer exclusion before minting a permit', async () => {
    const root = makeRoot(roots);
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: root,
      mode: 'write',
      timeoutMs: 500,
    });
    let calls = 0;
    try {
      await expect(withRepertoireReadPermit({ globalConfigDir: root }, () => {
        calls += 1;
      })).rejects.toMatchObject({ code: 'WRITER_PENDING' });
      expect(calls).toBe(0);
    } finally {
      writer.release();
    }
  });

  it('publishes the global-before-project lock order as an immutable contract', () => {
    expect(REPERTOIRE_READ_PERMIT_LOCK_ORDER).toEqual([
      'global-repertoire',
      'project-template',
    ]);
    expect(Object.isFrozen(REPERTOIRE_READ_PERMIT_LOCK_ORDER)).toBe(true);
  });

  it('uses module-initialization captures for mutable authority intrinsics', async () => {
    const root = makeRoot(roots);
    const originalGet = WeakMap.prototype.get;
    const originalSet = WeakMap.prototype.set;
    const originalFreeze = Object.freeze;
    try {
      WeakMap.prototype.get = () => { throw new Error('poisoned get'); };
      WeakMap.prototype.set = () => { throw new Error('poisoned set'); };
      Object.freeze = () => { throw new Error('poisoned freeze'); };
      await withRepertoireReadPermit({ globalConfigDir: root }, (permit) => {
        assertActiveRepertoireReadPermit(permit, root);
      });
    } finally {
      WeakMap.prototype.get = originalGet;
      WeakMap.prototype.set = originalSet;
      Object.freeze = originalFreeze;
    }
  });
});

function makeRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-read-permit-'));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function activeReaderFiles(root: string): string[] {
  const readers = join(root, '.takt-repertoire-coordination', 'readers');
  try {
    return readdirSync(readers).map((name) => join(readers, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
