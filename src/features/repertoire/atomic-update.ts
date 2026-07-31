/**
 * Atomic package installation / replacement.
 *
 * Package bytes are completed in a sibling staging directory before a rename
 * publishes them. Existing `.tmp` or `.bak` paths are never guessed to be
 * ours: without durable ownership evidence, deleting them could remove data
 * created by another TaktDesk process or an interrupted operator recovery.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;

type DirectoryIdentity = {
  dev: number;
  ino: number;
};

export class AtomicUpdateRecoveryError extends Error {
  readonly code = 'RECOVERY_REQUIRED';

  constructor() {
    super('repertoire package recovery is required before mutation can continue');
    this.name = 'AtomicUpdateRecoveryError';
  }
}

export interface AtomicReplaceOptions {
  /** Absolute path to the package directory (final install location). */
  packageDir: string;
  /** Writes and validates the complete new package inside stagingDir. */
  install: (stagingDir: string) => Promise<void>;
}

/**
 * Proves that no ambiguous recovery artifacts exist.
 *
 * Despite the historical name, this function deliberately does not clean an
 * unknown artifact. Safe automated cleanup requires a future durable recovery
 * record that binds the artifact to the interrupted transaction.
 */
export function cleanupResiduals(packageDir: string): void {
  if (existsSync(`${packageDir}.tmp`) || existsSync(`${packageDir}.bak`)) {
    throw new AtomicUpdateRecoveryError();
  }
}

/**
 * Builds a complete package off to the side and atomically publishes it.
 *
 * The caller must hold the global repertoire writer lease for the entire call.
 * Identity checks still fail closed around cleanup and rollback so an
 * out-of-protocol same-UID replacement is not recursively deleted.
 */
export async function atomicReplace(options: AtomicReplaceOptions): Promise<void> {
  const { packageDir, install } = options;
  const stagingDir = `${packageDir}.tmp`;
  const backupDir = `${packageDir}.bak`;

  cleanupResiduals(packageDir);
  const originalIdentity = readOptionalDirectoryIdentity(packageDir);
  mkdirSync(dirname(packageDir), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  mkdirSync(stagingDir, { mode: PRIVATE_DIRECTORY_MODE });
  const stagingIdentity = readRequiredDirectoryIdentity(stagingDir);

  try {
    await install(stagingDir);
  } catch (error) {
    removeOwnedDirectory(stagingDir, stagingIdentity);
    throw error;
  }

  assertDirectoryIdentity(stagingDir, stagingIdentity);
  assertOptionalDirectoryIdentity(packageDir, originalIdentity);

  if (originalIdentity !== undefined) {
    renameSync(packageDir, backupDir);
    assertDirectoryIdentity(backupDir, originalIdentity);
  }

  try {
    renameSync(stagingDir, packageDir);
  } catch (error) {
    if (originalIdentity !== undefined) {
      assertDirectoryIdentity(backupDir, originalIdentity);
      renameSync(backupDir, packageDir);
    }
    throw error;
  }

  assertDirectoryIdentity(packageDir, stagingIdentity);
  if (originalIdentity !== undefined) {
    removeOwnedDirectory(backupDir, originalIdentity);
  }
}

function readOptionalDirectoryIdentity(path: string): DirectoryIdentity | undefined {
  if (!existsSync(path)) return undefined;
  return readRequiredDirectoryIdentity(path);
}

function readRequiredDirectoryIdentity(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AtomicUpdateRecoveryError();
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertOptionalDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity | undefined,
): void {
  const actual = readOptionalDirectoryIdentity(path);
  if (expected === undefined) {
    if (actual !== undefined) throw new AtomicUpdateRecoveryError();
    return;
  }
  if (actual === undefined || !sameIdentity(actual, expected)) {
    throw new AtomicUpdateRecoveryError();
  }
}

function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): void {
  const actual = readRequiredDirectoryIdentity(path);
  if (!sameIdentity(actual, expected)) throw new AtomicUpdateRecoveryError();
}

function removeOwnedDirectory(path: string, expected: DirectoryIdentity): void {
  assertDirectoryIdentity(path, expected);
  rmSync(path, { recursive: true, force: true });
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
