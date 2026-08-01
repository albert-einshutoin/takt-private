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
  WINDOWS_COORDINATION_SENTINEL_FILENAME,
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

export type Win32CoordinationFilesystemDependencies = {
  close(fd: number): void;
  fstat(fd: number): BigIntStats;
  fsync(fd: number): void;
  link(source: string, destination: string): void;
  lstat(path: string): BigIntStats;
  mkdir(path: string): void;
  open(path: string, flags: number): number;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  readdir(path: string): string[];
  realpath(path: string): string;
  rename(source: string, destination: string): void;
  unlink(path: string): void;
  write(fd: number, bytes: Buffer): void;
};

export type Win32CoordinationFilesystemPolicyOptions = {
  readonly dependencies?: Win32CoordinationFilesystemDependencies;
  readonly openRootAuthority?: typeof openBuiltinWindowsRootAuthority;
  readonly openSentinel?: typeof openWindowsCoordinationSentinel;
};

/**
 * Windows filesystem semantics for the lease protocol. Directory descriptors
 * and POSIX mode bits are intentionally absent: identity is established by the
 * exact profile root, non-reparse pathname checks, stable file handles, and the
 * retained regular-file sentinel.
 */
export function createWin32CoordinationFilesystemPolicy(
  options: Win32CoordinationFilesystemPolicyOptions = {},
): CoordinationFilesystemPolicy {
  const dependencies = options.dependencies ?? builtinFilesystemDependencies;
  const openRootAuthority = options.openRootAuthority ?? openBuiltinWindowsRootAuthority;
  const openSentinel = options.openSentinel ?? openWindowsCoordinationSentinel;
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

  return freeze({
  ...identityPolicy,
  preflightRoot(path: string): CoordinationDirectoryAuthority {
    const base = openRootAuthority(path);
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
        state.sentinel = openSentinel({ rootAuthority: state.base });
      } catch (error) {
        if (error instanceof CoordinationWindowsSentinelBusyError) {
          throw new CoordinationFilesystemPendingError(error.malformed);
        }
        throw error;
      }
    }
    state.sentinel.assertUnchanged();
  },
  isReservedRootEntry(entry: string): boolean {
    return entry === WINDOWS_COORDINATION_SENTINEL_FILENAME;
  },
  ensurePrivateDirectory(path: string): void {
    try { dependencies.mkdir(path); } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
    assertDirectory(path, dependencies, expectedDevice);
  },
  createPrivateDirectoryExclusive(path: string): CoordinationIdentity {
    dependencies.mkdir(path);
    return directoryIdentity(path, dependencies, expectedDevice);
  },
  sealPrivateDirectory(path: string): void { assertDirectory(path, dependencies, expectedDevice); },
  assertDirectory(path: string): void { assertDirectory(path, dependencies, expectedDevice); },
  listStable(path: string) {
    const before = directoryDigest(path, dependencies, expectedDevice);
    const entries = reflectApply(arraySort, dependencies.readdir(path), []) as string[];
    const after = directoryDigest(path, dependencies, expectedDevice);
    if (before !== after) throw new CoordinationFilesystemChangedError();
    return freeze({
      entries: freeze(entries),
      digest: before,
      assertUnchanged(): void {
        if (directoryDigest(path, dependencies, expectedDevice) !== before) {
          throw new CoordinationFilesystemChangedError();
        }
      },
    });
  },
  createStagedExclusiveFile(path: string, bytes: Buffer): CoordinationStableFile {
    let fd: number | undefined;
    try {
      fd = dependencies.open(path, CREATE_FLAGS);
      dependencies.write(fd, bytes);
      dependencies.fsync(fd);
      return readOpened(fd, path, bytes.length, dependencies, expectedDevice);
    } finally {
      if (fd !== undefined) dependencies.close(fd);
    }
  },
  readStableFile(path: string, maximumBytes: number): CoordinationStableFile {
    const before = requireFile(lstat(path, dependencies), expectedDevice);
    let fd: number | undefined;
    try {
      fd = dependencies.open(path, FILE_FLAGS);
      const opened = requireFile(stat(fd, dependencies), expectedDevice);
      const after = requireFile(lstat(path, dependencies), expectedDevice);
      assertSameStableFile(before, opened);
      assertSameStableFile(opened, after);
      if (opened.size <= 0n || opened.size > BigInt(maximumBytes)) throw unsafe();
      const bytes = readBounded(fd, Number(opened.size), dependencies);
      const final = requireFile(stat(fd, dependencies), expectedDevice);
      assertSameStableFile(opened, final);
      return stableFile(final, bytes);
    } finally {
      if (fd !== undefined) dependencies.close(fd);
    }
  },
  statPath(path: string, maximumBytes: number): CoordinationFileObservation | undefined {
    const value = lstat(path, dependencies);
    if (value === undefined) return undefined;
    if (value.symbolicLink) throw unsafe();
    if (value.kind === 'file' && (value.size < 0n || value.size > BigInt(maximumBytes))) {
      throw unsafe();
    }
    if (value.kind === 'file' && value.nlink !== 1n && value.nlink !== 2n) throw unsafe();
    assertExpectedDevice(value, expectedDevice);
    return observation(value);
  },
  linkNoReplace: dependencies.link,
  unlinkOwned(path: string, identity: CoordinationIdentity): void {
    const current = requireFile(lstat(path, dependencies), expectedDevice);
    if (!identityPolicy.sameIdentity(toIdentity(current), identity)) throw unsafe();
    dependencies.unlink(path);
  },
  renameOwned(source: string, destination: string, _identity: CoordinationIdentity): void {
    dependencies.rename(source, destination);
  },
  // Node does not provide a portable Windows directory-fsync contract. File
  // contents are flushed before atomic publication and root/sentinel identity
  // is re-proved by the protocol around every transition.
  syncDirectory(path: string): void { assertDirectory(path, dependencies, expectedDevice); },
  sameObject(left: CoordinationFileObservation, right: CoordinationFileObservation): boolean {
    return identityPolicy.sameIdentity(left.identity, right.identity);
  },
  sameStableFile(left: CoordinationFileObservation, right: CoordinationFileObservation): boolean {
    return identityPolicy.sameIdentity(left.identity, right.identity) && left.digest === right.digest;
  },
  });
}

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

