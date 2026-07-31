import { createHash } from 'node:crypto';
import { TextDecoder, types } from 'node:util';
import { ProjectTemplateValidationError } from './errors.js';
import {
  assertAllowedKeys,
  MAX_SEMVER_LENGTH,
  MAX_SOURCE_REF_LENGTH,
  MAX_SOURCE_URI_LENGTH,
  parseSha256,
  requireRecord,
  requireSemVer,
  requireString,
  SEMVER_PATTERN_SOURCE,
  SHA256_PATTERN_SOURCE,
  SOURCE_REF_PATTERN_SOURCE,
} from './validation.js';

export const PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_PATH =
  '.takt-template-source.json';
export const MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES = 64 * 1024;

export const MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES = 128;
const MAX_DEPENDENCY_CAPABILITIES = 128;
const MAX_RELEASE_ASSET_NAME_LENGTH = 255;
const MAX_CHECKSUM_ASSET_NAME_LENGTH =
  MAX_RELEASE_ASSET_NAME_LENGTH + '.sha256'.length;
const RELEASE_TAG_PATTERN = /^[A-Za-z0-9._+-]+$/;
const SOURCE_REF_PATTERN = new RegExp(SOURCE_REF_PATTERN_SOURCE);
const TAKTPACK_ASSET_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.taktpack$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SEMVER_PATTERN_BODY = SEMVER_PATTERN_SOURCE.slice(1, -1);
const GITHUB_OWNER_PATTERN_SOURCE =
  '(?![a-z0-9-]*--)[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?';
const GITHUB_REPOSITORY_PATTERN_SOURCE =
  '[a-z0-9._-]{1,100}';
const DEPENDENCY_SEMVER_PATTERN = new RegExp(SEMVER_PATTERN_SOURCE);
const DEPENDENCY_SOURCE_PATTERN = new RegExp(
  `^github:(${GITHUB_OWNER_PATTERN_SOURCE})`
  + `/(${GITHUB_REPOSITORY_PATTERN_SOURCE})`
  + `@((?:refs/tags/)?v?${SEMVER_PATTERN_BODY})$`,
);
const FORBIDDEN_GITHUB_REPOSITORY_PATTERN = /^(?:\.{1,2}|.*\.git)$/;
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;
const INTRINSIC_ARRAY_IS_ARRAY = Array.isArray;
const INTRINSIC_ARRAY_PROTOTYPE = Array.prototype;
const INTRINSIC_NUMBER = Number;
const INTRINSIC_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const INTRINSIC_OBJECT_CREATE = Object.create;
const INTRINSIC_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const INTRINSIC_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const INTRINSIC_OBJECT_PROTOTYPE = Object.prototype;
const INTRINSIC_REFLECT_APPLY = Reflect.apply;
const INTRINSIC_REFLECT_OWN_KEYS = Reflect.ownKeys;
const INTRINSIC_REGEXP_EXEC = RegExp.prototype.exec;
const INTRINSIC_REGEXP_TEST = RegExp.prototype.test;
const INTRINSIC_STRING = String;
const INTRINSIC_TYPES_IS_PROXY = types.isProxy;

type DependencyDescriptorMap =
  Record<PropertyKey, PropertyDescriptor | undefined>;

/**
 * Draft-07 structural contract for editors and offline validation.
 * Cross-field equality and canonical ordering remain strict-parser rules
 * because standard draft-07 has no portable data-reference mechanism.
 */
