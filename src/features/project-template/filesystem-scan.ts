import { constants, type Stats } from 'node:fs';
import {
  lstat,
  open,
  opendir,
  realpath,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  classifyProjectTemplateEntry,
  createProjectTemplateBlockedResult,
} from './classifier-core.js';
import {
  areProjectTemplateFileStatsEqual,
  readBoundedProjectTemplateFile,
} from './bounded-file-read.js';
import type {
  ProjectTemplateClassificationReason,
  ProjectTemplateClassificationResult,
  ProjectTemplateScanLimits,
  ProjectTemplateScanOptions,
  ProjectTemplateScanResult,
} from './classifier-types.js';
import { DEFAULT_PROJECT_TEMPLATE_MAX_NODES } from './classifier-types.js';

const DEFAULT_LIMITS: ProjectTemplateScanLimits = {
  maxNodes: DEFAULT_PROJECT_TEMPLATE_MAX_NODES,
  maxFiles: 4_096,
  maxSingleFileBytes: 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxScanBytes: 4 * 1024 * 1024,
  maxDepth: 8,
};

interface MutableScan {
  entries: ProjectTemplateClassificationResult[];
  nodes: number;
  files: number;
  bytes: number;
  scannedBytes: number;
  incomplete: boolean;
  blocked: boolean;
  nodeLimitReached: boolean;
  portablePathKeys: Set<string>;
}

function safeMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

export function portablePathKey(path: string): string {
  // Case-insensitive NFKC catches collisions that would overwrite entries on
  // common destination filesystems even when the source filesystem permits them.
  return path.normalize('NFKC').toLocaleLowerCase('en-US');
}

