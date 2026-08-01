import { describe, expect, it, vi } from 'vitest';
import {
  CoordinationRootAuthorityError,
  createCoordinationPlatformPolicy,
  type CoordinationRootAuthority,
} from '../../features/repertoire/coordination-platform-policy.js';

function authority(overrides: Partial<CoordinationRootAuthority> = {}): CoordinationRootAuthority {
  return {
    lexicalRoot: '/config',
    canonicalRoot: '/config',
    evidence: { kind: 'posix', dev: 1, ino: 2, mode: 0o40700, uid: 501 },
    assertUnchanged: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

describe('coordination platform policy', () => {
  it('delegates non-Windows roots to the unchanged POSIX authority', () => {
    const expected = authority();
    const openPosixRootAuthority = vi.fn(() => expected);
    const loadWindowsBridge = vi.fn();
    const policy = createCoordinationPlatformPolicy({
      platform: 'darwin',
      openPosixRootAuthority,
      loadWindowsBridge,
    });

    expect(policy.openRootAuthority('/config')).toBe(expected);
    expect(openPosixRootAuthority).toHaveBeenCalledWith('/config');
    expect(loadWindowsBridge).not.toHaveBeenCalled();
  });

  it('fails closed before POSIX fallback when the Windows bridge is unavailable', () => {
    const openPosixRootAuthority = vi.fn(() => authority());
    const policy = createCoordinationPlatformPolicy({
      platform: 'win32',
      openPosixRootAuthority,
      loadWindowsBridge: () => undefined,
    });

    expect(() => policy.openRootAuthority('C:\\config')).toThrow(CoordinationRootAuthorityError);
    expect(openPosixRootAuthority).not.toHaveBeenCalled();
  });

  it('closes once and redacts details when the Windows proof cannot be established', () => {
    const close = vi.fn();
    const root = authority({
      close,
      assertUnchanged: vi.fn(() => {
        throw new Error('native SID DACL path-secret');
      }),
    });
    const policy = createCoordinationPlatformPolicy({
      platform: 'win32',
      openPosixRootAuthority: vi.fn(),
      loadWindowsBridge: () => ({ openRootAuthority: () => root }),
    });

    let caught: unknown;
    try {
      policy.openRootAuthority('C:\\path-secret');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CoordinationRootAuthorityError);
    expect(String(caught)).not.toContain('SID');
    expect(String(caught)).not.toContain('path-secret');
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    authority({ canonicalRoot: '' }),
    authority({ evidence: { kind: 'posix', dev: 1, ino: Number.NaN, mode: 0, uid: 0 } }),
    { ...authority(), assertUnchanged: undefined },
  ])('rejects malformed Windows bridge authority without returning it', (untrusted) => {
    const policy = createCoordinationPlatformPolicy({
      platform: 'win32',
      openPosixRootAuthority: vi.fn(),
      loadWindowsBridge: () => ({
        openRootAuthority: () => untrusted as CoordinationRootAuthority,
      }),
    });

    expect(() => policy.openRootAuthority('C:\\config')).toThrow(CoordinationRootAuthorityError);
  });

  it('returns a verified Windows authority without touching the POSIX implementation', () => {
    const root = authority();
    const openPosixRootAuthority = vi.fn();
    const policy = createCoordinationPlatformPolicy({
      platform: 'win32',
      openPosixRootAuthority,
      loadWindowsBridge: () => ({ openRootAuthority: () => root }),
    });

    expect(policy.openRootAuthority('C:\\config')).toBe(root);
    expect(root.assertUnchanged).toHaveBeenCalledOnce();
    expect(openPosixRootAuthority).not.toHaveBeenCalled();
  });
});
