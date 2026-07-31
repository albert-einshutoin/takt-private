export type ProjectTemplateValidationErrorCode =
  | 'INVALID_MANIFEST'
  | 'UNSUPPORTED_SCHEMA_MAJOR'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'UNKNOWN_KEY'
  | 'INVALID_ENTRY'
  | 'INVALID_LOCK'
  | 'INVALID_SEMVER'
  | 'INVALID_SOURCE'
  | 'INVALID_SOURCE_DESCRIPTOR'
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

const ERROR_OBJECT_RECEIVER = Object;
const ERROR_OBJECT_CREATE = Object.create;
const ERROR_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const ERROR_REFLECT_APPLY = Reflect.apply;

function defineErrorName(error: Error, name: string): void {
  const descriptor = ERROR_REFLECT_APPLY(
    ERROR_OBJECT_CREATE,
    ERROR_OBJECT_RECEIVER,
    [null],
  ) as PropertyDescriptor;
  // Why: direct assignment can invoke a post-init setter on the public error
  // prototype and reenter a validation or authority boundary.
  descriptor.configurable = true;
  descriptor.enumerable = true;
  descriptor.value = name;
  descriptor.writable = true;
  ERROR_REFLECT_APPLY(
    ERROR_OBJECT_DEFINE_PROPERTY,
    ERROR_OBJECT_RECEIVER,
    [error, 'name', descriptor],
  );
}

export class ProjectTemplateValidationError extends Error {
  constructor(
    public readonly code: ProjectTemplateValidationErrorCode,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    defineErrorName(this, 'ProjectTemplateValidationError');
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
    defineErrorName(this, 'TaktpackError');
  }
}
