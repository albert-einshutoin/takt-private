import { createHash } from 'node:crypto';
import type { MaterializedTaktpackContents } from './archive-inspector.js';
import { deriveProjectTemplateApplyPlanFromCurrentTarget } from './apply-plan-derivation.js';
import {
  createProjectTemplateRemoteApplyPreview,
  type ProjectTemplateRemoteApplyPreview,
} from './apply-preview.js';
import { openProjectTemplateApplyStorageReadOnly } from './apply-storage.js';
import { readProjectTemplateCompanionLockState } from './companion-lock-state-reader.js';
import type {
  VerifiedGithubTemplateDownloadReceipt,
} from './github-download-receipt-offline-read.js';
import { parseProjectTemplateGithubSourceSpec } from './github-source-spec.js';
import { serializeTemplateLock } from './lock.js';
import { readProjectTemplateMergeBaseline } from './merge-baseline-store.js';
import {
  claimProjectTemplateRepertoireDependencyInspectionForPlanning,
  inspectProjectTemplateRepertoireDependencies,
  type ProjectTemplateRepertoireDependencyInspectionPort,
} from './repertoire-dependency-inspection-port.js';
import {
  calculateProjectTemplateRepertoireDependencyDeclarationSha256,
} from './repertoire-dependency-canonical.js';
import {
  calculateProjectTemplateRepertoireDependencyLockSha256,
  serializeProjectTemplateRepertoireDependencyLock,
} from './repertoire-dependency-lock.js';
import { createProjectTemplateRepertoireDependencyPlan } from './repertoire-dependency-plan.js';
import {
  requireActiveRemotePreview,
  type ProjectTemplateRemotePreviewOperationContext,
} from './remote-preview-operation.js';
import { createProjectTemplateSourceProvenancePlan } from './source-provenance-plan.js';
import { serializeProjectTemplateSourceProvenance } from './source-provenance.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface DeriveGithubProjectTemplateRemoteTransactionOptions {
  readonly verified: VerifiedGithubTemplateDownloadReceipt;
  readonly materialized: MaterializedTaktpackContents;
  readonly receiptKey: string;
  readonly projectRoot: string;
  readonly currentTaktVersion: string;
  readonly repertoireInspectionPort:
    ProjectTemplateRepertoireDependencyInspectionPort;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly operationContext: ProjectTemplateRemotePreviewOperationContext;
  readonly assertAuthority?: () => void;
}

export interface DerivedGithubProjectTemplateRemoteTransaction {
  readonly preview: ProjectTemplateRemoteApplyPreview;
  readonly contentEntries: readonly (
    | {
      readonly path: string;
      readonly action: 'write';
      readonly content: Uint8Array;
      readonly mode: string;
    }
    | { readonly path: string; readonly action: 'delete' }
  )[];
  readonly companionOutputs: {
    readonly contentLock: Uint8Array;
    readonly repertoireLock: Uint8Array;
    readonly sourceProvenance: Uint8Array;
  };
}

function requireActive(
  options: DeriveGithubProjectTemplateRemoteTransactionOptions,
): void {
  requireActiveRemotePreview(options.operationContext);
  options.assertAuthority?.();
}

/**
 * Re-derives every transaction-bound plan from authenticated archive evidence
 * and the current three-lock cohort. Preview and apply intentionally share
 * this function so the expected transaction id cannot describe a different
 * target or dependency observation from the one authorized for execution.
 */
