import type { DetectedTemplateCapabilities, TemplateEntryPolicy } from './types.js';

export type ProjectTemplateClassification =
  | 'portable-candidate'
  | 'project-owned'
  | 'excluded'
  | 'blocked';

export type ProjectTemplateClassificationReason =
  | 'PROJECT_CONFIG'
  | 'SHARED_WORKFLOW'
  | 'SHARED_FACET'
  | 'SHARED_PROVIDER_OPTIONS'
  | 'PROJECT_AUTOMATION'
  | 'PROJECT_QUALITY_GATE'
  | 'UNKNOWN_DEFAULT_DENY'
  | 'RUNTIME_STATE'
  | 'SENSITIVE_FILENAME'
  | 'SECRET_CONTENT'
  | 'ABSOLUTE_PATH_CONTENT'
  | 'BINARY_CONTENT'
  | 'ROOT_SYMLINK'
  | 'SYMLINK'
  | 'HARD_LINK'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'PATH_ESCAPE'
  | 'PATH_COLLISION'
  | 'UNSAFE_ENTRY_PATH'
  | 'NODE_LIMIT_EXCEEDED'
  | 'FILE_LIMIT_EXCEEDED'
  | 'SINGLE_FILE_LIMIT_EXCEEDED'
  | 'TOTAL_BYTES_LIMIT_EXCEEDED'
  | 'SCAN_LIMIT_EXCEEDED'
  | 'DEPTH_LIMIT_EXCEEDED'
  | 'FILE_CHANGED_DURING_SCAN'
  | 'FILE_READ_OVERFLOW'
  | 'READ_FAILED'
  | 'ROOT_UNSAFE';

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
