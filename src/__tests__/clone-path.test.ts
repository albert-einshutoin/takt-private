import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createPrSyncWorktreePath,
  createTaskClonePath,
  createTempClonePath,
} from '../infra/task/clone-path.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'takt-clone-path-test-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('clone path allocation', () => {
  it('creates distinct task paths even when timestamps and slugs match', () => {
    const first = createTaskClonePath(baseDir, '20260727T1200', 42, 'fix-review');
    const second = createTaskClonePath(baseDir, '20260727T1200', 42, 'fix-review');

    expect(first).not.toBe(second);
    expect(path.basename(first)).toMatch(/^20260727T1200-42-fix-review-[A-Za-z0-9]{6}$/);
    expect(path.basename(second)).toMatch(/^20260727T1200-42-fix-review-[A-Za-z0-9]{6}$/);
  });

  it.each([
    ['whitespace', 'fix review comments', 'fix-review-comments'],
    ['path traversal', '../../../escape', 'escape'],
    ['dot segments', '..', '20260727T1200'],
  ])('keeps %s slugs inside the clone base directory', (_description, taskSlug, expectedStem) => {
    const clonePath = createTaskClonePath(baseDir, '20260727T1200', undefined, taskSlug);

    expect(path.relative(baseDir, clonePath)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(path.basename(clonePath)).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(path.basename(clonePath)).toContain(expectedStem);
  });

  it('creates distinct temporary and PR-sync paths in the same clock tick', () => {
    const firstTemp = createTempClonePath(baseDir, '20260727T1200');
    const secondTemp = createTempClonePath(baseDir, '20260727T1200');
    const firstPrSync = createPrSyncWorktreePath(baseDir, 1_753_593_600_000);
    const secondPrSync = createPrSyncWorktreePath(baseDir, 1_753_593_600_000);

    expect(firstTemp).not.toBe(secondTemp);
    expect(firstPrSync).not.toBe(secondPrSync);
    expect(path.basename(firstTemp)).toMatch(/^tmp-20260727T1200-[A-Za-z0-9]{6}$/);
    expect(path.basename(firstPrSync)).toMatch(/^pr-sync-1753593600000-[a-f0-9]{16}$/);
  });
});