export const projectTemplateSourceDescriptorV1JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://takt.dev/schemas/project-template-source-descriptor-v1.json',
  title: 'TAKT Project Template Source Descriptor v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'pack', 'repertoireDependencies'],
  properties: {
    schemaVersion: { const: '1.0' },
    pack: {
      type: 'object',
      additionalProperties: false,
      required: [
        'version',
        'releaseTag',
        'assetName',
        'checksumAssetName',
        'sha256',
      ],
      properties: {
        version: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_SEMVER_LENGTH,
          pattern: SEMVER_PATTERN_SOURCE,
        },
        releaseTag: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_SOURCE_REF_LENGTH,
          pattern: `^v?${SEMVER_PATTERN_BODY}$`,
        },
        assetName: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_RELEASE_ASSET_NAME_LENGTH,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*\\.taktpack$',
        },
        checksumAssetName: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_CHECKSUM_ASSET_NAME_LENGTH,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*\\.taktpack\\.sha256$',
        },
        sha256: { type: 'string', pattern: SHA256_PATTERN_SOURCE },
      },
    },
    repertoireDependencies: {
      type: 'array',
      maxItems: MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'scope',
          'version',
          'source',
          'commit',
          'capabilities',
        ],
        properties: {
          scope: {
            type: 'string',
            pattern:
              `^@${GITHUB_OWNER_PATTERN_SOURCE}/`
              + '(?!\\.{1,2}$)(?!.*\\.git$)'
              + `${GITHUB_REPOSITORY_PATTERN_SOURCE}$`,
          },
          version: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_SEMVER_LENGTH,
            pattern: SEMVER_PATTERN_SOURCE,
          },
          source: {
            type: 'string',
            maxLength: MAX_SOURCE_URI_LENGTH,
            pattern:
              `^github:${GITHUB_OWNER_PATTERN_SOURCE}/`
              + '(?!\\.{1,2}@)(?!.*\\.git@)'
              + `${GITHUB_REPOSITORY_PATTERN_SOURCE}@`
              + `(?:refs/tags/)?v?${SEMVER_PATTERN_BODY}$`,
          },
          commit: { type: 'string', pattern: '^[a-f0-9]{40}$' },
          capabilities: {
            type: 'array',
            maxItems: 1,
            uniqueItems: true,
            items: { const: 'edit' },
          },
        },
      },
    },
  },
} as const;

export interface ProjectTemplateSourceDescriptorPackV1 {
  readonly version: string;
  readonly releaseTag: string;
  readonly assetName: string;
  readonly checksumAssetName: string;
  readonly sha256: string;
}

export type ProjectTemplateRepertoireCapabilityV1 = 'edit';

export interface ProjectTemplateRepertoireDependencyV1 {
  readonly scope: `@${string}/${string}`;
  readonly version: string;
  readonly source: `github:${string}/${string}@${string}`;
  /**
   * Expected immutable target. A resolver must verify that the explicit source
   * tag resolves to this commit before trusting or downloading the dependency.
   */
  readonly commit: string;
  readonly capabilities: readonly ProjectTemplateRepertoireCapabilityV1[];
}

/**
 * Repository-root source metadata used to resolve a reviewed template pack.
 *
 * This descriptor is deliberately separate from manifest/lock v1. The source
 * document selects immutable remote artifacts; the pack manifest and lock keep
 * describing only the contents that are reviewed and applied under `.takt/`.
 */
export interface ProjectTemplateSourceDescriptorV1 {
  readonly schemaVersion: '1.0';
  readonly pack: ProjectTemplateSourceDescriptorPackV1;
  readonly repertoireDependencies:
    readonly ProjectTemplateRepertoireDependencyV1[];
}

export function parseProjectTemplateSourceDescriptor(
  value: unknown,
): ProjectTemplateSourceDescriptorV1 {
  const descriptor = requireRecord(value, 'sourceDescriptor');
  assertAllowedKeys(
    descriptor,
    ['schemaVersion', 'pack', 'repertoireDependencies'],
    'sourceDescriptor',
  );
  requireDescriptorSchemaVersion(descriptor['schemaVersion']);

  const dependencies = parseProjectTemplateRepertoireDependencies(
    descriptor['repertoireDependencies'],
  );

  return {
    schemaVersion: '1.0',
    pack: parseDescriptorPack(descriptor['pack']),
    repertoireDependencies: dependencies,
  };
}

/**
 * Shared strict parser for source-descriptor declarations and their companion
 * lock. Keeping one semantic boundary prevents the lock from accepting a
 * dependency that its authenticated descriptor would reject.
 */
export function parseProjectTemplateRepertoireDependencies(
  value: unknown,
  field = 'sourceDescriptor.repertoireDependencies',
): ProjectTemplateRepertoireDependencyV1[] {
  const rawDependencies = snapshotDependencyArray(
    value,
    field,
    MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES,
  );
  const dependencies: ProjectTemplateRepertoireDependencyV1[] = [];
  for (let index = 0; index < rawDependencies.length; index += 1) {
    defineArrayValue(
      dependencies,
      index,
      parseRepertoireDependency(
        rawDependencies[index],
        index,
        field,
      ),
    );
  }
  assertCanonicalDependencyOrder(dependencies, field);
  return dependencies;
}

