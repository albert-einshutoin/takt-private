import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
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

interface CoordinationNamespaceRecord {
  readonly version: 2;
  readonly token: string;
  readonly pid: number;
  readonly operation: 'publish' | 'reclaim';
  readonly mainToken?: string;
  readonly target?: {
    readonly device: string;
    readonly inode: string;
    readonly token: string;
    readonly pid: number;
  };
}

function readCoordinationNamespace(
  path: string,
): CoordinationNamespaceRecord | undefined {
  const read = readProjectTemplateJsonStrict(path);
  if (
    read.kind !== 'value'
    || typeof read.value !== 'object'
    || read.value === null
    || Array.isArray(read.value)
  ) {
    return undefined;
  }
  const value = read.value as Record<string, unknown>;
  if (
    value['version'] !== 2
    || typeof value['token'] !== 'string'
    || value['token'].trim().length === 0
    || value['token'].length > 512
    || !Number.isSafeInteger(value['pid'])
    || (value['pid'] as number) <= 0
    || (value['operation'] !== 'publish' && value['operation'] !== 'reclaim')
  ) {
    return undefined;
  }
  if (value['operation'] === 'publish') {
    if (
      typeof value['mainToken'] !== 'string'
      || value['mainToken'].trim().length === 0
      || value['mainToken'].length > 512
      || value['target'] !== undefined
    ) {
      return undefined;
    }
    return {
      version: 2,
      token: value['token'],
      pid: value['pid'] as number,
      operation: 'publish',
      mainToken: value['mainToken'],
    };
  }
  const target = value['target'];
  if (
    value['mainToken'] !== undefined
    || typeof target !== 'object'
    || target === null
    || Array.isArray(target)
  ) {
    return undefined;
  }
  const targetRecord = target as Record<string, unknown>;
  if (
    typeof targetRecord['device'] !== 'string'
    || targetRecord['device'].length === 0
    || typeof targetRecord['inode'] !== 'string'
    || targetRecord['inode'].length === 0
    || typeof targetRecord['token'] !== 'string'
    || targetRecord['token'].trim().length === 0
    || targetRecord['token'].length > 512
    || !Number.isSafeInteger(targetRecord['pid'])
    || (targetRecord['pid'] as number) <= 0
  ) {
    return undefined;
  }
  return {
    version: 2,
    token: value['token'],
    pid: value['pid'] as number,
    operation: 'reclaim',
    target: {
      device: targetRecord['device'],
      inode: targetRecord['inode'],
      token: targetRecord['token'],
      pid: targetRecord['pid'] as number,
    },
  };
}

function readCoordinationOwner(
  path: string,
): { token: string; pid: number } | undefined {
  const read = readProjectTemplateJsonStrict(path);
  if (
    read.kind !== 'value'
    || typeof read.value !== 'object'
    || read.value === null
    || Array.isArray(read.value)
  ) {
    return undefined;
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
    return undefined;
  }
  return { token: value['token'], pid: value['pid'] as number };
}

interface CoordinationRecoveryRecord {
  readonly version: 3;
  readonly token: string;
  readonly pid: number;
  readonly operation: 'namespace-recovery';
  readonly namespaceToken: string;
}

export interface ProjectTemplateCoordinationRecoveryReport {
  readonly status: 'none' | 'recoverable' | 'recovered' | 'blocked';
  readonly paths: readonly string[];
}

export interface ProjectTemplateCoordinationRecoveryOptions {
  readonly apply: boolean;
  readonly probeProcess?: (pid: number) => 'alive' | 'dead' | 'unknown';
}

