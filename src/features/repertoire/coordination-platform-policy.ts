import type {
  CoordinationDirectoryAuthority,
  CoordinationDirectoryEvidence,
} from './coordination-filesystem-types.js';

export type CoordinationRootEvidence = CoordinationDirectoryEvidence;

export type CoordinationRootAuthority = CoordinationDirectoryAuthority;

export type CoordinationWindowsRootAuthorityBridge = {
  openRootAuthority(path: string): CoordinationRootAuthority;
};

export type CoordinationPlatformPolicy = {
  openRootAuthority(path: string): CoordinationRootAuthority;
};

type CoordinationPlatformPolicyOptions = {
  readonly loadWindowsBridge: () => CoordinationWindowsRootAuthorityBridge | undefined;
  readonly openPosixRootAuthority: (path: string) => CoordinationRootAuthority;
  readonly platform: NodeJS.Platform;
};

/** Generic failure that deliberately carries no path, ACL, SID, or native error detail. */
export class CoordinationRootAuthorityError extends Error {
  constructor() {
    super('Coordination root authority unavailable');
    this.name = 'CoordinationRootAuthorityError';
  }
}

/**
 * Selects one OS authority implementation without weakening either contract.
 * Windows must never fall back to POSIX mode bits: they are advisory there and
 * cannot prove owner/DACL or reparse-point safety before filesystem mutation.
 */
export function createCoordinationPlatformPolicy(
  options: CoordinationPlatformPolicyOptions,
): CoordinationPlatformPolicy {
  const platform = options.platform;
  const openPosixRootAuthority = options.openPosixRootAuthority;
  const loadWindowsBridge = options.loadWindowsBridge;
  return Object.freeze({
    openRootAuthority(path: string): CoordinationRootAuthority {
      if (platform !== 'win32') return openPosixRootAuthority(path);

      let authority: CoordinationRootAuthority | undefined;
      try {
        const bridge = loadWindowsBridge();
        if (bridge === undefined || typeof bridge.openRootAuthority !== 'function') throw failed();
        authority = bridge.openRootAuthority(path);
        assertAuthorityShape(authority);
        // Proof is checked before the caller can create the coordination subtree.
        authority.assertUnchanged();
        return authority;
      } catch {
        try {
          authority?.close();
        } catch {
          // Close failure is still reported only as an untrusted authority.
        }
        throw failed();
      }
    },
  });
}

function assertAuthorityShape(authority: CoordinationRootAuthority): void {
  const evidence = authority?.evidence;
  if (
    typeof authority !== 'object'
    || authority === null
    || typeof authority.lexicalRoot !== 'string'
    || authority.lexicalRoot.length === 0
    || typeof authority.canonicalRoot !== 'string'
    || authority.canonicalRoot.length === 0
    || typeof authority.assertUnchanged !== 'function'
    || typeof authority.close !== 'function'
    || typeof evidence !== 'object'
    || evidence === null
    || (evidence.kind !== 'posix' && evidence.kind !== 'win32')
    || (evidence.kind === 'posix' && (
      !Number.isSafeInteger(evidence.dev)
      || !Number.isSafeInteger(evidence.ino)
      || !Number.isSafeInteger(evidence.mode)
      || !Number.isSafeInteger(evidence.uid)
    ))
    || (evidence.kind === 'win32' && (
      evidence.dev.length === 0 || evidence.ino.length === 0
    ))
  ) throw failed();
}

function failed(): CoordinationRootAuthorityError {
  return new CoordinationRootAuthorityError();
}
