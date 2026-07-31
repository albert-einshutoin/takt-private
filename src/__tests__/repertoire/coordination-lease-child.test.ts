import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

type Lease = {
  release(): Promise<void> | void;
};

type CoordinationModule = {
  acquireRepertoireCoordinationLease(options: {
    globalConfigDir: string;
    mode: 'read' | 'write';
    timeoutMs?: number;
  }): Promise<Lease>;
};

const isChildContractProcess = process.env['TAKT_REPERTOIRE_LEASE_CHILD'] === '1';

it.runIf(isChildContractProcess)(
  'holds a repertoire lease in an independent process',
  async () => {
    const globalConfigDir = requiredEnvironment('TAKT_REPERTOIRE_LEASE_CONFIG_DIR');
    const readyPath = requiredEnvironment('TAKT_REPERTOIRE_LEASE_READY_PATH');
    const releasePath = requiredEnvironment('TAKT_REPERTOIRE_LEASE_RELEASE_PATH');
    const moduleSpecifier: string = '../../features/repertoire/coordination-lease.js';
    const coordination = await import(moduleSpecifier) as CoordinationModule;
    const lease = await coordination.acquireRepertoireCoordinationLease({
      globalConfigDir,
      mode: 'write',
      timeoutMs: 2_000,
    });

    try {
      writeFileSync(readyPath, 'ready\n', { mode: 0o600, flag: 'wx' });
      const deadline = Date.now() + 10_000;
      while (!existsSync(releasePath) && Date.now() < deadline) {
        await delay(20);
      }
      expect(existsSync(releasePath)).toBe(true);
    } finally {
      await lease.release();
    }
  },
  15_000,
);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the child-process contract`);
  return value;
}
