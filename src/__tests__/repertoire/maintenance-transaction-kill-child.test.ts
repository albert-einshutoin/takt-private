import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { captureDirectoryTreeProof } from '../../features/repertoire/filesystem-proof.js';
import {
  detachToMaintenance,
  type MaintenanceTransactionPhase,
} from '../../features/repertoire/maintenance-transaction.js';

const childEnvironment = vi.hoisted(() => ({
  active: process.env['TAKT_MAINTENANCE_KILL_CHILD'] === '1',
  root: process.env['TAKT_MAINTENANCE_ROOT'],
  packageDir: process.env['TAKT_MAINTENANCE_PACKAGE'],
  ready: process.env['TAKT_MAINTENANCE_READY'],
  phase: process.env['TAKT_MAINTENANCE_PHASE'],
}));

it('stops at one real maintenance transaction crash boundary', () => {
  if (!childEnvironment.active) return;
  const root = required(childEnvironment.root, 'root');
  const packageDir = required(childEnvironment.packageDir, 'packageDir');
  const ready = required(childEnvironment.ready, 'ready');
  const target = required(childEnvironment.phase, 'phase') as MaintenanceTransactionPhase;
  detachToMaintenance({
    globalConfigDir: root,
    sourceDir: packageDir,
    containmentRoot: root,
    expected: captureDirectoryTreeProof(packageDir, root),
    kind: 'payload',
    onPhase: (phase) => {
      if (phase !== target) return;
      writeFileSync(ready, `${phase}\n`, { flag: 'wx', mode: 0o600 });
      // The parent sends SIGKILL. Blocking here makes the crash boundary exact.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    },
  });
  expect.unreachable('parent must terminate the child at the selected phase');
}, 65_000);

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing child environment: ${name}`);
  return value;
}
