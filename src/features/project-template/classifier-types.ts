import type { DetectedTemplateCapabilities, TemplateEntryPolicy } from './types.js';

export type ProjectTemplateClassification =
  | 'portable-candidate'
  | 'project-owned'
  | 'excluded'
  | 'blocked';

export const PROJECT_TEMPLATE_CLASSIFICATION_REASONS = [
  'PROJECT_CONFIG',
  'SHARED_WORKFLOW',
  'SHARED_FACET',
  'SHARED_PROVIDER_OPTIONS',
  'PROJECT_AUTOMATION',
  'PROJECT_QUALITY_GATE',
  'UNKNOWN_DEFAULT_DENY',
  'RUNTIME_STATE',
  'SENSITIVE_FILENAME',
  'SECRET_CONTENT',
  'ABSOLUTE_PATH_CONTENT',
  'BINARY_CONTENT',
  'ROOT_SYMLINK',
  'SYMLINK',
  'HARD_LINK',
  'UNSUPPORTED_FILE_TYPE',
  'PATH_ESCAPE',
  'PATH_COLLISION',
  'UNSAFE_ENTRY_PATH',
  'INVALID_CLASSIFIER_INPUT',
  'NODE_LIMIT_EXCEEDED',
  'FILE_LIMIT_EXCEEDED',
  'SINGLE_FILE_LIMIT_EXCEEDED',
  'TOTAL_BYTES_LIMIT_EXCEEDED',
  'SCAN_LIMIT_EXCEEDED',
  'DEPTH_LIMIT_EXCEEDED',
  'FILE_CHANGED_DURING_SCAN',
  'DIRECTORY_CHANGED_DURING_SCAN',
  'FILE_READ_OVERFLOW',
  'READ_FAILED',
  'ROOT_UNSAFE',
] as const;

export type ProjectTemplateClassificationReason =
  typeof PROJECT_TEMPLATE_CLASSIFICATION_REASONS[number];

export const DEFAULT_PROJECT_TEMPLATE_MAX_NODES = 8_192;

/**
 * A complete scan can report one exclusion per `.takt` node plus the fixed,
 * redacted `.devloop` sibling sentinel recorded outside that node budget.
 */
export const MAX_PROJECT_TEMPLATE_EXPORT_EXCLUSIONS =
  DEFAULT_PROJECT_TEMPLATE_MAX_NODES + 1;

export interface ProjectTemplateClassifierInput {
  relativePath: string;
  content?: Uint8Array;
  /** Known local prefixes whose presence makes otherwise opaque content non-portable. */
  absolutePathPrefixes?: readonly string[];
  bytes: number;
  mode?: string;
  sha256?: string;
}

export interface ProjectTemplateClassificationResult {
  relativePath: string;
  classification: ProjectTemplateClassification;
  reasonCode: ProjectTemplateClassificationReason;
  summary: string;
  bytes: number;
  mode?: string;
  sha256?: string;
  suggestedPolicy?: TemplateEntryPolicy;
  detectedCapabilities: DetectedTemplateCapabilities;
  /** True when capabilities or project-owned policy need explicit approval. */
  reviewRequired: boolean;
  warnings: string[];
}

export interface ProjectTemplateScanLimits {
  maxNodes: number;
  maxFiles: number;
  maxSingleFileBytes: number;
  maxTotalBytes: number;
  maxScanBytes: number;
  maxDepth: number;
}

export type ProjectTemplateScanOptions = Partial<ProjectTemplateScanLimits>;

export interface ProjectTemplateScanResult {
  scanStatus: 'complete' | 'incomplete' | 'blocked';
  canExport: boolean;
  /** True when project-owned entries require an explicit policy decision. */
  reviewRequired: boolean;
  entries: ProjectTemplateClassificationResult[];
  counts: {
    nodes: number;
    files: number;
    bytes: number;
  };
}
