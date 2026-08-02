import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('.github/scripts/resolve-conflicts-contract.mjs');
const temporaryRepositories = new Set<string>();

afterEach(() => {
  for (const repo of temporaryRepositories) rmSync(repo, { recursive: true, force: true });
  temporaryRepositories.clear();
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function makeConflict(): string {
  const repo = mkdtempSync(join(tmpdir(), 'takt-resolve-contract-'));
  temporaryRepositories.add(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'merge.conflictStyle', 'diff3');
  writeFileSync(join(repo, 'note.txt'), 'before\nbase\nafter\n');
  git(repo, 'add', 'note.txt');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'theirs');
  writeFileSync(join(repo, 'note.txt'), 'before\ntheirs\nafter\n');
  git(repo, 'commit', '-qam', 'theirs');
  git(repo, 'checkout', '-q', '-');
  writeFileSync(join(repo, 'note.txt'), 'before\nours\nafter\n');
  git(repo, 'commit', '-qam', 'ours');
  const merge = spawnSync('git', ['merge', '--no-edit', 'theirs'], { cwd: repo, encoding: 'utf8' });
  expect(merge.status).not.toBe(0);
  return repo;
}

function run(repo: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' });
}

describe('resolve-conflicts contract', () => {
  it('prepares a deterministic bounded diff3 conflict contract and applies exact replacements', () => {
    const repo = makeConflict();
    const inputPath = join(repo, 'input.json');
    expect(run(repo, 'prepare', repo, inputPath).status).toBe(0);
    const firstBytes = readFileSync(inputPath);
    const input = JSON.parse(firstBytes.toString('utf8'));

    expect(input).toMatchObject({ schema_version: 1 });
    expect(input.input_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(input.conflicts).toHaveLength(1);
    expect(input.conflicts[0]).toMatchObject({
      path: 'note.txt',
      ours: 'ours\n',
      base: 'base\n',
      theirs: 'theirs\n',
      context_before: ['before'],
      context_after: ['after'],
    });
    expect(input.conflicts[0].conflict_id).toMatch(/^[a-f0-9]{64}$/);
    expect(input.conflicts[0].preimage_sha256).toMatch(/^[a-f0-9]{64}$/);

    expect(run(repo, 'prepare', repo, inputPath).status).toBe(0);
    expect(readFileSync(inputPath)).toEqual(firstBytes);

    const proposalPath = join(repo, 'proposal.json');
    writeFileSync(proposalPath, `${JSON.stringify({
      schema_version: 1,
      input_digest: input.input_digest,
      resolutions: [{ conflict_id: input.conflicts[0].conflict_id, replacement: 'resolved\n' }],
    })}\n`);
    expect(run(repo, 'apply', repo, inputPath, proposalPath).status).toBe(0);
    expect(readFileSync(join(repo, 'note.txt'), 'utf8')).toBe('before\nresolved\nafter\n');
  });

  it('rejects malformed markers, binary or invalid UTF-8 files, and symlink worktree targets', () => {
    const malformed = makeConflict();
    writeFileSync(join(malformed, 'note.txt'), '<<<<<<< HEAD\nours\n=======\ntheirs\n');
    expect(run(malformed, 'prepare', malformed, join(malformed, 'input.json')).status).not.toBe(0);

    const binary = makeConflict();
    writeFileSync(join(binary, 'note.txt'), Buffer.from('<<<<<<< HEAD\na\0b\n'));
    expect(run(binary, 'prepare', binary, join(binary, 'input.json')).status).not.toBe(0);

    const invalidUtf8 = makeConflict();
    writeFileSync(join(invalidUtf8, 'note.txt'), Buffer.from([0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x20, 0xff]));
    expect(run(invalidUtf8, 'prepare', invalidUtf8, join(invalidUtf8, 'input.json')).status).not.toBe(0);

    const linked = makeConflict();
    writeFileSync(join(linked, 'outside.txt'), readFileSync(join(linked, 'note.txt')));
    unlinkSync(join(linked, 'note.txt'));
    symlinkSync('outside.txt', join(linked, 'note.txt'));
    expect(run(linked, 'prepare', linked, join(linked, 'input.json')).status).not.toBe(0);
  });

  it('rejects an extra marker after a valid conflict block', () => {
    const repo = makeConflict();
    writeFileSync(join(repo, 'note.txt'), `${readFileSync(join(repo, 'note.txt'), 'utf8')}<<<<<<< stray\n`);
    expect(run(repo, 'prepare', repo, join(repo, 'input.json')).status).not.toBe(0);
    expect(readFileSync(script, 'utf8')).toContain(
      "MARKER_LINE_PATTERN.lastIndex = 0;\n  const allMarkers = [...text.matchAll(MARKER_LINE_PATTERN)]",
    );
  });

  it('rejects more than twenty conflict blocks across the contract', () => {
    const repo = makeConflict();
    const blocks = Array.from({ length: 21 }, (_, index) => [
      '<<<<<<< HEAD',
      `ours-${index}`,
      '||||||| base',
      `base-${index}`,
      '=======',
      `theirs-${index}`,
      '>>>>>>> theirs',
      '',
    ].join('\n')).join('');
    writeFileSync(join(repo, 'note.txt'), blocks);

    expect(run(repo, 'prepare', repo, join(repo, 'input.json')).status).not.toBe(0);
  });

  it('bounds the serialized contract after JSON escaping', () => {
    const repo = makeConflict();
    writeFileSync(join(repo, 'note.txt'), [
      '<<<<<<< HEAD',
      '\u0001'.repeat(400 * 1024),
      '||||||| base',
      'base',
      '=======',
      'theirs',
      '>>>>>>> theirs',
      '',
    ].join('\n'));

    expect(run(repo, 'prepare', repo, join(repo, 'input.json')).status).not.toBe(0);
  });

  it('rejects stale preimages, digest mismatch, extra keys, and incomplete or duplicate IDs', () => {
    const cases = [
      (input: any) => ({ schema_version: 1, input_digest: '0'.repeat(64), resolutions: [{ conflict_id: input.conflicts[0].conflict_id, replacement: 'ok\n' }] }),
      (input: any) => ({ schema_version: 1, input_digest: input.input_digest, resolutions: [{ conflict_id: input.conflicts[0].conflict_id, replacement: 'ok\n', extra: true }] }),
      (input: any) => ({ schema_version: 1, input_digest: input.input_digest, resolutions: [] }),
      (input: any) => ({ schema_version: 1, input_digest: input.input_digest, resolutions: [
        { conflict_id: input.conflicts[0].conflict_id, replacement: 'one\n' },
        { conflict_id: input.conflicts[0].conflict_id, replacement: 'two\n' },
      ] }),
    ];
    for (const proposal of cases) {
      const repo = makeConflict();
      const inputPath = join(repo, 'input.json');
      const proposalPath = join(repo, 'proposal.json');
      expect(run(repo, 'prepare', repo, inputPath).status).toBe(0);
      const input = JSON.parse(readFileSync(inputPath, 'utf8'));
      writeFileSync(proposalPath, JSON.stringify(proposal(input)));
      expect(run(repo, 'apply', repo, inputPath, proposalPath).status).not.toBe(0);
    }

    const stale = makeConflict();
    const inputPath = join(stale, 'input.json');
    const proposalPath = join(stale, 'proposal.json');
    expect(run(stale, 'prepare', stale, inputPath).status).toBe(0);
    const input = JSON.parse(readFileSync(inputPath, 'utf8'));
    writeFileSync(join(stale, 'note.txt'), readFileSync(join(stale, 'note.txt'), 'utf8').replace('ours', 'changed'));
    writeFileSync(proposalPath, JSON.stringify({ schema_version: 1, input_digest: input.input_digest, resolutions: [
      { conflict_id: input.conflicts[0].conflict_id, replacement: 'ok\n' },
    ] }));
    expect(run(stale, 'apply', stale, inputPath, proposalPath).status).not.toBe(0);
  });

  it('rejects path escape, invalid UTF-8/NUL replacement, and oversized replacements', () => {
    const repo = makeConflict();
    const inputPath = join(repo, 'input.json');
    const proposalPath = join(repo, 'proposal.json');
    expect(run(repo, 'prepare', repo, inputPath).status).toBe(0);
    const input = JSON.parse(readFileSync(inputPath, 'utf8'));

    input.conflicts[0].path = '../escape';
    writeFileSync(inputPath, JSON.stringify(input));
    writeFileSync(proposalPath, JSON.stringify({ schema_version: 1, input_digest: input.input_digest, resolutions: [] }));
    expect(run(repo, 'apply', repo, inputPath, proposalPath).status).not.toBe(0);

    const cleanRepo = makeConflict();
    const cleanInputPath = join(cleanRepo, 'input.json');
    expect(run(cleanRepo, 'prepare', cleanRepo, cleanInputPath).status).toBe(0);
    const clean = JSON.parse(readFileSync(cleanInputPath, 'utf8'));
    for (const replacement of ['bad\0value', '<<<<<<< injected\n', 'x'.repeat(512 * 1024 + 1)]) {
      writeFileSync(proposalPath, JSON.stringify({ schema_version: 1, input_digest: clean.input_digest, resolutions: [
        { conflict_id: clean.conflicts[0].conflict_id, replacement },
      ] }));
      expect(run(cleanRepo, 'apply', cleanRepo, cleanInputPath, proposalPath).status).not.toBe(0);
    }
  });

  it('fails closed when there are no unresolved files or a conflicted path is outside limits', () => {
    const empty = mkdtempSync(join(tmpdir(), 'takt-resolve-empty-'));
    temporaryRepositories.add(empty);
    git(empty, 'init', '-q');
    expect(run(empty, 'prepare', empty, join(empty, 'input.json')).status).not.toBe(0);

    const oversized = makeConflict();
    writeFileSync(join(oversized, 'note.txt'), `<<<<<<< HEAD\n${'a'.repeat(512 * 1024)}\n||||||| base\nb\n=======\nc\n>>>>>>> theirs\n`);
    expect(run(oversized, 'prepare', oversized, join(oversized, 'input.json')).status).not.toBe(0);
  });

  it('validates every file preimage before changing any file', () => {
    const repo = makeConflict();
    writeFileSync(join(repo, 'second.txt'), readFileSync(join(repo, 'note.txt')));
    git(repo, 'add', 'second.txt');
    // Reuse the three index stages so the second path is a genuine unresolved
    // entry while keeping this regression fixture small and deterministic.
    for (const stage of ['1', '2', '3']) {
      const source = git(repo, 'rev-parse', `:${stage}:note.txt`);
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: repo,
        input: `100644 ${source} ${stage}\tsecond.txt\n`,
      });
    }
    const inputPath = join(repo, 'input.json');
    const proposalPath = join(repo, 'proposal.json');
    expect(run(repo, 'prepare', repo, inputPath).status).toBe(0);
    const input = JSON.parse(readFileSync(inputPath, 'utf8'));
    writeFileSync(proposalPath, JSON.stringify({
      schema_version: 1,
      input_digest: input.input_digest,
      resolutions: input.conflicts.map((conflict: { conflict_id: string }) => ({
        conflict_id: conflict.conflict_id,
        replacement: 'resolved\n',
      })),
    }));
    const firstBefore = readFileSync(join(repo, 'note.txt'));
    writeFileSync(join(repo, 'second.txt'), readFileSync(join(repo, 'second.txt'), 'utf8').replace('theirs', 'stale'));

    expect(run(repo, 'apply', repo, inputPath, proposalPath).status).not.toBe(0);
    expect(readFileSync(join(repo, 'note.txt'))).toEqual(firstBefore);
  });
});
