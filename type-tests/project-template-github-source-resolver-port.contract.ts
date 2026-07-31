import type {
  DownloadGithubTemplateSourceOptions,
  GithubTemplateSourceAdvisory,
  GithubTemplateSourceResolutionInput,
  GithubTemplateSourceResolverPort,
  ResolvedGithubTemplateSource,
} from '../src/features/project-template/index.js';

declare const advisory: GithubTemplateSourceAdvisory;
declare const resolved: ResolvedGithubTemplateSource;
declare const asset: DownloadGithubTemplateSourceOptions['asset'];
declare const authenticator:
  DownloadGithubTemplateSourceOptions['authenticator'];
declare const verifier: DownloadGithubTemplateSourceOptions['verifier'];

const resolver: GithubTemplateSourceResolverPort = {
  async resolveAdvisory(
    input: GithubTemplateSourceResolutionInput,
  ): Promise<GithubTemplateSourceAdvisory> {
    void input.source;
    return advisory;
  },
  async resolveForDownload(
    input: GithubTemplateSourceResolutionInput,
  ): Promise<ResolvedGithubTemplateSource> {
    void input.signal;
    return resolved;
  },
};

const options: DownloadGithubTemplateSourceOptions = {
  projectRoot: '/project',
  source: 'github:acme/template@main',
  advisory,
  resolver,
  asset,
  cacheRoot: '/cache',
  authenticator,
  verifier,
};
void options;

const retiredMetadataOptions: DownloadGithubTemplateSourceOptions = {
  projectRoot: '/project',
  source: 'github:acme/template@main',
  advisory,
  // @ts-expect-error Raw metadata is retired from the orchestrator boundary.
  metadata: {},
  asset,
  cacheRoot: '/cache',
  authenticator,
  verifier,
};
void retiredMetadataOptions;
