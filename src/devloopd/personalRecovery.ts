import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { inspectActiveRuns, type ActiveRunRecord } from './activeRuns.js';
import { readRawDevloopLedgerEvents, resolveDevloopLedgerPath } from './ledger.js';
import { inspectPersonalLifecycle } from './personalLifecycle.js';
import { writeFileAtomic } from './stateStore.js';
import { isDebugLoggerRunSlug } from '../shared/utils/debug.js';
import { isValidReportDirName } from '../shared/utils/index.js';
import {
  recoverAbandonedProjectTemplateCoordinationClaimsForRecovery,
} from '../features/project-template/apply-lease.js';

export type PersonalRecoveryActionStatus = 'would_change' | 'changed' | 'skipped' | 'exists' | 'warn' | 'fail';

export interface PersonalRecoveryAction {
  status: PersonalRecoveryActionStatus;
  name: string;
  message: string;
  path?: string;
  detail?: string;
}

export interface PersonalRecoveryReport {
  passed: boolean;
  changed: boolean;
  apply: boolean;
  repoPath: string;
  actions: PersonalRecoveryAction[];
  nextActions: readonly string[];
}

export interface RunPersonalRecoveryOptions {
  repoPath?: string;
  apply?: boolean;
  staleAfterMinutes?: number;
  lockStaleMinutes?: number;
  worktreeStaleMinutes?: number;
  ledgerPath?: string;
  now?: Date;
  probeRunProcess?: (pid: number) => 'alive' | 'dead' | 'unknown';
  /** Internal race hook used by deterministic recovery fault tests. */
  beforeMissingRunRemoval?: (runPath: string) => void;
}

const DEFAULT_STALE_AFTER_MINUTES = 180;
const DEFAULT_LOCK_STALE_MINUTES = 10;
const DEFAULT_WORKTREE_STALE_MINUTES = 24 * 60;

function resolveRepoPath(repoPath: string | undefined): string {
  return resolve(repoPath ?? process.cwd());
}

function makeAction(
  status: PersonalRecoveryActionStatus,
  name: string,
  message: string,
  options: { path?: string; detail?: string } = {},
): PersonalRecoveryAction {
  return {
    status,
    name,
    message,
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
  };
}

function parsePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function recoverStaleRun(options: {
  repoPath: string;
  run: ActiveRunRecord;
  apply: boolean;
  now: Date;
  probeProcess: (pid: number) => 'alive' | 'dead' | 'unknown';
}): PersonalRecoveryAction {
  const metaPath = join(options.repoPath, '.takt', 'runs', options.run.slug, 'meta.json');
  if (!options.run.stale) {
    return makeAction('skipped', `active run ${options.run.slug}`, 'active run is not stale', { path: metaPath });
  }
  if (options.run.ownerPid !== undefined) {
    let processState: 'alive' | 'dead' | 'unknown';
    try {
      processState = options.probeProcess(options.run.ownerPid);
    } catch {
      processState = 'unknown';
    }
    if (processState === 'alive') {
      return makeAction('skipped', `active run ${options.run.slug}`, 'stale metadata owner process is still alive', {
        path: metaPath,
        detail: `pid ${options.run.ownerPid}`,
      });
    }
    if (processState === 'unknown') {
      return makeAction('fail', `stale run ${options.run.slug}`, 'run owner process identity cannot be proven dead', {
        path: metaPath,
        detail: `pid ${options.run.ownerPid}`,
      });
    }
  }
  if (!options.apply) {
    return makeAction('would_change', `stale run ${options.run.slug}`, 'would mark stale running metadata as aborted', {
      path: metaPath,
      detail: `idle ${options.run.idleMinutes}m`,
    });
  }

  const meta = readJsonRecord(metaPath);
  if (meta === undefined) {
    return makeAction('fail', `stale run ${options.run.slug}`, 'run metadata is unreadable', { path: metaPath });
  }
  if (
    meta['status'] !== 'running'
    || meta['updatedAt'] !== options.run.updatedAt
    || meta['ownerPid'] !== options.run.ownerPid
  ) {
    return makeAction('skipped', `active run ${options.run.slug}`, 'run metadata changed during stale recovery', {
      path: metaPath,
    });
  }
  if (options.run.ownerPid !== undefined) {
    let processState: 'alive' | 'dead' | 'unknown';
    try {
      processState = options.probeProcess(options.run.ownerPid);
    } catch {
      processState = 'unknown';
    }
    if (processState !== 'dead') {
      return makeAction(
        processState === 'unknown' ? 'fail' : 'skipped',
        `active run ${options.run.slug}`,
        processState === 'unknown'
          ? 'run owner process identity became unknown during recovery'
          : 'run owner process became live during recovery',
        { path: metaPath, detail: `pid ${options.run.ownerPid}` },
      );
    }
  }
  const updated = {
    ...meta,
    status: 'aborted',
    endTime: options.now.toISOString(),
    updatedAt: options.now.toISOString(),
    recoveryReason: 'stale active run recovered by devloopd recover-stale',
  };
  writeFileAtomic(metaPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  return makeAction('changed', `stale run ${options.run.slug}`, 'marked stale running metadata as aborted', {
    path: metaPath,
  });
}

function collectEmptyRunDirectories(path: string): string[] | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  const directories: string[] = [];
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return undefined;
    const nested = collectEmptyRunDirectories(child);
    if (nested === undefined) return undefined;
    directories.push(...nested);
  }
  directories.push(path);
  return directories;
}

