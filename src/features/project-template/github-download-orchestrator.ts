import { types } from 'node:util';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  inspectProjectTemplateApplyGuard,
} from './apply-guard.js';
import {
  acquireProjectTemplateMutationLease,
  assertProjectTemplateMutationLeaseOwned,
  type ProjectTemplateMutationLease,
} from './apply-lease.js';
import {
  discardStagedGithubTemplateDownload,
  materializeGithubTemplateCache,
  stageGithubTemplateDownload,
  type StagedGithubTemplateDownload,
} from './github-download-storage.js';
import {
  prepareGithubTemplateDownloadReceipt,
  type GithubTemplateDownloadReceiptAuthenticator,
} from './github-download-receipt.js';
import {
  storeGithubTemplateDownloadReceipt,
  type GithubTemplateDownloadReceiptState,
  type GithubTemplateDownloadReceiptVerifier,
} from './github-download-receipt-storage.js';
import {
  parseProjectTemplateGithubSourceSpec,
  type ProjectTemplateGithubSourceSpec,
} from './github-source-spec.js';
import {
  claimResolvedGithubTemplateSourceForDownload,
  discardResolvedGithubTemplateSourceDownloadClaim,
  resolveGithubTemplateSource,
  type ClaimedResolvedGithubTemplateSourceForDownload,
  type GithubTemplateCurrentSourceEvidence,
  type GithubTemplateSourceMetadataPort,
  type ResolvedGithubTemplateSource,
} from './github-update-check.js';

const RESOLVED_FIELDS = [
  'kind',
  'owner',
  'repo',
  'repositoryUrl',
  'canonicalSource',
  'requestedRef',
  'releaseTag',
  'commit',
  'descriptorSha256',
  'releaseId',
  'assetId',
  'assetName',
  'assetSize',
  'checksumAssetId',
  'checksumAssetName',
  'checksumAssetSize',
  'sha256',
  'version',
  'declaredDependencies',
  'updateState',
  'hardBlocked',
  'downloadEligible',
] as const;
const CURRENT_FIELDS = [
  'owner',
  'repo',
  'repositoryUrl',
  'canonicalSource',
  'version',
  'sha256',
  'commit',
  'descriptorSha256',
] as const;
const METADATA_METHODS = [
  'resolveRefToCommit',
  'readFileAtCommit',
  'getReleaseByTag',
  'readReleaseAsset',
] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export type GithubTemplateDownloadOrchestratorErrorCode =
  | 'INVALID_ARGUMENT'
  | 'DOWNLOAD_NOT_ELIGIBLE'
  | 'GUARD_BLOCKED'
  | 'COORDINATION_FAILED'
  | 'SOURCE_RESOLUTION_FAILED'
  | 'SOURCE_DRIFT'
  | 'DOWNLOAD_PORT_FAILURE'
  | 'STAGING_FAILED'
  | 'ABORTED'
  | 'LEASE_LOST'
  | 'CACHE_FAILED'
  | 'RECEIPT_FAILED'
  | 'RECEIPT_STORAGE_FAILED'
  | 'CLEANUP_FAILED'
  | 'LEASE_RELEASE_FAILED'
  | 'INTERNAL_FAILURE';

export class GithubTemplateDownloadOrchestratorError extends Error {
  constructor(
    public readonly code: GithubTemplateDownloadOrchestratorErrorCode,
    message: string,
    public readonly artifactState?:
      | 'none'
      | 'staging-only'
      | 'cache-published',
    public readonly receiptState?: GithubTemplateDownloadReceiptState,
    public readonly releaseState?: 'uncertain',
    public readonly cleanupState?: 'failed',
  ) {
    super(message);
    this.name = 'GithubTemplateDownloadOrchestratorError';
  }
}