function intrinsicRegExpTest(pattern: RegExp, value: string): boolean {
  return INTRINSIC_REFLECT_APPLY(
    INTRINSIC_REGEXP_TEST,
    pattern,
    [value],
  ) as boolean;
}

function intrinsicRegExpExec(
  pattern: RegExp,
  value: string,
): RegExpExecArray | null {
  return INTRINSIC_REFLECT_APPLY(
    INTRINSIC_REGEXP_EXEC,
    pattern,
    [value],
  ) as RegExpExecArray | null;
}

function dependencyDescriptors(value: object): DependencyDescriptorMap {
  return INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    Object,
    [value],
  ) as unknown as DependencyDescriptorMap;
}

function dependencyOwnKeys(
  descriptors: DependencyDescriptorMap,
): PropertyKey[] {
  return INTRINSIC_REFLECT_APPLY(
    INTRINSIC_REFLECT_OWN_KEYS,
    Reflect,
    [descriptors],
  ) as PropertyKey[];
}

function defineDependencyDataProperty(
  target: object,
  key: PropertyKey,
  value: unknown,
): void {
  const descriptor = INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_CREATE,
    Object,
    [null],
  ) as PropertyDescriptor;
  // Why: ToPropertyDescriptor reads all six descriptor field names. A normal
  // object would inherit hostile post-init `get`/`set` hooks before the
  // captured defineProperty intrinsic can establish the data property.
  descriptor.configurable = true;
  descriptor.enumerable = true;
  descriptor.value = value;
  descriptor.writable = true;
  INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_DEFINE_PROPERTY,
    Object,
    [target, key, descriptor],
  );
}

function defineArrayValue(
  target: unknown[],
  index: number,
  value: unknown,
): void {
  defineDependencyDataProperty(
    target,
    INTRINSIC_STRING(index),
    value,
  );
}

function snapshotDependencyArray(
  value: unknown,
  field: string,
  maxItems: number,
): unknown[] {
  rejectProxy(value, field);
  if (
    !INTRINSIC_ARRAY_IS_ARRAY(value)
    || INTRINSIC_REFLECT_APPLY(
      INTRINSIC_OBJECT_GET_PROTOTYPE_OF,
      Object,
      [value],
    ) !== INTRINSIC_ARRAY_PROTOTYPE
  ) {
    invalidSource(field, `${field} must be a plain array`);
  }
  const descriptors = dependencyDescriptors(value);
  const lengthDescriptor = descriptors['length'];
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || !INTRINSIC_NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    nonPlainDependency(field, `${field} must have an intrinsic data length`);
  }
  const length = lengthDescriptor.value as number;
  if (length > maxItems) {
    throw new ProjectTemplateValidationError(
      'LIMIT_EXCEEDED',
      `${field} exceeds the ${maxItems} item limit`,
      field,
    );
  }
  const keys = dependencyOwnKeys(descriptors);
  if (keys.length !== length + 1) {
    nonPlainDependency(
      field,
      `${field} must be a dense JSON array without extra properties`,
    );
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[INTRINSIC_STRING(index)];
    if (descriptor === undefined || !('value' in descriptor)) {
      nonPlainDependency(
        field,
        `${field} must be a dense JSON array without extra properties`,
      );
    }
    defineArrayValue(snapshot, index, descriptor.value);
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (
      key !== 'length'
      && (
        typeof key !== 'string'
        || !intrinsicRegExpTest(ARRAY_INDEX_PATTERN, key)
        || INTRINSIC_NUMBER(key) >= length
        || !('value' in descriptors[key]!)
      )
    ) {
      nonPlainDependency(
        field,
        `${field} must be a dense JSON array without extra properties`,
      );
    }
  }
  return snapshot;
}

function isDependencyKey(key: string): boolean {
  return (
    key === 'scope'
    || key === 'version'
    || key === 'source'
    || key === 'commit'
    || key === 'capabilities'
  );
}

function snapshotDependencyRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  rejectProxy(value, field);
  if (
    typeof value !== 'object'
    || value === null
    || INTRINSIC_ARRAY_IS_ARRAY(value)
  ) {
    nonPlainDependency(
      field,
      `${field} must be a plain own-property object`,
    );
  }
  const prototype = INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_GET_PROTOTYPE_OF,
    Object,
    [value],
  ) as object | null;
  if (
    prototype !== INTRINSIC_OBJECT_PROTOTYPE
    && prototype !== null
  ) {
    nonPlainDependency(
      field,
      `${field} must be a plain own-property object`,
    );
  }
  const descriptors = dependencyDescriptors(value);
  const keys = dependencyOwnKeys(descriptors);
  const snapshot = INTRINSIC_REFLECT_APPLY(
    INTRINSIC_OBJECT_CREATE,
    Object,
    [null],
  ) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      nonPlainDependency(field, `${field} must not contain accessors`);
    }
    if (typeof key !== 'string' || !isDependencyKey(key)) {
      throw new ProjectTemplateValidationError(
        'UNKNOWN_KEY',
        typeof key === 'string'
          ? `${field}.${key} is not part of schema 1.0`
          : `${field} contains a non-string own key outside schema 1.0`,
        typeof key === 'string' ? `${field}.${key}` : field,
      );
    }
    defineDependencyDataProperty(
      snapshot,
      key,
      descriptor.value,
    );
  }
  return snapshot;
}

function nonPlainDependency(field: string, message: string): never {
  throw new ProjectTemplateValidationError(
    'NON_PLAIN_OBJECT',
    message,
    field,
  );
}

/**
 * Parses the untrusted repository-root descriptor with a bounded input pipeline.
 * Bytes are decoded as fatal UTF-8 before JSON parsing; both strings and bytes
 * then pass through the same strict object parser and semantic bindings.
 */