function readCoordinationRecovery(
  path: string,
): CoordinationRecoveryRecord | undefined {
  const read = readProjectTemplateJsonStrict(path);
  if (
    read.kind !== 'value'
    || typeof read.value !== 'object'
    || read.value === null
    || Array.isArray(read.value)
  ) {
    return undefined;
  }
  const value = read.value as Record<string, unknown>;
  if (
    value['version'] !== 3
    || typeof value['token'] !== 'string'
    || value['token'].trim().length === 0
    || value['token'].length > 512
    || !Number.isSafeInteger(value['pid'])
    || (value['pid'] as number) <= 0
    || value['operation'] !== 'namespace-recovery'
    || typeof value['namespaceToken'] !== 'string'
    || value['namespaceToken'].trim().length === 0
    || value['namespaceToken'].length > 512
  ) {
    return undefined;
  }
  return {
    version: 3,
    token: value['token'],
    pid: value['pid'] as number,
    operation: 'namespace-recovery',
    namespaceToken: value['namespaceToken'],
  };
}

function probeCoordinationProcess(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    return isProcessAlive(pid) ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}

function completeCoordinationNamespaceRecovery(
  mainPath: string,
  reclaimPath: string,
  namespace: CoordinationNamespaceRecord,
  recoveryPath: string,
  recovery: CoordinationRecoveryRecord,
): void {
  const confirmedRecovery = readCoordinationRecovery(recoveryPath);
  const confirmedNamespace = readCoordinationNamespace(reclaimPath);
  if (
    confirmedRecovery === undefined
    || JSON.stringify(confirmedRecovery) !== JSON.stringify(recovery)
    || confirmedNamespace === undefined
    || JSON.stringify(confirmedNamespace) !== JSON.stringify(namespace)
    || recovery.namespaceToken !== namespace.token
  ) {
    throw new ProjectTemplateCoordinationError();
  }

  let mainStat: ReturnType<typeof lstatSync> | undefined;
  try {
    mainStat = lstatSync(mainPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ProjectTemplateCoordinationError();
    }
  }
  if (mainStat !== undefined) {
    const owner = readCoordinationOwner(mainPath);
    const matches = namespace.operation === 'publish'
      ? owner?.token === namespace.mainToken && owner?.pid === namespace.pid
      : namespace.target !== undefined
        && owner?.token === namespace.target.token
        && owner?.pid === namespace.target.pid
        && String(mainStat.dev) === namespace.target.device
        && String(mainStat.ino) === namespace.target.inode;
    if (
      !matches
      || !mainStat.isFile()
      || mainStat.isSymbolicLink()
      || mainStat.nlink !== 1
    ) {
      throw new ProjectTemplateCoordinationError();
    }
    unlinkSync(mainPath);
    syncDirectory(dirname(mainPath));
  }
  removeOwnedCoordinationFile(reclaimPath, namespace.token, 2);
  removeOwnedCoordinationFile(recoveryPath, recovery.token, 3);
}

function recoverDeadCoordinationNamespace(
  mainPath: string,
  reclaimPath: string,
): boolean {
  const recoveryPath = `${reclaimPath}.recovery`;
  if (existsSync(recoveryPath)) {
    // Recovery ownership is never stolen automatically. This is the terminal
    // level that prevents crash handling from creating an unbounded chain of
    // progressively deeper recovery locks.
    throw new ProjectTemplateCoordinationError();
  }
  const namespace = readCoordinationNamespace(reclaimPath);
  if (namespace === undefined) {
    throw new ProjectTemplateCoordinationError();
  }
  try {
    if (isProcessAlive(namespace.pid)) return false;
  } catch {
    throw new ProjectTemplateCoordinationError();
  }

  const recoveryToken = randomUUID();
  try {
    createDurableJsonFile(recoveryPath, {
      version: 3,
      token: recoveryToken,
      pid: process.pid,
      operation: 'namespace-recovery',
      namespaceToken: namespace.token,
    });
  } catch {
    throw new ProjectTemplateCoordinationError();
  }

  try {
    const confirmedNamespace = readCoordinationNamespace(reclaimPath);
    if (
      confirmedNamespace === undefined
      || JSON.stringify(confirmedNamespace) !== JSON.stringify(namespace)
    ) {
      throw new ProjectTemplateCoordinationError();
    }
    try {
      if (isProcessAlive(namespace.pid)) {
        throw new ProjectTemplateCoordinationError();
      }
    } catch (error) {
      if (error instanceof ProjectTemplateCoordinationError) throw error;
      throw new ProjectTemplateCoordinationError();
    }

    completeCoordinationNamespaceRecovery(
      mainPath,
      reclaimPath,
      namespace,
      recoveryPath,
      {
        version: 3,
        token: recoveryToken,
        pid: process.pid,
        operation: 'namespace-recovery',
        namespaceToken: namespace.token,
      },
    );
    return true;
  } catch {
    // The v3 owner is intentionally retained on every uncertain failure. The
    // explicit recovery flow below can resume it after proving this PID dead.
    throw new ProjectTemplateCoordinationError();
  }
}

