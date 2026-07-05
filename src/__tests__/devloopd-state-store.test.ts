import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withDevloopFileLock, writeFileAtomic } from '../devloopd/stateStore.js';

function makePath(name: string): string {
  const dir = join(tmpdir(), `takt-state-store-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

describe('devloopd state store', () => {
  it('writes files atomically while holding a short lock', () => {
    const filePath = makePath('state.json');

    writeFileAtomic(filePath, '{"version":1}\n');

    expect(readFileSync(filePath, 'utf-8')).toBe('{"version":1}\n');
    expect(existsSync(`${filePath}.lock`)).toBe(false);
  });

  it('fails visibly when a non-stale lock is held', () => {
    const filePath = makePath('ledger.jsonl');
    writeFileSync(`${filePath}.lock`, 'locked', 'utf-8');

    expect(() => withDevloopFileLock(filePath, () => 'unreachable', { timeoutMs: 1, staleMs: 60_000 }))
      .toThrow(/timed out waiting for devloop state lock/u);
  });

  it('evicts stale locks before writing state', () => {
    const filePath = makePath('state.json');
    const lockPath = `${filePath}.lock`;
    writeFileSync(lockPath, 'stale', 'utf-8');
    const old = new Date('2026-07-05T00:00:00.000Z');
    utimesSync(lockPath, old, old);

    writeFileAtomic(filePath, '{"ok":true}\n', {
      lock: {
        timeoutMs: 100,
        staleMs: 1,
        now: () => new Date('2026-07-05T00:10:00.000Z').getTime(),
      },
    });

    expect(readFileSync(filePath, 'utf-8')).toBe('{"ok":true}\n');
  });
});
