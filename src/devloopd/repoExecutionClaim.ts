import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface RepoExecutionClaim {
  readonly operationId: string;
  release(): RepoExecutionClaimReleaseResult;
}

export type RepoExecutionClaimReleaseResult = 'released' | 'not_owner';

export class RepoExecutionClaimReleaseError extends Error {
  readonly code = 'claim_release_unavailable';

  constructor() {
    super('Repository execution claim release could not be verified');
    this.name = 'RepoExecutionClaimReleaseError';
  }
}
interface ClaimOwner {
  readonly pid: number;
  readonly startToken: string;
  readonly operationId: string;
}

const CLAIM_TRANSITION_SCRIPT = String.raw`
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const [action, claimPath, operationId, pidText, startToken] = process.argv.slice(1);
const pid = Number(pidText);
function tokenFor(targetPid) {
  const ps = ['/bin/ps', '/usr/bin/ps'].find(existsSync);
  if (!ps) return undefined;
  try {
    const started = execFileSync(ps, ['-p', String(targetPid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return started === '' ? undefined : createHash('sha256').update(String(targetPid) + '\0' + started, 'utf8').digest('hex');
  } catch { return undefined; }
}
function parseOwner() {
  let fd;
  try {
    fd = openSync(claimPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || (uid !== undefined && stat.uid !== uid)) return undefined;
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    return Number.isInteger(value.pid) && value.pid > 0
      && typeof value.startToken === 'string'
      && (/^[a-f0-9]{64}$/.test(value.startToken) || /^unknown_[A-Za-z0-9._:-]+$/.test(value.startToken))
      && typeof value.operationId === 'string'
      ? value : undefined;
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
function state(owner) {
  if (owner.startToken.startsWith('unknown_')) return 'unknown';
  const token = tokenFor(owner.pid);
  if (token !== undefined) return token === owner.startToken ? 'alive' : 'dead';
  try { process.kill(owner.pid, 0); return 'unknown'; }
  catch (error) { return error && error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}
if (action === 'acquire') {
  if (existsSync(claimPath)) {
    const owner = parseOwner();
    if (owner === undefined || state(owner) !== 'dead') {
      process.stdout.write('busy');
      process.exit(0);
    }
    unlinkSync(claimPath);
  }
  let fd;
  try {
    fd = openSync(claimPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify({ pid, startToken, operationId }));
    process.stdout.write('acquired');
  } finally { if (fd !== undefined) closeSync(fd); }
} else if (action === 'release') {
  if (!existsSync(claimPath)) {
    process.stdout.write('not_owner');
    process.exit(0);
  }
  const owner = parseOwner();
  if (!owner) {
    process.stdout.write('invalid_owner');
  } else if (owner.pid === pid && owner.startToken === startToken && owner.operationId === operationId) {
    unlinkSync(claimPath);
    process.stdout.write('released');
  } else {
    process.stdout.write('not_owner');
  }
} else {
  process.exit(2);
}
`;

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

export function inspectProcessIdentity(
  pid: number,
  expectedStartToken: string,
): 'alive' | 'dead' | 'unknown' {
  if (expectedStartToken.startsWith('unknown_')) return 'unknown';
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

function advisoryLockCommand(): { command: string; args: (lockPath: string) => string[] } | undefined {
  if (existsSync('/usr/bin/lockf')) {
    return {
      command: '/usr/bin/lockf',
      args: (lockPath) => ['-t', '5', lockPath],
    };
  }
  if (existsSync('/usr/bin/flock')) {
    return {
      command: '/usr/bin/flock',
      args: (lockPath) => ['-x', '-w', '5', lockPath],
    };
  }
  return undefined;
}

function runClaimTransition(
  claimPath: string,
  action: 'acquire' | 'release',
  owner: ClaimOwner,
): 'acquired' | 'busy' | 'released' | 'not_owner' | 'invalid_owner' | undefined {
  const advisory = advisoryLockCommand();
  if (advisory === undefined) return undefined;
  try {
    return execFileSync(advisory.command, [
      ...advisory.args(`${claimPath}.transition-lock`),
      process.execPath,
      '-e',
      CLAIM_TRANSITION_SCRIPT,
      action,
      claimPath,
      owner.operationId,
      String(owner.pid),
      owner.startToken,
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() as 'acquired' | 'busy' | 'released' | 'not_owner' | 'invalid_owner';
  } catch {
    return undefined;
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
  const token = resolveProcessStartToken(process.pid);
  if (token === undefined) return undefined;
  const owner = Object.freeze({ pid: process.pid, startToken: token, operationId });
  if (runClaimTransition(claimPath, 'acquire', owner) !== 'acquired') return undefined;
  let released = false;
  return Object.freeze({
    operationId,
    release(): RepoExecutionClaimReleaseResult {
      if (released) return 'not_owner';
      // Release is serialized by the same kernel advisory lock and checks the
      // complete owner tuple, so an old handle cannot unlink a replacement.
      const result = runClaimTransition(claimPath, 'release', owner);
      if (result !== 'released' && result !== 'not_owner') {
        // Do not poison this handle: a transient advisory-lock/helper failure
        // must be observable and the caller must be able to retry cleanup.
        throw new RepoExecutionClaimReleaseError();
      }
      released = true;
      return result;
    },
  });
}
