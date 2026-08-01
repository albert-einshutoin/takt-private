import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';

const SENTINEL_FILENAME = '.root.identity';
const SENTINEL_VERSION = 1;
const MAX_SENTINEL_BYTES = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type WindowsSentinelFileStat = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly nlink: bigint;
  readonly kind: 'directory' | 'file' | 'other';
  readonly symbolicLink: boolean;
};

export type WindowsSentinelRootAuthority = {
  readonly evidence: { readonly dev: string };
  assertUnchanged(): void;
  close(): void;
};

export type WindowsSentinelDependencies = {
  lstat(path: string): WindowsSentinelFileStat | undefined;
  openDirectory(path: string): number;
  openSentinelExclusive(path: string): number;
  openSentinelRead(path: string): number;
  fstat(fd: number): WindowsSentinelFileStat;
  writeSentinel(fd: number, bytes: Buffer): void;
  fsync(fd: number): void;
  readSentinel(fd: number, maximumBytes: number): Buffer;
  close(fd: number): void;
  randomUUID(): string;
};

export type WindowsCoordinationSentinelAuthority = {
  readonly token: string;
  assertUnchanged(): void;
  close(): void;
};

export class CoordinationWindowsSentinelError extends Error {
  constructor() {
    super('Windows coordination sentinel unavailable');
    this.name = 'CoordinationWindowsSentinelError';
  }
}

export function openWindowsCoordinationSentinel(options: {
  readonly rootAuthority: WindowsSentinelRootAuthority;
  readonly coordinationRoot: string;
  readonly dependencies?: WindowsSentinelDependencies;
}): WindowsCoordinationSentinelAuthority {
  const dependencies = options.dependencies ?? builtinDependencies;
  const sentinelPath = win32.join(options.coordinationRoot, SENTINEL_FILENAME);
  let directoryFd: number | undefined;
  let sentinelFd: number | undefined;
  try {
    options.rootAuthority.assertUnchanged();
    const directoryBefore = requireDirectory(dependencies.lstat(options.coordinationRoot));
    if (directoryBefore.dev.toString() !== options.rootAuthority.evidence.dev) throw failed();
    directoryFd = dependencies.openDirectory(options.coordinationRoot);
    const directoryOpened = requireDirectory(dependencies.fstat(directoryFd));
    const directoryAfter = requireDirectory(dependencies.lstat(options.coordinationRoot));
    assertSameLiveObject(directoryBefore, directoryOpened);
    assertSameLiveObject(directoryBefore, directoryAfter);

    let created = false;
    try {
      sentinelFd = dependencies.openSentinelExclusive(sentinelPath);
      created = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      sentinelFd = openExistingSentinel(dependencies, sentinelPath);
    }

    let canonicalBytes: Buffer;
    if (created) {
      const token = dependencies.randomUUID();
      if (!UUID.test(token)) throw failed();
      canonicalBytes = Buffer.from(JSON.stringify({ version: SENTINEL_VERSION, token }) + '\n');
      if (canonicalBytes.length > MAX_SENTINEL_BYTES) throw failed();
      dependencies.writeSentinel(sentinelFd, canonicalBytes);
      dependencies.fsync(sentinelFd);
    } else {
      canonicalBytes = dependencies.readSentinel(sentinelFd, MAX_SENTINEL_BYTES + 1);
    }

    const sentinelOpened = requireSentinel(dependencies.fstat(sentinelFd));
    const sentinelAfter = requireSentinel(dependencies.lstat(sentinelPath));
    assertSameStableFile(sentinelOpened, sentinelAfter);
    if (sentinelOpened.size !== BigInt(canonicalBytes.length)) throw failed();
    const record = parseCanonicalSentinel(canonicalBytes);
    if (created) {
      const retainedBytes = dependencies.readSentinel(sentinelFd, MAX_SENTINEL_BYTES + 1);
      if (!retainedBytes.equals(canonicalBytes)) throw failed();
    }
    options.rootAuthority.assertUnchanged();

    const retainedDirectoryFd = directoryFd;
    const retainedSentinelFd = sentinelFd;
    directoryFd = undefined;
    sentinelFd = undefined;
    let closed = false;
    return Object.freeze({
      token: record.token,
      assertUnchanged(): void {
        try {
          if (closed) throw failed();
          options.rootAuthority.assertUnchanged();
          const directoryPath = requireDirectory(dependencies.lstat(options.coordinationRoot));
          const directoryHandle = requireDirectory(dependencies.fstat(retainedDirectoryFd));
          if (
            directoryPath.dev !== directoryBefore.dev
            || directoryPath.ino !== directoryBefore.ino
          ) throw failed();
          assertSameLiveObject(directoryPath, directoryHandle);

          const sentinelPathStat = requireSentinel(dependencies.lstat(sentinelPath));
          const sentinelHandle = requireSentinel(dependencies.fstat(retainedSentinelFd));
          assertSameStableFile(sentinelOpened, sentinelPathStat);
          assertSameStableFile(sentinelOpened, sentinelHandle);
          const currentBytes = dependencies.readSentinel(
            retainedSentinelFd,
            MAX_SENTINEL_BYTES + 1,
          );
          if (!currentBytes.equals(canonicalBytes)) throw failed();
          options.rootAuthority.assertUnchanged();
        } catch {
          throw failed();
        }
      },
      close(): void {
        if (closed) return;
        closed = true;
        let closeFailed = false;
        for (const fd of [retainedSentinelFd, retainedDirectoryFd]) {
          try {
            dependencies.close(fd);
          } catch {
            closeFailed = true;
          }
        }
        try {
          options.rootAuthority.close();
        } catch {
          closeFailed = true;
        }
        if (closeFailed) throw failed();
      },
    });
  } catch {
    for (const fd of [sentinelFd, directoryFd]) {
      if (fd === undefined) continue;
      try {
        dependencies.close(fd);
      } catch {
        // Preserve the single redacted failure surface.
      }
    }
    try {
      options.rootAuthority.close();
    } catch {
      // Preserve the single redacted failure surface.
    }
    throw failed();
  }
}

