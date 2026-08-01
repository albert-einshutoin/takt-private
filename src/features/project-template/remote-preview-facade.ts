import { resolve } from 'node:path';
import { types } from 'node:util';
import {
  materializeTaktpackContents,
} from './archive-inspector.js';
import type { ProjectTemplateRemoteApplyPreview } from './apply-preview.js';
import {
  assertClaimedVerifiedGithubTemplateDownloadReceiptForPreview,
  claimVerifiedGithubTemplateDownloadReceiptForApply,
  consumeVerifiedGithubTemplateDownloadReceiptApplyClaim,
  readGithubTemplateDownloadReceiptByReceiptKey,
  type GithubTemplateDownloadReceiptOfflineReadIo,
} from './github-download-receipt-offline-read.js';
import {
  deriveGithubTemplateDownloadArtifactPaths,
} from './github-download-receipt-paths.js';
import type {
  GithubTemplateDownloadReceiptVerifier,
} from './github-download-receipt-storage.js';
import type {
  ProjectTemplateRepertoireDependencyInspectionPort,
} from './repertoire-dependency-inspection-port.js';
import {
  createRemotePreviewOperationContext,
  requireActiveRemotePreview,
  type ProjectTemplateRemotePreviewOperationContext,
} from './remote-preview-operation.js';
import {
  deriveGithubProjectTemplateRemoteTransaction,
} from './remote-transaction-derivation.js';

export {
  GithubProjectTemplateRemotePreviewError,
  type GithubProjectTemplateRemotePreviewErrorCode,
} from './remote-preview-operation.js';

const DEFAULT_DEPENDENCY_INSPECTION_TIMEOUT_MS = 5_000;
const MAX_DEPENDENCY_INSPECTION_TIMEOUT_MS = 30_000;

export interface CreateGithubProjectTemplateRemotePreviewOptions {
  readonly cacheRoot: string;
  readonly receiptKey: string;
  readonly verifier: GithubTemplateDownloadReceiptVerifier;
  readonly projectRoot: string;
  readonly currentTaktVersion: string;
  readonly repertoireInspectionPort:
    ProjectTemplateRepertoireDependencyInspectionPort;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly dependencyInspectionTimeoutMs?: number;
  readonly receiptIo?: GithubTemplateDownloadReceiptOfflineReadIo;
  readonly signal?: AbortSignal;
}

function exactOptions(
  value: CreateGithubProjectTemplateRemotePreviewOptions,
): CreateGithubProjectTemplateRemotePreviewOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('remote preview options are invalid');
  }
  // Why: this is the production trust boundary. Snapshotting must not invoke
  // caller-controlled traps or inherited accessors before receipt authority is
  // acquired.
  if (types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('remote preview options are invalid');
  }
  const allowed = new Set([
    'cacheRoot',
    'receiptKey',
    'verifier',
    'projectRoot',
    'currentTaktVersion',
    'repertoireInspectionPort',
    'baselineStrategy',
    'dependencyInspectionTimeoutMs',
    'receiptIo',
    'signal',
  ]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key))
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor))
  ) throw new TypeError('remote preview options are invalid');
  for (const required of [
    'cacheRoot',
    'receiptKey',
    'verifier',
    'projectRoot',
    'currentTaktVersion',
    'repertoireInspectionPort',
    'baselineStrategy',
  ]) {
    if (descriptors[required] === undefined) {
      throw new TypeError('remote preview options are invalid');
    }
  }
  const timeout = descriptors['dependencyInspectionTimeoutMs']?.value
    ?? DEFAULT_DEPENDENCY_INSPECTION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout)
    || (timeout as number) <= 0
    || (timeout as number) > MAX_DEPENDENCY_INSPECTION_TIMEOUT_MS
  ) throw new TypeError('remote preview options are invalid');
  const cacheRoot = descriptors['cacheRoot']!.value;
  const projectRoot = descriptors['projectRoot']!.value;
  const receiptKey = descriptors['receiptKey']!.value;
  const currentTaktVersion = descriptors['currentTaktVersion']!.value;
  const baselineStrategy = descriptors['baselineStrategy']!.value;
  if (
    typeof cacheRoot !== 'string'
    || cacheRoot.length === 0
    || typeof projectRoot !== 'string'
    || projectRoot.length === 0
    || typeof receiptKey !== 'string'
    || !/^[a-f0-9]{64}$/.test(receiptKey)
    || typeof currentTaktVersion !== 'string'
    || currentTaktVersion.length === 0
    || (baselineStrategy !== 'conflict'
      && baselineStrategy !== 'adopt-identical')
  ) throw new TypeError('remote preview options are invalid');
  return Object.freeze({
    cacheRoot,
    receiptKey,
    verifier: descriptors['verifier']!.value as GithubTemplateDownloadReceiptVerifier,
    projectRoot,
    currentTaktVersion,
    repertoireInspectionPort:
      descriptors['repertoireInspectionPort']!.value as ProjectTemplateRepertoireDependencyInspectionPort,
    baselineStrategy,
    dependencyInspectionTimeoutMs: timeout as number,
    ...(descriptors['receiptIo'] === undefined
      ? {}
      : {
        receiptIo:
          descriptors['receiptIo'].value as GithubTemplateDownloadReceiptOfflineReadIo,
      }),
    ...(descriptors['signal'] === undefined
      ? {}
      : { signal: descriptors['signal'].value as AbortSignal }),
  });
}

