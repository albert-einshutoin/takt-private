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
  | 'LOCK_MISMATCH';

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
