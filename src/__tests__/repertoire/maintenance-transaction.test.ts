import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDirectoryTreeProof } from '../../features/repertoire/filesystem-proof.js';
import {
  assertMaintenanceTransactionsReady,
  classifyMaintenanceTransactions,
  detachToMaintenance,
  type MaintenanceFilesystemOperation,
} from '../../features/repertoire/maintenance-transaction.js';

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
    expect(classifyMaintenanceTransactions(root)).toEqual({
      complete: [transaction],
      incomplete: [],
    });
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
    expect(() => assertMaintenanceTransactionsReady(root))
      .toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
  });

  it('classifies a restart after durable intent but before rename as incomplete', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-maintenance-'));
    roots.push(root);
    const transaction = join(root, '.repertoire-maintenance', 'transactions', 'a'.repeat(64));
    mkdirSync(transaction, { recursive: true });
    writeFileSync(join(transaction, 'intent.json'), JSON.stringify({ version: 1 }));
    expect(classifyMaintenanceTransactions(root).incomplete).toEqual([transaction]);
    expect(() => assertMaintenanceTransactionsReady(root)).toThrow();
  });

  it.each([
    'transaction-created',
    'intent-written',
    'intent-durable',
    'before-rename',
    'after-rename',
    'rename-durable',
    'proof-complete',
    'outcome-written',
    'outcome-durable',
  ] as const)('classifies a deterministic crash at %s as recovery-required', (phase) => {
    const root = mkdtempSync(join(tmpdir(), 'takt-maintenance-fault-'));
    roots.push(root);
    const packageDir = join(root, 'repertoire', '@owner', 'repo');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'workflow.yaml'), 'name: retained');
    const expected = captureDirectoryTreeProof(packageDir, root);
    expect(() => detachToMaintenance({
      globalConfigDir: root,
      sourceDir: packageDir,
      containmentRoot: root,
      expected,
      kind: 'payload',
      onPhase: (current) => {
        if (current === phase) throw new Error('simulated crash');
      },
    })).toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    const classification = classifyMaintenanceTransactions(root);
    expect(classification.incomplete).toHaveLength(1);
    expect(() => assertMaintenanceTransactionsReady(root)).toThrow();
  });

  it('reclassifies a completed transaction when foreign payload bytes appear', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-maintenance-foreign-'));
    roots.push(root);
    const packageDir = join(root, 'repertoire', '@owner', 'repo');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'workflow.yaml'), 'name: retained');
    const transaction = detachToMaintenance({
      globalConfigDir: root,
      sourceDir: packageDir,
      containmentRoot: root,
      expected: captureDirectoryTreeProof(packageDir, root),
      kind: 'payload',
    });
    writeFileSync(join(transaction, 'payload', 'foreign.yaml'), 'foreign');
    expect(classifyMaintenanceTransactions(root)).toEqual({
      complete: [],
      incomplete: [transaction],
    });
  });

  it.each([
    'intent-write',
    'intent-file-fsync',
    'intent-parent-fsync',
    'rename',
    'source-parent-fsync',
    'destination-parent-fsync',
    'payload-proof',
    'outcome-write',
    'outcome-file-fsync',
    'complete-write',
    'complete-file-fsync',
  ] satisfies MaintenanceFilesystemOperation[])(
    'normalizes direct %s failure and leaves restart-visible evidence',
    (operation) => {
      const root = mkdtempSync(join(tmpdir(), 'takt-maintenance-fs-fault-'));
      roots.push(root);
      const packageDir = join(root, 'repertoire', '@owner', 'repo');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'workflow.yaml'), 'name: retained');
      let caught: unknown;
      try {
        detachToMaintenance({
          globalConfigDir: root,
          sourceDir: packageDir,
          containmentRoot: root,
          expected: captureDirectoryTreeProof(packageDir, root),
          kind: 'payload',
          beforeFilesystemOperation: (current) => {
            if (current === operation) {
              throw Object.assign(new Error('/secret/path token=abc'), { code: 'EIO' });
            }
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: 'RECOVERY_REQUIRED',
        message: 'Repertoire package recovery is required',
      });
      expect(caught).not.toHaveProperty('cause');
      expect(classifyMaintenanceTransactions(root).incomplete).toHaveLength(1);
      const transactionsRoot = join(root, '.repertoire-maintenance', 'transactions');
      const transaction = readdirSync(transactionsRoot)[0]!;
      expect(
        existsSync(join(packageDir, 'workflow.yaml'))
        || existsSync(join(transactionsRoot, transaction, 'payload', 'workflow.yaml')),
      ).toBe(true);
    },
  );
});
