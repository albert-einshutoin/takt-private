import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { DEFAULT_TAKTPACK_LIMITS } from './archive-types.js';
import { calculateProjectTemplateManifestSha256 } from './binding.js';
import {
  claimMaterializedGithubTemplateCacheForReceipt,
  consumeMaterializedGithubTemplateCacheReceiptClaim,
  type MaterializedGithubTemplateCache,
} from './github-download-storage.js';
import {
  claimResolvedGithubTemplateSourceForReceipt,
  consumeResolvedGithubTemplateSourceReceiptClaim,
  type ResolvedGithubTemplateSource,
} from './github-update-check.js';
import { parseProjectTemplateGithubSourceSpec } from './github-source-spec.js';
import {
  calculateProjectTemplateSourceDescriptorSha256,
  parseProjectTemplateSourceDescriptor,
  type ProjectTemplateSourceDescriptorV1,
} from './source-descriptor.js';
import type { TemplateSource } from './types.js';
import {
  compareSemVer,
  MAX_SEMVER_LENGTH,
  MAX_SOURCE_REF_LENGTH,
  requireSemVer,
} from './validation.js';

const RECEIPT_SCHEMA_VERSION = '1.0';
const RECEIPT_KIND = 'github-template-download-receipt';
const SIGNATURE_DOMAIN =
  'takt:github-template-download-receipt:v1:pre-auth-envelope\u0000';
const RECEIPT_KEY_DOMAIN =
  'takt:github-template-download-receipt:v1:key\u0000';
const PREPARED_RECEIPT_CLAIM_BRAND: unique symbol =
  Symbol('prepared-github-template-download-receipt-claim');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ASSET_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.taktpack$/;
const CHECKSUM_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.taktpack\.sha256$/;
const MAX_ASSET_NAME_LENGTH = 255;
const MAX_CHECKSUM_NAME_LENGTH =
  MAX_ASSET_NAME_LENGTH + '.sha256'.length;
const MAX_CHECKSUM_BYTES = 4 * 1024;
export const MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES = 256 * 1024;

export type GithubTemplateDownloadReceiptErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_AUTHORITY'
  | 'BINDING_MISMATCH'
  | 'AUTHENTICATION_FAILED'
  | 'INVALID_RECEIPT';

export class GithubTemplateDownloadReceiptError extends Error {
  constructor(
    public readonly code: GithubTemplateDownloadReceiptErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GithubTemplateDownloadReceiptError';
  }
}

export interface GithubTemplateDownloadReceiptAuthenticator {
  acquireSigningKey(): Promise<unknown>;
}

export interface GithubTemplateDownloadReceiptSigningKey {
  readonly keyId: string;
  sign(input: Uint8Array): Promise<unknown>;
}

export interface GithubTemplateDownloadReceiptV1 {
  readonly schemaVersion: '1.0';
  readonly kind: 'github-template-download-receipt';
  readonly payload: {
    readonly source: {
      readonly owner: string;
      readonly repo: string;
      readonly repositoryUrl: string;
      readonly canonicalSource: string;
      readonly requestedRef: string;
      readonly releaseTag: string;
      readonly commit: string;
      readonly descriptorSha256: string;
      /**
       * Dependency entries are declarations from the authenticated descriptor.
       * They are not resolved dependency authorities.
       */
      readonly sourceDescriptor: ProjectTemplateSourceDescriptorV1;
    };
    readonly release: {
      readonly releaseId: number;
      readonly assetId: number;
      readonly assetName: string;
      readonly assetSize: number;
      readonly checksumAssetId: number;
      readonly checksumAssetName: string;
      readonly checksumAssetSize: number;
    };
    readonly archive: {
      readonly bytes: number;
      readonly sha256: string;
      readonly version: string;
      readonly manifestSha256: string;
      readonly source: TemplateSource;
      readonly takt: {
        readonly minVersion: string;
        readonly maxVersion?: string;
      };
    };
  };
  readonly authentication: {
    readonly algorithm: 'hmac-sha256';
    readonly keyId: string;
    readonly tag: string;
  };
}

export interface PrepareGithubTemplateDownloadReceiptOptions {
  readonly resolved: ResolvedGithubTemplateSource;
  readonly materialized: MaterializedGithubTemplateCache;
  readonly authenticator: GithubTemplateDownloadReceiptAuthenticator;
}

