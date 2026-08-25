import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readStableWorkflowResourceText,
} from '../infra/config/loaders/workflowResourceSafeReader.js';

describe('workflow resource safe reader', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-resource-safe-reader-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a regular private resource', () => {
    const path = join(root, 'resource.md');
    writeFileSync(path, 'approved');
    expect(readStableWorkflowResourceText(path, root)).toBe('approved');
  });

  it.each(['symlink', 'hardlink'] as const)('rejects a %s resource', (kind) => {
    const source = join(root, 'source.md');
    const path = join(root, 'resource.md');
    writeFileSync(source, 'aliased');
    if (kind === 'symlink') symlinkSync(source, path);
    else linkSync(source, path);
    expect(() => readStableWorkflowResourceText(path, root)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_RESOURCE_READ_FAILED' }),
    );
  });

  it('rejects replacement after opening the approved descriptor', () => {
    const path = join(root, 'resource.md');
    const original = join(root, 'original.md');
    writeFileSync(path, 'approved');
    expect(() => readStableWorkflowResourceText(path, root, {
      afterOpen: () => {
        renameSync(path, original);
        writeFileSync(path, 'replacement');
      },
    })).toThrow(expect.objectContaining({ code: 'WORKFLOW_RESOURCE_READ_FAILED' }));
  });

  it('rejects a symlinked immediate parent directory', () => {
    const actualDir = join(root, 'actual');
    const aliasDir = join(root, 'alias');
    mkdirSync(actualDir);
    writeFileSync(join(actualDir, 'resource.md'), 'aliased');
    symlinkSync(actualDir, aliasDir, 'dir');
    expect(() => readStableWorkflowResourceText(join(aliasDir, 'resource.md'), aliasDir)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_RESOURCE_READ_FAILED' }),
    );
  });

  it('reads a regular resource through a deep trusted tree', () => {
    const deepDir = join(root, 'one', 'two');
    const path = join(deepDir, 'resource.md');
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(path, 'deep');
    expect(readStableWorkflowResourceText(path, root)).toBe('deep');
  });

  it('rejects a nested directory alias below the trusted base', () => {
    const actualDir = join(root, 'actual');
    const aliasDir = join(root, 'nested-alias');
    mkdirSync(actualDir);
    writeFileSync(join(actualDir, 'resource.md'), 'aliased');
    symlinkSync(actualDir, aliasDir, 'dir');
    expect(() => readStableWorkflowResourceText(join(aliasDir, 'resource.md'), root)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_RESOURCE_READ_FAILED' }),
    );
  });
});
