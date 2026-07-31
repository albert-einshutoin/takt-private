import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicReplace } from '../../features/repertoire/atomic-update.js';

describe('atomicReplace durable publication', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('reserves the final path and writes the completion witness last', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-atomic-'));
    roots.push(root);
    const packageDir = join(root, 'repertoire', '@owner', 'repo');

    await atomicReplace({
      globalConfigDir: root,
      packageDir,
      install: async (reserved) => {
        expect(reserved).toBe(packageDir);
        writeFileSync(join(reserved, 'new.yaml'), 'new');
      },
    });

    expect(existsSync(join(packageDir, 'new.yaml'))).toBe(true);
    expect(existsSync(join(packageDir, '.takt-install-complete'))).toBe(true);
  });

  it('retains the old package and a failed partial without restoring either', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-atomic-'));
    roots.push(root);
    const packageDir = join(root, 'repertoire', '@owner', 'repo');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'old.yaml'), 'old');

    await expect(atomicReplace({
      globalConfigDir: root,
      packageDir,
      install: async (reserved) => {
        writeFileSync(join(reserved, 'partial.yaml'), 'partial');
        throw new Error('private validation detail');
      },
    })).rejects.toEqual(expect.objectContaining({
      code: 'RECOVERY_REQUIRED',
      message: 'Repertoire package recovery is required',
    }));

    expect(existsSync(packageDir)).toBe(false);
    const transactionsRoot = join(root, '.repertoire-maintenance', 'transactions');
    const transactions = readdirSync(transactionsRoot);
    expect(transactions).toHaveLength(2);
    expect(transactions.some((entry) => existsSync(join(transactionsRoot, entry, 'payload', 'old.yaml')))).toBe(true);
    expect(transactions.some((entry) => existsSync(join(transactionsRoot, entry, 'partial', 'partial.yaml')))).toBe(true);
  });
});