export interface PreparedGithubTemplateDownloadReceipt {
  readonly receipt: GithubTemplateDownloadReceiptV1;
  readonly serialized: string;
  readonly receiptKey: string;
}

/**
 * Opaque, single-use authority handed to the future D2 storage boundary.
 * Consumers cannot manufacture it by cloning a prepared receipt.
 */
export interface ClaimedPreparedGithubTemplateDownloadReceipt {
  readonly prepared: PreparedGithubTemplateDownloadReceipt;
  readonly [PREPARED_RECEIPT_CLAIM_BRAND]: true;
}

interface AuthenticatorSnapshot {
  readonly receiver: GithubTemplateDownloadReceiptAuthenticator;
  readonly acquireSigningKey: () => Promise<unknown>;
}

interface SigningKeySnapshot {
  readonly receiver: GithubTemplateDownloadReceiptSigningKey;
  readonly keyId: string;
  readonly sign: (input: Uint8Array) => Promise<unknown>;
}

const PREPARED_RECEIPT_AUTHORITIES = new WeakMap<
  object,
  { state: 'active' | 'consuming' | 'consumed' }
>();
const PREPARED_RECEIPT_CLAIMS = new WeakMap<
  object,
  {
    readonly prepared: PreparedGithubTemplateDownloadReceipt;
    readonly authority: { state: 'active' | 'consuming' | 'consumed' };
  }
>();

function receiptError(
  code: GithubTemplateDownloadReceiptErrorCode,
  message: string,
): GithubTemplateDownloadReceiptError {
  return Object.freeze(new GithubTemplateDownloadReceiptError(code, message));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function ownDataRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || !allowed.includes(key),
    )
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

function snapshotPrepareOptions(
  value: PrepareGithubTemplateDownloadReceiptOptions,
): {
  resolved: unknown;
  materialized: unknown;
  authenticator: AuthenticatorSnapshot;
} {
  try {
    const options = ownDataRecord(
      value,
      ['resolved', 'materialized', 'authenticator'],
    );
    const authenticator = ownDataRecord(
      options['authenticator'],
      ['acquireSigningKey'],
    );
    if (typeof authenticator['acquireSigningKey'] !== 'function') {
      throw new Error();
    }
    return {
      resolved: options['resolved'],
      materialized: options['materialized'],
      authenticator: {
        receiver:
          options['authenticator'] as GithubTemplateDownloadReceiptAuthenticator,
        acquireSigningKey:
          authenticator['acquireSigningKey'] as () => Promise<unknown>,
      },
    };
  } catch {
    throw receiptError(
      'INVALID_ARGUMENT',
      'GitHub template download receipt options are invalid',
    );
  }
}

function snapshotSigningKey(value: unknown): SigningKeySnapshot {
  try {
    const lease = ownDataRecord(value, ['keyId', 'sign']);
    if (
      typeof lease['keyId'] !== 'string'
      || !KEY_ID_PATTERN.test(lease['keyId'])
      || typeof lease['sign'] !== 'function'
    ) throw new Error();
    return Object.freeze({
      receiver: value as GithubTemplateDownloadReceiptSigningKey,
      keyId: lease['keyId'],
      sign: lease['sign'] as (input: Uint8Array) => Promise<unknown>,
    });
  } catch {
    throw receiptError(
      'AUTHENTICATION_FAILED',
      'GitHub template download receipt signing key is invalid',
    );
  }
}

function requireCrossBinding(
  resolved: ResolvedGithubTemplateSource,
  descriptor: ProjectTemplateSourceDescriptorV1,
  materialized: MaterializedGithubTemplateCache,
): void {
  const inspection = materialized.inspection;
  const manifest = inspection.manifest;
  const format = inspection.descriptor;
  const source = manifest.source;
  if (
    calculateProjectTemplateSourceDescriptorSha256(descriptor)
      !== resolved.descriptorSha256
    || descriptor.pack.sha256 !== resolved.sha256
    || descriptor.pack.version !== resolved.version
    || descriptor.pack.releaseTag !== resolved.releaseTag
    || descriptor.pack.assetName !== resolved.assetName
    || descriptor.pack.checksumAssetName !== resolved.checksumAssetName
    || materialized.sha256 !== resolved.sha256
    || materialized.bytes !== resolved.assetSize
    || inspection.archiveSha256 !== materialized.sha256
    || calculateProjectTemplateManifestSha256(manifest)
      !== inspection.manifestSha256
    || format.format !== 'taktpack'
    || format.version !== '1.0'
    || format.archive !== 'ustar'
    || format.contentAddressed !== true
    || source.kind !== 'github'
    || source.uri !== resolved.repositoryUrl
    || source.commit !== resolved.commit
    || source.ref !== resolved.releaseTag
    || manifest.packVersion !== resolved.version
    || inspection.compatibility.minVersion !== manifest.takt.minVersion
    || inspection.compatibility.maxVersion !== manifest.takt.maxVersion
  ) {
    throw receiptError(
      'BINDING_MISMATCH',
      'GitHub template download receipt provenance does not match',
    );
  }
}

