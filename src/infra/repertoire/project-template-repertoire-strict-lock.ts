import { Buffer } from 'node:buffer';
import { TextDecoder, types } from 'node:util';
import {
  SEMVER_PATTERN_SOURCE,
} from '../../features/project-template/validation.js';

const MAX_LOCK_BYTES = 64 * 1024;
const SOURCE_PATTERN =
  /^github:(?![a-z0-9-]*--)[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/(?!\.{1,2}$)(?!.*\.git$)[a-z0-9._-]{1,100}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const UTC_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const YAML_FEATURE_MARKER_PATTERN = /[&*![\]{}]/;
const SEMVER_PATTERN = new RegExp(SEMVER_PATTERN_SOURCE);
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: false,
});
const UINT8_ARRAY_BYTE_LENGTH_GETTER =
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype) as object,
    'byteLength',
  )!.get!;
const UINT8_ARRAY_BUFFER_GETTER =
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype) as object,
    'buffer',
  )!.get!;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const CAPTURED_BUFFER_ALLOC_UNSAFE_SLOW = Buffer.allocUnsafeSlow;
const CAPTURED_BUFFER_RECEIVER = Buffer;
const CAPTURED_DATE = Date;
const CAPTURED_DATE_TO_ISO_STRING = Date.prototype.toISOString;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_REGEXP_TEST = RegExp.prototype.test;
const CAPTURED_STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const CAPTURED_STRING_INDEX_OF = String.prototype.indexOf;
const CAPTURED_STRING_SLICE = String.prototype.slice;
const CAPTURED_STRING_STARTS_WITH = String.prototype.startsWith;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;
const CAPTURED_TYPES_IS_SHARED_ARRAY_BUFFER = types.isSharedArrayBuffer;
const CAPTURED_TYPES_IS_UINT8_ARRAY = types.isUint8Array;
const CAPTURED_WEAK_SET_ADD = WeakSet.prototype.add;
const CAPTURED_WEAK_SET_HAS = WeakSet.prototype.has;
const STRICT_LOCK_ERRORS = new WeakSet<object>();

export type ProjectTemplateRepertoireStrictLockErrorCode =
  | 'INVALID_ARGUMENT'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_ENCODING'
  | 'INVALID_YAML'
  | 'INVALID_LOCK';

const ERROR_MESSAGES:
Record<ProjectTemplateRepertoireStrictLockErrorCode, string> = {
  INVALID_ARGUMENT: 'Repertoire lock input is invalid',
  LIMIT_EXCEEDED: 'Repertoire lock byte limit was exceeded',
  INVALID_ENCODING: 'Repertoire lock encoding is invalid',
  INVALID_YAML: 'Repertoire lock YAML is invalid',
  INVALID_LOCK: 'Repertoire lock value is invalid',
};

export class ProjectTemplateRepertoireStrictLockError extends Error {
  declare public readonly code: ProjectTemplateRepertoireStrictLockErrorCode;

  constructor(
    code: ProjectTemplateRepertoireStrictLockErrorCode,
  ) {
    const validatedCode = validateErrorCode(code);
    super(errorMessage(validatedCode));
    defineOwn(this, 'code', validatedCode);
    CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_SET_ADD,
      STRICT_LOCK_ERRORS,
      [this],
    );
    const descriptor = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_CREATE,
      CAPTURED_OBJECT_RECEIVER,
      [null],
    ) as PropertyDescriptor;
    descriptor.configurable = true;
    descriptor.enumerable = true;
    descriptor.value = 'ProjectTemplateRepertoireStrictLockError';
    descriptor.writable = true;
    CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_DEFINE_PROPERTY,
      CAPTURED_OBJECT_RECEIVER,
      [this, 'name', descriptor],
    );
  }
}

function validateErrorCode(
  code: unknown,
): ProjectTemplateRepertoireStrictLockErrorCode {
  switch (code) {
    case 'INVALID_ARGUMENT':
    case 'LIMIT_EXCEEDED':
    case 'INVALID_ENCODING':
    case 'INVALID_YAML':
    case 'INVALID_LOCK':
      return code;
    default:
      return 'INVALID_ARGUMENT';
  }
}

function errorMessage(
  code: ProjectTemplateRepertoireStrictLockErrorCode,
): string {
  switch (code) {
    case 'INVALID_ARGUMENT': return ERROR_MESSAGES.INVALID_ARGUMENT;
    case 'LIMIT_EXCEEDED': return ERROR_MESSAGES.LIMIT_EXCEEDED;
    case 'INVALID_ENCODING': return ERROR_MESSAGES.INVALID_ENCODING;
    case 'INVALID_YAML': return ERROR_MESSAGES.INVALID_YAML;
    case 'INVALID_LOCK': return ERROR_MESSAGES.INVALID_LOCK;
    default: return ERROR_MESSAGES.INVALID_ARGUMENT;
  }
}

