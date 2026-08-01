import { ProjectTemplateValidationError } from './errors.js';
import { types } from 'node:util';
import type {
  ProjectTemplateValidationErrorCode,
} from './errors.js';
import type {
  TemplateCapability,
  TemplateEntryPolicy,
  TemplateSource,
} from './types.js';

export const MAX_TEMPLATE_ENTRIES = 4096;
export const MAX_TEMPLATE_PATH_LENGTH = 512;
export const MAX_SOURCE_URI_LENGTH = 512;
export const MAX_SOURCE_REF_LENGTH = 256;
export const MAX_SEMVER_LENGTH = 128;

export const TEMPLATE_CAPABILITIES = [
  'executable',
  'github-write',
  'external-command',
] as const satisfies readonly TemplateCapability[];

export const TEMPLATE_ENTRY_POLICIES = [
  'managed',
  'merge',
  'scaffold',
  'excluded',
] as const satisfies readonly TemplateEntryPolicy[];

export const SEMVER_PATTERN_SOURCE = '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$';
export const SHA256_PATTERN_SOURCE = '^[a-f0-9]{64}$';
export const COMMIT_PATTERN_SOURCE = '^[a-f0-9]{40}(?:[a-f0-9]{24})?$';
export const CONTROL_FREE_PATTERN_SOURCE = '^[^\\u0000-\\u001F\\u007F]*$';
export const GITHUB_URI_PATTERN_SOURCE = '^(?!.*\\.git$)https://github\\.com/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/(?!(?:\\.|\\.\\.)$)[A-Za-z0-9._-]{1,100}$';
export const GIT_URI_PATTERN_SOURCE = '^(?!.*%(?:2[fF]|5[cC]))(?!.*\\/\\.{1,2}(?:\\/|$))https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}(?::[1-9][0-9]{0,4})?/[A-Za-z0-9._~!$&\'()*+,;=:@%/-]+$';
export const SOURCE_REF_PATTERN_SOURCE = '^(?!@$)(?!/)(?!\\.)(?!.*//)(?!.*\\.\\.)(?!.*@\\{)(?!.*\\/\\.)(?!.*\\.lock(?:/|$))(?!.*\\.$)(?!.*[\\u0000-\\u0020\\u007F~^:?*\\[\\\\])[^/]+(?:/[^/]+)*$';
const PORTABLE_RELATIVE_PATH_BODY_SOURCE = '(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*:)(?!.*[\\u0000-\\u001F\\u007F])(?!(?:.*\\/)?(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Nn](?:[Ii][Nn]|[Oo][Uu][Tt])\\$|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\\.[^/]*)?(?:/|$))(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*(?:^|/)[^/]*[ .](?:/|$))(?!.*//)[A-Za-z0-9._-]{1,255}(?:/[A-Za-z0-9._-]{1,255})*';
export const LOCAL_SOURCE_URI_PATTERN_SOURCE = `^(?:\\.|${PORTABLE_RELATIVE_PATH_BODY_SOURCE})$`;
export const PROJECT_TEMPLATE_PATH_PATTERN_SOURCE = `^(?!\\.takt(?:/|$))${PORTABLE_RELATIVE_PATH_BODY_SOURCE}$`;

type OwnPropertyDescriptorMap =
  Record<PropertyKey, PropertyDescriptor | undefined>;

const CAPTURED_ARRAY_FROM = Array.from;
const CAPTURED_ARRAY_INCLUDES = Array.prototype.includes;
const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_ARRAY_PROTOTYPE = Array.prototype;
const CAPTURED_ARRAY_RECEIVER = Array;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_REFLECT_RECEIVER = Reflect;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;

function appendArrayValue<T>(values: T[], value: T): void {
  CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_DEFINE_PROPERTY,
    CAPTURED_OBJECT_RECEIVER,
    [values, `${values.length}`, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    }],
  );
}

