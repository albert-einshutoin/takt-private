import { TextDecoder, types } from 'node:util';
import {
  DEFAULT_TAKTPACK_LIMITS,
} from './archive-types.js';
import type {
  ProjectTemplateGithubSourceSpec,
} from './github-source-spec.js';
import {
  parseProjectTemplateGithubSourceSpec,
} from './github-source-spec.js';
import {
  calculateProjectTemplateSourceDescriptorSha256,
  MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES,
  parseProjectTemplateSourceDescriptorJson,
  PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_PATH,
  serializeProjectTemplateSourceDescriptor,
} from './source-descriptor.js';
import type {
  ProjectTemplateRepertoireDependencyV1,
  ProjectTemplateSourceDescriptorV1,
} from './source-descriptor.js';
import {
  compareSemVer,
  requireSemVer,
} from './validation.js';
import type {
  VerifiedGithubDependencySourceEvidence,
} from '../repertoire/github-ref-resolver.js';
import {
  calculateProjectTemplateRepertoireDependencyDeclarationSha256,
} from './repertoire-dependency-canonical.js';

const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RELEASE_ASSETS = 256;
const MAX_METADATA_NAME_LENGTH = 512;
const MAX_CHECKSUM_BYTES = 4 * 1024;

export type GithubTemplateSourceResolutionErrorCode =
  | 'INVALID_SOURCE_SPEC'
  | 'METADATA_PORT_FAILURE'
  | 'INVALID_REF_METADATA'
  | 'INVALID_DESCRIPTOR'
  | 'DIRECT_RELEASE_MISMATCH'
  | 'TAG_COMMIT_MISMATCH'
  | 'INVALID_RELEASE_METADATA'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_AMBIGUOUS'
  | 'ASSET_TOO_LARGE'
  | 'INVALID_CHECKSUM'
  | 'CHECKSUM_MISMATCH'
  | 'UNVERIFIED_DEPENDENCY_SOURCE'
  | 'INVALID_CURRENT_EVIDENCE'
  | 'INVALID_AUTHORITY';

export class GithubTemplateSourceResolutionError extends Error {
  constructor(
    public readonly code: GithubTemplateSourceResolutionErrorCode,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'GithubTemplateSourceResolutionError';
  }
}

export interface GithubTemplateResolveRefInput {
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
}

export interface GithubTemplateReadFileInput {
  readonly owner: string;
  readonly repo: string;
  readonly commit: string;
  readonly path: typeof PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_PATH;
  readonly maxBytes: number;
}

export interface GithubTemplateGetReleaseInput {
  readonly owner: string;
  readonly repo: string;
  readonly tag: string;
}

export interface GithubTemplateReadReleaseAssetInput {
  readonly owner: string;
  readonly repo: string;
  readonly releaseId: number;
  readonly assetId: number;
  readonly maxBytes: number;
}

/**
 * Injected metadata-only boundary. Implementations may use GitHub APIs, but
 * tokens, commands, URLs, and raw stderr never cross into this pure resolver.
 *
 * @deprecated Application flows should expose GithubTemplateSourceResolverPort
 * so raw metadata and credential-bearing implementations remain private.
 */
export interface GithubTemplateSourceMetadataPort {
  resolveRefToCommit(
    input: GithubTemplateResolveRefInput,
  ): Promise<unknown>;
  readFileAtCommit(
    input: GithubTemplateReadFileInput,
  ): Promise<unknown>;
  getReleaseByTag(
    input: GithubTemplateGetReleaseInput,
  ): Promise<unknown>;
  readReleaseAsset(
    input: GithubTemplateReadReleaseAssetInput,
  ): Promise<unknown>;
}

export interface GithubTemplateCurrentSourceEvidence {
  readonly owner: string;
  readonly repo: string;
  readonly repositoryUrl: `https://github.com/${string}/${string}`;
  readonly canonicalSource: string;
  readonly version: string;
  readonly sha256: string;
  readonly commit: string;
  readonly descriptorSha256: string;
}

export type GithubTemplateUpdateState =
  | 'update-available'
  | 'up-to-date'
  | 'version-republished'
  | 'downgrade'
  | 'source-changed';

export interface ResolveGithubTemplateSourceOptions {
  readonly source: ProjectTemplateGithubSourceSpec;
  readonly metadata: GithubTemplateSourceMetadataPort;
  readonly current?: GithubTemplateCurrentSourceEvidence;
  readonly verifyDependencies?: (
    dependencies: readonly ProjectTemplateRepertoireDependencyV1[],
  ) => Promise<VerifiedGithubDependencySourceEvidence>;
}

/**
 * Advisory provenance and update evidence. Structural typing and
 * Object.freeze do not make this value download authority: only the original
 * result can be exchanged for a process-local download claim. Downloaders
 * must still re-resolve under the shared mutation lease and exactly match
 * canonicalSource, commit, descriptorSha256, releaseId, assetId, and sha256.
 */