function createPayload(
  resolved: ResolvedGithubTemplateSource,
  descriptor: ProjectTemplateSourceDescriptorV1,
  materialized: MaterializedGithubTemplateCache,
): GithubTemplateDownloadReceiptV1['payload'] {
  const inspection = materialized.inspection;
  return deepFreeze({
    source: {
      owner: resolved.owner,
      repo: resolved.repo,
      repositoryUrl: resolved.repositoryUrl,
      canonicalSource: resolved.canonicalSource,
      requestedRef: resolved.requestedRef,
      releaseTag: resolved.releaseTag,
      commit: resolved.commit,
      descriptorSha256: resolved.descriptorSha256,
      // Keep dependency declarations inside their signed descriptor. D1 does
      // not promote declarations into resolved dependency authorities.
      sourceDescriptor: descriptor,
    },
    release: {
      releaseId: resolved.releaseId,
      assetId: resolved.assetId,
      assetName: resolved.assetName,
      assetSize: resolved.assetSize,
      checksumAssetId: resolved.checksumAssetId,
      checksumAssetName: resolved.checksumAssetName,
      checksumAssetSize: resolved.checksumAssetSize,
    },
    archive: {
      bytes: materialized.bytes,
      sha256: materialized.sha256,
      version: resolved.version,
      manifestSha256: inspection.manifestSha256,
      source: inspection.manifest.source,
      // Compatibility status depends on the local Takt runtime. Persist only
      // the canonical manifest range so offline callers can recompute status.
      takt: inspection.manifest.takt,
    },
  });
}

function signatureInput(
  payload: GithubTemplateDownloadReceiptV1['payload'],
  keyId: string,
): Uint8Array {
  const preAuthenticationEnvelope = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    payload,
    authentication: {
      algorithm: 'hmac-sha256',
      keyId,
    },
  };
  return Buffer.from(
    `${SIGNATURE_DOMAIN}${JSON.stringify(
      preAuthenticationEnvelope,
      null,
      2,
    )}`,
    'utf8',
  );
}

export function serializeGithubTemplateDownloadReceipt(
  value: GithubTemplateDownloadReceiptV1,
): string {
  const receipt = parseReceiptStructure(value);
  const serialized = JSON.stringify(receipt, null, 2);
  if (
    Buffer.byteLength(serialized, 'utf8')
    > MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES
  ) {
    throw receiptError(
      'INVALID_RECEIPT',
      'GitHub template download receipt exceeds the size limit',
    );
  }
  return serialized;
}

function requireString(
  value: unknown,
  pattern?: RegExp,
  maxLength = Number.MAX_SAFE_INTEGER,
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || (pattern !== undefined && !pattern.test(value))
  ) throw new Error();
  return value;
}

function requirePositiveInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) <= 0
    || (value as number) > maximum
  ) throw new Error();
  return value as number;
}