const SEMVER_PATTERN = new RegExp(SEMVER_PATTERN_SOURCE);
const SHA256_PATTERN = new RegExp(SHA256_PATTERN_SOURCE);
const COMMIT_PATTERN = new RegExp(COMMIT_PATTERN_SOURCE);
const CONTROL_FREE_PATTERN = new RegExp(CONTROL_FREE_PATTERN_SOURCE);
const GITHUB_URI_PATTERN = new RegExp(GITHUB_URI_PATTERN_SOURCE);
const GIT_URI_PATTERN = new RegExp(GIT_URI_PATTERN_SOURCE);
const SOURCE_REF_PATTERN = new RegExp(SOURCE_REF_PATTERN_SOURCE);
const LOCAL_SOURCE_URI_PATTERN = new RegExp(LOCAL_SOURCE_URI_PATTERN_SOURCE);
const PROJECT_TEMPLATE_PATH_PATTERN = new RegExp(PROJECT_TEMPLATE_PATH_PATTERN_SOURCE);
const POSIX_MODE_PATTERN = /^0[0-7]{3}$/;

function codePointLength(value: string): number {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_ARRAY_FROM,
    CAPTURED_ARRAY_RECEIVER,
    [value],
  ).length;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_ARRAY_IS_ARRAY,
      CAPTURED_ARRAY_RECEIVER,
      [value],
    )
  ) return false;
  const prototype = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_PROTOTYPE_OF,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  );
  return prototype === CAPTURED_OBJECT_PROTOTYPE || prototype === null;
}

export function requireRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProjectTemplateValidationError('NON_PLAIN_OBJECT', `${field} must be a plain own-property object`, field);
  }
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as unknown as OwnPropertyDescriptorMap;
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    CAPTURED_REFLECT_RECEIVER,
    [descriptors],
  ) as PropertyKey[];
  for (let index = 0; index < keys.length; index += 1) {
    if (!('value' in descriptors[keys[index]!]!)) {
      throw new ProjectTemplateValidationError('NON_PLAIN_OBJECT', `${field} must not contain accessors`, field);
    }
  }
  return value;
}

export function requireArray(
  value: unknown,
  field: string,
  maxItems: number,
  errorCode: ProjectTemplateValidationErrorCode,
): unknown[] {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])
    || !CAPTURED_REFLECT_APPLY(
      CAPTURED_ARRAY_IS_ARRAY,
      CAPTURED_ARRAY_RECEIVER,
      [value],
    )
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) !== CAPTURED_ARRAY_PROTOTYPE
  ) {
    throw new ProjectTemplateValidationError(errorCode, `${field} must be a plain array`, field);
  }
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as unknown as OwnPropertyDescriptorMap;
  const lengthDescriptor = descriptors['length'];
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    throw new ProjectTemplateValidationError('NON_PLAIN_OBJECT', `${field} must have an intrinsic data length`, field);
  }
  const length = lengthDescriptor.value as number;
  if (length > maxItems) {
    throw new ProjectTemplateValidationError('LIMIT_EXCEEDED', `${field} exceeds the ${maxItems} item limit`, field);
  }
  const ownKeys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    CAPTURED_REFLECT_RECEIVER,
    [descriptors],
  ) as PropertyKey[];
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index]!;
    if (
      typeof key !== 'string'
      || (
        key !== 'length'
        && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)
      )
      || (key !== 'length' && !('value' in descriptors[key]!))
    ) {
      throw new ProjectTemplateValidationError('NON_PLAIN_OBJECT', `${field} must be a dense JSON array without extra properties`, field);
    }
  }
  // Return a descriptor snapshot so later validation never reads caller-owned
  // array indices after the exact data-property boundary has been established.
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new ProjectTemplateValidationError('NON_PLAIN_OBJECT', `${field} must be a dense JSON array without extra properties`, field);
    }
    CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_DEFINE_PROPERTY,
      CAPTURED_OBJECT_RECEIVER,
      [snapshot, `${index}`, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      }],
    );
  }
  return snapshot;
}

export function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    CAPTURED_REFLECT_RECEIVER,
    [value],
  ) as PropertyKey[];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (typeof key !== 'string') {
      throw new ProjectTemplateValidationError(
        'UNKNOWN_KEY',
        `${field} contains a non-string own key outside schema 1.0`,
        field,
      );
    }
    let isAllowed = false;
    for (let allowedIndex = 0; allowedIndex < allowed.length; allowedIndex += 1) {
      if (allowed[allowedIndex] === key) {
        isAllowed = true;
        break;
      }
    }
    if (!isAllowed) {
      throw new ProjectTemplateValidationError('UNKNOWN_KEY', `${field}.${key} is not part of schema 1.0`, `${field}.${key}`);
    }
  }
}

