import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CommitSource = 'TAKT_BUILD_COMMIT' | 'GITHUB_SHA' | 'SOURCE_COMMIT' | 'git' | 'unknown';

export interface ReleasePackageInfo {
  name: string;
  version: string;
}

export interface ReleaseProvenance {
  packageName: string;
  packageVersion: string;
  commitSha: string;
  commitSource: CommitSource;
  packageRoot: string;
  gitDirty: boolean | null;
  generatedAt: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  artifactBoundary: string[];
}

export interface CollectReleaseProvenanceOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  packageRoot?: string;
  packageInfo?: ReleasePackageInfo;
  gitCommand?: (args: readonly string[]) => string | undefined;
}

const require = createRequire(import.meta.url);
const ENV_COMMIT_KEYS = ['TAKT_BUILD_COMMIT', 'GITHUB_SHA', 'SOURCE_COMMIT'] as const;
const ARTIFACT_BOUNDARY = [
  'npm package build from dist/',
  'CLI wrappers from bin/',
  'built-in workflows, facets, and prompts from builtins/',
  'personal release runbook and changelog/release notes snapshot from docs/',
] as const;

function defaultPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function loadPackageInfo(): ReleasePackageInfo {
  return require('../../../package.json') as ReleasePackageInfo;
}

function normalizeCommit(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || !/^[0-9a-f]{7,40}$/i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function defaultGitCommand(packageRoot: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', packageRoot, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function resolveCommit(options: {
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  gitCommand: (args: readonly string[]) => string | undefined;
}): { commitSha: string; commitSource: CommitSource } {
  for (const key of ENV_COMMIT_KEYS) {
    const commit = normalizeCommit(options.env[key]);
    if (commit !== undefined) {
      return { commitSha: commit, commitSource: key };
    }
  }

  const gitCommit = normalizeCommit(options.gitCommand(['rev-parse', 'HEAD']));
  if (gitCommit !== undefined) {
    return { commitSha: gitCommit, commitSource: 'git' };
  }

  return { commitSha: 'unknown', commitSource: 'unknown' };
}

function resolveGitDirty(gitCommand: (args: readonly string[]) => string | undefined): boolean | null {
  const status = gitCommand(['status', '--porcelain']);
  if (status === undefined) {
    return null;
  }
  return status.trim().length > 0;
}

export function collectReleaseProvenance(
  options: CollectReleaseProvenanceOptions = {},
): ReleaseProvenance {
  const env = options.env ?? process.env;
  const packageRoot = resolve(options.packageRoot ?? defaultPackageRoot());
  const packageInfo = options.packageInfo ?? loadPackageInfo();
  const gitCommand = options.gitCommand ?? ((args: readonly string[]) => defaultGitCommand(packageRoot, args));
  const commit = resolveCommit({ env, packageRoot, gitCommand });

  return {
    packageName: packageInfo.name,
    packageVersion: packageInfo.version,
    commitSha: commit.commitSha,
    commitSource: commit.commitSource,
    packageRoot,
    gitDirty: resolveGitDirty(gitCommand),
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    artifactBoundary: [...ARTIFACT_BOUNDARY],
  };
}

export function formatReleaseProvenance(provenance: ReleaseProvenance): string {
  const dirty = provenance.gitDirty === null
    ? 'unknown'
    : provenance.gitDirty ? 'yes' : 'no';
  return [
    `${provenance.packageName} ${provenance.packageVersion}`,
    `Commit: ${provenance.commitSha} (${provenance.commitSource})`,
    `Git dirty: ${dirty}`,
    `Package root: ${provenance.packageRoot}`,
    `Generated: ${provenance.generatedAt}`,
    `Runtime: ${provenance.nodeVersion} ${provenance.platform}/${provenance.arch}`,
    'Artifact boundary:',
    ...provenance.artifactBoundary.map((item) => `- ${item}`),
  ].join('\n');
}
