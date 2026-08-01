import { describe, expect, it, vi } from 'vitest';
import {
  CoordinationWindowsSentinelError,
  CoordinationWindowsSentinelBusyError,
  CoordinationWindowsSentinelTimeoutError,
  openWindowsCoordinationSentinel,
  openWindowsCoordinationSentinelBounded,
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
  let publishingPath: string | undefined;
  const close = vi.fn();
  const rootAuthority = {
    canonicalRoot: ROOT,
    assertUnchanged: vi.fn(),
    close: vi.fn(),
    evidence: { dev: '1' },
  };
  const dependencies = {
    lstat: (path: string) => paths.get(path),
    list: () => [...paths.keys()]
      .filter((path) => path.startsWith(`${SUBTREE}\\`))
      .map((path) => path.slice(SUBTREE.length + 1)),
    openDirectory: vi.fn(() => 41),
    openSentinelExclusive: vi.fn((path: string) => {
      if (paths.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const created = { ...stat('file', 5n), size: 0n };
      publishingPath = path;
      paths.set(path, created);
      fdStats.set(52, created);
      return 52;
    }),
    openSentinelRead: vi.fn(() => 52),
    fstat: (fd: number) => fdStats.get(fd)!,
    writeSentinel: vi.fn((_fd: number, value: Buffer) => {
      bytes = Buffer.from(value);
      const written = { ...stat('file', 5n), size: BigInt(bytes.length) };
      paths.set(publishingPath ?? SENTINEL, written);
      fdStats.set(52, written);
    }),
    fsync: vi.fn(),
    readSentinel: vi.fn(() => Buffer.from(bytes)),
    close,
    link: vi.fn((source: string, destination: string) => {
      if (paths.has(destination)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const linked = { ...paths.get(source)!, nlink: 2n };
      paths.set(source, linked);
      paths.set(destination, linked);
      fdStats.set(52, linked);
    }),
    unlink: vi.fn((path: string) => {
      paths.delete(path);
      if (path === publishingPath && paths.has(SENTINEL)) {
        const published = { ...paths.get(SENTINEL)!, nlink: 1n };
        paths.set(SENTINEL, published);
        fdStats.set(52, published);
      }
    }),
    randomUUID: () => TOKEN,
  };
  return { bytes: () => bytes, close, dependencies, fdStats, paths, rootAuthority };
}

describe('Windows coordination root sentinel', () => {
  it('creates canonical bounded JSON with O_EXCL and persists no host identity', () => {
    const value = fixture();
    const authority = openWindowsCoordinationSentinel({
      rootAuthority: value.rootAuthority,
      dependencies: value.dependencies,
    });

    expect(value.dependencies.openSentinelExclusive).toHaveBeenCalledWith(
      `${SENTINEL}.${TOKEN}.publishing`,
    );
    expect(value.bytes().toString('utf8')).toBe(`{"version":1,"token":"${TOKEN}"}\n`);
    expect(value.bytes().toString('utf8')).not.toMatch(/dev|ino|mtime|ctime/i);
    expect(authority.token).toBe(TOKEN);
    expect(value.dependencies.openDirectory).not.toHaveBeenCalled();
  });

  it('opens and retains an existing valid sentinel without rewriting it', () => {
    const value = fixture(true);
    const before = value.bytes();
    const authority = openWindowsCoordinationSentinel({
      rootAuthority: value.rootAuthority,
      dependencies: value.dependencies,
    });

    expect(authority.token).toBe(TOKEN);
    expect(value.dependencies.openSentinelRead).toHaveBeenCalledWith(SENTINEL);
    expect(value.dependencies.writeSentinel).not.toHaveBeenCalled();
    expect(value.bytes()).toEqual(before);
  });

  it('does not reinterpret lease claim publication as sentinel staging', () => {
    const value = fixture(true);
    value.paths.set(`${SUBTREE}\\writer.intent.publishing`, stat('file', 9n));

    const authority = openWindowsCoordinationSentinel({
      rootAuthority: value.rootAuthority,
      dependencies: value.dependencies,
    });

    expect(authority.token).toBe(TOKEN);
  });

  it('blocks a concurrent first-start observer until complete publication', () => {
    const value = fixture();
    let observed: unknown;
    const publish = value.dependencies.link.getMockImplementation()!;
    value.dependencies.link.mockImplementation((source, destination) => {
      try {
        openWindowsCoordinationSentinel({
          rootAuthority: value.rootAuthority,
          dependencies: value.dependencies,
        });
      } catch (error) {
        observed = error;
      }
      publish(source, destination);
    });

    const authority = openWindowsCoordinationSentinel({
      rootAuthority: value.rootAuthority,
      dependencies: value.dependencies,
    });
    expect(observed).toBeInstanceOf(CoordinationWindowsSentinelBusyError);
    expect(authority.token).toBe(TOKEN);
  });

  it('times out behind a stale valid publishing file and never cleans it', async () => {
    const value = fixture(true);
    const staging = `${SENTINEL}.${TOKEN}.publishing`;
    value.paths.set(staging, value.paths.get(SENTINEL)!);
    value.paths.delete(SENTINEL);

    await expect(openWindowsCoordinationSentinelBounded({
      rootAuthority: value.rootAuthority,
      dependencies: value.dependencies,
      timeoutMs: 20,
    })).rejects.toBeInstanceOf(CoordinationWindowsSentinelTimeoutError);
    expect(value.paths.has(staging)).toBe(true);
    expect(value.dependencies.unlink).not.toHaveBeenCalled();
  });

  it('treats a crash-retained linked publication pair as bounded busy evidence', async () => {
    const value = fixture(true);
    const staging = `${SENTINEL}.${TOKEN}.publishing`;
    const linked = { ...value.paths.get(SENTINEL)!, nlink: 2n };
    value.paths.set(SENTINEL, linked);
    value.paths.set(staging, linked);
    value.fdStats.set(52, linked);

    await expect(openWindowsCoordinationSentinelBounded({
      rootAuthority: value.rootAuthority,
      dependencies: value.dependencies,
      timeoutMs: 20,
    })).rejects.toBeInstanceOf(CoordinationWindowsSentinelTimeoutError);
    expect(value.paths.has(staging)).toBe(true);
  });

  it('rejects stable malformed publishing bytes after bounded observation', async () => {
    const value = fixture(true);
    const staging = `${SENTINEL}.${TOKEN}.publishing`;
    value.paths.set(staging, { ...value.paths.get(SENTINEL)!, size: 1n });
    value.paths.delete(SENTINEL);
    value.dependencies.readSentinel.mockReturnValue(Buffer.from('{'));

    await expect(openWindowsCoordinationSentinelBounded({
      rootAuthority: value.rootAuthority,
      dependencies: value.dependencies,
      timeoutMs: 20,
    })).rejects.toBeInstanceOf(CoordinationWindowsSentinelError);
    expect(value.paths.has(staging)).toBe(true);
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
        dependencies: value.dependencies,
      })).toThrow(CoordinationWindowsSentinelError);
    },
  );

  it('fails closed when the retained sentinel pathname is replaced', () => {
    const value = fixture(true);
    const authority = openWindowsCoordinationSentinel({
      rootAuthority: value.rootAuthority,
      dependencies: value.dependencies,
    });
    value.paths.set(SENTINEL, { ...value.paths.get(SENTINEL)!, ino: 99n });

    expect(() => authority.assertUnchanged()).toThrow(CoordinationWindowsSentinelError);
  });

  it('closes sentinel, subtree, and root authorities exactly once', () => {
    const value = fixture(true);
    const authority = openWindowsCoordinationSentinel({
      rootAuthority: value.rootAuthority,
      dependencies: value.dependencies,
    });

    authority.close();
    authority.close();

    expect(value.close.mock.calls).toEqual([[52]]);
    expect(value.rootAuthority.close).toHaveBeenCalledOnce();
  });
});