export function parseProjectTemplateSourceDescriptorJson(
  input: string | Uint8Array,
): ProjectTemplateSourceDescriptorV1 {
  let json: string;
  if (typeof input === 'string') {
    assertDescriptorByteLimit(Buffer.byteLength(input, 'utf8'));
    json = input;
  } else if (input instanceof Uint8Array) {
    assertDescriptorByteLimit(input.byteLength);
    try {
      json = new TextDecoder('utf-8', {
        fatal: true,
        // Preserve a BOM in decoded text so canonical equality rejects bytes
        // that would hash differently from the sole UTF-8 representation.
        ignoreBOM: true,
      }).decode(input);
    } catch {
      invalidDescriptor(
        'sourceDescriptor',
        'source descriptor bytes must be valid UTF-8',
      );
    }
  } else {
    invalidDescriptor(
      'sourceDescriptor',
      'source descriptor input must be a string or Uint8Array',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    invalidDescriptor(
      'sourceDescriptor',
      'source descriptor must contain valid JSON',
    );
  }
  const parsed = parseProjectTemplateSourceDescriptor(value);
  // The fetched bytes are the reviewed and hashed artifact. Requiring exact
  // equality with the sole serializer rejects whitespace, key-order, duplicate
  // key, and trailing-data aliases before any digest can describe another form.
  if (serializeProjectTemplateSourceDescriptor(parsed) !== json) {
    invalidDescriptor(
      'sourceDescriptor',
      'source descriptor JSON must use the canonical serialized representation',
    );
  }
  return parsed;
}

/**
 * Produces the sole byte representation used for descriptor review and hashing.
 * Parsing first rejects aliases and non-canonical dependency ordering.
 */
export function serializeProjectTemplateSourceDescriptor(
  value: unknown,
): string {
  return JSON.stringify(parseProjectTemplateSourceDescriptor(value), null, 2);
}

export function calculateProjectTemplateSourceDescriptorSha256(
  value: unknown,
): string {
  return createHash('sha256')
    .update(serializeProjectTemplateSourceDescriptor(value), 'utf8')
    .digest('hex');
}

function parseDescriptorPack(
  value: unknown,
): ProjectTemplateSourceDescriptorPackV1 {
  const field = 'sourceDescriptor.pack';
  const pack = requireRecord(value, field);
  assertAllowedKeys(
    pack,
    [
      'version',
      'releaseTag',
      'assetName',
      'checksumAssetName',
      'sha256',
    ],
    field,
  );

  const assetName = parseTaktpackAssetName(
    pack['assetName'],
    `${field}.assetName`,
  );
  const checksumAssetName = requireString(
    pack['checksumAssetName'],
    `${field}.checksumAssetName`,
    'INVALID_SOURCE',
    MAX_CHECKSUM_ASSET_NAME_LENGTH,
  );
  if (checksumAssetName !== `${assetName}.sha256`) {
    invalidSource(
      `${field}.checksumAssetName`,
      `${field}.checksumAssetName must equal assetName + ".sha256"`,
    );
  }

  const version = requireSemVer(pack['version'], `${field}.version`);
  const releaseTag = parseReleaseTag(
    pack['releaseTag'],
    `${field}.releaseTag`,
  );
  if (releaseTag !== version && releaseTag !== `v${version}`) {
    invalidSource(
      `${field}.releaseTag`,
      `${field}.releaseTag must equal pack.version with optional "v" prefix`,
    );
  }

  return {
    version,
    releaseTag,
    assetName,
    checksumAssetName,
    sha256: parseSha256(pack['sha256'], `${field}.sha256`),
  };
}

function parseRepertoireDependency(
  value: unknown,
  index: number,
  dependenciesField: string,
): ProjectTemplateRepertoireDependencyV1 {
  const field = `${dependenciesField}[${index}]`;
  const dependency = snapshotDependencyRecord(value, field);
  const source = parseDependencyString(
    dependency['source'],
    `${field}.source`,
    MAX_SOURCE_URI_LENGTH,
  );
  const sourceMatch = intrinsicRegExpExec(
    DEPENDENCY_SOURCE_PATTERN,
    source,
  );
  if (sourceMatch === null) {
    invalidSource(
      `${field}.source`,
      `${field}.source must use canonical lowercase github:owner/repo@ref`,
    );
  }
  const owner = sourceMatch[1]!;
  const repo = sourceMatch[2]!;
  const ref = sourceMatch[3]!;
  if (intrinsicRegExpTest(FORBIDDEN_GITHUB_REPOSITORY_PATTERN, repo)) {
    invalidSource(
      `${field}.source`,
      `${field}.source must be canonical lowercase github:owner/repo@ref`,
    );
  }
  const canonicalSource = `github:${owner}/${repo}@${ref}` as const;

  const version = parseDependencyVersion(
    dependency['version'],
    `${field}.version`,
  );
  if (
    ref !== version
    && ref !== `v${version}`
    && ref !== `refs/tags/${version}`
    && ref !== `refs/tags/v${version}`
  ) {
    invalidSource(
      `${field}.source`,
      `${field}.source ref must be an explicit tag matching dependency.version`,
    );
  }

  const scope = parseDependencyString(
    dependency['scope'],
    `${field}.scope`,
    MAX_SOURCE_URI_LENGTH,
  );
  const canonicalScope = `@${owner}/${repo}` as const;
  if (scope !== canonicalScope) {
    invalidSource(
      `${field}.scope`,
      `${field}.scope must be lowercase and match source owner/repository`,
    );
  }

  return {
    scope: canonicalScope,
    version,
    source: canonicalSource,
    commit: parseDependencyCommit(
      dependency['commit'],
      `${field}.commit`,
    ),
    capabilities: parseDependencyCapabilities(
      dependency['capabilities'],
      `${field}.capabilities`,
    ),
  };
}

function parseDependencyString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalidSource(field, `${field} must be a non-empty string`);
  }
  // Dependency fields are constrained to ASCII by the patterns below, so
  // code-unit length is also code-point length without invoking an iterator.
  if (value.length > maxLength) {
    throw new ProjectTemplateValidationError(
      'LIMIT_EXCEEDED',
      `${field} exceeds the ${maxLength} character limit`,
      field,
    );
  }
  return value;
}

