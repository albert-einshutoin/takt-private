import type {
  GithubTemplateCurrentSourceEvidence,
  GithubTemplateSourceAdvisory,
  ResolvedGithubTemplateSource,
} from './github-update-check.js';

export interface GithubTemplateSourceResolutionInput {
  readonly source: string;
  readonly current?: GithubTemplateCurrentSourceEvidence;
  readonly signal?: AbortSignal;
}

/**
 * High-level source resolution boundary. Implementations own credentials and
 * raw GitHub metadata; callers receive either authority-free evidence or one
 * fresh, process-local download authority.
 */
export interface GithubTemplateSourceResolverPort {
  resolveAdvisory(
    input: GithubTemplateSourceResolutionInput,
  ): Promise<GithubTemplateSourceAdvisory>;
  resolveForDownload(
    input: GithubTemplateSourceResolutionInput,
  ): Promise<ResolvedGithubTemplateSource>;
}
