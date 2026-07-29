import { ProjectTemplateValidationError } from './errors.js';
import type { TemplateCapability, TemplateSource } from './types.js';

export const TEMPLATE_CAPABILITIES = [
  'executable',
  'github-write',
  'external-command',
] as const satisfies readonly TemplateCapability[];

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const POSIX_MODE_PATTERN = /^0[0-7]{3}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, field: string, errorCode = 'INVALID_MANIFEST'): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProjectTemplateValidationError(errorCode as 'INVALID_MANIFEST' | 'INVALID_LOCK', `${field} must be an object`);
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
      throw new ProjectTemplateValidationError('UNKNOWN_KEY', `${field}.${key} is not part of schema 1.0`);
    }
  }
}

export function requireString(value: unknown, field: string, errorCode = 'INVALID_MANIFEST'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProjectTemplateValidationError(errorCode as 'INVALID_MANIFEST' | 'INVALID_LOCK', `${field} must be a non-empty string`);
  }
  return value;
}

export function requireSemVer(value: unknown, field: string): string {
  const version = requireString(value, field);
  if (!SEMVER_PATTERN.test(version)) {
    throw new ProjectTemplateValidationError('INVALID_SEMVER', `${field} must be valid SemVer`);
  }
  return version;
}

export function parseSource(value: unknown, errorCode = 'INVALID_MANIFEST'): TemplateSource {
  const source = requireRecord(value, 'source', errorCode);
  assertAllowedKeys(source, ['kind', 'uri', 'ref', 'commit'], 'source');
  const kind = requireString(source['kind'], 'source.kind', errorCode);
  if (kind !== 'local' && kind !== 'git' && kind !== 'github') {
    throw new ProjectTemplateValidationError('INVALID_SOURCE', 'source.kind must be local, git, or github');
  }
  const commit = requireString(source['commit'], 'source.commit', errorCode);
  if (!COMMIT_PATTERN.test(commit)) {
    throw new ProjectTemplateValidationError('INVALID_SOURCE', 'source.commit must be a 40-64 character lowercase hexadecimal commit');
  }
  return {
    kind,
    uri: requireString(source['uri'], 'source.uri', errorCode),
    ref: requireString(source['ref'], 'source.ref', errorCode),
    commit,
  };
}

export function parseCapabilities(value: unknown, field: string): TemplateCapability[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ProjectTemplateValidationError('INVALID_ENTRY', `${field} must be an array`);
  }
  const seen = new Set<TemplateCapability>();
  const capabilities: TemplateCapability[] = [];
  for (const capability of value) {
    if (!TEMPLATE_CAPABILITIES.includes(capability as TemplateCapability)) {
      throw new ProjectTemplateValidationError('UNDECLARED_CAPABILITY', `${field} contains an unsupported capability`);
    }
    const typedCapability = capability as TemplateCapability;
    if (seen.has(typedCapability)) {
      throw new ProjectTemplateValidationError('UNDECLARED_CAPABILITY', `${field} must not contain duplicates`);
    }
    seen.add(typedCapability);
    capabilities.push(typedCapability);
  }
  return capabilities;
}

export function parsePortablePath(value: unknown, field: string): string {
  const path = requireString(value, field);
  // Pack paths are intentionally POSIX-only. Accepting host-specific forms
  // would let a pack validated on macOS escape differently on Windows.
  if (
    path.includes('\\')
    || path.startsWith('/')
    || /^[A-Za-z]:/.test(path)
    || path.includes('\0')
    || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ProjectTemplateValidationError('INVALID_PATH', `${field} must be a relative POSIX path without traversal`);
  }
  return path;
}

export function parsePosixMode(value: unknown, field: string): string {
  const mode = requireString(value, field);
  if (!POSIX_MODE_PATTERN.test(mode)) {
    throw new ProjectTemplateValidationError('INVALID_MODE', `${field} must be a four-digit POSIX mode such as 0644`);
  }
  return mode;
}

export function parseSha256(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') {
    throw new ProjectTemplateValidationError('MISSING_HASH', `${field} is required to make imports reproducible`);
  }
  const hash = requireString(value, field);
  if (!SHA256_PATTERN.test(hash)) {
    throw new ProjectTemplateValidationError('INVALID_HASH', `${field} must be a lowercase SHA-256 digest`);
  }
  return hash;
}

export function isExecutableMode(mode: string): boolean {
  return mode.slice(1).split('').some((digit) => (Number(digit) & 1) === 1);
}
