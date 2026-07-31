import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type FsOperation =
  | 'closeSync'
  | 'fchmodSync'
  | 'fstatSync'
  | 'fsyncSync'
  | 'lstatSync'
  | 'mkdirSync'
  | 'openSync'
  | 'readSync'
  | 'readdirSync'
  | 'renameSync'
  | 'writeFileSync';

const fsFault = vi.hoisted(() => ({
  operation: undefined as FsOperation | undefined,
  hook0: undefined as (() => void) | undefined,
  beforeReleaseMutation: undefined as ((path: string) => void) | undefined,
  afterReaddir: undefined as ((path: string) => boolean | void) | undefined,
  afterLeaseWrite: undefined as (() => void) | undefined,
  actualRenameSync: undefined as typeof import('node:fs').renameSync | undefined,
  actualWriteFileSync: undefined as typeof import('node:fs').writeFileSync | undefined,
  readCalls: 0,
}));

const cryptoFault = vi.hoisted(() => ({
  nextRandomBytes: undefined as Buffer | undefined,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes(size: number) {
      const forced = cryptoFault.nextRandomBytes;
      cryptoFault.nextRandomBytes = undefined;
      return forced ?? actual.randomBytes(size);
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsFault.actualRenameSync = actual.renameSync;
  fsFault.actualWriteFileSync = actual.writeFileSync;
  const fail = (operation: FsOperation): void => {
    if (fsFault.operation !== operation) return;
    fsFault.operation = undefined;
    throw Object.assign(new Error('raw-fs-secret /absolute/secret token-secret'), {
      code: 'EIO',
      path: '/absolute/secret',
      token: 'token-secret',
      raw: { detail: 'raw-fs-secret' },
    });
  };
  const runHook0 = (): void => {
    const hook = fsFault.hook0;
    fsFault.hook0 = undefined;
    hook?.();
  };
  const runReleaseHook = (path: string): void => {
    const hook = fsFault.beforeReleaseMutation;
    fsFault.beforeReleaseMutation = undefined;
    hook?.(path);
  };

  return {
    ...actual,
    lstatSync(...args: Parameters<typeof actual.lstatSync>) {
      runHook0();
      fail('lstatSync');
      return actual.lstatSync(...args);
    },
    mkdirSync(...args: Parameters<typeof actual.mkdirSync>) {
      fail('mkdirSync');
      return actual.mkdirSync(...args);
    },
    openSync(...args: Parameters<typeof actual.openSync>) {
      fail('openSync');
      return actual.openSync(...args);
    },
    fchmodSync(...args: Parameters<typeof actual.fchmodSync>) {
      fail('fchmodSync');
      return actual.fchmodSync(...args);
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      fail('writeFileSync');
      const result = actual.writeFileSync(...args);
      const hook = fsFault.afterLeaseWrite;
      fsFault.afterLeaseWrite = undefined;
      hook?.();
      return result;
    },
    fsyncSync(...args: Parameters<typeof actual.fsyncSync>) {
      fail('fsyncSync');
      return actual.fsyncSync(...args);
    },
    closeSync(...args: Parameters<typeof actual.closeSync>) {
      fail('closeSync');
      return actual.closeSync(...args);
    },
    fstatSync(...args: Parameters<typeof actual.fstatSync>) {
      fail('fstatSync');
      return actual.fstatSync(...args);
    },
    readSync(...args: Parameters<typeof actual.readSync>) {
      fsFault.readCalls += 1;
      fail('readSync');
      return actual.readSync(...args);
    },
    readdirSync(...args: Parameters<typeof actual.readdirSync>) {
      fail('readdirSync');
      const result = actual.readdirSync(...args);
      const hook = fsFault.afterReaddir;
      if (hook?.(String(args[0])) !== false) fsFault.afterReaddir = undefined;
      return result;
    },
    renameSync(...args: Parameters<typeof actual.renameSync>) {
      runReleaseHook(String(args[0]));
      fail('renameSync');
      return actual.renameSync(...args);
    },
  };
});

import {
  acquireRepertoireCoordinationLease,
  type RepertoireCoordinationLease,
} from '../../features/repertoire/coordination-lease.js';

const roots: string[] = [];

afterEach(() => {
  fsFault.operation = undefined;
  fsFault.hook0 = undefined;
  fsFault.beforeReleaseMutation = undefined;
  fsFault.afterReaddir = undefined;
  fsFault.afterLeaseWrite = undefined;
  fsFault.readCalls = 0;
  cryptoFault.nextRandomBytes = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repertoire coordination hardening', () => {
  it('uses module-captured intrinsics when a waiting writer times out after hook0 poison', async () => {
    const root = makeRoot();
    const owner = await acquire(root, 'write');
    const activePath = findActiveLeasePath(root, 'write');
    const active = JSON.parse(readFileSync(activePath, 'utf8')) as Record<string, unknown>;
    const writerToken = String(active['token']);
    const originals = capturePoisonedIntrinsicDescriptors();
    const observed: IntrinsicObservation[] = [];
    const observe = (observation: IntrinsicObservation) => {
      observed[observed.length] = observation;
    };
    fsFault.hook0 = () => poisonIntrinsics(observe);

    let caught: unknown;
    try {
      caught = await acquire(root, 'write', 40).catch((error: unknown) => error);
    } finally {
      restorePoisonedIntrinsics(originals);
    }

    expect(caught).toMatchObject({ code: 'TIMEOUT' });
    expect(containsToken(observed, writerToken)).toBe(false);
    owner.release();
  });

  it('denies a reader without exposing its writer token to hostile post-init intrinsics', async () => {
    const root = makeRoot();
    const owner = await acquire(root, 'write');
    const activePath = findActiveLeasePath(root, 'write');
    const active = JSON.parse(readFileSync(activePath, 'utf8')) as Record<string, unknown>;
    const writerToken = String(active['token']);
    const originals = capturePoisonedIntrinsicDescriptors();
    const observed: IntrinsicObservation[] = [];
    const observe = (observation: IntrinsicObservation) => {
      observed[observed.length] = observation;
    };
    fsFault.hook0 = () => poisonIntrinsics(observe);

    let caught: unknown;
    try {
      caught = await acquire(root, 'read', 40).catch((error: unknown) => error);
    } finally {
      restorePoisonedIntrinsics(originals);
    }

    expect(caught).toMatchObject({ code: 'WRITER_PENDING' });
    expect(containsToken(observed, writerToken)).toBe(false);
    expect(String(caught)).not.toContain(writerToken);
    owner.release();
  });

  it.each(['read', 'write'] as const)(
    'never removes a foreign %s owner installed immediately before release mutation',
    async (mode) => {
      const root = makeRoot();
      const lease = await acquire(root, mode);
      const activePath = findActiveLeasePath(root, mode);
      const original = JSON.parse(readFileSync(activePath, 'utf8')) as Record<string, unknown>;
      const foreignToken = randomUUID();
      const savedOwnedPath = join(root, `saved-owned-${mode}`);
      fsFault.beforeReleaseMutation = (path) => {
        expect(path).toBe(activePath);
        fsFault.actualRenameSync!(path, savedOwnedPath);
        fsFault.actualWriteFileSync!(path, `${JSON.stringify({
          ...original,
          token: foreignToken,
        })}\n`, { mode: 0o600 });
      };

      let releaseError: unknown;
      try {
        lease.release();
      } catch (error) {
        releaseError = error;
      }

      expect(releaseError).toMatchObject({ code: 'UNSAFE_STATE' });
      expect(findPayloadWithToken(root, foreignToken)).toBe(true);
      await expect(acquire(root, mode, 50))
        .rejects.toMatchObject({ code: 'UNSAFE_STATE' });
    },
  );

  it('fails closed when an unknown reader artifact appears during a scan', async () => {
    const root = makeRoot();
    const seed = await acquire(root, 'read');
    seed.release();
    let injectedPath: string | undefined;
    fsFault.afterReaddir = (path) => {
      if (basename(path) !== 'readers') return false;
      injectedPath = join(path, 'unknown-artifact');
      fsFault.actualWriteFileSync!(injectedPath, 'unknown\n', { mode: 0o600 });
      return true;
    };

    await expect(acquire(root, 'read', 50))
      .rejects.toMatchObject({ code: 'UNSAFE_STATE' });
    expect(injectedPath).toBeDefined();
    expect(existsSync(injectedPath!)).toBe(true);
  });

  it('rescans all coordination state after publishing its own claim', async () => {
    const root = makeRoot();
    const readers = join(root, '.takt-repertoire-coordination', 'readers');
    const injectedPath = join(readers, 'post-publication-unknown');
    fsFault.afterLeaseWrite = () => {
      fsFault.actualWriteFileSync!(injectedPath, 'unknown\n', { mode: 0o600 });
    };

    await expect(acquire(root, 'read', 50))
      .rejects.toMatchObject({ code: 'UNSAFE_STATE' });
    expect(existsSync(injectedPath)).toBe(true);
    expect(readdirSync(readers).filter((name) => name.endsWith('.lease'))).toEqual([]);
  });

  it('keeps an exact released tombstone while allowing later acquisition', async () => {
    const root = makeRoot();
    const lease = await acquire(root, 'write');
    lease.release();

    const released = releasedFiles(root);
    expect(released).toHaveLength(1);
    const next = await acquire(root, 'write');
    next.release();
    expect(releasedFiles(root)).toHaveLength(2);
  });

  it('fails closed when a released tombstone no longer matches its filename', async () => {
    const root = makeRoot();
    const lease = await acquire(root, 'write');
    lease.release();
    const [released] = releasedFiles(root);
    const record = JSON.parse(readFileSync(released!, 'utf8')) as Record<string, unknown>;
    writeFileSync(released!, `${JSON.stringify({ ...record, token: randomUUID() })}\n`);

    await expect(acquire(root, 'write', 50))
      .rejects.toMatchObject({ code: 'UNSAFE_STATE' });
  });

  it('preserves a foreign legacy predictable destination and blocks future acquisition', async () => {
    const root = makeRoot();
    const lease = await acquire(root, 'write');
    const activePath = findActiveLeasePath(root, 'write');
    const active = JSON.parse(readFileSync(activePath, 'utf8')) as Record<string, unknown>;
    const legacyPath = join(
      root,
      '.takt-repertoire-coordination',
      'released',
      `${String(active['pid'])}.${String(active['token'])}.write.released`,
    );
    const foreign = 'foreign legacy destination\n';
    writeFileSync(legacyPath, foreign, { mode: 0o600 });

    expect(() => lease.release()).toThrow(expect.objectContaining({ code: 'UNSAFE_STATE' }));
    expect(readFileSync(legacyPath, 'utf8')).toBe(foreign);
    await expect(acquire(root, 'write', 50))
      .rejects.toMatchObject({ code: 'UNSAFE_STATE' });
  });

  it('preserves a foreign container on forced release nonce collision', async () => {
    const root = makeRoot();
    const lease = await acquire(root, 'write');
    const activePath = findActiveLeasePath(root, 'write');
    const active = JSON.parse(readFileSync(activePath, 'utf8')) as Record<string, unknown>;
    const nonce = 'ab'.repeat(32);
    const container = join(
      root,
      '.takt-repertoire-coordination',
      'released',
      `${nonce}.${String(active['pid'])}.${String(active['token'])}.write.released`,
    );
    mkdirSync(container, { mode: 0o700 });
    const foreignPath = join(container, 'foreign-artifact');
    const foreign = 'foreign collision destination\n';
    writeFileSync(foreignPath, foreign, { mode: 0o600 });
    cryptoFault.nextRandomBytes = Buffer.from(nonce, 'hex');

    expect(() => lease.release()).toThrow(expect.objectContaining({ code: 'UNSAFE_STATE' }));
    expect(readFileSync(foreignPath, 'utf8')).toBe(foreign);
    await expect(acquire(root, 'write', 50))
      .rejects.toMatchObject({ code: 'UNSAFE_STATE' });
  });

  it('returns recovery before opening any released child when the hard limit is exceeded', async () => {
    const root = makeRoot();
    const initial = await acquire(root, 'write');
    initial.release();
    const released = join(root, '.takt-repertoire-coordination', 'released');
    for (let index = 0; index < 4_096; index += 1) {
      mkdirSync(join(released, index.toString(16).padStart(64, '0')), { mode: 0o700 });
    }
    fsFault.readCalls = 0;

    await expect(acquire(root, 'write', 50))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fsFault.readCalls).toBe(0);
  });

  it.each([
    { count: 2_047, mode: 'read', expected: undefined },
    {
      count: 2_048,
      mode: 'read',
      expected: {
        code: 'MAINTENANCE_REQUIRED',
        message: 'repertoire coordination maintenance is required before new readers can acquire',
      },
    },
    { count: 4_096, mode: 'write', expected: undefined },
    {
      count: 4_097,
      mode: 'write',
      expected: {
        code: 'RECOVERY_REQUIRED',
        message: 'repertoire coordination requires operator recovery before acquisition can continue',
      },
    },
  ] as const)(
    'enforces released tombstone boundary $count for $mode acquisition',
    async ({ count, mode, expected }) => {
      const root = makeRoot();
      await seedReleasedTombstones(root, count);

      if (expected) {
        await expect(acquire(root, mode, 50)).rejects.toMatchObject(expected);
      } else {
        const lease = await acquire(root, mode, 500);
        lease.release();
      }
    },
  );

  it.each([
    'closeSync',
    'fchmodSync',
    'fstatSync',
    'fsyncSync',
    'lstatSync',
    'mkdirSync',
    'openSync',
    'readSync',
    'readdirSync',
    'renameSync',
    'writeFileSync',
  ] as const)('normalizes and redacts %s failures', async (operation) => {
    const root = makeRoot();
    let lease: RepertoireCoordinationLease | undefined;
    if (operation === 'renameSync') {
      lease = await acquire(root, 'write');
    }
    fsFault.operation = operation;

    let caught: unknown;
    try {
      if (lease) lease.release();
      else await acquire(root, 'read', 50);
    } catch (error) {
      caught = error;
    }

    assertSanitizedCoordinationError(caught);
  });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-repertoire-hardening-'));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function acquire(root: string, mode: 'read' | 'write', timeoutMs = 500) {
  return acquireRepertoireCoordinationLease({
    globalConfigDir: root,
    mode,
    timeoutMs,
  });
}

function findActiveLeasePath(root: string, mode: 'read' | 'write'): string {
  const files = allFiles(root);
  const path = files.find((candidate) => {
    try {
      const value = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      return value['mode'] === mode && value['pid'] === process.pid;
    } catch {
      return false;
    }
  });
  expect(path).toBeDefined();
  return path!;
}

function findPayloadWithToken(root: string, token: string): boolean {
  return allFiles(root).some((path) => {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      return value['token'] === token;
    } catch {
      return false;
    }
  });
}

function allFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

function releasedFiles(root: string): string[] {
  const released = join(root, '.takt-repertoire-coordination', 'released');
  if (!existsSync(released)) return [];
  return allFiles(released).filter((path) => basename(path) === 'lease.released');
}

async function seedReleasedTombstones(root: string, count: number): Promise<void> {
  const initial = await acquire(root, 'write');
  initial.release();
  const [seedPath] = releasedFiles(root);
  expect(seedPath).toBeDefined();
  const seed = JSON.parse(readFileSync(seedPath!, 'utf8')) as Record<string, unknown>;
  const releasedDirectory = join(seedPath!, '..', '..');
  for (let index = 1; index < count; index += 1) {
    const token = randomUUID();
    const record: Record<string, unknown> = { ...seed, token };
    const nonce = index.toString(16).padStart(64, '0');
    const container = join(
      releasedDirectory,
      `${nonce}.${String(record['pid'])}.${token}.write.released`,
    );
    mkdirSync(container, { mode: 0o700 });
    writeFileSync(
      join(container, 'lease.released'),
      `${JSON.stringify(record)}\n`,
      { mode: 0o600 },
    );
  }
}

function assertSanitizedCoordinationError(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    code: 'UNSAFE_STATE',
    message: 'repertoire coordination state cannot be proven safe',
  });
  const value = error as Error & Record<string, unknown>;
  expect(value.cause).toBeUndefined();
  expect(Object.keys(value).sort()).toEqual(['code']);
  expect(JSON.stringify(Object.fromEntries(Object.entries(value))))
    .not.toMatch(/raw-fs-secret|absolute\/secret|token-secret/);
  expect(String(value)).not.toMatch(/raw-fs-secret|absolute\/secret|token-secret/);
}

