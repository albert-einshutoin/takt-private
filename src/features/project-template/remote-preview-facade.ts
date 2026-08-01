import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { types } from 'node:util';
import {
  materializeTaktpackContents,
} from './archive-inspector.js';
import { createProjectTemplateApplyPlan } from './apply-plan.js';
import {
  createProjectTemplateRemoteApplyPreview,
  type ProjectTemplateRemoteApplyPreview,
} from './apply-preview.js';
import {
  readProjectTemplateCompanionLockState,
} from './companion-lock-state-reader.js';
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
import {
  claimProjectTemplateRepertoireDependencyInspectionForPlanning,
  inspectProjectTemplateRepertoireDependencies,
  type ProjectTemplateRepertoireDependencyInspectionPort,
} from './repertoire-dependency-inspection-port.js';
import {
  calculateProjectTemplateRepertoireDependencyDeclarationSha256,
} from './repertoire-dependency-canonical.js';
import {
  createProjectTemplateRepertoireDependencyPlan,
} from './repertoire-dependency-plan.js';
import {
  calculateProjectTemplateRepertoireDependencyLockSha256,
  serializeProjectTemplateRepertoireDependencyLock,
} from './repertoire-dependency-lock.js';
import { serializeTemplateLock } from './lock.js';
import {
  createProjectTemplateSourceProvenancePlan,
} from './source-provenance-plan.js';
import { captureProjectTemplateTargetSnapshot } from './target-snapshot.js';

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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

const ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    if (ABORTED_GETTER === undefined) return true;
    return Reflect.apply(ABORTED_GETTER, signal, []) as boolean;
  } catch {
    return true;
  }
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
  if (isAborted(options.signal)) throw new Error('remote preview aborted');
  const cacheRoot = resolve(options.cacheRoot);
  const verified = await readGithubTemplateDownloadReceiptByReceiptKey({
    cacheRoot,
    receiptKey: options.receiptKey,
    verifier: options.verifier,
    ...(options.receiptIo === undefined ? {} : { io: options.receiptIo }),
  });

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
    if (isAborted(options.signal)) throw new Error('remote preview aborted');
    materialized = await materializeTaktpackContents(
      artifactPaths.artifactPath,
      { currentTaktVersion: options.currentTaktVersion },
    );
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

  const receipt = verified.receipt;
  const descriptor = receipt.payload.source.sourceDescriptor;
  const dependencies = descriptor.repertoireDependencies;
  const dependencyEvidence = receipt.payload.source.dependencyVerification
    ?? Object.freeze({
      method: 'github-ref-to-commit-v1' as const,
      declarationSha256:
        calculateProjectTemplateRepertoireDependencyDeclarationSha256([]),
      count: 0,
    });
  if (
    dependencyEvidence.count !== dependencies.length
    || dependencyEvidence.declarationSha256
      !== calculateProjectTemplateRepertoireDependencyDeclarationSha256(
        dependencies,
      )
  ) throw new Error('remote dependency evidence mismatch');

  const companion = readProjectTemplateCompanionLockState(
    options.projectRoot,
  );
  const candidatePaths = new Set(
    materialized.inspection.manifest.entries.map((entry) => entry.path),
  );
  if (companion.state === 'update') {
    for (const entry of companion.contentLock.entries) {
      candidatePaths.add(entry.path);
    }
  }
  const target = await captureProjectTemplateTargetSnapshot(
    options.projectRoot,
    [...candidatePaths],
  );
  const contentPlan = createProjectTemplateApplyPlan({
    ...(companion.state === 'update'
      ? { baseLock: companion.contentLock }
      : {}),
    incomingManifest: materialized.inspection.manifest,
    incomingContents: materialized.contents,
    localEntries: target.entries,
    targetRootState: target.rootState,
    missingPathTracking: target.missingPathTracking,
    incomingInspection: {
      archiveSha256: materialized.inspection.archiveSha256,
      manifestSha256: materialized.inspection.manifestSha256,
      currentTaktVersion: options.currentTaktVersion,
      compatibilityStatus: materialized.inspection.compatibility.status,
    },
    baselineStrategy: options.baselineStrategy,
  });

  const incomingDependencyLock = Object.freeze({
    schemaVersion: '1.0' as const,
    sourceDescriptorSha256: receipt.payload.source.descriptorSha256,
    manifestSha256: materialized.inspection.manifestSha256,
    dependencies,
  });
  const inspection = inspectProjectTemplateRepertoireDependencies({
    request: {
      sourceDescriptorSha256: incomingDependencyLock.sourceDescriptorSha256,
      manifestSha256: incomingDependencyLock.manifestSha256,
      dependencies,
      deadlineMs: performance.now() + options.dependencyInspectionTimeoutMs!,
    },
    port: options.repertoireInspectionPort,
  });
  const dependencyPlan = createProjectTemplateRepertoireDependencyPlan({
    inspectionClaim:
      claimProjectTemplateRepertoireDependencyInspectionForPlanning(inspection),
    incomingLock: incomingDependencyLock,
    previousLock: companion.state === 'first-install'
      ? { state: 'absent' }
      : {
        state: 'present',
        content: serializeProjectTemplateRepertoireDependencyLock(
          companion.repertoireLock,
        ),
      },
  });

  const sourceProvenance = Object.freeze({
    schemaVersion: '1.0' as const,
    source: Object.freeze({
      owner: receipt.payload.source.owner,
      repo: receipt.payload.source.repo,
      repositoryUrl: receipt.payload.source.repositoryUrl,
      canonicalSource: receipt.payload.source.canonicalSource,
      requestedRef: receipt.payload.source.requestedRef,
      releaseTag: receipt.payload.source.releaseTag,
      commit: receipt.payload.source.commit,
      descriptorSha256: receipt.payload.source.descriptorSha256,
    }),
    archive: Object.freeze({
      sha256: receipt.payload.archive.sha256,
      version: receipt.payload.archive.version,
      manifestSha256: receipt.payload.archive.manifestSha256,
    }),
    dependencyVerification: Object.freeze({ ...dependencyEvidence }),
  });
  const sourcePlan = createProjectTemplateSourceProvenancePlan({
    incoming: sourceProvenance,
    previous: companion.state === 'first-install'
      ? { state: 'absent' }
      : { state: 'present', provenance: companion.sourceProvenance },
  });
  const nextContentLock = {
    schemaVersion: materialized.inspection.lockSeed.schemaVersion,
    manifestSha256: materialized.inspection.manifestSha256,
    packVersion: materialized.inspection.lockSeed.packVersion,
    source: materialized.inspection.lockSeed.source,
    capabilities: materialized.inspection.lockSeed.capabilities,
    entries: materialized.inspection.lockSeed.entries,
  };
  return createProjectTemplateRemoteApplyPreview({
    contentPlan,
    repertoireDependencyPlan: dependencyPlan,
    sourceProvenancePlan: sourcePlan,
    receiptKey: options.receiptKey,
    previousLocksSha256: companion.previousLocksSha256,
    nextContentLockSha256: sha256(serializeTemplateLock(nextContentLock)),
    nextRepertoireLockSha256:
      calculateProjectTemplateRepertoireDependencyLockSha256(
        incomingDependencyLock,
      ),
    baselineStrategy: options.baselineStrategy,
  });
}