export interface ResolvedGithubTemplateSource {
  readonly kind: 'resolved-github-template-source';
  readonly owner: string;
  readonly repo: string;
  readonly repositoryUrl: `https://github.com/${string}/${string}`;
  readonly canonicalSource: string;
  readonly requestedRef: string;
  readonly releaseTag: string;
  readonly commit: string;
  readonly descriptorSha256: string;
  readonly releaseId: number;
  readonly assetId: number;
  readonly assetName: string;
  readonly assetSize: number;
  readonly checksumAssetId: number;
  readonly checksumAssetName: string;
  readonly checksumAssetSize: number;
  readonly sha256: string;
  readonly version: string;
  /**
   * Unverified declarations only. They must not be applied or locked until a
   * dependency resolver proves every declared tag resolves to its commit.
   */
  readonly declaredDependencies:
    readonly ProjectTemplateRepertoireDependencyV1[];
  readonly dependencyVerification?: VerifiedGithubDependencySourceEvidence;
  readonly updateState: GithubTemplateUpdateState;
  readonly hardBlocked: boolean;
  readonly downloadEligible: boolean;
}

/**
 * Authority-free evidence for UI, persistence decisions, and drift comparison.
 * Its distinct discriminant prevents accidental structural reuse as a fresh
 * resolution result, while runtime download authority remains WeakMap-only.
 */
export interface GithubTemplateSourceAdvisory {
  readonly kind: 'github-template-source-advisory';
  readonly source: {
    readonly owner: string;
    readonly repo: string;
    readonly repositoryUrl: `https://github.com/${string}/${string}`;
    readonly canonicalSource: string;
    readonly requestedRef: string;
    readonly commit: string;
    readonly descriptorSha256: string;
  };
  readonly release: {
    readonly tag: string;
    readonly id: number;
    readonly asset: {
      readonly id: number;
      readonly name: string;
      readonly size: number;
    };
    readonly checksumAsset: {
      readonly id: number;
      readonly name: string;
      readonly size: number;
    };
    readonly sha256: string;
    readonly version: string;
  };
  readonly declaredDependencies:
    readonly ProjectTemplateRepertoireDependencyV1[];
  readonly updateState: GithubTemplateUpdateState;
  readonly hardBlocked: boolean;
  readonly downloadEligible: boolean;
}

interface ResolvedGithubTemplateSourceAuthority {
  readonly result: ResolvedGithubTemplateSource;
  readonly descriptor: ProjectTemplateSourceDescriptorV1;
  readonly dependencyVerification?: VerifiedGithubDependencySourceEvidence;
  state:
    | 'active'
    | 'demoting'
    | 'download-owned'
    | 'receipt-consuming'
    | 'consumed';
}

declare const resolvedGithubTemplateSourceDownloadClaimBrand: unique symbol;
declare const resolvedGithubTemplateSourceReceiptClaimBrand: unique symbol;

/** Opaque, process-local ownership of one freshly resolved provenance result. */
export interface ClaimedResolvedGithubTemplateSourceForDownload {
  readonly resolved: ResolvedGithubTemplateSource;
  readonly [resolvedGithubTemplateSourceDownloadClaimBrand]: true;
}

export interface ClaimedResolvedGithubTemplateSource {
  readonly resolved: ResolvedGithubTemplateSource;
  readonly descriptor: ProjectTemplateSourceDescriptorV1;
  readonly [resolvedGithubTemplateSourceReceiptClaimBrand]: true;
}

const RESOLVED_SOURCE_AUTHORITIES = new WeakMap<
  object,
  ResolvedGithubTemplateSourceAuthority
>();
const RESOLVED_SOURCE_CLAIMS = new WeakMap<
  object,
  ResolvedGithubTemplateSourceAuthority
>();
const RESOLVED_SOURCE_DOWNLOAD_CLAIMS = new WeakMap<
  object,
  ResolvedGithubTemplateSourceAuthority
>();
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_WEAK_MAP_GET = WeakMap.prototype.get;
const CAPTURED_WEAK_MAP_SET = WeakMap.prototype.set;
const CAPTURED_WEAK_MAP_DELETE = WeakMap.prototype.delete;

function authorityMapGet(
  map: WeakMap<object, ResolvedGithubTemplateSourceAuthority>,
  key: object,
): ResolvedGithubTemplateSourceAuthority | undefined {
  // Authority decisions must not consult mutable prototype properties after
  // module initialization. A poisoned WeakMap method could otherwise reenter
  // between validation and retirement or replace the selected primary error.
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_MAP_GET,
    map,
    [key],
  ) as ResolvedGithubTemplateSourceAuthority | undefined;
}

function authorityMapSet(
  map: WeakMap<object, ResolvedGithubTemplateSourceAuthority>,
  key: object,
  authority: ResolvedGithubTemplateSourceAuthority,
): void {
  CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_MAP_SET,
    map,
    [key, authority],
  );
}

function authorityMapDelete(
  map: WeakMap<object, ResolvedGithubTemplateSourceAuthority>,
  key: object,
): void {
  CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_MAP_DELETE, map, [key]);
}

