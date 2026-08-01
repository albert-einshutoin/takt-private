import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureDirectoryTreeProof,
  captureRegularFileProof,
  PROOF_MAX_DEPTH,
  PROOF_MAX_SINGLE_FILE_BYTES,
  sameFileProof,
  sameTreeProof,
} from '../../features/repertoire/filesystem-proof.js';

describe('repertoire filesystem proofs', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-filesystem-proof-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('binds a source proof to identity, mode, link count, realpath, and bytes', () => {
    const path = join(root, 'source.yaml');
    writeFileSync(path, 'before');
    const before = captureRegularFileProof(path, root);
    writeFileSync(path, 'after!');
    const after = captureRegularFileProof(path, root);

    expect(sameFileProof(before, after)).toBe(false);
    expect(before).toMatchObject({
      nlink: 1,
      mode: expect.any(Number),
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('rejects a hardlinked source rather than authorizing mutable aliasing', () => {
    const path = join(root, 'source.yaml');
    writeFileSync(path, 'content');
    linkSync(path, join(root, 'alias.yaml'));

    expect(() => captureRegularFileProof(path, root))
      .toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
  });

  it('changes a full-tree fingerprint for non-lock content and foreign additions', () => {
    const packageDir = join(root, 'package');
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, 'lock.yaml'), 'lock');
    writeFileSync(join(packageDir, 'content.md'), 'before');
    const before = captureDirectoryTreeProof(packageDir, root);
    writeFileSync(join(packageDir, 'content.md'), 'after!');
    const contentChanged = captureDirectoryTreeProof(packageDir, root);
    writeFileSync(join(packageDir, 'foreign.md'), 'foreign');
    const foreignAdded = captureDirectoryTreeProof(packageDir, root);

    expect(sameTreeProof(before, contentChanged)).toBe(false);
    expect(sameTreeProof(contentChanged, foreignAdded)).toBe(false);
  });

  it('keeps proof authorization stable under hostile sort, join, and startsWith hooks', () => {
    const packageDir = join(root, 'package');
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, 'content.md'), 'content');
    const originalSort = Array.prototype.sort;
    const originalJoin = Array.prototype.join;
    const originalStartsWith = String.prototype.startsWith;
    let proof: ReturnType<typeof captureDirectoryTreeProof>;
    try {
      Array.prototype.sort = function poisonedSort() { return this; };
      Array.prototype.join = () => 'poison';
      String.prototype.startsWith = () => true;
      proof = captureDirectoryTreeProof(packageDir, root);
    } finally {
      Array.prototype.sort = originalSort;
      Array.prototype.join = originalJoin;
      String.prototype.startsWith = originalStartsWith;
    }
    expect(proof!).toMatchObject({ contentFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('rejects a foreign addition injected between directory listings', () => {
    const packageDir = join(root, 'package');
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, 'content.md'), 'content');
    let injected = false;

    expect(() => captureDirectoryTreeProof(packageDir, root, {
      afterDirectoryRead: (directory) => {
        if (!injected && directory === packageDir) {
          injected = true;
          writeFileSync(join(packageDir, 'foreign.md'), 'foreign');
        }
      },
    })).toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    expect(injected).toBe(true);
  });

  it('fails closed at the depth and single-file byte budgets', () => {
    const packageDir = join(root, 'package');
    let deep = packageDir;
    mkdirSync(deep);
    for (let index = 0; index <= PROOF_MAX_DEPTH; index += 1) {
      deep = join(deep, `d${index}`);
      mkdirSync(deep);
    }
    expect(() => captureDirectoryTreeProof(packageDir, root))
      .toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));

    const large = join(root, 'large.md');
    writeFileSync(large, Buffer.alloc(PROOF_MAX_SINGLE_FILE_BYTES + 1));
    expect(() => captureRegularFileProof(large, root))
      .toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
  });
});
