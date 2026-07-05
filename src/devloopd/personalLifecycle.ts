import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';
import { writeFileAtomic } from './stateStore.js';

export type PersonalLifecycleStatus = 'idle' | 'running' | 'stop_requested';

export interface PersonalLifecyclePaths {
  stateDir: string;
  statePath: string;
  stopRequestPath: string;
}

export interface PersonalDaemonState {
  version: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  repoPath: string;
  command: 'devloopd start';
  status: 'running';
  cycleCount: number;
}

export interface PersonalDaemonStopRequest {
  version: 1;
  requestedAt: string;
  reason: string;
}

export interface PersonalLifecycleReport {
  passed: boolean;
  message: string;
  status: PersonalLifecycleStatus;
  statePath: string;
  stopRequestPath: string;
  daemon?: PersonalDaemonState;
  stopRequest?: PersonalDaemonStopRequest;
  stopRequested: boolean;
}

export interface PersonalLifecycleMutationReport extends PersonalLifecycleReport {
  changed: boolean;
}

function resolveRepoPath(repoPath: string | undefined): string {
  return resolve(repoPath ?? process.cwd());
}

export function resolvePersonalLifecyclePaths(repoPath: string): PersonalLifecyclePaths {
  const stateDir = join(resolve(repoPath), '.devloop', 'daemon');
  return {
    stateDir,
    statePath: join(stateDir, 'state.json'),
    stopRequestPath: join(stateDir, 'stop-request.json'),
  };
}

function sanitizeReason(reason: string | undefined): string {
  const sanitized = sanitizeSensitiveText(reason ?? 'operator requested stop').replace(/\s+/g, ' ').trim();
  return sanitized.length > 0 ? sanitized : 'operator requested stop';
}

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function inspectPersonalLifecycle(options: {
  repoPath?: string;
} = {}): PersonalLifecycleReport {
  const repoPath = resolveRepoPath(options.repoPath);
  const paths = resolvePersonalLifecyclePaths(repoPath);
  const daemon = readJsonFile<PersonalDaemonState>(paths.statePath);
  const stopRequest = readJsonFile<PersonalDaemonStopRequest>(paths.stopRequestPath);
  const status: PersonalLifecycleStatus = stopRequest
    ? 'stop_requested'
    : daemon?.status === 'running'
      ? 'running'
      : 'idle';

  return {
    passed: true,
    message: stopRequest
      ? `stop requested: ${stopRequest.reason}`
      : daemon?.status === 'running'
        ? `daemon metadata found for pid ${daemon.pid}`
        : 'no personal daemon state found',
    status,
    statePath: paths.statePath,
    stopRequestPath: paths.stopRequestPath,
    ...(daemon ? { daemon } : {}),
    ...(stopRequest ? { stopRequest } : {}),
    stopRequested: stopRequest !== undefined,
  };
}

export function writePersonalDaemonState(options: {
  repoPath?: string;
  cycleCount?: number;
  now?: Date;
} = {}): PersonalLifecycleMutationReport {
  const repoPath = resolveRepoPath(options.repoPath);
  const paths = resolvePersonalLifecyclePaths(repoPath);
  const previous = readJsonFile<PersonalDaemonState>(paths.statePath);
  const now = options.now ?? new Date();
  const state: PersonalDaemonState = {
    version: 1,
    pid: process.pid,
    startedAt: previous?.startedAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    repoPath,
    command: 'devloopd start',
    status: 'running',
    cycleCount: options.cycleCount ?? previous?.cycleCount ?? 0,
  };
  writeJsonFile(paths.statePath, state);
  return {
    ...inspectPersonalLifecycle({ repoPath }),
    changed: true,
  };
}

export function requestPersonalDaemonStop(options: {
  repoPath?: string;
  reason?: string;
  now?: Date;
} = {}): PersonalLifecycleMutationReport {
  const repoPath = resolveRepoPath(options.repoPath);
  const paths = resolvePersonalLifecyclePaths(repoPath);
  // A file-based stop request works for foreground shells, launchd, and cron
  // without assuming parent/child process ownership across supervisors.
  const request: PersonalDaemonStopRequest = {
    version: 1,
    requestedAt: (options.now ?? new Date()).toISOString(),
    reason: sanitizeReason(options.reason),
  };
  writeJsonFile(paths.stopRequestPath, request);
  return {
    ...inspectPersonalLifecycle({ repoPath }),
    changed: true,
  };
}

export function resetPersonalLifecycle(options: {
  repoPath?: string;
} = {}): PersonalLifecycleMutationReport {
  const repoPath = resolveRepoPath(options.repoPath);
  const paths = resolvePersonalLifecyclePaths(repoPath);
  let changed = false;
  for (const filePath of [paths.statePath, paths.stopRequestPath]) {
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
      changed = true;
    }
  }
  return {
    ...inspectPersonalLifecycle({ repoPath }),
    message: changed ? 'personal daemon lifecycle state reset' : 'no personal daemon lifecycle state to reset',
    changed,
  };
}

export function clearPersonalDaemonState(options: {
  repoPath?: string;
} = {}): PersonalLifecycleMutationReport {
  const repoPath = resolveRepoPath(options.repoPath);
  const paths = resolvePersonalLifecyclePaths(repoPath);
  const changed = existsSync(paths.statePath);
  if (changed) {
    rmSync(paths.statePath, { force: true });
  }
  return {
    ...inspectPersonalLifecycle({ repoPath }),
    changed,
  };
}

export function formatPersonalLifecycleReport(report: PersonalLifecycleReport): string {
  const lines = [
    report.passed ? 'devloopd lifecycle passed' : 'devloopd lifecycle failed',
    report.message,
    `Status: ${report.status}`,
    `State: ${report.statePath}`,
    `Stop request: ${report.stopRequestPath}`,
  ];
  if (report.daemon) {
    lines.push(
      `Daemon: pid ${report.daemon.pid}, cycles ${report.daemon.cycleCount}, updated ${report.daemon.updatedAt}`,
    );
  }
  if (report.stopRequest) {
    lines.push(`Stop requested: ${report.stopRequest.requestedAt} - ${report.stopRequest.reason}`);
  }
  return lines.join('\n');
}