export function requireString(
  value: unknown,
  field: string,
  errorCode: ProjectTemplateValidationErrorCode = 'INVALID_MANIFEST',
  maxLength = MAX_SOURCE_URI_LENGTH,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProjectTemplateValidationError(errorCode, `${field} must be a non-empty string`, field);
  }
  if (codePointLength(value) > maxLength) {
    throw new ProjectTemplateValidationError('LIMIT_EXCEEDED', `${field} exceeds the ${maxLength} character limit`, field);
  }
  return value;
}

export function requireSemVer(value: unknown, field: string): string {
  const version = requireString(value, field, 'INVALID_SEMVER', MAX_SEMVER_LENGTH);
  if (!SEMVER_PATTERN.test(version)) {
    throw new ProjectTemplateValidationError('INVALID_SEMVER', `${field} must be valid SemVer`, field);
  }
  return version;
}

export function requireSchemaVersionV1(
  value: unknown,
  field: string,
  invalidCode: 'INVALID_MANIFEST' | 'INVALID_LOCK',
): '1.0' {
  if (typeof value !== 'string') {
    throw new ProjectTemplateValidationError(invalidCode, `${field} must be a string`, field);
  }
  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (match === null) {
    throw new ProjectTemplateValidationError(invalidCode, `${field} must use major.minor notation`, field);
  }
  if (match[1] !== '1') {
    throw new ProjectTemplateValidationError('UNSUPPORTED_SCHEMA_MAJOR', `${field} major ${match[1]} is not supported`, field);
  }
  if (value !== '1.0') {
    throw new ProjectTemplateValidationError('UNSUPPORTED_SCHEMA_VERSION', `${field} version ${value} is not supported`, field);
  }
  return '1.0';
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left === right ? 0 : (left < right ? -1 : 1);
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return compareNumericIdentifiers(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : (left < right ? -1 : 1);
}

export function compareSemVer(left: string, right: string): number {
  const parse = (version: string): { core: string[]; prerelease: string[] } => {
    const withoutBuild = version.split('+', 1)[0]!;
    const separatorIndex = withoutBuild.indexOf('-');
    const coreText = separatorIndex === -1 ? withoutBuild : withoutBuild.slice(0, separatorIndex);
    const prereleaseText = separatorIndex === -1 ? undefined : withoutBuild.slice(separatorIndex + 1);
    return {
      core: coreText!.split('.'),
      prerelease: prereleaseText?.split('.') ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    // String comparison avoids precision loss for valid SemVer components
    // larger than JavaScript's safe integer range.
    const difference = compareNumericIdentifiers(a.core[index]!, b.core[index]!);
    if (difference !== 0) return difference;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : (a.prerelease.length === 0 ? 1 : -1);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : (leftIdentifier === undefined ? -1 : 1);
    }
    const difference = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (difference !== 0) return difference;
  }
  return 0;
}

function requireControlFree(value: unknown, field: string, maxLength: number): string {
  const text = requireString(value, field, 'INVALID_SOURCE', maxLength);
  if (!CONTROL_FREE_PATTERN.test(text)) {
    throw new ProjectTemplateValidationError('INVALID_SOURCE', `${field} must not contain control characters`, field);
  }
  return text;
}

function parseCommit(value: unknown): string {
  const commit = requireControlFree(value, 'source.commit', 64);
  if (!COMMIT_PATTERN.test(commit)) {
    throw new ProjectTemplateValidationError('INVALID_SOURCE', 'source.commit must be exactly 40 or 64 lowercase hexadecimal characters', 'source.commit');
  }
  return commit;
}

function parseRef(value: unknown): string {
  const ref = requireControlFree(value, 'source.ref', MAX_SOURCE_REF_LENGTH);
  if (!SOURCE_REF_PATTERN.test(ref)) {
    throw new ProjectTemplateValidationError('INVALID_SOURCE', 'source.ref is not a portable Git ref', 'source.ref');
  }
  return ref;
}

function requirePortablePathSegmentLimit(path: string, field: string): void {
  let segmentLength = 0;
  for (let index = 0; index <= path.length; index += 1) {
    if (index === path.length || path[index] === '/') {
      if (segmentLength > 255) {
        throw new ProjectTemplateValidationError(
          'LIMIT_EXCEEDED',
          `${field} contains a path segment longer than 255 ASCII characters`,
          field,
        );
      }
      segmentLength = 0;
    } else {
      segmentLength += 1;
    }
  }
}

function isCanonicalHttpsUrl(uri: string): boolean {
  if (/%(?:2f|5c)/i.test(uri)) return false;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && parsed.href === uri;
  } catch {
    return false;
  }
}

