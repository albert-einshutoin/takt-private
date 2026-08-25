import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicReplace } from '../features/repertoire/atomic-update.js';

describe('repertoire atomic install contract', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('publishes only inside an exclusively reserved final directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-atomic-contract-'));
    roots.push(root);
    const packageDir = join(root, 'repertoire', '@owner', 'repo');
    await atomicReplace({
      globalConfigDir: root,
      packageDir,
      install: async (reserved) => writeFileSync(join(reserved, 'workflow.yaml'), 'complete'),
    });
    expect(existsSync(join(packageDir, 'workflow.yaml'))).toBe(true);
    expect(existsSync(`${packageDir}.tmp`)).toBe(false);
    expect(existsSync(`${packageDir}.bak`)).toBe(false);
  });

  it('normalizes mutation failures without exposing their cause', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-atomic-contract-'));
    roots.push(root);
    const packageDir = join(root, 'repertoire', '@owner', 'repo');
    let caught: unknown;
    try {
      await atomicReplace({
        globalConfigDir: root,
        packageDir,
        install: async () => { throw new Error('/secret/path token=abc'); },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'RECOVERY_REQUIRED',
      message: 'Repertoire package recovery is required',
    });
    expect(caught).not.toHaveProperty('cause');
  });
});
