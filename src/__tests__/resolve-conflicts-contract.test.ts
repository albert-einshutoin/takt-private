import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

function makeAddAddConflict(): string {
  const repo = mkdtempSync(join(tmpdir(), 'takt-resolve-add-add-'));
  temporaryRepositories.add(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'merge.conflictStyle', 'diff3');
  writeFileSync(join(repo, '.keep'), 'base\n');
  git(repo, 'add', '.keep');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'theirs');
  writeFileSync(join(repo, 'added.txt'), 'theirs\n');
  git(repo, 'add', 'added.txt');
  git(repo, 'commit', '-qm', 'theirs adds');
  git(repo, 'checkout', '-q', '-');
  writeFileSync(join(repo, 'added.txt'), 'ours\n');
  git(repo, 'add', 'added.txt');
  git(repo, 'commit', '-qm', 'ours adds');
  expect(spawnSync('git', ['merge', '--no-edit', 'theirs'], { cwd: repo }).status).not.toBe(0);
  return repo;
}

function makeModifyDeleteConflict(): string {
  const repo = mkdtempSync(join(tmpdir(), 'takt-resolve-modify-delete-'));
  temporaryRepositories.add(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'target.txt'), 'base\n');
  git(repo, 'add', 'target.txt');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'theirs');
  git(repo, 'rm', '-q', 'target.txt');
  git(repo, 'commit', '-qm', 'theirs deletes');
  git(repo, 'checkout', '-q', '-');
  writeFileSync(join(repo, 'target.txt'), 'ours modified\n');
  git(repo, 'commit', '-qam', 'ours modifies');
  expect(spawnSync('git', ['merge', '--no-edit', 'theirs'], { cwd: repo }).status).not.toBe(0);
  return repo;
}

function makeDeleteModifyConflict(): string {
  const repo = mkdtempSync(join(tmpdir(), 'takt-resolve-delete-modify-'));
  temporaryRepositories.add(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'target.txt'), 'base\n');
  git(repo, 'add', 'target.txt');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'theirs');
  writeFileSync(join(repo, 'target.txt'), 'theirs modified\n');
  git(repo, 'commit', '-qam', 'theirs modifies');
  git(repo, 'checkout', '-q', '-');
  git(repo, 'rm', '-q', 'target.txt');
  git(repo, 'commit', '-qm', 'ours deletes');
  expect(spawnSync('git', ['merge', '--no-edit', 'theirs'], { cwd: repo }).status).not.toBe(0);
  return repo;
}

function run(repo: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' });
}

