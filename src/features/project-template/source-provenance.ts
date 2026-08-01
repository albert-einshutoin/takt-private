import { createHash } from 'node:crypto';
import { TextDecoder, types } from 'node:util';
import { ProjectTemplateValidationError } from './errors.js';
import { parseProjectTemplateGithubSourceSpec } from './github-source-spec.js';
import { requireSemVer } from './validation.js';

export const PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH =
  '.takt-template-source-lock.json';
export const MAX_PROJECT_TEMPLATE_SOURCE_PROVENANCE_BYTES = 64 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const MAX_DEPENDENCIES = 128;
const CAPTURED_JSON_PARSE = JSON.parse;
const CAPTURED_JSON_STRINGIFY = JSON.stringify;
const CAPTURED_BUFFER_BYTE_LENGTH = Buffer.byteLength;
const CAPTURED_CREATE_HASH = createHash;
const CAPTURED_TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const HASH_SAMPLE = CAPTURED_CREATE_HASH('sha256');
const CAPTURED_HASH_UPDATE = HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_SAMPLE.digest;

export interface ProjectTemplateSourceProvenanceV1 {
  readonly schemaVersion: '1.0';
  readonly source: {
    readonly owner: string;
    readonly repo: string;
    readonly repositoryUrl: string;
    readonly canonicalSource: string;
    readonly requestedRef: string;
    readonly releaseTag: string;
    readonly assetName?: string;
    readonly commit: string;
    readonly descriptorSha256: string;
  };
  readonly archive: {
    readonly sha256: string;
    readonly version: string;
    readonly manifestSha256: string;
  };
  readonly dependencyVerification: {
    readonly method: 'github-ref-to-commit-v1';
    readonly declarationSha256: string;
    readonly count: number;
  };
}

function validationError(
  code: ProjectTemplateValidationError['code'],
  message: string,
  field: string,
): never {
  throw new ProjectTemplateValidationError(code, message, field);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  return exactRecordVariant(value, [keys], field);
}

function exactRecordVariant(
  value: unknown,
  keyVariants: readonly (readonly string[])[],
  field: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Array.isArray(value)
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      Object,
      [value],
    ) !== CAPTURED_OBJECT_PROTOTYPE
  ) {
    validationError(
      'NON_PLAIN_OBJECT',
      `${field} must be an exact plain data object`,
      field,
    );
  }
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    Object,
    [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const ownKeys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    Reflect,
    [descriptors],
  ) as PropertyKey[];
  const keys = keyVariants.find((candidate) => (
    ownKeys.length === candidate.length
    && ownKeys.every((key) => (
      typeof key === 'string' && candidate.includes(key)
    ))
  ));
  if (keys === undefined) {
    validationError('UNKNOWN_KEY', `${field} contains unknown or missing fields`, field);
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      validationError('UNKNOWN_KEY', `${field} contains unknown or missing fields`, field);
    }
    snapshot[key] = descriptor.value;
  }
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key !== 'string' || !keys.includes(key)) {
      validationError('UNKNOWN_KEY', `${field} contains unknown or missing fields`, field);
    }
  }
  return snapshot;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    validationError('INVALID_SOURCE', `${field} must be a non-empty string`, field);
  }
  return value;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    validationError('INVALID_HASH', `${field} must be a lowercase SHA-256`, field);
  }
  return value;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE,
    Object,
    [value],
  ) as Readonly<T>;
}

