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
import { projectTemplateSourceDescriptorV1JsonSchema } from './source-descriptor.js';

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

const derivedSourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'method', 'draftId'],
  properties: {
    kind: { const: 'derived' },
    method: { const: 'takt-editor-v1' },
    draftId: { type: 'string', pattern: SHA256_PATTERN_SOURCE },
  },
} as const;

const sourceSchemaV1_1 = {
  oneOf: [...sourceSchema.oneOf, derivedSourceSchema],
} as const;

const sourceDerivationPairSchema = {
  oneOf: [
    {
      properties: {
        source: sourceSchema,
        derivation: {
          type: 'object',
          required: ['kind'],
          properties: { kind: { const: 'root' } },
        },
      },
    },
    {
      properties: {
        source: derivedSourceSchema,
        derivation: {
          type: 'object',
          required: ['kind'],
          properties: { kind: { const: 'derived' } },
        },
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

/**
 * Draft-07 editor-save manifest structure. NFC normalization and repertoire
 * ordering are enforced by the strict parser because JSON Schema cannot
 * express either portable invariant without implementation-specific extensions.
 * The metadata pattern pairs Unicode properties with a self-negating legacy
 * identity escape so both Unicode and non-Unicode validators reject astral controls.
 */
export const projectTemplateManifestV1_1JsonSchema = {
  $schema: draft,
  $id: 'https://takt.dev/schemas/project-template-manifest-v1.1.json',
  title: 'TAKT Project Template Manifest v1.1',
  type: 'object',
  additionalProperties: false,
  allOf: [sourceDerivationPairSchema],
  required: [
    'schemaVersion',
    'packVersion',
    'metadata',
    'derivation',
    'takt',
    'source',
    'repertoireDependencies',
    'entries',
  ],
  properties: {
    schemaVersion: { const: '1.1' },
    packVersion: semverSchema,
    metadata: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^(?!\\s)(?!.*\\s$)(?![\\s\\S]*(?:\\p{Default_Ignorable_Code_Point}(?<!p\\{Default_Ignorable_Code_Point\\})|\\uD82F[\\uDCA0-\\uDCA3]|\\uD834[\\uDD73-\\uDD7A]|[\\uDB40-\\uDB43][\\uDC00-\\uDFFF]))(?!.*[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF]))(?!.*(?:^|[^\\uD800-\\uDBFF])[\\uDC00-\\uDFFF])[^\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u115F-\\u1160\\u17B4-\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF0-\\uFFFB]*$',
        },
        description: {
          type: 'string',
          minLength: 0,
          maxLength: 2048,
          pattern: '^(?![\\s\\S]*(?:\\p{Default_Ignorable_Code_Point}(?<!p\\{Default_Ignorable_Code_Point\\})|\\uD82F[\\uDCA0-\\uDCA3]|\\uD834[\\uDD73-\\uDD7A]|[\\uDB40-\\uDB43][\\uDC00-\\uDFFF]))(?!.*[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF]))(?!.*(?:^|[^\\uD800-\\uDBFF])[\\uDC00-\\uDFFF])[^\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u115F-\\u1160\\u17B4-\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF0-\\uFFFB]*$',
        },
      },
    },
    derivation: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: { kind: { const: 'root' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'operation', 'draftId', 'editDocumentSha256', 'parent'],
          properties: {
            kind: { const: 'derived' },
            operation: { const: 'editor-save' },
            draftId: { type: 'string', pattern: SHA256_PATTERN_SOURCE },
            editDocumentSha256: { type: 'string', pattern: SHA256_PATTERN_SOURCE },
            parent: {
              type: 'object',
              additionalProperties: false,
              required: ['archiveSha256', 'manifestSha256', 'packVersion'],
              properties: {
                archiveSha256: { type: 'string', pattern: SHA256_PATTERN_SOURCE },
                manifestSha256: { type: 'string', pattern: SHA256_PATTERN_SOURCE },
                packVersion: semverSchema,
              },
            },
          },
        },
      ],
    },
    takt: {
      type: 'object',
      additionalProperties: false,
      required: ['minVersion'],
      properties: {
        minVersion: semverSchema,
        maxVersion: semverSchema,
      },
    },
    source: sourceSchemaV1_1,
    repertoireDependencies:
      projectTemplateSourceDescriptorV1JsonSchema.properties.repertoireDependencies,
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

/**
 * Draft-07 editor-save lock structure. Metadata stays only in the manifest:
 * its digest binds that display content, while this lock repeats authority
 * fields needed to prevent a reviewed lineage or dependency substitution.
 */
export const projectTemplateLockV1_1JsonSchema = {
  $schema: draft,
  $id: 'https://takt.dev/schemas/project-template-lock-v1.1.json',
  title: 'TAKT Project Template Lock v1.1',
  type: 'object',
  additionalProperties: false,
  allOf: [sourceDerivationPairSchema],
  required: [
    'schemaVersion',
    'manifestSha256',
    'packVersion',
    'source',
    'derivation',
    'repertoireDependencies',
    'capabilities',
    'entries',
  ],
  properties: {
    schemaVersion: { const: '1.1' },
    manifestSha256: { type: 'string', pattern: SHA256_PATTERN_SOURCE },
    packVersion: semverSchema,
    source: sourceSchemaV1_1,
    derivation: projectTemplateManifestV1_1JsonSchema.properties.derivation,
    repertoireDependencies:
      projectTemplateSourceDescriptorV1JsonSchema.properties.repertoireDependencies,
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