export function areProjectTemplateDirectorySnapshotsStable(
  before: Stats,
  after: Stats,
): boolean {
  return before.isDirectory()
    && after.isDirectory()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.nlink === after.nlink
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function isInside(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

function limitEntry(
  scan: MutableScan,
  relativePath: string,
  reasonCode: ProjectTemplateClassificationReason,
  bytes = 0,
): void {
  scan.entries.push(createProjectTemplateBlockedResult(relativePath, reasonCode, bytes));
  scan.blocked = true;
}

function validateLimits(options: ProjectTemplateScanOptions): ProjectTemplateScanLimits | undefined {
  const bounded = (key: keyof ProjectTemplateScanLimits): number | undefined => {
    const defaultValue = DEFAULT_LIMITS[key];
    const requested = options[key] ?? defaultValue;
    if (!Number.isSafeInteger(requested) || requested < 0) return undefined;
    // Callers may tighten a budget, but cannot turn a bounded public API into
    // an unbounded allocator by raising its built-in safety ceilings.
    return Math.min(requested, defaultValue);
  };
  const limits = {
    maxNodes: bounded('maxNodes'),
    maxFiles: bounded('maxFiles'),
    maxSingleFileBytes: bounded('maxSingleFileBytes'),
    maxTotalBytes: bounded('maxTotalBytes'),
    maxScanBytes: bounded('maxScanBytes'),
    maxDepth: bounded('maxDepth'),
  };
  if (Object.values(limits).some((value) => value === undefined)) return undefined;
  return limits as ProjectTemplateScanLimits;
}

async function scanFile(
  absolutePath: string,
  relativePath: string,
  rootRealPath: string,
  absolutePathPrefixes: readonly string[],
  initialStat: Stats,
  limits: ProjectTemplateScanLimits,
  scan: MutableScan,
): Promise<void> {
  scan.files += 1;
  if (scan.files > limits.maxFiles) {
    limitEntry(scan, relativePath, 'FILE_LIMIT_EXCEEDED', initialStat.size);
    return;
  }
  if (initialStat.nlink > 1) {
    limitEntry(scan, relativePath, 'HARD_LINK', initialStat.size);
    return;
  }
  if (initialStat.size > limits.maxSingleFileBytes) {
    limitEntry(scan, relativePath, 'SINGLE_FILE_LIMIT_EXCEEDED', initialStat.size);
    return;
  }
  if (scan.bytes + initialStat.size > limits.maxTotalBytes) {
    limitEntry(scan, relativePath, 'TOTAL_BYTES_LIMIT_EXCEEDED', initialStat.size);
    return;
  }
  if (scan.scannedBytes + initialStat.size > limits.maxScanBytes) {
    limitEntry(scan, relativePath, 'SCAN_LIMIT_EXCEEDED', initialStat.size);
    return;
  }

  scan.bytes += initialStat.size;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const resolvedPath = await realpath(absolutePath);
    if (!isInside(rootRealPath, resolvedPath)) {
      limitEntry(scan, relativePath, 'PATH_ESCAPE', initialStat.size);
      return;
    }

    // Opening first and comparing fstat snapshots prevents a path swap from
    // making the scanner hash a different object than the one it classified.
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) {
      limitEntry(scan, relativePath, 'UNSUPPORTED_FILE_TYPE', before.size);
      return;
    }
    if (!areProjectTemplateFileStatsEqual(initialStat, before)) {
      limitEntry(scan, relativePath, 'FILE_CHANGED_DURING_SCAN', before.size);
      return;
    }
    if (before.nlink > 1) {
      limitEntry(scan, relativePath, 'HARD_LINK', before.size);
      return;
    }
    const readResult = await readBoundedProjectTemplateFile(handle, before.size);
    if (readResult.status === 'overflow') {
      limitEntry(scan, relativePath, readResult.reasonCode, before.size);
      return;
    }
    const { content } = readResult;
    const after = await handle.stat();
    if (!areProjectTemplateFileStatsEqual(before, after)) {
      limitEntry(scan, relativePath, 'FILE_CHANGED_DURING_SCAN', after.size);
      return;
    }
    scan.scannedBytes += content.byteLength;
    scan.entries.push(classifyProjectTemplateEntry({
      relativePath,
      content,
      absolutePathPrefixes,
      bytes: content.byteLength,
      mode: safeMode(before.mode),
    }));
  } catch {
    scan.entries.push(createProjectTemplateBlockedResult(relativePath, 'READ_FAILED', initialStat.size));
    scan.incomplete = true;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function walkDirectory(
  absoluteDirectory: string,
  relativeDirectory: string,
  depth: number,
  rootRealPath: string,
  absolutePathPrefixes: readonly string[],
  expectedStat: Stats,
  limits: ProjectTemplateScanLimits,
  scan: MutableScan,
): Promise<void> {
  if (scan.nodeLimitReached) return;
  let before: Stats;
  let directoryRealPath: string;
  try {
    before = await lstat(absoluteDirectory);
    directoryRealPath = await realpath(absoluteDirectory);
  } catch {
    scan.entries.push(createProjectTemplateBlockedResult(
      relativeDirectory || '.',
      'READ_FAILED',
    ));
    scan.incomplete = true;
    return;
  }
  if (
    before.isSymbolicLink()
    || !areProjectTemplateDirectorySnapshotsStable(expectedStat, before)
    || !isInside(rootRealPath, directoryRealPath)
  ) {
    limitEntry(scan, relativeDirectory || '.', 'DIRECTORY_CHANGED_DURING_SCAN');
    return;
  }

  const names: string[] = [];
  try {
    const directory = await opendir(absoluteDirectory);
    for await (const entry of directory) {
      scan.nodes += 1;
      if (scan.nodes > limits.maxNodes) {
        // maxNodes is shared by the whole walk. Ancestors check this flag after
        // recursion so no sibling can consume another entry after maxNodes + 1.
        scan.nodeLimitReached = true;
        limitEntry(scan, '[node-limit]', 'NODE_LIMIT_EXCEEDED');
        return;
      }
      names.push(entry.name);
    }
  } catch {
    scan.entries.push(createProjectTemplateBlockedResult(
      relativeDirectory || '.',
      'READ_FAILED',
    ));
    scan.incomplete = true;
    return;
  }
  try {
    const after = await lstat(absoluteDirectory);
    const afterRealPath = await realpath(absoluteDirectory);
    if (
      !areProjectTemplateDirectorySnapshotsStable(before, after)
      || afterRealPath !== directoryRealPath
    ) {
      limitEntry(scan, relativeDirectory || '.', 'DIRECTORY_CHANGED_DURING_SCAN');
      return;
    }
  } catch {
    limitEntry(scan, relativeDirectory || '.', 'DIRECTORY_CHANGED_DURING_SCAN');
    return;
  }
  names.sort((left, right) => left.localeCompare(right, 'en-US'));
  for (const name of names) {
    if (scan.nodeLimitReached) return;
    const absolutePath = join(absoluteDirectory, name);
    const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
    const pathPreflight = classifyProjectTemplateEntry({ relativePath, bytes: 0 });

    let entryStat: Stats;
    try {
      entryStat = await lstat(absolutePath);
    } catch {
      // Names returned by directory enumeration are untrusted until the named
      // inode and its real path are verified, so failures use a fixed sentinel.
      scan.entries.push(createProjectTemplateBlockedResult('[unverified-entry]', 'READ_FAILED'));
      scan.incomplete = true;
      continue;
    }
    if (entryStat.isSymbolicLink()) {
      limitEntry(scan, '[unverified-entry]', 'SYMLINK', entryStat.size);
      continue;
    }
    if (pathPreflight.classification === 'blocked') {
      scan.entries.push(classifyProjectTemplateEntry({
        relativePath,
        bytes: entryStat.size,
        mode: safeMode(entryStat.mode),
      }));
      scan.blocked = true;
      continue;
    }

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(absolutePath);
    } catch {
      scan.entries.push(createProjectTemplateBlockedResult('[unverified-entry]', 'READ_FAILED'));
      scan.incomplete = true;
      continue;
    }
    if (!isInside(rootRealPath, resolvedPath)) {
      limitEntry(scan, '[unverified-entry]', 'PATH_ESCAPE', entryStat.size);
      continue;
    }

    // The raw relative path becomes evidence only after inode lookup and
    // realpath containment both succeed.
    const displayPath = relativePath;
    const collisionKey = portablePathKey(relativePath);
    if (scan.portablePathKeys.has(collisionKey)) {
      limitEntry(scan, displayPath, 'PATH_COLLISION');
      continue;
    }
    scan.portablePathKeys.add(collisionKey);
    if (!entryStat.isDirectory() && !entryStat.isFile()) {
      limitEntry(scan, displayPath, 'UNSUPPORTED_FILE_TYPE', entryStat.size);
      continue;
    }
    if (entryStat.isFile() && entryStat.nlink > 1) {
      limitEntry(scan, displayPath, 'HARD_LINK', entryStat.size);
      continue;
    }
    if (depth + 1 > limits.maxDepth) {
      limitEntry(scan, displayPath, 'DEPTH_LIMIT_EXCEEDED');
      continue;
    }

    const metadataClassification = classifyProjectTemplateEntry({
      relativePath,
      bytes: entryStat.size,
      mode: safeMode(entryStat.mode),
    });
    if (
      metadataClassification.reasonCode === 'RUNTIME_STATE'
      || metadataClassification.reasonCode === 'SENSITIVE_FILENAME'
      || (entryStat.isFile() && metadataClassification.classification === 'excluded')
    ) {
      scan.entries.push(metadataClassification);
      if (metadataClassification.classification === 'blocked') scan.blocked = true;
      continue;
    }
    if (entryStat.isDirectory()) {
      await walkDirectory(
        absolutePath,
        relativePath,
        depth + 1,
        rootRealPath,
        absolutePathPrefixes,
        entryStat,
        limits,
        scan,
      );
      if (scan.nodeLimitReached) return;
      continue;
    }
    await scanFile(
      absolutePath,
      relativePath,
      rootRealPath,
      absolutePathPrefixes,
      entryStat,
      limits,
      scan,
    );
  }
}

export async function scanProjectTemplateDirectory(
  projectRoot: string,
  options: ProjectTemplateScanOptions = {},
): Promise<ProjectTemplateScanResult> {
  const limits = validateLimits(options);
  const scan: MutableScan = {
    entries: [],
    nodes: 0,
    files: 0,
    bytes: 0,
    scannedBytes: 0,
    incomplete: false,
    blocked: false,
    nodeLimitReached: false,
    portablePathKeys: new Set(),
  };
  if (limits === undefined) {
    limitEntry(scan, '.', 'ROOT_UNSAFE');
    return finish(scan);
  }

  const taktRoot = resolve(projectRoot, '.takt');
  try {
    const rootStat = await lstat(taktRoot);
    if (rootStat.isSymbolicLink()) {
      limitEntry(scan, '.', 'ROOT_SYMLINK');
      return finish(scan);
    }
    if (!rootStat.isDirectory()) {
      limitEntry(scan, '.', 'ROOT_UNSAFE');
      return finish(scan);
    }
    const projectRealPath = await realpath(projectRoot);
    const rootRealPath = await realpath(taktRoot);
    if (!isInside(projectRealPath, rootRealPath) || relative(projectRealPath, rootRealPath) !== '.takt') {
      limitEntry(scan, '.', 'PATH_ESCAPE');
      return finish(scan);
    }

    // `.devloop` is a sibling runtime tree. Recording only a fixed sentinel
    // proves it was excluded without opening or disclosing any of its children.
    try {
      await lstat(resolve(projectRoot, '.devloop'));
      scan.entries.push(classifyProjectTemplateEntry({
        relativePath: '.devloop',
        bytes: 0,
      }));
    } catch {
      // Absence is expected and does not affect exportability.
    }

    await walkDirectory(
      taktRoot,
      '',
      0,
      rootRealPath,
      [resolve(projectRoot), projectRealPath, rootRealPath, dirname(rootRealPath)],
      rootStat,
      limits,
      scan,
    );
  } catch {
    scan.entries.push(createProjectTemplateBlockedResult('.', 'ROOT_UNSAFE'));
    scan.blocked = true;
  }
  return finish(scan);
}

function finish(scan: MutableScan): ProjectTemplateScanResult {
  const hasBlockedEntry = scan.entries.some((entry) => entry.classification === 'blocked');
  const reviewRequired = scan.entries.some((entry) => entry.reviewRequired);
  const scanStatus = scan.blocked
    ? 'blocked'
    : scan.incomplete
      ? 'incomplete'
      : hasBlockedEntry
        ? 'blocked'
        : 'complete';
  return {
    scanStatus,
    canExport: scanStatus === 'complete' && !reviewRequired,
    reviewRequired,
    entries: scan.entries,
    counts: {
      nodes: scan.nodes,
      files: scan.files,
      bytes: scan.bytes,
    },
  };
}
