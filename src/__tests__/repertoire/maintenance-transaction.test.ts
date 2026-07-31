import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDirectoryTreeProof } from '../../features/repertoire/filesystem-proof.js';
import { detachToMaintenance } from '../../features/repertoire/maintenance-transaction.js';

describe('detachToMaintenance', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('detaches an approved package and retains it behind a completion witness', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-maintenance-'));
    roots.push(root);
    const packageDir = join(root, 'repertoire', '@owner', 'repo');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'workflow.yaml'), 'name: retained');
    const expected = captureDirectoryTreeProof(packageDir, root);

    const transaction = detachToMaintenance({
      globalConfigDir: root,
      sourceDir: packageDir,
      containmentRoot: root,
      expected,
      kind: 'payload',
    });

    expect(existsSync(packageDir)).toBe(false);
    expect(existsSync(join(transaction, 'payload', 'workflow.yaml'))).toBe(true);
    expect(existsSync(join(transaction, 'complete'))).toBe(true);
  });

  it('does not detach when the tree differs from the authorization proof', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-maintenance-'));
    roots.push(root);
    const packageDir = join(root, 'repertoire', '@owner', 'repo');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'workflow.yaml'), 'name: before');
    const expected = captureDirectoryTreeProof(packageDir, root);
    writeFileSync(join(packageDir, 'foreign.yaml'), 'foreign');

    expect(() => detachToMaintenance({
      globalConfigDir: root,
      sourceDir: packageDir,
      containmentRoot: root,
      expected,
      kind: 'payload',
    })).toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));

    expect(existsSync(join(packageDir, 'foreign.yaml'))).toBe(true);
    const transactions = join(root, '.repertoire-maintenance', 'transactions');
    expect(readdirSync(transactions)).toHaveLength(1);
  });
});