function parseReceiptStructure(
  value: unknown,
): GithubTemplateDownloadReceiptV1 {
  try {
    const envelope = ownDataRecord(
      value,
      ['schemaVersion', 'kind', 'payload', 'authentication'],
    );
    if (
      Reflect.ownKeys(envelope).length !== 4
      || envelope['schemaVersion'] !== RECEIPT_SCHEMA_VERSION
      || envelope['kind'] !== RECEIPT_KIND
    ) throw new Error();
    const payload = ownDataRecord(
      envelope['payload'],
      ['source', 'release', 'archive'],
    );
    const source = ownDataRecord(payload['source'], [
      'owner',
      'repo',
      'repositoryUrl',
      'canonicalSource',
      'requestedRef',
      'releaseTag',
      'commit',
      'descriptorSha256',
      'sourceDescriptor',
    ]);
    const release = ownDataRecord(payload['release'], [
      'releaseId',
      'assetId',
      'assetName',
      'assetSize',
      'checksumAssetId',
      'checksumAssetName',
      'checksumAssetSize',
    ]);
    const archive = ownDataRecord(payload['archive'], [
      'bytes',
      'sha256',
      'version',
      'manifestSha256',
      'source',
      'takt',
    ]);
    const takt = ownDataRecord(archive['takt'], [
      'minVersion',
      'maxVersion',
    ]);
    const authentication = ownDataRecord(
      envelope['authentication'],
      ['algorithm', 'keyId', 'tag'],
    );
    const descriptor = parseProjectTemplateSourceDescriptor(
      source['sourceDescriptor'],
    );
    const archiveSource = ownDataRecord(
      archive['source'],
      ['kind', 'uri', 'ref', 'commit'],
    );
    if (
      Object.keys(payload).length !== 3
      || Object.keys(source).length !== 9
      || Object.keys(release).length !== 7
      || Object.keys(archive).length !== 6
      || authentication['algorithm'] !== 'hmac-sha256'
      || archiveSource['kind'] !== 'github'
    ) throw new Error();
    const receipt: GithubTemplateDownloadReceiptV1 = {
      schemaVersion: RECEIPT_SCHEMA_VERSION as '1.0',
      kind: RECEIPT_KIND as 'github-template-download-receipt',
      payload: {
        source: {
          owner: requireString(source['owner']),
          repo: requireString(source['repo']),
          repositoryUrl: requireString(
            source['repositoryUrl'],
            /^https:\/\/github\.com\/[^/]+\/[^/]+$/,
          ),
          canonicalSource: requireString(
            source['canonicalSource'],
            undefined,
            2048,
          ),
          requestedRef: requireString(
            source['requestedRef'],
            undefined,
            MAX_SOURCE_REF_LENGTH,
          ),
          releaseTag: requireString(
            source['releaseTag'],
            undefined,
            MAX_SOURCE_REF_LENGTH,
          ),
          commit: requireString(source['commit'], /^[a-f0-9]{40}$/),
          descriptorSha256: requireString(
            source['descriptorSha256'],
            SHA256_PATTERN,
          ),
          sourceDescriptor: descriptor,
        },
        release: {
          releaseId: requirePositiveInteger(release['releaseId']),
          assetId: requirePositiveInteger(release['assetId']),
          assetName: requireString(
            release['assetName'],
            ASSET_NAME_PATTERN,
            MAX_ASSET_NAME_LENGTH,
          ),
          assetSize: requirePositiveInteger(
            release['assetSize'],
            DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes,
          ),
          checksumAssetId: requirePositiveInteger(
            release['checksumAssetId'],
          ),
          checksumAssetName: requireString(
            release['checksumAssetName'],
            CHECKSUM_NAME_PATTERN,
            MAX_CHECKSUM_NAME_LENGTH,
          ),
          checksumAssetSize: requirePositiveInteger(
            release['checksumAssetSize'],
            MAX_CHECKSUM_BYTES,
          ),
        },
        archive: {
          bytes: requirePositiveInteger(
            archive['bytes'],
            DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes,
          ),
          sha256: requireString(archive['sha256'], SHA256_PATTERN),
          version: requireString(
            archive['version'],
            undefined,
            MAX_SEMVER_LENGTH,
          ),
          manifestSha256: requireString(
            archive['manifestSha256'],
            SHA256_PATTERN,
          ),
          source: {
            kind: 'github' as const,
            uri: requireString(archiveSource['uri']) as `https://github.com/${string}/${string}`,
            ref: requireString(
              archiveSource['ref'],
              undefined,
              MAX_SOURCE_REF_LENGTH,
            ),
            commit: requireString(
              archiveSource['commit'],
              /^[a-f0-9]{40}$/,
            ),
          },
          takt: {
            minVersion: requireString(
              takt['minVersion'],
              undefined,
              MAX_SEMVER_LENGTH,
            ),
            ...(takt['maxVersion'] === undefined
              ? {}
              : {
                maxVersion: requireString(
                  takt['maxVersion'],
                  undefined,
                  MAX_SEMVER_LENGTH,
                ),
              }),
          },
        },
      },
      authentication: {
        algorithm: 'hmac-sha256' as const,
        keyId: requireString(authentication['keyId'], KEY_ID_PATTERN),
        tag: requireString(authentication['tag'], SHA256_PATTERN),
      },
    };
    const minTaktVersion = requireSemVer(
      receipt.payload.archive.takt.minVersion,
      'receipt.payload.archive.takt.minVersion',
    );
    requireSemVer(
      receipt.payload.archive.version,
      'receipt.payload.archive.version',
    );
    const maxTaktVersion = receipt.payload.archive.takt.maxVersion === undefined
      ? undefined
      : requireSemVer(
        receipt.payload.archive.takt.maxVersion,
        'receipt.payload.archive.takt.maxVersion',
      );
    const parsedCanonicalSource = parseProjectTemplateGithubSourceSpec(
      receipt.payload.source.canonicalSource,
    );
    const descriptorPack = receipt.payload.source.sourceDescriptor.pack;
    const archiveReceipt = receipt.payload.archive;
    const sourceReceipt = receipt.payload.source;
    const releaseReceipt = receipt.payload.release;
    if (
      parsedCanonicalSource.owner !== sourceReceipt.owner
      || parsedCanonicalSource.repo !== sourceReceipt.repo
      || parsedCanonicalSource.repositoryUrl !== sourceReceipt.repositoryUrl
      || parsedCanonicalSource.ref !== sourceReceipt.requestedRef
      || (
        parsedCanonicalSource.kind === 'github-release-asset'
        && (
          parsedCanonicalSource.ref !== sourceReceipt.releaseTag
          || parsedCanonicalSource.assetName !== releaseReceipt.assetName
        )
      )
      || calculateProjectTemplateSourceDescriptorSha256(
        sourceReceipt.sourceDescriptor,
      ) !== sourceReceipt.descriptorSha256
      || descriptorPack.releaseTag !== sourceReceipt.releaseTag
      || descriptorPack.version !== archiveReceipt.version
      || descriptorPack.sha256 !== archiveReceipt.sha256
      || descriptorPack.assetName !== releaseReceipt.assetName
      || descriptorPack.checksumAssetName !== releaseReceipt.checksumAssetName
      || releaseReceipt.assetId === releaseReceipt.checksumAssetId
      || releaseReceipt.assetSize !== archiveReceipt.bytes
      || archiveReceipt.source.kind !== 'github'
      || archiveReceipt.source.uri !== sourceReceipt.repositoryUrl
      || archiveReceipt.source.ref !== sourceReceipt.releaseTag
      || archiveReceipt.source.commit !== sourceReceipt.commit
      || (
        maxTaktVersion !== undefined
        && compareSemVer(minTaktVersion, maxTaktVersion) > 0
      )
    ) throw new Error();
    return deepFreeze(receipt);
  } catch {
    throw receiptError(
      'INVALID_RECEIPT',
      'GitHub template download receipt is invalid',
    );
  }
}