export interface GithubTemplateArchiveAssetInput {
  readonly owner: string;
  readonly repo: string;
  readonly releaseId: number;
  readonly assetId: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface GithubTemplateArchiveAssetPort {
  openReleaseAsset(
    input: GithubTemplateArchiveAssetInput,
  ): AsyncIterable<Uint8Array>;
}

export interface DownloadGithubTemplateSourceOptions {
  readonly projectRoot: string;
  readonly source: string;
  readonly advisory: ResolvedGithubTemplateSource;
  readonly metadata: GithubTemplateSourceMetadataPort;
  readonly asset: GithubTemplateArchiveAssetPort;
  readonly cacheRoot: string;
  readonly authenticator: GithubTemplateDownloadReceiptAuthenticator;
  readonly verifier: GithubTemplateDownloadReceiptVerifier;
  readonly current?: GithubTemplateCurrentSourceEvidence;
  readonly signal?: AbortSignal;
}

export interface DownloadedGithubTemplateSource {
  readonly status: 'downloaded';
  readonly commit: string;
  readonly version: string;
  readonly sha256: string;
  readonly receiptKey: string;
  readonly cacheStatus: 'cache-hit' | 'cache-published';
  readonly receiptStatus: 'stored' | 'existing';
  readonly artifactState: 'cache-published';
  readonly receiptState: 'receipt-published';
  readonly bytes: number;
  readonly directoryDurability: 'synced' | 'unsupported';
}

interface OptionsSnapshot {
  readonly projectRoot: string;
  readonly source: ProjectTemplateGithubSourceSpec;
  readonly advisory: ResolvedSnapshot;
  readonly metadata: GithubTemplateSourceMetadataPort;
  readonly assetReceiver: GithubTemplateArchiveAssetPort;
  readonly openReleaseAsset: GithubTemplateArchiveAssetPort['openReleaseAsset'];
  readonly current?: GithubTemplateCurrentSourceEvidence;
  readonly cacheRoot: string;
  readonly authenticator: GithubTemplateDownloadReceiptAuthenticator;
  readonly verifier: GithubTemplateDownloadReceiptVerifier;
  readonly signal?: AbortSignal;
  readonly aborted: () => boolean;
}

type ResolvedSnapshot = {
  readonly [Key in typeof RESOLVED_FIELDS[number]]:
    ResolvedGithubTemplateSource[Key];
};

function orchestratorError(
  code: GithubTemplateDownloadOrchestratorErrorCode,
  message: string,
  artifactState?: 'none' | 'staging-only' | 'cache-published',
  receiptState?: GithubTemplateDownloadReceiptState,
  releaseState?: 'uncertain',
  cleanupState?: 'failed',
): GithubTemplateDownloadOrchestratorError {
  return Object.freeze(
    new GithubTemplateDownloadOrchestratorError(
      code,
      message,
      artifactState,
      receiptState,
      releaseState,
      cleanupState,
    ),
  );
}

function ownDataRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.includes(key))
    || required.some((key) => descriptors[key] === undefined)
    || Object.values(descriptors).some(
      (descriptor) => !('value' in descriptor),
    )
  ) throw new Error();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function snapshotDependency(value: unknown): ResolvedGithubTemplateSource[
  'declaredDependencies'
][number] {
  const dependency = ownDataRecord(value, [
    'scope',
    'version',
    'source',
    'commit',
    'capabilities',
  ]);
  const capabilities = snapshotDenseDataArray(
    dependency['capabilities'],
    1,
  );
  if (
    typeof dependency['scope'] !== 'string'
    || typeof dependency['version'] !== 'string'
    || typeof dependency['source'] !== 'string'
    || typeof dependency['commit'] !== 'string'
    || !COMMIT_PATTERN.test(dependency['commit'])
    || capabilities.length !== 1
    || capabilities[0] !== 'edit'
  ) throw new Error();
  return Object.freeze({
    scope: dependency['scope'] as `@${string}/${string}`,
    version: dependency['version'] as string,
    source: dependency['source'] as `github:${string}/${string}@${string}`,
    commit: dependency['commit'] as string,
    capabilities: Object.freeze(['edit'] as const),
  });
}

