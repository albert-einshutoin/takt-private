import type {
  ProjectTemplateClassificationReason,
} from './classifier-types.js';
import type {
  ProjectTemplateManifestV1,
  TemplateCapability,
  TemplateEntryPolicy,
  TemplateLockV1,
  TemplateSource,
} from './types.js';

export const TAKTPACK_ENTRY_NAMES = [
  'pack.json',
  'manifest.json',
  'export-report.json',
] as const;

export const TAKTPACK_BLOB_PREFIX = 'blobs/sha256/';

export interface TaktpackLimits {
  maxEntries: number;
  maxPackJsonBytes: number;
  maxManifestJsonBytes: number;
  maxExportReportJsonBytes: number;
  maxBlobBytes: number;
  maxTotalBytes: number;
  maxArchiveBytes: number;
}

export const DEFAULT_TAKTPACK_LIMITS: Readonly<TaktpackLimits> = Object.freeze({
  maxEntries: 4_099,
  maxPackJsonBytes: 4 * 1024 * 1024,
  maxManifestJsonBytes: 4 * 1024 * 1024,
  maxExportReportJsonBytes: 1024 * 1024,
  maxBlobBytes: 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxArchiveBytes: 40 * 1024 * 1024,
});

export interface TaktpackDescriptorV1 {
  format: 'taktpack';
  version: '1.0';
  archive: 'ustar';
  contentAddressed: true;
}

export interface TaktpackExportReportV1 {
  schemaVersion: '1.0';
  counts: Record<TemplateEntryPolicy, number>;
  excludedReasons: Partial<Record<ProjectTemplateClassificationReason, number>>;
  warnings: readonly [];
}

export interface ProjectTemplateExportOptions {
  packVersion: string;
  takt: { minVersion: string; maxVersion?: string };
  source: TemplateSource;
  policies?: Readonly<Record<string, Exclude<TemplateEntryPolicy, 'excluded'>>>;
  approvedCapabilities?: readonly TemplateCapability[];
}

export interface ProjectTemplateExportFile {
  path: string;
  absolutePath: string;
  bytes: number;
  mode: string;
  sha256: string;
  snapshot: {
    dev: number;
    ino: number;
    nlink: number;
    size: number;
    mode: number;
    mtimeMs: number;
    ctimeMs: number;
  };
}

export interface ProjectTemplateExportPlan {
  descriptor: TaktpackDescriptorV1;
  manifest: ProjectTemplateManifestV1;
  lock: TemplateLockV1;
  report: TaktpackExportReportV1;
}

export interface TaktpackInspectResult {
  descriptor: TaktpackDescriptorV1;
  manifest: ProjectTemplateManifestV1;
  lockSeed: TaktpackLockSeedV1;
  report: TaktpackExportReportV1;
  archiveSha256: string;
  compatibility: {
    status: 'unknown' | 'compatible' | 'incompatible';
    compatible?: boolean;
    currentVersion?: string;
    minVersion: string;
    maxVersion?: string;
  };
}

export interface TaktpackLockSeedV1 {
  kind: 'project-template-lock-seed';
  schemaVersion: TemplateLockV1['schemaVersion'];
  packVersion: TemplateLockV1['packVersion'];
  source: TemplateLockV1['source'];
  capabilities: TemplateLockV1['capabilities'];
  entries: TemplateLockV1['entries'];
}

export interface TaktpackBlobIndexEntry {
  sha256: string;
  bytes: number;
}

export interface TaktpackIndexV1 extends TaktpackDescriptorV1 {
  manifestSha256: string;
  exportReportSha256: string;
  lockSeed: TaktpackLockSeedV1;
  blobs: TaktpackBlobIndexEntry[];
}

export interface InspectTaktpackOptions {
  currentTaktVersion?: string;
  limits?: Partial<TaktpackLimits>;
}

export interface WriteTaktpackOptions {
  force?: boolean;
  signal?: AbortSignal;
  limits?: Partial<TaktpackLimits>;
}

export interface WriteTaktpackResult {
  outputPath: string;
  archiveSha256: string;
  bytes: number;
}
