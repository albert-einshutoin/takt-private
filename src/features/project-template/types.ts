/**
 * Public contract for a portable .takt project template pack.
 *
 * Keeping these values independent of the CLI command layer lets other tools,
 * including TaktDesk, inspect and prepare an import without executing it.
 */

export type TemplateEntryPolicy = 'managed' | 'merge' | 'scaffold' | 'excluded';

export type TemplateCapability = 'executable' | 'github-write' | 'external-command';

export interface TemplateSource {
  kind: 'local' | 'git' | 'github';
  uri: string;
  ref: string;
  commit: string;
}

export interface TemplateEntry {
  path: string;
  policy: TemplateEntryPolicy;
  mode: string;
  sha256: string;
  capabilities?: TemplateCapability[];
}

export interface ProjectTemplateManifestV1 {
  schemaVersion: '1.0';
  packVersion: string;
  takt: {
    minVersion: string;
    maxVersion?: string;
  };
  source: TemplateSource;
  capabilities?: TemplateCapability[];
  entries: TemplateEntry[];
}

/**
 * The lock captures the exact source and file digests selected for an import.
 * It is deliberately separate from the manifest so an update can be planned
 * and reviewed before mutable project files are touched.
 */
export interface TemplateLockV1 {
  schemaVersion: '1.0';
  packVersion: string;
  source: TemplateSource;
  entries: Array<Pick<TemplateEntry, 'path' | 'mode' | 'sha256'>>;
}