function requireActiveResolvedAuthority(
  value: unknown,
): ResolvedGithubTemplateSourceAuthority {
  const authority = (
    typeof value === 'object' && value !== null
      ? authorityMapGet(RESOLVED_SOURCE_AUTHORITIES, value)
      : undefined
  );
  if (
    authority === undefined
    || authority.result !== value
    || authority.state !== 'active'
  ) {
    invalidResolvedAuthority('resolved GitHub template source authority');
  }
  return authority;
}

function consumeActiveResolvedAuthority(
  authority: ResolvedGithubTemplateSourceAuthority,
): void {
  authority.state = 'consumed';
  authorityMapDelete(RESOLVED_SOURCE_AUTHORITIES, authority.result);
}

export function demoteResolvedGithubTemplateSourceToAdvisory(
  value: unknown,
): GithubTemplateSourceAdvisory {
  const authority = requireActiveResolvedAuthority(value);
  const resolved = authority.result;
  // Reserve synchronously before copying nested evidence. Even if a mutable
  // intrinsic is compromised, reentry cannot exchange the same result for a
  // claim while demotion is in progress.
  authority.state = 'demoting';
  let advisory: GithubTemplateSourceAdvisory;
  try {
    advisory = Object.freeze<GithubTemplateSourceAdvisory>({
      kind: 'github-template-source-advisory',
      source: Object.freeze({
        owner: resolved.owner,
        repo: resolved.repo,
        repositoryUrl: resolved.repositoryUrl,
        canonicalSource: resolved.canonicalSource,
        requestedRef: resolved.requestedRef,
        commit: resolved.commit,
        descriptorSha256: resolved.descriptorSha256,
      }),
      release: Object.freeze({
        tag: resolved.releaseTag,
        id: resolved.releaseId,
        asset: Object.freeze({
          id: resolved.assetId,
          name: resolved.assetName,
          size: resolved.assetSize,
        }),
        checksumAsset: Object.freeze({
          id: resolved.checksumAssetId,
          name: resolved.checksumAssetName,
          size: resolved.checksumAssetSize,
        }),
        sha256: resolved.sha256,
        version: resolved.version,
      }),
      declaredDependencies: Object.freeze(
        resolved.declaredDependencies.map((dependency) => Object.freeze({
          ...dependency,
          capabilities: Object.freeze([...dependency.capabilities]),
        })),
      ),
      updateState: resolved.updateState,
      hardBlocked: resolved.hardBlocked,
      downloadEligible: resolved.downloadEligible,
    });
  } catch (error) {
    authority.state = 'active';
    throw error;
  }
  // Build every structural copy before consuming. Once this synchronous state
  // transition occurs, no throw or reentry can strand active authority behind
  // an advisory result.
  consumeActiveResolvedAuthority(authority);
  return advisory;
}

export function discardResolvedGithubTemplateSource(value: unknown): void {
  const authority = requireActiveResolvedAuthority(value);
  // Fresh results that lose a compare/race must be explicitly retired so no
  // later code can accidentally exchange the stale object for download power.
  consumeActiveResolvedAuthority(authority);
}

export function claimResolvedGithubTemplateSourceForDownload(
  value: unknown,
): ClaimedResolvedGithubTemplateSourceForDownload {
  const authority = requireActiveResolvedAuthority(value);
  if (authority.dependencyVerification === undefined) {
    invalidResolvedAuthority(
      'unverified resolved GitHub template source authority',
    );
  }
  // The existing authority is deliberately advanced instead of copying its
  // provenance into a second authority: one state cell makes concurrent
  // download, discard, and receipt ownership mutually exclusive.
  authority.state = 'download-owned';
  const claim = Object.freeze({
    resolved: authority.result,
  }) as ClaimedResolvedGithubTemplateSourceForDownload;
  authorityMapSet(RESOLVED_SOURCE_DOWNLOAD_CLAIMS, claim, authority);
  return claim;
}

export function discardResolvedGithubTemplateSourceDownloadClaim(
  claim: ClaimedResolvedGithubTemplateSourceForDownload,
): void {
  const authority = authorityMapGet(RESOLVED_SOURCE_DOWNLOAD_CLAIMS, claim);
  if (authority === undefined || authority.state !== 'download-owned') {
    invalidResolvedAuthority(
      'resolved GitHub template source download claim',
    );
  }
  authority.state = 'consumed';
  authorityMapDelete(RESOLVED_SOURCE_DOWNLOAD_CLAIMS, claim);
}

export function handoffResolvedGithubTemplateSourceDownloadClaimForReceipt(
  claim: ClaimedResolvedGithubTemplateSourceForDownload,
): ClaimedResolvedGithubTemplateSource {
  const authority = authorityMapGet(RESOLVED_SOURCE_DOWNLOAD_CLAIMS, claim);
  if (authority === undefined || authority.state !== 'download-owned') {
    invalidResolvedAuthority(
      'resolved GitHub template source download claim',
    );
  }
  authority.state = 'receipt-consuming';
  authorityMapDelete(RESOLVED_SOURCE_DOWNLOAD_CLAIMS, claim);
  return createResolvedReceiptClaim(authority);
}