export async function deriveGithubProjectTemplateRemoteTransaction(
  options: DeriveGithubProjectTemplateRemoteTransactionOptions,
): Promise<DerivedGithubProjectTemplateRemoteTransaction> {
  requireActive(options);
  const { verified, materialized } = options;
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
    options.operationContext,
  );
  requireActive(options);
  const baseContents: Array<{ path: string; content: Uint8Array }> = [];
  if (companion.state === 'update') {
    try {
      const storage = await openProjectTemplateApplyStorageReadOnly({
        repoPath: options.projectRoot,
      });
      requireActive(options);
      for (const entry of companion.contentLock.entries) {
        if (
          entry.policy !== 'merge'
          || (entry.path !== 'config.yaml' && entry.path !== 'devloopd.yaml')
        ) continue;
        try {
          const content = await readProjectTemplateMergeBaseline({
            storage,
            expectedSha256: entry.sha256,
          });
          requireActive(options);
          baseContents.push({ path: entry.path, content: new Uint8Array(content) });
        } catch {
          requireActive(options);
        }
      }
    } catch {
      requireActive(options);
    }
  }
  const preparedContentPlan = await deriveProjectTemplateApplyPlanFromCurrentTarget({
    projectRoot: options.projectRoot,
    ...(companion.state === 'update'
      ? { baseLock: companion.contentLock }
      : {}),
    baseContents,
    incomingManifest: materialized.inspection.manifest,
    incomingContents: materialized.contents,
    incomingInspection: {
      archiveSha256: materialized.inspection.archiveSha256,
      manifestSha256: materialized.inspection.manifestSha256,
      currentTaktVersion: options.currentTaktVersion,
      compatibilityStatus: materialized.inspection.compatibility.status,
    },
    baselineStrategy: options.baselineStrategy,
    operationContext: options.operationContext,
  });
  requireActive(options);
  const contentPlan = preparedContentPlan.plan;

  const incomingDependencyLock = Object.freeze({
    schemaVersion: '1.0' as const,
    sourceDescriptorSha256: receipt.payload.source.descriptorSha256,
    manifestSha256: materialized.inspection.manifestSha256,
    dependencies,
  });
  let inspection: ReturnType<
    typeof inspectProjectTemplateRepertoireDependencies
  >;
  try {
    inspection = inspectProjectTemplateRepertoireDependencies({
      request: {
        sourceDescriptorSha256: incomingDependencyLock.sourceDescriptorSha256,
        manifestSha256: incomingDependencyLock.manifestSha256,
        dependencies,
        ...(options.operationContext.signal === undefined
          ? {}
          : { signal: options.operationContext.signal }),
        deadlineMs: options.operationContext.deadlineMs,
      },
      port: options.repertoireInspectionPort,
    });
  } catch (error) {
    // Cancellation and deadline expiry race with an inspection-port failure.
    // Reassert the operation first so the public facade reports the stable
    // cancellation contract and never leaks a lower-level authority error.
    requireActive(options);
    throw error;
  }
  requireActive(options);
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
      ...(parseProjectTemplateGithubSourceSpec(
        receipt.payload.source.canonicalSource,
      ).kind === 'github-release-asset'
        ? { assetName: receipt.payload.release.assetName }
        : {}),
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
  requireActive(options);
  const preview = createProjectTemplateRemoteApplyPreview({
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
  const effectiveContents = new Map(
    materialized.contents.map((item) => [item.path, item.content]),
  );
  for (const item of preparedContentPlan.resolvedContents) {
    effectiveContents.set(item.path, item.content);
  }
  const contentEntries: Array<
    DerivedGithubProjectTemplateRemoteTransaction['contentEntries'][number]
  > = [];
  for (const entry of contentPlan.entries) {
    if (entry.action === 'delete') {
      contentEntries.push({ path: entry.path, action: 'delete' });
      continue;
    }
    if (entry.action !== 'add' && entry.action !== 'update') continue;
    const content = effectiveContents.get(entry.path);
    if (content === undefined || entry.afterMode === undefined) {
      throw new Error('remote transaction content evidence is incomplete');
    }
    contentEntries.push({
      path: entry.path,
      action: 'write',
      content: new Uint8Array(content),
      mode: entry.afterMode,
    });
  }
  return Object.freeze({
    preview,
    contentEntries: Object.freeze(contentEntries),
    companionOutputs: Object.freeze({
      contentLock: new TextEncoder().encode(serializeTemplateLock(nextContentLock)),
      repertoireLock: new TextEncoder().encode(
        serializeProjectTemplateRepertoireDependencyLock(incomingDependencyLock),
      ),
      sourceProvenance: new TextEncoder().encode(
        serializeProjectTemplateSourceProvenance(sourceProvenance),
      ),
    }),
  });
}
