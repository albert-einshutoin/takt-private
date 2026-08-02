import type {
  ProjectTemplateRepertoireDependencyInspectionPlanningClaim,
  ProjectTemplateRepertoireDependencyObservation,
} from './repertoire-dependency-inspection-port.js';
import type {
  ProjectTemplateRepertoireDependencyLockV1,
} from './repertoire-dependency-lock.js';
import type {
  ProjectTemplateRepertoireDependencyV1,
} from './source-descriptor.js';

export type ProjectTemplateRepertoireDependencyPreviousLockInput =
  | { readonly state: 'absent' }
  | {
    readonly state: 'present';
    readonly content: string | Uint8Array;
  }
  | { readonly state: 'unavailable' };

export interface ProjectTemplateRepertoireDependencyPlanOptions {
  readonly inspectionClaim:
    ProjectTemplateRepertoireDependencyInspectionPlanningClaim;
  readonly incomingLock: ProjectTemplateRepertoireDependencyLockV1;
  readonly previousLock:
    ProjectTemplateRepertoireDependencyPreviousLockInput;
}

export interface ProjectTemplateLocalEmptyRepertoireDependencyPlanOptions {
  readonly incomingLock: ProjectTemplateRepertoireDependencyLockV1;
  readonly previousLock:
    ProjectTemplateRepertoireDependencyPreviousLockInput;
}

export type ProjectTemplateRepertoireDependencyPlanAction =
  | 'add'
  | 'keep'
  | 'update'
  | 'remove'
  | 'unknown';

export type ProjectTemplateRepertoireDependencyChangeCode =
  | 'ADDED'
  | 'REMOVED'
  | 'SOURCE_CHANGED'
  | 'VERSION_CHANGED'
  | 'COMMIT_CHANGED'
  | 'EDIT_CAPABILITY_ADDED'
  | 'EDIT_CAPABILITY_REMOVED';

export type ProjectTemplateRepertoireDependencyInstalledConflictCode =
  | 'NOT_INSTALLED'
  | 'INVALID_INSTALLATION'
  | 'SOURCE_MISMATCH'
  | 'REF_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'COMMIT_MISMATCH'
  | 'CAPABILITY_MISMATCH';

export type ProjectTemplateRepertoireDependencyPlanGlobalConflictCode =
  | 'INSPECTION_BINDING_MISMATCH'
  | 'PREVIOUS_LOCK_INVALID'
  | 'PREVIOUS_LOCK_UNAVAILABLE';

export type ProjectTemplateRepertoireDependencyPreviousLockState =
  | 'absent'
  | 'valid'
  | 'invalid'
  | 'unavailable';

export type ProjectTemplateRepertoireDependencyMetadataChangeCode =
  | 'SOURCE_DESCRIPTOR_SHA256_CHANGED'
  | 'MANIFEST_SHA256_CHANGED';

export interface ProjectTemplateRepertoireDependencyPlanEntry {
  readonly scope: `@${string}/${string}`;
  readonly action: ProjectTemplateRepertoireDependencyPlanAction;
  readonly changes:
    readonly ProjectTemplateRepertoireDependencyChangeCode[];
  readonly installedConflicts:
    readonly ProjectTemplateRepertoireDependencyInstalledConflictCode[];
  readonly previous?: ProjectTemplateRepertoireDependencyV1;
  readonly incoming?: ProjectTemplateRepertoireDependencyV1;
  readonly observation?: ProjectTemplateRepertoireDependencyObservation;
}

export interface ProjectTemplateRepertoireDependencyPlanSummary {
  readonly counts: Readonly<Record<
    ProjectTemplateRepertoireDependencyPlanAction,
    number
  >>;
  readonly conflicts: number;
  readonly metadataChanges:
    readonly ProjectTemplateRepertoireDependencyMetadataChangeCode[];
  readonly metadataChangeCount: number;
  readonly reviewRequired: boolean;
  readonly hardConflict: boolean;
}

export interface ProjectTemplateRepertoireDependencyPlan {
  readonly schemaVersion: '1.0';
  readonly planId: string;
  readonly preconditionToken: string;
  readonly sourceDescriptorSha256: string;
  readonly manifestSha256: string;
  readonly declarationSha256: string;
  readonly previousLockState:
    ProjectTemplateRepertoireDependencyPreviousLockState;
  readonly previousLockSha256?: string;
  readonly metadataChanges:
    readonly ProjectTemplateRepertoireDependencyMetadataChangeCode[];
  readonly globalConflicts:
    readonly ProjectTemplateRepertoireDependencyPlanGlobalConflictCode[];
  readonly dependencies: readonly ProjectTemplateRepertoireDependencyPlanEntry[];
  readonly summary: ProjectTemplateRepertoireDependencyPlanSummary;
  readonly reviewRequired: boolean;
  readonly hardConflict: boolean;
  readonly defaultApplyPossible: boolean;
  readonly nextLock?: ProjectTemplateRepertoireDependencyLockV1;
}