function parseDependencyVersion(value: unknown, field: string): string {
  const version = parseDependencyString(
    value,
    field,
    MAX_SEMVER_LENGTH,
  );
  if (!intrinsicRegExpTest(DEPENDENCY_SEMVER_PATTERN, version)) {
    throw new ProjectTemplateValidationError(
      'INVALID_SEMVER',
      `${field} must be valid SemVer`,
      field,
    );
  }
  return version;
}

function parseReleaseTag(value: unknown, field: string): string {
  const tag = requireString(
    value,
    field,
    'INVALID_SOURCE',
    MAX_SOURCE_REF_LENGTH,
  );
  // Literal `+` retains SemVer build metadata in a URL path without the
  // query-string space conversion. Resolvers consume the parsed fields and
  // must pass argument arrays, never interpolate the tag into a shell command.
  // Slash remains excluded so the tag is exactly one literal URL segment.
  if (!SOURCE_REF_PATTERN.test(tag) || !RELEASE_TAG_PATTERN.test(tag)) {
    invalidSource(
      field,
      `${field} must be one portable ASCII release-tag path segment`,
    );
  }
  return tag;
}

function parseTaktpackAssetName(value: unknown, field: string): string {
  const assetName = requireString(
    value,
    field,
    'INVALID_SOURCE',
    MAX_RELEASE_ASSET_NAME_LENGTH,
  );
  if (
    !TAKTPACK_ASSET_PATTERN.test(assetName)
  ) {
    invalidSource(field, `${field} must be a portable .taktpack filename`);
  }
  return assetName;
}

function requireDescriptorSchemaVersion(value: unknown): void {
  if (value !== '1.0') {
    invalidDescriptor(
      'sourceDescriptor.schemaVersion',
      'sourceDescriptor.schemaVersion must be exactly "1.0"',
    );
  }
}

function assertDescriptorByteLimit(byteLength: number): void {
  if (byteLength > MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES) {
    invalidDescriptor(
      'sourceDescriptor',
      `source descriptor exceeds the ${MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES} byte limit`,
    );
  }
}

function parseDependencyCommit(value: unknown, field: string): string {
  const commit = parseDependencyString(value, field, 64);
  if (!intrinsicRegExpTest(COMMIT_PATTERN, commit)) {
    invalidSource(
      field,
      `${field} must be exactly 40 lowercase hexadecimal characters`,
    );
  }
  return commit;
}

function parseDependencyCapabilities(
  value: unknown,
  field: string,
): ProjectTemplateRepertoireCapabilityV1[] {
  const rawCapabilities = snapshotDependencyArray(
    value,
    field,
    MAX_DEPENDENCY_CAPABILITIES,
  );
  const capabilities: ProjectTemplateRepertoireCapabilityV1[] = [];
  for (let index = 0; index < rawCapabilities.length; index += 1) {
    const capability = rawCapabilities[index];
    if (capability !== 'edit' || index !== 0) {
      invalidSource(
        field,
        `${field} supports only unique "edit" capability entries`,
      );
    }
    defineArrayValue(capabilities, index, capability);
  }
  return capabilities;
}

function assertCanonicalDependencyOrder(
  dependencies: readonly ProjectTemplateRepertoireDependencyV1[],
  field: string,
): void {
  let previousScope: string | undefined;
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index]!;
    if (previousScope !== undefined && dependency.scope <= previousScope) {
      const reason = dependency.scope === previousScope
        ? 'duplicate scope'
        : 'non-canonical scope order';
      invalidSource(
        field,
        `${field} contains ${reason}`,
      );
    }
    previousScope = dependency.scope;
  }
}

function rejectProxy(value: unknown, field: string): void {
  if (
    typeof value === 'object'
    && value !== null
    && INTRINSIC_TYPES_IS_PROXY(value)
  ) {
    throw new ProjectTemplateValidationError(
      'NON_PLAIN_OBJECT',
      `${field} must not be a Proxy`,
      field,
    );
  }
}

function invalidSource(field: string, message: string): never {
  throw new ProjectTemplateValidationError(
    'INVALID_SOURCE',
    message,
    field,
  );
}

function invalidDescriptor(field: string, message: string): never {
  throw new ProjectTemplateValidationError(
    'INVALID_SOURCE_DESCRIPTOR',
    message,
    field,
  );
}
