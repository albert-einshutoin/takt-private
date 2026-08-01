import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createCoordinationIdentityPolicy,
  type CoordinationDirectoryAuthority,
  type CoordinationFileObservation,
  type CoordinationFilesystemPolicy,
  type CoordinationIdentity,
  type CoordinationStableFile,
} from './coordination-filesystem-types.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const TYPE_MASK = constants.S_IFMT;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const identityPolicy = createCoordinationIdentityPolicy('posix');
const getUid = typeof process.getuid === 'function' ? process.getuid.bind(process) : undefined;
// Coordination runs while authority-bearing callbacks execute. Capture mutable
// intrinsics at module initialization so callback code cannot replace them and
// influence filesystem validation or publication.
const freeze = Object.freeze.bind(Object);

export class CoordinationFilesystemChangedError extends Error {}
export class CoordinationFilesystemUnsafeError extends Error {}

export const posixCoordinationFilesystemPolicy: CoordinationFilesystemPolicy = freeze({
  ...identityPolicy,
  preflightRoot(path: string): CoordinationDirectoryAuthority {
    const before = lstatSync(path);
    assertRoot(before);
    const canonicalRoot = realpathSync(path);
    assertSameRoot(before, lstatSync(canonicalRoot));
    let fd: number | undefined;
    try {
      fd = openSync(canonicalRoot, DIRECTORY_FLAGS);
      assertSameRoot(before, fstatSync(fd));
      assertSameRoot(before, lstatSync(path));
      assertSameRoot(before, lstatSync(canonicalRoot));
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      throw error;
    }
    const retainedFd = fd;
    let closed = false;
    const evidence = freeze({
      kind: 'posix' as const,
      dev: before.dev,
      ino: before.ino,
      mode: before.mode,
      uid: before.uid,
    });
    return freeze({
      lexicalRoot: path,
      canonicalRoot,
      evidence,
      assertUnchanged(): void {
        if (closed) throw unsafe();
        assertSameRoot(evidence, fstatSync(retainedFd));
        assertSameRoot(evidence, lstatSync(path));
        assertSameRoot(evidence, lstatSync(canonicalRoot));
      },
      close(): void {
        if (closed) return;
        closed = true;
        closeSync(retainedFd);
      },
    });
  },
  ensurePrivateDirectory(path: string): void {
    try {
      mkdirSync(path, { mode: DIRECTORY_MODE });
      chmodDirectory(path);
      syncDirectory(dirname(path));
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
    assertPrivateDirectory(lstatSync(path));
  },
  createPrivateDirectoryExclusive(path: string): CoordinationIdentity {
    mkdirSync(path, { mode: DIRECTORY_MODE });
    chmodDirectory(path);
    const stat = lstatSync(path);
    assertPrivateDirectory(stat);
    return freeze({ kind: 'posix', dev: stat.dev, ino: stat.ino });
  },
  sealPrivateDirectory(path: string): void {
    chmodDirectory(path);
    assertPrivateDirectory(lstatSync(path));
  },
  assertDirectory(path: string): void {
    assertPrivateDirectory(lstatSync(path));
  },
  listStable(path: string) {
    const before = directoryDigest(path);
    const entries = readdirSync(path).sort();
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
      fd = openSync(path, CREATE_FLAGS, FILE_MODE);
      fchmodSync(fd, FILE_MODE);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      return readStableOpenedFile(fd, path, bytes.length);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
  readStableFile(path: string, maximumBytes: number): CoordinationStableFile {
    const before = lstatSync(path);
    let fd: number | undefined;
    try {
      fd = openSync(path, READ_FLAGS);
      const opened = fstatSync(fd);
      const after = lstatSync(path);
      assertPrivateFile(before, opened, after);
      if (opened.size <= 0 || opened.size > maximumBytes) throw unsafe();
      const bytes = readBounded(fd, opened.size);
      const final = fstatSync(fd);
      const pathAfter = lstatSync(path);
      assertPrivateFile(opened, final, pathAfter);
      if (!stableTimes(opened, final) || final.size !== bytes.length) throw unsafe();
      return stableFile(opened, bytes);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
  statPath(path: string, maximumBytes: number): CoordinationFileObservation | undefined {
    let stat: Stats;
    try { stat = lstatSync(path); } catch (error) {
      if (code(error) === 'ENOENT') return undefined;
      throw error;
    }
    const uid = currentUid();
    if (!isType(stat, constants.S_IFREG) || isType(stat, constants.S_IFLNK)
      || (stat.mode & 0o777) !== FILE_MODE || (uid !== null && stat.uid !== uid)
      || stat.size < 0 || stat.size > maximumBytes) throw unsafe();
    return observation(stat);
  },
  linkNoReplace: linkSync,
  unlinkOwned(path: string, identity: CoordinationIdentity): void {
    const current = observation(lstatSync(path));
    if (!identityPolicy.sameIdentity(current.identity, identity)) throw unsafe();
    unlinkSync(path);
  },
  renameOwned(source: string, destination: string, _identity: CoordinationIdentity): void {
    renameSync(source, destination);
  },
  syncDirectory,
  sameObject(left: CoordinationFileObservation, right: CoordinationFileObservation): boolean {
    return identityPolicy.sameIdentity(left.identity, right.identity);
  },
  sameStableFile(left: CoordinationFileObservation, right: CoordinationFileObservation): boolean {
    return identityPolicy.sameIdentity(left.identity, right.identity)
      && left.digest === right.digest;
  },
});

function readStableOpenedFile(fd: number, path: string, expectedLength: number): CoordinationStableFile {
  const opened = fstatSync(fd);
  const pathname = lstatSync(path);
  assertPrivateFile(opened, opened, pathname);
  if (opened.size !== expectedLength || opened.size <= 0) throw unsafe();
  const bytes = readBounded(fd, opened.size);
  if (bytes.length !== expectedLength) throw unsafe();
  return stableFile(opened, bytes);
}

function stableFile(stat: Stats, bytes: Buffer): CoordinationStableFile {
  const identity = { kind: 'posix' as const, dev: stat.dev, ino: stat.ino };
  const contentDigest = createHash('sha256').update(bytes).digest('hex');
  return freeze({ bytes, identity, digest: `${statDigest(stat)}:${contentDigest}` });
}

function observation(stat: Stats): CoordinationFileObservation {
  return freeze({
    identity: { kind: 'posix' as const, dev: stat.dev, ino: stat.ino },
    digest: statDigest(stat),
    kind: isType(stat, constants.S_IFREG) ? 'file' : isType(stat, constants.S_IFDIR) ? 'directory' : 'other',
    linkCount: stat.nlink,
    size: stat.size,
  });
}

function assertRoot(stat: Stats): void {
  const uid = currentUid();
  if (!isType(stat, constants.S_IFDIR) || isType(stat, constants.S_IFLNK)
    || (stat.mode & 0o022) !== 0 || (uid !== null && stat.uid !== uid)) throw unsafe();
}

function assertSameRoot(expected: { dev: number; ino: number; mode: number; uid: number }, actual: Stats): void {
  assertRoot(actual);
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.uid !== actual.uid
    || (expected.mode & 0o777) !== (actual.mode & 0o777)) throw unsafe();
}

function assertPrivateDirectory(stat: Stats): void {
  const uid = currentUid();
  if (!isType(stat, constants.S_IFDIR) || isType(stat, constants.S_IFLNK)
    || (stat.mode & 0o777) !== DIRECTORY_MODE || (uid !== null && stat.uid !== uid)) throw unsafe();
}

function assertPrivateFile(before: Stats, opened: Stats, after: Stats): void {
  const uid = currentUid();
  if (!isType(before, constants.S_IFREG) || !isType(opened, constants.S_IFREG)
    || !isType(after, constants.S_IFREG) || isType(before, constants.S_IFLNK)
    || isType(after, constants.S_IFLNK) || before.dev !== opened.dev || before.ino !== opened.ino
    || after.dev !== opened.dev || after.ino !== opened.ino || opened.nlink !== 1
    || (opened.mode & 0o777) !== FILE_MODE || (uid !== null && opened.uid !== uid)) throw unsafe();
}

function chmodDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, DIRECTORY_FLAGS); fchmodSync(fd, DIRECTORY_MODE); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, DIRECTORY_FLAGS); fsyncSync(fd); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function directoryDigest(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  const uid = currentUid();
  if (
    (stat.mode & BigInt(TYPE_MASK)) !== BigInt(constants.S_IFDIR)
    || (stat.mode & BigInt(TYPE_MASK)) === BigInt(constants.S_IFLNK)
    || (stat.mode & 0o777n) !== BigInt(DIRECTORY_MODE)
    || (uid !== null && stat.uid !== BigInt(uid))
  ) throw unsafe();
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.mtimeNs}:${stat.ctimeNs}`;
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

function stableTimes(left: Stats, right: Stats): boolean {
  return left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function statDigest(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.nlink}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function isType(stat: Stats, type: number): boolean { return (stat.mode & TYPE_MASK) === type; }
function currentUid(): number | null { return getUid?.() ?? null; }
function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code : undefined;
}
function unsafe(): CoordinationFilesystemUnsafeError { return new CoordinationFilesystemUnsafeError(); }
