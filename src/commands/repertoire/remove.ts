/**
 * takt repertoire remove — remove an installed repertoire package.
 */

import {
  existsSync,
  Stats,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
} from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
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
import { detachToMaintenance } from '../../features/repertoire/maintenance-transaction.js';
import { confirm } from '../../shared/prompt/index.js';
import { info, success } from '../../shared/ui/index.js';

const safeReflectApply = Reflect.apply.bind(Reflect);
const safeStringStartsWithMethod = String.prototype.startsWith;
const safeStringIndexOfMethod = String.prototype.indexOf;
const safeStringSliceMethod = String.prototype.slice;
const safeArraySortMethod = Array.prototype.sort;
const safeArrayJoinMethod = Array.prototype.join;
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
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
    detachToMaintenance({
      globalConfigDir: getGlobalConfigDir(),
      sourceDir: packageDir,
      containmentRoot: repertoireDir,
      expected: beforeRename,
      kind: 'payload',
    });
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
  if (
    !safeReflectApply(safeStatsIsDirectoryMethod, stat, [])
    || safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, [])
  ) {
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
