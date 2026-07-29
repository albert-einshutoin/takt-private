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
  projectTemplateManifestV1JsonSchema,
  projectTemplateLockV1JsonSchema,
} from './schema.js';
export { ProjectTemplateValidationError } from './errors.js';
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
