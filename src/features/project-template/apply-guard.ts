import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { isProcessAlive } from '../../infra/task/process.js';
import { parseProjectTemplateApplyJournal } from './apply-storage.js';

const DEFAULT_STALE_AFTER_MINUTES = 180;
const MAX_GUARD_JSON_BYTES = 1024 * 1024;
const MAX_GUARD_DIRECTORY_ENTRIES = 8_192;

export type ProjectTemplateApplyGuardBlockCode =
  | 'GUARD_INPUT_INVALID'
  | 'RUNS_DIRECTORY_UNREADABLE'
  | 'RUN_METADATA_MISSING'
  | 'RUN_METADATA_UNREADABLE'
  | 'RUN_METADATA_INVALID'
  | 'ACTIVE_RUN'
  | 'STALE_RUN'
  | 'LIFECYCLE_STATE_UNREADABLE'
  | 'LIFECYCLE_STATE_INVALID'
  | 'STOP_REQUEST_UNREADABLE'
  | 'STOP_REQUEST_INVALID'
  | 'STOP_REQUEST_PRESENT'
  | 'PERSONAL_DAEMON_RUNNING'
  | 'PROCESS_IDENTITY_UNKNOWN'
  | 'APPLY_LEASE_PRESENT'
  | 'APPLY_LEASE_UNKNOWN'
  | 'PERSISTENT_AUTOMATION_PRESENT'
  | 'PERSISTENT_AUTOMATION_UNKNOWN'
  | 'RECOVERY_REQUIRED'
  | 'RECOVERY_REQUIRED_UNKNOWN';

interface ApplyGuardBlockBase {
  message: string;
  path?: string;
}

export interface ProjectTemplateApplyGuardGeneralBlock extends ApplyGuardBlockBase {
  code: Exclude<
    ProjectTemplateApplyGuardBlockCode,
    | ProjectTemplateApplyGuardRunBlock['code']
    | ProjectTemplateApplyGuardProcessBlock['code']
  >;
}

export interface ProjectTemplateApplyGuardRunBlock extends ApplyGuardBlockBase {
  code:
    | 'RUN_METADATA_MISSING'
    | 'RUN_METADATA_UNREADABLE'
    | 'RUN_METADATA_INVALID'
    | 'ACTIVE_RUN'
    | 'STALE_RUN';
  slug: string;
}

export interface ProjectTemplateApplyGuardProcessBlock extends ApplyGuardBlockBase {
  code: 'PERSONAL_DAEMON_RUNNING' | 'PROCESS_IDENTITY_UNKNOWN';
  pid: number;
}

export type ProjectTemplateApplyGuardBlock =
  | ProjectTemplateApplyGuardGeneralBlock
  | ProjectTemplateApplyGuardRunBlock
  | ProjectTemplateApplyGuardProcessBlock;

export type ProjectTemplateProcessProbeResult = 'alive' | 'dead' | 'unknown';

export interface ProjectTemplateApplyLeaseIdentity {
  lockPath: string;
  token: string;
  pid: number;
}

export interface InspectProjectTemplateApplyGuardOptions {
  repoPath?: string;
  staleAfterMinutes?: number;
  now?: Date;
  /**
   * Injectable so callers can supply a stronger platform-specific identity
   * check and tests do not need to spawn a real daemon.
   */
  probeProcess?: (pid: number) => ProjectTemplateProcessProbeResult;
  /**
   * Apply may re-run the guard after taking the exclusive lease. The lease is
   * ignored only when both its canonical path and durable token match.
   */
  ownedLease?: ProjectTemplateApplyLeaseIdentity;
}

export interface ProjectTemplateApplyGuardReport {
  status: 'pass' | 'blocked';
  passed: boolean;
  repoPath: string;
  checkedAt: string;
  staleAfterMinutes: number;
  blocks: ProjectTemplateApplyGuardBlock[];
}

