import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({
  target: '',
  backup: '',
  triggered: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      const textPath = String(path);
      if (!fault.triggered && fault.target !== '' && textPath === fault.target) {
        fault.triggered = true;
        renameSync(fault.target, fault.backup);
        renameSync(fault.backup, fault.target);
        throw Object.assign(new Error('synthetic swap fault'), { code: 'ENOENT' });
      }
      return actual.lstat(path);
    },
  };
});

const { scanProjectTemplateDirectory } = await import(
  '../../features/project-template/filesystem-scan.js'
);

const roots: string[] = [];

afterEach(() => {
  fault.target = '';
  fault.backup = '';
  fault.triggered = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template filesystem scan faults', () => {
  it('should not disclose a name that fails validation after a swap and restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-classifier-fault-'));
    roots.push(root);
    fault.target = join(root, '.takt/workflows/external-private-filename.yaml');
    fault.backup = `${fault.target}.swapped`;
    mkdirSync(dirname(fault.target), { recursive: true });
    writeFileSync(fault.target, 'name: safe');

    const result = await scanProjectTemplateDirectory(root);
    const serialized = JSON.stringify(result);

    expect(fault.triggered).toBe(true);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: '[unverified-entry]',
        reasonCode: 'READ_FAILED',
      }),
    ]));
    expect(serialized).not.toContain('external-private-filename');
  });
});
