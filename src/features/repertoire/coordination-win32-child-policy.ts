import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';

const MAX_CHILD_BYTES = 4_096;

export type WindowsChildStat = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly nlink: bigint;
  readonly kind: 'directory' | 'file' | 'other';
  readonly symbolicLink: boolean;
};

export type WindowsChildDependencies = {
  realpath(path: string): string;
  lstat(path: string): WindowsChildStat | undefined;
  openExclusive(path: string): number;
  fstat(fd: number): WindowsChildStat;
  write(fd: number, bytes: Buffer): void;
  fsync(fd: number): void;
  read(fd: number, maximumBytes: number): Buffer;
  close(fd: number): void;
};

export class CoordinationWindowsChildPolicyError extends Error {
  constructor() {
    super('Windows coordination child policy unavailable');
    this.name = 'CoordinationWindowsChildPolicyError';
  }
}

export function createWindowsChildPolicy(dependencies: WindowsChildDependencies = builtinDependencies) {
  return Object.freeze({
    assertDirectory(path: string, expectedCanonicalPath: string, expectedDevice: string): void {
      try {
        if (dependencies.realpath(path).toLowerCase() !== expectedCanonicalPath.toLowerCase()) {
          throw failed();
        }
        const directory = requireKind(dependencies.lstat(path), 'directory');
        if (directory.dev.toString() !== expectedDevice) throw failed();
      } catch {
        throw failed();
      }
    },
    createExclusiveFile(
      path: string,
      bytes: Buffer,
      expectedDevice: string,
    ): { readonly dev: string; readonly ino: string } {
      let fd: number | undefined;
      try {
        if (bytes.length === 0 || bytes.length > MAX_CHILD_BYTES) throw failed();
        fd = dependencies.openExclusive(path);
        dependencies.write(fd, bytes);
        dependencies.fsync(fd);
        const opened = requireKind(dependencies.fstat(fd), 'file');
        const pathname = requireKind(dependencies.lstat(path), 'file');
        assertStableFile(opened, pathname);
        if (
          opened.dev.toString() !== expectedDevice
          || opened.size !== BigInt(bytes.length)
        ) throw failed();
        const retained = dependencies.read(fd, MAX_CHILD_BYTES + 1);
        if (!retained.equals(bytes)) throw failed();
        return Object.freeze({ dev: opened.dev.toString(), ino: opened.ino.toString() });
      } catch {
        throw failed();
      } finally {
        if (fd !== undefined) {
          try {
            dependencies.close(fd);
          } catch {
            // Creation has no successful result when descriptor closure fails.
          }
        }
      }
    },
  });
}

function requireKind(
  stat: WindowsChildStat | undefined,
  kind: 'directory' | 'file',
): WindowsChildStat {
  if (stat === undefined || stat.kind !== kind || stat.symbolicLink) throw failed();
  if (kind === 'file' && (stat.nlink !== 1n || stat.size > BigInt(MAX_CHILD_BYTES))) throw failed();
  return stat;
}

function assertStableFile(left: WindowsChildStat, right: WindowsChildStat): void {
  if (
    left.dev !== right.dev
    || left.ino !== right.ino
    || left.size !== right.size
    || left.mtimeNs !== right.mtimeNs
    || left.ctimeNs !== right.ctimeNs
    || left.nlink !== right.nlink
  ) throw failed();
}

const builtinDependencies: WindowsChildDependencies = {
  realpath: realpathSync,
  lstat(path): WindowsChildStat | undefined {
    try {
      return fromStat(lstatSync(path, { bigint: true }));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  },
  openExclusive: (path) => openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
  ),
  fstat: (fd) => fromStat(fstatSync(fd, { bigint: true })),
  write: (fd, bytes) => writeFileSync(fd, bytes),
  fsync: fsyncSync,
  read(fd, maximumBytes): Buffer {
    const buffer = Buffer.alloc(maximumBytes);
    let offset = 0;
    while (offset < maximumBytes) {
      const count = readSync(fd, buffer, offset, maximumBytes - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return buffer.subarray(0, offset);
  },
  close: closeSync,
};

function fromStat(stat: BigIntStats): WindowsChildStat {
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

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function failed(): CoordinationWindowsChildPolicyError {
  return new CoordinationWindowsChildPolicyError();
}
