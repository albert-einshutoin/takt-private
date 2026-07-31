/**
 * takt repertoire add — install a repertoire package from GitHub.
 *
 * Usage:
 *   takt repertoire add github:{owner}/{repo}@{ref}
 *   takt repertoire add github:{owner}/{repo}          (uses default branch)
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
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
import { atomicReplace, cleanupResiduals } from '../../features/repertoire/atomic-update.js';
import { acquireRepertoireCoordinationLease } from '../../features/repertoire/coordination-lease.js';
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

const log = createLogger('repertoire-add');

type RepertoireMutationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type PackageState =
  | { exists: false; parentRealpath: string }
  | {
    exists: true;
    dev: number;
    ino: number;
    lockDigest: string | undefined;
    realpath: string;
  };

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

  const tmpBase = mkdtempSync(join(ensureCurrentTmpDirExists(), 'takt-import-'));
  const tmpTarPath = join(tmpBase, 'archive.tar.gz');
  const tmpExtractDir = join(tmpBase, 'extract');
  const tmpIncludeFile = join(tmpBase, 'include.txt');

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

    const verboseLines = tarVerboseList.split('\n').filter(l => l.trim());
    const { firstDirEntry, includePaths } = parseTarVerboseListing(verboseLines);

    const commitSha = extractCommitSha(firstDirEntry);

    if (includePaths.length > 0) {
      writeFileSync(tmpIncludeFile, includePaths.join('\n') + '\n');
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
    const facetFiles = targets.filter(t => t.relativePath.startsWith('facets/'));
    const workflowFiles = targets.filter(t => t.relativePath.startsWith('workflows/'));
    const providerOptionsFiles = targets.filter(t => t.relativePath.startsWith('provider-options/'));

    const facetSummary = summarizeFacetsByType(facetFiles.map(t => t.relativePath));

    const workflowYamls: Array<{ name: string; content: string; relativePath: string }> = [];
    for (const workflowFile of workflowFiles) {
      try {
        const content = readFileSync(workflowFile.absolutePath, 'utf-8');
        workflowYamls.push({
          name: workflowFile.relativePath.replace(/^workflows\//, ''),
          content,
          relativePath: workflowFile.relativePath,
        });
      } catch (err) {
        log.debug('Failed to parse workflow YAML for edit check', { path: workflowFile.absolutePath, error: getErrorMessage(err) });
      }
    }
    const providerOptionsYamls: Array<{ name: string; content: string; relativePath: string }> = [];
    const workflowRelativeProviderOptionsFiles = workflowFiles.filter(t => t.relativePath.includes('/provider-options/'));
    for (const providerOptionsFile of [...providerOptionsFiles, ...workflowRelativeProviderOptionsFiles]) {
      try {
        const content = readFileSync(providerOptionsFile.absolutePath, 'utf-8');
        providerOptionsYamls.push({
          name: providerOptionsFile.relativePath.replace(/^provider-options\//, ''),
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
      const workflowNames = workflowFiles.map(t =>
        t.relativePath.replace(/^workflows\//, '').replace(/\.yaml$/, ''),
      );
      info(`   workflows:  ${workflowFiles.length} (${workflowNames.join(', ')})`);
    } else {
      info('   workflows:  0');
    }
    for (const workflow of editWorkflows) {
      for (const warning of formatEditWorkflowWarnings(workflow)) {
        info(warning);
      }
    }
    info('');

    const sourceDigest = digestSourceFiles(packConfigPath, targets.map((target) => target.absolutePath));
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

    const lease = await acquireRepertoireCoordinationLease({
      globalConfigDir: getGlobalConfigDir(),
      mode: 'write',
      ...(mutationOptions.signal === undefined ? {} : { signal: mutationOptions.signal }),
      ...(mutationOptions.timeoutMs === undefined ? {} : { timeoutMs: mutationOptions.timeoutMs }),
    });
    try {
      const freshPackageState = capturePackageState(packageDir, repertoireDir);
      if (!samePackageState(initialPackageState, freshPackageState)) {
        throw new Error('Package state changed while waiting for coordination lease');
      }
      if (digestSourceFiles(packConfigPath, targets.map((target) => target.absolutePath)) !== sourceDigest) {
        throw new Error('Downloaded package source changed while waiting for coordination lease');
      }
      cleanupResiduals(packageDir);

      await atomicReplace({
        packageDir,
        install: async (stagingDir) => {
          for (const target of targets) {
            const destFile = join(stagingDir, target.relativePath);
            mkdirSync(dirname(destFile), { recursive: true });
            copyFileSync(target.absolutePath, destFile);
          }
          copyFileSync(packConfigPath, join(stagingDir, TAKT_REPERTOIRE_MANIFEST_FILENAME));

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
  } finally {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  }
}

function digestSourceFiles(manifestPath: string, sourcePaths: string[]): string {
  const hash = createHash('sha256');
  for (const path of [manifestPath, ...sourcePaths].sort()) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function capturePackageState(packageDir: string, repertoireDir: string): PackageState {
  assertLexicallyInside(packageDir, repertoireDir);
  const repertoireRealpath = realpathSync(repertoireDir);
  if (!existsSync(packageDir)) {
    const parentRealpath = realpathNearestExistingParent(dirname(packageDir));
    assertResolvedInside(parentRealpath, repertoireRealpath);
    return { exists: false, parentRealpath };
  }

  const stat = lstatSync(packageDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Package state cannot be proven safe');
  }
  const packageRealpath = realpathSync(packageDir);
  assertResolvedInside(packageRealpath, repertoireRealpath);
  const lockPath = join(packageDir, TAKT_REPERTOIRE_LOCK_FILENAME);
  return {
    exists: true,
    dev: stat.dev,
    ino: stat.ino,
    lockDigest: existsSync(lockPath) ? digestFile(lockPath) : undefined,
    realpath: packageRealpath,
  };
}

function realpathNearestExistingParent(start: string): string {
  let candidate = start;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error('Package parent cannot be proven safe');
    candidate = parent;
  }
  return realpathSync(candidate);
}

function assertLexicallyInside(path: string, root: string): void {
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Package path escapes repertoire directory');
  }
}

function assertResolvedInside(path: string, root: string): void {
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Package path escapes repertoire directory');
  }
}

function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function samePackageState(left: PackageState, right: PackageState): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return !right.exists && left.parentRealpath === right.parentRealpath;
  if (!right.exists) return false;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.realpath === right.realpath
    && left.lockDigest === right.lockDigest;
}
