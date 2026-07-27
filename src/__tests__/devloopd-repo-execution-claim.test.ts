import { randomUUID } from 'node:crypto';
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
});