interface StrictRunMeta {
  status: 'running' | 'completed' | 'aborted' | 'failed';
  startTime: string;
  updatedAt?: string;
}

interface StrictPersonalDaemonState {
  pid: number;
}

export interface ProjectTemplateStrictJsonReadResult {
  kind: 'missing' | 'unreadable' | 'invalid' | 'value';
  value?: unknown;
}

export class ProjectTemplateApplyLeaseUnavailableError extends Error {
  readonly code:
    | 'APPLY_LEASE_PRESENT'
    | 'APPLY_LEASE_UNKNOWN'
    | 'RECOVERY_REQUIRED'
    | 'RECOVERY_REQUIRED_UNKNOWN';
  readonly lockPath: string;

  constructor(
    code:
      | 'APPLY_LEASE_PRESENT'
      | 'APPLY_LEASE_UNKNOWN'
      | 'RECOVERY_REQUIRED'
      | 'RECOVERY_REQUIRED_UNKNOWN',
    lockPath: string,
  ) {
    super(
      code === 'APPLY_LEASE_PRESENT'
        ? 'project template apply lease is already held'
        : code === 'RECOVERY_REQUIRED'
          ? 'project template recovery is required'
          : 'project template coordination state cannot be proven safe',
    );
    this.name = 'ProjectTemplateApplyLeaseUnavailableError';
    this.code = code;
    this.lockPath = lockPath;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Number.isFinite(Date.parse(value));
}

function areFileStatsEqual(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/**
 * Reads bounded coordination/runtime JSON from the opened file descriptor.
 * Path-based reads are intentionally avoided so symlinks, hardlinks and
 * replacements during inspection cannot be accepted as durable truth.
 */
export function readProjectTemplateJsonStrict(
  filePath: string,
): ProjectTemplateStrictJsonReadResult {
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }

  let result: ProjectTemplateStrictJsonReadResult;
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.size < 0
      || before.size > MAX_GUARD_JSON_BYTES
    ) {
      result = { kind: 'unreadable' };
    } else {
      const content = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < content.byteLength) {
        const bytesRead = readSync(
          fd,
          content,
          offset,
          content.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) throw new Error('guard evidence changed while reading');
        offset += bytesRead;
      }
      const extra = Buffer.alloc(1);
      const extraBytes = readSync(fd, extra, 0, 1, offset);
      const after = fstatSync(fd);
      if (extraBytes !== 0 || !areFileStatsEqual(before, after)) {
        result = { kind: 'unreadable' };
      } else {
        const raw = content.toString('utf8');
        if (raw.trim().length === 0) {
          result = { kind: 'invalid' };
        } else {
          try {
            result = { kind: 'value', value: JSON.parse(raw) as unknown };
          } catch {
            result = { kind: 'invalid' };
          }
        }
      }
    }
  } catch {
    result = { kind: 'unreadable' };
  }
  try {
    closeSync(fd);
  } catch {
    result = { kind: 'unreadable' };
  }
  return result;
}

export function resolveProjectTemplateApplyLeasePath(repoPath: string): string {
  return join(resolve(repoPath), '.takt-template-state', 'apply.lock');
}

export function resolveProjectTemplateRunStartMutexPath(repoPath: string): string {
  return join(resolve(repoPath), '.takt-template-state', 'run-start.lock');
}

export function resolveProjectTemplateRecoveryRequiredPath(repoPath: string): string {
  return join(resolve(repoPath), '.takt-template-state', 'recovery-required.json');
}

