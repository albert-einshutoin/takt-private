export type ProjectTemplateValidationErrorCode =
  | 'INVALID_MANIFEST'
  | 'UNSUPPORTED_SCHEMA_MAJOR'
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
  | 'POLICY_CONFLICT'
  | 'UNDECLARED_CAPABILITY';

export class ProjectTemplateValidationError extends Error {
  constructor(
    public readonly code: ProjectTemplateValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectTemplateValidationError';
  }
}
