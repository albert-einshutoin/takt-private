import {
  resolveAuthenticatedGithubTemplateSource,
  type ProjectTemplateSourceResolverDependencies,
} from '../src/index.js';
import type {
  GithubTemplateArchiveAssetPort,
  ResolvedGithubTemplateSource,
} from '../src/index.js';

declare const checksumAssets: GithubTemplateArchiveAssetPort;

const result: Promise<ResolvedGithubTemplateSource> =
  resolveAuthenticatedGithubTemplateSource({
    source: 'github:octo/demo@main',
    checksumAssets,
    deadlineMs: 1,
  });
void result;

const dependencies: ProjectTemplateSourceResolverDependencies = {
  acquireCredential: async () => Object.freeze({
    dispose: () => undefined,
  }),
  requestMetadata: async () => Buffer.from('{}'),
};
void dependencies;

resolveAuthenticatedGithubTemplateSource({
  source: 'github:octo/demo@main',
  // @ts-expect-error Checksum assets require the bounded D5 port.
  checksumAssets: ['template.taktpack.sha256'],
  deadlineMs: 1,
});

// @ts-expect-error Metadata ports are private implementation details.
const leakedMetadata = dependencies.metadata;
void leakedMetadata;
// @ts-expect-error Credentials have no exported structural type here.
const leakedCredential = dependencies.credential;
void leakedCredential;
