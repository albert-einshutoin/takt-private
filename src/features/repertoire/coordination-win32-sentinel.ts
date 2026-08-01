import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';

const SENTINEL_FILENAME = '.root.identity';
const SENTINEL_VERSION = 1;
const MAX_SENTINEL_BYTES = 4_096;
const PUBLISHING_SUFFIX = '.publishing';
const PUBLISHING_PATTERN = /^\.root\.identity\.([0-9a-f-]{36})\.publishing$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const freeze = Object.freeze.bind(Object);

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
  readonly canonicalRoot: string;
  readonly evidence: { readonly dev: string };
  assertUnchanged(): void;
  close(): void;
};

export type WindowsSentinelDependencies = {
  lstat(path: string): WindowsSentinelFileStat | undefined;
  list(path: string): string[];
  openSentinelExclusive(path: string): number;
  openSentinelRead(path: string): number;
  fstat(fd: number): WindowsSentinelFileStat;
  writeSentinel(fd: number, bytes: Buffer): void;
  fsync(fd: number): void;
  readSentinel(fd: number, maximumBytes: number): Buffer;
  close(fd: number): void;
  link(source: string, destination: string): void;
  unlink(path: string): void;
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

export class CoordinationWindowsSentinelBusyError extends Error {
  readonly malformed: boolean;
  constructor(malformed = false) {
    super('Windows coordination sentinel publication is pending');
    this.name = 'CoordinationWindowsSentinelBusyError';
    this.malformed = malformed;
  }
}

export class CoordinationWindowsSentinelTimeoutError extends Error {
  constructor() {
    super('Windows coordination sentinel publication timed out');
    this.name = 'CoordinationWindowsSentinelTimeoutError';
  }
}

class CoordinationWindowsSentinelSnapshotChangedError extends Error {}

export async function openWindowsCoordinationSentinelBounded(options: {
  readonly rootAuthority: WindowsSentinelRootAuthority;
  readonly dependencies?: WindowsSentinelDependencies;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<WindowsCoordinationSentinelAuthority> {
  const deadline = Date.now() + options.timeoutMs;
  let observedMalformed = false;
  try {
    while (true) {
      if (options.signal?.aborted) throw failed();
      try {
        return openWindowsCoordinationSentinel(options);
      } catch (error) {
        if (!(error instanceof CoordinationWindowsSentinelBusyError)) throw error;
        observedMalformed ||= error.malformed;
        if (Date.now() >= deadline) {
          if (observedMalformed) throw failed();
          throw new CoordinationWindowsSentinelTimeoutError();
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } catch (error) {
    try { options.rootAuthority.close(); } catch { /* redacted below */ }
    throw error;
  }
}

export function openWindowsCoordinationSentinel(options: {
  readonly rootAuthority: WindowsSentinelRootAuthority;
  readonly dependencies?: WindowsSentinelDependencies;
}): WindowsCoordinationSentinelAuthority {
  const dependencies = options.dependencies ?? builtinDependencies;
  const coordinationRoot = win32.join(
    options.rootAuthority.canonicalRoot,
    '.takt-repertoire-coordination',
  );
  const sentinelPath = win32.join(coordinationRoot, SENTINEL_FILENAME);
  let sentinelFd: number | undefined;
  let ownPublishingPath: string | undefined;
  try {
    options.rootAuthority.assertUnchanged();
    const directoryBefore = requireDirectory(dependencies.lstat(coordinationRoot));
    if (directoryBefore.dev.toString() !== options.rootAuthority.evidence.dev) throw failed();
    const directoryAfter = requireDirectory(dependencies.lstat(coordinationRoot));
    if (directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino) {
      throw failed();
    }

    assertKnownPublishingEntries(dependencies, coordinationRoot);
    let canonicalBytes: Buffer;
    if (dependencies.lstat(sentinelPath) === undefined) {
      const token = dependencies.randomUUID();
      if (!UUID.test(token)) throw failed();
      canonicalBytes = Buffer.from(JSON.stringify({ version: SENTINEL_VERSION, token }) + '\n');
      if (canonicalBytes.length > MAX_SENTINEL_BYTES) throw failed();
      ownPublishingPath = `${sentinelPath}.${token}${PUBLISHING_SUFFIX}`;
      sentinelFd = dependencies.openSentinelExclusive(ownPublishingPath);
      dependencies.writeSentinel(sentinelFd, canonicalBytes);
      dependencies.fsync(sentinelFd);
      const stagedFd = requireSentinel(dependencies.fstat(sentinelFd));
      const stagedPath = requireSentinel(dependencies.lstat(ownPublishingPath));
      assertSameStableFile(stagedFd, stagedPath);
      const stagedBytes = dependencies.readSentinel(sentinelFd, MAX_SENTINEL_BYTES + 1);
      if (!stagedBytes.equals(canonicalBytes)) throw failed();
      try {
        dependencies.link(ownPublishingPath, sentinelPath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      dependencies.unlink(ownPublishingPath);
      ownPublishingPath = undefined;
      const stagedFdToClose = sentinelFd;
      // A failed close may still release the OS handle and allow its numeric
      // value to be recycled. Terminalize ownership before calling close so
      // outer cleanup can never target a different handle with the same value.
      sentinelFd = undefined;
      dependencies.close(stagedFdToClose);
      sentinelFd = openExistingSentinel(dependencies, sentinelPath);
    } else {
      sentinelFd = openExistingSentinel(dependencies, sentinelPath);
      canonicalBytes = dependencies.readSentinel(sentinelFd, MAX_SENTINEL_BYTES + 1);
    }

    const sentinelOpened = requireSentinel(dependencies.fstat(sentinelFd));
    const sentinelAfter = requireSentinel(dependencies.lstat(sentinelPath));
    assertSameStableFile(sentinelOpened, sentinelAfter);
    if (sentinelOpened.size !== BigInt(canonicalBytes.length)) throw failed();
    const record = parseCanonicalSentinel(canonicalBytes);
    options.rootAuthority.assertUnchanged();

    const retainedSentinelFd = sentinelFd;
    sentinelFd = undefined;
    let closed = false;
    return freeze({
      token: record.token,
      assertUnchanged(): void {
        try {
          if (closed) throw failed();
          options.rootAuthority.assertUnchanged();
          const directoryPath = requireDirectory(dependencies.lstat(coordinationRoot));
          if (
            directoryPath.dev !== directoryBefore.dev
            || directoryPath.ino !== directoryBefore.ino
          ) throw failed();

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
        for (const fd of [retainedSentinelFd]) {
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
  } catch (error) {
    if (error instanceof CoordinationWindowsSentinelBusyError) throw error;
    for (const fd of [sentinelFd]) {
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

function assertKnownPublishingEntries(
  dependencies: WindowsSentinelDependencies,
  coordinationRoot: string,
): void {
  let publishing = false;
  let malformed = false;
  try {
    for (const name of dependencies.list(coordinationRoot)) {
      // Lease claims also use a .publishing suffix in this directory. Sentinel
      // recovery owns only its reserved prefix and must not reinterpret valid
      // lease transitions as malformed sentinel state.
      if (!name.startsWith(`${SENTINEL_FILENAME}.`)) continue;
      if (!name.endsWith(PUBLISHING_SUFFIX)) throw failed();
      const match = PUBLISHING_PATTERN.exec(name);
      if (match === null || !UUID.test(match[1]!)) throw failed();
      const publishingPath = win32.join(coordinationRoot, name);
      const publishingStat = requirePublishingSnapshot(dependencies.lstat(publishingPath));
      if (publishingStat.nlink === 2n) {
        const published = requirePublishingSnapshot(
          dependencies.lstat(win32.join(coordinationRoot, SENTINEL_FILENAME)),
        );
        if (
          published.nlink !== 2n
          || published.dev !== publishingStat.dev
          || published.ino !== publishingStat.ino
        ) throw changed();
      }
      publishing = true;
      if (publishingStat.size > 0n) {
        let fd: number | undefined;
        try {
          try {
            fd = dependencies.openSentinelRead(publishingPath);
          } catch (error) {
            if (isMissing(error)) throw changed();
            throw error;
          }
          const opened = requirePublishing(dependencies.fstat(fd));
          const after = requirePublishingSnapshot(dependencies.lstat(publishingPath));
          if (!sameStableFile(opened, after)) throw changed();
          let stagedBytes: Buffer;
          try {
            stagedBytes = dependencies.readSentinel(fd, MAX_SENTINEL_BYTES + 1);
          } catch (error) {
            if (isMissing(error)) throw changed();
            throw error;
          }
          try {
            parseCanonicalSentinel(stagedBytes);
          } catch {
            malformed = true;
          }
        } finally {
          if (fd !== undefined) {
            const fdToClose = fd;
            fd = undefined;
            dependencies.close(fdToClose);
          }
        }
      } else {
        malformed = true;
      }
    }
  } catch (error) {
    if (error instanceof CoordinationWindowsSentinelSnapshotChangedError) {
      throw new CoordinationWindowsSentinelBusyError(malformed);
    }
    throw error;
  }
  if (publishing) throw new CoordinationWindowsSentinelBusyError(malformed);
}

function requirePublishingSnapshot(
  stat: WindowsSentinelFileStat | undefined,
): WindowsSentinelFileStat {
  if (stat === undefined) throw changed();
  return requirePublishing(stat);
}

function requirePublishing(
  stat: WindowsSentinelFileStat | undefined,
): WindowsSentinelFileStat {
  if (
    stat === undefined
    || stat.kind !== 'file'
    || stat.symbolicLink
    || (stat.nlink !== 1n && stat.nlink !== 2n)
    || stat.size < 0n
    || stat.size > BigInt(MAX_SENTINEL_BYTES)
  ) throw failed();
  return stat;
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

function sameStableFile(left: WindowsSentinelFileStat, right: WindowsSentinelFileStat): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.size === right.size
    && left.nlink === right.nlink;
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
  list: readdirSync,
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
  link: linkSync,
  unlink: unlinkSync,
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

function changed(): CoordinationWindowsSentinelSnapshotChangedError {
  return new CoordinationWindowsSentinelSnapshotChangedError();
}