export interface ProjectTemplateRepertoireStrictLock {
  readonly source: `github:${string}/${string}`;
  readonly ref: string;
  readonly version: string;
  readonly commit: string;
  readonly importedAt: string;
}

function failure(
  code: ProjectTemplateRepertoireStrictLockErrorCode,
): ProjectTemplateRepertoireStrictLockError {
  return new ProjectTemplateRepertoireStrictLockError(code);
}

function isFailure(
  value: unknown,
): value is ProjectTemplateRepertoireStrictLockError {
  return typeof value === 'object'
    && value !== null
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_SET_HAS,
      STRICT_LOCK_ERRORS,
      [value],
    ) === true;
}

function defineOwn(
  target: object,
  key: PropertyKey,
  value: unknown,
): void {
  const descriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE,
    CAPTURED_OBJECT_RECEIVER,
    [null],
  ) as PropertyDescriptor;
  descriptor.configurable = true;
  descriptor.enumerable = true;
  descriptor.value = value;
  descriptor.writable = true;
  CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_DEFINE_PROPERTY,
    CAPTURED_OBJECT_RECEIVER,
    [target, key, descriptor],
  );
}

function freeze<T>(value: T): Readonly<T> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Readonly<T>;
}

function exactByteLength(value: unknown): number {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_TYPES_IS_PROXY(value)
    || !CAPTURED_TYPES_IS_UINT8_ARRAY(value)
  ) throw failure('INVALID_ARGUMENT');
  try {
    const buffer = CAPTURED_REFLECT_APPLY(
      UINT8_ARRAY_BUFFER_GETTER,
      value,
      [],
    );
    if (CAPTURED_TYPES_IS_SHARED_ARRAY_BUFFER(buffer)) {
      throw failure('INVALID_ARGUMENT');
    }
    return CAPTURED_REFLECT_APPLY(
      UINT8_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
  } catch {
    throw failure('INVALID_ARGUMENT');
  }
}

interface BoundedByteSnapshot {
  readonly bytes: Buffer;
  readonly byteLength: number;
}

function copyBoundedBytes(value: unknown): BoundedByteSnapshot {
  const byteLength = exactByteLength(value);
  if (byteLength > MAX_LOCK_BYTES) throw failure('LIMIT_EXCEEDED');
  try {
    const bytes = CAPTURED_REFLECT_APPLY(
      CAPTURED_BUFFER_ALLOC_UNSAFE_SLOW,
      CAPTURED_BUFFER_RECEIVER,
      [byteLength],
    ) as Buffer;
    const source = value as Uint8Array;
    // Why: Buffer.from consults mutable pool and TypedArray length surfaces.
    // Bounded integer-indexed copying snapshots only internal-slot bytes and
    // cannot hand private output storage to an attacker-controlled getter.
    for (let index = 0; index < byteLength; index += 1) {
      bytes[index] = source[index]!;
    }
    return { bytes, byteLength };
  } catch {
    throw failure('INVALID_ARGUMENT');
  }
}

function rejectExcessiveYamlDepth(text: string): void {
  // Why: reject pathological indentation before canonical-shape scanning;
  // the G3 boundary never builds attacker-influenced recursive structures.
  let lineStart = true;
  let indentation = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = CAPTURED_REFLECT_APPLY(
      CAPTURED_STRING_CHAR_CODE_AT,
      text,
      [index],
    ) as number;
    if (lineStart) {
      if (code === 0x20) {
        indentation += 1;
        if (indentation > 64) throw failure('INVALID_YAML');
        continue;
      }
      lineStart = false;
    }
    if (code === 0x0a || code === 0x0d) {
      lineStart = true;
      indentation = 0;
    }
  }
}

function test(pattern: RegExp, value: string): boolean {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_REGEXP_TEST,
    pattern,
    [value],
  ) as boolean;
}

function requireCanonicalImportedAt(value: string): void {
  if (!test(UTC_ISO_PATTERN, value)) throw failure('INVALID_LOCK');
  let parsed: Date;
  try {
    parsed = new CAPTURED_DATE(value);
    if (
      CAPTURED_REFLECT_APPLY(
        CAPTURED_DATE_TO_ISO_STRING,
        parsed,
        [],
      ) !== value
    ) throw failure('INVALID_LOCK');
  } catch (error) {
    if (isFailure(error)) throw error;
    throw failure('INVALID_LOCK');
  }
}

function deriveVersion(ref: string): string {
  const version = CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_STARTS_WITH,
    ref,
    ['v'],
  )
    ? CAPTURED_REFLECT_APPLY(CAPTURED_STRING_SLICE, ref, [1]) as string
    : ref;
  if (!test(SEMVER_PATTERN, version)) throw failure('INVALID_LOCK');
  if (ref !== version && ref !== `v${version}`) {
    throw failure('INVALID_LOCK');
  }
  return version;
}

/**
 * Recognize only the exact mapping emitted by the repertoire lock writer.
 *
 * Why: G3 accepts this canonical four-line subset and fails closed for every
 * other YAML spelling, so no third-party parser or post-init hook is involved.
 */