function openExistingSentinel(dependencies: WindowsSentinelDependencies, path: string): number {
  const before = requireSentinel(dependencies.lstat(path));
  let fd: number | undefined;
  try {
    fd = dependencies.openSentinelRead(path);
    const opened = requireSentinel(dependencies.fstat(fd));
    const after = requireSentinel(dependencies.lstat(path));
    assertSameStableFile(before, opened);
    assertSameStableFile(before, after);
    const retainedFd = fd;
    fd = undefined;
    return retainedFd;
  } finally {
    if (fd !== undefined) dependencies.close(fd);
  }
}

function parseCanonicalSentinel(bytes: Buffer): { version: 1; token: string } {
  if (bytes.length === 0 || bytes.length > MAX_SENTINEL_BYTES) throw failed();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw failed();
  }
  if (
    typeof value !== 'object'
    || value === null
    || Object.keys(value).join(',') !== 'version,token'
    || (value as { version?: unknown }).version !== SENTINEL_VERSION
    || typeof (value as { token?: unknown }).token !== 'string'
    || !UUID.test((value as { token: string }).token)
  ) throw failed();
  const record = value as { version: 1; token: string };
  const canonical = Buffer.from(JSON.stringify(record) + '\n');
  if (!canonical.equals(bytes)) throw failed();
  return record;
}

function requireDirectory(stat: WindowsSentinelFileStat | undefined): WindowsSentinelFileStat {
  if (stat === undefined || stat.kind !== 'directory' || stat.symbolicLink) throw failed();
  return stat;
}

function requireSentinel(stat: WindowsSentinelFileStat | undefined): WindowsSentinelFileStat {
  if (
    stat === undefined
    || stat.kind !== 'file'
    || stat.symbolicLink
    || stat.nlink !== 1n
    || stat.size <= 0n
    || stat.size > BigInt(MAX_SENTINEL_BYTES)
  ) throw failed();
  return stat;
}

function assertSameLiveObject(left: WindowsSentinelFileStat, right: WindowsSentinelFileStat): void {
  if (
    left.dev !== right.dev
    || left.ino !== right.ino
    || left.mtimeNs !== right.mtimeNs
    || left.ctimeNs !== right.ctimeNs
  ) throw failed();
}

function assertSameStableFile(left: WindowsSentinelFileStat, right: WindowsSentinelFileStat): void {
  assertSameLiveObject(left, right);
  if (left.size !== right.size || left.nlink !== right.nlink) throw failed();
}

const builtinDependencies: WindowsSentinelDependencies = {
  lstat(path): WindowsSentinelFileStat | undefined {
    try {
      return fromBigIntStat(lstatSync(path, { bigint: true }));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },
  openDirectory: (path) => openSync(path, constants.O_RDONLY),
  openSentinelExclusive: (path) => openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
  ),
  openSentinelRead: (path) => openSync(path, constants.O_RDONLY),
  fstat: (fd) => fromBigIntStat(fstatSync(fd, { bigint: true })),
  writeSentinel: (fd, bytes) => writeFileSync(fd, bytes),
  fsync: fsyncSync,
  readSentinel: readBounded,
  close: closeSync,
  randomUUID,
};

function readBounded(fd: number, maximumBytes: number): Buffer {
  const buffer = Buffer.alloc(maximumBytes);
  let offset = 0;
  while (offset < maximumBytes) {
    const count = readSync(fd, buffer, offset, maximumBytes - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}

function fromBigIntStat(stat: BigIntStats): WindowsSentinelFileStat {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    nlink: stat.nlink,
    kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    symbolicLink: stat.isSymbolicLink(),
  };
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function failed(): CoordinationWindowsSentinelError {
  return new CoordinationWindowsSentinelError();
}
