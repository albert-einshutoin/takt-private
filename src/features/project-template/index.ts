export {
  parseProjectTemplateManifest,
  serializeProjectTemplateManifest,
} from './manifest.js';
export { parseTemplateLock, serializeTemplateLock } from './lock.js';
export {
  calculateProjectTemplateManifestSha256,
  validateManifestLockPair,
} from './binding.js';
export { validateDetectedTemplateCapabilities } from './capability-detection.js';
export {
  classifyProjectTemplateEntry,
} from './classifier-core.js';
export { scanProjectTemplateDirectory } from './filesystem-scan.js';
export {
  projectTemplateManifestV1JsonSchema,
  projectTemplateLockV1JsonSchema,
} from './schema.js';
export {
  ProjectTemplateValidationError,
  TaktpackError,
} from './errors.js';
export type {
  TaktpackArtifactState,
  TaktpackErrorCode,
} from './errors.js';
export {
  TAKTPACK_ENTRY_NAMES,
  TAKTPACK_BLOB_PREFIX,
  DEFAULT_TAKTPACK_LIMITS,
} from './archive-types.js';
export type {
  TaktpackLimits,
  TaktpackDescriptorV1,
  TaktpackExportReportV1,
  ProjectTemplateExportOptions,
  ProjectTemplateExportPlan,
  TaktpackInspectResult,
  InspectTaktpackOptions,
  WriteTaktpackOptions,
  WriteTaktpackResult,
  TaktpackIndexV1,
  TaktpackLockSeedV1,
  DeepReadonly,
} from './archive-types.js';
export { canonicalizeTaktpackJson } from './canonical-json.js';
export { createProjectTemplateExportPlan } from './export-plan.js';
export { writeTaktpack } from './archive-writer.js';
export { inspectTaktpack } from './archive-inspector.js';
export {
  calculateProjectTemplateTargetPreconditionToken,
  captureProjectTemplateTargetSnapshot,
} from './target-snapshot.js';
export type {
  ProjectTemplateGitTrackingStatus,
  CapturedProjectTemplateTargetEntry,
  ProjectTemplateTargetSnapshot,
} from './target-snapshot.js';
export { createProjectTemplateApplyPlan } from './apply-plan.js';
export {
  inspectProjectTemplateApplyGuard,
} from './apply-guard.js';
export type {
  ProjectTemplateApplyGuardBlockCode,
  ProjectTemplateApplyGuardBlock,
  ProjectTemplateApplyGuardReport,
  InspectProjectTemplateApplyGuardOptions,
} from './apply-guard.js';
export {
  runProjectTemplateDoctor,
} from './apply-doctor.js';
export type {
  ProjectTemplateDoctorCheck,
  ProjectTemplateDoctorCheckKind,
  ProjectTemplateDoctorReport,
} from './apply-doctor.js';
export {
  PROJECT_TEMPLATE_LOCK_PATH,
  applyProjectTemplatePlan,
  recoverProjectTemplateApply,
  rollbackProjectTemplateApply,
} from './apply-executor.js';
export type {
  ProjectTemplateApplyResult,
  ProjectTemplateRecoveryResult,
  ProjectTemplateRollbackResult,
} from './apply-executor.js';
export type {
  ProjectTemplateLocalSnapshotEntry,
  ProjectTemplateIncomingContent,
  ProjectTemplateIncomingInspectionEvidence,
  ProjectTemplateApplyPlanInput,
  ProjectTemplateApplyAction,
  ProjectTemplateApplyReasonCode,
  ProjectTemplateRollbackImpact,
  ProjectTemplateEntryDiff,
  ManagedProjectTemplateApplyPlanEntry,
  MergeProjectTemplateApplyPlanEntry,
  ScaffoldProjectTemplateApplyPlanEntry,
  ExcludedProjectTemplateApplyPlanEntry,
  ProjectTemplateApplyPlanEntry,
  ProjectTemplateApplyPlanSummary,
  ProjectTemplateApplyPlan,
  ProjectTemplatePolicyActionMap,
} from './apply-plan-types.js';
export type {
  ProjectTemplateManifestV1,
  TemplateCapability,
  TemplateEntry,
  TemplateEntryPolicy,
  TemplateLockV1,
  TemplateLockEntry,
  TemplateSource,
  GithubTemplateSource,
  GitTemplateSource,
  LocalTemplateSource,
  DetectedTemplateCapabilities,
} from './types.js';
export type { ProjectTemplateValidationErrorCode } from './errors.js';
export type {
  ProjectTemplateClassification,
  ProjectTemplateClassificationReason,
  ProjectTemplateClassificationResult,
  ProjectTemplateClassifierInput,
  ProjectTemplateScanLimits,
  ProjectTemplateScanOptions,
  ProjectTemplateScanResult,
} from './classifier-types.js';
