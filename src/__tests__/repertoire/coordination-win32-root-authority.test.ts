import { describe, expect, it, vi } from 'vitest';
import {
  CoordinationWindowsRootAuthorityError,
  createWindowsRootAuthorityOpener,
  type WindowsRootFileStat,
} from '../../features/repertoire/coordination-win32-root-authority.js';

const HOME = 'C:\\Users\\alice';
const ROOT = `${HOME}\\.takt`;

function directory(
  dev: bigint,
  ino: bigint,
  overrides: Partial<WindowsRootFileStat> = {},
): WindowsRootFileStat {
  return {
    dev,
    ino,
    mtimeNs: 10n,
    ctimeNs: 11n,
    kind: 'directory',
    symbolicLink: false,
    ...overrides,
  };
}

function fixture() {
  const stats = new Map<string, WindowsRootFileStat>([
    ['c:\\', directory(1n, 1n)],
    ['c:\\users', directory(1n, 2n)],
    ['c:\\users\\alice', directory(1n, 3n)],
    ['c:\\users\\alice\\.takt', directory(1n, 4n)],
  ]);
  const key = (path: string) => path.toLowerCase();
  const dependencies = {
    capturedHomeDirectory: HOME,
    lstat(path: string) {
      return stats.get(key(path));
    },
    realpath(path: string) {
      if (!stats.has(key(path))) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return path;
    },
  };
  return { dependencies, stats };
}

describe('Windows coordination root authority', () => {
  it('opens only the exact OS-captured profile .takt root with opaque bigint identity', () => {
    const { dependencies } = fixture();
    const open = createWindowsRootAuthorityOpener(dependencies);

    const authority = open(ROOT);

    expect(authority.lexicalRoot).toBe(ROOT);
    expect(authority.canonicalRoot).toBe(ROOT);
    expect(authority.evidence).toEqual({
      kind: 'win32',
      dev: '1',
      ino: '4',
    });
    expect(Object.values(authority.evidence).every((value) => typeof value === 'string')).toBe(true);
  });

  it.each([
    `${HOME}\\custom\\.takt`,
    `${HOME}\\.takt\\nested`,
    'D:\\Users\\alice\\.takt',
    '\\\\server\\share\\.takt',
    '\\\\?\\C:\\Users\\alice\\.takt',
    `${HOME}\\.takt:stream`,
    `${HOME}\\NUL\\.takt`,
    `${HOME}\\alice. \\.takt`,
    `${HOME}\\folder\\..\\.takt`,
    '.takt',
  ])('rejects a non-default or non-local root %s before opening it', (candidate) => {
    const { dependencies } = fixture();
    const open = createWindowsRootAuthorityOpener(dependencies);

    expect(() => open(candidate)).toThrow(CoordinationWindowsRootAuthorityError);
  });

  it('rejects a canonical alias and cross-volume target before opening it', () => {
    const { dependencies } = fixture();
    dependencies.realpath = (path: string) => path === ROOT ? 'D:\\redirected\\.takt' : path;
    const open = createWindowsRootAuthorityOpener(dependencies);

    expect(() => open(ROOT)).toThrow(CoordinationWindowsRootAuthorityError);
  });

  it.each([
    'C:\\Users',
    HOME,
    ROOT,
    `${ROOT}\\.takt-repertoire-coordination`,
    `${ROOT}\\.takt-repertoire-coordination\\readers`,
  ])('rejects a symlink or junction at %s before mutation', (path) => {
    const { dependencies, stats } = fixture();
    stats.set(path.toLowerCase(), directory(1n, 9n, { symbolicLink: true }));
    const open = createWindowsRootAuthorityOpener(dependencies);

    expect(() => open(ROOT)).toThrow(CoordinationWindowsRootAuthorityError);
  });

  it('fails closed when path and retained descriptor identity diverge', () => {
    const { dependencies, stats } = fixture();
    const open = createWindowsRootAuthorityOpener(dependencies);
    const authority = open(ROOT);
    stats.set(ROOT.toLowerCase(), directory(1n, 99n));

    expect(() => authority.assertUnchanged()).toThrow(CoordinationWindowsRootAuthorityError);
  });

  it('uses no Windows directory descriptor and terminalizes close once', () => {
    const { dependencies } = fixture();
    const authority = createWindowsRootAuthorityOpener(dependencies)(ROOT);

    authority.close();
    authority.close();

    expect(() => authority.assertUnchanged()).toThrow(CoordinationWindowsRootAuthorityError);
  });
});
