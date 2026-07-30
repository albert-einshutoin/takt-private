/**
 * TAKT - TAKT Agent Koordination Topology
 *
 * This module exports the public API for programmatic usage.
 */

// Models
export type {
  Status,
  WorkflowRule,
  WorkflowStep,
  WorkflowConfig,
  WorkflowState,
  Language,
  PartDefinition,
  PartResult,
} from './core/models/types.js';

// Configuration
export {
  loadWorkflow,
  loadWorkflowByIdentifier,
  listWorkflows,
  loadAllWorkflowDiscovery,
  loadAllWorkflowDiscoveryWithSources,
  loadAllWorkflows,
  loadAllWorkflowsWithSources,
  getWorkflowDescription,
  getBuiltinWorkflow,
  isWorkflowPath,
} from './infra/config/loaders/index.js';
export type {
  WorkflowDiscoveryConfig as WorkflowDiscoveryConfig,
  WorkflowDiscoveryWithSource as WorkflowDiscoveryWithSource,
  WorkflowSource as WorkflowSource,
  WorkflowWithSource as WorkflowWithSource,
} from './infra/config/loaders/workflowLoader.js';
export {
  saveProjectConfig,
  updateProjectConfig,
  isVerboseMode,
  type ProjectLocalConfig,
} from './infra/config/project/index.js';

// Prompt composition
export {
  composeTaktPromptPayload,
} from './shared/prompts/facetedPayload.js';
export type {
  ComposeTaktPromptPayloadParams,
} from './shared/prompts/facetedPayload.js';

// Workflow engine
export {
  WorkflowEngine,
  isOutputContractItem,
} from './core/workflow/index.js';
export type {
  WorkflowEvents,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  WorkflowEngineOptions,
  ProviderType,
} from './core/workflow/index.js';

// Agent usecases
export {
  executeAgent,
  generateReport,
  executePart,
  judgeStatus,
  evaluateCondition,
  decomposeTask,
} from './agents/agent-usecases.js';
export type { JudgeStatusResult } from './agents/agent-usecases.js';

// Portable project-template contract. This remains side-effect free so tools
// can validate a pack before applying it to a working tree.
export {
  parseProjectTemplateManifest,
  serializeProjectTemplateManifest,
  parseProjectTemplateGithubSourceSpec,
  PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_PATH,
  MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES,
  projectTemplateSourceDescriptorV1JsonSchema,
  parseProjectTemplateSourceDescriptor,
  parseProjectTemplateSourceDescriptorJson,
  serializeProjectTemplateSourceDescriptor,
  calculateProjectTemplateSourceDescriptorSha256,
  GithubTemplateSourceResolutionError,
  resolveGithubTemplateSource,
  parseTemplateLock,
  serializeTemplateLock,
  calculateProjectTemplateManifestSha256,
  validateManifestLockPair,
  validateDetectedTemplateCapabilities,
  classifyProjectTemplateEntry,
  scanProjectTemplateDirectory,
  createProjectTemplateExportPlan,
  writeTaktpack,
  inspectTaktpack,
  calculateProjectTemplateTargetPreconditionToken,
  captureProjectTemplateTargetSnapshot,
  createProjectTemplateApplyPlan,
  prepareProjectTemplateApplyPlan,
  inspectProjectTemplateApplyGuard,
  runProjectTemplateDoctor,
  PROJECT_TEMPLATE_LOCK_PATH,
  applyProjectTemplatePlan,
  recoverProjectTemplateApply,
  rollbackProjectTemplateApply,
  canonicalizeTaktpackJson,
  TAKTPACK_ENTRY_NAMES,
  TAKTPACK_BLOB_PREFIX,
  DEFAULT_TAKTPACK_LIMITS,
  projectTemplateManifestV1JsonSchema,
  projectTemplateLockV1JsonSchema,
  ProjectTemplateValidationError,
  TaktpackError,
} from './features/project-template/index.js';
export type {
  ProjectTemplateManifestV1,
  ProjectTemplateGithubRefSourceSpec,
  ProjectTemplateGithubReleaseAssetSourceSpec,
  ProjectTemplateGithubSourceSpec,
  ProjectTemplateSourceDescriptorPackV1,
  ProjectTemplateRepertoireCapabilityV1,
  ProjectTemplateRepertoireDependencyV1,
  ProjectTemplateSourceDescriptorV1,
  GithubTemplateSourceResolutionErrorCode,
  GithubTemplateResolveRefInput,
  GithubTemplateReadFileInput,
  GithubTemplateGetReleaseInput,
  GithubTemplateReadReleaseAssetInput,
  GithubTemplateSourceMetadataPort,
  GithubTemplateCurrentSourceEvidence,
  GithubTemplateUpdateState,
  ResolveGithubTemplateSourceOptions,
  ResolvedGithubTemplateSource,
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
  ProjectTemplateValidationErrorCode,
  ProjectTemplateClassification,
  ProjectTemplateClassificationReason,
  ProjectTemplateClassificationResult,
  ProjectTemplateClassifierInput,
  ProjectTemplateScanLimits,
  ProjectTemplateScanOptions,
  ProjectTemplateScanResult,
  ProjectTemplateExportOptions,
  ProjectTemplateExportPlan,
  TaktpackInspectResult,
  InspectTaktpackOptions,
  WriteTaktpackOptions,
  WriteTaktpackResult,
  TaktpackErrorCode,
  TaktpackArtifactState,
  TaktpackLimits,
  TaktpackDescriptorV1,
  TaktpackExportReportV1,
  TaktpackIndexV1,
  TaktpackLockSeedV1,
  DeepReadonly,
  ProjectTemplateGitTrackingStatus,
  CapturedProjectTemplateTargetEntry,
  ProjectTemplateTargetSnapshot,
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
  ProjectTemplateApplyApprovalEvidence,
  ProjectTemplatePolicyActionMap,
  ProjectTemplateApplyGuardBlockCode,
  ProjectTemplateApplyGuardBlock,
  ProjectTemplateApplyGuardReport,
  InspectProjectTemplateApplyGuardOptions,
  ProjectTemplateDoctorCheck,
  ProjectTemplateDoctorCheckKind,
  ProjectTemplateDoctorReport,
  ProjectTemplateApplyResult,
  ProjectTemplateRecoveryResult,
  ProjectTemplateRollbackResult,
} from './features/project-template/index.js';
