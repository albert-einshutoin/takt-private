import type {
  ProjectTemplateManifestV1,
  TemplateCapability,
  TemplateEntryPolicy,
  TemplateLockV1,
} from './types.js';
import type {
  CapturedProjectTemplateTargetEntry,
  ProjectTemplateGitTrackingStatus,
} from './target-snapshot.js';
import type {
  ProjectTemplateYamlMergeBlockedCode,
  ProjectTemplateYamlMergeConflict,
  ProjectTemplateYamlMergeDiagnostic,
} from './yaml-document-merge.js';

export type ProjectTemplateLocalSnapshotEntry = CapturedProjectTemplateTargetEntry;

export interface ProjectTemplateIncomingContent {
  path: string;
  content: Uint8Array;
}

export interface ProjectTemplateBaseContent {
  path: string;
  content: Uint8Array;
}

export interface ProjectTemplateIncomingInspectionEvidence {
  archiveSha256: string;
  manifestSha256: string;
  currentTaktVersion: string;
  compatibilityStatus: 'compatible' | 'unknown' | 'incompatible';
}

export interface ProjectTemplateApplyPlanInput {
  baseLock?: TemplateLockV1;
  incomingManifest: ProjectTemplateManifestV1;
  localEntries: readonly ProjectTemplateLocalSnapshotEntry[];
  targetRootState?: 'missing' | 'directory';
  missingPathTracking?: Readonly<Record<string, ProjectTemplateGitTrackingStatus>>;
  baseContents?: readonly ProjectTemplateBaseContent[];
  incomingContents?: readonly ProjectTemplateIncomingContent[];
  incomingInspection?: ProjectTemplateIncomingInspectionEvidence;
  baselineStrategy?: 'conflict' | 'adopt-identical';
}

export type ProjectTemplateApplyAction =
  | 'add'
  | 'update'
  | 'keep'
  | 'delete'
  | 'conflict'
  | 'excluded';

export type ProjectTemplateApplyReasonCode =
  | 'UPSTREAM_CHANGED'
  | 'LOCAL_CHANGED'
  | 'BOTH_CHANGED'
  | 'SEMANTIC_MERGE_REQUIRED'
  | 'SEMANTIC_MERGED'
  | 'CONFLICT'
  | 'BASE_UNAVAILABLE'
  | 'ALREADY_CURRENT'
  | 'UNCHANGED'
  | 'NEW_ENTRY'
  | 'DESTINATION_EXISTS'
  | 'LOCAL_UNCHANGED_TEMPLATE_DELETED'
  | 'LOCAL_CHANGED_TEMPLATE_DELETED'
  | 'ALREADY_ABSENT'
  | 'SCAFFOLD_MISSING'
  | 'SCAFFOLD_PRESERVED'
  | 'POLICY_EXCLUDED'
  | 'LEGACY_BASELINE_REQUIRED'
  | 'BASELINE_ADOPTED'
  | 'POLICY_CHANGED'
  | 'RENAME_DETECTED'
  | 'AMBIGUOUS_RENAME'
  | 'CASE_ONLY_RENAME'
  | 'DESTINATION_CASE_COLLISION'
  | 'DESTINATION_PATH_COLLISION'
  | 'LOCAL_DELETED'
  | 'LOCAL_DELETED_UPSTREAM_CHANGED';

export type ProjectTemplateRollbackImpact =
  | 'none'
  | 'remove-created'
  | 'restore-existing'
  | 'restore-deleted'
  | 'manual-conflict';

export type ProjectTemplateEntryDiff =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'binary' }
  | { kind: 'too-large' }
  | { kind: 'redacted' }
  | { kind: 'unavailable' };