type PoisonedIntrinsicDescriptors = ReturnType<typeof capturePoisonedIntrinsicDescriptors>;

function capturePoisonedIntrinsicDescriptors() {
  return {
    arrayFind: Object.getOwnPropertyDescriptor(Array.prototype, 'find')!,
    arrayIncludes: Object.getOwnPropertyDescriptor(Array.prototype, 'includes')!,
    arrayIsArray: Object.getOwnPropertyDescriptor(Array, 'isArray')!,
    arrayJoin: Object.getOwnPropertyDescriptor(Array.prototype, 'join')!,
    arrayPush: Object.getOwnPropertyDescriptor(Array.prototype, 'push')!,
    arraySome: Object.getOwnPropertyDescriptor(Array.prototype, 'some')!,
    arraySort: Object.getOwnPropertyDescriptor(Array.prototype, 'sort')!,
    bufferAlloc: Object.getOwnPropertyDescriptor(Buffer, 'alloc')!,
    bufferSubarray: Object.getOwnPropertyDescriptor(Buffer.prototype, 'subarray')!,
    bufferToString: Object.getOwnPropertyDescriptor(Buffer.prototype, 'toString')!,
    dateNow: Object.getOwnPropertyDescriptor(Date, 'now')!,
    dateToISOString: Object.getOwnPropertyDescriptor(Date.prototype, 'toISOString')!,
    jsonParse: Object.getOwnPropertyDescriptor(JSON, 'parse')!,
    jsonStringify: Object.getOwnPropertyDescriptor(JSON, 'stringify')!,
    mathMin: Object.getOwnPropertyDescriptor(Math, 'min')!,
    numberIsSafeInteger: Object.getOwnPropertyDescriptor(Number, 'isSafeInteger')!,
    objectFreeze: Object.getOwnPropertyDescriptor(Object, 'freeze')!,
    objectKeys: Object.getOwnPropertyDescriptor(Object, 'keys')!,
    regexpTest: Object.getOwnPropertyDescriptor(RegExp.prototype, 'test')!,
    processGetuid: Object.getOwnPropertyDescriptor(process, 'getuid'),
  };
}

