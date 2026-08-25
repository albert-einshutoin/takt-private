import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyMaintenanceTransactions,
  type MaintenanceTransactionPhase,
} from '../../features/repertoire/maintenance-transaction.js';

describe('maintenance transaction real process crash classification', () => {
  const roots: string[] = [];
  const children = new Set<ChildProcess>();

  afterEach(() => {
    for (const child of children) child.kill('SIGKILL');
    children.clear();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['maintenance-root-created', 'empty'],
    ['maintenance-root-durable', 'empty'],
    ['transactions-root-created', 'empty'],
    ['transactions-root-durable', 'empty'],
    ['intent-written', 'incomplete'],
    ['intent-durable', 'incomplete'],
    ['after-rename', 'incomplete'],
    ['outcome-durable', 'incomplete'],
    ['complete-written', 'incomplete'],
    ['complete-pending-durable', 'incomplete'],
    ['complete-renamed', 'complete'],
  ] satisfies Array<[MaintenanceTransactionPhase, 'empty' | 'incomplete' | 'complete']>)(
    'classifies SIGKILL at %s on restart', async (phase, expectedState) => {
      const root = mkdtempSync(join(tmpdir(), 'takt-maintenance-kill-'));
      roots.push(root);
      const packageDir = join(root, 'repertoire', '@owner', 'repo');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'workflow.yaml'), 'name: retained');
      const ready = join(root, 'child.ready');
      const child = spawnCrashChild(root, packageDir, ready, phase);
      children.add(child);
      await waitForPath(ready);
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      children.delete(child);

      const classification = classifyMaintenanceTransactions(root);
      expect(classification[expectedState === 'complete' ? 'complete' : 'incomplete'])
        .toHaveLength(expectedState === 'empty' ? 0 : 1);
      const transaction = classification.complete[0] ?? classification.incomplete[0];
      expect(
        existsSync(join(packageDir, 'workflow.yaml'))
        || (transaction !== undefined
          && existsSync(join(transaction, 'payload', 'workflow.yaml'))),
      ).toBe(true);
    }, 15_000);
});

function spawnCrashChild(
  root: string,
  packageDir: string,
  ready: string,
  phase: MaintenanceTransactionPhase,
): ChildProcess {
  const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
  const childTest = fileURLToPath(new URL('./maintenance-transaction-kill-child.test.ts', import.meta.url));
  return spawn(process.execPath, [vitest, 'run', childTest], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TAKT_MAINTENANCE_KILL_CHILD: '1',
      TAKT_MAINTENANCE_ROOT: root,
      TAKT_MAINTENANCE_PACKAGE: packageDir,
      TAKT_MAINTENANCE_READY: ready,
      TAKT_MAINTENANCE_PHASE: phase,
    },
    stdio: 'ignore',
  });
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(10);
  }
  throw new Error('child did not reach the requested maintenance phase');
}
