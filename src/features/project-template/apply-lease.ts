import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
  type Stats,
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

class RetryableCoordinationMainExistsError extends Error {
  constructor() {
    super('coordination main path already exists');
    this.name = 'RetryableCoordinationMainExistsError';
  }
}

export interface ProjectTemplateApplyLease
  extends ProjectTemplateApplyLeaseIdentity {
  release(): void;
}

export interface ProjectTemplateRunStartPermit {
  readonly repoPath: string;
  readonly lockPath: string;
  readonly token: string;
  readonly pid: number;
}

const activeRunStartPermits = new WeakSet<ProjectTemplateRunStartPermit>();

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

function createClaimSafeCoordinationFile(path: string, token: string): void {
  const reclaimPath = `${path}.reclaim`;
  const namespaceToken = randomUUID();
  if (existsSync(reclaimPath)) {
    // A process can die after publishing its exclusive reclaim namespace but
    // before removing it. Recover only a well-formed namespace whose owner is
    // definitely dead; live or ambiguous ownership remains fail-closed.
    if (!reclaimDeadCoordinationNamespace(path, reclaimPath, 0)) {
      throw new ProjectTemplateCoordinationError();
    }
  }
  try {
    // Reserving the same fixed namespace used by stale reclaim proves that no
    // prior claimant remains after unlinking the old main path. Without this
    // handshake, a crash between old-path unlink and claim cleanup could let a
    // new owner report acquisition while the reclaim claim is still durable.
    createCoordinationFile(reclaimPath, namespaceToken);
  } catch {
    throw new ProjectTemplateCoordinationError();
  }
  try {
    createCoordinationFile(path, token);
  } catch (error) {
    try {
      removeOwnedCoordinationFile(reclaimPath, namespaceToken);
    } catch {
      // Even a pre-main collision becomes terminal if namespace cleanup cannot
      // be proven durable.
      throw new ProjectTemplateCoordinationError();
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RetryableCoordinationMainExistsError();
    }
    throw new ProjectTemplateCoordinationError();
  }
  try {
    removeOwnedCoordinationFile(reclaimPath, namespaceToken);
  } catch {
    try {
      removeOwnedCoordinationFile(path, token);
    } catch {
      // Leaving an ambiguous owned main path is safer than retrying publication
      // after namespace durability became uncertain.
    }
    try {
      removeOwnedCoordinationFile(reclaimPath, namespaceToken);
    } catch {
      // A durable reservation is safer than guessing about its ownership.
    }
    throw new ProjectTemplateCoordinationError();
  }
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
  return reclaimDeadCoordinationFileAtDepth(path, 0);
}

const MAX_RECLAIM_RECOVERY_DEPTH = 16;
const MAX_COORDINATION_RECORD_BYTES = 4096;

