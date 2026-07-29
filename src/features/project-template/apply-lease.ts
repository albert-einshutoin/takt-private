import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  assertProjectTemplateApplyLeaseAvailable,
  readProjectTemplateJsonStrict,
  resolveProjectTemplateApplyLeasePath,
  resolveProjectTemplateRecoveryRequiredPath,
  resolveProjectTemplateRunStartMutexPath,
  type ProjectTemplateApplyLeaseIdentity,
} from './apply-guard.js';
import { isProcessAlive } from '../../infra/task/process.js';

export class ProjectTemplateCoordinationError extends Error {
  readonly code = 'PROJECT_TEMPLATE_COORDINATION_UNAVAILABLE';

  constructor() {
    super('project template coordination state is busy or cannot be proven safe');
    this.name = 'ProjectTemplateCoordinationError';
  }
}

export interface ProjectTemplateApplyLease
  extends ProjectTemplateApplyLeaseIdentity {
  release(): void;
}

export interface ProjectTemplateRecoveryRequiredIdentity {
  token: string;
  transactionId: string;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureControlRoot(repoPath: string): string {
  const repoRoot = resolve(repoPath);
  const repoStat = lstatSync(repoRoot);
  if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) {
    throw new ProjectTemplateCoordinationError();
  }
  const controlRoot = join(repoRoot, '.takt-template-state');
  try {
    mkdirSync(controlRoot, { mode: 0o700 });
    syncDirectory(repoRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new ProjectTemplateCoordinationError();
    }
  }
  const stat = lstatSync(controlRoot);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0
  ) {
    throw new ProjectTemplateCoordinationError();
  }
  return controlRoot;
}