/**
 * Resume a terminal v3 recovery owner from the explicit operator recovery flow.
 *
 * Normal TAKT/apply processes remain blocked by v3, so only operator recovery
 * can enter here. As with the existing personal recovery mutations, callers
 * must serialize explicit recovery commands; portable Node filesystem APIs do
 * not provide a crash-recoverable conditional unlink primitive.
 */
export function recoverAbandonedProjectTemplateCoordinationClaimsForRecovery(
  repoPathValue: string,
  options: ProjectTemplateCoordinationRecoveryOptions,
): ProjectTemplateCoordinationRecoveryReport {
  const repoPath = resolve(repoPathValue);
  const probeProcess = options.probeProcess ?? probeCoordinationProcess;
  const candidates = [
    resolveProjectTemplateRunStartMutexPath(repoPath),
    resolveProjectTemplateApplyLeasePath(repoPath),
  ].map((mainPath) => ({
    mainPath,
    reclaimPath: `${mainPath}.reclaim`,
    recoveryPath: `${mainPath}.reclaim.recovery`,
  }));
  const present = candidates.filter(({ recoveryPath }) => existsSync(recoveryPath));
  if (present.length === 0) return { status: 'none', paths: [] };

  const inspected = present.map((candidate) => {
    const recovery = readCoordinationRecovery(candidate.recoveryPath);
    let processState: 'alive' | 'dead' | 'unknown' = 'unknown';
    if (recovery !== undefined) {
      try {
        processState = probeProcess(recovery.pid);
      } catch {
        processState = 'unknown';
      }
    }
    const namespace = readCoordinationNamespace(candidate.reclaimPath);
    const namespaceMatches = namespace === undefined
      ? !existsSync(candidate.reclaimPath) && !existsSync(candidate.mainPath)
      : recovery?.namespaceToken === namespace.token;
    return {
      ...candidate,
      recovery,
      namespace,
      recoverable: recovery !== undefined
        && processState === 'dead'
        && namespaceMatches,
    };
  });
  if (inspected.some((entry) => !entry.recoverable)) {
    return {
      status: 'blocked',
      paths: inspected.map((entry) => entry.recoveryPath),
    };
  }
  if (!options.apply) {
    return {
      status: 'recoverable',
      paths: inspected.map((entry) => entry.recoveryPath),
    };
  }

  for (const entry of inspected) {
    const recovery = readCoordinationRecovery(entry.recoveryPath);
    if (
      recovery === undefined
      || JSON.stringify(recovery) !== JSON.stringify(entry.recovery)
    ) {
      throw new ProjectTemplateCoordinationError();
    }
    let processState: 'alive' | 'dead' | 'unknown';
    try {
      processState = probeProcess(recovery.pid);
    } catch {
      processState = 'unknown';
    }
    if (processState !== 'dead') {
      throw new ProjectTemplateCoordinationError();
    }
    const namespace = readCoordinationNamespace(entry.reclaimPath);
    if (namespace === undefined) {
      if (existsSync(entry.reclaimPath) || existsSync(entry.mainPath)) {
        throw new ProjectTemplateCoordinationError();
      }
      removeOwnedCoordinationFile(entry.recoveryPath, recovery.token, 3);
      continue;
    }
    completeCoordinationNamespaceRecovery(
      entry.mainPath,
      entry.reclaimPath,
      namespace,
      entry.recoveryPath,
      recovery,
    );
  }
  return {
    status: 'recovered',
    paths: inspected.map((entry) => entry.recoveryPath),
  };
}