interface RunsRootIdentity {
  readonly repoDevice: number;
  readonly repoInode: number;
  readonly taktDevice: number;
  readonly taktInode: number;
  readonly runsDevice?: number;
  readonly runsInode?: number;
}

type RunsRootInspection =
  | { kind: 'missing'; identity?: RunsRootIdentity }
  | { kind: 'safe'; runsRoot: string; identity: RunsRootIdentity }
  | { kind: 'unsafe'; path: string };

function isCanonicalDescendant(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '..'
    && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(path);
}

function inspectRunsRoot(repoPath: string): RunsRootInspection {
  const taktPath = join(repoPath, '.takt');
  const runsRoot = join(taktPath, 'runs');
  try {
    const repoBefore = lstatSync(repoPath);
    if (!repoBefore.isDirectory() || repoBefore.isSymbolicLink()) {
      return { kind: 'unsafe', path: repoPath };
    }
    let taktBefore;
    try {
      taktBefore = lstatSync(taktPath);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'unsafe', path: taktPath };
    }
    if (!taktBefore.isDirectory() || taktBefore.isSymbolicLink()) {
      return { kind: 'unsafe', path: taktPath };
    }
    const repoCanonical = realpathSync.native(repoPath);
    const taktCanonical = realpathSync.native(taktPath);
    const repoAfter = lstatSync(repoPath);
    const taktAfter = lstatSync(taktPath);
    if (
      !isCanonicalDescendant(repoCanonical, taktCanonical)
      || repoBefore.dev !== repoAfter.dev
      || repoBefore.ino !== repoAfter.ino
      || taktBefore.dev !== taktAfter.dev
      || taktBefore.ino !== taktAfter.ino
      || taktAfter.isSymbolicLink()
    ) {
      return { kind: 'unsafe', path: taktPath };
    }
    const baseIdentity = {
      repoDevice: repoAfter.dev,
      repoInode: repoAfter.ino,
      taktDevice: taktAfter.dev,
      taktInode: taktAfter.ino,
    };
    let runsBefore;
    try {
      runsBefore = lstatSync(runsRoot);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'missing', identity: baseIdentity }
        : { kind: 'unsafe', path: runsRoot };
    }
    if (!runsBefore.isDirectory() || runsBefore.isSymbolicLink()) {
      return { kind: 'unsafe', path: runsRoot };
    }
    const runsCanonical = realpathSync.native(runsRoot);
    const runsAfter = lstatSync(runsRoot);
    if (
      !isCanonicalDescendant(taktCanonical, runsCanonical)
      || runsBefore.dev !== runsAfter.dev
      || runsBefore.ino !== runsAfter.ino
      || runsAfter.isSymbolicLink()
    ) {
      return { kind: 'unsafe', path: runsRoot };
    }
    return {
      kind: 'safe',
      runsRoot,
      identity: {
        ...baseIdentity,
        runsDevice: runsAfter.dev,
        runsInode: runsAfter.ino,
      },
    };
  } catch {
    return { kind: 'unsafe', path: runsRoot };
  }
}

function sameRunsRootIdentity(
  left: RunsRootIdentity,
  right: RunsRootIdentity,
): boolean {
  return left.repoDevice === right.repoDevice
    && left.repoInode === right.repoInode
    && left.taktDevice === right.taktDevice
    && left.taktInode === right.taktInode
    && left.runsDevice === right.runsDevice
    && left.runsInode === right.runsInode;
}

