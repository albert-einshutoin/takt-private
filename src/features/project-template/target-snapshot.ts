import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  open,
  realpath,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  areProjectTemplateFileStatsEqual,
} from './bounded-file-read.js';
import { TaktpackError } from './errors.js';
import {
  areProjectTemplateDirectorySnapshotsStable,
  portablePathKey,
} from './filesystem-scan.js';
import {
  MAX_TEMPLATE_ENTRIES,
  parsePortablePath,
  requireArray,
} from './validation.js';

const execFileAsync = promisify(execFile);
const MAX_LOCAL_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LOCAL_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DIFF_CONTENT_BYTES = 64 * 1024;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;

export type ProjectTemplateGitTrackingStatus =
  | 'tracked-clean'
  | 'tracked-modified'
  | 'staged'
  | 'untracked'
  | 'ignored'
  | 'unmerged'
  | 'not-repository'
  | 'unavailable';

export interface CapturedProjectTemplateTargetEntry {
  path: string;
  mode: string;
  sha256: string;
  bytes: number;
  content?: Uint8Array;
  gitTrackingStatus: ProjectTemplateGitTrackingStatus;
}

export interface ProjectTemplateTargetSnapshot {
  candidatePaths: string[];
  missingPaths: string[];
  entries: CapturedProjectTemplateTargetEntry[];
}

interface CapturedTargetFile {
  entry: Omit<CapturedProjectTemplateTargetEntry, 'gitTrackingStatus'>;
  snapshot: Stats;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function isInside(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

function unsafeTarget(): TaktpackError {
  return new TaktpackError(
    'UNSAFE_ARCHIVE_ENTRY',
    'project template target cannot be inspected safely',
    'target',
  );
}

function parseCandidatePaths(value: unknown): string[] {
  let paths: string[];
  try {
    paths = requireArray(
      value,
      'candidatePaths',
      MAX_TEMPLATE_ENTRIES * 2,
      'LIMIT_EXCEEDED',
    ).map((path, index) => parsePortablePath(path, `candidatePaths[${index}]`));
  } catch {
    throw new TaktpackError(
      'INVALID_EXPORT_PLAN',
      'candidate paths are invalid',
      'candidatePaths',
    );
  }
  const identities = new Set<string>();
  for (const path of paths) {
    const identity = portablePathKey(path);
    if (identities.has(identity)) {
      throw new TaktpackError(
        'INVALID_EXPORT_PLAN',
        'candidate paths contain a portable identity collision',
        'candidatePaths',
      );
    }
    identities.add(identity);
  }
  return [...paths].sort(compareAscii);
}

async function runGit(
  projectRoot: string,
  args: readonly string[],
  maxBuffer = MAX_GIT_OUTPUT_BYTES,
): Promise<Buffer> {
  const result = await execFileAsync('git', [
    '--no-optional-locks',
    '-c',
    'core.fsmonitor=false',
    '-C',
    projectRoot,
    ...args,
  ], {
    encoding: 'buffer',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout);
}

function splitNul(output: Buffer): string[] {
  const records = output.toString('utf8').split('\0');
  if (records.at(-1) === '') records.pop();
  return records;
}

function fromGitPath(path: string): string | undefined {
  if (!path.startsWith('.takt/')) return undefined;
  return path.slice('.takt/'.length);
}

function parseGitStatus(output: Buffer): Map<string, ProjectTemplateGitTrackingStatus> {
  const records = splitNul(output);
  const statuses = new Map<string, ProjectTemplateGitTrackingStatus>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('unsupported git status record');
    }
    const code = record.slice(0, 2);
    const path = fromGitPath(record.slice(3));
    if (path !== undefined) {
      const status: ProjectTemplateGitTrackingStatus =
        code === '??' ? 'untracked'
          : code === '!!' ? 'ignored'
            : code.includes('U') || code === 'AA' || code === 'DD' ? 'unmerged'
              : code[0] !== ' ' && code[0] !== '?' ? 'staged'
                : 'tracked-modified';
      statuses.set(path, status);
    }
    if (code.includes('R') || code.includes('C')) {
      index += 1;
      if (index >= records.length) throw new Error('truncated git rename record');
    }
  }
  return statuses;
}

async function gitTrackingForPaths(
  projectRoot: string,
  existingPaths: readonly string[],
): Promise<Map<string, ProjectTemplateGitTrackingStatus>> {
  try {
    const inside = (await runGit(
      projectRoot,
      ['rev-parse', '--is-inside-work-tree'],
      64 * 1024,
    )).toString('utf8').trim();
    if (inside !== 'true') throw new Error('not a work tree');
  } catch {
    return new Map(existingPaths.map((path) => [path, 'not-repository']));
  }

  try {
    const [trackedOutput, statusOutput] = await Promise.all([
      runGit(projectRoot, ['ls-files', '--cached', '-z', '--', '.takt']),
      runGit(projectRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
        '--',
        '.takt',
      ]),
    ]);
    const tracked = new Set(
      splitNul(trackedOutput)
        .map(fromGitPath)
        .filter((path): path is string => path !== undefined),
    );
    const changed = parseGitStatus(statusOutput);
    return new Map(existingPaths.map((path) => [
      path,
      changed.get(path) ?? (tracked.has(path) ? 'tracked-clean' : 'untracked'),
    ]));
  } catch {
    return new Map(existingPaths.map((path) => [path, 'unavailable']));
  }
}

