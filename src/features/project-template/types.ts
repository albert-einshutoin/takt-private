/** Public contract for a portable `.takt/` project template pack. */

/** Replaces the destination file and keeps it managed by future updates. */
export type ManagedTemplateEntryPolicy = 'managed';
/** Uses a three-way merge against the previously locked pack version. */
export type MergeTemplateEntryPolicy = 'merge';
/** Creates the destination only when it does not already exist. */
export type ScaffoldTemplateEntryPolicy = 'scaffold';
/** Records content that must never be copied into the destination project. */
export type ExcludedTemplateEntryPolicy = 'excluded';

export type TemplateEntryPolicy =
  | ManagedTemplateEntryPolicy
  | MergeTemplateEntryPolicy
  | ScaffoldTemplateEntryPolicy
  | ExcludedTemplateEntryPolicy;

export type TemplateCapability = 'executable' | 'github-write' | 'external-command';

export interface GithubTemplateSource {
  kind: 'github';
  /** Canonical HTTPS repository URL without `.git`, query, or fragment. */
  uri: `https://github.com/${string}/${string}`;
  ref: string;
  commit: string;
}

export interface GitTemplateSource {
  kind: 'git';
  /** Credential-free HTTPS repository URL without query or fragment. */
  uri: `https://${string}`;
  ref: string;
  commit: string;
}

export interface LocalTemplateSource {
  kind: 'local';
  /** Portable relative POSIX path; absolute workstation paths are forbidden. */
  uri: string;
  ref: 'workspace';
  commit: string;
}

export type TemplateSource = GithubTemplateSource | GitTemplateSource | LocalTemplateSource;

export interface TemplateEntry {
  /** Relative to the `.takt/` root; the path must not include a `.takt/` prefix. */
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

export interface TemplateLockEntry {
  path: string;
  policy: TemplateEntryPolicy;
  mode: string;
  sha256: string;
  capabilities: TemplateCapability[];
}

/** Immutable reviewed state bound to one canonical manifest digest. */
export interface TemplateLockV1 {
  schemaVersion: '1.0';
  manifestSha256: string;
  packVersion: string;
  source: TemplateSource;
  capabilities: TemplateCapability[];
  entries: TemplateLockEntry[];
}
