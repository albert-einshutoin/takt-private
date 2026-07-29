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
export type { TaktpackErrorCode } from './errors.js';
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
  ProjectTemplateExportFile,
  ProjectTemplateExportPlan,
  TaktpackInspectResult,
} from './archive-types.js';
export { canonicalizeTaktpackJson } from './canonical-json.js';
export { createProjectTemplateExportPlan } from './export-plan.js';
export { writeTaktpack } from './archive-writer.js';
export { inspectTaktpack } from './archive-inspector.js';
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