async function inspectAncestors(
  taktRoot: string,
  relativePath: string,
  snapshots: Map<string, Stats>,
): Promise<'present' | 'missing'> {
  const segments = relativePath.split('/');
  let current = taktRoot;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let stat: Stats;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw unsafeTarget();
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeTarget();
    snapshots.set(current, stat);
  }
  return 'present';
}

async function captureFile(
  absolutePath: string,
  relativePath: string,
  rootRealPath: string,
): Promise<CapturedTargetFile | undefined> {
  let initial: Stats;
  try {
    initial = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw unsafeTarget();
  }
  if (
    initial.isSymbolicLink()
    || !initial.isFile()
    || initial.nlink !== 1
    || initial.size > MAX_LOCAL_FILE_BYTES
  ) {
    throw unsafeTarget();
  }
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(absolutePath);
  } catch {
    throw unsafeTarget();
  }
  if (!isInside(rootRealPath, resolvedPath)) throw unsafeTarget();

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let result: CapturedTargetFile | undefined;
  let primaryError: Error | undefined;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || !areProjectTemplateFileStatsEqual(initial, before)
    ) {
      throw unsafeTarget();
    }
    const digest = createHash('sha256');
    const contentChunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const requested = Math.min(buffer.byteLength, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) throw unsafeTarget();
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      digest.update(chunk);
      if (before.size <= MAX_DIFF_CONTENT_BYTES) contentChunks.push(chunk);
      position += bytesRead;
    }
    const after = await handle.stat();
    if (!areProjectTemplateFileStatsEqual(before, after)) throw unsafeTarget();
    result = {
      entry: {
        path: relativePath,
        mode: safeMode(before.mode),
        sha256: digest.digest('hex'),
        bytes: before.size,
        ...(before.size <= MAX_DIFF_CONTENT_BYTES
          ? { content: Buffer.concat(contentChunks) }
          : {}),
      },
      snapshot: after,
    };
  } catch (error) {
    primaryError = error instanceof TaktpackError ? error : unsafeTarget();
  }
  try {
    await handle?.close();
  } catch {
    primaryError ??= unsafeTarget();
  }
  if (primaryError !== undefined) throw primaryError;
  return result;
}

/**
 * Captures only the candidate destinations needed by an apply plan. The
 * adapter intentionally imports no write primitive, so preview cannot mutate
 * the target while collecting hash and Git evidence.
 */
export async function captureProjectTemplateTargetSnapshot(
  projectRoot: string,
  candidateValue: unknown,
): Promise<ProjectTemplateTargetSnapshot> {
  const candidatePaths = parseCandidatePaths(candidateValue);
  const taktRoot = resolve(projectRoot, '.takt');
  let projectRealPath: string;
  let rootRealPath: string;
  let rootBefore: Stats;
  try {
    projectRealPath = await realpath(projectRoot);
    rootRealPath = await realpath(taktRoot);
    rootBefore = await lstat(taktRoot);
  } catch {
    throw unsafeTarget();
  }
  if (
    rootBefore.isSymbolicLink()
    || !rootBefore.isDirectory()
    || relative(projectRealPath, rootRealPath) !== '.takt'
  ) {
    throw unsafeTarget();
  }

  const ancestorSnapshots = new Map<string, Stats>([[taktRoot, rootBefore]]);
  const captured: CapturedTargetFile[] = [];
  const missingPaths: string[] = [];
  let totalBytes = 0;
  for (const path of candidatePaths) {
    if (await inspectAncestors(taktRoot, path, ancestorSnapshots) === 'missing') {
      missingPaths.push(path);
      continue;
    }
    const entry = await captureFile(join(taktRoot, path), path, rootRealPath);
    if (entry === undefined) {
      missingPaths.push(path);
      continue;
    }
    totalBytes += entry.entry.bytes;
    if (totalBytes > MAX_LOCAL_TOTAL_BYTES) {
      throw new TaktpackError(
        'ARCHIVE_LIMIT_EXCEEDED',
        'project template target exceeds the snapshot byte budget',
        'target',
      );
    }
    captured.push(entry);
  }

  const tracking = await gitTrackingForPaths(
    projectRoot,
    captured.map(({ entry }) => entry.path),
  );

  // Git inspection takes time and can race with editors. Revalidate both
  // directories and files afterward so one precondition token never combines
  // hashes from one target state with Git evidence from another.
  for (const [directory, before] of ancestorSnapshots) {
    let after: Stats;
    try {
      after = await lstat(directory);
    } catch {
      throw unsafeTarget();
    }
    if (!areProjectTemplateDirectorySnapshotsStable(before, after)) {
      throw unsafeTarget();
    }
  }
  for (const { entry, snapshot } of captured) {
    let after: Stats;
    try {
      after = await lstat(join(taktRoot, entry.path));
    } catch {
      throw unsafeTarget();
    }
    if (!areProjectTemplateFileStatsEqual(snapshot, after)) throw unsafeTarget();
  }
  for (const path of missingPaths) {
    try {
      await lstat(join(taktRoot, path));
      throw unsafeTarget();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const entries = captured.map(({ entry }): CapturedProjectTemplateTargetEntry => ({
    ...entry,
    gitTrackingStatus: tracking.get(entry.path) ?? 'unavailable',
  }));
  return {
    candidatePaths,
    missingPaths,
    entries,
  };
}