function snapshotDenseDataArray(
  value: unknown,
  maxLength: number,
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors['length'];
  const lengthValue = lengthDescriptor?.value;
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || typeof lengthValue !== 'number'
    || !Number.isSafeInteger(lengthValue)
    || lengthValue < 0
    || lengthValue > maxLength
  ) throw new Error();
  const length = lengthValue;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1
    || keys.some((key) => (
      typeof key !== 'string'
      || (
        key !== 'length'
        && (
          !/^(0|[1-9]\d*)$/.test(key)
          || Number(key) >= length
        )
      )
    ))
  ) throw new Error();
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error();
    }
    copy[index] = descriptor.value;
  }
  return Object.freeze(copy);
}

function snapshotResolved(value: unknown): ResolvedSnapshot {
  const resolved = ownDataRecord(value, RESOLVED_FIELDS);
  const dependencies = snapshotDenseDataArray(
    resolved['declaredDependencies'],
    256,
  );
  if (
    resolved['kind'] !== 'resolved-github-template-source'
    || [
      'owner',
      'repo',
      'repositoryUrl',
      'canonicalSource',
      'requestedRef',
      'releaseTag',
      'commit',
      'descriptorSha256',
      'assetName',
      'checksumAssetName',
      'sha256',
      'version',
      'updateState',
    ].some((field) => typeof resolved[field] !== 'string')
    || !COMMIT_PATTERN.test(resolved['commit'] as string)
    || !SHA256_PATTERN.test(resolved['descriptorSha256'] as string)
    || !SHA256_PATTERN.test(resolved['sha256'] as string)
    || [
      'releaseId',
      'assetId',
      'assetSize',
      'checksumAssetId',
      'checksumAssetSize',
    ].some((field) => (
      !Number.isSafeInteger(resolved[field])
      || (resolved[field] as number) <= 0
    ))
    || typeof resolved['downloadEligible'] !== 'boolean'
    || typeof resolved['hardBlocked'] !== 'boolean'
  ) throw new Error();
  const dependencySnapshots: Array<
    ResolvedGithubTemplateSource['declaredDependencies'][number]
  > = [];
  for (let index = 0; index < dependencies.length; index += 1) {
    dependencySnapshots[index] = snapshotDependency(dependencies[index]);
  }
  return Object.freeze({
    ...resolved,
    declaredDependencies: Object.freeze(dependencySnapshots),
  }) as ResolvedSnapshot;
}

function snapshotCurrent(
  value: unknown,
): GithubTemplateCurrentSourceEvidence | undefined {
  if (value === undefined) return undefined;
  const current = ownDataRecord(value, CURRENT_FIELDS);
  if (
    CURRENT_FIELDS.some((field) => typeof current[field] !== 'string')
    || !SHA256_PATTERN.test(current['sha256'] as string)
    || !SHA256_PATTERN.test(current['descriptorSha256'] as string)
    || !COMMIT_PATTERN.test(current['commit'] as string)
  ) throw new Error();
  return Object.freeze(current) as unknown as GithubTemplateCurrentSourceEvidence;
}