function parseLeaseIdentity(
  value: unknown,
): Pick<ProjectTemplateApplyLeaseIdentity, 'token' | 'pid'> | undefined {
  if (
    !isRecord(value)
    || value['version'] !== 1
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

function isValidRecoveryRequiredMarker(value: unknown): boolean {
  return isRecord(value)
    && value['version'] === 1
    && typeof value['token'] === 'string'
    && value['token'].trim().length > 0
    && value['token'].length <= 512
    && typeof value['transactionId'] === 'string'
    && value['transactionId'].trim().length > 0
    && value['transactionId'].length <= 512;
}

function recoveryJournalState(value: unknown): string | undefined {
  try {
    return parseProjectTemplateApplyJournal(value).state;
  } catch {
    return undefined;
  }
}

function inspectRecoveryRequired(
  repoPath: string,
): ProjectTemplateApplyGuardBlock[] {
  const blocks: ProjectTemplateApplyGuardBlock[] = [];
  const markerPath = resolveProjectTemplateRecoveryRequiredPath(repoPath);
  const markerRead = readProjectTemplateJsonStrict(markerPath);
  if (
    markerRead.kind !== 'missing'
    && (markerRead.kind !== 'value'
      || !isValidRecoveryRequiredMarker(markerRead.value))
  ) {
    blocks.push({
      code: 'RECOVERY_REQUIRED_UNKNOWN',
      message: 'project template recovery marker cannot be proven safe',
      path: markerPath,
    });
  } else if (markerRead.kind === 'value') {
    blocks.push({
      code: 'RECOVERY_REQUIRED',
      message: 'project template recovery must complete before more writes',
      path: markerPath,
    });
  }

  // A process can terminate after a durable mutation intent but before it can
  // write the explicit marker. The journal is therefore also a truth source:
  // non-terminal state must block every later writer until recovery converges.
  const journalPath = join(resolve(repoPath), '.takt-template-state', 'journal.json');
  const journalRead = readProjectTemplateJsonStrict(journalPath);
  if (journalRead.kind !== 'missing') {
    const state = journalRead.kind === 'value'
      ? recoveryJournalState(journalRead.value)
      : undefined;
    if (state === undefined) {
      blocks.push({
        code: 'RECOVERY_REQUIRED_UNKNOWN',
        message: 'project template recovery journal cannot be proven safe',
        path: journalPath,
      });
    } else if (state !== 'committed' && state !== 'rolled-back') {
      blocks.push({
        code: 'RECOVERY_REQUIRED',
        message: 'project template recovery journal is not terminal',
        path: journalPath,
      });
    }
  }
  return blocks;
}

function inspectApplyLease(
  repoPath: string,
  ownedLease: ProjectTemplateApplyLeaseIdentity | undefined,
): ProjectTemplateApplyGuardBlock[] {
  const lockPath = resolveProjectTemplateApplyLeasePath(repoPath);
  if (
    ownedLease !== undefined
    && (
      resolve(ownedLease.lockPath) !== lockPath
      || ownedLease.token.trim().length === 0
      || ownedLease.token.length > 512
      || !Number.isSafeInteger(ownedLease.pid)
      || ownedLease.pid <= 0
    )
  ) {
    return [{
      code: 'APPLY_LEASE_UNKNOWN',
      message: 'claimed project template apply lease identity is invalid',
      path: lockPath,
    }];
  }

  const read = readProjectTemplateJsonStrict(lockPath);
  if (read.kind === 'missing') {
    return ownedLease === undefined
      ? []
      : [{
        code: 'APPLY_LEASE_UNKNOWN',
        message: 'claimed project template apply lease is not durable',
        path: lockPath,
      }];
  }
  if (read.kind !== 'value') {
    return [{
      code: 'APPLY_LEASE_UNKNOWN',
      message: 'project template apply lease cannot be read safely',
      path: lockPath,
    }];
  }
  const identity = parseLeaseIdentity(read.value);
  if (identity === undefined) {
    return [{
      code: 'APPLY_LEASE_UNKNOWN',
      message: 'project template apply lease does not match the required schema',
      path: lockPath,
    }];
  }
  if (
    ownedLease !== undefined
    && identity.token === ownedLease.token
    && identity.pid === ownedLease.pid
  ) return [];
  return [{
    code: ownedLease === undefined ? 'APPLY_LEASE_PRESENT' : 'APPLY_LEASE_UNKNOWN',
    message: ownedLease === undefined
      ? 'a project template apply lease is already held'
      : 'project template apply lease belongs to a different operation',
    path: lockPath,
  }];
}

/**
 * Run/daemon startup uses this before publishing running state. A crash-left
 * lock intentionally blocks startup until an operator resolves it.
 */
export function assertProjectTemplateApplyLeaseAvailable(repoPath: string): void {
  const resolvedRepoPath = resolve(repoPath);
  const [block] = [
    ...inspectRecoveryRequired(resolvedRepoPath),
    ...inspectApplyLease(resolvedRepoPath, undefined),
  ];
  if (block === undefined) return;
  throw new ProjectTemplateApplyLeaseUnavailableError(
    block.code === 'APPLY_LEASE_PRESENT'
      || block.code === 'RECOVERY_REQUIRED'
      || block.code === 'RECOVERY_REQUIRED_UNKNOWN'
      ? block.code
      : 'APPLY_LEASE_UNKNOWN',
    block.path ?? resolveProjectTemplateApplyLeasePath(repoPath),
  );
}

function parseRunMeta(value: unknown): StrictRunMeta | undefined {
  if (!isRecord(value)) return undefined;
  const status = value['status'];
  if (
    status !== 'running'
    && status !== 'completed'
    && status !== 'aborted'
    && status !== 'failed'
  ) {
    return undefined;
  }
  if (
    typeof value['task'] !== 'string'
    || value['task'].trim().length === 0
    || typeof value['workflow'] !== 'string'
    || value['workflow'].trim().length === 0
    || !isIsoTimestamp(value['startTime'])
    || (value['updatedAt'] !== undefined && !isIsoTimestamp(value['updatedAt']))
  ) {
    return undefined;
  }
  return {
    status,
    startTime: value['startTime'],
    ...(value['updatedAt'] === undefined ? {} : { updatedAt: value['updatedAt'] }),
  };
}

function parseDaemonState(
  value: unknown,
  repoPath: string,
): StrictPersonalDaemonState | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value['version'] !== 1
    || !Number.isSafeInteger(value['pid'])
    || (value['pid'] as number) <= 0
    || !isIsoTimestamp(value['startedAt'])
    || !isIsoTimestamp(value['updatedAt'])
    || typeof value['repoPath'] !== 'string'
    || resolve(value['repoPath']) !== repoPath
    || value['command'] !== 'devloopd start'
    || value['status'] !== 'running'
    || !Number.isSafeInteger(value['cycleCount'])
    || (value['cycleCount'] as number) < 0
  ) {
    return undefined;
  }
  return { pid: value['pid'] as number };
}