/**
 * Creates an offline-only, non-authorizing preview from a stored signed receipt.
 * The receipt claim is deliberately retired before any target or installed
 * repertoire inspection begins; apply must perform a fresh read in H11.
 */
export async function createGithubProjectTemplateRemotePreview(
  value: CreateGithubProjectTemplateRemotePreviewOptions,
): Promise<ProjectTemplateRemoteApplyPreview> {
  const options = exactOptions(value);
  // One monotonic deadline is shared by every downstream boundary. Resetting
  // a duration after each await would allow a slow preview to exceed its bound.
  const deadlineMs = performance.now()
    + options.dependencyInspectionTimeoutMs!;
  const operationContext: ProjectTemplateRemotePreviewOperationContext =
    createRemotePreviewOperationContext(options.signal, deadlineMs);
  requireActiveRemotePreview(operationContext);
  const cacheRoot = resolve(options.cacheRoot);
  const verified = await readGithubTemplateDownloadReceiptByReceiptKey({
    cacheRoot,
    receiptKey: options.receiptKey,
    verifier: options.verifier,
    ...(options.receiptIo === undefined ? {} : { io: options.receiptIo }),
  });
  requireActiveRemotePreview(operationContext);

  // No await is permitted between offline verification and reservation.
  const receiptClaim = claimVerifiedGithubTemplateDownloadReceiptForApply(
    verified,
  );
  let materialized: Awaited<ReturnType<typeof materializeTaktpackContents>>;
  try {
    const claimed = assertClaimedVerifiedGithubTemplateDownloadReceiptForPreview(
      receiptClaim,
      {
        cacheRoot,
        receiptKey: options.receiptKey,
        artifactSha256: verified.artifactSha256,
      },
    );
    const artifactPaths = deriveGithubTemplateDownloadArtifactPaths({
      cacheRoot,
      archiveSha256: claimed.artifactSha256,
    });
    requireActiveRemotePreview(operationContext);
    materialized = await materializeTaktpackContents(
      artifactPaths.artifactPath,
      {
        currentTaktVersion: options.currentTaktVersion,
        signal: options.signal,
        deadlineMs,
      },
    );
    requireActiveRemotePreview(operationContext);
    if (
      materialized.inspection.archiveSha256 !== claimed.artifactSha256
      || materialized.inspection.archiveSha256
        !== claimed.receipt.payload.archive.sha256
      || materialized.inspection.manifestSha256
        !== claimed.receipt.payload.archive.manifestSha256
      || materialized.inspection.manifestSha256
        !== claimed.inspection.manifestSha256
    ) throw new Error('remote archive binding mismatch');
  } finally {
    consumeVerifiedGithubTemplateDownloadReceiptApplyClaim(receiptClaim);
  }

  return deriveGithubProjectTemplateRemoteTransaction({
    verified,
    materialized,
    receiptKey: options.receiptKey,
    projectRoot: options.projectRoot,
    currentTaktVersion: options.currentTaktVersion,
    repertoireInspectionPort: options.repertoireInspectionPort,
    baselineStrategy: options.baselineStrategy,
    operationContext,
  });
}
