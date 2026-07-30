import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { ProjectTemplateValidationError } from './errors.js';
import { parseProjectTemplateGithubSourceSpec } from './github-source-spec.js';
import {
  assertAllowedKeys,
  MAX_SEMVER_LENGTH,
  MAX_SOURCE_REF_LENGTH,
  MAX_SOURCE_URI_LENGTH,
  parseSha256,
  requireArray,
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

const MAX_REPERTOIRE_DEPENDENCIES = 128;
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
      maxItems: MAX_REPERTOIRE_DEPENDENCIES,
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

  const dependencies = requireArray(
    descriptor['repertoireDependencies'],
    'sourceDescriptor.repertoireDependencies',
    MAX_REPERTOIRE_DEPENDENCIES,
    'INVALID_SOURCE',
  ).map(parseRepertoireDependency);
  assertCanonicalDependencyOrder(dependencies);

  return {
    schemaVersion: '1.0',
    pack: parseDescriptorPack(descriptor['pack']),
    repertoireDependencies: dependencies,
  };
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
): ProjectTemplateRepertoireDependencyV1 {
  const field = `sourceDescriptor.repertoireDependencies[${index}]`;
  const dependency = requireRecord(value, field);
  assertAllowedKeys(
    dependency,
    ['scope', 'version', 'source', 'commit', 'capabilities'],
    field,
  );

  const source = requireString(
    dependency['source'],
    `${field}.source`,
    'INVALID_SOURCE',
    MAX_SOURCE_URI_LENGTH,
  );
  const sourceSpec = parseProjectTemplateGithubSourceSpec(source);
  if (sourceSpec.kind !== 'github-ref') {
    invalidSource(
      `${field}.source`,
      `${field}.source must use canonical github:owner/repo@ref`,
    );
  }
  const canonicalSource =
    `github:${sourceSpec.owner}/${sourceSpec.repo}@${sourceSpec.ref}` as const;
  if (source !== canonicalSource) {
    invalidSource(
      `${field}.source`,
      `${field}.source must be canonical lowercase github:owner/repo@ref`,
    );
  }

  const version = requireSemVer(
    dependency['version'],
    `${field}.version`,
  );
  const allowedTagRefs = new Set([
    version,
    `v${version}`,
    `refs/tags/${version}`,
    `refs/tags/v${version}`,
  ]);
  if (!allowedTagRefs.has(sourceSpec.ref)) {
    invalidSource(
      `${field}.source`,
      `${field}.source ref must be an explicit tag matching dependency.version`,
    );
  }

  const scope = requireString(
    dependency['scope'],
    `${field}.scope`,
    'INVALID_SOURCE',
    MAX_SOURCE_URI_LENGTH,
  );
  const canonicalScope = `@${sourceSpec.owner}/${sourceSpec.repo}` as const;
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
  const commit = requireString(value, field, 'INVALID_SOURCE', 64);
  if (!COMMIT_PATTERN.test(commit)) {
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
  const rawCapabilities = requireArray(
    value,
    field,
    MAX_DEPENDENCY_CAPABILITIES,
    'INVALID_SOURCE',
  );
  const capabilities: ProjectTemplateRepertoireCapabilityV1[] = [];
  const seen = new Set<ProjectTemplateRepertoireCapabilityV1>();
  for (const capability of rawCapabilities) {
    if (capability !== 'edit' || seen.has(capability)) {
      invalidSource(
        field,
        `${field} supports only unique "edit" capability entries`,
      );
    }
    seen.add(capability);
    capabilities.push(capability);
  }
  return capabilities;
}

function assertCanonicalDependencyOrder(
  dependencies: readonly ProjectTemplateRepertoireDependencyV1[],
): void {
  let previousScope: string | undefined;
  for (const dependency of dependencies) {
    if (previousScope !== undefined && dependency.scope <= previousScope) {
      const reason = dependency.scope === previousScope
        ? 'duplicate scope'
        : 'non-canonical scope order';
      invalidSource(
        'sourceDescriptor.repertoireDependencies',
        `sourceDescriptor.repertoireDependencies contains ${reason}`,
      );
    }
    previousScope = dependency.scope;
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
