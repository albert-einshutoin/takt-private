/** Public contract for a portable `.takt/` project template pack. */

import type { ProjectTemplateRepertoireDependencyV1 } from './source-descriptor.js';

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

/**
 * Capability evidence produced by a classifier or archive inspector.
 * An empty detection is evidence of no detected capability for that entry; an
 * omitted entry means inspection has not supplied evidence for that path.
 */
export interface DetectedTemplateCapabilities {
  path: string;
  capabilities: TemplateCapability[];
  /**
   * Empty capabilities are authoritative only when inspection completed.
   * Optional for v1 callers created before classifier evidence carried status.
   */
  inspectionStatus?: 'complete' | 'incomplete' | 'blocked';
}

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
  /** Portable ASCII relative path with segments no longer than 255 characters. */
  uri: string;
  ref: 'workspace';
  commit: string;
}

export type TemplateSource = GithubTemplateSource | GitTemplateSource | LocalTemplateSource;

/** A save draft issued by the editor authority, never a user-selected URL. */
export interface DerivedTemplateSourceV1_1 {
  kind: 'derived';
  method: 'takt-editor-v1';
  draftId: string;
}

export interface TemplateEntry {
  /** ASCII path relative to `.takt/`; each segment is at most 255 characters. */
  path: string;
  policy: TemplateEntryPolicy;
  mode: string;
  sha256: string;
  capabilities?: TemplateCapability[];
}

export interface ProjectTemplateManifestV1_0 {
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

/** Human-readable identity shown by the editor before a save is approved. */
export interface ProjectTemplateManifestMetadataV1_1 {
  name: string;
  description: string;
}

/** A pack created independently of a prior archive. */
export interface ProjectTemplateManifestRootDerivationV1_1 {
  kind: 'root';
}

/** Immutable evidence that an editor save derived from a reviewed pack. */
export interface ProjectTemplateManifestDerivedDerivationV1_1 {
  kind: 'derived';
  operation: 'editor-save';
  draftId: string;
  editDocumentSha256: string;
  parent: {
    archiveSha256: string;
    manifestSha256: string;
    packVersion: string;
  };
}

export type ProjectTemplateManifestDerivationV1_1 =
  | ProjectTemplateManifestRootDerivationV1_1
  | ProjectTemplateManifestDerivedDerivationV1_1;

/**
 * Editor-save manifest contract. A derived manifest records only its immutable
 * parent archive identity; it never asserts the hash of the archive currently
 * being written, which prevents a self-referential hash contract.
 */
export interface ProjectTemplateManifestV1_1 {
  schemaVersion: '1.1';
  packVersion: string;
  metadata: ProjectTemplateManifestMetadataV1_1;
  derivation: ProjectTemplateManifestDerivationV1_1;
  takt: {
    minVersion: string;
    maxVersion?: string;
  };
  source: TemplateSource | DerivedTemplateSourceV1_1;
  repertoireDependencies: ProjectTemplateRepertoireDependencyV1[];
  capabilities?: TemplateCapability[];
  entries: TemplateEntry[];
}

export type ProjectTemplateManifestV1 =
  | ProjectTemplateManifestV1_0
  | ProjectTemplateManifestV1_1;

export interface TemplateLockEntry {
  path: string;
  policy: TemplateEntryPolicy;
  mode: string;
  sha256: string;
  capabilities: TemplateCapability[];
}

/** Immutable reviewed state bound to one canonical manifest digest. */
export interface TemplateLockV1_0 {
  schemaVersion: '1.0';
  manifestSha256: string;
  packVersion: string;
  source: TemplateSource;
  capabilities: TemplateCapability[];
  entries: TemplateLockEntry[];
}

/**
 * Immutable reviewed state for an editor-save manifest. These authority fields
 * deliberately duplicate the manifest: a lock must not be replayable against
 * another reviewed lineage merely because pack content happens to look alike.
 * Human-readable metadata is still manifest-hash-bound and is not duplicated.
 */
export interface TemplateLockV1_1 {
  schemaVersion: '1.1';
  manifestSha256: string;
  packVersion: string;
  source: ProjectTemplateManifestV1_1['source'];
  derivation: ProjectTemplateManifestDerivationV1_1;
  repertoireDependencies: ProjectTemplateRepertoireDependencyV1[];
  capabilities: TemplateCapability[];
  entries: TemplateLockEntry[];
}

export type TemplateLockV1 = TemplateLockV1_0 | TemplateLockV1_1;
