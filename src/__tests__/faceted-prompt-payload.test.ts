import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { ComposeDefinition } from 'faceted-prompting';
import { composeTaktPromptPayload } from '../shared/prompts/facetedPayload.js';
import { getLanguageResourcesDir } from '../infra/resources/index.js';

describe('composeTaktPromptPayload', () => {
  it('composes TAKT builtin facets through path-based references and returns copy files', () => {
    const facetsRoot = join(getLanguageResourcesDir('en'), 'facets');
    const definition: ComposeDefinition = {
      name: 'builtin-path-based-payload',
      persona: 'personas/coder.md',
      knowledge: ['knowledge/takt.md'],
      policies: ['policies/coding.md'],
      instructions: ['instructions/implement.md'],
    };

    const payload = composeTaktPromptPayload({
      definition,
      definitionDir: facetsRoot,
      facetsRoots: [facetsRoot],
      composeOptions: { contextMaxChars: 10000 },
    });

    expect(payload.systemPrompt).toContain('# Coder Agent');
    expect(payload.userPrompt).toContain('Implement according to the plan.');
    expect(payload.userPrompt).toContain('# Coding Policy');
    expect(payload.copyFiles.persona).toEqual([join(facetsRoot, 'personas', 'coder.md')]);
    expect(payload.copyFiles.knowledge).toEqual([join(facetsRoot, 'knowledge', 'takt.md')]);
    expect(payload.copyFiles.policies).toEqual([join(facetsRoot, 'policies', 'coding.md')]);
    expect(payload.copyFiles.instructions).toEqual([join(facetsRoot, 'instructions', 'implement.md')]);
  });

  it('fails fast when no facet root is provided', () => {
    const facetsRoot = join(getLanguageResourcesDir('en'), 'facets');

    expect(() => composeTaktPromptPayload({
      definition: {
        name: 'missing-roots',
        persona: 'personas/coder.md',
      },
      definitionDir: facetsRoot,
      facetsRoots: [],
      composeOptions: { contextMaxChars: 10000 },
    })).toThrow(/facet root/i);
  });
});
