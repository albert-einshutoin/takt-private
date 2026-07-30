import { ProjectTemplateValidationError } from './errors.js';
import {
  MAX_SOURCE_REF_LENGTH,
  MAX_SOURCE_URI_LENGTH,
  SOURCE_REF_PATTERN_SOURCE,
} from './validation.js';

const GITHUB_REF_PREFIX = 'github:';
const GITHUB_ORIGIN = 'https://github.com';
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SOURCE_REF_PATTERN = new RegExp(SOURCE_REF_PATTERN_SOURCE);
const PORTABLE_REF_PATTERN = /^[A-Za-z0-9._/+-]+$/;
const TAKTPACK_ASSET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.taktpack$/;
const MAX_RELEASE_ASSET_NAME_LENGTH = 255;

export interface ProjectTemplateGithubRefSourceSpec {
  readonly kind: 'github-ref';
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly repositoryUrl: `https://github.com/${string}/${string}`;
}

export interface ProjectTemplateGithubReleaseAssetSourceSpec {
  readonly kind: 'github-release-asset';
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly assetName: string;
  readonly repositoryUrl: `https://github.com/${string}/${string}`;
  readonly assetUrl:
    `https://github.com/${string}/${string}/releases/download/${string}/${string}.taktpack`;
}

export type ProjectTemplateGithubSourceSpec =
  | ProjectTemplateGithubRefSourceSpec
  | ProjectTemplateGithubReleaseAssetSourceSpec;

/**
 * Parses the two portable GitHub source forms accepted by project templates.
 *
 * This parser intentionally accepts only redirect-free, canonical identifiers.
 * Refs use the shared Git safety rules plus the portable ASCII subset
 * `[A-Za-z0-9._/+-]`. Literal `+` preserves SemVer build metadata: URL paths
 * treat it as data, and downstream GitHub resolution must pass these structured
 * fields as argument arrays without shell interpolation. A release tag must
 * additionally be one unescaped URL path segment: slash and percent escapes are
 * rejected to prevent layers from disagreeing about tag/path boundaries.
 * Network resolution, commit pinning, checksums, and downloads belong to the
 * resolver so parsing remains deterministic and safe to use during validation.
 */
export function parseProjectTemplateGithubSourceSpec(
  input: unknown,
): ProjectTemplateGithubSourceSpec {
  if (
    typeof input !== 'string'
    || input.length === 0
    || Array.from(input).length > MAX_SOURCE_URI_LENGTH
  ) {
    invalidSource('source must be a non-empty string within the portable length limit');
  }

  if (input.startsWith(GITHUB_REF_PREFIX)) {
    return parseGithubRefSpec(input);
  }
  return parseGithubReleaseAssetUrl(input);
}

function parseGithubRefSpec(input: string): ProjectTemplateGithubRefSourceSpec {
  const value = input.slice(GITHUB_REF_PREFIX.length);
  const separator = value.indexOf('@');
  if (separator <= 0 || separator !== value.lastIndexOf('@')) {
    invalidSource('GitHub repository source must contain exactly one explicit @ref');
  }

  const repository = value.slice(0, separator);
  const ref = value.slice(separator + 1);
  const repositoryParts = repository.split('/');
  if (repositoryParts.length !== 2) {
    invalidSource('GitHub repository source must use github:owner/repo@ref');
  }

  const owner = repositoryParts[0]!;
  const repo = repositoryParts[1]!;
  assertRepositoryCoordinates(owner, repo);
  assertPortableRef(ref);

  const normalizedOwner = owner.toLowerCase();
  const normalizedRepo = repo.toLowerCase();
  const repositoryUrl = createRepositoryUrl(normalizedOwner, normalizedRepo);

  return Object.freeze({
    kind: 'github-ref',
    owner: normalizedOwner,
    repo: normalizedRepo,
    ref,
    repositoryUrl,
  });
}

function parseGithubReleaseAssetUrl(
  input: string,
): ProjectTemplateGithubReleaseAssetSourceSpec {
  if (input.includes('%')) {
    invalidSource(
      'GitHub release tags use one unescaped portable path segment; '
      + 'percent escapes are rejected to avoid tag/path ambiguity',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    invalidSource('source must be an absolute canonical GitHub release asset URL');
  }

  if (
    parsed.href !== input
    || parsed.protocol !== 'https:'
    || parsed.hostname !== 'github.com'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.port !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    invalidSource('source must use the canonical credential-free GitHub URL');
  }

  const parts = parsed.pathname.split('/');
  if (
    parts.length !== 7
    || parts[0] !== ''
    || parts[3] !== 'releases'
    || parts[4] !== 'download'
  ) {
    invalidSource(
      'GitHub release source must use /releases/download/{tag}/{asset}; '
      + 'tag slash and percent escapes are rejected to avoid path ambiguity',
    );
  }

  const owner = parts[1]!;
  const repo = parts[2]!;
  const ref = parts[5]!;
  const assetName = parts[6]!;
  assertRepositoryCoordinates(owner, repo);
  if (owner !== owner.toLowerCase() || repo !== repo.toLowerCase()) {
    invalidSource('GitHub release source owner and repository must be canonical lowercase');
  }
  assertPortableRef(ref, false);
  assertTaktpackAssetName(assetName);

  const repositoryUrl = createRepositoryUrl(owner, repo);
  const assetUrl = (
    `${repositoryUrl}/releases/download/${ref}/${assetName}`
  ) as ProjectTemplateGithubReleaseAssetSourceSpec['assetUrl'];
  if (assetUrl !== input) {
    invalidSource('GitHub release asset URL must be canonical');
  }

  return Object.freeze({
    kind: 'github-release-asset',
    owner,
    repo,
    ref,
    assetName,
    repositoryUrl,
    assetUrl,
  });
}

function assertRepositoryCoordinates(owner: string, repo: string): void {
  if (!OWNER_PATTERN.test(owner) || owner.includes('--')) {
    invalidSource('GitHub owner is not a portable canonical name');
  }
  if (
    !REPOSITORY_PATTERN.test(repo)
    || repo === '.'
    || repo === '..'
    || repo.toLowerCase().endsWith('.git')
  ) {
    invalidSource('GitHub repository is not a portable canonical name');
  }
}

function assertPortableRef(ref: string, allowSlash = true): void {
  if (
    ref.length === 0
    || Array.from(ref).length > MAX_SOURCE_REF_LENGTH
    || !SOURCE_REF_PATTERN.test(ref)
    || !PORTABLE_REF_PATTERN.test(ref)
    || ref.includes('@')
    || (!allowSlash && ref.includes('/'))
  ) {
    invalidSource(
      'GitHub ref must satisfy Git ref safety rules and use only '
      + 'portable ASCII [A-Za-z0-9._/+-]',
    );
  }
}

function assertTaktpackAssetName(assetName: string): void {
  if (
    assetName.length > MAX_RELEASE_ASSET_NAME_LENGTH
    || !TAKTPACK_ASSET_PATTERN.test(assetName)
  ) {
    invalidSource('GitHub release asset must be a portable .taktpack filename');
  }
}

function createRepositoryUrl(
  owner: string,
  repo: string,
): `https://github.com/${string}/${string}` {
  return `${GITHUB_ORIGIN}/${owner}/${repo}`;
}

function invalidSource(message: string): never {
  throw new ProjectTemplateValidationError(
    'INVALID_SOURCE',
    message,
    'source',
  );
}