function createClaimSafeCoordinationFile(path: string, token: string): void {
  const reclaimPath = `${path}.reclaim`;
  const recoveryPath = `${reclaimPath}.recovery`;
  const namespaceToken = randomUUID();
  if (existsSync(recoveryPath)) {
    throw new ProjectTemplateCoordinationError();
  }
  if (existsSync(reclaimPath)) {
    if (!recoverDeadCoordinationNamespace(path, reclaimPath)) {
      throw new ProjectTemplateCoordinationError();
    }
  }
  try {
    createDurableJsonFile(reclaimPath, {
      version: 2,
      token: namespaceToken,
      pid: process.pid,
      operation: 'publish',
      mainToken: token,
    } satisfies CoordinationNamespaceRecord);
  } catch {
    throw new ProjectTemplateCoordinationError();
  }
  try {
    createCoordinationFile(path, token);
  } catch (error) {
    try {
      removeOwnedCoordinationFile(reclaimPath, namespaceToken, 2);
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
    removeOwnedCoordinationFile(reclaimPath, namespaceToken, 2);
  } catch {
    try {
      removeOwnedCoordinationFile(path, token);
    } catch {
      // Leaving an ambiguous owned main path is safer than retrying publication
      // after namespace durability became uncertain.
    }
    try {
      removeOwnedCoordinationFile(reclaimPath, namespaceToken, 2);
    } catch {
      // A durable reservation is safer than guessing about its ownership.
    }
    throw new ProjectTemplateCoordinationError();
  }
}

function removeOwnedCoordinationFile(
  path: string,
  token: string,
  version = 1,
): void {
  const read = readProjectTemplateJsonStrict(path);
  if (read.kind !== 'value') {
    throw new ProjectTemplateCoordinationError();
  }
  const value = read.value;
  if (
    typeof value !== 'object'
    || value === null
    || (value as Record<string, unknown>)['version'] !== version
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
  const reclaimPath = `${path}.reclaim`;
  if (existsSync(`${reclaimPath}.recovery`)) {
    throw new ProjectTemplateCoordinationError();
  }
  if (existsSync(reclaimPath)) {
    return recoverDeadCoordinationNamespace(path, reclaimPath);
  }
  let observed: Stats;
  try {
    observed = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new ProjectTemplateCoordinationError();
  }
  const owner = readCoordinationOwner(path);
  if (owner === undefined) {
    throw new ProjectTemplateCoordinationError();
  }
  try {
    if (isProcessAlive(owner.pid)) return false;
  } catch {
    throw new ProjectTemplateCoordinationError();
  }
  const namespaceToken = randomUUID();
  try {
    createDurableJsonFile(reclaimPath, {
      version: 2,
      token: namespaceToken,
      pid: process.pid,
      operation: 'reclaim',
      target: {
        device: String(observed.dev),
        inode: String(observed.ino),
        token: owner.token,
        pid: owner.pid,
      },
    } satisfies CoordinationNamespaceRecord);
  } catch {
    throw new ProjectTemplateCoordinationError();
  }
  let mainUnlinked = false;
  try {
    const current = lstatSync(path);
    const currentOwner = readCoordinationOwner(path);
    if (
      !observed.isFile()
      || observed.isSymbolicLink()
      || observed.nlink !== 1
      || current.dev !== observed.dev
      || current.ino !== observed.ino
      || current.nlink !== 1
      || currentOwner?.token !== owner.token
      || currentOwner?.pid !== owner.pid
    ) {
      throw new ProjectTemplateCoordinationError();
    }
    unlinkSync(path);
    mainUnlinked = true;
    syncDirectory(dirname(path));
    removeOwnedCoordinationFile(reclaimPath, namespaceToken, 2);
    return true;
  } catch {
    if (!mainUnlinked) {
      try {
        removeOwnedCoordinationFile(reclaimPath, namespaceToken, 2);
      } catch {
        // A durable namespace is safer than guessing about its ownership.
      }
    }
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
