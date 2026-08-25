/**
 * Unit tests for resolveRef in github-ref-resolver.ts.
 *
 * Covers:
 * - Returns specRef directly when provided
 * - Calls execGh with correct API path to retrieve default branch
 * - Returns trimmed branch name from execGh output
 * - Throws when execGh returns empty string
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveRef,
  verifyImmutableGithubDependencySources,
} from '../../features/repertoire/github-ref-resolver.js';

const DEPENDENCIES = [{
  scope: '@acme/alpha',
  version: '1.2.3',
  source: 'github:acme/alpha@v1.2.3',
  commit: '0123456789abcdef0123456789abcdef01234567',
  capabilities: ['edit'] as const,
}, {
  scope: '@acme/beta',
  version: '2.0.0',
  source: 'github:acme/beta@refs/tags/v2.0.0',
  commit: 'abcdef0123456789abcdef0123456789abcdef01',
  capabilities: [] as const,
}] as const;

describe('resolveRef', () => {
  it('should return specRef directly when provided', () => {
    // Given: specRef is specified
    const execGh = vi.fn();

    // When: resolveRef is called with a specRef
    const result = resolveRef('main', 'owner', 'repo', execGh);

    // Then: returns specRef without calling execGh
    expect(result).toBe('main');
    expect(execGh).not.toHaveBeenCalled();
  });

  it('should return specRef even when it is a SHA', () => {
    // Given: specRef is a commit SHA
    const execGh = vi.fn();

    const result = resolveRef('abc1234def', 'owner', 'repo', execGh);

    expect(result).toBe('abc1234def');
    expect(execGh).not.toHaveBeenCalled();
  });

  it('should call execGh with correct API args when specRef is undefined', () => {
    // Given: specRef is undefined (omitted from spec)
    const execGh = vi.fn().mockReturnValue('main\n');

    // When: resolveRef is called without specRef
    resolveRef(undefined, 'nrslib', 'takt-fullstack', execGh);

    // Then: calls gh api with the correct path and jq filter
    expect(execGh).toHaveBeenCalledOnce();
    expect(execGh).toHaveBeenCalledWith([
      'api',
      '/repos/nrslib/takt-fullstack',
      '--jq', '.default_branch',
    ]);
  });

  it('should return trimmed branch name from execGh output', () => {
    // Given: execGh returns branch name with trailing newline
    const execGh = vi.fn().mockReturnValue('develop\n');

    // When: resolveRef is called
    const result = resolveRef(undefined, 'owner', 'repo', execGh);

    // Then: branch name is trimmed
    expect(result).toBe('develop');
  });

  it('should throw when execGh returns an empty string', () => {
    // Given: execGh returns empty output (API error or unexpected response)
    const execGh = vi.fn().mockReturnValue('');

    // When / Then: throws an error with the owner/repo in the message
    expect(() => resolveRef(undefined, 'owner', 'repo', execGh)).toThrow(
      'デフォルトブランチを取得できませんでした: owner/repo',
    );
  });

  it('should throw when execGh returns only whitespace', () => {
    // Given: execGh returns whitespace only
    const execGh = vi.fn().mockReturnValue('   \n');

    // When / Then: throws (whitespace trims to empty string)
    expect(() => resolveRef(undefined, 'myorg', 'myrepo', execGh)).toThrow(
      'デフォルトブランチを取得できませんでした: myorg/myrepo',
    );
  });
});

describe('verifyImmutableGithubDependencySources', () => {
  it('resolves every canonical tag sequentially and returns sealed evidence', async () => {
    const calls: string[] = [];
    let active = 0;
    const result = await verifyImmutableGithubDependencySources({
      dependencies: DEPENDENCIES,
      resolver: {
        async resolveRefToCommit(input) {
          active += 1;
          expect(active).toBe(1);
          calls.push(`${input.owner}/${input.repo}@${input.ref}`);
          await Promise.resolve();
          active -= 1;
          return { commit: DEPENDENCIES[calls.length - 1]!.commit };
        },
      },
    });

    expect(calls).toEqual([
      'acme/alpha@v1.2.3',
      'acme/beta@refs/tags/v2.0.0',
    ]);
    expect(result).toEqual({
      method: 'github-ref-to-commit-v1',
      declarationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      count: 2,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('fails closed when a tag was republished to another commit', async () => {
    await expect(verifyImmutableGithubDependencySources({
      dependencies: DEPENDENCIES.slice(0, 1),
      resolver: {
        async resolveRefToCommit() {
          return { commit: 'ffffffffffffffffffffffffffffffffffffffff' };
        },
      },
    })).rejects.toMatchObject({ code: 'COMMIT_MISMATCH' });
  });

  it('returns zero-count evidence without invoking the metadata port', async () => {
    const resolveRefToCommit = vi.fn();
    await expect(verifyImmutableGithubDependencySources({
      dependencies: [],
      resolver: { resolveRefToCommit },
    })).resolves.toMatchObject({
      method: 'github-ref-to-commit-v1',
      count: 0,
    });
    expect(resolveRefToCommit).not.toHaveBeenCalled();
  });

  it('captures the resolver receiver and method before the first await', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = {
      marker: 'original',
      async resolveRefToCommit(
        this: { marker: string },
        input: { repo: string },
      ) {
        expect(this).toBe(resolver);
        if (input.repo === 'alpha') await gate;
        return {
          commit: input.repo === 'alpha'
            ? DEPENDENCIES[0]!.commit
            : DEPENDENCIES[1]!.commit,
        };
      },
    };
    const pending = verifyImmutableGithubDependencySources({
      dependencies: DEPENDENCIES,
      resolver,
    });
    await Promise.resolve();
    resolver.resolveRefToCommit = vi.fn(async () => {
      throw new Error('SECRET replacement');
    });
    release();

    await expect(pending).resolves.toMatchObject({ count: 2 });
    expect(resolver.resolveRefToCommit).not.toHaveBeenCalled();
  });

  it('rejects non-canonical declarations before invoking the resolver', async () => {
    const resolveRefToCommit = vi.fn();
    await expect(verifyImmutableGithubDependencySources({
      dependencies: [...DEPENDENCIES].reverse(),
      resolver: { resolveRefToCommit },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(resolveRefToCommit).not.toHaveBeenCalled();
  });

  it('maps abort and resolver details to finite non-secret errors', async () => {
    const controller = new AbortController();
    controller.abort('SECRET abort reason');
    const error = await verifyImmutableGithubDependencySources({
      dependencies: DEPENDENCIES,
      resolver: {
        async resolveRefToCommit() {
          throw new Error('token SECRET https://api.github.com/private');
        },
      },
      signal: controller.signal,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'ABORTED' });
    expect(String(error)).not.toContain('SECRET');
    expect(String(error)).not.toContain('https://');
  });
});