function createResolvedReceiptClaim(
  authority: ResolvedGithubTemplateSourceAuthority,
): ClaimedResolvedGithubTemplateSource {
  // The compile-time brand mirrors the runtime WeakMap seal so downstream
  // code cannot accidentally reconstruct receipt authority from public data.
  const claim = Object.freeze({
    resolved: authority.result,
    descriptor: authority.descriptor,
  }) as ClaimedResolvedGithubTemplateSource;
  authorityMapSet(RESOLVED_SOURCE_CLAIMS, claim, authority);
  return claim;
}

export function consumeResolvedGithubTemplateSourceReceiptClaim(
  claim: ClaimedResolvedGithubTemplateSource,
): void {
  const authority = authorityMapGet(RESOLVED_SOURCE_CLAIMS, claim);
  if (authority === undefined || authority.state !== 'receipt-consuming') {
    invalidResolvedAuthority('resolved GitHub template source claim');
  }
  authority.state = 'consumed';
  authorityMapDelete(RESOLVED_SOURCE_CLAIMS, claim);
}

function invalidResolvedAuthority(subject: string): never {
  resolutionError(
    'INVALID_AUTHORITY',
    `${subject} is invalid`,
    'resolved',
  );
}

interface ParsedReleaseAsset {
  id: number;
  name: string;
  size: number;
}

interface ParsedRelease {
  id: number;
  tagName: string;
  assets: ParsedReleaseAsset[];
}

/**
 * @deprecated Use a GithubTemplateSourceResolverPort outside low-level
 * resolver implementations.
 */
