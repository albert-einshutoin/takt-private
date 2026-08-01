import { describe, expect, it } from 'vitest';
import { ProjectTemplateValidationError } from '../../features/project-template/errors.js';
import { parseProjectTemplateGithubSourceSpec } from '../../features/project-template/github-source-spec.js';

describe('parseProjectTemplateGithubSourceSpec', () => {
  it('normalizes an explicit GitHub repository ref', () => {
    expect(parseProjectTemplateGithubSourceSpec(
      'github:OpenAI/My.Template@refs/tags/v1.2.3',
    )).toEqual({
      kind: 'github-ref',
      owner: 'openai',
      repo: 'my.template',
      ref: 'refs/tags/v1.2.3',
      repositoryUrl: 'https://github.com/openai/my.template',
    });
  });

  it('accepts a portable ref containing slashes', () => {
    expect(parseProjectTemplateGithubSourceSpec(
      'github:owner/repo@feature/release-142',
    )).toMatchObject({
      kind: 'github-ref',
      ref: 'feature/release-142',
    });
  });

  it('accepts literal plus in portable refs and release tags', () => {
    expect(parseProjectTemplateGithubSourceSpec(
      'github:owner/repo@v1.2.3+build.1',
    )).toMatchObject({ ref: 'v1.2.3+build.1' });

    const assetUrl =
      'https://github.com/owner/repo/releases/download/v1.2.3+build.1/template.taktpack';
    expect(parseProjectTemplateGithubSourceSpec(assetUrl)).toMatchObject({
      ref: 'v1.2.3+build.1',
      assetUrl,
    });
  });

  it('accepts legitimate repeated dots in repository and asset names', () => {
    expect(parseProjectTemplateGithubSourceSpec(
      'github:owner/repo..template@v1.0.0',
    )).toMatchObject({ repo: 'repo..template' });

    const assetUrl =
      'https://github.com/owner/repo..template/releases/download/v1.0.0/template..pack.taktpack';
    expect(parseProjectTemplateGithubSourceSpec(assetUrl)).toMatchObject({
      repo: 'repo..template',
      assetName: 'template..pack.taktpack',
    });
  });

  it('accepts only the canonical GitHub release asset form', () => {
    const assetUrl =
      'https://github.com/owner/repo/releases/download/v1.2.3/project-template.taktpack';

    expect(parseProjectTemplateGithubSourceSpec(assetUrl)).toEqual({
      kind: 'github-release-asset',
      owner: 'owner',
      repo: 'repo',
      ref: 'v1.2.3',
      assetName: 'project-template.taktpack',
      repositoryUrl: 'https://github.com/owner/repo',
      assetUrl,
    });
  });

  it.each([
    'github:owner/repo',
    'github:owner/repo@',
    'github:owner/repo@main@backup',
    'github:/repo@main',
    'github:owner/@main',
    'github:owner/repo/extra@main',
    'github:-owner/repo@main',
    'github:owner-/repo@main',
    'github:owner--name/repo@main',
    'github:owner/.@main',
    'github:owner/..@main',
    'github:owner/repo.git@main',
    'github:owner/repo@../main',
    'github:owner/repo@.hidden',
    'github:owner/repo@refs//main',
    'github:owner/repo@main.lock',
    'github:owner/repo@main@{1}',
    'github:owner/repo@feature branch',
    'github:owner/repo@リリース',
    'github:owner/repo@release\u202E1',
    'github:owner/repo@release\u200B1',
    'GitHub:owner/repo@main',
  ])('rejects an ambiguous or dangerous repository ref: %s', (source) => {
    expectInvalidSource(source);
  });

  it('rejects a ref over the portable length limit', () => {
    expectInvalidSource(`github:owner/repo@${'a'.repeat(257)}`);
  });

  it.each([
    'https://github.com/owner/repo/releases/download/feature/v1/template.taktpack',
    'https://github.com/owner/repo/releases/download/v1%2Fv2/template.taktpack',
    'https://github.com/owner/repo/releases/download/v1%252Fv2/template.taktpack',
  ])('rejects a release tag that is not one unescaped portable path segment: %s', (source) => {
    expectInvalidSource(source);
    expect(() => parseProjectTemplateGithubSourceSpec(source))
      .toThrow(/path ambiguity/);
  });

  it.each([
    'https://example.com/owner/repo/releases/download/v1/template.taktpack',
    'https://github.com/owner/repo',
    'https://github.com/owner/repo/releases/latest/download/template.taktpack',
    'https://github.com/owner/repo/releases/download/v1/template.zip',
    'https://github.com/owner/repo/releases/download//template.taktpack',
    'https://github.com/owner/repo/releases/download/v1/',
    'https://github.com/owner/repo/releases/download/v1/template.taktpack?download=1',
    'https://github.com/owner/repo/releases/download/v1/template.taktpack#asset',
    'https://user@github.com/owner/repo/releases/download/v1/template.taktpack',
    'https://github.com:443/owner/repo/releases/download/v1/template.taktpack',
    'HTTPS://github.com/owner/repo/releases/download/v1/template.taktpack',
    'https://GitHub.com/owner/repo/releases/download/v1/template.taktpack',
    'https://github.com/Owner/repo/releases/download/v1/template.taktpack',
    'https://github.com/owner/Repo/releases/download/v1/template.taktpack',
    'https://github.com/owner/repo/releases/download/v1/template%5Cname.taktpack',
    'https://github.com/owner/repo/releases/download/v1/../template.taktpack',
    'https://objects.githubusercontent.com/owner/repo/releases/download/v1/template.taktpack',
  ])('rejects a non-canonical or redirect-dependent release URL: %s', (source) => {
    expectInvalidSource(source);
  });

  it.each([undefined, null, {}, '', ' github:owner/repo@main'])(
    'rejects a non-string, empty, or whitespace-padded source: %j',
    (source) => {
      expectInvalidSource(source);
    },
  );
});

function expectInvalidSource(source: unknown): void {
  expect(() => parseProjectTemplateGithubSourceSpec(source)).toThrow(
    expect.objectContaining<Partial<ProjectTemplateValidationError>>({
      name: 'ProjectTemplateValidationError',
      code: 'INVALID_SOURCE',
      field: 'source',
    }),
  );
}
