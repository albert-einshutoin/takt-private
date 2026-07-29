export {
  parseProjectTemplateManifest,
  serializeProjectTemplateManifest,
} from './manifest.js';
export { parseTemplateLock, serializeTemplateLock } from './lock.js';
export { projectTemplateManifestV1JsonSchema } from './schema.js';
export { ProjectTemplateValidationError } from './errors.js';
export type {
  ProjectTemplateManifestV1,
  TemplateCapability,
  TemplateEntry,
  TemplateEntryPolicy,
  TemplateLockV1,
  TemplateSource,
} from './types.js';
export type { ProjectTemplateValidationErrorCode } from './errors.js';