function isValidStopRequest(value: unknown): boolean {
  return isRecord(value)
    && value['version'] === 1
    && isIsoTimestamp(value['requestedAt'])
    && typeof value['reason'] === 'string'
    && value['reason'].trim().length > 0;
}

function inspectRuns(
  repoPath: string,
  now: Date,
  staleAfterMinutes: number,
): ProjectTemplateApplyGuardBlock[] {
  const runsDir = join(repoPath, '.takt', 'runs');
  let entries: Dirent<string>[];
  try {
    entries = readDirectoryEntriesBounded(runsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{
      code: 'RUNS_DIRECTORY_UNREADABLE',
      message: 'TAKT run directory cannot be inspected safely',
      path: runsDir,
    }];
  }

  const blocks: ProjectTemplateApplyGuardBlock[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      // A symlink can hide a live run outside the inspected tree. Ordinary
      // files are not run records and remain irrelevant.
      if (entry.isSymbolicLink()) {
        blocks.push({
          code: 'RUN_METADATA_UNREADABLE',
          message: 'TAKT run entry is not a safely inspectable directory',
          path: join(runsDir, entry.name),
          slug: entry.name,
        });
      }
      continue;
    }
    const metaPath = join(runsDir, entry.name, 'meta.json');
    const read = readProjectTemplateJsonStrict(metaPath);
    if (read.kind !== 'value') {
      const code = read.kind === 'missing'
        ? 'RUN_METADATA_MISSING'
        : read.kind === 'unreadable'
          ? 'RUN_METADATA_UNREADABLE'
          : 'RUN_METADATA_INVALID';
      blocks.push({
        code,
        message: `TAKT run metadata is ${read.kind}`,
        path: metaPath,
        slug: entry.name,
      });
      continue;
    }
    const meta = parseRunMeta(read.value);
    if (meta === undefined) {
      blocks.push({
        code: 'RUN_METADATA_INVALID',
        message: 'TAKT run metadata does not match the required schema',
        path: metaPath,
        slug: entry.name,
      });
      continue;
    }
    if (meta.status !== 'running') continue;
    const lastProgressAt = meta.updatedAt ?? meta.startTime;
    const idleMinutes = Math.max(
      0,
      Math.floor((now.getTime() - Date.parse(lastProgressAt)) / 60_000),
    );
    const stale = idleMinutes >= staleAfterMinutes;
    blocks.push({
      code: stale ? 'STALE_RUN' : 'ACTIVE_RUN',
      message: stale
        ? 'stale running TAKT metadata requires explicit recovery before apply'
        : 'an active TAKT run blocks project template apply',
      path: metaPath,
      slug: entry.name,
    });
  }
  return blocks;
}

