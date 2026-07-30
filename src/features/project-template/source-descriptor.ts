import { createHash } from 'node:crypto';
import { ProjectTemplateValidationError } from './errors.js';
import { parseProjectTemplateGithubSourceSpec } from './github-source-spec.js';
import {
  assertAllowedKeys,
  MAX_SOURCE_REF_LENGTH,
  MAX_SOURCE_URI_LENGTH,
  parseSha256,
  requireArray,
  requireRecord,
  requireSchemaVersionV1,
  requireSemVer,
  requireString,
  SOURCE_REF_PATTERN_SOURCE,
} from './validation.js';

export const PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_PATH =
  '.takt-template-source.json';

const MAX_REPERTOIRE_DEPENDENCIES = 128;
const MAX_DEPENDENCY_CAPABILITIES = 128;
const MAX_RELEASE_ASSET_NAME_LENGTH = 255;
const MAX_CHECKSUM_ASSET_NAME_LENGTH =
  MAX_RELEASE_ASSET_NAME_LENGTH + '.sha256'.length;
const RELEASE_TAG_PATTERN = /^[A-Za-z0-9._-]+$/;
const SOURCE_REF_PATTERN = new RegExp(SOURCE_REF_PATTERN_SOURCE);
const TAKTPACK_ASSET_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.taktpack$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

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
  requireSchemaVersionV1(
    descriptor['schemaVersion'],
    'sourceDescriptor.schemaVersion',
    'INVALID_MANIFEST',
  );

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

  return {
    version: requireSemVer(pack['version'], `${field}.version`),
    releaseTag: parseReleaseTag(
      pack['releaseTag'],
      `${field}.releaseTag`,
    ),
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
    version: requireSemVer(dependency['version'], `${field}.version`),
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
  // A release tag is one literal URL segment. Restricting it beyond the shared
  // Git ref rules prevents encoded or raw separators from changing URL meaning.
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
    || assetName.includes('..')
  ) {
    invalidSource(field, `${field} must be a portable .taktpack filename`);
  }
  return assetName;
}

function parseDependencyCommit(value: unknown, field: string): string {
  const commit = requireString(value, field, 'INVALID_SOURCE', 40);
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
