/**
 * takt repertoire add — install a repertoire package from GitHub.
 *
 * Usage:
 *   takt repertoire add github:{owner}/{repo}@{ref}
 *   takt repertoire add github:{owner}/{repo}          (uses default branch)
 */

import {
  existsSync,
  Stats,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { stringify as stringifyYaml } from 'yaml';
import {
  getBuiltinProviderOptionsDir,
  getGlobalConfigDir,
  getGlobalProviderOptionsDir,
  getProjectProviderOptionsDir,
  getRepertoireDir,
  getRepertoirePackageDir,
} from '../../infra/config/paths.js';
import { resolveWorkflowConfigValues } from '../../infra/config/resolveWorkflowConfigValue.js';
import { parseGithubSpec } from '../../features/repertoire/github-spec.js';
import {
  parseTaktRepertoireConfig,
  validateTaktRepertoirePath,
  validateMinVersion,
  isVersionCompatible,
  checkPackageHasContentWithContext,
  validateRealpathInsideRoot,
  resolveRepertoireConfigPath,
} from '../../features/repertoire/takt-repertoire-config.js';
import { collectCopyTargets } from '../../features/repertoire/file-filter.js';
import { parseTarVerboseListing } from '../../features/repertoire/tar-parser.js';
import { resolveRef } from '../../features/repertoire/github-ref-resolver.js';
import { atomicReplace } from '../../features/repertoire/atomic-update.js';
import {
  normalizeRepertoireMutationError,
  RepertoireMutationError,
} from '../../features/repertoire/mutation-error.js';
import { acquireRepertoireCoordinationLease } from '../../features/repertoire/coordination-lease.js';
import {
  captureDirectoryTreeProof,
  captureNearestParentProof,
  captureRegularFileProof,
  readApprovedRegularFile,
  sameFileProof,
  sameParentProof,
  sameTreeProof,
  type FileProof,
  type ApprovedFile,
  type ParentProof,
  type TreeProof,
} from '../../features/repertoire/filesystem-proof.js';
import { generateLockFile, extractCommitSha } from '../../features/repertoire/lock-file.js';
import { TAKT_REPERTOIRE_MANIFEST_FILENAME, TAKT_REPERTOIRE_LOCK_FILENAME } from '../../features/repertoire/constants.js';
import {
  PACKAGE_PROVIDER_OPTIONS_DIR,
  summarizeFacetsByType,
  detectEditWorkflows,
  formatEditWorkflowWarnings,
} from '../../features/repertoire/pack-summary.js';
import { getScopedProviderOptionsCandidateKey } from '../../infra/config/loaders/providerOptionsLookupDirectories.js';
import { confirm } from '../../shared/prompt/index.js';
import { info, success } from '../../shared/ui/index.js';
import { createLogger, ensureCurrentTmpDirExists, getErrorMessage } from '../../shared/utils/index.js';

const require = createRequire(import.meta.url);
const { version: TAKT_VERSION } = require('../../../package.json') as { version: string };

const GH_API_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
const APPROVED_SOURCE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeStringStartsWithMethod = String.prototype.startsWith;
const safeStringIncludesMethod = String.prototype.includes;
const safeStringSplitMethod = String.prototype.split;
const safeStringTrimMethod = String.prototype.trim;
const safeStringReplaceMethod = String.prototype.replace;
const safeArrayJoinMethod = Array.prototype.join;
const safeArrayPushMethod = Array.prototype.push;
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const safeStringStartsWith = (value: string, search: string): boolean => (
  safeReflectApply(safeStringStartsWithMethod, value, [search]) as boolean
);
const safeStringIncludes = (value: string, search: string): boolean => (
  safeReflectApply(safeStringIncludesMethod, value, [search]) as boolean
);
const safeStringSplit = (value: string, separator: string): string[] => (
  safeReflectApply(safeStringSplitMethod, value, [separator]) as string[]
);
const safeStringTrim = (value: string): string => (
  safeReflectApply(safeStringTrimMethod, value, []) as string
);
const safeStringReplace = (value: string, search: string | RegExp, replacement: string): string => (
  safeReflectApply(safeStringReplaceMethod, value, [search, replacement]) as string
);
const safeArrayJoin = (values: string[], separator: string): string => (
  safeReflectApply(safeArrayJoinMethod, values, [separator]) as string
);
const safeArrayPush = <T>(values: T[], value: T): void => {
  safeReflectApply(safeArrayPushMethod, values, [value]);
};

const log = createLogger('repertoire-add');

type RepertoireMutationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test-only observation after the first synchronous lease attempt. */
  onLeaseAttempted?: () => void;
};