function createDurableJsonFile(path: string, value: unknown): void {
  const fd = openSync(
    path,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

function createCoordinationFile(path: string, token: string): void {
  createDurableJsonFile(path, { version: 1, token, pid: process.pid });
}

function removeOwnedCoordinationFile(path: string, token: string): void {
  const read = readProjectTemplateJsonStrict(path);
  if (read.kind !== 'value') {
    throw new ProjectTemplateCoordinationError();
  }
  const value = read.value;
  if (
    typeof value !== 'object'
    || value === null
    || (value as Record<string, unknown>)['version'] !== 1
    || (value as Record<string, unknown>)['token'] !== token
  ) {
    throw new ProjectTemplateCoordinationError();
  }
  unlinkSync(path);
  syncDirectory(dirname(path));
}

function assertRecoveryIdentity(
  identity: ProjectTemplateRecoveryRequiredIdentity,
): void {
  if (
    identity.token.trim().length === 0
    || identity.token.length > 512
    || identity.transactionId.trim().length === 0
    || identity.transactionId.length > 512
  ) {
    throw new ProjectTemplateCoordinationError();
  }
}

export function writeProjectTemplateRecoveryRequiredMarker(
  repoPathValue: string,
  identity: ProjectTemplateRecoveryRequiredIdentity,
): void {
  assertRecoveryIdentity(identity);
  const repoPath = resolve(repoPathValue);
  const controlRoot = ensureControlRoot(repoPath);
  const markerPath = resolveProjectTemplateRecoveryRequiredPath(repoPath);
  if (dirname(markerPath) !== controlRoot) {
    throw new ProjectTemplateCoordinationError();
  }
  try {
    createDurableJsonFile(markerPath, {
      version: 1,
      token: identity.token,
      transactionId: identity.transactionId,
    });
  } catch {
    throw new ProjectTemplateCoordinationError();
  }
}

export function clearProjectTemplateRecoveryRequiredMarker(
  repoPathValue: string,
  identity: ProjectTemplateRecoveryRequiredIdentity,
): void {
  assertRecoveryIdentity(identity);
  const repoPath = resolve(repoPathValue);
  const controlRoot = ensureControlRoot(repoPath);
  const markerPath = resolveProjectTemplateRecoveryRequiredPath(repoPath);
  if (dirname(markerPath) !== controlRoot) {
    throw new ProjectTemplateCoordinationError();
  }
  const read = readProjectTemplateJsonStrict(markerPath);
  if (
    read.kind !== 'value'
    || typeof read.value !== 'object'
    || read.value === null
    || (read.value as Record<string, unknown>)['version'] !== 1
    || (read.value as Record<string, unknown>)['token'] !== identity.token
    || (read.value as Record<string, unknown>)['transactionId'] !== identity.transactionId
  ) {
    throw new ProjectTemplateCoordinationError();
  }
  try {
    unlinkSync(markerPath);
    syncDirectory(controlRoot);
  } catch {
    throw new ProjectTemplateCoordinationError();
  }
}

function reclaimDeadCoordinationFile(path: string): boolean {
  const read = readProjectTemplateJsonStrict(path);
  if (read.kind === 'missing') return true;
  if (
    read.kind !== 'value'
    || typeof read.value !== 'object'
    || read.value === null
  ) {
    throw new ProjectTemplateCoordinationError();
  }
  const value = read.value as Record<string, unknown>;
  if (
    value['version'] !== 1
    || typeof value['token'] !== 'string'
    || value['token'].trim().length === 0
    || value['token'].length > 512
    || !Number.isSafeInteger(value['pid'])
    || (value['pid'] as number) <= 0
  ) {
    throw new ProjectTemplateCoordinationError();
  }
  try {
    if (isProcessAlive(value['pid'] as number)) return false;
  } catch {
    throw new ProjectTemplateCoordinationError();
  }
  removeOwnedCoordinationFile(path, value['token']);
  return true;
}

function acquireCoordinationFile(path: string): {
  token: string;
  pid: number;
  release(): void;
} {
  const token = randomUUID();
  try {
    createCoordinationFile(path, token);
  } catch {
    if (!reclaimDeadCoordinationFile(path)) {
      throw new ProjectTemplateCoordinationError();
    }
    try {
      createCoordinationFile(path, token);
    } catch {
      throw new ProjectTemplateCoordinationError();
    }
  }
  let released = false;
  return {
    token,
    pid: process.pid,
    release() {
      if (released) return;
      removeOwnedCoordinationFile(path, token);
      released = true;
    },
  };
}

/**
 * Serializes the short critical section where a runner proves no apply is in
 * flight and publishes durable running evidence. Apply takes the same mutex
 * before publishing its own lease, closing the check-then-start race.
 */
export function withProjectTemplateRunStartPermit<Result>(
  repoPathValue: string,
  publishRunningEvidence: () => Result,
): Result {
  const repoPath = resolve(repoPathValue);
  const controlRoot = ensureControlRoot(repoPath);
  const mutexPath = resolveProjectTemplateRunStartMutexPath(repoPath);
  if (dirname(mutexPath) !== controlRoot) {
    throw new ProjectTemplateCoordinationError();
  }
  const mutex = acquireCoordinationFile(mutexPath);
  try {
    try {
      assertProjectTemplateApplyLeaseAvailable(repoPath);
    } catch {
      throw new ProjectTemplateCoordinationError();
    }
    return publishRunningEvidence();
  } finally {
    mutex.release();
  }
}

export function acquireProjectTemplateApplyLease(
  repoPathValue: string,
): ProjectTemplateApplyLease {
  const repoPath = resolve(repoPathValue);
  const controlRoot = ensureControlRoot(repoPath);
  const mutexPath = resolveProjectTemplateRunStartMutexPath(repoPath);
  const lockPath = resolveProjectTemplateApplyLeasePath(repoPath);
  if (dirname(mutexPath) !== controlRoot || dirname(lockPath) !== controlRoot) {
    throw new ProjectTemplateCoordinationError();
  }
  const mutex = acquireCoordinationFile(mutexPath);
  try {
    const lease = acquireCoordinationFile(lockPath);
    return {
      lockPath,
      token: lease.token,
      pid: lease.pid,
      release: lease.release,
    };
  } finally {
    mutex.release();
  }
}

/**
 * Recovery may remove only a well-formed lease whose recorded owner process is
 * definitely gone. Live, unreadable, or malformed ownership remains blocked.
 */
export function reclaimStaleProjectTemplateApplyLeaseForRecovery(
  repoPathValue: string,
): void {
  const repoPath = resolve(repoPathValue);
  const controlRoot = ensureControlRoot(repoPath);
  const mutexPath = resolveProjectTemplateRunStartMutexPath(repoPath);
  const lockPath = resolveProjectTemplateApplyLeasePath(repoPath);
  if (dirname(mutexPath) !== controlRoot || dirname(lockPath) !== controlRoot) {
    throw new ProjectTemplateCoordinationError();
  }
  const mutex = acquireCoordinationFile(mutexPath);
  try {
    if (!reclaimDeadCoordinationFile(lockPath)) {
      throw new ProjectTemplateCoordinationError();
    }
  } finally {
    mutex.release();
  }
}
