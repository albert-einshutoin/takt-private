import { describe, expect, it, vi } from 'vitest';
import {
  CoordinationWindowsSentinelError,
  openWindowsCoordinationSentinel,
  type WindowsSentinelFileStat,
} from '../../features/repertoire/coordination-win32-sentinel.js';

const ROOT = 'C:\\Users\\alice\\.takt';
const SUBTREE = `${ROOT}\\.takt-repertoire-coordination`;
const SENTINEL = `${SUBTREE}\\.root.identity`;
const TOKEN = ['00000000', '0000', '4000', '8000', '000000000000'].join('-');

function stat(kind: 'directory' | 'file', ino: bigint): WindowsSentinelFileStat {
  return {
    dev: 1n,
    ino,
    size: kind === 'file' ? 61n : 0n,
    mtimeNs: 10n,
    ctimeNs: 11n,
    nlink: 1n,
    kind,
    symbolicLink: false,
  };
}

function fixture(existing = false) {
  const canonical = Buffer.from(`{"version":1,"token":"${TOKEN}"}\n`);
  const paths = new Map<string, WindowsSentinelFileStat>([[SUBTREE, stat('directory', 4n)]]);
  if (existing) paths.set(SENTINEL, { ...stat('file', 5n), size: BigInt(canonical.length) });
  const fdStats = new Map<number, WindowsSentinelFileStat>([[41, stat('directory', 4n)]]);
  if (existing) fdStats.set(52, paths.get(SENTINEL)!);
  let bytes = existing ? canonical : Buffer.alloc(0);
  const close = vi.fn();
  const rootAuthority = { assertUnchanged: vi.fn(), close: vi.fn(), evidence: { dev: '1' } };
  const dependencies = {
    lstat: (path: string) => paths.get(path),
    openDirectory: vi.fn(() => 41),
    openSentinelExclusive: vi.fn(() => {
      if (paths.has(SENTINEL)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const created = { ...stat('file', 5n), size: 0n };
      paths.set(SENTINEL, created);
      fdStats.set(52, created);
      return 52;
    }),
    openSentinelRead: vi.fn(() => 52),
    fstat: (fd: number) => fdStats.get(fd)!,
    writeSentinel: vi.fn((_fd: number, value: Buffer) => {
      bytes = Buffer.from(value);
      const written = { ...stat('file', 5n), size: BigInt(bytes.length) };
      paths.set(SENTINEL, written);
      fdStats.set(52, written);
    }),
    fsync: vi.fn(),
    readSentinel: vi.fn(() => Buffer.from(bytes)),
    close,
    randomUUID: () => TOKEN,
  };
  return { bytes: () => bytes, close, dependencies, fdStats, paths, rootAuthority };
}

describe('Windows coordination root sentinel', () => {
  it('creates canonical bounded JSON with O_EXCL and persists no host identity', () => {
    const value = fixture();
    const authority = openWindowsCoordinationSentinel({
      rootAuthority: value.rootAuthority,
      coordinationRoot: SUBTREE,
      dependencies: value.dependencies,
    });

    expect(value.dependencies.openSentinelExclusive).toHaveBeenCalledWith(SENTINEL);
    expect(value.bytes().toString('utf8')).toBe(`{"version":1,"token":"${TOKEN}"}\n`);
    expect(value.bytes().toString('utf8')).not.toMatch(/dev|ino|mtime|ctime/i);
    expect(authority.token).toBe(TOKEN);
  });

  it('opens and retains an existing valid sentinel without rewriting it', () => {
    const value = fixture(true);
    const before = value.bytes();
    const authority = openWindowsCoordinationSentinel({
      rootAuthority: value.rootAuthority,
      coordinationRoot: SUBTREE,
      dependencies: value.dependencies,
    });

    expect(authority.token).toBe(TOKEN);
    expect(value.dependencies.openSentinelRead).toHaveBeenCalledWith(SENTINEL);
    expect(value.dependencies.writeSentinel).not.toHaveBeenCalled();
    expect(value.bytes()).toEqual(before);
  });

  it.each(['malformed', 'oversize', 'symlink', 'hardlink'] as const)(
    'rejects an unsafe existing %s sentinel',
    (kind) => {
      const value = fixture(true);
      if (kind === 'malformed') value.dependencies.readSentinel.mockReturnValue(Buffer.from('{}\n'));
      if (kind === 'oversize') value.paths.set(SENTINEL, { ...value.paths.get(SENTINEL)!, size: 4_097n });
      if (kind === 'symlink') value.paths.set(SENTINEL, { ...value.paths.get(SENTINEL)!, symbolicLink: true });
      if (kind === 'hardlink') value.paths.set(SENTINEL, { ...value.paths.get(SENTINEL)!, nlink: 2n });

      expect(() => openWindowsCoordinationSentinel({
        rootAuthority: value.rootAuthority,
        coordinationRoot: SUBTREE,
        dependencies: value.dependencies,
      })).toThrow(CoordinationWindowsSentinelError);
    },
  );

  it('fails closed when the retained sentinel pathname is replaced', () => {
    const value = fixture(true);
    const authority = openWindowsCoordinationSentinel({
      rootAuthority: value.rootAuthority,
      coordinationRoot: SUBTREE,
      dependencies: value.dependencies,
    });
    value.paths.set(SENTINEL, { ...value.paths.get(SENTINEL)!, ino: 99n });

    expect(() => authority.assertUnchanged()).toThrow(CoordinationWindowsSentinelError);
  });

  it('closes sentinel, subtree, and root authorities exactly once', () => {
    const value = fixture(true);
    const authority = openWindowsCoordinationSentinel({
      rootAuthority: value.rootAuthority,
      coordinationRoot: SUBTREE,
      dependencies: value.dependencies,
    });

    authority.close();
    authority.close();

    expect(value.close.mock.calls).toEqual([[52], [41]]);
    expect(value.rootAuthority.close).toHaveBeenCalledOnce();
  });
});
