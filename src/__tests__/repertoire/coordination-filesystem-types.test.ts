import { describe, expect, it } from 'vitest';
import {
  createCoordinationIdentityPolicy,
  type CoordinationIdentity,
} from '../../features/repertoire/coordination-filesystem-types.js';

describe('coordination filesystem identity types', () => {
  it.each([
    ['posix', { kind: 'posix', dev: 1, ino: 2 }, { kind: 'posix', dev: 1, ino: 2 }],
    ['win32', { kind: 'win32', dev: '18446744073709551615', ino: '9007199254740993' }, {
      kind: 'win32', dev: '18446744073709551615', ino: '9007199254740993',
    }],
  ] as const)('compares and digests %s evidence without coercion', (kind, left, right) => {
    const policy = createCoordinationIdentityPolicy(kind);
    expect(policy.sameIdentity(left, right)).toBe(true);
    expect(policy.identityDigest(left)).toBe(`${kind}:${left.dev}:${left.ino}`);
  });

  it('rejects cross-platform identity comparison and digest use', () => {
    const posix = createCoordinationIdentityPolicy('posix');
    const windows: CoordinationIdentity = { kind: 'win32', dev: '1', ino: '2' };
    expect(posix.sameIdentity({ kind: 'posix', dev: 1, ino: 2 }, windows)).toBe(false);
    expect(() => posix.identityDigest(windows)).toThrow(TypeError);
  });
});