function recoverMissingRunMetadata(options: {
  repoPath: string;
  apply: boolean;
  beforeRemoval?: (runPath: string) => void;
}): PersonalRecoveryAction[] {
  const inspectedRoot = inspectRunsRoot(options.repoPath);
  if (inspectedRoot.kind === 'missing') return [];
  if (inspectedRoot.kind === 'unsafe') {
    return [makeAction(
      'fail',
      'unsafe run recovery root',
      'repository .takt/runs ancestry is not a canonical directory and was not traversed',
      { path: inspectedRoot.path },
    )];
  }
  const { runsRoot } = inspectedRoot;
  return readdirSync(runsRoot, { withFileTypes: true }).flatMap((entry) => {
    const runPath = join(runsRoot, entry.name);
    if (entry.isSymbolicLink()) {
      return [makeAction(
        'fail',
        `missing run metadata ${entry.name}`,
        'run entry is a symlink and requires manual recovery',
        { path: runPath },
      )];
    }
    if (
      !entry.isDirectory()
      || !isValidReportDirName(entry.name)
      || isDebugLoggerRunSlug(entry.name)
    ) {
      return [];
    }
    const metaPath = join(runPath, 'meta.json');
    if (existsSync(metaPath)) return [];
    const directories = collectEmptyRunDirectories(runPath);
    if (directories === undefined) {
      return [makeAction(
        'fail',
        `missing run metadata ${entry.name}`,
        'run directory contains non-empty or unsafe artifacts and requires manual recovery',
        { path: runPath },
      )];
    }
    if (!options.apply) {
      return [makeAction(
        'would_change',
        `missing run metadata ${entry.name}`,
        'would remove empty crash-left run scaffolding',
        { path: runPath },
      )];
    }
    options.beforeRemoval?.(runPath);
    const confirmedRoot = inspectRunsRoot(options.repoPath);
    if (
      confirmedRoot.kind !== 'safe'
      || !sameRunsRootIdentity(inspectedRoot.identity, confirmedRoot.identity)
    ) {
      return [makeAction(
        'fail',
        `missing run metadata ${entry.name}`,
        'run ancestry changed during recovery and was left fail-closed',
        { path: runPath },
      )];
    }
    const revalidated = collectEmptyRunDirectories(runPath);
    if (
      revalidated === undefined
      || revalidated.length !== directories.length
      || revalidated.some((directory, index) => directory !== directories[index])
    ) {
      return [makeAction(
        'fail',
        `missing run metadata ${entry.name}`,
        'run directory changed during recovery and was left fail-closed',
        { path: runPath },
      )];
    }
    try {
      // Remove only directories proven empty, leaf-first. Concurrent metadata
      // or context publication makes rmdir fail instead of deleting live data.
      for (const directory of directories) rmdirSync(directory);
      return [makeAction(
        'changed',
        `missing run metadata ${entry.name}`,
        'removed empty crash-left run scaffolding',
        { path: runPath },
      )];
    } catch {
      return [makeAction(
        'fail',
        `missing run metadata ${entry.name}`,
        'run directory changed during recovery and was left fail-closed',
        { path: runPath },
      )];
    }
  });
}

function listFilesRecursive(rootPath: string): string[] {
  if (!existsSync(rootPath)) {
    return [];
  }
  const stat = statSync(rootPath);
  if (!stat.isDirectory()) {
    return [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(entryPath));
    } else if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results;
}

function ageMinutes(filePath: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - statSync(filePath).mtimeMs) / 60_000));
}

function recoverLockFiles(options: {
  repoPath: string;
  apply: boolean;
  lockStaleMinutes: number;
  now: Date;
}): PersonalRecoveryAction[] {
  return [join(options.repoPath, '.devloop'), join(options.repoPath, '.takt')]
    .flatMap((rootPath) => listFilesRecursive(rootPath))
    .filter((filePath) => filePath.endsWith('.lock'))
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => {
      const age = ageMinutes(filePath, options.now);
      if (age < options.lockStaleMinutes) {
        return makeAction('skipped', 'recent lock', 'lock file is not stale', {
          path: filePath,
          detail: `age ${age}m`,
        });
      }
      if (!options.apply) {
        return makeAction('would_change', 'stale lock', 'would remove stale lock file', {
          path: filePath,
          detail: `age ${age}m`,
        });
      }
      rmSync(filePath, { force: true });
      return makeAction('changed', 'stale lock', 'removed stale lock file', {
        path: filePath,
      });
    });
}

