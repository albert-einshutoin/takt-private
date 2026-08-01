export type PosixCoordinationIdentity = {
  readonly kind: 'posix';
  readonly dev: number;
  readonly ino: number;
};

export type Win32CoordinationIdentity = {
  readonly kind: 'win32';
  readonly dev: string;
  readonly ino: string;
};

export type CoordinationIdentity = PosixCoordinationIdentity | Win32CoordinationIdentity;

export type PosixDirectoryEvidence = PosixCoordinationIdentity & {
  readonly mode: number;
  readonly uid: number;
};

export type Win32DirectoryEvidence = Win32CoordinationIdentity;

export type CoordinationDirectoryEvidence = PosixDirectoryEvidence | Win32DirectoryEvidence;

export type CoordinationDirectoryAuthority = {
  readonly canonicalRoot: string;
  readonly lexicalRoot: string;
  readonly evidence: CoordinationDirectoryEvidence;
  assertUnchanged(): void;
  close(): void;
};

export interface CoordinationIdentityPolicy {
  readonly kind: CoordinationIdentity['kind'];
  sameIdentity(left: CoordinationIdentity, right: CoordinationIdentity): boolean;
  identityDigest(identity: CoordinationIdentity): string;
}

/** Identity operations stay platform-owned so bigint evidence is never coerced. */
export function createCoordinationIdentityPolicy(
  kind: CoordinationIdentity['kind'],
): CoordinationIdentityPolicy {
  return Object.freeze({
    kind,
    sameIdentity(left: CoordinationIdentity, right: CoordinationIdentity): boolean {
      return left.kind === kind
        && right.kind === kind
        && left.dev === right.dev
        && left.ino === right.ino;
    },
    identityDigest(identity: CoordinationIdentity): string {
      if (identity.kind !== kind) throw new TypeError('coordination identity platform mismatch');
      return `${identity.kind}:${identity.dev}:${identity.ino}`;
    },
  });
}