function snapshotMetadata(value: unknown): GithubTemplateSourceMetadataPort {
  const methods = ownDataRecord(value, METADATA_METHODS);
  if (
    METADATA_METHODS.some(
      (method) => typeof methods[method] !== 'function',
    )
  ) throw new Error();
  const receiver = value as GithubTemplateSourceMetadataPort;
  return Object.freeze({
    resolveRefToCommit: (
      input: Parameters<GithubTemplateSourceMetadataPort[
        'resolveRefToCommit'
      ]>[0],
    ) => Reflect.apply(
      methods['resolveRefToCommit'] as
        GithubTemplateSourceMetadataPort['resolveRefToCommit'],
      receiver,
      [input],
    ) as Promise<unknown>,
    readFileAtCommit: (
      input: Parameters<GithubTemplateSourceMetadataPort[
        'readFileAtCommit'
      ]>[0],
    ) => Reflect.apply(
      methods['readFileAtCommit'] as
        GithubTemplateSourceMetadataPort['readFileAtCommit'],
      receiver,
      [input],
    ) as Promise<unknown>,
    getReleaseByTag: (
      input: Parameters<GithubTemplateSourceMetadataPort[
        'getReleaseByTag'
      ]>[0],
    ) => Reflect.apply(
      methods['getReleaseByTag'] as
        GithubTemplateSourceMetadataPort['getReleaseByTag'],
      receiver,
      [input],
    ) as Promise<unknown>,
    readReleaseAsset: (
      input: Parameters<GithubTemplateSourceMetadataPort[
        'readReleaseAsset'
      ]>[0],
    ) => Reflect.apply(
      methods['readReleaseAsset'] as
        GithubTemplateSourceMetadataPort['readReleaseAsset'],
      receiver,
      [input],
    ) as Promise<unknown>,
  });
}

function snapshotAuthenticator(
  value: unknown,
): GithubTemplateDownloadReceiptAuthenticator {
  const record = ownDataRecord(value, ['acquireSigningKey']);
  if (typeof record['acquireSigningKey'] !== 'function') throw new Error();
  const receiver = value as GithubTemplateDownloadReceiptAuthenticator;
  return Object.freeze({
    acquireSigningKey: () => Reflect.apply(
      record['acquireSigningKey'] as
        GithubTemplateDownloadReceiptAuthenticator['acquireSigningKey'],
      receiver,
      [],
    ) as Promise<unknown>,
  });
}

function snapshotVerifier(
  value: unknown,
): GithubTemplateDownloadReceiptVerifier {
  const record = ownDataRecord(value, ['verify']);
  if (typeof record['verify'] !== 'function') throw new Error();
  const receiver = value as GithubTemplateDownloadReceiptVerifier;
  return Object.freeze({
    verify: (
      request: Parameters<GithubTemplateDownloadReceiptVerifier['verify']>[0],
    ) => Reflect.apply(
      record['verify'] as GithubTemplateDownloadReceiptVerifier['verify'],
      receiver,
      [request],
    ) as Promise<'valid' | 'invalid' | 'unavailable'>,
  });
}

function snapshotSignal(value: unknown): {
  readonly signal?: AbortSignal;
  readonly aborted: () => boolean;
} {
  if (value === undefined) return { aborted: () => false };
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
  ) throw new Error();
  const getter = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    'aborted',
  )?.get;
  if (getter === undefined) throw new Error();
  Reflect.apply(getter, value, []);
  return {
    signal: value as AbortSignal,
    aborted: () => Reflect.apply(getter, value, []) as boolean,
  };
}

