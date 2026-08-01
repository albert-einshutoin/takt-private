/** Durable package publication without recursive cleanup or automatic restore. */

import {
  Stats,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { captureDirectoryTreeProof, type TreeProof } from './filesystem-proof.js';
import {
  assertMaintenanceTransactionsReady,
  classifyMaintenanceTransactions,
  detachToMaintenance,
  RepertoireMaintenanceCapacityError,
  RepertoireMaintenanceError,
  type MaintenanceClassificationLimits,
} from './maintenance-transaction.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const safeStatsIsFileMethod = Stats.prototype.isFile;
const safeArraySortMethod = Array.prototype.sort;

export class AtomicUpdateRecoveryError extends Error {
  readonly code = 'RECOVERY_REQUIRED' as const;

  constructor() {
    super('Repertoire package recovery is required');
    this.name = 'AtomicUpdateRecoveryError';
  }
}

export interface AtomicReplaceOptions {
  globalConfigDir: string;
  packageDir: string;
  install: (reservedPackageDir: string) => Promise<void>;
  /** Test-only lower startup classification limits. */
  maintenanceLimits?: MaintenanceClassificationLimits;
}

/**
 * Reserves the final pathname before writing. An overwritten package is first
 * retained as a durable maintenance payload; failures retain partial bytes too.
 * No automatic rollback is attempted because a same-UID process can mutate
 * pathnames between Node filesystem calls.
 */
export async function atomicReplace(options: AtomicReplaceOptions): Promise<void> {
  const { globalConfigDir, packageDir, install } = options;
  try {
    if (options.maintenanceLimits === undefined) {
      assertMaintenanceTransactionsReady(globalConfigDir);
    } else {
      // The detach helper performs the same bounded classification for
      // overwrite paths; this branch is only a deterministic test boundary.
      const state = classifyMaintenanceTransactions(globalConfigDir, {
        limits: options.maintenanceLimits,
      });
      if (state.incomplete.length !== 0) throw recoveryRequired();
    }
    mkdirSync(dirname(packageDir), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const original = readOptionalTree(packageDir, globalConfigDir);
    if (original !== undefined) {
      detachToMaintenance({
        globalConfigDir,
        sourceDir: packageDir,
        containmentRoot: globalConfigDir,
        expected: original,
        kind: 'payload',
        ...(options.maintenanceLimits === undefined
          ? {} : { maintenanceLimits: options.maintenanceLimits }),
      });
    }

    // mkdir without recursive is the O_EXCL reservation for the active name.
    mkdirSync(packageDir, { mode: PRIVATE_DIRECTORY_MODE });
    try {
      await install(packageDir);
      syncInstalledTree(packageDir);
      captureDirectoryTreeProof(packageDir, globalConfigDir);
      writeCompletionWitness(packageDir);
      syncDirectory(packageDir);
      syncDirectory(dirname(packageDir));
    } catch {
      retainPartial(globalConfigDir, packageDir);
      throw recoveryRequired();
    }
  } catch (error) {
    if (error instanceof AtomicUpdateRecoveryError) throw error;
    if (error instanceof RepertoireMaintenanceCapacityError) throw error;
    if (error instanceof RepertoireMaintenanceError) throw recoveryRequired();
    throw recoveryRequired();
  }
}

function retainPartial(globalConfigDir: string, packageDir: string): void {
  let proof: TreeProof;
  try {
    proof = captureDirectoryTreeProof(packageDir, globalConfigDir);
  } catch {
    throw recoveryRequired();
  }
  detachToMaintenance({
    globalConfigDir,
    sourceDir: packageDir,
    containmentRoot: globalConfigDir,
    expected: proof,
    kind: 'partial',
  });
}

function readOptionalTree(path: string, containmentRoot: string): TreeProof | undefined {
  try {
    const stat = lstatSync(path);
    if (
      !safeReflectApply(safeStatsIsDirectoryMethod, stat, [])
      || safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, [])
    ) throw recoveryRequired();
    return captureDirectoryTreeProof(path, containmentRoot);
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (error instanceof AtomicUpdateRecoveryError) throw error;
    throw recoveryRequired();
  }
}

function writeCompletionWitness(packageDir: string): void {
  const pending = `${packageDir}/.takt-install-complete.pending`;
  const complete = `${packageDir}/.takt-install-complete`;
  writeFileSync(pending, 'complete\n', { flag: 'wx', mode: PRIVATE_FILE_MODE });
  const fd = openSync(pending, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(pending, complete);
}

function syncInstalledTree(directory: string): void {
  const entries = readdirSync(directory);
  safeReflectApply(safeArraySortMethod, entries, []);
  for (let index = 0; index < entries.length; index += 1) {
    const path = `${directory}/${entries[index]!}`;
    const stat = lstatSync(path);
    if (safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, [])) throw recoveryRequired();
    if (safeReflectApply(safeStatsIsDirectoryMethod, stat, [])) {
      syncInstalledTree(path);
    } else if (safeReflectApply(safeStatsIsFileMethod, stat, [])) {
      syncFile(path);
    } else {
      throw recoveryRequired();
    }
  }
  // Post-order fsync makes every nested directory entry durable before its
  // parent and before the completion witness is allowed to exist.
  syncDirectory(directory);
}

function syncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT';
}

function recoveryRequired(): AtomicUpdateRecoveryError {
  return new AtomicUpdateRecoveryError();
}
