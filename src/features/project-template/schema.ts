/**
 * JSON Schema equivalent exported from the library for editor integrations.
 * It is code-owned so the runtime validator and published declaration remain
 * in the same npm `dist/` artifact rather than relying on a copied asset.
 */
export const projectTemplateManifestV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://takt.dev/schemas/project-template-manifest-v1.json',
  title: 'TAKT Project Template Manifest v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'packVersion', 'takt', 'source', 'entries'],
  properties: {
    schemaVersion: { const: '1.0' },
    packVersion: { type: 'string' },
    takt: {
      type: 'object',
      additionalProperties: false,
      required: ['minVersion'],
      properties: {
        minVersion: { type: 'string' },
        maxVersion: { type: 'string' },
      },
    },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'uri', 'ref', 'commit'],
      properties: {
        kind: { enum: ['local', 'git', 'github'] },
        uri: { type: 'string' },
        ref: { type: 'string' },
        commit: { type: 'string' },
      },
    },
    capabilities: {
      type: 'array',
      uniqueItems: true,
      items: { enum: ['executable', 'github-write', 'external-command'] },
    },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'policy', 'mode', 'sha256'],
        properties: {
          path: { type: 'string' },
          policy: { enum: ['managed', 'merge', 'scaffold', 'excluded'] },
          mode: { type: 'string', pattern: '^0[0-7]{3}$' },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          capabilities: {
            type: 'array',
            uniqueItems: true,
            items: { enum: ['executable', 'github-write', 'external-command'] },
          },
        },
      },
    },
  },
} as const;