function areDirectoryStatsEqual(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readDirectoryEntriesBounded(path: string): Dirent<string>[] {
  const directory = opendirSync(path);
  const entries: Dirent<string>[] = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) return entries;
      if (entries.length >= MAX_GUARD_DIRECTORY_ENTRIES) {
        throw new Error('guard directory entry limit exceeded');
      }
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
}

function inspectPersistentAutomation(
  repoPath: string,
): ProjectTemplateApplyGuardBlock[] {
  const schedulesPath = join(repoPath, '.devloop', 'schedules');
  let before: Stats;
  try {
    before = lstatSync(schedulesPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? []
      : [{
        code: 'PERSISTENT_AUTOMATION_UNKNOWN',
        message: 'persistent automation schedules cannot be inspected safely',
        path: schedulesPath,
      }];
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    return [{
      code: 'PERSISTENT_AUTOMATION_UNKNOWN',
      message: 'persistent automation schedules path is not a safe directory',
      path: schedulesPath,
    }];
  }

  let entryCount: number;
  let after: Stats;
  try {
    entryCount = readDirectoryEntriesBounded(schedulesPath).length;
    after = lstatSync(schedulesPath);
  } catch {
    return [{
      code: 'PERSISTENT_AUTOMATION_UNKNOWN',
      message: 'persistent automation schedules cannot be read safely',
      path: schedulesPath,
    }];
  }
  // Re-check identity and directory metadata so a concurrent replacement or
  // schedule mutation is unknown instead of being mistaken for an empty set.
  if (
    after.isSymbolicLink()
    || !after.isDirectory()
    || !areDirectoryStatsEqual(before, after)
  ) {
    return [{
      code: 'PERSISTENT_AUTOMATION_UNKNOWN',
      message: 'persistent automation schedules changed during inspection',
      path: schedulesPath,
    }];
  }
  return entryCount === 0
    ? []
    : [{
      code: 'PERSISTENT_AUTOMATION_PRESENT',
      message: 'persistent automation schedules block project template apply',
      path: schedulesPath,
    }];
}

function defaultProbeProcess(pid: number): ProjectTemplateProcessProbeResult {
  return isProcessAlive(pid) ? 'alive' : 'dead';
}

function inspectLifecycle(
  repoPath: string,
  probeProcess: (pid: number) => ProjectTemplateProcessProbeResult,
): ProjectTemplateApplyGuardBlock[] {
  const stateDir = join(repoPath, '.devloop', 'daemon');
  const statePath = join(stateDir, 'state.json');
  const stopRequestPath = join(stateDir, 'stop-request.json');
  const blocks: ProjectTemplateApplyGuardBlock[] = [];

  const stateRead = readProjectTemplateJsonStrict(statePath);
  if (stateRead.kind === 'unreadable') {
    blocks.push({
      code: 'LIFECYCLE_STATE_UNREADABLE',
      message: 'personal daemon lifecycle state cannot be read safely',
      path: statePath,
    });
  } else if (stateRead.kind === 'invalid') {
    blocks.push({
      code: 'LIFECYCLE_STATE_INVALID',
      message: 'personal daemon lifecycle state is invalid',
      path: statePath,
    });
  } else if (stateRead.kind === 'value') {
    const state = parseDaemonState(stateRead.value, repoPath);
    if (state === undefined) {
      blocks.push({
        code: 'LIFECYCLE_STATE_INVALID',
        message: 'personal daemon lifecycle state does not match this repository',
        path: statePath,
      });
    } else {
      let processState: ProjectTemplateProcessProbeResult = 'unknown';
      try {
        processState = probeProcess(state.pid);
      } catch {
        processState = 'unknown';
      }
      blocks.push(processState === 'alive'
        ? {
          code: 'PERSONAL_DAEMON_RUNNING',
          message: 'a personal daemon process blocks project template apply',
          path: statePath,
          pid: state.pid,
        }
        : {
          code: 'PROCESS_IDENTITY_UNKNOWN',
          message: 'personal daemon process identity cannot be proven safe',
          path: statePath,
          pid: state.pid,
        });
    }
  }

  const stopRead = readProjectTemplateJsonStrict(stopRequestPath);
  if (stopRead.kind === 'unreadable') {
    blocks.push({
      code: 'STOP_REQUEST_UNREADABLE',
      message: 'personal daemon stop request cannot be read safely',
      path: stopRequestPath,
    });
  } else if (stopRead.kind === 'invalid') {
    blocks.push({
      code: 'STOP_REQUEST_INVALID',
      message: 'personal daemon stop request is invalid',
      path: stopRequestPath,
    });
  } else if (stopRead.kind === 'value') {
    const valid = isValidStopRequest(stopRead.value);
    blocks.push({
      code: valid
        ? 'STOP_REQUEST_PRESENT'
        : 'STOP_REQUEST_INVALID',
      message: valid
        ? 'a personal daemon stop request remains pending'
        : 'personal daemon stop request does not match the required schema',
      path: stopRequestPath,
    });
  }
  return blocks;
}

/**
 * Reads durable runtime evidence without mutating it. Any evidence that cannot
 * be interpreted safely blocks apply, because treating unknown as idle could
 * race a workflow or personal automation process writing the same files.
 */
export function inspectProjectTemplateApplyGuard(
  options: InspectProjectTemplateApplyGuardOptions = {},
): ProjectTemplateApplyGuardReport {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const now = options.now ?? new Date();
  const staleAfterMinutes = options.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES;
  const blocks: ProjectTemplateApplyGuardBlock[] = [];
  if (
    !Number.isInteger(staleAfterMinutes)
    || staleAfterMinutes < 1
    || !Number.isFinite(now.getTime())
  ) {
    blocks.push({
      code: 'GUARD_INPUT_INVALID',
      message: 'apply guard time inputs must be valid',
    });
  } else {
    blocks.push(...inspectRecoveryRequired(repoPath));
    blocks.push(...inspectApplyLease(repoPath, options.ownedLease));
    blocks.push(...inspectPersistentAutomation(repoPath));
    blocks.push(...inspectRuns(repoPath, now, staleAfterMinutes));
    blocks.push(...inspectLifecycle(
      repoPath,
      options.probeProcess ?? defaultProbeProcess,
    ));
  }
  const passed = blocks.length === 0;
  return {
    status: passed ? 'pass' : 'blocked',
    passed,
    repoPath,
    checkedAt: Number.isFinite(now.getTime()) ? now.toISOString() : 'invalid',
    staleAfterMinutes,
    blocks,
  };
}