function prevalidateCanonicalShape(
  text: string,
): Record<'source' | 'ref' | 'commit' | 'imported_at', string> | undefined {
  const prefixes = [
    'source: ',
    'ref: ',
    'commit: ',
    'imported_at: ',
  ] as const;
  const values: string[] = [];
  let start = 0;
  for (let index = 0; index < prefixes.length; index += 1) {
    const end = CAPTURED_REFLECT_APPLY(
      CAPTURED_STRING_INDEX_OF,
      text,
      ['\n', start],
    ) as number;
    if (
      end < 0
      || !CAPTURED_REFLECT_APPLY(
        CAPTURED_STRING_STARTS_WITH,
        text,
        [prefixes[index], start],
      )
    ) return undefined;
    const valueStart = start + prefixes[index]!.length;
    defineOwn(
      values,
      index,
      CAPTURED_REFLECT_APPLY(
        CAPTURED_STRING_SLICE,
        text,
        [valueStart, end],
      ),
    );
    start = end + 1;
  }
  if (start !== text.length) return undefined;
  const source = values[0]!;
  const ref = values[1]!;
  const commit = values[2]!;
  const importedAt = values[3]!;
  if (
    test(YAML_FEATURE_MARKER_PATTERN, source)
    || test(YAML_FEATURE_MARKER_PATTERN, ref)
    || test(YAML_FEATURE_MARKER_PATTERN, commit)
    || test(YAML_FEATURE_MARKER_PATTERN, importedAt)
  ) return undefined;
  if (
    !test(SOURCE_PATTERN, source)
    || source.length > 256
    || ref.length > 128
    || !test(COMMIT_PATTERN, commit)
  ) throw failure('INVALID_LOCK');
  deriveVersion(ref);
  requireCanonicalImportedAt(importedAt);
  const raw = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE,
    CAPTURED_OBJECT_RECEIVER,
    [null],
  ) as Record<string, string>;
  defineOwn(raw, 'source', source);
  defineOwn(raw, 'ref', ref);
  defineOwn(raw, 'commit', commit);
  defineOwn(raw, 'imported_at', importedAt);
  return raw as Record<
  'source' | 'ref' | 'commit' | 'imported_at',
  string
  >;
}

function materializeLock(
  raw: Record<'source' | 'ref' | 'commit' | 'imported_at', string>,
): ProjectTemplateRepertoireStrictLock {
  const version = deriveVersion(raw.ref);
  requireCanonicalImportedAt(raw.imported_at);
  return freeze({
    source: raw.source as `github:${string}/${string}`,
    ref: raw.ref,
    version,
    commit: raw.commit,
    importedAt: raw.imported_at,
  }) as ProjectTemplateRepertoireStrictLock;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let start = 0;
  while (start < text.length) {
    const found = CAPTURED_REFLECT_APPLY(
      CAPTURED_STRING_INDEX_OF,
      text,
      [needle, start],
    ) as number;
    if (found < 0) return count;
    count += 1;
    start = found + needle.length;
  }
  return count;
}

function rejectNonCanonicalLock(text: string): never {
  // Why: G3 is a trust boundary, so syntactically valid but non-canonical
  // YAML is not accepted. This also keeps all post-init attacker callbacks
  // outside the parser by avoiding third-party YAML execution entirely.
  if (
    test(YAML_FEATURE_MARKER_PATTERN, text)
    || countOccurrences(text, 'source: ') > 1
    || countOccurrences(text, 'ref: ') > 1
    || countOccurrences(text, 'commit: ') > 1
    || countOccurrences(text, 'imported_at: ') > 1
    || countOccurrences(text, '<<:') !== 0
  ) throw failure('INVALID_YAML');
  throw failure('INVALID_LOCK');
}

export function parseProjectTemplateRepertoireStrictLock(
  value: unknown,
): ProjectTemplateRepertoireStrictLock {
  // Why: legacy CLI listing remains permissive elsewhere. Inspection accepts
  // only this bounded, canonical writer representation at the trust boundary.
  const snapshot = copyBoundedBytes(value);
  const bytes = snapshot.bytes;
  if (
    snapshot.byteLength >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf
  ) throw failure('INVALID_YAML');
  let text: string;
  try {
    text = CAPTURED_REFLECT_APPLY(
      CAPTURED_TEXT_DECODER_DECODE,
      FATAL_UTF8_DECODER,
      [bytes],
    ) as string;
  } catch {
    throw failure('INVALID_ENCODING');
  }
  if (
    text.length === 0
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_STRING_CHAR_CODE_AT,
      text,
      [0],
    ) === 0xfeff
  ) {
    throw failure('INVALID_YAML');
  }
  rejectExcessiveYamlDepth(text);
  // Why: only the writer's exact canonical form is accepted; all other YAML
  // spellings fail closed without invoking third-party parser code.
  const canonical = prevalidateCanonicalShape(text);
  if (canonical !== undefined) return materializeLock(canonical);
  return rejectNonCanonicalLock(text);
}
