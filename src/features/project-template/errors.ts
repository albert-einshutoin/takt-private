export type ProjectTemplateValidationErrorCode =
  | 'INVALID_MANIFEST'
  | 'UNSUPPORTED_SCHEMA_MAJOR'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'UNKNOWN_KEY'
  | 'INVALID_ENTRY'
  | 'INVALID_LOCK'
  | 'INVALID_SEMVER'
  | 'INVALID_SOURCE'
  | 'MISSING_HASH'
  | 'INVALID_HASH'
  | 'INVALID_PATH'
  | 'INVALID_MODE'
  | 'DUPLICATE_ENTRY_PATH'
  | 'PATH_CASE_COLLISION'
  | 'PATH_NORMALIZATION_COLLISION'
  | 'POLICY_CONFLICT'
  | 'UNDECLARED_CAPABILITY'
  | 'NON_PLAIN_OBJECT'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_VERSION_RANGE'
  | 'LOCK_MISMATCH'
  | 'DETECTED_CAPABILITY_MISMATCH';

export class ProjectTemplateValidationError extends Error {
  constructor(
    public readonly code: ProjectTemplateValidationErrorCode,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ProjectTemplateValidationError';
  }
}

export type TaktpackErrorCode =
  | 'INVALID_EXPORT_PLAN'
  | 'EXPORT_REVIEW_REQUIRED'
  | 'OUTPUT_EXISTS'
  | 'UNSAFE_OUTPUT_TARGET'
  | 'SOURCE_CHANGED'
  | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'UNSAFE_ARCHIVE_ENTRY'
  | 'INVALID_ARCHIVE_ORDER'
  | 'DUPLICATE_ARCHIVE_ENTRY'
  | 'TRUNCATED_ARCHIVE'
  | 'TRAILING_ARCHIVE_DATA'
  | 'INVALID_PACK'
  | 'MISSING_ARCHIVE_ENTRY'
  | 'ORPHAN_BLOB'
  | 'HASH_MISMATCH'
  | 'ARCHIVE_WRITE_FAILED'
  | 'ARCHIVE_READ_FAILED'
  | 'DURABILITY_FAILED'
  | 'CLEANUP_FAILED';

export type TaktpackArtifactState = 'not-published' | 'published';

export class TaktpackError extends Error {
  constructor(
    public readonly code: TaktpackErrorCode,
    message: string,
    public readonly field?: string,
    public readonly artifactState?: TaktpackArtifactState,
  ) {
    super(message);
    this.name = 'TaktpackError';
  }
}
