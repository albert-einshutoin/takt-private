import { describe, expect, it, vi } from 'vitest';
import {
  CoordinationWindowsChildPolicyError,
  createWindowsChildPolicy,
  type WindowsChildStat,
} from '../../features/repertoire/coordination-win32-child-policy.js';

const DIRECTORY = 'C:\\Users\\alice\\.takt\\.takt-repertoire-coordination\\readers';
const FILE = `${DIRECTORY}\\claim.lease`;

function stat(kind: 'directory' | 'file', ino: bigint): WindowsChildStat {
  return { dev: 1n, ino, size: 4n, mtimeNs: 1n, ctimeNs: 2n, nlink: 1n, kind, symbolicLink: false };
}

function fixture() {
  const paths = new Map<string, WindowsChildStat>([[DIRECTORY, stat('directory', 4n)]]);
  const fdStats = new Map<number, WindowsChildStat>();
  let bytes = Buffer.alloc(0);
  const dependencies = {
    realpath: (path: string) => path,
    lstat: (path: string) => paths.get(path),
    openExclusive: vi.fn(() => {
      if (paths.has(FILE)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const created = { ...stat('file', 5n), size: 0n };
      paths.set(FILE, created);
      fdStats.set(51, created);
      return 51;
    }),
    fstat: (fd: number) => fdStats.get(fd)!,
    write: vi.fn((_fd: number, value: Buffer) => {
      bytes = Buffer.from(value);
      const written = { ...stat('file', 5n), size: BigInt(bytes.length) };
      paths.set(FILE, written);
      fdStats.set(51, written);
    }),
    fsync: vi.fn(),
    read: vi.fn(() => Buffer.from(bytes)),
    close: vi.fn(),
  };
  return { dependencies, paths };
}

describe('Windows coordination child policy', () => {
  it('accepts only the exact canonical non-reparse directory on the root volume', () => {
    const value = fixture();
    const policy = createWindowsChildPolicy(value.dependencies);

    expect(() => policy.assertDirectory(DIRECTORY, DIRECTORY, '1')).not.toThrow();
  });

  it.each(['alias', 'symlink', 'cross-device'] as const)('rejects an unsafe %s directory', (kind) => {
    const value = fixture();
    if (kind === 'alias') value.dependencies.realpath = () => `${DIRECTORY}-elsewhere`;
    if (kind === 'symlink') value.paths.set(DIRECTORY, { ...stat('directory', 4n), symbolicLink: true });
    if (kind === 'cross-device') value.paths.set(DIRECTORY, { ...stat('directory', 4n), dev: 2n });
    const policy = createWindowsChildPolicy(value.dependencies);

    expect(() => policy.assertDirectory(DIRECTORY, DIRECTORY, '1'))
      .toThrow(CoordinationWindowsChildPolicyError);
  });

  it('creates and verifies a bounded file exclusively without POSIX mode operations', () => {
    const value = fixture();
    const policy = createWindowsChildPolicy(value.dependencies);

    const evidence = policy.createExclusiveFile(FILE, Buffer.from('data'), '1');

    expect(evidence).toEqual({ dev: '1', ino: '5' });
    expect(value.dependencies.openExclusive).toHaveBeenCalledWith(FILE);
    expect(value.dependencies.write).toHaveBeenCalledWith(51, Buffer.from('data'));
    expect(value.dependencies.close).toHaveBeenCalledWith(51);
    expect('fchmod' in value.dependencies).toBe(false);
  });

  it('rejects a hardlinked or replaced created file', () => {
    const value = fixture();
    value.dependencies.write = vi.fn((_fd: number, bytes: Buffer) => {
      value.paths.set(FILE, { ...stat('file', 99n), size: BigInt(bytes.length), nlink: 2n });
    });
    const policy = createWindowsChildPolicy(value.dependencies);

    expect(() => policy.createExclusiveFile(FILE, Buffer.from('data'), '1'))
      .toThrow(CoordinationWindowsChildPolicyError);
    expect(value.dependencies.close).toHaveBeenCalledWith(51);
  });
});
