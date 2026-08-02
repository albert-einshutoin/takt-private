import { createHash } from 'node:crypto';
import { materializeTaktpackContents } from './archive-inspector.js';
import { deriveProjectTemplateApplyPlanFromCurrentTarget } from './apply-plan-derivation.js';
import {
  createProjectTemplateLocalApplyPreview,
  type ProjectTemplateLocalApplyPreview,
} from './apply-preview.js';
import { openProjectTemplateApplyStorageReadOnly } from './apply-storage.js';
import { canonicalizeTaktpackJson } from './canonical-json.js';
import { readProjectTemplateCompanionLockState } from './companion-lock-state-reader.js';
import { TaktpackError } from './errors.js';
import { serializeTemplateLock } from './lock.js';
import { readProjectTemplateMergeBaseline } from './merge-baseline-store.js';
import {
  calculateProjectTemplateRepertoireDependencyDeclarationSha256,
} from './repertoire-dependency-canonical.js';
import {
  calculateProjectTemplateRepertoireDependencyLockSha256,
  serializeProjectTemplateRepertoireDependencyLock,
} from './repertoire-dependency-lock.js';
import {
  createLocalEmptyProjectTemplateRepertoireDependencyPlan,
} from './repertoire-dependency-plan.js';
import { createProjectTemplateSourceProvenancePlan } from './source-provenance-plan.js';
import { serializeProjectTemplateSourceProvenance } from './source-provenance.js';

const LOCAL_DESCRIPTOR_DOMAIN =
  'takt.project-template.local-import-descriptor.v1\u0000';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new TaktpackError(
      'OPERATION_ABORTED',
      'project template local transaction derivation was aborted',
      'operation',
    );
  }
}

export interface DeriveLocalProjectTemplateTransactionOptions {
  readonly archivePath: string;
  readonly projectRoot: string;
  readonly currentTaktVersion: string;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly signal?: AbortSignal;
}

export interface DerivedLocalProjectTemplateTransaction {
  readonly preview: ProjectTemplateLocalApplyPreview;
  readonly candidatePaths: readonly string[];
  readonly mergeBaselines: readonly {
    readonly sha256: string;
    readonly content: Uint8Array;
  }[];
  readonly contentEntries: readonly (
    | {
      readonly path: string;
      readonly action: 'write';
      readonly content: Uint8Array;
      readonly mode: string;
    }
    | { readonly path: string; readonly action: 'delete' }
  )[];
  /**
   * Safe read/review facts retained separately from content and transaction
   * authority so a desktop consumer never needs the executable plan object.
   */
  readonly review: {
    readonly archiveId: string;
    readonly manifestId: string;
    readonly revision: string;
    readonly entries: readonly {
      readonly path: string;
      readonly policy: 'managed' | 'merge' | 'scaffold' | 'excluded';
      readonly action: 'add' | 'update' | 'keep' | 'delete' | 'conflict' | 'excluded';
      readonly reason: import('./apply-plan-types.js').ProjectTemplateApplyReasonCode;
      readonly reviewRequired: boolean;
      readonly capabilitiesBefore: readonly import('./types.js').TemplateCapability[];
      readonly capabilitiesAfter: readonly import('./types.js').TemplateCapability[];
    }[];
  };
  readonly companionOutputs: {
    readonly contentLock: Uint8Array;
    readonly repertoireLock: Uint8Array;
    readonly sourceProvenance: Uint8Array;
  };
}

/**
 * Re-derives a local archive transaction from fresh archive, target, baseline,
 * and exact 000/111 companion-lock evidence. Local schema 1.0 deliberately
 * admits no repertoire dependencies. Any embedded git/GitHub identity is
 * retained only as pack-bound provenance and is never upgraded into remote
 * fetch, update, or repository authority.
 */