function runWithEnv(repo: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('resolve-conflicts contract', () => {
  it('supports typed add/add and modify/delete contracts', () => {
    const addAdd = makeAddAddConflict();
    const addInputPath = join(addAdd, 'input.json');
    expect(run(addAdd, 'prepare', addAdd, addInputPath).status).toBe(0);
    const addInput = JSON.parse(readFileSync(addInputPath, 'utf8'));
    expect(addInput.conflicts[0]).toMatchObject({
      kind: 'add-add',
      stages: [{ stage: 2 }, { stage: 3 }],
    });
    const addProposalPath = join(addAdd, 'proposal.json');
    writeFileSync(addProposalPath, JSON.stringify({
      schema_version: 1,
      input_digest: addInput.input_digest,
      resolutions: [{ conflict_id: addInput.conflicts[0].conflict_id, action: 'replace', replacement: 'added resolved\n' }],
    }));
    expect(run(addAdd, 'apply', addAdd, addInputPath, addProposalPath).status).toBe(0);
    expect(readFileSync(join(addAdd, 'added.txt'), 'utf8')).toBe('added resolved\n');

    const modifyDelete = makeModifyDeleteConflict();
    const mdInputPath = join(modifyDelete, 'input.json');
    expect(run(modifyDelete, 'prepare', modifyDelete, mdInputPath).status).toBe(0);
    const mdInput = JSON.parse(readFileSync(mdInputPath, 'utf8'));
    expect(mdInput.conflicts[0]).toMatchObject({
      kind: 'modify-delete',
      stages: [{ stage: 1 }, { stage: 2 }],
      ours: 'ours modified\n',
      theirs: '',
    });
    const mdProposalPath = join(modifyDelete, 'proposal.json');
    writeFileSync(mdProposalPath, JSON.stringify({
      schema_version: 1,
      input_digest: mdInput.input_digest,
      resolutions: [{ conflict_id: mdInput.conflicts[0].conflict_id, action: 'delete' }],
    }));
    expect(run(modifyDelete, 'apply', modifyDelete, mdInputPath, mdProposalPath).status).toBe(0);
    expect(existsSync(join(modifyDelete, 'target.txt'))).toBe(false);

    const deleteModify = makeDeleteModifyConflict();
    const dmInputPath = join(deleteModify, 'input.json');
    expect(run(deleteModify, 'prepare', deleteModify, dmInputPath).status).toBe(0);
    const dmInput = JSON.parse(readFileSync(dmInputPath, 'utf8'));
    expect(dmInput.conflicts[0]).toMatchObject({
      kind: 'modify-delete',
      stages: [{ stage: 1 }, { stage: 3 }],
      ours: '',
      theirs: 'theirs modified\n',
    });
    const dmProposalPath = join(deleteModify, 'proposal.json');
    writeFileSync(dmProposalPath, JSON.stringify({
      schema_version: 1,
      input_digest: dmInput.input_digest,
      resolutions: [{ conflict_id: dmInput.conflicts[0].conflict_id, action: 'replace', replacement: 'kept and resolved\n' }],
    }));
    expect(run(deleteModify, 'apply', deleteModify, dmInputPath, dmProposalPath).status).toBe(0);
    expect(readFileSync(join(deleteModify, 'target.txt'), 'utf8')).toBe('kept and resolved\n');
  });

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
      kind: 'content',
      path: 'note.txt',
      stages: [
        { stage: 1, mode: '100644', oid: expect.stringMatching(/^[a-f0-9]{40,64}$/) },
        { stage: 2, mode: '100644', oid: expect.stringMatching(/^[a-f0-9]{40,64}$/) },
        { stage: 3, mode: '100644', oid: expect.stringMatching(/^[a-f0-9]{40,64}$/) },
      ],
      worktree_mode: 0o644,
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
      resolutions: [{ conflict_id: input.conflicts[0].conflict_id, action: 'replace', replacement: 'resolved\n' }],
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

  it('rejects overlong marker-like lines in conflict input', () => {
    for (const marker of ['<<<<<<<< injected', '|||||||| injected', '========', '>>>>>>>> injected']) {
      const repo = makeConflict();
      writeFileSync(join(repo, 'note.txt'), `${readFileSync(join(repo, 'note.txt'), 'utf8')}${marker}\n`);
      expect(run(repo, 'prepare', repo, join(repo, 'input.json')).status).not.toBe(0);
    }
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
      (input: any) => ({ schema_version: 1, input_digest: '0'.repeat(64), resolutions: [{ conflict_id: input.conflicts[0].conflict_id, action: 'replace', replacement: 'ok\n' }] }),
      (input: any) => ({ schema_version: 1, input_digest: input.input_digest, resolutions: [{ conflict_id: input.conflicts[0].conflict_id, action: 'replace', replacement: 'ok\n', extra: true }] }),
      (input: any) => ({ schema_version: 1, input_digest: input.input_digest, resolutions: [] }),
      (input: any) => ({ schema_version: 1, input_digest: input.input_digest, resolutions: [
        { conflict_id: input.conflicts[0].conflict_id, action: 'replace', replacement: 'one\n' },
        { conflict_id: input.conflicts[0].conflict_id, action: 'replace', replacement: 'two\n' },
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
      { conflict_id: input.conflicts[0].conflict_id, action: 'replace', replacement: 'ok\n' },
    ] }));
    expect(run(stale, 'apply', stale, inputPath, proposalPath).status).not.toBe(0);
  });

  it('binds the worktree mode and rejects chmod changes after prepare', () => {
    const repo = makeConflict();
    const inputPath = join(repo, 'input.json');
    const proposalPath = join(repo, 'proposal.json');
    expect(run(repo, 'prepare', repo, inputPath).status).toBe(0);
    const input = JSON.parse(readFileSync(inputPath, 'utf8'));
    writeFileSync(proposalPath, JSON.stringify({
      schema_version: 1,
      input_digest: input.input_digest,
      resolutions: [{ conflict_id: input.conflicts[0].conflict_id, action: 'replace', replacement: 'resolved\n' }],
    }));
    chmodSync(join(repo, 'note.txt'), 0o600);

    expect(run(repo, 'apply', repo, inputPath, proposalPath).status).not.toBe(0);
    expect(readFileSync(join(repo, 'note.txt'), 'utf8')).toContain('<<<<<<< HEAD');
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
    for (const replacement of [
      'bad\0value',
      '<<<<<<< injected\n',
      '<<<<<<<< injected\n',
      '|||||||| injected\n',
      '========\n',
      '>>>>>>>> injected\n',
      'x'.repeat(512 * 1024 + 1),
    ]) {
      writeFileSync(proposalPath, JSON.stringify({ schema_version: 1, input_digest: clean.input_digest, resolutions: [
        { conflict_id: clean.conflicts[0].conflict_id, action: 'replace', replacement },
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

  it('rolls back the first file when a later mutation fails', () => {
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
        action: 'replace',
        replacement: 'resolved\n',
      })),
    }));
    const firstBefore = readFileSync(join(repo, 'note.txt'));
    const secondBefore = readFileSync(join(repo, 'second.txt'));

    expect(runWithEnv(repo, { NODE_ENV: 'test', TAKT_RESOLVE_TEST_FAIL_WRITE_AT: '2' },
      'apply', repo, inputPath, proposalPath).status).not.toBe(0);
    expect(readFileSync(join(repo, 'note.txt'))).toEqual(firstBefore);
    expect(readFileSync(join(repo, 'second.txt'))).toEqual(secondBefore);
  });

  it('rejects a parent symlink exchange, rolls back earlier files, and leaves outside bytes unchanged', async () => {
    const repo = makeConflict();
    mkdirSync(join(repo, 'zested'));
    writeFileSync(join(repo, 'zested', 'second.txt'), readFileSync(join(repo, 'note.txt')));
    for (const stage of ['1', '2', '3']) {
      const source = git(repo, 'rev-parse', `:${stage}:note.txt`);
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: repo,
        input: `100644 ${source} ${stage}\tzested/second.txt\n`,
      });
    }
    const outside = mkdtempSync(join(tmpdir(), 'takt-resolve-outside-'));
    temporaryRepositories.add(outside);
    const outsideTarget = join(outside, 'second.txt');
    writeFileSync(outsideTarget, 'outside sentinel\n');
    const inputPath = join(repo, 'input.json');
    const proposalPath = join(repo, 'proposal.json');
    expect(run(repo, 'prepare', repo, inputPath).status).toBe(0);
    const input = JSON.parse(readFileSync(inputPath, 'utf8'));
    writeFileSync(proposalPath, JSON.stringify({
      schema_version: 1,
      input_digest: input.input_digest,
      resolutions: input.conflicts.map((conflict: { conflict_id: string }) => ({
        conflict_id: conflict.conflict_id,
        action: 'replace',
        replacement: 'resolved\n',
      })),
    }));
    const firstBefore = readFileSync(join(repo, 'note.txt'));
    const signal = join(repo, 'mutation-ready');
    const release = join(repo, 'mutation-release');
    const child = spawn(process.execPath, [script, 'apply', repo, inputPath, proposalPath], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TAKT_RESOLVE_TEST_GATE_AT: '2',
        TAKT_RESOLVE_TEST_GATE_SIGNAL: signal,
        TAKT_RESOLVE_TEST_GATE_RELEASE: release,
      },
    });
    const deadline = Date.now() + 5_000;
    while (!existsSync(signal) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(existsSync(signal)).toBe(true);
    renameSync(join(repo, 'zested'), join(repo, 'zested.original'));
    symlinkSync(outside, join(repo, 'zested'));
    writeFileSync(release, 'continue\n');
    const status = await new Promise<number | null>((resolveExit) => child.once('close', resolveExit));

    expect(status).not.toBe(0);
    expect(readFileSync(join(repo, 'note.txt'))).toEqual(firstBefore);
    expect(readFileSync(outsideTarget, 'utf8')).toBe('outside sentinel\n');
  });
});
