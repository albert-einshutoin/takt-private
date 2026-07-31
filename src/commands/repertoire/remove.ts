/**
 * takt repertoire remove — remove an installed repertoire package.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { validateScopeOwner, validateScopeRepo } from 'faceted-prompting';
import {
  getGlobalConfigDir,
  getGlobalProviderOptionsDir,
  getGlobalWorkflowsDir,
  getProjectProviderOptionsDir,
  getProjectWorkflowsDir,
  getRepertoireDir,
  getRepertoirePackageDir,
} from '../../infra/config/paths.js';
import { getWorkflowCategoriesPath } from '../../infra/config/global/index.js';
import { acquireRepertoireCoordinationLease } from '../../features/repertoire/coordination-lease.js';
import {
  captureDirectoryTreeProof,
  sameTreeProof,
  type TreeProof,
} from '../../features/repertoire/filesystem-proof.js';
import { findScopeReferences, type ScanConfig, type ScopeReference } from '../../features/repertoire/remove.js';
import { confirm } from '../../shared/prompt/index.js';
import { info, success } from '../../shared/ui/index.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeStringStartsWithMethod = String.prototype.startsWith;
const safeStringIndexOfMethod = String.prototype.indexOf;
const safeStringSliceMethod = String.prototype.slice;
const safeArraySortMethod = Array.prototype.sort;
const safeArrayJoinMethod = Array.prototype.join;
const safeBufferToStringMethod = Buffer.prototype.toString;
const safeStringStartsWith = (value: string, search: string): boolean => (
  safeReflectApply(safeStringStartsWithMethod, value, [search]) as boolean
);
const safeStringIndexOf = (value: string, search: string): number => (
  safeReflectApply(safeStringIndexOfMethod, value, [search]) as number
);
const safeStringSlice = (value: string, start: number, end?: number): string => (
  safeReflectApply(safeStringSliceMethod, value, end === undefined ? [start] : [start, end]) as string
);
const safeArraySort = (values: string[]): string[] => (
  safeReflectApply(safeArraySortMethod, values, []) as string[]
);
const safeArrayJoin = (values: string[], separator: string): string => (
  safeReflectApply(safeArrayJoinMethod, values, [separator]) as string
);
const safeBufferToString = (value: Buffer, encoding: BufferEncoding): string => (
  safeReflectApply(safeBufferToStringMethod, value, [encoding]) as string
);

type RepertoireMutationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test-only observation after the first synchronous lease attempt. */
  onLeaseAttempted?: () => void;
};

type PackageIdentity = TreeProof;

export async function repertoireRemoveCommand(
  scope: string,
  mutationOptions: RepertoireMutationOptions = {},
): Promise<void> {
  const { owner, repo } = parseScope(scope);
  const repertoireDir = getRepertoireDir();
  const packageDir = getRepertoirePackageDir(owner, repo);

  if (!existsSync(packageDir)) throw new Error(`Package not found: ${scope}`);
  const initialIdentity = capturePackageIdentity(packageDir, repertoireDir, scope);
  const scanConfig = createReferenceScanConfig();
  const refs = findScopeReferences(scope, scanConfig);
  reportReferences(scope, refs);

  const confirmed = await confirm(`${scope} を削除しますか？`, false);
  if (!confirmed) {
    info('キャンセルしました');
    return;
  }

  const leasePromise = acquireRepertoireCoordinationLease({
    globalConfigDir: getGlobalConfigDir(),
    mode: 'write',
    ...(mutationOptions.signal === undefined ? {} : { signal: mutationOptions.signal }),
    ...(mutationOptions.timeoutMs === undefined ? {} : { timeoutMs: mutationOptions.timeoutMs }),
  });
  mutationOptions.onLeaseAttempted?.();
  const lease = await leasePromise;
  try {
    if (!existsSync(packageDir)) {
      throw new Error('Package state changed while waiting for coordination lease');
    }
    const freshIdentity = capturePackageIdentity(packageDir, repertoireDir, scope);
    if (!sameIdentity(initialIdentity, freshIdentity)) {
      throw new Error('Package state changed while waiting for coordination lease');
    }

    const freshRefs = findScopeReferences(scope, scanConfig);
    if (referenceFingerprint(refs) !== referenceFingerprint(freshRefs)) {
      throw new Error('Package references changed while waiting for coordination lease');
    }

    const beforeRename = capturePackageIdentity(packageDir, repertoireDir, scope);
    if (!sameTreeProof(freshIdentity, beforeRename)) {
      throw new Error('Package state changed before quarantine');
    }
    removeViaQuarantine(packageDir, repertoireDir, beforeRename);
    removeOwnerDirectoryOnlyWhenExactlyEmpty(dirname(packageDir));
  } finally {
    await lease.release();
  }

  success(`${scope} を削除しました`);
}