export function parseProjectTemplateSourceProvenance(
  value: unknown,
): ProjectTemplateSourceProvenanceV1 {
  const root = exactRecord(
    value,
    ['schemaVersion', 'source', 'archive', 'dependencyVerification'],
    'sourceProvenance',
  );
  if (root['schemaVersion'] !== '1.0') {
    validationError(
      root['schemaVersion'] === undefined ? 'INVALID_LOCK' : 'UNSUPPORTED_SCHEMA_VERSION',
      'source provenance schemaVersion must be exactly "1.0"',
      'sourceProvenance.schemaVersion',
    );
  }

  const sourceKeys = [
    'owner',
    'repo',
    'repositoryUrl',
    'canonicalSource',
    'requestedRef',
    'releaseTag',
    'commit',
    'descriptorSha256',
  ] as const;
  const rawSource = exactRecordVariant(
    root['source'],
    [
      sourceKeys,
      [...sourceKeys, 'assetName'],
    ],
    'sourceProvenance.source',
  );
  const owner = string(rawSource['owner'], 'sourceProvenance.source.owner');
  const repo = string(rawSource['repo'], 'sourceProvenance.source.repo');
  const repositoryUrl = string(
    rawSource['repositoryUrl'],
    'sourceProvenance.source.repositoryUrl',
  );
  const canonicalSource = string(
    rawSource['canonicalSource'],
    'sourceProvenance.source.canonicalSource',
  );
  const requestedRef = string(
    rawSource['requestedRef'],
    'sourceProvenance.source.requestedRef',
  );
  const releaseTag = string(
    rawSource['releaseTag'],
    'sourceProvenance.source.releaseTag',
  );
  let parsedSource;
  try {
    parsedSource = parseProjectTemplateGithubSourceSpec(canonicalSource);
  } catch {
    validationError(
      'INVALID_SOURCE',
      'source provenance canonicalSource is invalid',
      'sourceProvenance.source.canonicalSource',
    );
  }
  if (
    parsedSource.owner !== owner
    || parsedSource.repo !== repo
    || parsedSource.repositoryUrl !== repositoryUrl
    || parsedSource.ref !== requestedRef
    || (
      parsedSource.kind === 'github-ref'
        ? rawSource['assetName'] !== undefined
        : (
          parsedSource.ref !== releaseTag
          || rawSource['assetName'] !== parsedSource.assetName
        )
    )
  ) {
    validationError(
      'INVALID_SOURCE',
      'source provenance repository, ref, and release identities must agree',
      'sourceProvenance.source',
    );
  }
  const commit = rawSource['commit'];
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    validationError(
      'INVALID_SOURCE',
      'source provenance commit must be a lowercase full Git commit',
      'sourceProvenance.source.commit',
    );
  }

  const rawArchive = exactRecord(
    root['archive'],
    ['sha256', 'version', 'manifestSha256'],
    'sourceProvenance.archive',
  );
  const version = requireSemVer(
    rawArchive['version'],
    'sourceProvenance.archive.version',
  );
  const tagVersion = requireSemVer(
    releaseTag.startsWith('v') ? releaseTag.slice(1) : releaseTag,
    'sourceProvenance.source.releaseTag',
  );
  if (version !== tagVersion) {
    validationError(
      'INVALID_SOURCE',
      'source provenance version must match its release tag',
      'sourceProvenance.archive.version',
    );
  }

  const rawEvidence = exactRecord(
    root['dependencyVerification'],
    ['method', 'declarationSha256', 'count'],
    'sourceProvenance.dependencyVerification',
  );
  if (rawEvidence['method'] !== 'github-ref-to-commit-v1') {
    validationError(
      'INVALID_SOURCE',
      'source provenance dependency verification method is unsupported',
      'sourceProvenance.dependencyVerification.method',
    );
  }
  const count = rawEvidence['count'];
  if (
    typeof count !== 'number'
    || !Number.isSafeInteger(count)
    || count < 0
    || count > MAX_DEPENDENCIES
  ) {
    validationError(
      'INVALID_SOURCE',
      'source provenance dependency verification count is invalid',
      'sourceProvenance.dependencyVerification.count',
    );
  }

  const source = freeze({
    owner,
    repo,
    repositoryUrl,
    canonicalSource,
    requestedRef,
    releaseTag,
    ...(parsedSource.kind === 'github-release-asset'
      ? { assetName: parsedSource.assetName }
      : {}),
    commit,
    descriptorSha256: sha256(
      rawSource['descriptorSha256'],
      'sourceProvenance.source.descriptorSha256',
    ),
  });
  const archive = freeze({
    sha256: sha256(
      rawArchive['sha256'],
      'sourceProvenance.archive.sha256',
    ),
    version,
    manifestSha256: sha256(
      rawArchive['manifestSha256'],
      'sourceProvenance.archive.manifestSha256',
    ),
  });
  const dependencyVerification = freeze({
    method: 'github-ref-to-commit-v1' as const,
    declarationSha256: sha256(
      rawEvidence['declarationSha256'],
      'sourceProvenance.dependencyVerification.declarationSha256',
    ),
    count,
  });
  return freeze({
    schemaVersion: '1.0' as const,
    source,
    archive,
    dependencyVerification,
  });
}

export function serializeProjectTemplateSourceProvenance(value: unknown): string {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_JSON_STRINGIFY,
    JSON,
    [parseProjectTemplateSourceProvenance(value), null, 2],
  ) as string;
}

function assertByteLimit(bytes: number): void {
  if (bytes > MAX_PROJECT_TEMPLATE_SOURCE_PROVENANCE_BYTES) {
    validationError(
      'LIMIT_EXCEEDED',
      `source provenance exceeds the ${MAX_PROJECT_TEMPLATE_SOURCE_PROVENANCE_BYTES} byte limit`,
      'sourceProvenance',
    );
  }
}

export function parseProjectTemplateSourceProvenanceJson(
  input: string | Uint8Array,
): ProjectTemplateSourceProvenanceV1 {
  let json: string;
  if (typeof input === 'string') {
    assertByteLimit(CAPTURED_REFLECT_APPLY(
      CAPTURED_BUFFER_BYTE_LENGTH,
      Buffer,
      [input, 'utf8'],
    ) as number);
    json = input;
  } else if (
    typeof input === 'object'
    && input !== null
    && !types.isProxy(input)
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      Object,
      [input],
    ) === Uint8Array.prototype
  ) {
    assertByteLimit(input.byteLength);
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      json = CAPTURED_REFLECT_APPLY(
        CAPTURED_TEXT_DECODER_DECODE,
        decoder,
        [new Uint8Array(input)],
      ) as string;
    } catch {
      validationError(
        'INVALID_LOCK',
        'source provenance bytes must be valid UTF-8',
        'sourceProvenance',
      );
    }
  } else {
    validationError(
      'INVALID_LOCK',
      'source provenance input must be a string or Uint8Array',
      'sourceProvenance',
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = CAPTURED_REFLECT_APPLY(CAPTURED_JSON_PARSE, JSON, [json]);
  } catch {
    validationError(
      'INVALID_LOCK',
      'source provenance must contain valid JSON',
      'sourceProvenance',
    );
  }
  const parsed = parseProjectTemplateSourceProvenance(parsedJson);
  if (serializeProjectTemplateSourceProvenance(parsed) !== json) {
    validationError(
      'INVALID_LOCK',
      'source provenance JSON must use the canonical serialized representation',
      'sourceProvenance',
    );
  }
  return parsed;
}

export function calculateProjectTemplateSourceProvenanceSha256(
  value: unknown,
): string {
  const hash = CAPTURED_CREATE_HASH('sha256');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [
    serializeProjectTemplateSourceProvenance(value),
    'utf8',
  ]);
  return CAPTURED_REFLECT_APPLY(CAPTURED_HASH_DIGEST, hash, ['hex']) as string;
}
