import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { win32 } from 'node:path';
import {
  CoordinationFilesystemChangedError,
  CoordinationFilesystemPendingError,
  CoordinationFilesystemUnsafeError,
  createCoordinationIdentityPolicy,
  type CoordinationDirectoryAuthority,
  type CoordinationFileObservation,
  type CoordinationFilesystemPolicy,
  type CoordinationIdentity,
  type CoordinationStableFile,
} from './coordination-filesystem-types.js';
import { openBuiltinWindowsRootAuthority } from './coordination-win32-root-authority.js';
import {
  CoordinationWindowsSentinelBusyError,
  openWindowsCoordinationSentinel,
  type WindowsCoordinationSentinelAuthority,
} from './coordination-win32-sentinel.js';

const FILE_FLAGS = constants.O_RDONLY;
const CREATE_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL;
const identityPolicy = createCoordinationIdentityPolicy('win32');
const freeze = Object.freeze.bind(Object);
const reflectApply = Reflect.apply.bind(Reflect);
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const weakMapDelete = WeakMap.prototype.delete;
const arraySort = Array.prototype.sort;
const authorityStates = new WeakMap<CoordinationDirectoryAuthority, {
  readonly base: ReturnType<typeof openBuiltinWindowsRootAuthority>;
  sentinel?: WindowsCoordinationSentinelAuthority;
}>();
const getAuthorityState = (authority: CoordinationDirectoryAuthority) => reflectApply(
  weakMapGet,
  authorityStates,
  [authority],
) as { base: ReturnType<typeof openBuiltinWindowsRootAuthority>; sentinel?: WindowsCoordinationSentinelAuthority } | undefined;
const setAuthorityState = (
  authority: CoordinationDirectoryAuthority,
  state: { base: ReturnType<typeof openBuiltinWindowsRootAuthority>; sentinel?: WindowsCoordinationSentinelAuthority },
): void => { reflectApply(weakMapSet, authorityStates, [authority, state]); };
const deleteAuthorityState = (authority: CoordinationDirectoryAuthority): void => {
  reflectApply(weakMapDelete, authorityStates, [authority]);
};
let expectedDevice: string | undefined;

/**
 * Windows filesystem semantics for the lease protocol. Directory descriptors
 * and POSIX mode bits are intentionally absent: identity is established by the
 * exact profile root, non-reparse pathname checks, stable file handles, and the
 * retained regular-file sentinel.
 */
