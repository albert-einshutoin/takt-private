import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RepoExecutionClaimReleaseError,
  tryAcquireRepoExecutionClaim,
} from '../devloopd/repoExecutionClaim.js';

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

  it('retries a transient cleanup failure inside one production release call', () => {
    const repoPath = join(tmpdir(), `takt-repo-claim-release-retry-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
    let attempts = 0;
    const claim = tryAcquireRepoExecutionClaim(repoPath, 'retry_release', {
      beforeReleaseAttempt(attempt) {
        attempts = attempt;
        if (attempt === 1) throw new Error('transient helper failure');
      },
    });
    expect(claim).toBeDefined();
    expect(claim?.release()).toBe('released');
    expect(attempts).toBe(2);
    expect(existsSync(join(repoPath, '.takt', 'devloop', 'repo-execution.claim'))).toBe(false);
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('propagates a typed error after bounded transient cleanup failures', () => {
    const repoPath = join(tmpdir(), `takt-repo-claim-release-fail-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
    let attempts = 0;
    const claim = tryAcquireRepoExecutionClaim(repoPath, 'failed_release', {
      beforeReleaseAttempt(attempt) {
        attempts += 1;
        if (attempts <= 3) throw new Error(`failure ${attempt}`);
      },
    });
    expect(claim).toBeDefined();
    expect(() => claim?.release()).toThrow(RepoExecutionClaimReleaseError);
    expect(attempts).toBe(3);
    expect(existsSync(join(repoPath, '.takt', 'devloop', 'repo-execution.claim'))).toBe(true);
    expect(claim?.release()).toBe('released');
    rmSync(repoPath, { recursive: true, force: true });
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
      let claim;
      let pending = '';
      process.stdout.write('ready\\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\\n')) >= 0) {
          const command = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (command === 'go') {
            claim = tryAcquireRepoExecutionClaim(process.argv[1], process.argv[2]);
            process.stdout.write((claim ? 'acquired' : 'busy') + '\\n');
            if (!claim) process.exit(0);
          } else if (command === 'release' && claim) {
            process.stdout.write(claim.release() + '\\n');
            process.exit(0);
          }
        }
      });
    `;
    const runChild = (operationId: string) => {
      const child = spawn(process.execPath, [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        childSource,
        repoPath,
        operationId,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      let pending = '';
      const messages: string[] = [];
      const waiters: Array<(message: string) => void> = [];
      child.stdout.on('data', (chunk) => {
        pending += String(chunk);
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const message = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          const waiter = waiters.shift();
          if (waiter === undefined) messages.push(message);
          else waiter(message);
        }
      });
      return {
        child,
        next: () => messages.length > 0
          ? Promise.resolve(messages.shift() as string)
          : new Promise<string>((resolve) => waiters.push(resolve)),
      };
    };

    try {
      const contenders = [runChild('contender_a'), runChild('contender_b')];
      await Promise.all(contenders.map((contender) => expect(contender.next()).resolves.toBe('ready')));
      contenders.forEach((contender) => contender.child.stdin.write('go\n'));
      const results = await Promise.all(contenders.map((contender) => contender.next()));
      expect(results.filter((result) => result === 'acquired')).toHaveLength(1);
      expect(results.filter((result) => result === 'busy')).toHaveLength(1);
      const winner = contenders[results.indexOf('acquired')];
      if (winner === undefined) throw new Error('winner missing');
      winner.child.stdin.write('release\n');
      await expect(winner.next()).resolves.toBe('released');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
