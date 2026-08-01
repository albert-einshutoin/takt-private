import type { BigIntStats } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CoordinationFilesystemUnsafeError } from '../../features/repertoire/coordination-filesystem-types.js';
import {
  createWin32CoordinationFilesystemPolicy,
  type Win32CoordinationFilesystemDependencies,
} from '../../features/repertoire/coordination-win32-filesystem-policy.js';

const ROOT = 'C:\\Users\\alice\\.takt';
const DIRECTORY = `${ROOT}\\.takt-repertoire-coordination\\readers`;
const FILE = `${DIRECTORY}\\claim.lease.publishing`;

function stat(kind: 'directory' | 'file', ino: bigint): BigIntStats {
  return {
    dev: 1n,
    ino,
    size: kind === 'file' ? 4n : 0n,
    mtimeNs: 1n,
    ctimeNs: 2n,
    nlink: 1n,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false,
  } as unknown as BigIntStats;
}

function fixture() {
  const paths = new Map<string, BigIntStats>([[DIRECTORY, stat('directory', 4n)]]);
  const fdStats = new Map<number, BigIntStats>();
  let bytes = Buffer.alloc(0);
  const dependencies: Win32CoordinationFilesystemDependencies = {
    close: vi.fn(),
    fstat: (fd) => fdStats.get(fd)!,
    fsync: vi.fn(),
    link: vi.fn(),
    lstat: (path) => {
      const value = paths.get(path);
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    mkdir: vi.fn(),
    open: vi.fn(() => {
      if (paths.has(FILE)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const created = { ...stat('file', 5n), size: 0n } as BigIntStats;
      paths.set(FILE, created);
      fdStats.set(51, created);
      return 51;
    }),
    read: vi.fn((_fd, buffer, offset, length) => {
      const count = Math.min(length, bytes.length - offset);
      bytes.copy(buffer, offset, offset, offset + count);
      return count;
    }),
    readdir: vi.fn(() => []),
    realpath: (path) => path,
    rename: vi.fn(),
    unlink: vi.fn(),
    write: vi.fn((_fd, value) => {
      bytes = Buffer.from(value);
      const written = { ...stat('file', 5n), size: BigInt(bytes.length) } as BigIntStats;
      paths.set(FILE, written);
      fdStats.set(51, written);
    }),
  };
  const rootAuthority = {
    lexicalRoot: ROOT,
    canonicalRoot: ROOT,
    evidence: { kind: 'win32' as const, dev: '1', ino: '2' },
    assertUnchanged: vi.fn(),
    close: vi.fn(),
  };
  const policy = createWin32CoordinationFilesystemPolicy({
    dependencies,
    openRootAuthority: () => rootAuthority,
    openSentinel: vi.fn(() => ({ token: 'token', assertUnchanged: vi.fn(), close: vi.fn() })),
  });
  policy.preflightRoot(ROOT);
  return { dependencies, fdStats, paths, policy };
}

describe('production Windows coordination filesystem policy', () => {
  it('accepts only an exact canonical non-reparse directory on the root volume', () => {
    const value = fixture();
    expect(() => value.policy.assertDirectory(DIRECTORY)).not.toThrow();
  });

  it.each(['alias', 'symlink', 'cross-device'] as const)(
    'rejects an unsafe %s directory',
    (kind) => {
      const value = fixture();
      if (kind === 'alias') value.dependencies.realpath = () => `${DIRECTORY}-elsewhere`;
      if (kind === 'symlink') {
        const unsafe = { ...stat('directory', 4n), isSymbolicLink: () => true } as BigIntStats;
        value.paths.set(DIRECTORY, unsafe);
      }
      if (kind === 'cross-device') {
        value.paths.set(DIRECTORY, { ...stat('directory', 4n), dev: 2n } as BigIntStats);
      }

      expect(() => value.policy.assertDirectory(DIRECTORY))
        .toThrow(CoordinationFilesystemUnsafeError);
    },
  );

  it('creates and verifies a bounded exclusive file without POSIX mode operations', () => {
    const value = fixture();
    const evidence = value.policy.createStagedExclusiveFile(FILE, Buffer.from('data'));

    expect(evidence.identity).toEqual({ kind: 'win32', dev: '1', ino: '5' });
    expect(value.dependencies.open).toHaveBeenCalledWith(FILE, expect.any(Number));
    expect(value.dependencies.write).toHaveBeenCalledWith(51, Buffer.from('data'));
    expect(value.dependencies.close).toHaveBeenCalledWith(51);
    expect('fchmod' in value.dependencies).toBe(false);
  });

  it('rejects a hardlinked or replaced created file through the production policy', () => {
    const value = fixture();
    value.dependencies.write = vi.fn((_fd, written) => {
      const replacement = {
        ...stat('file', 99n),
        size: BigInt(written.length),
        nlink: 2n,
      } as BigIntStats;
      value.paths.set(FILE, replacement);
    });

    expect(() => value.policy.createStagedExclusiveFile(FILE, Buffer.from('data')))
      .toThrow(CoordinationFilesystemUnsafeError);
    expect(value.dependencies.close).toHaveBeenCalledWith(51);
  });
});