export async function resolveGithubTemplateSource(
  options: ResolveGithubTemplateSourceOptions,
): Promise<ResolvedGithubTemplateSource> {
  const source = validateParsedSourceSpec(options.source);
  const canonicalSource = canonicalizeSourceSpec(source);
  const { owner, repo, ref: requestedRef } = source;
  const requestedCommit = await resolveCommit(
    options.metadata,
    owner,
    repo,
    requestedRef,
  );

  // The mutable requested ref is intentionally discarded here. Every content
  // read after this point is addressed by the immutable resolved commit.
  const descriptorPayload = await callMetadataPort(
    () => options.metadata.readFileAtCommit(Object.freeze({
      owner,
      repo,
      commit: requestedCommit,
      path: PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_PATH,
      maxBytes: MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES,
    })),
  );
  const descriptor = parseDescriptorPayload(descriptorPayload);
  const declaredDependencies = Object.freeze(
    descriptor.repertoireDependencies.map((dependency) => Object.freeze({
      ...dependency,
      capabilities: Object.freeze([...dependency.capabilities]),
    })),
  );

  if (
    source.kind === 'github-release-asset'
    && (
      source.ref !== descriptor.pack.releaseTag
      || source.assetName !== descriptor.pack.assetName
    )
  ) {
    resolutionError(
      'DIRECT_RELEASE_MISMATCH',
      'direct release URL must exactly match descriptor tag and asset',
      'source',
    );
  }

  const tagCommit = await resolveCommit(
    options.metadata,
    owner,
    repo,
    descriptor.pack.releaseTag,
  );
  if (tagCommit !== requestedCommit) {
    resolutionError(
      'TAG_COMMIT_MISMATCH',
      'descriptor release tag does not resolve to requested commit',
      'descriptor.pack.releaseTag',
    );
  }

  // Dependency refs are verified after the pack tag is pinned but before any
  // release/checksum side effect. A republished dependency therefore cannot
  // advance the flow to archive authority, cache, or receipt signing.
  let dependencyVerification: VerifiedGithubDependencySourceEvidence
    | undefined;
  if (options.verifyDependencies !== undefined) {
    try {
      const evidence = await options.verifyDependencies(declaredDependencies);
      const descriptors: Record<string, PropertyDescriptor | undefined> = (
        typeof evidence === 'object'
        && evidence !== null
        && !types.isProxy(evidence)
      ) ? Object.getOwnPropertyDescriptors(evidence) : {};
      const method = descriptors['method'];
      const declarationSha256 = descriptors['declarationSha256'];
      const count = descriptors['count'];
      if (
        typeof evidence !== 'object'
        || evidence === null
        || Array.isArray(evidence)
        || types.isProxy(evidence)
        || Object.getPrototypeOf(evidence) !== Object.prototype
        || Reflect.ownKeys(evidence).length !== 3
        || method === undefined
        || !('value' in method)
        || method.value !== 'github-ref-to-commit-v1'
        || declarationSha256 === undefined
        || !('value' in declarationSha256)
        || typeof declarationSha256.value !== 'string'
        || count === undefined
        || !('value' in count)
        || count.value !== declaredDependencies.length
        || !Number.isSafeInteger(count.value)
        || !SHA256_PATTERN.test(declarationSha256.value)
        || declarationSha256.value
          !== calculateProjectTemplateRepertoireDependencyDeclarationSha256(
            declaredDependencies,
          )
      ) throw new Error();
      dependencyVerification = Object.freeze({
        method: 'github-ref-to-commit-v1',
        declarationSha256: declarationSha256.value,
        count: count.value as number,
      });
    } catch {
      resolutionError(
        'UNVERIFIED_DEPENDENCY_SOURCE',
        'GitHub dependency sources could not be verified',
        'descriptor.repertoireDependencies',
      );
    }
  } else if (declaredDependencies.length === 0) {
    // Empty declarations require no remote call, but still receive explicit
    // evidence so legacy zero-dependency downloads remain unambiguous.
    dependencyVerification = Object.freeze({
      method: 'github-ref-to-commit-v1',
      declarationSha256:
        calculateProjectTemplateRepertoireDependencyDeclarationSha256([]),
      count: 0,
    });
  }

  const releasePayload = await callMetadataPort(
    () => options.metadata.getReleaseByTag(Object.freeze({
      owner,
      repo,
      tag: descriptor.pack.releaseTag,
    })),
  );
  const release = normalizeValidationBoundary(
    'INVALID_RELEASE_METADATA',
    'release metadata failed strict validation',
    () => parseReleaseMetadata(releasePayload),
  );
  if (release.tagName !== descriptor.pack.releaseTag) {
    resolutionError(
      'INVALID_RELEASE_METADATA',
      'release tag does not match descriptor releaseTag',
      'release.tagName',
    );
  }

  const archiveAsset = selectUniqueAsset(
    release.assets,
    descriptor.pack.assetName,
  );
  const checksumAsset = selectUniqueAsset(
    release.assets,
    descriptor.pack.checksumAssetName,
  );
  if (archiveAsset.id === checksumAsset.id) {
    resolutionError(
      'INVALID_RELEASE_METADATA',
      'archive and checksum assets must have distinct IDs',
      'release.assets',
    );
  }
  if (
    archiveAsset.size <= 0
    || archiveAsset.size > DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes
    || checksumAsset.size <= 0
    || checksumAsset.size > MAX_CHECKSUM_BYTES
  ) {
    resolutionError(
      'ASSET_TOO_LARGE',
      'release asset size is outside the allowed bound',
      'release.assets',
    );
  }

  const checksumPayload = await callMetadataPort(
    () => options.metadata.readReleaseAsset(Object.freeze({
      owner,
      repo,
      releaseId: release.id,
      assetId: checksumAsset.id,
      maxBytes: MAX_CHECKSUM_BYTES,
    })),
  );
  const checksumText = normalizeValidationBoundary(
    'INVALID_CHECKSUM',
    'checksum payload failed strict validation',
    () => parseChecksumPayload(checksumPayload, checksumAsset.size),
  );
  const checksum = normalizeValidationBoundary(
    'INVALID_CHECKSUM',
    'checksum payload failed strict validation',
    () => parseCanonicalChecksum(
      checksumText,
      descriptor.pack.assetName,
    ),
  );
  if (checksum !== descriptor.pack.sha256) {
    resolutionError(
      'CHECKSUM_MISMATCH',
      'release checksum does not match descriptor SHA-256',
      'checksum',
    );
  }

  const descriptorSha256 =
    calculateProjectTemplateSourceDescriptorSha256(descriptor);
  const update = classifyUpdate(
    descriptor,
    requestedCommit,
    descriptorSha256,
    source,
    options.current,
  );
  const result: ResolvedGithubTemplateSource = Object.freeze({
    kind: 'resolved-github-template-source',
    owner,
    repo,
    repositoryUrl: source.repositoryUrl,
    canonicalSource,
    requestedRef,
    releaseTag: descriptor.pack.releaseTag,
    commit: requestedCommit,
    descriptorSha256,
    releaseId: release.id,
    assetId: archiveAsset.id,
    assetName: archiveAsset.name,
    assetSize: archiveAsset.size,
    checksumAssetId: checksumAsset.id,
    checksumAssetName: checksumAsset.name,
    checksumAssetSize: checksumAsset.size,
    sha256: descriptor.pack.sha256,
    version: descriptor.pack.version,
    declaredDependencies,
    ...(dependencyVerification === undefined
      ? {}
      : { dependencyVerification }),
    ...update,
  });
  const descriptorSnapshot = parseProjectTemplateSourceDescriptorJson(
    serializeProjectTemplateSourceDescriptor(descriptor),
  );
  authorityMapSet(RESOLVED_SOURCE_AUTHORITIES, result, {
    result,
    descriptor: Object.freeze({
      ...descriptorSnapshot,
      pack: Object.freeze({ ...descriptorSnapshot.pack }),
      repertoireDependencies: Object.freeze(
        descriptorSnapshot.repertoireDependencies.map(
          (dependency) => Object.freeze({
            ...dependency,
            capabilities: Object.freeze([...dependency.capabilities]),
          }),
        ),
      ),
    }),
    ...(dependencyVerification === undefined
      ? {}
      : { dependencyVerification }),
    state: 'active',
  });
  return result;
}