type IntrinsicObservation = {
  name: string;
  receiver: unknown;
  args: unknown[];
};

function poisonIntrinsics(observe: (observation: IntrinsicObservation) => void): void {
  const originals = capturePoisonedIntrinsicDescriptors();
  const reflectApply = Reflect.apply.bind(Reflect);
  const trap = (name: string, descriptor: PropertyDescriptor) => function trapIntrinsic(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    observe({ name, receiver: this, args });
    return reflectApply(descriptor.value as (...values: unknown[]) => unknown, this, args);
  };
  Object.defineProperty(Array.prototype, 'find', { configurable: true, value: trap('Array.find', originals.arrayFind) });
  Object.defineProperty(Array.prototype, 'includes', { configurable: true, value: trap('Array.includes', originals.arrayIncludes) });
  Object.defineProperty(Array, 'isArray', { configurable: true, value: trap('Array.isArray', originals.arrayIsArray) });
  Object.defineProperty(Array.prototype, 'join', { configurable: true, value: trap('Array.join', originals.arrayJoin) });
  Object.defineProperty(Array.prototype, 'push', { configurable: true, value: trap('Array.push', originals.arrayPush) });
  Object.defineProperty(Array.prototype, 'some', { configurable: true, value: trap('Array.some', originals.arraySome) });
  Object.defineProperty(Array.prototype, 'sort', { configurable: true, value: trap('Array.sort', originals.arraySort) });
  Object.defineProperty(Buffer, 'alloc', { configurable: true, value: trap('Buffer.alloc', originals.bufferAlloc) });
  Object.defineProperty(Buffer.prototype, 'subarray', { configurable: true, value: trap('Buffer.subarray', originals.bufferSubarray) });
  Object.defineProperty(Buffer.prototype, 'toString', { configurable: true, value: trap('Buffer.toString', originals.bufferToString) });
  Object.defineProperty(Date, 'now', { configurable: true, value: trap('Date.now', originals.dateNow) });
  Object.defineProperty(Date.prototype, 'toISOString', { configurable: true, value: trap('Date.toISOString', originals.dateToISOString) });
  Object.defineProperty(JSON, 'parse', { configurable: true, value: trap('JSON.parse', originals.jsonParse) });
  Object.defineProperty(JSON, 'stringify', { configurable: true, value: trap('JSON.stringify', originals.jsonStringify) });
  Object.defineProperty(Math, 'min', { configurable: true, value: trap('Math.min', originals.mathMin) });
  Object.defineProperty(Number, 'isSafeInteger', { configurable: true, value: trap('Number.isSafeInteger', originals.numberIsSafeInteger) });
  Object.defineProperty(Object, 'freeze', { configurable: true, value: trap('Object.freeze', originals.objectFreeze) });
  Object.defineProperty(Object, 'keys', { configurable: true, value: trap('Object.keys', originals.objectKeys) });
  Object.defineProperty(RegExp.prototype, 'test', { configurable: true, value: trap('RegExp.test', originals.regexpTest) });
  if (Object.getOwnPropertyDescriptor(process, 'getuid')) {
    Object.defineProperty(process, 'getuid', { configurable: true, value: trap('process.getuid', originals.processGetuid!) });
  }
}

