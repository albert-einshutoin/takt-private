import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export interface DevloopFileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  now?: () => number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;

function sleepSync(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, Math.max(0, milliseconds));
}

function lockPathFor(targetPath: string): string {
  return `${targetPath}.lock`;
}

function removeIfStale(lockPath: string, now: number, staleMs: number): void {
  try {
    const stat = statSync(lockPath);
    if (now - stat.mtimeMs > staleMs) {
      unlinkSync(lockPath);
    }
  } catch {
    // Another process may have released the lock between exists/stat/unlink.
  }
}

export function withDevloopFileLock<T>(
  targetPath: string,
  fn: () => T,
  options: DevloopFileLockOptions = {},
): T {
  const lockPath = lockPathFor(targetPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date(now()).toISOString() }));
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
      if (code !== 'EEXIST') {
        throw error;
      }
      removeIfStale(lockPath, now(), staleMs);
      if (now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for devloop state lock: ${lockPath}`);
      }
      // The lock is process-local and intentionally synchronous because the
      // ledger/state APIs are synchronous; a bounded wait avoids partial writes
      // without forcing callers into an async persistence abstraction.
      sleepSync(Math.min(50, Math.max(1, timeoutMs - (now() - startedAt))));
    }
  }

  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // Lock cleanup should not mask the original state operation result.
      }
    }
  }
}

export function writeFileAtomic(
  filePath: string,
  content: string,
  options: { mode?: number; lock?: DevloopFileLockOptions } = {},
): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  withDevloopFileLock(filePath, () => {
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tempPath, content, { encoding: 'utf-8', flag: 'wx', mode: options.mode ?? 0o600 });
    renameSync(tempPath, filePath);
    if (options.mode !== undefined && existsSync(filePath)) {
      chmodSync(filePath, options.mode);
    }
  }, options.lock);
}