function recoverRetryWindows(options: {
  repoPath: string;
  ledgerPath?: string;
  now: Date;
}): PersonalRecoveryAction[] {
  const ledgerPath = resolveDevloopLedgerPath(options.repoPath, options.ledgerPath);
  return readRawDevloopLedgerEvents(ledgerPath)
    .flatMap((event) => {
      const retryAfter = (event as { retryAfter?: unknown }).retryAfter;
      if (typeof retryAfter !== 'string') {
        return [];
      }
      const retryAt = Date.parse(retryAfter);
      if (!Number.isFinite(retryAt)) {
        return [makeAction('warn', 'malformed retryAfter', 'retryAfter timestamp is not parseable', {
          path: ledgerPath,
          detail: retryAfter,
        })];
      }
      if (retryAt <= options.now.getTime()) {
        return [makeAction('exists', 'expired retryAfter', 'expired retry window is preserved in ledger evidence', {
          path: ledgerPath,
          detail: retryAfter,
        })];
      }
      return [makeAction('skipped', 'active retryAfter', 'retry window is still active', {
        path: ledgerPath,
        detail: retryAfter,
      })];
    });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function probeRunProcess(pid: number): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    // Portable Node APIs cannot prove OS process start identity. PID reuse is
    // therefore treated as alive and requires manual recovery; this trades
    // availability for never aborting a potentially live preparation owner.
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function recoverDaemonMetadata(options: {
  repoPath: string;
  apply: boolean;
}): PersonalRecoveryAction[] {
  const lifecycle = inspectPersonalLifecycle({ repoPath: options.repoPath });
  if (lifecycle.daemon === undefined) {
    return [];
  }
  if (isProcessAlive(lifecycle.daemon.pid)) {
    return [makeAction('skipped', 'live daemon metadata', 'daemon process is still alive', {
      path: lifecycle.statePath,
      detail: `pid ${lifecycle.daemon.pid}`,
    })];
  }
  if (!options.apply) {
    return [makeAction('would_change', 'dead daemon metadata', 'would remove daemon metadata for a dead process', {
      path: lifecycle.statePath,
      detail: `pid ${lifecycle.daemon.pid}`,
    })];
  }
  rmSync(lifecycle.statePath, { force: true });
  return [makeAction('changed', 'dead daemon metadata', 'removed daemon metadata for a dead process', {
    path: lifecycle.statePath,
  })];
}

function recoverWorktreeDirectories(options: {
  repoPath: string;
  apply: boolean;
  worktreeStaleMinutes: number;
  now: Date;
}): PersonalRecoveryAction[] {
  const worktreesDir = join(options.repoPath, '.takt', 'worktrees');
  if (!existsSync(worktreesDir)) {
    return [];
  }
  return readdirSync(worktreesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(worktreesDir, entry.name))
    .sort((left, right) => left.localeCompare(right))
    .map((worktreePath) => {
      const age = ageMinutes(worktreePath, options.now);
      const gitPath = join(worktreePath, '.git');
      if (existsSync(gitPath)) {
        return makeAction('skipped', 'git worktree directory', 'git worktree requires manual cleanup', {
          path: worktreePath,
          detail: `age ${age}m`,
        });
      }
      if (age < options.worktreeStaleMinutes) {
        return makeAction('skipped', 'recent worktree directory', 'worktree directory is not stale', {
          path: worktreePath,
          detail: `age ${age}m`,
        });
      }
      if (!options.apply) {
        return makeAction('would_change', 'abandoned worktree directory', 'would remove stale non-git worktree directory', {
          path: worktreePath,
          detail: `age ${age}m`,
        });
      }
      rmSync(worktreePath, { recursive: true, force: true });
      return makeAction('changed', 'abandoned worktree directory', 'removed stale non-git worktree directory', {
        path: worktreePath,
      });
    });
}

function recoverAbandonedCoordinationClaims(options: {
  repoPath: string;
  apply: boolean;
  probeProcess?: (pid: number) => 'alive' | 'dead' | 'unknown';
}): PersonalRecoveryAction[] {
  let report;
  try {
    report = recoverAbandonedProjectTemplateCoordinationClaimsForRecovery(
      options.repoPath,
      {
        apply: options.apply,
        ...(options.probeProcess === undefined
          ? {}
          : { probeProcess: options.probeProcess }),
      },
    );
  } catch {
    return [makeAction(
      'fail',
      'abandoned project template coordination recovery',
      'coordination recovery changed during explicit recovery and remains fail-closed',
    )];
  }
  const detail = report.paths.join(', ');
  switch (report.status) {
    case 'none':
      return [];
    case 'recoverable':
      return [makeAction(
        'would_change',
        'abandoned project template coordination recovery',
        'would resume coordination recovery owned by a dead process',
        { detail },
      )];
    case 'recovered':
      return [makeAction(
        'changed',
        'abandoned project template coordination recovery',
        'resumed and completed coordination recovery owned by a dead process',
        { detail },
      )];
    case 'blocked':
      return [makeAction(
        'fail',
        'abandoned project template coordination recovery',
        'coordination recovery owner is live, unknown, or unsafe; manual recovery is required',
        { detail },
      )];
  }
}

function buildNextActions(actions: readonly PersonalRecoveryAction[]): string[] {
  const next = new Set<string>();
  if (actions.some((action) => action.status === 'would_change')) {
    next.add('rerun with --apply to clean stale local automation state');
  }
  if (actions.some((action) => action.name === 'git worktree directory')) {
    next.add('inspect git worktrees manually before deleting them');
  }
  if (actions.some((action) => action.name === 'active retryAfter')) {
    next.add('wait for active retryAfter windows before forcing scheduler stages');
  }
  if (actions.some((action) => action.status === 'changed')) {
    next.add('rerun devloopd status to confirm recovery');
  }
  return [...next];
}

export function runPersonalRecovery(options: RunPersonalRecoveryOptions = {}): PersonalRecoveryReport {
  const repoPath = resolveRepoPath(options.repoPath);
  const apply = options.apply === true;
  const now = options.now ?? new Date();
  const staleAfterMinutes = parsePositiveInteger(options.staleAfterMinutes, DEFAULT_STALE_AFTER_MINUTES);
  const lockStaleMinutes = parsePositiveInteger(options.lockStaleMinutes, DEFAULT_LOCK_STALE_MINUTES);
  const worktreeStaleMinutes = parsePositiveInteger(options.worktreeStaleMinutes, DEFAULT_WORKTREE_STALE_MINUTES);
  const initialRunsRoot = inspectRunsRoot(repoPath);
  if (initialRunsRoot.kind === 'unsafe') {
    const actions = [makeAction(
      'fail',
      'unsafe run recovery root',
      'repository .takt/runs ancestry is not a canonical directory and was not traversed',
      { path: initialRunsRoot.path },
    )];
    return {
      passed: false,
      changed: false,
      apply,
      repoPath,
      actions,
      nextActions: buildNextActions(actions),
    };
  }
  const activeRuns = inspectActiveRuns({ repoPath, staleAfterMinutes, now });
  const runProcessProbe = options.probeRunProcess ?? probeRunProcess;
  const actions: PersonalRecoveryAction[] = [];

  if (!activeRuns.passed) {
    actions.push(makeAction('fail', 'active runs', activeRuns.message));
  } else {
    actions.push(...activeRuns.activeRuns.map((run) => recoverStaleRun({
      repoPath,
      run,
      apply,
      now,
      probeProcess: runProcessProbe,
    })));
  }
  actions.push(...recoverMissingRunMetadata({
    repoPath,
    apply,
    ...(options.beforeMissingRunRemoval === undefined
      ? {}
      : { beforeRemoval: options.beforeMissingRunRemoval }),
  }));
  actions.push(
    ...recoverAbandonedCoordinationClaims({
      repoPath,
      apply,
      ...(options.probeRunProcess === undefined
        ? {}
        : { probeProcess: options.probeRunProcess }),
    }),
    ...recoverLockFiles({ repoPath, apply, lockStaleMinutes, now }),
    ...recoverRetryWindows({ repoPath, ledgerPath: options.ledgerPath, now }),
    ...recoverDaemonMetadata({ repoPath, apply }),
    ...recoverWorktreeDirectories({ repoPath, apply, worktreeStaleMinutes, now }),
  );

  return {
    passed: actions.every((action) => action.status !== 'fail'),
    changed: actions.some((action) => action.status === 'changed'),
    apply,
    repoPath,
    actions,
    nextActions: buildNextActions(actions),
  };
}

export function formatPersonalRecoveryReport(report: PersonalRecoveryReport): string {
  const lines = [
    report.passed ? 'devloopd recover-stale passed' : 'devloopd recover-stale failed',
    `Mode: ${report.apply ? 'apply' : 'dry-run'}`,
    `Repository: ${report.repoPath}`,
  ];
  if (report.actions.length === 0) {
    lines.push('No stale local automation state found.');
  }
  for (const action of report.actions) {
    lines.push(`- ${action.status.toUpperCase()} ${action.name}: ${action.message}`);
    if (action.path !== undefined) {
      lines.push(`  ${action.path}`);
    }
    if (action.detail !== undefined && action.detail.length > 0) {
      lines.push(`  ${action.detail}`);
    }
  }
  if (report.nextActions.length > 0) {
    lines.push('Next actions:', ...report.nextActions.map((action) => `- ${action}`));
  }
  return lines.join('\n');
}
