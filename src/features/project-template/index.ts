export {
  parseProjectTemplateManifest,
  serializeProjectTemplateManifest,
} from './manifest.js';
export { parseProjectTemplateGithubSourceSpec } from './github-source-spec.js';
export type {
  ProjectTemplateGithubRefSourceSpec,
  ProjectTemplateGithubReleaseAssetSourceSpec,
  ProjectTemplateGithubSourceSpec,
} from './github-source-spec.js';
export {
  PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_PATH,
  MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES,
  projectTemplateSourceDescriptorV1JsonSchema,
  parseProjectTemplateSourceDescriptor,
  parseProjectTemplateSourceDescriptorJson,
  serializeProjectTemplateSourceDescriptor,
  calculateProjectTemplateSourceDescriptorSha256,
} from './source-descriptor.js';
export type {
  ProjectTemplateSourceDescriptorPackV1,
  ProjectTemplateRepertoireCapabilityV1,
  ProjectTemplateRepertoireDependencyV1,
  ProjectTemplateSourceDescriptorV1,
} from './source-descriptor.js';
export {
  demoteResolvedGithubTemplateSourceToAdvisory,
  discardResolvedGithubTemplateSource,
  GithubTemplateSourceResolutionError,
  resolveGithubTemplateSource,
} from './github-update-check.js';
export type {
  GithubTemplateSourceResolutionErrorCode,
  GithubTemplateResolveRefInput,
  GithubTemplateReadFileInput,
  GithubTemplateGetReleaseInput,
  GithubTemplateReadReleaseAssetInput,
  GithubTemplateSourceMetadataPort,
  GithubTemplateSourceAdvisory,
  GithubTemplateCurrentSourceEvidence,
  GithubTemplateUpdateState,
  ResolveGithubTemplateSourceOptions,
  ResolvedGithubTemplateSource,
} from './github-update-check.js';
export {
  downloadGithubTemplateSource,
  GithubTemplateDownloadOrchestratorError,
} from './github-download-orchestrator.js';
export type {
  DownloadGithubTemplateSourceOptions,
  DownloadedGithubTemplateSource,
  GithubTemplateArchiveAssetInput,
  GithubTemplateArchiveAssetPort,
  GithubTemplateDownloadOrchestratorErrorCode,
} from './github-download-orchestrator.js';
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
export {
  createProjectTemplateApplyPlan,
  prepareProjectTemplateApplyPlan,
} from './apply-plan.js';
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
  ProjectTemplateApplyApprovalEvidence,
} from './apply-approval.js';
export type {
  ProjectTemplateLocalSnapshotEntry,
  ProjectTemplateBaseContent,
  ProjectTemplateIncomingContent,
  ProjectTemplateIncomingInspectionEvidence,
  ProjectTemplateApplyPlanInput,
  ProjectTemplateApplyAction,
  ProjectTemplateApplyReasonCode,
  ProjectTemplateRollbackImpact,
  ProjectTemplateEntryDiff,
  ProjectTemplateApplyMergeDiagnostics,
  ManagedProjectTemplateApplyPlanEntry,
  MergeProjectTemplateApplyPlanEntry,
  ScaffoldProjectTemplateApplyPlanEntry,
  ExcludedProjectTemplateApplyPlanEntry,
  ProjectTemplateApplyPlanEntry,
  ProjectTemplateApplyPlanSummary,
  ProjectTemplateApplyPlan,
  PreparedProjectTemplateApplyPlan,
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