function assertDirectory(
  path: string,
  dependencies: Win32CoordinationFilesystemDependencies,
  expectedDevice: string | undefined,
): void {
  const canonical = dependencies.realpath(path);
  if (canonical.toLowerCase() !== win32.normalize(path).toLowerCase()) throw unsafe();
  const value = lstat(path, dependencies);
  if (value === undefined || value.kind !== 'directory' || value.symbolicLink) throw unsafe();
  assertExpectedDevice(value, expectedDevice);
}

function directoryIdentity(
  path: string,
  dependencies: Win32CoordinationFilesystemDependencies,
  expectedDevice: string | undefined,
): CoordinationIdentity {
  assertDirectory(path, dependencies, expectedDevice);
  const value = lstat(path, dependencies);
  if (value === undefined) throw unsafe();
  return freeze(toIdentity(value));
}

function directoryDigest(
  path: string,
  dependencies: Win32CoordinationFilesystemDependencies,
  expectedDevice: string | undefined,
): string {
  assertDirectory(path, dependencies, expectedDevice);
  const value = lstat(path, dependencies);
  if (value === undefined) throw unsafe();
  return digest(value);
}

function readOpened(
  fd: number,
  path: string,
  expectedLength: number,
  dependencies: Win32CoordinationFilesystemDependencies,
  expectedDevice: string | undefined,
): CoordinationStableFile {
  const opened = requireFile(stat(fd, dependencies), expectedDevice);
  const pathname = requireFile(lstat(path, dependencies), expectedDevice);
  assertSameStableFile(opened, pathname);
  if (opened.size !== BigInt(expectedLength) || opened.size <= 0n) throw unsafe();
  const bytes = readBounded(fd, expectedLength, dependencies);
  const final = requireFile(stat(fd, dependencies), expectedDevice);
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

function requireFile(value: WinStat | undefined, expectedDevice: string | undefined): WinStat {
  if (value === undefined || value.kind !== 'file' || value.symbolicLink || value.nlink !== 1n) {
    throw unsafe();
  }
  assertExpectedDevice(value, expectedDevice);
  return value;
}

function assertSameStableFile(left: WinStat, right: WinStat): void {
  if (digest(left) !== digest(right)) throw unsafe();
}

function assertExpectedDevice(value: WinStat, expectedDevice: string | undefined): void {
  if (expectedDevice === undefined || value.dev.toString() !== expectedDevice) throw unsafe();
}

function toIdentity(value: WinStat): CoordinationIdentity {
  return { kind: 'win32', dev: value.dev.toString(), ino: value.ino.toString() };
}

function digest(value: WinStat): string {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}:${value.nlink}:${value.kind}`;
}

function lstat(
  path: string,
  dependencies: Win32CoordinationFilesystemDependencies,
): WinStat | undefined {
  try { return fromStat(dependencies.lstat(path)); } catch (error) {
    if (code(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function stat(fd: number, dependencies: Win32CoordinationFilesystemDependencies): WinStat {
  return fromStat(dependencies.fstat(fd));
}

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

function readBounded(
  fd: number,
  size: number,
  dependencies: Win32CoordinationFilesystemDependencies,
): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = dependencies.read(fd, bytes, offset, size - offset, offset);
    if (count === 0) throw unsafe();
    offset += count;
  }
  return bytes;
}

const builtinFilesystemDependencies: Win32CoordinationFilesystemDependencies = {
  close: closeSync,
  fstat: (fd) => fstatSync(fd, { bigint: true }),
  fsync: fsyncSync,
  link: linkSync,
  lstat: (path) => lstatSync(path, { bigint: true }),
  mkdir: (path) => mkdirSync(path),
  open: openSync,
  read: readSync,
  readdir: readdirSync,
  realpath: realpathSync,
  rename: renameSync,
  unlink: unlinkSync,
  write: (fd, bytes) => writeFileSync(fd, bytes),
};

export const win32CoordinationFilesystemPolicy = createWin32CoordinationFilesystemPolicy();

function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code : undefined;
}

function unsafe(): CoordinationFilesystemUnsafeError {
  return new CoordinationFilesystemUnsafeError();
}