export function parseSource(value: unknown): TemplateSource {
  const source = requireRecord(value, 'source');
  assertAllowedKeys(source, ['kind', 'uri', 'ref', 'commit'], 'source');
  const kind = requireString(source['kind'], 'source.kind', 'INVALID_SOURCE', 16);
  const uri = requireControlFree(source['uri'], 'source.uri', MAX_SOURCE_URI_LENGTH);
  const commit = parseCommit(source['commit']);

  if (kind === 'github') {
    if (!GITHUB_URI_PATTERN.test(uri) || !isCanonicalHttpsUrl(uri)) {
      throw new ProjectTemplateValidationError('INVALID_SOURCE', 'source.uri must be a canonical GitHub HTTPS repository URL without .git, query, or fragment', 'source.uri');
    }
    return { kind, uri: uri as `https://github.com/${string}/${string}`, ref: parseRef(source['ref']), commit };
  }
  if (kind === 'git') {
    if (!GIT_URI_PATTERN.test(uri) || !isCanonicalHttpsUrl(uri)) {
      throw new ProjectTemplateValidationError('INVALID_SOURCE', 'source.uri must be a credential-free HTTPS Git URL without query or fragment', 'source.uri');
    }
    return { kind, uri: uri as `https://${string}`, ref: parseRef(source['ref']), commit };
  }
  if (kind === 'local') {
    requirePortablePathSegmentLimit(uri, 'source.uri');
    if (!LOCAL_SOURCE_URI_PATTERN.test(uri) || source['ref'] !== 'workspace') {
      throw new ProjectTemplateValidationError('INVALID_SOURCE', 'local sources require a portable relative uri and ref "workspace"', 'source');
    }
    return { kind, uri, ref: 'workspace', commit };
  }
  throw new ProjectTemplateValidationError('INVALID_SOURCE', 'source.kind must be local, git, or github', 'source.kind');
}

export function parseCapabilities(
  value: unknown,
  field: string,
  errorCode: ProjectTemplateValidationErrorCode = 'INVALID_ENTRY',
): TemplateCapability[] | undefined {
  if (value === undefined) return undefined;
  const rawCapabilities = requireArray(value, field, TEMPLATE_CAPABILITIES.length, errorCode);
  const seen = new Set<TemplateCapability>();
  const capabilities: TemplateCapability[] = [];
  const capabilityErrorCode = errorCode === 'DETECTED_CAPABILITY_MISMATCH'
    ? errorCode
    : 'UNDECLARED_CAPABILITY';
  for (let index = 0; index < rawCapabilities.length; index += 1) {
    const capability = rawCapabilities[index];
    if (!CAPTURED_REFLECT_APPLY(
      CAPTURED_ARRAY_INCLUDES,
      TEMPLATE_CAPABILITIES,
      [capability],
    )) {
      throw new ProjectTemplateValidationError(capabilityErrorCode, `${field} contains an unsupported capability`, field);
    }
    const typedCapability = capability as TemplateCapability;
    if (seen.has(typedCapability)) {
      throw new ProjectTemplateValidationError(capabilityErrorCode, `${field} must not contain duplicates`, field);
    }
    seen.add(typedCapability);
    appendArrayValue(capabilities, typedCapability);
  }
  return capabilities;
}

export function parsePolicy(
  value: unknown,
  field: string,
  errorCode: 'INVALID_ENTRY' | 'INVALID_LOCK' = 'INVALID_ENTRY',
): TemplateEntryPolicy {
  if (!CAPTURED_REFLECT_APPLY(
    CAPTURED_ARRAY_INCLUDES,
    TEMPLATE_ENTRY_POLICIES,
    [value],
  )) {
    throw new ProjectTemplateValidationError(errorCode, `${field} is not a supported policy`, field);
  }
  return value as TemplateEntryPolicy;
}

export function parsePortablePath(value: unknown, field: string): string {
  const path = requireString(value, field, 'INVALID_PATH', MAX_TEMPLATE_PATH_LENGTH);
  requirePortablePathSegmentLimit(path, field);
  // Paths are relative to `.takt/`. The shared expression also blocks Windows
  // reserved names, ADS syntax, controls, traversal, trailing dot/space, and
  // non-ASCII names whose case folding differs across file systems.
  if (path.normalize('NFC') !== path || !PROJECT_TEMPLATE_PATH_PATTERN.test(path)) {
    throw new ProjectTemplateValidationError('INVALID_PATH', `${field} must be a safe path relative to the .takt root`, field);
  }
  return path;
}