type PackageState =
  | { exists: false; parent: ParentProof }
  | { exists: true; tree: TreeProof };

export async function repertoireAddCommand(
  spec: string,
  mutationOptions: RepertoireMutationOptions = {},
): Promise<void> {
  const { owner, repo, ref: specRef } = parseGithubSpec(spec);

  try {
    execFileSync('gh', ['--version'], {
      stdio: 'pipe',
      maxBuffer: GH_API_MAX_BUFFER_BYTES,
    });
  } catch {
    throw new Error(
      '`gh` CLI がインストールされていません。https://cli.github.com からインストールしてください',
    );
  }

  const execGh = (args: string[]) => execFileSync('gh', args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    maxBuffer: GH_API_MAX_BUFFER_BYTES,
  });

  const execGhBinary = (args: string[]) => execFileSync('gh', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: GH_API_MAX_BUFFER_BYTES,
  });

  const ref = resolveRef(specRef, owner, repo, execGh);

  let tmpBase: string;
  try {
    tmpBase = mkdtempSync(join(ensureCurrentTmpDirExists(), 'takt-import-'));
  } catch {
    throw new RepertoireMutationError();
  }
  const tmpTarPath = join(tmpBase, 'archive.tar.gz');
  const tmpExtractDir = join(tmpBase, 'extract');
  const tmpIncludeFile = join(tmpBase, 'include.txt');

  let primaryFailure: unknown;
  try {
    mkdirSync(tmpExtractDir, { recursive: true });

    info(`📦 ${owner}/${repo} @${ref} をダウンロード中...`);
    const tarballBuffer = execGhBinary([
      'api',
      `/repos/${owner}/${repo}/tarball/${ref}`,
    ]);
    writeFileSync(tmpTarPath, tarballBuffer);

    const tarVerboseList = execFileSync('tar', ['tvzf', tmpTarPath], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    const verboseLines: string[] = [];
    const rawVerboseLines = safeStringSplit(tarVerboseList, '\n');
    for (let index = 0; index < rawVerboseLines.length; index += 1) {
      if (safeStringTrim(rawVerboseLines[index]!) !== '') {
        safeArrayPush(verboseLines, rawVerboseLines[index]!);
      }
    }
    const { firstDirEntry, includePaths } = parseTarVerboseListing(verboseLines);

    const commitSha = extractCommitSha(firstDirEntry);

    if (includePaths.length > 0) {
      writeFileSync(tmpIncludeFile, safeArrayJoin(includePaths, '\n') + '\n');
      execFileSync(
        'tar',
        ['xzf', tmpTarPath, '-C', tmpExtractDir, '--strip-components=1', '-T', tmpIncludeFile],
        { stdio: 'pipe' },
      );
    }

    const packConfigPath = resolveRepertoireConfigPath(tmpExtractDir);

    const packConfigYaml = readFileSync(packConfigPath, 'utf-8');
    const config = parseTaktRepertoireConfig(packConfigYaml);
    validateTaktRepertoirePath(config.path);

    if (config.takt?.min_version) {
      validateMinVersion(config.takt.min_version);
      if (!isVersionCompatible(config.takt.min_version, TAKT_VERSION)) {
        throw new Error(
          `このパッケージは TAKT ${config.takt.min_version} 以降が必要です（現在: ${TAKT_VERSION}）`,
        );
      }
    }

    const packageRoot = config.path === '.' ? tmpExtractDir : join(tmpExtractDir, config.path);

    validateRealpathInsideRoot(packageRoot, tmpExtractDir);

    checkPackageHasContentWithContext(packageRoot, {
      manifestPath: packConfigPath,
      configuredPath: config.path,
    });

    const targets = collectCopyTargets(packageRoot);
    const facetFiles: typeof targets = [];
    const workflowFiles: typeof targets = [];
    const providerOptionsFiles: typeof targets = [];
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!;
      if (safeStringStartsWith(target.relativePath, 'facets/')) safeArrayPush(facetFiles, target);
      if (safeStringStartsWith(target.relativePath, 'workflows/')) safeArrayPush(workflowFiles, target);
      if (safeStringStartsWith(target.relativePath, 'provider-options/')) {
        safeArrayPush(providerOptionsFiles, target);
      }
    }

    const facetPaths: string[] = [];
    for (let index = 0; index < facetFiles.length; index += 1) {
      facetPaths[index] = facetFiles[index]!.relativePath;
    }
    const facetSummary = summarizeFacetsByType(facetPaths);

    const workflowYamls: Array<{ name: string; content: string; relativePath: string }> = [];
    for (let index = 0; index < workflowFiles.length; index += 1) {
      const workflowFile = workflowFiles[index]!;
      try {
        const content = readFileSync(workflowFile.absolutePath, 'utf-8');
        safeArrayPush(workflowYamls, {
          name: safeStringReplace(workflowFile.relativePath, /^workflows\//, ''),
          content,
          relativePath: workflowFile.relativePath,
        });
      } catch (err) {
        log.debug('Failed to parse workflow YAML for edit check', { path: workflowFile.absolutePath, error: getErrorMessage(err) });
      }
    }
    const providerOptionsYamls: Array<{ name: string; content: string; relativePath: string }> = [];
    const allProviderOptionsFiles: typeof providerOptionsFiles = [];
    for (let index = 0; index < providerOptionsFiles.length; index += 1) {
      allProviderOptionsFiles[index] = providerOptionsFiles[index]!;
    }
    for (let index = 0; index < workflowFiles.length; index += 1) {
      if (safeStringIncludes(workflowFiles[index]!.relativePath, '/provider-options/')) {
        safeArrayPush(allProviderOptionsFiles, workflowFiles[index]!);
      }
    }
    for (let index = 0; index < allProviderOptionsFiles.length; index += 1) {
      const providerOptionsFile = allProviderOptionsFiles[index]!;
      try {
        const content = readFileSync(providerOptionsFile.absolutePath, 'utf-8');
        safeArrayPush(providerOptionsYamls, {
          name: safeStringReplace(providerOptionsFile.relativePath, /^provider-options\//, ''),
          content,
          relativePath: providerOptionsFile.relativePath,
        });
      } catch (err) {
        log.debug('Failed to parse provider-options YAML for edit check', { path: providerOptionsFile.absolutePath, error: getErrorMessage(err) });
      }
    }
    const projectCwd = process.cwd();
    const { language } = resolveWorkflowConfigValues(projectCwd, ['language']);
    const repertoireDir = getRepertoireDir();
    const packageWorkflowDir = join(getRepertoirePackageDir(owner, repo), 'workflows');
    const editWorkflows = detectEditWorkflows(workflowYamls, providerOptionsYamls, {
      providerOptionsCandidateDirs: [
        getProjectProviderOptionsDir(projectCwd),
        getGlobalProviderOptionsDir(),
        getBuiltinProviderOptionsDir(language),
      ],
      providerOptionsScopedCandidateDirs: new Map([
        [getScopedProviderOptionsCandidateKey(owner, repo), [PACKAGE_PROVIDER_OPTIONS_DIR]],
      ]),
      context: {
        projectDir: projectCwd,
        lang: language,
        workflowDir: packageWorkflowDir,
        repertoireDir,
      },
    });

    info(`\n📦 ${owner}/${repo} @${ref}`);
    info(`   facets:  ${facetSummary}`);
    if (workflowFiles.length > 0) {
      const workflowNames: string[] = [];
      for (let index = 0; index < workflowFiles.length; index += 1) {
        workflowNames[index] = safeStringReplace(
          safeStringReplace(workflowFiles[index]!.relativePath, /^workflows\//, ''),
          /\.yaml$/,
          '',
        );
      }
      info(`   workflows:  ${workflowFiles.length} (${safeArrayJoin(workflowNames, ', ')})`);
    } else {
      info('   workflows:  0');
    }
    for (let index = 0; index < editWorkflows.length; index += 1) {
      const warnings = formatEditWorkflowWarnings(editWorkflows[index]!);
      for (let warningIndex = 0; warningIndex < warnings.length; warningIndex += 1) {
        info(warnings[warningIndex]!);
      }
    }
    info('');

    const sourceProofs = captureSourceProofs(packConfigPath, targets, tmpExtractDir);
    const confirmed = await confirm('インストールしますか？', false);
    if (!confirmed) {
      info('キャンセルしました');
      return;
    }

    const packageDir = getRepertoirePackageDir(owner, repo);
    const initialPackageState = capturePackageState(packageDir, repertoireDir);

    if (initialPackageState.exists) {
      info(`⚠ パッケージ @${owner}/${repo} は既にインストールされています`);
      const overwrite = await confirm(
        '上書きしますか？',
        false,
      );
      if (!overwrite) {
        info('キャンセルしました');
        return;
      }
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
      const freshPackageState = capturePackageState(packageDir, repertoireDir);
      if (!samePackageState(initialPackageState, freshPackageState)) {
        throw new Error('Package state changed while waiting for coordination lease');
      }
      const freshTargets = collectCopyTargets(packageRoot);
      if (!sameTargetSet(targets, freshTargets) || !sameSourceProofs(
        sourceProofs,
        captureSourceProofs(packConfigPath, freshTargets, tmpExtractDir),
      )) {
        throw new Error('Downloaded package source changed while waiting for coordination lease');
      }
      await atomicReplace({
        globalConfigDir: getGlobalConfigDir(),
        packageDir,
        install: async (stagingDir) => {
          for (let index = 0; index < targets.length; index += 1) {
            const target = targets[index]!;
            const approved = readApprovedRegularFile(target.absolutePath, tmpExtractDir);
            if (!sameFileProof(sourceProofs[index + 1]!.proof, approved.proof)) {
              throw new Error('Downloaded package source changed before copy');
            }
            const destFile = join(stagingDir, target.relativePath);
            mkdirSync(dirname(destFile), { recursive: true });
            writeFileSync(destFile, approved.bytes, { flag: 'wx', mode: 0o600 });
            assertPublishedBytes(approved.proof, captureRegularFileProof(destFile, stagingDir));
          }
          const approvedManifest = readApprovedRegularFile(packConfigPath, tmpExtractDir);
          if (!sameFileProof(sourceProofs[0]!.proof, approvedManifest.proof)) {
            throw new Error('Downloaded package manifest changed before copy');
          }
          const stagedManifest = join(stagingDir, TAKT_REPERTOIRE_MANIFEST_FILENAME);
          writeFileSync(stagedManifest, approvedManifest.bytes, { flag: 'wx', mode: 0o600 });
          assertPublishedBytes(
            approvedManifest.proof,
            captureRegularFileProof(stagedManifest, stagingDir),
          );

          const lock = generateLockFile({
            source: `github:${owner}/${repo}`,
            ref,
            commitSha,
            importedAt: new Date(),
          });
          writeFileSync(join(stagingDir, TAKT_REPERTOIRE_LOCK_FILENAME), stringifyYaml(lock));
        },
      });
    } finally {
      await lease.release();
    }

    success(`✅ ${owner}/${repo} @${ref} をインストールしました`);
  } catch (error) {
    primaryFailure = normalizeRepertoireMutationError(error);
    throw primaryFailure;
  } finally {
    try {
      if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // Cleanup must not mask the primary recovery/validation result.
      if (primaryFailure === undefined) failCleanup();
    }
  }
}

function failCleanup(): never {
  throw new RepertoireMutationError();
}

function capturePackageState(packageDir: string, repertoireDir: string): PackageState {
  assertLexicallyInside(packageDir, repertoireDir);
  const repertoireRealpath = realpathSync(repertoireDir);
  if (!existsSync(packageDir)) {
    return { exists: false, parent: captureNearestParentProof(packageDir, repertoireDir) };
  }

  const stat = lstatSync(packageDir);
  if (
    !safeReflectApply(safeStatsIsDirectoryMethod, stat, [])
    || safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, [])
  ) {
    throw new Error('Package state cannot be proven safe');
  }
  const packageRealpath = realpathSync(packageDir);
  assertResolvedInside(packageRealpath, repertoireRealpath);
  return { exists: true, tree: captureDirectoryTreeProof(packageDir, repertoireDir) };
}

function assertLexicallyInside(path: string, root: string): void {
  const relativePath = relative(root, path);
  if (safeStringStartsWith(relativePath, '..') || isAbsolute(relativePath)) {
    throw new Error('Package path escapes repertoire directory');
  }
}

function assertResolvedInside(path: string, root: string): void {
  const relativePath = relative(root, path);
  if (safeStringStartsWith(relativePath, '..') || isAbsolute(relativePath)) {
    throw new Error('Package path escapes repertoire directory');
  }
}

function samePackageState(left: PackageState, right: PackageState): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return !right.exists && sameParentProof(left.parent, right.parent);
  if (!right.exists) return false;
  return sameTreeProof(left.tree, right.tree);
}

