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

export type CoordinationFileObservation = {
  readonly identity: CoordinationIdentity;
  readonly digest: string;
  readonly kind: 'file' | 'directory' | 'other';
  readonly linkCount: number;
  readonly size: number;
};

export type CoordinationStableFile = {
  readonly bytes: Buffer;
  readonly identity: CoordinationIdentity;
  readonly digest: string;
};

export type CoordinationStableDirectory = {
  readonly entries: readonly string[];
  readonly digest: string;
  assertUnchanged(): void;
};

export interface CoordinationFilesystemPolicy extends CoordinationIdentityPolicy {
  preflightRoot(path: string): CoordinationDirectoryAuthority;
  sealRoot(authority: CoordinationDirectoryAuthority): void;
  ensurePrivateDirectory(path: string): void;
  createPrivateDirectoryExclusive(path: string): CoordinationIdentity;
  sealPrivateDirectory(path: string): void;
  assertDirectory(path: string): void;
  listStable(path: string): CoordinationStableDirectory;
  createStagedExclusiveFile(path: string, bytes: Buffer): CoordinationStableFile;
  readStableFile(path: string, maximumBytes: number): CoordinationStableFile;
  statPath(path: string, maximumBytes: number): CoordinationFileObservation | undefined;
  linkNoReplace(source: string, destination: string): void;
  unlinkOwned(path: string, identity: CoordinationIdentity): void;
  renameOwned(source: string, destination: string, identity: CoordinationIdentity): void;
  syncDirectory(path: string): void;
  sameObject(left: CoordinationFileObservation, right: CoordinationFileObservation): boolean;
  sameStableFile(left: CoordinationFileObservation, right: CoordinationFileObservation): boolean;
}

export class CoordinationFilesystemChangedError extends Error {}
export class CoordinationFilesystemUnsafeError extends Error {}
export class CoordinationFilesystemPendingError extends Error {
  readonly malformed: boolean;
  constructor(malformed = false) {
    super('coordination filesystem publication is pending');
    this.malformed = malformed;
  }
}

const freeze = Object.freeze.bind(Object);

/** Identity operations stay platform-owned so bigint evidence is never coerced. */
export function createCoordinationIdentityPolicy(
  kind: CoordinationIdentity['kind'],
): CoordinationIdentityPolicy {
  return freeze({
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