function readClaimedCoordinationRecord(
  path: string,
  expected: Stats,
): Record<string, unknown> | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile()
      || before.dev !== expected.dev
      || before.ino !== expected.ino
      || before.nlink !== expected.nlink
      || before.size <= 0
      || before.size > MAX_COORDINATION_RECORD_BYTES
    ) {
      return undefined;
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = readSync(fd, content, offset, content.length - offset, offset);
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const extraBytes = readSync(fd, extra, 0, 1, offset);
    const after = fstatSync(fd);
    if (
      extraBytes !== 0
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mode !== before.mode
      || after.nlink !== before.nlink
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      return undefined;
    }
    const parsed = JSON.parse(content.toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function reclaimDeadCoordinationNamespace(
  mainPath: string,
  reclaimPath: string,
  depth: number,
): boolean {
  if (depth > MAX_RECLAIM_RECOVERY_DEPTH) {
    throw new ProjectTemplateCoordinationError();
  }
  let claimed: Stats;
  try {
    claimed = lstatSync(reclaimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new ProjectTemplateCoordinationError();
  }
  const value = readClaimedCoordinationRecord(reclaimPath, claimed);
  if (value === undefined) {
    throw new ProjectTemplateCoordinationError();
  }
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

  let currentMain: Stats | undefined;
  try {
    currentMain = lstatSync(mainPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ProjectTemplateCoordinationError();
    }
  }
  if (
    currentMain !== undefined
    && currentMain.dev === claimed.dev
    && currentMain.ino === claimed.ino
  ) {
    // The main pathname keeps this namespace from being replaced before the
    // single unlink below. Re-check both links immediately before removal so
    // a dead reclaimer's exact inode is recovered without touching a successor.
    const latestMain = lstatSync(mainPath);
    const latestClaim = lstatSync(reclaimPath);
    if (
      !latestMain.isFile()
      || latestMain.isSymbolicLink()
      || !latestClaim.isFile()
      || latestClaim.isSymbolicLink()
      || latestMain.dev !== claimed.dev
      || latestMain.ino !== claimed.ino
      || latestClaim.dev !== claimed.dev
      || latestClaim.ino !== claimed.ino
      || latestMain.nlink !== 2
      || latestClaim.nlink !== 2
    ) {
      throw new ProjectTemplateCoordinationError();
    }
    unlinkSync(reclaimPath);
    syncDirectory(dirname(reclaimPath));
    return true;
  }

  return reclaimDeadCoordinationFileAtDepth(reclaimPath, depth + 1);
}

function reclaimDeadCoordinationFileAtDepth(path: string, depth: number): boolean {
  if (depth > MAX_RECLAIM_RECOVERY_DEPTH) {
    throw new ProjectTemplateCoordinationError();
  }
  const reclaimPath = `${path}.reclaim`;
  if (existsSync(reclaimPath)) {
    if (!reclaimDeadCoordinationNamespace(path, reclaimPath, depth + 1)) {
      return false;
    }
  }
  let observed: Stats;
  try {
    observed = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new ProjectTemplateCoordinationError();
  }
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
  let claimCreated = false;
  try {
    // The hard link is an exclusive claim on this exact inode. A second
    // reclaimer cannot pass this boundary and later unlink a replacement lock
    // published by the first reclaimer.
    linkSync(path, reclaimPath);
    claimCreated = true;
    const claimed = lstatSync(reclaimPath);
    const current = lstatSync(path);
    if (
      !observed.isFile()
      || observed.isSymbolicLink()
      || observed.nlink !== 1
      || claimed.dev !== observed.dev
      || claimed.ino !== observed.ino
      || current.dev !== claimed.dev
      || current.ino !== claimed.ino
      || claimed.nlink !== 2
      || current.nlink !== 2
    ) {
      throw new ProjectTemplateCoordinationError();
    }
    unlinkSync(path);
    syncDirectory(dirname(path));
    unlinkSync(reclaimPath);
    syncDirectory(dirname(path));
    return true;
  } catch {
    if (claimCreated) {
      try {
        // This pathname was published by this invocation with O_EXCL-like link
        // semantics, so removing it cannot touch another claimant or owner.
        unlinkSync(reclaimPath);
        syncDirectory(dirname(path));
      } catch {
        // Cleanup uncertainty remains fail-closed.
      }
    }
    // A leftover or concurrent claim is intentionally not stolen: availability
    // can be repaired by an operator, whereas guessing could delete a new
    // owner's coordination file.
    throw new ProjectTemplateCoordinationError();
  }
}

function acquireCoordinationFile(path: string): {
  token: string;
  pid: number;
  release(): void;
} {
  const token = randomUUID();
  try {
    createClaimSafeCoordinationFile(path, token);
  } catch (error) {
    if (!(error instanceof RetryableCoordinationMainExistsError)) {
      throw new ProjectTemplateCoordinationError();
    }
    if (!reclaimDeadCoordinationFile(path)) {
      throw new ProjectTemplateCoordinationError();
    }
    try {
      createClaimSafeCoordinationFile(path, token);
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
  publishRunningEvidence: (permit: ProjectTemplateRunStartPermit) => Result,
): Result {
  const repoPath = resolve(repoPathValue);
  const controlRoot = ensureControlRoot(repoPath);
  const mutexPath = resolveProjectTemplateRunStartMutexPath(repoPath);
  if (dirname(mutexPath) !== controlRoot) {
    throw new ProjectTemplateCoordinationError();
  }
  const mutex = acquireCoordinationFile(mutexPath);
  const permit = Object.freeze({
    repoPath,
    lockPath: mutexPath,
    token: mutex.token,
    pid: mutex.pid,
  }) satisfies ProjectTemplateRunStartPermit;
  activeRunStartPermits.add(permit);
  try {
    try {
      assertProjectTemplateApplyLeaseAvailable(repoPath);
    } catch {
      throw new ProjectTemplateCoordinationError();
    }
    return publishRunningEvidence(permit);
  } finally {
    activeRunStartPermits.delete(permit);
    mutex.release();
  }
}

/**
 * Proves that a run-start capability still owns the durable mutex immediately
 * before running evidence is published. A delayed/custom executor must fail
 * closed once the callback that issued its capability has returned.
 */
export function assertProjectTemplateRunStartPermitOwned(
  repoPathValue: string,
  permit: ProjectTemplateRunStartPermit,
): void {
  const repoPath = resolve(repoPathValue);
  const lockPath = resolveProjectTemplateRunStartMutexPath(repoPath);
  if (
    !activeRunStartPermits.has(permit)
    ||
    permit.repoPath !== repoPath
    || permit.lockPath !== lockPath
    || permit.pid !== process.pid
  ) {
    throw new ProjectTemplateCoordinationError();
  }
  const read = readProjectTemplateJsonStrict(lockPath);
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
    || value['token'] !== permit.token
    || value['pid'] !== permit.pid
  ) {
    throw new ProjectTemplateCoordinationError();
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