function captureSourceProofs(
  manifestPath: string,
  targets: Array<{ absolutePath: string }>,
  containmentRoot: string,
): ApprovedFile[] {
  const proofs: ApprovedFile[] = [readApprovedRegularFile(manifestPath, containmentRoot)];
  let totalBytes = proofs[0]!.bytes.length;
  for (let index = 0; index < targets.length; index += 1) {
    proofs[index + 1] = readApprovedRegularFile(targets[index]!.absolutePath, containmentRoot);
    totalBytes += proofs[index + 1]!.bytes.length;
    if (totalBytes > APPROVED_SOURCE_MAX_TOTAL_BYTES) throw sourceBudgetExceeded();
  }
  return proofs;
}

function sourceBudgetExceeded(): Error & { code: 'RECOVERY_REQUIRED' } {
  return Object.assign(new Error('Downloaded package source exceeds the safe read budget'), {
    code: 'RECOVERY_REQUIRED' as const,
  });
}

function sameSourceProofs(left: ApprovedFile[], right: ApprovedFile[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!sameFileProof(left[index]!.proof, right[index]!.proof)) return false;
  }
  return true;
}

function assertPublishedBytes(source: FileProof, destination: FileProof): void {
  if (source.size !== destination.size || source.digest !== destination.digest) {
    throw Object.assign(new Error('Staged package bytes could not be verified'), {
      code: 'RECOVERY_REQUIRED' as const,
    });
  }
}

function sameTargetSet(
  left: Array<{ absolutePath: string; relativePath: string }>,
  right: Array<{ absolutePath: string; relativePath: string }>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index]!.absolutePath !== right[index]!.absolutePath
      || left[index]!.relativePath !== right[index]!.relativePath
    ) return false;
  }
  return true;
}
