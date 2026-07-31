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
import {
  captureDirectoryTreeProof,
  sameTreeProof,
  type TreeProof,
} from './filesystem-proof.js';

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
  const parentDir = dirname(packageDir);

  cleanupResiduals(packageDir);
  const originalIdentity = readOptionalDirectoryIdentity(packageDir);
  mkdirSync(parentDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const parentIdentity = readRequiredDirectoryIdentity(parentDir);
  mkdirSync(stagingDir, { mode: PRIVATE_DIRECTORY_MODE });
  const stagingIdentity = readRequiredDirectoryIdentity(stagingDir);
  const originalTree = originalIdentity === undefined
    ? undefined
    : captureDirectoryTreeProof(packageDir, parentDir);

  try {
    await install(stagingDir);
  } catch (error) {
    removeOwnedDirectory(stagingDir, stagingIdentity);
    throw error;
  }

  assertDirectoryIdentity(parentDir, parentIdentity);
  assertDirectoryIdentity(stagingDir, stagingIdentity);
  const stagingTree = captureDirectoryTreeProof(stagingDir, parentDir);
  assertOptionalDirectoryIdentity(backupDir, undefined);
  assertOptionalDirectoryIdentity(packageDir, originalIdentity);
  assertOptionalTree(packageDir, parentDir, originalTree);

  if (originalIdentity !== undefined) {
    // POSIX rename may replace an existing destination. Re-prove both the
    // destination absence and parent identity at the last synchronous boundary.
    assertDirectoryIdentity(parentDir, parentIdentity);
    assertOptionalDirectoryIdentity(backupDir, undefined);
    assertDirectoryIdentity(packageDir, originalIdentity);
    assertOptionalTree(packageDir, parentDir, originalTree);
    renameOwnedDirectory(packageDir, backupDir);
    assertDirectoryIdentity(backupDir, originalIdentity);
    assertRelocatedTree(backupDir, parentDir, originalTree!);
  }

  try {
    assertDirectoryIdentity(parentDir, parentIdentity);
    assertDirectoryIdentity(stagingDir, stagingIdentity);
    assertRelocatedTree(stagingDir, parentDir, stagingTree);
    assertOptionalDirectoryIdentity(packageDir, undefined);
    renameOwnedDirectory(stagingDir, packageDir);
  } catch (error) {
    if (originalIdentity !== undefined) {
      assertDirectoryIdentity(parentDir, parentIdentity);
      assertDirectoryIdentity(backupDir, originalIdentity);
      assertRelocatedTree(backupDir, parentDir, originalTree!);
      assertOptionalDirectoryIdentity(packageDir, undefined);
      renameOwnedDirectory(backupDir, packageDir);
    }
    throw error;
  }

  assertDirectoryIdentity(parentDir, parentIdentity);
  assertDirectoryIdentity(packageDir, stagingIdentity);
  if (originalIdentity !== undefined) {
    assertRelocatedTree(backupDir, parentDir, originalTree!);
    removeOwnedDirectory(backupDir, originalIdentity);
  }
}

function readOptionalDirectoryIdentity(path: string): DirectoryIdentity | undefined {
  if (!existsSync(path)) return undefined;
  return readRequiredDirectoryIdentity(path);
}

function readRequiredDirectoryIdentity(path: string): DirectoryIdentity {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new AtomicUpdateRecoveryError();
  }
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
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    throw new AtomicUpdateRecoveryError();
  }
}

function renameOwnedDirectory(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch {
    throw new AtomicUpdateRecoveryError();
  }
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOptionalTree(
  path: string,
  parentDir: string,
  expected: TreeProof | undefined,
): void {
  if (expected === undefined) return;
  if (!sameTreeProof(expected, captureDirectoryTreeProof(path, parentDir))) {
    throw new AtomicUpdateRecoveryError();
  }
}

function assertRelocatedTree(path: string, parentDir: string, expected: TreeProof): void {
  if (!sameTreeProof(expected, captureDirectoryTreeProof(path, parentDir), true)) {
    throw new AtomicUpdateRecoveryError();
  }
}
