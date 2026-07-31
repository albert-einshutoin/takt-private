import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

  it('keeps a completed transaction valid after recursive copy to another root', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'takt-maintenance-portable-a-'));
    const destinationRoot = mkdtempSync(join(tmpdir(), 'takt-maintenance-portable-b-'));
    roots.push(sourceRoot, destinationRoot);
    const packageDir = join(sourceRoot, 'repertoire', '@owner', 'repo');
    mkdirSync(join(packageDir, 'nested'), { recursive: true });
    writeFileSync(join(packageDir, 'nested', 'workflow.yaml'), 'name: portable');
    detachToMaintenance({
      globalConfigDir: sourceRoot,
      sourceDir: packageDir,
      containmentRoot: sourceRoot,
      expected: captureDirectoryTreeProof(packageDir, sourceRoot),
      kind: 'payload',
    });
    cpSync(
      join(sourceRoot, '.repertoire-maintenance'),
      join(destinationRoot, '.repertoire-maintenance'),
      { recursive: true },
    );

    const copied = classifyMaintenanceTransactions(destinationRoot);
    expect(copied.complete).toHaveLength(1);
    expect(copied.incomplete).toEqual([]);

    writeFileSync(join(copied.complete[0]!, 'payload', 'nested', 'workflow.yaml'), 'tampered');
    expect(classifyMaintenanceTransactions(destinationRoot).incomplete).toHaveLength(1);
  });

  it.each([
    ['transactions', { transactions: 0 }],
    ['entries', { entries: 0 }],
    ['bytes', { bytes: 0 }],
  ] as const)('applies aggregate %s preflight before opening any payload', (_label, limits) => {
    const root = mkdtempSync(join(tmpdir(), 'takt-maintenance-budget-'));
    roots.push(root);
    const packageDir = join(root, 'repertoire', '@owner', 'repo');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'workflow.yaml'), 'non-empty');
    detachToMaintenance({
      globalConfigDir: root,
      sourceDir: packageDir,
      containmentRoot: root,
      expected: captureDirectoryTreeProof(packageDir, root),
      kind: 'payload',
    });
    let payloadReads = 0;
    expect(() => classifyMaintenanceTransactions(root, {
      limits,
      onPayloadOpen: () => { payloadReads += 1; },
    })).toThrow(expect.objectContaining({
      code: 'MAINTENANCE_REQUIRED',
      message: 'Repertoire maintenance cleanup is required',
    }));
    expect(payloadReads).toBe(0);
  });

  it.each([
    ['maintenance-root-mkdir', 'empty'],
    ['maintenance-root-fsync', 'empty'],
    ['transactions-root-mkdir', 'empty'],
    ['transactions-root-fsync', 'empty'],
    ['transaction-mkdir', 'empty'],
    ['transaction-parent-fsync', 'incomplete'],
    ['intent-write', 'incomplete'],
    ['intent-file-fsync', 'incomplete'],
    ['intent-parent-fsync', 'incomplete'],
    ['rename', 'incomplete'],
    ['source-parent-fsync', 'incomplete'],
    ['destination-parent-fsync', 'incomplete'],
    ['payload-proof', 'incomplete'],
    ['outcome-write', 'incomplete'],
    ['outcome-file-fsync', 'incomplete'],
    ['complete-write', 'incomplete'],
    ['complete-file-fsync', 'incomplete'],
    ['complete-pending-rename', 'incomplete'],
    ['complete-parent-fsync', 'complete'],
  ] satisfies Array<[MaintenanceFilesystemOperation, 'empty' | 'incomplete' | 'complete']>)(
    'normalizes direct %s failure and leaves restart-visible evidence',
    (operation, expectedState) => {
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
      const classification = classifyMaintenanceTransactions(root);
      expect(classification[expectedState === 'complete' ? 'complete' : 'incomplete'])
        .toHaveLength(expectedState === 'empty' ? 0 : 1);
      const transactionsRoot = join(root, '.repertoire-maintenance', 'transactions');
      const transaction = existsSync(transactionsRoot) ? readdirSync(transactionsRoot)[0] : undefined;
      expect(
        existsSync(join(packageDir, 'workflow.yaml'))
        || (transaction !== undefined
          && existsSync(join(transactionsRoot, transaction, 'payload', 'workflow.yaml'))),
      ).toBe(true);
    },
  );
});