function containsToken(value: unknown, token: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return value.includes(token);
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const child of Object.values(value)) {
    if (containsToken(child, token, seen)) return true;
  }
  return false;
}

function restorePoisonedIntrinsics(descriptors: PoisonedIntrinsicDescriptors): void {
  Object.defineProperty(Array.prototype, 'find', descriptors.arrayFind);
  Object.defineProperty(Array.prototype, 'includes', descriptors.arrayIncludes);
  Object.defineProperty(Array, 'isArray', descriptors.arrayIsArray);
  Object.defineProperty(Array.prototype, 'join', descriptors.arrayJoin);
  Object.defineProperty(Array.prototype, 'push', descriptors.arrayPush);
  Object.defineProperty(Array.prototype, 'some', descriptors.arraySome);
  Object.defineProperty(Array.prototype, 'sort', descriptors.arraySort);
  Object.defineProperty(Buffer, 'alloc', descriptors.bufferAlloc);
  Object.defineProperty(Buffer.prototype, 'subarray', descriptors.bufferSubarray);
  Object.defineProperty(Buffer.prototype, 'toString', descriptors.bufferToString);
  Object.defineProperty(Date, 'now', descriptors.dateNow);
  Object.defineProperty(Date.prototype, 'toISOString', descriptors.dateToISOString);
  Object.defineProperty(JSON, 'parse', descriptors.jsonParse);
  Object.defineProperty(JSON, 'stringify', descriptors.jsonStringify);
  Object.defineProperty(Math, 'min', descriptors.mathMin);
  Object.defineProperty(Number, 'isSafeInteger', descriptors.numberIsSafeInteger);
  Object.defineProperty(Object, 'freeze', descriptors.objectFreeze);
  Object.defineProperty(Object, 'keys', descriptors.objectKeys);
  Object.defineProperty(RegExp.prototype, 'test', descriptors.regexpTest);
  if (descriptors.processGetuid) {
    Object.defineProperty(process, 'getuid', descriptors.processGetuid);
  }
}
