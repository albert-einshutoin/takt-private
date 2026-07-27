import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tryAcquireRepoExecutionClaim } from '../devloopd/repoExecutionClaim.js';

describe('repository execution claim', () => {
  it('allows only one start boundary owner and releases explicitly', () => {
    const repoPath = join(tmpdir(), `takt-repo-claim-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
    try {
      const first = tryAcquireRepoExecutionClaim(repoPath, 'decision_a');
      expect(first).toBeDefined();
      expect(tryAcquireRepoExecutionClaim(repoPath, 'decision_b')).toBeUndefined();

      first?.release();
      const second = tryAcquireRepoExecutionClaim(repoPath, 'decision_b');
      expect(second).toBeDefined();
      second?.release();
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('does not treat a reused live PID with a different start token as the owner', () => {
    const repoPath = join(tmpdir(), `takt-repo-claim-reused-${randomUUID()}`);
    const claimDirectory = join(repoPath, '.takt', 'devloop');
    mkdirSync(claimDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(claimDirectory, 'repo-execution.claim'), JSON.stringify({
      pid: process.pid,
      startToken: '0'.repeat(64),
      operationId: 'stale_reused_pid',
    }), { mode: 0o600 });
    try {
      const replacement = tryAcquireRepoExecutionClaim(repoPath, 'replacement');
      expect(replacement).toBeDefined();
      replacement?.release();
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('allows at most one real process to reclaim the same dead owner', async () => {
    const repoPath = join(tmpdir(), `takt-repo-claim-race-${randomUUID()}`);
    const claimDirectory = join(repoPath, '.takt', 'devloop');
    mkdirSync(claimDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(claimDirectory, 'repo-execution.claim'), JSON.stringify({
      pid: 999_999,
      startToken: '0'.repeat(64),
      operationId: 'dead_owner',
    }), { mode: 0o600 });
    const moduleUrl = new URL('../devloopd/repoExecutionClaim.ts', import.meta.url).href;
    const childSource = `
      import { tryAcquireRepoExecutionClaim } from ${JSON.stringify(moduleUrl)};
      const claim = tryAcquireRepoExecutionClaim(process.argv[1], process.argv[2]);
      process.stdout.write(claim ? 'acquired' : 'busy');
      if (claim) setTimeout(() => { claim.release(); }, 250);
    `;
    const runChild = (operationId: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        childSource,
        repoPath,
        operationId,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr));
      });
    });

    try {
      const results = await Promise.all([runChild('contender_a'), runChild('contender_b')]);
      expect(results.filter((result) => result === 'acquired')).toHaveLength(1);
      expect(results.filter((result) => result === 'busy')).toHaveLength(1);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
