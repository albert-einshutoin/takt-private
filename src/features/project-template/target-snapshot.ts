import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  open,
  opendir,
  realpath,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_TAKTPACK_LIMITS,
  MAX_PROJECT_TEMPLATE_COHORT_BYTES,
} from './archive-types.js';
import {
  areProjectTemplateFileStatsEqual,
} from './bounded-file-read.js';
import { canonicalizeTaktpackJson } from './canonical-json.js';
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
import {
  requireActiveRemotePreview,
  type ProjectTemplateRemotePreviewOperationContext,
} from './remote-preview-operation.js';

const execFileAsync = promisify(execFile);
const MAX_LOCAL_FILE_BYTES = MAX_PROJECT_TEMPLATE_COHORT_BYTES;
const MAX_DIFF_CONTENT_BYTES = 64 * 1024;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const MAX_DIRECTORY_SCAN_ENTRIES = MAX_TEMPLATE_ENTRIES * 2;

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
  rootState: 'missing' | 'directory';
  candidatePaths: string[];
  missingPaths: string[];
  missingPathTracking: Readonly<Record<string, ProjectTemplateGitTrackingStatus>>;
  entries: CapturedProjectTemplateTargetEntry[];
}

/**
 * Seals only the filesystem and Git evidence that must still be true at
 * commit time. Content bytes are deliberately excluded: retaining another
 * copy would increase secret exposure without strengthening the hash witness.
 */
export function calculateProjectTemplateTargetPreconditionToken(
  snapshot: ProjectTemplateTargetSnapshot,
): string {
  const candidatePaths = [...snapshot.candidatePaths].sort(compareAscii);
  const entries = snapshot.entries
    .map(({ path, mode, sha256, bytes, gitTrackingStatus }) => ({
      path,
      mode,
      sha256,
      bytes,
      gitTrackingStatus,
    }))
    .sort((left, right) => compareAscii(left.path, right.path));
  return createHash('sha256').update(canonicalizeTaktpackJson({
    candidatePaths,
    targetRootState: snapshot.rootState,
    missingPathTracking: snapshot.missingPathTracking,
    entries,
  })).digest('hex');
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

function retainedContentLimit(path: string): number {
  const key = portablePathKey(path);
  // Semantic config needs historical bytes for safe three-way migration. Keep
  // that narrowly scoped exception bounded by the same accepted blob limit;
  // unrelated large files remain opaque to minimize secret exposure.
  return key === 'config.yaml' || key === 'devloopd.yaml'
    ? DEFAULT_TAKTPACK_LIMITS.maxBlobBytes
    : MAX_DIFF_CONTENT_BYTES;
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

function fromGitPath(path: string, repositoryPrefix: string): string | undefined {
  const prefixes = repositoryPrefix === ''
    ? ['.takt/']
    : [`.takt/`, `${repositoryPrefix}.takt/`];
  const prefix = prefixes.find((candidate) => path.startsWith(candidate));
  return prefix === undefined ? undefined : path.slice(prefix.length);
}

function parseGitStatus(
  output: Buffer,
  repositoryPrefix: string,
): Map<string, ProjectTemplateGitTrackingStatus> {
  const records = splitNul(output);
  const statuses = new Map<string, ProjectTemplateGitTrackingStatus>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('unsupported git status record');
    }
    const code = record.slice(0, 2);
    const path = fromGitPath(record.slice(3), repositoryPrefix);
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
      const secondPath = fromGitPath(records[index]!, repositoryPrefix);
      if (secondPath !== undefined) statuses.set(secondPath, 'staged');
    }
  }
  return statuses;
}