function parseScope(scope: string): { owner: string; repo: string } {
  if (!safeStringStartsWith(scope, '@')) {
    throw new Error(`Invalid scope: "${scope}". Expected @{owner}/{repo}`);
  }
  const withoutAt = safeStringSlice(scope, 1);
  const slashIdx = safeStringIndexOf(withoutAt, '/');
  if (slashIdx < 0) {
    throw new Error(`Invalid scope: "${scope}". Expected @{owner}/{repo}`);
  }
  const owner = safeStringSlice(withoutAt, 0, slashIdx);
  const repo = safeStringSlice(withoutAt, slashIdx + 1);
  validateScopeOwner(owner);
  validateScopeRepo(repo);
  return { owner, repo };
}

function capturePackageIdentity(
  packageDir: string,
  repertoireDir: string,
  scope: string,
): PackageIdentity {
  const realPackageDir = realpathSync(packageDir);
  const realRepertoireDir = realpathSync(repertoireDir);
  if (!isPathInsideDirectory(realPackageDir, realRepertoireDir)) {
    throw new Error(`Invalid scope: "${scope}". Package path escapes repertoire directory`);
  }
  const stat = lstatSync(packageDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Package state cannot be proven safe');
  }
  return captureDirectoryTreeProof(packageDir, repertoireDir);
}

function createReferenceScanConfig(): ScanConfig {
  const cwd = process.cwd();
  return {
    workflowDirs: [getGlobalWorkflowsDir(), getProjectWorkflowsDir(cwd)],
    providerOptionsDirs: [getGlobalProviderOptionsDir(), getProjectProviderOptionsDir(cwd)],
    categoriesFiles: [getWorkflowCategoriesPath(cwd)],
    // Removal authorization must never be based on a partial reference scan.
    failClosed: true,
  };
}

function reportReferences(scope: string, refs: Array<{ filePath: string }>): void {
  if (refs.length === 0) return;
  info(`⚠ 以下のファイルが ${scope} を参照しています:`);
  for (const ref of refs) info(`  ${ref.filePath}`);
}

function removeViaQuarantine(
  packageDir: string,
  repertoireDir: string,
  expected: PackageIdentity,
): void {
  const nonce = safeBufferToString(randomBytes(32), 'hex');
  const quarantineDir = join(dirname(packageDir), `.remove-${nonce}`);
  mkdirSync(quarantineDir, { mode: PRIVATE_DIRECTORY_MODE });
  const quarantinedPackage = join(quarantineDir, 'package.quarantined');

  // rename is the deletion linearization point. Building a fresh O_EXCL-style
  // container first avoids overwriting a prior quarantine on nonce collision.
  if (!sameTreeProof(expected, captureDirectoryTreeProof(packageDir, repertoireDir))) {
    throw recoveryRequired();
  }
  renameSync(packageDir, quarantinedPackage);
  const moved = captureDirectoryTreeProof(quarantinedPackage, repertoireDir);
  if (!sameTreeProof(expected, moved, true)) throw recoveryRequired();
  const quarantineEntries = readdirSync(quarantineDir);
  if (quarantineEntries.length !== 1 || quarantineEntries[0] !== 'package.quarantined') {
    throw recoveryRequired();
  }
  // Re-prove the complete moved tree immediately before recursive removal. A
  // same-UID foreign addition leaves quarantine intact for manual recovery.
  if (!sameTreeProof(moved, captureDirectoryTreeProof(quarantinedPackage, repertoireDir))) {
    throw recoveryRequired();
  }
  const finalEntries = readdirSync(quarantineDir);
  if (finalEntries.length !== 1 || finalEntries[0] !== 'package.quarantined') {
    throw recoveryRequired();
  }
  rmSync(quarantineDir, { recursive: true, force: true });
}

function removeOwnerDirectoryOnlyWhenExactlyEmpty(ownerDir: string): void {
  if (!existsSync(ownerDir)) return;
  // Non-recursive rmdir is intentional: an unknown file appearing after the
  // exact-empty check must make removal fail rather than be recursively lost.
  if (readdirSync(ownerDir).length === 0) rmdirSync(ownerDir);
}

function referenceFingerprint(refs: ScopeReference[]): string {
  const records: string[] = [];
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index]!;
    records[index] = `${ref.filePath}\0${ref.dev ?? '-'}\0${ref.ino ?? '-'}\0${ref.contentDigest ?? '-'}`;
  }
  safeArraySort(records);
  return safeArrayJoin(records, '\0');
}

function sameIdentity(left: PackageIdentity, right: PackageIdentity): boolean {
  return sameTreeProof(left, right);
}

function isPathInsideDirectory(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath === '' || (!safeStringStartsWith(relativePath, '..') && !isAbsolute(relativePath));
}

function recoveryRequired(): Error & { code: 'RECOVERY_REQUIRED' } {
  return Object.assign(new Error('Repertoire package recovery is required'), {
    code: 'RECOVERY_REQUIRED' as const,
  });
}