function validateParsedSourceSpec(
  value: ProjectTemplateGithubSourceSpec,
): ProjectTemplateGithubSourceSpec {
  try {
    const source = snapshotSourceSpec(value);
    if (source['kind'] === 'github-ref') {
      const parsed = parseProjectTemplateGithubSourceSpec(
        `github:${source['owner']}/${source['repo']}@${source['ref']}`,
      );
      const keys = [
        'kind',
        'owner',
        'repo',
        'ref',
        'repositoryUrl',
      ] as const;
      if (keys.some((key) => parsed[key] !== source[key])) {
        resolutionError(
          'INVALID_SOURCE_SPEC',
          'source spec is not canonical',
          'source',
        );
      }
      return parsed;
    }
    const parsed = parseProjectTemplateGithubSourceSpec(
      source['assetUrl'],
    );
    if (parsed.kind !== 'github-release-asset') {
      resolutionError(
        'INVALID_SOURCE_SPEC',
        'release source spec did not reconstruct as a release asset',
        'source',
      );
    }
    const keys = [
      'kind',
      'owner',
      'repo',
      'ref',
      'assetName',
      'repositoryUrl',
      'assetUrl',
    ] as const;
    if (keys.some((key) => parsed[key] !== source[key])) {
      resolutionError(
        'INVALID_SOURCE_SPEC',
        'source spec is not canonical',
        'source',
      );
    }
    return parsed;
  } catch {
    resolutionError(
      'INVALID_SOURCE_SPEC',
      'source spec is not a parsed canonical GitHub source',
      'source',
    );
  }
}

function snapshotSourceSpec(
  value: ProjectTemplateGithubSourceSpec,
): Record<string, string> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    resolutionError(
      'INVALID_SOURCE_SPEC',
      'source spec must be an exact plain object',
      'source',
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const kindDescriptor = descriptors['kind'];
  if (kindDescriptor === undefined || !('value' in kindDescriptor)) {
    resolutionError(
      'INVALID_SOURCE_SPEC',
      'source spec kind must be an own data property',
      'source.kind',
    );
  }
  const expectedKeys = kindDescriptor.value === 'github-ref'
    ? ['kind', 'owner', 'repo', 'ref', 'repositoryUrl']
    : kindDescriptor.value === 'github-release-asset'
      ? [
        'kind',
        'owner',
        'repo',
        'ref',
        'assetName',
        'repositoryUrl',
        'assetUrl',
      ]
      : [];
  const ownKeys = Reflect.ownKeys(value);
  if (
    expectedKeys.length === 0
    || ownKeys.length !== expectedKeys.length
    || ownKeys.some(
      (key) => typeof key !== 'string' || !expectedKeys.includes(key),
    )
    || expectedKeys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined
        || !('value' in descriptor)
        || typeof descriptor.value !== 'string';
    })
  ) {
    resolutionError(
      'INVALID_SOURCE_SPEC',
      'source spec must contain exactly the canonical own data properties',
      'source',
    );
  }
  return Object.fromEntries(
    expectedKeys.map((key) => [key, descriptors[key]!.value]),
  ) as Record<string, string>;
}

async function resolveCommit(
  port: GithubTemplateSourceMetadataPort,
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  const payload = await callMetadataPort(
    () => port.resolveRefToCommit(Object.freeze({ owner, repo, ref })),
  );
  return normalizeValidationBoundary(
    'INVALID_REF_METADATA',
    'ref metadata failed strict validation',
    () => {
      const record = requirePlainRecord(
        payload,
        ['commit'],
        'INVALID_REF_METADATA',
        'ref metadata',
      );
      const commit = record['commit'];
      if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
        resolutionError(
          'INVALID_REF_METADATA',
          'resolved commit must be lowercase hexadecimal 40',
          'ref.commit',
        );
      }
      return commit;
    },
  );
}

function parseDescriptorPayload(
  payload: unknown,
): ProjectTemplateSourceDescriptorV1 {
  return normalizeValidationBoundary(
    'INVALID_DESCRIPTOR',
    'descriptor payload failed strict validation',
    () => {
      if (!(typeof payload === 'string' || payload instanceof Uint8Array)) {
        resolutionError(
          'INVALID_DESCRIPTOR',
          'descriptor payload must be bounded UTF-8 bytes or string',
          'descriptor',
        );
      }
      try {
        return parseProjectTemplateSourceDescriptorJson(payload);
      } catch {
        resolutionError(
          'INVALID_DESCRIPTOR',
          'descriptor payload failed strict validation',
          'descriptor',
        );
      }
    },
  );
}

function parseReleaseMetadata(payload: unknown): ParsedRelease {
  const release = requirePlainRecord(
    payload,
    ['id', 'tagName', 'assets'],
    'INVALID_RELEASE_METADATA',
    'release',
  );
  const id = requireBoundedId(
    release['id'],
    'release.id',
    'INVALID_RELEASE_METADATA',
  );
  const tagName = requireMetadataName(
    release['tagName'],
    'release.tagName',
  );
  const rawAssets = requireDenseArray(
    release['assets'],
    MAX_RELEASE_ASSETS,
    'release.assets',
  );
  const seenIds = new Set<number>();
  const assets = rawAssets.map((value, index) => {
    const field = `release.assets[${index}]`;
    const asset = requirePlainRecord(
      value,
      ['id', 'name', 'size'],
      'INVALID_RELEASE_METADATA',
      field,
    );
    const assetId = requireBoundedId(
      asset['id'],
      `${field}.id`,
      'INVALID_RELEASE_METADATA',
    );
    if (seenIds.has(assetId)) {
      resolutionError(
        'INVALID_RELEASE_METADATA',
        'release assets must have unique IDs',
        'release.assets',
      );
    }
    seenIds.add(assetId);
    const size = asset['size'];
    if (
      typeof size !== 'number'
      || !Number.isSafeInteger(size)
      || size < 0
    ) {
      resolutionError(
        'INVALID_RELEASE_METADATA',
        'release asset size must be a non-negative safe integer',
        `${field}.size`,
      );
    }
    return {
      id: assetId,
      name: requireMetadataName(asset['name'], `${field}.name`),
      size,
    };
  });
  return { id, tagName, assets };
}