function snapshotOptions(value: unknown): OptionsSnapshot {
  try {
    const optionFields = [
      'projectRoot',
      'source',
      'advisory',
      'metadata',
      'asset',
      'cacheRoot',
      'authenticator',
      'verifier',
      'current',
      'signal',
    ] as const;
    const options = ownDataRecord(
      value,
      optionFields,
      optionFields.filter(
        (key) => key !== 'current' && key !== 'signal',
      ),
    );
    const projectRoot = options['projectRoot'];
    const source = options['source'];
    const cacheRoot = options['cacheRoot'];
    if (
      typeof projectRoot !== 'string'
      || typeof source !== 'string'
      || typeof cacheRoot !== 'string'
    ) {
      throw new Error();
    }
    const advisory = snapshotResolved(options['advisory']);
    const metadata = snapshotMetadata(options['metadata']);
    const assetRecord = ownDataRecord(options['asset'], ['openReleaseAsset']);
    if (typeof assetRecord['openReleaseAsset'] !== 'function') {
      throw new Error();
    }
    const signal = snapshotSignal(options['signal']);
    return Object.freeze({
      projectRoot,
      source: parseProjectTemplateGithubSourceSpec(source),
      cacheRoot,
      advisory,
      metadata,
      authenticator: snapshotAuthenticator(options['authenticator']),
      verifier: snapshotVerifier(options['verifier']),
      assetReceiver: options['asset'] as GithubTemplateArchiveAssetPort,
      openReleaseAsset:
        assetRecord['openReleaseAsset'] as
          GithubTemplateArchiveAssetPort['openReleaseAsset'],
      ...(options['current'] === undefined
        ? {}
        : { current: snapshotCurrent(options['current']) }),
      ...(signal.signal === undefined ? {} : { signal: signal.signal }),
      aborted: signal.aborted,
    });
  } catch {
    throw orchestratorError(
      'INVALID_ARGUMENT',
      'GitHub template download options are invalid',
    );
  }
}

function dependenciesEqual(
  left: ResolvedGithubTemplateSource['declaredDependencies'],
  right: ResolvedGithubTemplateSource['declaredDependencies'],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const dependency = left[index]!;
    const candidate = right[index]!;
    if (
      dependency.scope !== candidate.scope
      || dependency.version !== candidate.version
      || dependency.source !== candidate.source
      || dependency.commit !== candidate.commit
      || dependency.capabilities.length !== candidate.capabilities.length
    ) return false;
    for (
      let capabilityIndex = 0;
      capabilityIndex < dependency.capabilities.length;
      capabilityIndex += 1
    ) {
      if (
        dependency.capabilities[capabilityIndex]
          !== candidate.capabilities[capabilityIndex]
      ) return false;
    }
  }
  return true;
}

function resolvedExactlyMatches(
  advisory: ResolvedSnapshot,
  fresh: ResolvedGithubTemplateSource,
): boolean {
  let freshSnapshot: ResolvedSnapshot;
  try {
    freshSnapshot = snapshotResolved(fresh);
  } catch {
    return false;
  }
  for (const field of RESOLVED_FIELDS) {
    if (field === 'declaredDependencies') {
      if (!dependenciesEqual(
        advisory.declaredDependencies,
        freshSnapshot.declaredDependencies,
      )) return false;
      continue;
    }
    if (advisory[field] !== freshSnapshot[field]) return false;
  }
  return true;
}

function requireGuardPassed(
  projectRoot: string,
  lease?: ProjectTemplateMutationLease,
): void {
  const report = inspectProjectTemplateApplyGuard({
    repoPath: projectRoot,
    ...(lease === undefined ? {} : { ownedLease: lease }),
  });
  if (!report.passed) {
    throw orchestratorError(
      'GUARD_BLOCKED',
      'GitHub template download is blocked by active project state',
    );
  }
}

function requireCanonicalDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (
      resolve(path) !== path
      || realpathSync.native(path) !== path
      || stat.isSymbolicLink()
      || !stat.isDirectory()
    ) throw new Error();
  } catch {
    throw orchestratorError(
      'INVALID_ARGUMENT',
      'GitHub template download directory is invalid',
    );
  }
}

function throwIfAborted(snapshot: OptionsSnapshot): void {
  let aborted = true;
  try {
    aborted = snapshot.aborted();
  } catch {
    // Treat a signal whose state is no longer readable as cancellation.
  }
  if (aborted) {
    throw orchestratorError(
      'ABORTED',
      'GitHub template download was cancelled',
    );
  }
}

function readArtifactState(
  error: unknown,
): 'none' | 'staging-only' | 'cache-published' {
  if (
    typeof error === 'object'
    && error !== null
    && 'artifactState' in error
  ) {
    if (error.artifactState === 'cache-published') return 'cache-published';
    if (error.artifactState === 'staging-only') return 'staging-only';
  }
  return 'none';
}

