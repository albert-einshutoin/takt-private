import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveExecutionContext } from '../features/pipeline/steps.js';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();
}

function gitSucceeds(cwd: string, args: string[]): boolean {
  return spawnSync('git', args, { cwd, stdio: 'pipe' }).status === 0;
}

describe('independent pipeline branch ancestry', () => {
  const repositories: string[] = [];

  afterEach(() => {
    for (const repository of repositories.splice(0)) {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('starts a new direct pipeline branch from origin/main instead of the current feature', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'takt-independent-pipeline-'));
    repositories.push(repository);
    runGit(repository, ['init', '--initial-branch=main']);
    runGit(repository, ['config', 'user.name', 'TAKT Test']);
    runGit(repository, ['config', 'user.email', 'takt-test@example.invalid']);

    writeFileSync(join(repository, 'base.txt'), 'base\n', 'utf-8');
    runGit(repository, ['add', 'base.txt']);
    runGit(repository, ['commit', '-m', 'base']);
    const mainCommit = runGit(repository, ['rev-parse', 'HEAD']);
    runGit(repository, ['update-ref', 'refs/remotes/origin/main', mainCommit]);
    runGit(repository, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

    runGit(repository, ['checkout', '-b', 'feature/a']);
    writeFileSync(join(repository, 'feature-a.txt'), 'feature a\n', 'utf-8');
    runGit(repository, ['add', 'feature-a.txt']);
    runGit(repository, ['commit', '-m', 'feature a']);

    const context = await resolveExecutionContext(
      repository,
      'Implement independent feature B',
      {
        branch: 'feature/b',
        autoPr: false,
        isolation: 'none',
      },
      undefined,
    );

    expect(context.branch).toBe('feature/b');
    expect(context.baseBranch).toBe('main');
    expect(runGit(repository, ['rev-parse', 'feature/b'])).toBe(mainCommit);
    expect(gitSucceeds(repository, [
      'merge-base',
      '--is-ancestor',
      'feature/a',
      'feature/b',
    ])).toBe(false);
  });
});