function selectUniqueAsset(
  assets: readonly ParsedReleaseAsset[],
  name: string,
): ParsedReleaseAsset {
  const matches = assets.filter((asset) => asset.name === name);
  if (matches.length === 0) {
    resolutionError(
      'ASSET_NOT_FOUND',
      'required release asset is missing',
      'release.assets',
    );
  }
  if (matches.length !== 1) {
    resolutionError(
      'ASSET_AMBIGUOUS',
      'required release asset name is not unique',
      'release.assets',
    );
  }
  return matches[0]!;
}

function parseChecksumPayload(payload: unknown, expectedSize: number): string {
  let bytes: number;
  let text: string;
  if (typeof payload === 'string') {
    bytes = Buffer.byteLength(payload, 'utf8');
    text = payload;
  } else if (payload instanceof Uint8Array) {
    bytes = payload.byteLength;
    try {
      text = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(payload);
    } catch {
      resolutionError(
        'INVALID_CHECKSUM',
        'checksum asset must be valid UTF-8',
        'checksum',
      );
    }
  } else {
    resolutionError(
      'INVALID_CHECKSUM',
      'checksum asset must be bytes or string',
      'checksum',
    );
  }
  if (bytes > MAX_CHECKSUM_BYTES || bytes !== expectedSize) {
    resolutionError(
      'INVALID_CHECKSUM',
      'checksum payload size does not match release metadata',
      'checksum',
    );
  }
  return text;
}

function parseCanonicalChecksum(text: string, assetName: string): string {
  const match = /^([a-f0-9]{64})[ ]{2}([A-Za-z0-9][A-Za-z0-9._-]*\.taktpack)\n$/
    .exec(text);
  if (match === null || match[2] !== assetName) {
    resolutionError(
      'INVALID_CHECKSUM',
      'checksum must be one canonical SHA-256 line for the exact asset',
      'checksum',
    );
  }
  return match[1]!;
}

function classifyUpdate(
  descriptor: ProjectTemplateSourceDescriptorV1,
  commit: string,
  descriptorSha256: string,
  source: ProjectTemplateGithubSourceSpec,
  currentValue: GithubTemplateCurrentSourceEvidence | undefined,
): Pick<
ResolvedGithubTemplateSource,
'updateState' | 'hardBlocked' | 'downloadEligible'
> {
  if (currentValue === undefined) {
    return updateFlags('update-available');
  }
  const current = normalizeValidationBoundary(
    'INVALID_CURRENT_EVIDENCE',
    'current evidence failed strict validation',
    () => parseCurrentEvidence(currentValue),
  );
  if (
    current.owner !== source.owner
    || current.repo !== source.repo
    || current.repositoryUrl !== source.repositoryUrl
    || current.canonicalSource !== canonicalizeSourceSpec(source)
  ) {
    return updateFlags('source-changed');
  }
  const precedence = compareSemVer(descriptor.pack.version, current.version);
  if (precedence > 0) return updateFlags('update-available');
  if (precedence < 0) return updateFlags('downgrade');
  if (
    descriptor.pack.version === current.version
    && descriptor.pack.sha256 === current.sha256
    && commit === current.commit
    && descriptorSha256 === current.descriptorSha256
  ) {
    return updateFlags('up-to-date');
  }
  return updateFlags('version-republished');
}