function readReceiptState(
  error: unknown,
): GithubTemplateDownloadReceiptState {
  if (
    typeof error === 'object'
    && error !== null
    && 'receiptState' in error
    && (
      error.receiptState === 'none'
      || error.receiptState === 'temporary-only'
      || error.receiptState === 'receipt-present'
      || error.receiptState === 'receipt-published'
    )
  ) return error.receiptState;
  return 'none';
}

/**
 * No low-level authority crosses this boundary. In particular, the staged
 * discard checkpoint is disarmed at the synchronous materialize invocation:
 * materialize owns the authority from that moment and cleanup must not race it.
 */
export async function downloadGithubTemplateSource(
  value: DownloadGithubTemplateSourceOptions,
): Promise<DownloadedGithubTemplateSource> {
  const snapshot = snapshotOptions(value);
  requireCanonicalDirectory(snapshot.projectRoot);
  requireCanonicalDirectory(snapshot.cacheRoot);
  if (
    !snapshot.advisory.downloadEligible
    || snapshot.advisory.hardBlocked
  ) {
    throw orchestratorError(
      'DOWNLOAD_NOT_ELIGIBLE',
      'GitHub template source is not eligible for download',
    );
  }
  throwIfAborted(snapshot);
  requireGuardPassed(snapshot.projectRoot);

  let lease: ProjectTemplateMutationLease | undefined;
  let staged: StagedGithubTemplateDownload | undefined;
  let downloadClaim:
    ClaimedResolvedGithubTemplateSourceForDownload | undefined;
  let failure: GithubTemplateDownloadOrchestratorError | undefined;
  let result: DownloadedGithubTemplateSource | undefined;
  try {
    try {
      lease = acquireProjectTemplateMutationLease(
        snapshot.projectRoot,
        'download',
      );
      assertProjectTemplateMutationLeaseOwned(snapshot.projectRoot, lease);
      requireGuardPassed(snapshot.projectRoot, lease);
      assertProjectTemplateMutationLeaseOwned(snapshot.projectRoot, lease);
    } catch (error) {
      if (error instanceof GithubTemplateDownloadOrchestratorError) throw error;
      throw orchestratorError(
        'COORDINATION_FAILED',
        'GitHub template download coordination failed',
      );
    }

    let fresh: ResolvedGithubTemplateSource;
    try {
      fresh = await resolveGithubTemplateSource({
        source: snapshot.source,
        metadata: snapshot.metadata,
        ...(snapshot.current === undefined
          ? {}
          : { current: snapshot.current }),
      });
    } catch {
      throw orchestratorError(
        'SOURCE_RESOLUTION_FAILED',
        'GitHub template source resolution failed',
      );
    }
    try {
      assertProjectTemplateMutationLeaseOwned(snapshot.projectRoot, lease);
    } catch {
      throw orchestratorError(
        'LEASE_LOST',
        'GitHub template download lease was lost',
      );
    }
    if (!resolvedExactlyMatches(snapshot.advisory, fresh)) {
      throw orchestratorError(
        'SOURCE_DRIFT',
        'GitHub template source changed before download',
      );
    }
    if (!fresh.downloadEligible || fresh.hardBlocked) {
      throw orchestratorError(
        'DOWNLOAD_NOT_ELIGIBLE',
        'GitHub template source is not eligible for download',
      );
    }

    throwIfAborted(snapshot);
    try {
      assertProjectTemplateMutationLeaseOwned(snapshot.projectRoot, lease);
    } catch {
      throw orchestratorError(
        'LEASE_LOST',
        'GitHub template download lease was lost',
      );
    }
    try {
      downloadClaim = claimResolvedGithubTemplateSourceForDownload(fresh);
    } catch {
      throw orchestratorError(
        'SOURCE_RESOLUTION_FAILED',
        'GitHub template source resolution failed',
      );
    }
    const sealed = downloadClaim.resolved;
    let chunks: AsyncIterable<Uint8Array>;
    try {
      chunks = Reflect.apply(
        snapshot.openReleaseAsset,
        snapshot.assetReceiver,
        [Object.freeze({
          owner: sealed.owner,
          repo: sealed.repo,
          releaseId: sealed.releaseId,
          assetId: sealed.assetId,
          maxBytes: sealed.assetSize,
          ...(snapshot.signal === undefined
            ? {}
            : { signal: snapshot.signal }),
        })],
      );
    } catch {
      throw orchestratorError(
        'DOWNLOAD_PORT_FAILURE',
        'GitHub template archive transport failed',
      );
    }
    try {
      assertProjectTemplateMutationLeaseOwned(snapshot.projectRoot, lease);
    } catch {
      throw orchestratorError(
        'LEASE_LOST',
        'GitHub template download lease was lost',
      );
    }
    try {
      staged = await stageGithubTemplateDownload({
        projectRoot: snapshot.projectRoot,
        expectedBytes: sealed.assetSize,
        expectedSha256: sealed.sha256,
        chunks,
        ...(snapshot.signal === undefined
          ? {}
          : { signal: snapshot.signal }),
      });
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ABORTED'
      ) {
        throw orchestratorError(
          'ABORTED',
          'GitHub template download was cancelled',
          'none',
        );
      }
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'STREAM_FAILED'
      ) {
        throw orchestratorError(
          'DOWNLOAD_PORT_FAILURE',
          'GitHub template archive transport failed',
          'none',
        );
      }
      throw orchestratorError(
        'STAGING_FAILED',
        'GitHub template archive download failed',
        'none',
      );
    }
    throwIfAborted(snapshot);
    try {
      assertProjectTemplateMutationLeaseOwned(snapshot.projectRoot, lease);
    } catch {
      throw orchestratorError(
        'LEASE_LOST',
        'GitHub template download lease was lost',
      );
    }

    let materialized: Awaited<ReturnType<
      typeof materializeGithubTemplateCache
    >>;
    try {
      assertProjectTemplateMutationLeaseOwned(snapshot.projectRoot, lease);
      const materializing = materializeGithubTemplateCache({
        staged,
        cacheRoot: snapshot.cacheRoot,
      });
      // materialize synchronously claims staged before returning its Promise.
      // Disarm exactly here so finally can never race the new owner.
      staged = undefined;
      materialized = await materializing;
    } catch (error) {
      const artifactState = readArtifactState(error);
      throw orchestratorError(
        'CACHE_FAILED',
        'GitHub template cache materialization failed',
        artifactState,
      );
    }
    try {
      assertProjectTemplateMutationLeaseOwned(snapshot.projectRoot, lease);
    } catch {
      throw orchestratorError(
        'LEASE_LOST',
        'GitHub template download lease was lost',
        'cache-published',
        'none',
      );
    }
    // Materialization is the commit point: cancellation after this point must
    // not strand an authenticated cache without its durable receipt. Only
    // lease ownership can stop the tail before signing.

    let prepared: Awaited<ReturnType<
      typeof prepareGithubTemplateDownloadReceipt
    >>;
    try {
      const preparing = prepareGithubTemplateDownloadReceipt({
        downloadClaim,
        materialized,
        authenticator: snapshot.authenticator,
      });
      // Receipt preparation synchronously hands this exact claim to its own
      // finally block before its first signer await. Disarm the download
      // cleanup here so the same authority never has two cleanup owners.
      downloadClaim = undefined;
      prepared = await preparing;
    } catch {
      throw orchestratorError(
        'RECEIPT_FAILED',
        'GitHub template receipt preparation failed',
        'cache-published',
        'none',
      );
    }
    try {
      assertProjectTemplateMutationLeaseOwned(snapshot.projectRoot, lease);
    } catch {
      throw orchestratorError(
        'LEASE_LOST',
        'GitHub template download lease was lost',
        'cache-published',
        'none',
      );
    }
    let stored: Awaited<ReturnType<
      typeof storeGithubTemplateDownloadReceipt
    >>;
    try {
      stored = await storeGithubTemplateDownloadReceipt({
        prepared,
        cacheRoot: snapshot.cacheRoot,
        verifier: snapshot.verifier,
      });
    } catch (error) {
      throw orchestratorError(
        'RECEIPT_STORAGE_FAILED',
        'GitHub template receipt storage failed',
        'cache-published',
        readReceiptState(error),
      );
    }
    result = Object.freeze({
      status: 'downloaded',
      commit: sealed.commit,
      version: sealed.version,
      sha256: sealed.sha256,
      receiptKey: stored.receiptKey,
      cacheStatus: materialized.status,
      receiptStatus: stored.status,
      artifactState: 'cache-published',
      receiptState: 'receipt-published',
      bytes: sealed.assetSize,
      directoryDurability: stored.directoryDurability,
    });
  } catch (error) {
    failure = error instanceof GithubTemplateDownloadOrchestratorError
      ? error
      : orchestratorError(
        'STAGING_FAILED',
        'GitHub template download failed',
      );
  } finally {
    if (downloadClaim !== undefined) {
      // Revoke logical provenance before filesystem and lease cleanup. Even
      // if either physical cleanup later fails, the checked source can never
      // be replayed outside the lease that established its identity.
      try {
        discardResolvedGithubTemplateSourceDownloadClaim(downloadClaim);
      } catch {
        if (failure === undefined) {
          failure = orchestratorError(
            'CLEANUP_FAILED',
            'GitHub template download authority cleanup failed',
            result?.artifactState,
            result?.receiptState,
            undefined,
            'failed',
          );
        } else {
          failure = orchestratorError(
            failure.code,
            failure.message,
            failure.artifactState,
            failure.receiptState,
            failure.releaseState,
            'failed',
          );
        }
      }
    }
    if (staged !== undefined) {
      try {
        const discarded = discardStagedGithubTemplateDownload(staged);
        if (failure !== undefined && failure.artifactState !== 'none') {
          failure = orchestratorError(
            failure.code,
            failure.message,
            discarded.artifactState,
            failure.receiptState,
            failure.releaseState,
            failure.cleanupState,
          );
        }
      } catch (error) {
        const artifactState = (
          typeof error === 'object'
          && error !== null
          && 'artifactState' in error
          && error.artifactState === 'none'
        )
          ? 'none'
          : 'staging-only';
        if (failure === undefined) {
          failure = orchestratorError(
            'CLEANUP_FAILED',
            'GitHub template staging cleanup failed',
            artifactState,
            undefined,
            undefined,
            'failed',
          );
        } else if (failure.artifactState !== artifactState) {
          failure = orchestratorError(
            failure.code,
            failure.message,
            artifactState,
            failure.receiptState,
            failure.releaseState,
            'failed',
          );
        } else {
          failure = orchestratorError(
            failure.code,
            failure.message,
            failure.artifactState,
            failure.receiptState,
            failure.releaseState,
            'failed',
          );
        }
      }
    }
    if (lease !== undefined) {
      try {
        lease.release();
      } catch {
        if (failure === undefined) {
          failure = orchestratorError(
            'LEASE_RELEASE_FAILED',
            'GitHub template download lease release failed',
            result?.artifactState,
            result?.receiptState,
            'uncertain',
          );
        } else {
          failure = orchestratorError(
            failure.code,
            failure.message,
            failure.artifactState,
            failure.receiptState,
            'uncertain',
            failure.cleanupState,
          );
        }
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) {
    throw orchestratorError(
      'INTERNAL_FAILURE',
      'GitHub template download did not produce a result',
    );
  }
  return result;
}
