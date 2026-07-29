import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
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
import {
  isProjectTemplateOwnerOnlyMode,
  PROJECT_TEMPLATE_CONTROL_DIRECTORY,
  PROJECT_TEMPLATE_CONTROL_GITIGNORE_TEXT,
} from './control-root-contract.js';

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

const CONTROL_GITIGNORE_CONTENT = Buffer.from(PROJECT_TEMPLATE_CONTROL_GITIGNORE_TEXT);

function syncDirectoryDescriptor(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function syncProjectTemplateCoordinationDirectory(
  path: string,
  platform: NodeJS.Platform = process.platform,
  sync: (directory: string) => void = syncDirectoryDescriptor,
): 'synced' | 'unsupported' {
  // Windows does not support opening directories for fsync. File contents are
  // still fsynced before publication; directory durability is best-effort on
  // that platform, matching the existing taktpack writer contract.
  if (platform === 'win32') return 'unsupported';
  sync(path);
  return 'synced';
}

function syncDirectory(path: string): void {
  syncProjectTemplateCoordinationDirectory(path);
}

export function isSafeProjectTemplateControlIgnore(
  path: string,
  expectedDevice: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  let pathEntry: ReturnType<typeof lstatSync>;
  try {
    pathEntry = lstatSync(path);
  } catch {
    return false;
  }
  if (
    pathEntry.isSymbolicLink()
    || !pathEntry.isFile()
    || pathEntry.nlink !== 1
    || pathEntry.dev !== expectedDevice
    || !isProjectTemplateOwnerOnlyMode(pathEntry.mode, platform)
    || pathEntry.size !== CONTROL_GITIGNORE_CONTENT.byteLength
  ) {
    return false;
  }
  let fd: number;
  try {
    // Windows does not expose O_NOFOLLOW. The lstat/fstat identity check
    // provides the corresponding reparse-point and replacement witness there.
    const noFollow = platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    return false;
  }
  let safe = false;
  try {
    const before = fstatSync(fd);
    if (
      before.isFile()
      && before.nlink === 1
      && before.dev === expectedDevice
      && isProjectTemplateOwnerOnlyMode(before.mode, platform)
      && before.size === CONTROL_GITIGNORE_CONTENT.byteLength
      && pathEntry.dev === before.dev
      && pathEntry.ino === before.ino
      && pathEntry.mode === before.mode
      && pathEntry.nlink === before.nlink
      && pathEntry.size === before.size
      && pathEntry.mtimeMs === before.mtimeMs
      && pathEntry.ctimeMs === before.ctimeMs
    ) {
      const content = Buffer.alloc(CONTROL_GITIGNORE_CONTENT.byteLength);
      const bytesRead = readSync(fd, content, 0, content.byteLength, 0);
      const extra = Buffer.alloc(1);
      const extraBytes = readSync(fd, extra, 0, 1, bytesRead);
      const after = fstatSync(fd);
      safe = bytesRead === content.byteLength
        && extraBytes === 0
        && content.equals(CONTROL_GITIGNORE_CONTENT)
        && before.dev === after.dev
        && before.ino === after.ino
        && before.mode === after.mode
        && before.nlink === after.nlink
        && before.size === after.size
        && before.mtimeMs === after.mtimeMs
        && before.ctimeMs === after.ctimeMs;
    }
  } catch {
    safe = false;
  }
  try {
    closeSync(fd);
  } catch {
    safe = false;
  }
  return safe;
}

function ensureControlIgnore(controlRoot: string, expectedDevice: number): void {
  const path = join(controlRoot, '.gitignore');
  try {
    const fd = openSync(
      path,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, CONTROL_GITIGNORE_CONTENT);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new ProjectTemplateCoordinationError();
    }
  }
  // The coordination namespace must be durable before any visible lock file
  // can be published. Repeating the directory sync also repairs the durability
  // boundary after a prior process failed between file and directory fsync.
  syncDirectory(controlRoot);
  if (!isSafeProjectTemplateControlIgnore(path, expectedDevice)) {
    throw new ProjectTemplateCoordinationError();
  }
}

function ensureControlRoot(repoPath: string): string {
  const repoRoot = resolve(repoPath);
  const repoStat = lstatSync(repoRoot);
  if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) {
    throw new ProjectTemplateCoordinationError();
  }
  const controlRoot = join(repoRoot, PROJECT_TEMPLATE_CONTROL_DIRECTORY);
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
    || stat.dev !== repoStat.dev
    || !isProjectTemplateOwnerOnlyMode(stat.mode)
  ) {
    throw new ProjectTemplateCoordinationError();
  }
  // Ignore publication precedes every mutex/lease file so even a process crash
  // cannot expose coordination artifacts to `git add -A`.
  ensureControlIgnore(controlRoot, repoStat.dev);
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