/**
 * Parses the sole receipt representation and its internal bindings. This does
 * not verify the HMAC against key material; callers must not describe a parsed
 * receipt as GitHub-authentic until the key-provider verification boundary.
 */
export function parseGithubTemplateDownloadReceipt(
  input: string | Uint8Array,
): GithubTemplateDownloadReceiptV1 {
  let json: string;
  try {
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES) {
        throw new Error();
      }
      json = input;
    } else if (input instanceof Uint8Array) {
      if (input.byteLength > MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES) {
        throw new Error();
      }
      json = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(input);
    } else {
      throw new Error();
    }
    const value = JSON.parse(json) as unknown;
    const receipt = parseReceiptStructure(value);
    if (JSON.stringify(receipt, null, 2) !== json) throw new Error();
    return receipt;
  } catch {
    throw receiptError(
      'INVALID_RECEIPT',
      'GitHub template download receipt bytes are invalid',
    );
  }
}

export async function prepareGithubTemplateDownloadReceipt(
  value: PrepareGithubTemplateDownloadReceiptOptions,
): Promise<PreparedGithubTemplateDownloadReceipt> {
  const options = snapshotPrepareOptions(value);
  let resolvedClaim:
    ReturnType<typeof claimResolvedGithubTemplateSourceForReceipt> | undefined;
  let materializedClaim:
    ReturnType<typeof claimMaterializedGithubTemplateCacheForReceipt> | undefined;
  try {
    try {
      resolvedClaim = claimResolvedGithubTemplateSourceForReceipt(
        options.resolved,
      );
      materializedClaim = claimMaterializedGithubTemplateCacheForReceipt(
        options.materialized,
      );
    } catch {
      throw receiptError(
        'INVALID_AUTHORITY',
        'GitHub template download receipt authority is invalid',
      );
    }
    requireCrossBinding(
      resolvedClaim.resolved,
      resolvedClaim.descriptor,
      materializedClaim.materialized,
    );
    const payload = createPayload(
      resolvedClaim.resolved,
      resolvedClaim.descriptor,
      materializedClaim.materialized,
    );
    let signingKey: SigningKeySnapshot;
    let tag: unknown;
    try {
      const acquired = await Reflect.apply(
        options.authenticator.acquireSigningKey,
        options.authenticator.receiver,
        [],
      );
      signingKey = snapshotSigningKey(acquired);
      tag = await Reflect.apply(
        signingKey.sign,
        signingKey.receiver,
        [signatureInput(payload, signingKey.keyId)],
      );
      if (typeof tag !== 'string' || !SHA256_PATTERN.test(tag)) {
        throw new Error();
      }
    } catch {
      throw receiptError(
        'AUTHENTICATION_FAILED',
        'GitHub template download receipt authentication failed',
      );
    }
    const receipt: GithubTemplateDownloadReceiptV1 = deepFreeze({
      schemaVersion: RECEIPT_SCHEMA_VERSION as '1.0',
      kind: RECEIPT_KIND as 'github-template-download-receipt',
      payload,
      authentication: {
        algorithm: 'hmac-sha256' as const,
        keyId: signingKey.keyId,
        tag,
      },
    });
    const serialized = serializeGithubTemplateDownloadReceipt(receipt);
    const receiptKey = createHash('sha256')
      .update(RECEIPT_KEY_DOMAIN, 'utf8')
      .update(serialized, 'utf8')
      .digest('hex');
    const prepared = Object.freeze({ receipt, serialized, receiptKey });
    PREPARED_RECEIPT_AUTHORITIES.set(prepared, { state: 'active' });
    return prepared;
  } finally {
    if (materializedClaim !== undefined) {
      consumeMaterializedGithubTemplateCacheReceiptClaim(materializedClaim);
    }
    if (resolvedClaim !== undefined) {
      consumeResolvedGithubTemplateSourceReceiptClaim(resolvedClaim);
    }
  }
}

