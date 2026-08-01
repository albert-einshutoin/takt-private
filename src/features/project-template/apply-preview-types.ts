import type { ProjectTemplateApplyReasonCode } from './apply-plan-types.js';
import type { ProjectTemplateApplyPlan } from './apply-plan-types.js';
import type {
  ProjectTemplateRepertoireDependencyPlan,
} from './repertoire-dependency-plan.js';
import type {
  ProjectTemplateSourceProvenancePlan,
} from './source-provenance-plan.js';

/** @internal Inputs accepted only by the private preview-composition boundary. */
export interface ProjectTemplateApplyPreviewOptions {
  readonly contentPlan: ProjectTemplateApplyPlan;
  readonly repertoireDependencyPlan:
    ProjectTemplateRepertoireDependencyPlan;
}

/** @internal Inputs accepted only by the authenticated remote preview facade. */
export interface ProjectTemplateRemoteApplyPreviewOptions
  extends ProjectTemplateApplyPreviewOptions {
  readonly sourceProvenancePlan: ProjectTemplateSourceProvenancePlan;
  readonly receiptKey: string;
  readonly previousLocksSha256: string;
  readonly nextContentLockSha256: string;
  readonly nextRepertoireLockSha256: string;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
}

/** @internal Inputs accepted only by the trusted local archive derivation. */
export interface ProjectTemplateLocalApplyPreviewOptions
  extends ProjectTemplateApplyPreviewOptions {
  readonly sourceProvenancePlan: ProjectTemplateSourceProvenancePlan;
  readonly previousLocksSha256: string;
  readonly nextContentLockSha256: string;
  readonly nextRepertoireLockSha256: string;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
}

/** A cross-plan composition failure safe to show on a review surface. */
export type ProjectTemplateApplyPreviewCompositionConflictCode =
  | 'MANIFEST_BINDING_MISMATCH'
  | 'SOURCE_MANIFEST_BINDING_MISMATCH'
  | 'SOURCE_ARCHIVE_BINDING_MISMATCH'
  | 'SOURCE_DESCRIPTOR_BINDING_MISMATCH'
  | 'SOURCE_DEPENDENCY_BINDING_MISMATCH'
  | 'SOURCE_VERSION_BINDING_MISMATCH';

/** A content blocker safe to show without exposing file contents or tokens. */
export type ProjectTemplateApplyPreviewContentHardConflict =
  | {
    readonly code: 'INCOMING_COMPATIBILITY_INCOMPATIBLE';
  }
  | {
    readonly code: 'CONTENT_ENTRY_CONFLICT';
    readonly path: string;
    readonly reasonCode: ProjectTemplateApplyReasonCode;
  };

/**
 * Stable identifiers binding one process-local preview to its content and
 * repertoire-dependency plans. Renderers intentionally do not display the
 * precondition-token fields.
 */
export interface ProjectTemplateApplyPreviewBindings {
  readonly contentPlanId: string;
  readonly contentPreconditionToken: string;
  readonly repertoireDependencyPlanId: string;
  readonly repertoireDependencyPreconditionToken: string;
  readonly incomingManifestSha256: string;
  readonly incomingArchiveSha256?: string;
  readonly baseLockSha256?: string;
  readonly sourceDescriptorSha256: string;
  readonly repertoireDeclarationSha256: string;
  readonly previousRepertoireLockSha256?: string;
  readonly sourceProvenancePlanId?: string;
  readonly previousSourceProvenanceSha256?: string;
  readonly nextSourceProvenanceSha256?: string;
  readonly previousLocksSha256?: string;
  readonly nextContentLockSha256?: string;
  readonly nextRepertoireLockSha256?: string;
  readonly transactionPlanId?: string;
}

/**
 * A process-local, sealed review value. Copies and deserialized lookalikes are
 * not accepted by the public renderers.
 */
export interface ProjectTemplateApplyPreview {
  readonly schemaVersion: '1.0';
  readonly previewId: string;
  readonly bindings: ProjectTemplateApplyPreviewBindings;
  readonly compositionConflicts:
    readonly ProjectTemplateApplyPreviewCompositionConflictCode[];
  readonly contentHardConflicts:
    readonly ProjectTemplateApplyPreviewContentHardConflict[];
  readonly dependencyHardConflict: boolean;
  readonly transactionPlanId?: string;
  readonly sourceHardConflict?: boolean;
  readonly reviewRequired: boolean;
  readonly hardConflict: boolean;
  readonly defaultApplyPossible: boolean;
}

export interface ProjectTemplateTransactionApplyPreview
  extends ProjectTemplateApplyPreview {
  readonly transactionPlanId: string;
  readonly sourceHardConflict: boolean;
  readonly bindings: ProjectTemplateApplyPreviewBindings & {
    readonly transactionPlanId: string;
    readonly sourceProvenancePlanId: string;
    readonly nextSourceProvenanceSha256: string;
    readonly previousLocksSha256: string;
    readonly nextContentLockSha256: string;
    readonly nextRepertoireLockSha256: string;
  };
}


export interface ProjectTemplateRemoteApplyPreview
  extends ProjectTemplateTransactionApplyPreview {}

export interface ProjectTemplateLocalApplyPreview
  extends ProjectTemplateTransactionApplyPreview {}
