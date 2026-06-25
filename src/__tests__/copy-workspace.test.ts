import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCopyWorkspace } from '../infra/task/copyWorkspace.js';

function createProjectDir(): string {
  const dir = join(tmpdir(), `takt-copy-workspace-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('createCopyWorkspace', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createProjectDir();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(join(projectDir, '..', 'takt-workspaces'), { recursive: true, force: true });
  });

  it('copies a non-git project into ../takt-workspaces without mutating the source directory', () => {
    writeFileSync(join(projectDir, 'README.md'), '# source\n', 'utf-8');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'index.ts'), 'export const value = 1;\n', 'utf-8');

    const result = createCopyWorkspace(projectDir, { taskSlug: 'non-git-task' });

    expect(dirname(result.path)).toBe(join(projectDir, '..', 'takt-workspaces'));
    expect(basename(result.path)).toMatch(/^\d{13}-non-git-task-/);
    expect(readFileSync(join(result.path, 'README.md'), 'utf-8')).toBe('# source\n');
    expect(readFileSync(join(result.path, 'src', 'index.ts'), 'utf-8')).toContain('value = 1');

    writeFileSync(join(result.path, 'README.md'), '# copied\n', 'utf-8');

    expect(readFileSync(join(projectDir, 'README.md'), 'utf-8')).toBe('# source\n');
  });

  it('excludes git metadata, takt run/worktree outputs, node_modules, and build caches', () => {
    writeFileSync(join(projectDir, 'keep.txt'), 'keep\n', 'utf-8');
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'runs', 'run-a'), { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'worktrees', 'old'), { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'facets'), { recursive: true });
    mkdirSync(join(projectDir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(projectDir, 'dist'), { recursive: true });
    mkdirSync(join(projectDir, 'coverage'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'facets', 'keep.md'), 'facet\n', 'utf-8');

    const result = createCopyWorkspace(projectDir, { taskSlug: 'exclude-heavy' });

    expect(existsSync(join(result.path, 'keep.txt'))).toBe(true);
    expect(existsSync(join(result.path, '.takt', 'facets', 'keep.md'))).toBe(true);
    expect(existsSync(join(result.path, '.git'))).toBe(false);
    expect(existsSync(join(result.path, '.takt', 'runs'))).toBe(false);
    expect(existsSync(join(result.path, '.takt', 'worktrees'))).toBe(false);
    expect(existsSync(join(result.path, 'node_modules'))).toBe(false);
    expect(existsSync(join(result.path, 'dist'))).toBe(false);
    expect(existsSync(join(result.path, 'coverage'))).toBe(false);
  });
});
