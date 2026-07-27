import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface RepoExecutionClaim {
  readonly operationId: string;
  release(): void;
}

interface ClaimOwner {
  readonly pid: number;
  readonly startToken: string;
  readonly operationId: string;
}

export function resolveProcessStartToken(pid: number): string | undefined {
  const psPath = ['/bin/ps', '/usr/bin/ps'].find(existsSync);
  if (psPath === undefined) return undefined;
  try {
    const started = execFileSync(psPath, ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return started === ''
      ? undefined
      : createHash('sha256').update(`${pid}\0${started}`, 'utf8').digest('hex');
  } catch {
    return undefined;
  }
}

function ownerState(owner: ClaimOwner): 'alive' | 'dead' | 'unknown' {
  return inspectProcessIdentity(owner.pid, owner.startToken);
}

export function inspectProcessIdentity(
  pid: number,
  expectedStartToken: string,
): 'alive' | 'dead' | 'unknown' {
  const token = resolveProcessStartToken(pid);
  if (token !== undefined) return token === expectedStartToken ? 'alive' : 'dead';
  try {
    process.kill(pid, 0);
    return 'unknown';
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    return code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function parseOwner(path: string): ClaimOwner | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || stat.size > 4_096
      || (uid !== undefined && stat.uid !== uid)
    ) {
      return undefined;
    }
    const value = JSON.parse(readFileSync(fd, 'utf8')) as Partial<ClaimOwner>;
    return Number.isInteger(value.pid)
      && (value.pid ?? 0) > 0
      && typeof value.startToken === 'string'
      && /^[a-f0-9]{64}$/u.test(value.startToken)
      && typeof value.operationId === 'string'
      ? value as ClaimOwner
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function secureClaimDirectory(path: string): void {
  const directory = dirname(path);
  const taktDirectory = dirname(directory);
  if (existsSync(taktDirectory) && lstatSync(taktDirectory).isSymbolicLink()) {
    throw new Error('Repository execution claim runtime directory is not secure');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || (uid !== undefined && stat.uid !== uid)
    || (stat.mode & 0o022) !== 0
  ) {
    throw new Error('Repository execution claim directory is not secure');
  }
}

export function tryAcquireRepoExecutionClaim(
  repoPath: string,
  operationId = `exec_${randomUUID()}`,
): RepoExecutionClaim | undefined {
  const claimPath = join(repoPath, '.takt', 'devloop', 'repo-execution.claim');
  secureClaimDirectory(claimPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(
        claimPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : '';
      if (code !== 'EEXIST') throw error;
      const owner = parseOwner(claimPath);
      if (owner === undefined || ownerState(owner) !== 'dead') return undefined;
      // Dead ownership, not elapsed time, is the only automatic cleanup rule.
      // This prevents a slow but live operation from being replayed.
      try {
        unlinkSync(claimPath);
      } catch {
        return undefined;
      }
      continue;
    }

    const token = resolveProcessStartToken(process.pid);
    if (token === undefined) {
      closeSync(fd);
      unlinkSync(claimPath);
      return undefined;
    }
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startToken: token, operationId }));
    const inode = fstatSync(fd).ino;
    let released = false;
    return Object.freeze({
      operationId,
      release(): void {
        if (released) return;
        released = true;
        try {
          closeSync(fd);
        } finally {
          try {
            const current = lstatSync(claimPath);
            if (current.isFile() && !current.isSymbolicLink() && current.ino === inode) {
              unlinkSync(claimPath);
            }
          } catch {
            // A missing/replaced claim must not be unlinked or mask the operation.
          }
        }
      },
    });
  }
  return undefined;
}
