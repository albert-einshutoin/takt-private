import type { ProjectTemplateApplyReasonCode } from './apply-plan-types.js';
import type { ProjectTemplateApplyPlan } from './apply-plan-types.js';
import type {
  ProjectTemplateRepertoireDependencyPlan,
} from './repertoire-dependency-plan.js';

export interface ProjectTemplateApplyPreviewOptions {
  readonly contentPlan: ProjectTemplateApplyPlan;
  readonly repertoireDependencyPlan:
    ProjectTemplateRepertoireDependencyPlan;
}

export type ProjectTemplateApplyPreviewCompositionConflictCode =
  'MANIFEST_BINDING_MISMATCH';

export type ProjectTemplateApplyPreviewContentHardConflict =
  | {
    readonly code: 'INCOMING_COMPATIBILITY_INCOMPATIBLE';
  }
  | {
    readonly code: 'CONTENT_ENTRY_CONFLICT';
    readonly path: string;
    readonly reasonCode: ProjectTemplateApplyReasonCode;
  };

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
}

export interface ProjectTemplateApplyPreview {
  readonly schemaVersion: '1.0';
  readonly previewId: string;
  readonly bindings: ProjectTemplateApplyPreviewBindings;
  readonly compositionConflicts:
    readonly ProjectTemplateApplyPreviewCompositionConflictCode[];
  readonly contentHardConflicts:
    readonly ProjectTemplateApplyPreviewContentHardConflict[];
  readonly dependencyHardConflict: boolean;
  readonly reviewRequired: boolean;
  readonly hardConflict: boolean;
  readonly defaultApplyPossible: boolean;
}
