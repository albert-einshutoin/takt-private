import { ProjectTemplateValidationError } from './errors.js';
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
export const GITHUB_URI_PATTERN_SOURCE = '^(?!.*\\.git$)https://github\\.com/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$';
export const GIT_URI_PATTERN_SOURCE = '^https://(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}(?::[1-9][0-9]{0,4})?/[A-Za-z0-9._~!$&\'()*+,;=:@%/-]+$';
export const SOURCE_REF_PATTERN_SOURCE = '^(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)(?!.*\\.lock(?:/|$))[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254}[A-Za-z0-9_-])?$';
export const LOCAL_SOURCE_URI_PATTERN_SOURCE = '^(?!\\.takt(?:/|$))(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*:)(?!.*[\\u0000-\\u001F\\u007F])(?!(?:.*\\/)?(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\\.[^/]*)?(?:/|$))(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*(?:^|/)[^/]*[ .](?:/|$))(?!.*//)[^/]+(?:/[^/]+)*$';
export const PROJECT_TEMPLATE_PATH_PATTERN_SOURCE = LOCAL_SOURCE_URI_PATTERN_SOURCE;

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
  return Array.from(value).length;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requireRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProjectTemplateValidationError('NON_PLAIN_OBJECT', `${field} must be a plain own-property object`, field);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) {
    throw new ProjectTemplateValidationError('NON_PLAIN_OBJECT', `${field} must not contain accessors`, field);
  }
  return value;
}

export function requireArray(
  value: unknown,
  field: string,
  maxItems: number,
  errorCode: ProjectTemplateValidationErrorCode,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new ProjectTemplateValidationError(errorCode, `${field} must be a plain array`, field);
  }
  if (value.length > maxItems) {
    throw new ProjectTemplateValidationError('LIMIT_EXCEEDED', `${field} exceeds the ${maxItems} item limit`, field);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const hasAccessor = Object.entries(descriptors)
    .some(([key, descriptor]) => key !== 'length' && !('value' in descriptor));
  const hasNonIndexProperty = Object.keys(value)
    .some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length);
  const hasHole = Array.from({ length: value.length }, (_, index) => index)
    .some((index) => !Object.prototype.hasOwnProperty.call(value, index));
  if (hasAccessor || hasNonIndexProperty || hasHole) {
    throw new ProjectTemplateValidationError('NON_PLAIN_OBJECT', `${field} must be a dense JSON array without extra properties`, field);
  }
  return value;
}

export function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
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

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right, 'en-US');
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return compareNumericIdentifiers(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left.localeCompare(right, 'en-US');
}

export function compareSemVer(left: string, right: string): number {
  const parse = (version: string): { core: string[]; prerelease: string[] } => {
    const withoutBuild = version.split('+', 1)[0]!;
    const [coreText, prereleaseText] = withoutBuild.split('-', 2);
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

export function parseSource(value: unknown): TemplateSource {
  const source = requireRecord(value, 'source');
  assertAllowedKeys(source, ['kind', 'uri', 'ref', 'commit'], 'source');
  const kind = requireString(source['kind'], 'source.kind', 'INVALID_SOURCE', 16);
  const uri = requireControlFree(source['uri'], 'source.uri', MAX_SOURCE_URI_LENGTH);
  const commit = parseCommit(source['commit']);

  if (kind === 'github') {
    if (!GITHUB_URI_PATTERN.test(uri)) {
      throw new ProjectTemplateValidationError('INVALID_SOURCE', 'source.uri must be a canonical GitHub HTTPS repository URL without .git, query, or fragment', 'source.uri');
    }
    return { kind, uri: uri as `https://github.com/${string}/${string}`, ref: parseRef(source['ref']), commit };
  }
  if (kind === 'git') {
    if (!GIT_URI_PATTERN.test(uri)) {
      throw new ProjectTemplateValidationError('INVALID_SOURCE', 'source.uri must be a credential-free HTTPS Git URL without query or fragment', 'source.uri');
    }
    return { kind, uri: uri as `https://${string}`, ref: parseRef(source['ref']), commit };
  }
  if (kind === 'local') {
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
  for (const capability of rawCapabilities) {
    if (!TEMPLATE_CAPABILITIES.includes(capability as TemplateCapability)) {
      throw new ProjectTemplateValidationError('UNDECLARED_CAPABILITY', `${field} contains an unsupported capability`, field);
    }
    const typedCapability = capability as TemplateCapability;
    if (seen.has(typedCapability)) {
      throw new ProjectTemplateValidationError('UNDECLARED_CAPABILITY', `${field} must not contain duplicates`, field);
    }
    seen.add(typedCapability);
    capabilities.push(typedCapability);
  }
  return capabilities;
}

export function parsePolicy(value: unknown, field: string): TemplateEntryPolicy {
  if (!TEMPLATE_ENTRY_POLICIES.includes(value as TemplateEntryPolicy)) {
    throw new ProjectTemplateValidationError('INVALID_ENTRY', `${field} is not a supported policy`, field);
  }
  return value as TemplateEntryPolicy;
}

export function parsePortablePath(value: unknown, field: string): string {
  const path = requireString(value, field, 'INVALID_PATH', MAX_TEMPLATE_PATH_LENGTH);
  // Paths are relative to `.takt/`. The shared expression also blocks Windows
  // reserved names, ADS syntax, controls, traversal, and trailing dot/space.
  if (!PROJECT_TEMPLATE_PATH_PATTERN.test(path)) {
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
  return mode.slice(1).split('').some((digit) => (Number(digit) & 1) === 1);
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
  const declaredCapabilities = new Set(manifestCapabilities);
  for (const entry of entries) {
    const entryCapabilities = entry.capabilities ?? [];
    // Executable bits alter what applying a template can run. Requiring a
    // declaration at both levels makes the preview explicit and auditable.
    if (isExecutableMode(entry.mode) && !entryCapabilities.includes('executable')) {
      throw new ProjectTemplateValidationError('UNDECLARED_CAPABILITY', `${entry.path} is executable but does not declare executable capability`, field);
    }
    for (const capability of entryCapabilities) {
      if (!declaredCapabilities.has(capability)) {
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
  const normalizedPaths = new Map<string, string>();
  const caseInsensitivePaths = new Map<string, string>();
  for (const entry of entries) {
    const duplicate = exactPaths.get(entry.path);
    if (duplicate) {
      if (duplicate.policy !== entry.policy) {
        throw new ProjectTemplateValidationError('POLICY_CONFLICT', `${field} for ${entry.path} have conflicting policies`, field);
      }
      throw new ProjectTemplateValidationError('DUPLICATE_ENTRY_PATH', `${field} contains duplicate path ${entry.path}`, field);
    }
    const normalizedPath = entry.path.normalize('NFC');
    const normalizationVariant = normalizedPaths.get(normalizedPath);
    if (normalizationVariant !== undefined) {
      throw new ProjectTemplateValidationError('PATH_NORMALIZATION_COLLISION', `${entry.path} normalizes to the same path as ${normalizationVariant}`, field);
    }
    const caseKey = normalizedPath.toLocaleLowerCase('en-US');
    const caseVariant = caseInsensitivePaths.get(caseKey);
    if (caseVariant !== undefined) {
      throw new ProjectTemplateValidationError('PATH_CASE_COLLISION', `${entry.path} conflicts with ${caseVariant} on case-insensitive file systems`, field);
    }
    exactPaths.set(entry.path, entry);
    normalizedPaths.set(normalizedPath, entry.path);
    caseInsensitivePaths.set(caseKey, entry.path);
  }
}
