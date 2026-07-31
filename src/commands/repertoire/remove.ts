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
import { findScopeReferences, type ScanConfig } from '../../features/repertoire/remove.js';
import { confirm } from '../../shared/prompt/index.js';
import { info, success } from '../../shared/ui/index.js';

const PRIVATE_DIRECTORY_MODE = 0o700;

type RepertoireMutationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type PackageIdentity = {
  dev: number;
  ino: number;
  realpath: string;
};

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

  const lease = await acquireRepertoireCoordinationLease({
    globalConfigDir: getGlobalConfigDir(),
    mode: 'write',
    ...(mutationOptions.signal === undefined ? {} : { signal: mutationOptions.signal }),
    ...(mutationOptions.timeoutMs === undefined ? {} : { timeoutMs: mutationOptions.timeoutMs }),
  });
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

    removeViaQuarantine(packageDir, initialIdentity);
    removeOwnerDirectoryOnlyWhenExactlyEmpty(dirname(packageDir));
  } finally {
    await lease.release();
  }

  success(`${scope} を削除しました`);
}

function parseScope(scope: string): { owner: string; repo: string } {
  if (!scope.startsWith('@')) {
    throw new Error(`Invalid scope: "${scope}". Expected @{owner}/{repo}`);
  }
  const withoutAt = scope.slice(1);
  const slashIdx = withoutAt.indexOf('/');
  if (slashIdx < 0) {
    throw new Error(`Invalid scope: "${scope}". Expected @{owner}/{repo}`);
  }
  const owner = withoutAt.slice(0, slashIdx);
  const repo = withoutAt.slice(slashIdx + 1);
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
  return { dev: stat.dev, ino: stat.ino, realpath: realPackageDir };
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

function removeViaQuarantine(packageDir: string, expected: PackageIdentity): void {
  const nonce = randomBytes(32).toString('hex');
  const quarantineDir = join(dirname(packageDir), `.remove-${nonce}`);
  mkdirSync(quarantineDir, { mode: PRIVATE_DIRECTORY_MODE });
  const quarantinedPackage = join(quarantineDir, 'package.quarantined');

  // rename is the deletion linearization point. Building a fresh O_EXCL-style
  // container first avoids overwriting a prior quarantine on nonce collision.
  renameSync(packageDir, quarantinedPackage);
  const moved = lstatSync(quarantinedPackage);
  if (
    !moved.isDirectory()
    || moved.isSymbolicLink()
    || moved.dev !== expected.dev
    || moved.ino !== expected.ino
  ) {
    throw new Error('Quarantined package identity cannot be proven safe');
  }
  rmSync(quarantineDir, { recursive: true, force: true });
}

function removeOwnerDirectoryOnlyWhenExactlyEmpty(ownerDir: string): void {
  if (!existsSync(ownerDir)) return;
  // Non-recursive rmdir is intentional: an unknown file appearing after the
  // exact-empty check must make removal fail rather than be recursively lost.
  if (readdirSync(ownerDir).length === 0) rmdirSync(ownerDir);
}

function referenceFingerprint(refs: Array<{ filePath: string }>): string {
  return refs.map((ref) => ref.filePath).sort().join('\0');
}

function sameIdentity(left: PackageIdentity, right: PackageIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.realpath === right.realpath;
}

function isPathInsideDirectory(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}