async function gitTrackingForPaths(
  projectRoot: string,
  existingPaths: readonly string[],
): Promise<Map<string, ProjectTemplateGitTrackingStatus>> {
  let inside: string;
  try {
    inside = (await runGit(
      projectRoot,
      ['rev-parse', '--is-inside-work-tree'],
      64 * 1024,
    )).toString('utf8').trim();
  } catch (error) {
    const failure = error as {
      code?: unknown;
      stderr?: string | Buffer;
    };
    const stderr = Buffer.isBuffer(failure.stderr)
      ? failure.stderr.toString('utf8')
      : failure.stderr ?? '';
    const status: ProjectTemplateGitTrackingStatus =
      failure.code === 128 && /not a git repository|not a work tree/i.test(stderr)
        ? 'not-repository'
        : 'unavailable';
    return new Map(existingPaths.map((path) => [path, status]));
  }
  if (inside !== 'true') {
    return new Map(existingPaths.map((path) => [path, 'not-repository']));
  }

  try {
    const [prefixOutput, trackedOutput, statusOutput] = await Promise.all([
      runGit(projectRoot, ['rev-parse', '--show-prefix'], 64 * 1024),
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
    const repositoryPrefix = prefixOutput.toString('utf8').trim();
    if (
      repositoryPrefix !== ''
      && (!repositoryPrefix.endsWith('/') || repositoryPrefix.includes('\0'))
    ) {
      throw new Error('invalid repository prefix');
    }
    const tracked = new Set(
      splitNul(trackedOutput)
        .map((path) => fromGitPath(path, repositoryPrefix))
        .filter((path): path is string => path !== undefined),
    );
    const changed = parseGitStatus(statusOutput, repositoryPrefix);
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
  directoryNames: Map<string, Map<string, string[]>>,
  scanBudget: { entries: number },
): Promise<'present' | 'missing'> {
  const segments = relativePath.split('/');
  let current = taktRoot;
  for (const segment of segments.slice(0, -1)) {
    const parent = current;
    current = join(current, segment);
    const names = await readBoundedDirectory(parent, directoryNames, scanBudget);
    const segmentKey = segment.normalize('NFKC').toLowerCase();
    const portableMatches = names.get(segmentKey) ?? [];
    if (
      portableMatches.length > 1
      || (portableMatches.length === 1 && portableMatches[0] !== segment)
    ) {
      throw unsafeTarget();
    }
    let stat: Stats;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (portableMatches.length > 0) throw unsafeTarget();
        return 'missing';
      }
      throw unsafeTarget();
    }
    if (portableMatches.length !== 1) throw unsafeTarget();
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeTarget();
    let actualRelative: string;
    try {
      actualRelative = relative(taktRoot, await realpath(current)).split(sep).join('/');
    } catch {
      throw unsafeTarget();
    }
    const requestedRelative = relative(taktRoot, current).split(sep).join('/');
    if (actualRelative !== requestedRelative) throw unsafeTarget();
    snapshots.set(current, stat);
  }
  return 'present';
}

async function readBoundedDirectory(
  directory: string,
  cache: Map<string, Map<string, string[]>>,
  budget: { entries: number },
): Promise<Map<string, string[]>> {
  const cached = cache.get(directory);
  if (cached !== undefined) return cached;
  let handle: Awaited<ReturnType<typeof opendir>>;
  try {
    handle = await opendir(directory);
  } catch {
    throw unsafeTarget();
  }
  const names = new Map<string, string[]>();
  let primaryError: Error | undefined;
  try {
    for (;;) {
      const entry = await handle.read();
      if (entry === null) break;
      budget.entries += 1;
      if (budget.entries > MAX_DIRECTORY_SCAN_ENTRIES) {
        throw new TaktpackError(
          'ARCHIVE_LIMIT_EXCEEDED',
          'project template target directories exceed the inspection budget',
          'target',
        );
      }
      const key = entry.name.normalize('NFKC').toLowerCase();
      const bucket = names.get(key);
      if (bucket === undefined) names.set(key, [entry.name]);
      else bucket.push(entry.name);
    }
  } catch (error) {
    primaryError = error instanceof TaktpackError ? error : unsafeTarget();
  }
  try {
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') {
      primaryError ??= unsafeTarget();
    }
  }
  if (primaryError !== undefined) throw primaryError;
  cache.set(directory, names);
  return names;
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
    const contentLimit = retainedContentLimit(relativePath);
    let position = 0;
    while (position < before.size) {
      const requested = Math.min(buffer.byteLength, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) throw unsafeTarget();
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      digest.update(chunk);
      if (before.size <= contentLimit) contentChunks.push(chunk);
      position += bytesRead;
    }
    const after = await handle.stat();
    if (!areProjectTemplateFileStatsEqual(before, after)) throw unsafeTarget();
    result = {
      entry: {
        // realpath supplies the on-disk spelling on case-insensitive targets.
        // Keeping that spelling is required for case-only rename conflicts.
        path: relative(rootRealPath, resolvedPath).split(sep).join('/'),
        mode: safeMode(before.mode),
        sha256: digest.digest('hex'),
        bytes: before.size,
        ...(before.size <= contentLimit
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
  operationContext?: ProjectTemplateRemotePreviewOperationContext,
): Promise<ProjectTemplateTargetSnapshot> {
  const checkpoint = (): void => {
    if (operationContext !== undefined) {
      requireActiveRemotePreview(operationContext);
    }
  };
  checkpoint();
  const candidatePaths = parseCandidatePaths(candidateValue);
  let projectRealPath: string;
  let taktRoot: string;
  let rootRealPath: string | undefined;
  let rootBefore: Stats | undefined;
  try {
    projectRealPath = await realpath(projectRoot);
    // Why: macOS commonly exposes /var through /private/var. Every descendant
    // identity comparison must share the canonical root or a safe target is
    // falsely classified as an escaping directory.
    taktRoot = resolve(projectRealPath, '.takt');
  } catch {
    throw unsafeTarget();
  }
  checkpoint();
  const directoryNames = new Map<string, Map<string, string[]>>();
  const directoryScanBudget = { entries: 0 };
  const projectNames = await readBoundedDirectory(
    projectRealPath,
    directoryNames,
    directoryScanBudget,
  );
  checkpoint();
  const rootPortableMatches = projectNames.get('.takt') ?? [];
  if (
    rootPortableMatches.length > 1
    || (
      rootPortableMatches.length === 1
      && rootPortableMatches[0] !== '.takt'
    )
  ) {
    throw unsafeTarget();
  }
  try {
    rootBefore = await lstat(taktRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unsafeTarget();
    const tracking = await gitTrackingForPaths(projectRoot, candidatePaths);
    checkpoint();
    try {
      await lstat(taktRoot);
      throw unsafeTarget();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const refreshedProjectNames = await readBoundedDirectory(
      projectRealPath,
      new Map(),
      { entries: 0 },
    );
    checkpoint();
    if ((refreshedProjectNames.get('.takt') ?? []).length > 0) {
      throw unsafeTarget();
    }
    return {
      rootState: 'missing',
      candidatePaths,
      missingPaths: candidatePaths,
      missingPathTracking: Object.fromEntries(tracking),
      entries: [],
    };
  }
  try {
    rootRealPath = await realpath(taktRoot);
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
  const capturedActualPaths = new Set<string>();
  const collisionPaths = new Set<string>();
  const requestedNamesByParent = new Map<string, {
    relative: string;
    names: Set<string>;
  }>();
  const presentCandidatePaths: string[] = [];
  const missingPaths: string[] = [];
  let totalBytes = 0;
  for (const path of candidatePaths) {
    if (await inspectAncestors(
      taktRoot,
      path,
      ancestorSnapshots,
      directoryNames,
      directoryScanBudget,
    ) === 'missing') {
      checkpoint();
      missingPaths.push(path);
      continue;
    }
    checkpoint();
    presentCandidatePaths.push(path);
    const parentRelative = dirname(path) === '.' ? '' : dirname(path);
    const parentAbsolute = parentRelative === ''
      ? taktRoot
      : join(taktRoot, parentRelative);
    const requestedNameKey = basename(path).normalize('NFKC').toLowerCase();
    const group = requestedNamesByParent.get(parentAbsolute);
    if (group === undefined) {
      requestedNamesByParent.set(parentAbsolute, {
        relative: parentRelative,
        names: new Set([requestedNameKey]),
      });
    } else {
      group.names.add(requestedNameKey);
    }
  }
  for (const [parentAbsolute, group] of requestedNamesByParent) {
    const siblings = await readBoundedDirectory(
      parentAbsolute,
      directoryNames,
      directoryScanBudget,
    );
    checkpoint();
    for (const requestedName of group.names) {
      for (const sibling of siblings.get(requestedName) ?? []) {
        const siblingPath = group.relative === ''
          ? sibling
          : `${group.relative}/${sibling}`;
        collisionPaths.add(siblingPath);
      }
    }
  }
  for (const path of presentCandidatePaths) {
    const entry = await captureFile(join(taktRoot, path), path, rootRealPath);
    checkpoint();
    if (entry === undefined) {
      missingPaths.push(path);
      continue;
    }
    if (capturedActualPaths.has(entry.entry.path)) continue;
    capturedActualPaths.add(entry.entry.path);
    totalBytes += entry.entry.bytes;
    if (totalBytes > MAX_PROJECT_TEMPLATE_COHORT_BYTES) {
      throw new TaktpackError(
        'ARCHIVE_LIMIT_EXCEEDED',
        'project template target exceeds the snapshot byte budget',
        'target',
      );
    }
    captured.push(entry);
  }
  for (const path of [...collisionPaths].sort(compareAscii)) {
    const entry = await captureFile(join(taktRoot, path), path, rootRealPath);
    checkpoint();
    if (entry === undefined || capturedActualPaths.has(entry.entry.path)) continue;
    capturedActualPaths.add(entry.entry.path);
    totalBytes += entry.entry.bytes;
    if (totalBytes > MAX_PROJECT_TEMPLATE_COHORT_BYTES) {
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
    candidatePaths,
  );
  checkpoint();

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
    checkpoint();
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
    checkpoint();
    if (!areProjectTemplateFileStatsEqual(snapshot, after)) throw unsafeTarget();
  }
  for (const path of missingPaths) {
    try {
      await lstat(join(taktRoot, path));
      throw unsafeTarget();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    checkpoint();
  }

  const entries = captured.map(({ entry }): CapturedProjectTemplateTargetEntry => ({
    ...entry,
    gitTrackingStatus: tracking.get(entry.path) ?? 'unavailable',
  }));
  checkpoint();
  return {
    rootState: 'directory',
    candidatePaths,
    missingPaths,
    missingPathTracking: Object.fromEntries(
      missingPaths.map((path) => [path, tracking.get(path) ?? 'unavailable']),
    ),
    entries,
  };
}
