import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  acquireRepertoireCoordinationLease,
  acquireRepertoireCoordinationReadLeaseImmediate,
} from '../../features/repertoire/coordination-lease.js';

it.runIf(process.platform === 'win32')(
  'coordinates the production default root across independent Windows processes',
  async () => {
    const globalConfigDir = join(userInfo().homedir, '.takt');
    mkdirSync(globalConfigDir, { recursive: true });
    const signals = mkdtempSync(join(tmpdir(), 'takt-win32-coordination-'));
    const readyPath = join(signals, 'ready');
    const releasePath = join(signals, 'release');
    const vitestEntry = fileURLToPath(
      new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url),
    );
    const childTest = fileURLToPath(new URL('./coordination-lease-child.test.ts', import.meta.url));
    const child = spawn(process.execPath, [vitestEntry, 'run', childTest], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TAKT_REPERTOIRE_LEASE_CHILD: '1',
        TAKT_REPERTOIRE_LEASE_CONFIG_DIR: globalConfigDir,
        TAKT_REPERTOIRE_LEASE_READY_PATH: readyPath,
        TAKT_REPERTOIRE_LEASE_RELEASE_PATH: releasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    try {
      await waitForPath(readyPath, 10_000);
      expect(() => acquireRepertoireCoordinationReadLeaseImmediate({ globalConfigDir }))
        .toThrow(expect.objectContaining({ code: 'WRITER_PENDING' }));
      writeFileSync(releasePath, 'release\n', { flag: 'wx' });
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });

      const lease = await acquireRepertoireCoordinationLease({
        globalConfigDir,
        mode: 'read',
        timeoutMs: 2_000,
      });
      lease.release();
    } finally {
      if (child.exitCode === null) child.kill();
      rmSync(signals, { recursive: true, force: true });
    }
  },
  20_000,
);

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await delay(20);
  if (!existsSync(path)) throw new Error('Windows coordination child did not become ready');
}