function parseCurrentEvidence(
  value: GithubTemplateCurrentSourceEvidence,
): GithubTemplateCurrentSourceEvidence {
  const record = requirePlainRecord(
    value,
    [
      'owner',
      'repo',
      'repositoryUrl',
      'canonicalSource',
      'version',
      'sha256',
      'commit',
      'descriptorSha256',
    ],
    'INVALID_CURRENT_EVIDENCE',
    'current',
  );
  let version: string;
  try {
    version = requireSemVer(record['version'], 'current.version');
  } catch {
    resolutionError(
      'INVALID_CURRENT_EVIDENCE',
      'current version must be strict SemVer',
      'current.version',
    );
  }
  const sha256 = requireEvidenceHash(record['sha256'], 'current.sha256');
  const descriptorSha256 = requireEvidenceHash(
    record['descriptorSha256'],
    'current.descriptorSha256',
  );
  const commit = record['commit'];
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    resolutionError(
      'INVALID_CURRENT_EVIDENCE',
      'current commit must be lowercase hexadecimal 40',
      'current.commit',
    );
  }
  const owner = record['owner'];
  const repo = record['repo'];
  const repositoryUrl = record['repositoryUrl'];
  const canonicalSource = record['canonicalSource'];
  if (
    typeof owner !== 'string'
    || typeof repo !== 'string'
    || typeof repositoryUrl !== 'string'
    || typeof canonicalSource !== 'string'
  ) {
    resolutionError(
      'INVALID_CURRENT_EVIDENCE',
      'current repository identity must be canonical strings',
      'current',
    );
  }
  let parsedCanonicalSource: ProjectTemplateGithubSourceSpec;
  try {
    parsedCanonicalSource = parseProjectTemplateGithubSourceSpec(
      canonicalSource,
    );
  } catch {
    resolutionError(
      'INVALID_CURRENT_EVIDENCE',
      'current canonical source must be a strict GitHub source',
      'current.canonicalSource',
    );
  }
  if (
    canonicalizeSourceSpec(parsedCanonicalSource) !== canonicalSource
    || parsedCanonicalSource.owner !== owner
    || parsedCanonicalSource.repo !== repo
    || parsedCanonicalSource.repositoryUrl !== repositoryUrl
  ) {
    resolutionError(
      'INVALID_CURRENT_EVIDENCE',
      'current canonical source must match its repository identity',
      'current.canonicalSource',
    );
  }
  return {
    owner,
    repo,
    repositoryUrl: parsedCanonicalSource.repositoryUrl,
    canonicalSource,
    version,
    sha256,
    commit,
    descriptorSha256,
  };
}

function updateFlags(
  state: GithubTemplateUpdateState,
): Pick<
ResolvedGithubTemplateSource,
'updateState' | 'hardBlocked' | 'downloadEligible'
> {
  return {
    updateState: state,
    hardBlocked: state === 'version-republished' || state === 'downgrade',
    downloadEligible:
      state === 'update-available' || state === 'source-changed',
  };
}

function canonicalizeSourceSpec(
  source: ProjectTemplateGithubSourceSpec,
): string {
  if (source.kind === 'github-release-asset') return source.assetUrl;
  return `github:${source.owner}/${source.repo}@${source.ref}`;
}

function normalizeValidationBoundary<T>(
  code: GithubTemplateSourceResolutionErrorCode,
  message: string,
  validate: () => T,
): T {
  try {
    return validate();
  } catch {
    resolutionError(code, message);
  }
}

function requireEvidenceHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    resolutionError(
      'INVALID_CURRENT_EVIDENCE',
      `${field} must be lowercase SHA-256`,
      field,
    );
  }
  return value;
}

function requireMetadataName(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_METADATA_NAME_LENGTH
    || Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    resolutionError(
      'INVALID_RELEASE_METADATA',
      `${field} must be a bounded control-free string`,
      field,
    );
  }
  return value;
}

function requireBoundedId(
  value: unknown,
  field: string,
  code: GithubTemplateSourceResolutionErrorCode,
): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value <= 0
  ) {
    resolutionError(
      code,
      `${field} must be a positive safe integer`,
      field,
    );
  }
  return value;
}

function requirePlainRecord(
  value: unknown,
  allowedKeys: readonly string[],
  code: GithubTemplateSourceResolutionErrorCode,
  field: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    resolutionError(code, `${field} must be a plain object`, field);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== allowedKeys.length
    || ownKeys.some(
      (key) => typeof key !== 'string' || !allowedKeys.includes(key),
    )
    || Object.values(descriptors).some(
      (descriptor) => !('value' in descriptor),
    )
  ) {
    resolutionError(code, `${field} must contain only data properties`, field);
  }
  const record = value as Record<string, unknown>;
  return record;
}

function requireDenseArray(
  value: unknown,
  maxItems: number,
  field: string,
): unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maxItems
  ) {
    resolutionError(
      'INVALID_RELEASE_METADATA',
      `${field} must be a bounded plain array`,
      field,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor)) {
      resolutionError(
        'INVALID_RELEASE_METADATA',
        `${field} must be a dense data array`,
        field,
      );
    }
  }
  if (Reflect.ownKeys(value).some((key) => {
    if (key === 'length') return false;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return true;
    return Number(key) >= value.length;
  })) {
    resolutionError(
      'INVALID_RELEASE_METADATA',
      `${field} must not have extra properties`,
      field,
    );
  }
  return value;
}

async function callMetadataPort(
  call: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await call();
  } catch {
    // Never retain provider errors: they may contain tokens or raw stderr.
    resolutionError(
      'METADATA_PORT_FAILURE',
      'GitHub metadata operation failed',
    );
  }
}

function resolutionError(
  code: GithubTemplateSourceResolutionErrorCode,
  message: string,
  field?: string,
): never {
  const error = new GithubTemplateSourceResolutionError(
    code,
    message,
    field,
  );
  // Resolution errors cross trust boundaries, so keep their public diagnostic
  // fields immutable after the caller can observe them.
  Object.freeze(error);
  throw error;
}