export const win32CoordinationFilesystemPolicy: CoordinationFilesystemPolicy = freeze({
  ...identityPolicy,
  preflightRoot(path: string): CoordinationDirectoryAuthority {
    const base = openBuiltinWindowsRootAuthority(path);
    if (expectedDevice !== undefined && expectedDevice !== base.evidence.dev) {
      base.close();
      throw unsafe();
    }
    expectedDevice = base.evidence.dev;
    let closed = false;
    const authority = freeze({
      lexicalRoot: base.lexicalRoot,
      canonicalRoot: base.canonicalRoot,
      evidence: base.evidence,
      assertUnchanged(): void {
        if (closed) throw unsafe();
        const state = getAuthorityState(authority);
        if (state === undefined) throw unsafe();
        (state.sentinel ?? state.base).assertUnchanged();
      },
      close(): void {
        if (closed) return;
        closed = true;
        const state = getAuthorityState(authority);
        deleteAuthorityState(authority);
        if (state === undefined) throw unsafe();
        if (state.sentinel !== undefined) state.sentinel.close();
        else state.base.close();
      },
    });
    setAuthorityState(authority, { base });
    return authority;
  },
  sealRoot(authority: CoordinationDirectoryAuthority): void {
    const state = getAuthorityState(authority);
    if (state === undefined) throw unsafe();
    if (state.sentinel === undefined) {
      try {
        state.sentinel = openWindowsCoordinationSentinel({ rootAuthority: state.base });
      } catch (error) {
        if (error instanceof CoordinationWindowsSentinelBusyError) {
          throw new CoordinationFilesystemPendingError(error.malformed);
        }
        throw error;
      }
    }
    state.sentinel.assertUnchanged();
  },
  ensurePrivateDirectory(path: string): void {
    try { mkdirSync(path); } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
    assertDirectory(path);
  },
  createPrivateDirectoryExclusive(path: string): CoordinationIdentity {
    mkdirSync(path);
    return directoryIdentity(path);
  },
  sealPrivateDirectory(path: string): void { assertDirectory(path); },
  assertDirectory,
  listStable(path: string) {
    const before = directoryDigest(path);
    const entries = reflectApply(arraySort, readdirSync(path), []) as string[];
    const after = directoryDigest(path);
    if (before !== after) throw new CoordinationFilesystemChangedError();
    return freeze({
      entries: freeze(entries),
      digest: before,
      assertUnchanged(): void {
        if (directoryDigest(path) !== before) throw new CoordinationFilesystemChangedError();
      },
    });
  },
  createStagedExclusiveFile(path: string, bytes: Buffer): CoordinationStableFile {
    let fd: number | undefined;
    try {
      fd = openSync(path, CREATE_FLAGS);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      return readOpened(fd, path, bytes.length);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
  readStableFile(path: string, maximumBytes: number): CoordinationStableFile {
    const before = requireFile(lstat(path));
    let fd: number | undefined;
    try {
      fd = openSync(path, FILE_FLAGS);
      const opened = requireFile(stat(fd));
      const after = requireFile(lstat(path));
      assertSameStableFile(before, opened);
      assertSameStableFile(opened, after);
      if (opened.size <= 0n || opened.size > BigInt(maximumBytes)) throw unsafe();
      const bytes = readBounded(fd, Number(opened.size));
      const final = requireFile(stat(fd));
      assertSameStableFile(opened, final);
      return stableFile(final, bytes);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
  statPath(path: string, maximumBytes: number): CoordinationFileObservation | undefined {
    const value = lstat(path);
    if (value === undefined) return undefined;
    if (value.symbolicLink) throw unsafe();
    if (value.kind === 'file' && (value.size < 0n || value.size > BigInt(maximumBytes))) {
      throw unsafe();
    }
    if (value.kind === 'file' && value.nlink !== 1n && value.nlink !== 2n) throw unsafe();
    assertExpectedDevice(value);
    return observation(value);
  },
  linkNoReplace: linkSync,
  unlinkOwned(path: string, identity: CoordinationIdentity): void {
    const current = requireFile(lstat(path));
    if (!identityPolicy.sameIdentity(toIdentity(current), identity)) throw unsafe();
    unlinkSync(path);
  },
  renameOwned(source: string, destination: string, _identity: CoordinationIdentity): void {
    renameSync(source, destination);
  },
  // Node does not provide a portable Windows directory-fsync contract. File
  // contents are flushed before atomic publication and root/sentinel identity
  // is re-proved by the protocol around every transition.
  syncDirectory(path: string): void { assertDirectory(path); },
  sameObject(left: CoordinationFileObservation, right: CoordinationFileObservation): boolean {
    return identityPolicy.sameIdentity(left.identity, right.identity);
  },
  sameStableFile(left: CoordinationFileObservation, right: CoordinationFileObservation): boolean {
    return identityPolicy.sameIdentity(left.identity, right.identity) && left.digest === right.digest;
  },
});

type WinStat = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly nlink: bigint;
  readonly kind: 'directory' | 'file' | 'other';
  readonly symbolicLink: boolean;
};

function assertDirectory(path: string): void {
  const canonical = realpathSync(path);
  if (canonical.toLowerCase() !== win32.normalize(path).toLowerCase()) throw unsafe();
  const value = lstat(path);
  if (value === undefined || value.kind !== 'directory' || value.symbolicLink) throw unsafe();
  assertExpectedDevice(value);
}

function directoryIdentity(path: string): CoordinationIdentity {
  assertDirectory(path);
  const value = lstat(path);
  if (value === undefined) throw unsafe();
  return freeze(toIdentity(value));
}

function directoryDigest(path: string): string {
  assertDirectory(path);
  const value = lstat(path);
  if (value === undefined) throw unsafe();
  return digest(value);
}

function readOpened(fd: number, path: string, expectedLength: number): CoordinationStableFile {
  const opened = requireFile(stat(fd));
  const pathname = requireFile(lstat(path));
  assertSameStableFile(opened, pathname);
  if (opened.size !== BigInt(expectedLength) || opened.size <= 0n) throw unsafe();
  const bytes = readBounded(fd, expectedLength);
  const final = requireFile(stat(fd));
  assertSameStableFile(opened, final);
  return stableFile(final, bytes);
}

function stableFile(value: WinStat, bytes: Buffer): CoordinationStableFile {
  const content = createHash('sha256').update(bytes).digest('hex');
  return freeze({ bytes, identity: freeze(toIdentity(value)), digest: `${digest(value)}:${content}` });
}

function observation(value: WinStat): CoordinationFileObservation {
  return freeze({
    identity: freeze(toIdentity(value)),
    digest: digest(value),
    kind: value.kind,
    linkCount: Number(value.nlink),
    size: Number(value.size),
  });
}

function requireFile(value: WinStat | undefined): WinStat {
  if (value === undefined || value.kind !== 'file' || value.symbolicLink || value.nlink !== 1n) {
    throw unsafe();
  }
  assertExpectedDevice(value);
  return value;
}

function assertSameStableFile(left: WinStat, right: WinStat): void {
  if (digest(left) !== digest(right)) throw unsafe();
}

function assertExpectedDevice(value: WinStat): void {
  if (expectedDevice === undefined || value.dev.toString() !== expectedDevice) throw unsafe();
}

function toIdentity(value: WinStat): CoordinationIdentity {
  return { kind: 'win32', dev: value.dev.toString(), ino: value.ino.toString() };
}

function digest(value: WinStat): string {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}:${value.nlink}:${value.kind}`;
}

function lstat(path: string): WinStat | undefined {
  try { return fromStat(lstatSync(path, { bigint: true })); } catch (error) {
    if (code(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function stat(fd: number): WinStat { return fromStat(fstatSync(fd, { bigint: true })); }

function fromStat(value: BigIntStats): WinStat {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
    nlink: value.nlink,
    kind: value.isDirectory() ? 'directory' : value.isFile() ? 'file' : 'other',
    symbolicLink: value.isSymbolicLink(),
  };
}

function readBounded(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) throw unsafe();
    offset += count;
  }
  return bytes;
}

function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code : undefined;
}

function unsafe(): CoordinationFilesystemUnsafeError {
  return new CoordinationFilesystemUnsafeError();
}
