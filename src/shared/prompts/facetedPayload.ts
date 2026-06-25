import type {
  ComposedPromptPayload,
  ComposeDefinition,
  ComposeOptions,
} from 'faceted-prompting';
import { composePromptPayload } from 'faceted-prompting';

export interface ComposeTaktPromptPayloadParams {
  definition: ComposeDefinition;
  definitionDir: string;
  facetsRoots: readonly string[];
  facetedRoots?: readonly string[];
  composeOptions: ComposeOptions;
}

export function composeTaktPromptPayload(
  params: ComposeTaktPromptPayloadParams,
): ComposedPromptPayload {
  if (params.facetsRoots.length === 0) {
    throw new Error('At least one facet root is required to compose a TAKT prompt payload');
  }

  // TAKT keeps plural facet directories, so path-based refs preserve that contract explicitly.
  return composePromptPayload({
    definition: params.definition,
    definitionDir: params.definitionDir,
    facetsRoots: params.facetsRoots,
    facetedRoots: params.facetedRoots,
    composeOptions: params.composeOptions,
  });
}