export function parsePosixMode(value: unknown, field: string): string {
  const mode = requireString(value, field, 'INVALID_MODE', 4);
  if (!POSIX_MODE_PATTERN.test(mode)) {
    throw new ProjectTemplateValidationError('INVALID_MODE', `${field} must be a four-digit POSIX mode such as 0644`, field);
  }
  return mode;
}

export function parseSha256(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') {
    throw new ProjectTemplateValidationError('MISSING_HASH', `${field} is required to make imports reproducible`, field);
  }
  const hash = requireString(value, field, 'INVALID_HASH', 64);
  if (!SHA256_PATTERN.test(hash)) {
    throw new ProjectTemplateValidationError('INVALID_HASH', `${field} must be a lowercase SHA-256 digest`, field);
  }
  return hash;
}

export function isExecutableMode(mode: string): boolean {
  for (let index = 1; index < mode.length; index += 1) {
    if ((Number(mode[index]) & 1) === 1) return true;
  }
  return false;
}

export interface CapabilityEntry {
  path: string;
  mode: string;
  capabilities?: TemplateCapability[];
}

export function validateDeclaredCapabilities(
  entries: CapabilityEntry[],
  manifestCapabilities: TemplateCapability[],
  field: string,
): void {
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    const entryCapabilities = entry.capabilities ?? [];
    // Executable bits alter what applying a template can run. Requiring a
    // declaration at both levels makes the preview explicit and auditable.
    let declaresExecutable = false;
    for (let index = 0; index < entryCapabilities.length; index += 1) {
      if (entryCapabilities[index] === 'executable') declaresExecutable = true;
    }
    if (isExecutableMode(entry.mode) && !declaresExecutable) {
      throw new ProjectTemplateValidationError('UNDECLARED_CAPABILITY', `${entry.path} is executable but does not declare executable capability`, field);
    }
    for (let index = 0; index < entryCapabilities.length; index += 1) {
      const capability = entryCapabilities[index]!;
      let declared = false;
      for (let declaredIndex = 0;
        declaredIndex < manifestCapabilities.length;
        declaredIndex += 1) {
        if (manifestCapabilities[declaredIndex] === capability) declared = true;
      }
      if (!declared) {
        throw new ProjectTemplateValidationError('UNDECLARED_CAPABILITY', `${entry.path} uses ${capability} without a top-level declaration`, field);
      }
    }
  }
}

export interface PathIdentityEntry {
  path: string;
  policy?: TemplateEntryPolicy;
}

export function validatePathIdentities(entries: PathIdentityEntry[], field: string): void {
  const exactPaths = new Map<string, PathIdentityEntry>();
  const compatibilityNormalizedPaths = new Map<string, string>();
  const caseInsensitivePaths = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const duplicate = exactPaths.get(entry.path);
    if (duplicate) {
      if (duplicate.policy !== entry.policy) {
        throw new ProjectTemplateValidationError('POLICY_CONFLICT', `${field} for ${entry.path} have conflicting policies`, field);
      }
      throw new ProjectTemplateValidationError('DUPLICATE_ENTRY_PATH', `${field} contains duplicate path ${entry.path}`, field);
    }
    const normalizedPath = entry.path.normalize('NFKC');
    const normalizationVariant = compatibilityNormalizedPaths.get(normalizedPath);
    if (normalizationVariant !== undefined) {
      throw new ProjectTemplateValidationError('PATH_NORMALIZATION_COLLISION', `${entry.path} normalizes to the same path as ${normalizationVariant}`, field);
    }
    const caseKey = normalizedPath.toLocaleLowerCase('en-US');
    const caseVariant = caseInsensitivePaths.get(caseKey);
    if (caseVariant !== undefined) {
      throw new ProjectTemplateValidationError('PATH_CASE_COLLISION', `${entry.path} conflicts with ${caseVariant} on case-insensitive file systems`, field);
    }
    exactPaths.set(entry.path, entry);
    compatibilityNormalizedPaths.set(normalizedPath, entry.path);
    caseInsensitivePaths.set(caseKey, entry.path);
  }
}
