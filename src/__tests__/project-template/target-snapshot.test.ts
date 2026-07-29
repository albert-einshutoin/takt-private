import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureProjectTemplateTargetSnapshot,
} from '../../features/project-template/index.js';

const roots: string[] = [];

function makeRoot(withGit = true): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-apply-target-'));
  roots.push(root);
  mkdirSync(join(root, '.takt'), { recursive: true });
  if (withGit) {
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  }
  return root;
}

function writeTakt(root: string, path: string, content: string): void {
  const absolutePath = join(root, '.takt', path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function commitAll(root: string): void {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'pipe' });
}

function fingerprint(root: string): unknown {
  const taktRoot = join(root, '.takt');
  const rows: Array<Record<string, unknown>> = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const relativePath = relative(taktRoot, path);
      rows.push({
        path: relativePath,
        mode: stat.mode,
        size: stat.size,
        type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
        ...(stat.isFile()
          ? { sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
          : {}),
      });
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(taktRoot);
  return rows;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template target snapshot', () => {
  it('captures tracked and missing candidates without changing target or Git state', async () => {
    const root = makeRoot();
    writeTakt(root, 'config.yaml', 'language: ja\n');
    commitAll(root);
    const treeBefore = fingerprint(root);
    const gitBefore = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: root },
    );

    const snapshot = await captureProjectTemplateTargetSnapshot(root, [
      'missing.yaml',
      'config.yaml',
    ]);

    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        path: 'config.yaml',
        bytes: 13,
        mode: '0644',
        gitTrackingStatus: 'tracked-clean',
        sha256: hash('language: ja\n'),
      }),
    ]);
    expect(snapshot.rootState).toBe('directory');
    expect(snapshot.candidatePaths).toEqual(['config.yaml', 'missing.yaml']);
    expect(snapshot.missingPaths).toEqual(['missing.yaml']);
    expect(snapshot.missingPathTracking).toEqual({
      'missing.yaml': 'untracked',
    });
    expect(fingerprint(root)).toEqual(treeBefore);
    expect(execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: root },
    )).toEqual(gitBefore);
  });

  it('distinguishes modified, untracked, ignored, and non-repository files', async () => {
    const root = makeRoot();
    writeTakt(root, 'tracked.yaml', 'base\n');
    writeFileSync(join(root, '.gitignore'), '.takt/ignored.yaml\n');
    commitAll(root);
    writeTakt(root, 'tracked.yaml', 'changed\n');
    writeTakt(root, 'untracked.yaml', 'new\n');
    writeTakt(root, 'ignored.yaml', 'ignored\n');

    const gitSnapshot = await captureProjectTemplateTargetSnapshot(root, [
      'tracked.yaml',
      'untracked.yaml',
      'ignored.yaml',
    ]);
    const statuses = Object.fromEntries(
      gitSnapshot.entries.map((entry) => [entry.path, entry.gitTrackingStatus]),
    );

    expect(statuses).toEqual({
      'ignored.yaml': 'ignored',
      'tracked.yaml': 'tracked-modified',
      'untracked.yaml': 'untracked',
    });

    const localRoot = makeRoot(false);
    writeTakt(localRoot, 'config.yaml', 'local\n');
    const localSnapshot = await captureProjectTemplateTargetSnapshot(localRoot, ['config.yaml']);
    expect(localSnapshot.entries[0]?.gitTrackingStatus).toBe('not-repository');
  });

  it('marks Git execution failures unavailable instead of treating them as non-repository', async () => {
    const root = makeRoot();
    writeTakt(root, 'config.yaml', 'local\n');
    const originalPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const snapshot = await captureProjectTemplateTargetSnapshot(root, ['config.yaml']);
      expect(snapshot.entries[0]?.gitTrackingStatus).toBe('unavailable');
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
    }
  });

  it('rejects a symlink or hard-linked destination without exposing its path', async () => {
    const root = makeRoot(false);
    writeFileSync(join(root, 'outside'), 'secret');
    symlinkSync(join(root, 'outside'), join(root, '.takt', 'linked.yaml'));

    const symlinkError = await captureProjectTemplateTargetSnapshot(
      root,
      ['linked.yaml'],
    ).catch((caught: unknown) => caught);
    expect(symlinkError).toMatchObject({
      code: 'UNSAFE_ARCHIVE_ENTRY',
      field: 'target',
    });
    expect(String(symlinkError)).not.toContain(root);
    expect(String(symlinkError)).not.toContain('linked.yaml');

    rmSync(join(root, '.takt', 'linked.yaml'));
    linkSync(join(root, 'outside'), join(root, '.takt', 'linked.yaml'));
    await expect(captureProjectTemplateTargetSnapshot(
      root,
      ['linked.yaml'],
    )).rejects.toMatchObject({
      code: 'UNSAFE_ARCHIVE_ENTRY',
      field: 'target',
    });
  });

  it('preserves case-only candidates while capturing an actual destination once', async () => {
    const root = makeRoot(false);
    writeTakt(root, 'Config.yaml', 'local\n');

    const snapshot = await captureProjectTemplateTargetSnapshot(root, [
      'Config.yaml',
      'config.yaml',
    ]);

    expect(snapshot.candidatePaths).toEqual(['Config.yaml', 'config.yaml']);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.path).toBe('Config.yaml');
  });

  it('represents a missing .takt root as a stable onboarding snapshot', async () => {
    const root = makeRoot(false);
    rmSync(join(root, '.takt'), { recursive: true });

    const snapshot = await captureProjectTemplateTargetSnapshot(root, [
      'config.yaml',
      'workflows/default.yaml',
    ]);

    expect(snapshot).toEqual({
      rootState: 'missing',
      candidatePaths: ['config.yaml', 'workflows/default.yaml'],
      missingPaths: ['config.yaml', 'workflows/default.yaml'],
      missingPathTracking: {
        'config.yaml': 'not-repository',
        'workflows/default.yaml': 'not-repository',
      },
      entries: [],
    });
  });

  it('rejects a dangling .takt root symlink instead of treating it as missing', async () => {
    const root = makeRoot(false);
    rmSync(join(root, '.takt'), { recursive: true });
    symlinkSync(join(root, 'does-not-exist'), join(root, '.takt'));

    await expect(captureProjectTemplateTargetSnapshot(
      root,
      ['config.yaml'],
    )).rejects.toMatchObject({
      code: 'UNSAFE_ARCHIVE_ENTRY',
      field: 'target',
    });
  });

  it('rejects a case-only .takt root sibling', async () => {
    const root = makeRoot(false);
    rmSync(join(root, '.takt'), { recursive: true });
    mkdirSync(join(root, '.TAKT'));

    await expect(captureProjectTemplateTargetSnapshot(
      root,
      ['config.yaml'],
    )).rejects.toMatchObject({
      code: 'UNSAFE_ARCHIVE_ENTRY',
      field: 'target',
    });
  });

  it('rejects case-only ancestor directory collisions', async () => {
    const root = makeRoot(false);
    writeTakt(root, 'Workflows/local.yaml', 'local\n');

    await expect(captureProjectTemplateTargetSnapshot(
      root,
      ['workflows/new.yaml'],
    )).rejects.toMatchObject({
      code: 'UNSAFE_ARCHIVE_ENTRY',
      field: 'target',
    });
  });

  it('captures unstaged and staged tracked deletions for missing candidates', async () => {
    const root = makeRoot();
    writeTakt(root, 'config.yaml', 'base\n');
    commitAll(root);
    rmSync(join(root, '.takt', 'config.yaml'));

    const unstaged = await captureProjectTemplateTargetSnapshot(root, ['config.yaml']);
    expect(unstaged.missingPathTracking).toEqual({
      'config.yaml': 'tracked-modified',
    });

    execFileSync('git', ['add', '-A'], { cwd: root });
    const staged = await captureProjectTemplateTargetSnapshot(root, ['config.yaml']);
    expect(staged.missingPathTracking).toEqual({
      'config.yaml': 'staged',
    });
  });
});

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