export async function deriveLocalProjectTemplateTransaction(
  options: DeriveLocalProjectTemplateTransactionOptions,
): Promise<DerivedLocalProjectTemplateTransaction> {
  requireActive(options.signal);
  const materialized = await materializeTaktpackContents(options.archivePath, {
    currentTaktVersion: options.currentTaktVersion,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  requireActive(options.signal);
  const manifest = materialized.inspection.manifest;
  const localImportSource = manifest.source.kind === 'local'
    ? manifest.source
    : Object.freeze({
      kind: 'local' as const,
      uri: '.',
      ref: 'workspace' as const,
      commit: manifest.source.commit,
    });

  const companion = readProjectTemplateCompanionLockState(options.projectRoot);
  requireActive(options.signal);
  const baseContents: Array<{ path: string; content: Uint8Array }> = [];
  if (companion.state === 'update') {
    try {
      const storage = await openProjectTemplateApplyStorageReadOnly({
        repoPath: options.projectRoot,
      });
      requireActive(options.signal);
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
          requireActive(options.signal);
          baseContents.push({ path: entry.path, content: new Uint8Array(content) });
        } catch {
          requireActive(options.signal);
        }
      }
    } catch {
      requireActive(options.signal);
    }
  }

  const preparedContentPlan = await deriveProjectTemplateApplyPlanFromCurrentTarget({
    projectRoot: options.projectRoot,
    ...(companion.state === 'update'
      ? { baseLock: companion.contentLock }
      : {}),
    baseContents,
    incomingManifest: manifest,
    incomingContents: materialized.contents,
    incomingInspection: {
      archiveSha256: materialized.inspection.archiveSha256,
      manifestSha256: materialized.inspection.manifestSha256,
      currentTaktVersion: options.currentTaktVersion,
      compatibilityStatus: materialized.inspection.compatibility.status,
    },
    baselineStrategy: options.baselineStrategy,
  });
  requireActive(options.signal);

  const sourceDescriptorSha256 = sha256(
    LOCAL_DESCRIPTOR_DOMAIN + canonicalizeTaktpackJson({
      schemaVersion: '1.0',
      source: manifest.source,
      repertoireDependencies: [],
    }),
  );
  const incomingDependencyLock = Object.freeze({
    schemaVersion: '1.0' as const,
    sourceDescriptorSha256,
    manifestSha256: materialized.inspection.manifestSha256,
    dependencies: Object.freeze([]),
  });
  const dependencyPlan =
    createLocalEmptyProjectTemplateRepertoireDependencyPlan({
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
      kind: 'local-import' as const,
      // Why: a git/GitHub identity embedded in copied archive bytes remains
      // descriptor evidence only. Mapping the effective source to a local
      // workspace prevents a later update from treating it as fetch authority.
      uri: localImportSource.uri,
      ref: localImportSource.ref,
      commit: localImportSource.commit,
      descriptorSha256: sourceDescriptorSha256,
    }),
    archive: Object.freeze({
      sha256: materialized.inspection.archiveSha256,
      version: manifest.packVersion,
      manifestSha256: materialized.inspection.manifestSha256,
    }),
    dependencyVerification: Object.freeze({
      method: 'local-empty-v1' as const,
      declarationSha256:
        calculateProjectTemplateRepertoireDependencyDeclarationSha256([]),
      count: 0 as const,
    }),
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
    source: localImportSource,
    capabilities: materialized.inspection.lockSeed.capabilities,
    entries: materialized.inspection.lockSeed.entries,
  };
  const contentPlan = preparedContentPlan.plan;
  const preview = createProjectTemplateLocalApplyPreview({
    contentPlan,
    repertoireDependencyPlan: dependencyPlan,
    sourceProvenancePlan: sourcePlan,
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
  const incomingContents = new Map(
    materialized.contents.map((item) => [item.path, item.content]),
  );
  const mergeBaselines: Array<
    DerivedLocalProjectTemplateTransaction['mergeBaselines'][number]
  > = [];
  for (const entry of materialized.inspection.lockSeed.entries) {
    if (
      entry.policy !== 'merge'
      || (entry.path !== 'config.yaml' && entry.path !== 'devloopd.yaml')
    ) continue;
    const content = incomingContents.get(entry.path);
    if (content === undefined || sha256Bytes(content) !== entry.sha256) {
      // Archive inspection already binds blobs to the lock seed. This final
      // local copy check prevents a retained materialization from being paired
      // with a different next-generation merge baseline.
      throw new Error('local merge baseline evidence is incomplete');
    }
    mergeBaselines.push(Object.freeze({
      sha256: entry.sha256,
      content: new Uint8Array(content!),
    }));
  }
  const contentEntries: Array<
    DerivedLocalProjectTemplateTransaction['contentEntries'][number]
  > = [];
  for (const entry of contentPlan.entries) {
    if (entry.action === 'delete') {
      contentEntries.push({ path: entry.path, action: 'delete' });
      continue;
    }
    if (entry.action !== 'add' && entry.action !== 'update') continue;
    const content = effectiveContents.get(entry.path);
    if (content === undefined || entry.afterMode === undefined) {
      throw new Error('local transaction content evidence is incomplete');
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
    review: Object.freeze({
      archiveId: materialized.inspection.archiveSha256,
      manifestId: materialized.inspection.manifestSha256,
      revision: localImportSource.commit,
      entries: Object.freeze(contentPlan.entries.map((entry) => Object.freeze({
        path: entry.path,
        policy: entry.policy,
        action: entry.action,
        reason: entry.reasonCode,
        reviewRequired: entry.reviewRequired,
        capabilitiesBefore: Object.freeze([...entry.capabilitiesBefore]),
        capabilitiesAfter: Object.freeze([...entry.capabilitiesAfter]),
      }))),
    }),
    candidatePaths: Object.freeze(contentPlan.entries.map((entry) => entry.path)),
    mergeBaselines: Object.freeze(mergeBaselines),
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
