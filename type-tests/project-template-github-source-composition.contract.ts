import {
  createProjectTemplateGithubSourceComposition,
  type GithubTemplateArchiveAssetPort,
  type GithubTemplateSourceResolverPort,
  type ProjectTemplateGithubSourceComposition,
  type ProjectTemplateGithubSourceCompositionDependencies,
} from '../src/index.js';

declare const dependencies:
  ProjectTemplateGithubSourceCompositionDependencies;

const composition: ProjectTemplateGithubSourceComposition =
  createProjectTemplateGithubSourceComposition(
    { deadlineMs: 1 },
    dependencies,
  );
const resolver: GithubTemplateSourceResolverPort = composition.resolver;
const archive: GithubTemplateArchiveAssetPort = composition.archive;
void resolver;
void archive;

// @ts-expect-error The shared absolute deadline must be numeric.
createProjectTemplateGithubSourceComposition({ deadlineMs: '1' });

const missingRequest:
ProjectTemplateGithubSourceCompositionDependencies = {
  now: () => 1,
  setTimer: () => ({}),
  clearTimer: () => undefined,
  acquireCredential: async () => Object.freeze({
    dispose: () => undefined,
  }),
  createAttempt: () => {
    throw new Error('unreachable');
  },
  // @ts-expect-error Metadata transport is required by the F3 projection.
  requestMetadata: undefined,
};
void missingRequest;

const withExtra: ProjectTemplateGithubSourceCompositionDependencies = {
  ...dependencies,
  // @ts-expect-error Runtime dependency records are exact.
  extra: true,
};
void withExtra;