export type ProjectTemplateApplyMergeDiagnostics =
  | {
    readonly status: 'merged';
    readonly diagnostics: readonly ProjectTemplateYamlMergeDiagnostic[];
  }
  | {
    readonly status: 'conflict';
    readonly conflicts: readonly ProjectTemplateYamlMergeConflict[];
    readonly diagnostics: readonly ProjectTemplateYamlMergeDiagnostic[];
  }
  | {
    readonly status: 'blocked';
    readonly code:
      | ProjectTemplateYamlMergeBlockedCode
      | 'MERGED_CONFIG_INVALID'
      | 'MERGED_DEVLOOP_POLICY_INVALID';
    readonly document: 'base' | 'local' | 'incoming' | 'merged';
    readonly path?: readonly string[];
    readonly message?: string;
    readonly diagnostics: readonly ProjectTemplateYamlMergeDiagnostic[];
  }
  | {
    readonly status: 'base-unavailable';
    readonly diagnostics: readonly [];
  };

interface ProjectTemplateApplyPlanEntryBase {
  path: string;
  reasonCode: ProjectTemplateApplyReasonCode;
  beforeSha256?: string;
  baseSha256?: string;
  incomingSha256?: string;
  afterSha256?: string;
  beforeMode?: string;
  incomingMode?: string;
  afterMode?: string;
  capabilitiesBefore: readonly TemplateCapability[];
  capabilitiesAfter: readonly TemplateCapability[];
  gitTrackingStatus: ProjectTemplateGitTrackingStatus | 'absent';
  rollbackImpact: ProjectTemplateRollbackImpact;
  reviewRequired: boolean;
  diff?: ProjectTemplateEntryDiff;
  mergeDiagnostics?: ProjectTemplateApplyMergeDiagnostics;
}

export interface ManagedProjectTemplateApplyPlanEntry
  extends ProjectTemplateApplyPlanEntryBase {
  policy: 'managed';
  action: 'add' | 'update' | 'keep' | 'delete' | 'conflict';
}

export interface MergeProjectTemplateApplyPlanEntry
  extends ProjectTemplateApplyPlanEntryBase {
  policy: 'merge';
  action: 'add' | 'update' | 'keep' | 'delete' | 'conflict';
}

export interface ScaffoldProjectTemplateApplyPlanEntry
  extends ProjectTemplateApplyPlanEntryBase {
  policy: 'scaffold';
  action: 'add' | 'keep' | 'conflict';
}

export interface ExcludedProjectTemplateApplyPlanEntry
  extends ProjectTemplateApplyPlanEntryBase {
  policy: 'excluded';
  action: 'excluded';
}

export type ProjectTemplateApplyPlanEntry =
  | ManagedProjectTemplateApplyPlanEntry
  | MergeProjectTemplateApplyPlanEntry
  | ScaffoldProjectTemplateApplyPlanEntry
  | ExcludedProjectTemplateApplyPlanEntry;

export interface ProjectTemplateApplyPlanSummary {
  counts: Readonly<Record<ProjectTemplateApplyAction, number>>;
  human: string;
  json: string;
}

export interface ProjectTemplateApplyPlan {
  schemaVersion: '1.0';
  planId: string;
  preconditionToken: string;
  baseLockSha256?: string;
  incomingManifestSha256: string;
  incomingArchiveSha256?: string;
  incomingCompatibility: 'compatible' | 'unknown' | 'incompatible' | 'unverified';
  capabilitiesBefore: readonly TemplateCapability[];
  capabilitiesAfter: readonly TemplateCapability[];
  basePackVersion?: string;
  incomingPackVersion: string;
  reviewRequired: boolean;
  defaultApplyPossible: boolean;
  entries: readonly ProjectTemplateApplyPlanEntry[];
  summary: ProjectTemplateApplyPlanSummary;
}

export interface PreparedProjectTemplateApplyPlan {
  readonly plan: ProjectTemplateApplyPlan;
  readonly resolvedContents: readonly ProjectTemplateIncomingContent[];
}

export type ProjectTemplatePolicyActionMap = {
  [Policy in TemplateEntryPolicy]: Extract<
    ProjectTemplateApplyPlanEntry,
    { policy: Policy }
  >['action'];
};
