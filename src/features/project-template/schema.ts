import {
  COMMIT_PATTERN_SOURCE,
  GITHUB_URI_PATTERN_SOURCE,
  GIT_URI_PATTERN_SOURCE,
  LOCAL_SOURCE_URI_PATTERN_SOURCE,
  MAX_SEMVER_LENGTH,
  MAX_SOURCE_REF_LENGTH,
  MAX_SOURCE_URI_LENGTH,
  MAX_TEMPLATE_ENTRIES,
  MAX_TEMPLATE_PATH_LENGTH,
  PROJECT_TEMPLATE_PATH_PATTERN_SOURCE,
  SEMVER_PATTERN_SOURCE,
  SHA256_PATTERN_SOURCE,
  SOURCE_REF_PATTERN_SOURCE,
  TEMPLATE_CAPABILITIES,
  TEMPLATE_ENTRY_POLICIES,
} from './validation.js';

const draft = 'http://json-schema.org/draft-07/schema#';

const semverSchema = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_SEMVER_LENGTH,
  pattern: SEMVER_PATTERN_SOURCE,
} as const;

const capabilitiesSchema = {
  type: 'array',
  maxItems: TEMPLATE_CAPABILITIES.length,
  uniqueItems: true,
  items: { enum: TEMPLATE_CAPABILITIES },
} as const;

const sourceBaseProperties = {
  commit: { type: 'string', pattern: COMMIT_PATTERN_SOURCE },
} as const;

const sourceSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'uri', 'ref', 'commit'],
      properties: {
        kind: { const: 'github' },
        uri: { type: 'string', maxLength: MAX_SOURCE_URI_LENGTH, pattern: GITHUB_URI_PATTERN_SOURCE },
        ref: { type: 'string', maxLength: MAX_SOURCE_REF_LENGTH, pattern: SOURCE_REF_PATTERN_SOURCE },
        ...sourceBaseProperties,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'uri', 'ref', 'commit'],
      properties: {
        kind: { const: 'git' },
        uri: { type: 'string', maxLength: MAX_SOURCE_URI_LENGTH, pattern: GIT_URI_PATTERN_SOURCE },
        ref: { type: 'string', maxLength: MAX_SOURCE_REF_LENGTH, pattern: SOURCE_REF_PATTERN_SOURCE },
        ...sourceBaseProperties,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'uri', 'ref', 'commit'],
      properties: {
        kind: { const: 'local' },
        uri: { type: 'string', maxLength: MAX_SOURCE_URI_LENGTH, pattern: LOCAL_SOURCE_URI_PATTERN_SOURCE },
        ref: { const: 'workspace' },
        ...sourceBaseProperties,
      },
    },
  ],
} as const;

const entryProperties = {
  path: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_TEMPLATE_PATH_LENGTH,
    pattern: PROJECT_TEMPLATE_PATH_PATTERN_SOURCE,
  },
  policy: { enum: TEMPLATE_ENTRY_POLICIES },
  mode: { type: 'string', pattern: '^0[0-7]{3}$' },
  sha256: { type: 'string', pattern: SHA256_PATTERN_SOURCE },
  capabilities: capabilitiesSchema,
} as const;

export const projectTemplateManifestV1JsonSchema = {
  $schema: draft,
  $id: 'https://takt.dev/schemas/project-template-manifest-v1.json',
  title: 'TAKT Project Template Manifest v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'packVersion', 'takt', 'source', 'entries'],
  properties: {
    schemaVersion: { const: '1.0' },
    packVersion: semverSchema,
    takt: {
      type: 'object',
      additionalProperties: false,
      required: ['minVersion'],
      properties: {
        minVersion: semverSchema,
        maxVersion: semverSchema,
      },
    },
    source: sourceSchema,
    capabilities: capabilitiesSchema,
    entries: {
      type: 'array',
      maxItems: MAX_TEMPLATE_ENTRIES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'policy', 'mode', 'sha256'],
        properties: entryProperties,
      },
    },
  },
} as const;

export const projectTemplateLockV1JsonSchema = {
  $schema: draft,
  $id: 'https://takt.dev/schemas/project-template-lock-v1.json',
  title: 'TAKT Project Template Lock v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'manifestSha256', 'packVersion', 'source', 'capabilities', 'entries'],
  properties: {
    schemaVersion: { const: '1.0' },
    manifestSha256: { type: 'string', pattern: SHA256_PATTERN_SOURCE },
    packVersion: semverSchema,
    source: sourceSchema,
    capabilities: capabilitiesSchema,
    entries: {
      type: 'array',
      maxItems: MAX_TEMPLATE_ENTRIES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'policy', 'mode', 'sha256', 'capabilities'],
        properties: entryProperties,
      },
    },
  },
} as const;