export function claimPreparedGithubTemplateDownloadReceiptForStorage(
  value: unknown,
): ClaimedPreparedGithubTemplateDownloadReceipt {
  const authority = (
    typeof value === 'object' && value !== null
      ? PREPARED_RECEIPT_AUTHORITIES.get(value)
      : undefined
  );
  if (authority === undefined || authority.state !== 'active') {
    throw receiptError(
      'INVALID_AUTHORITY',
      'prepared GitHub template download receipt authority is invalid',
    );
  }
  authority.state = 'consuming';
  const prepared = value as PreparedGithubTemplateDownloadReceipt;
  const claim = Object.freeze({
    prepared,
    [PREPARED_RECEIPT_CLAIM_BRAND]: true as const,
  });
  PREPARED_RECEIPT_CLAIMS.set(claim, { prepared, authority });
  return claim;
}

export function consumePreparedGithubTemplateDownloadReceiptStorageClaim(
  value: ClaimedPreparedGithubTemplateDownloadReceipt,
): void {
  const claim = (
    typeof value === 'object' && value !== null
      ? PREPARED_RECEIPT_CLAIMS.get(value)
      : undefined
  );
  if (
    claim === undefined
    || claim.authority.state !== 'consuming'
    || value.prepared !== claim.prepared
  ) {
    throw receiptError(
      'INVALID_AUTHORITY',
      'prepared GitHub template download receipt claim is invalid',
    );
  }
  PREPARED_RECEIPT_CLAIMS.delete(value);
  claim.authority.state = 'consumed';
}

/**
 * D1 stops at a process-local sealed representation authenticated only after a
 * trusted atomic signing-key lease succeeds. No receipt path is accepted and no
 * disk, journal, backup, or recovery marker is written.
 */
