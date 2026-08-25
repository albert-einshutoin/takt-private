import {
  Stats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export const MAX_WORKFLOW_RESOURCE_BYTES = 2 * 1024 * 1024;

const safeReflectApply = Reflect.apply.bind(Reflect);
const safeStatsIsFileMethod = Stats.prototype.isFile;
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const safeBufferAlloc = Buffer.alloc.bind(Buffer);
const safeBufferSubarrayMethod = Buffer.prototype.subarray;
const safeBufferToStringMethod = Buffer.prototype.toString;
const safeNumberIsSafeInteger = Number.isSafeInteger.bind(Number);
const safeGetUid = typeof process.getuid === 'function' ? process.getuid.bind(process) : undefined;

export class WorkflowResourceReadError extends Error {
  readonly code = 'WORKFLOW_RESOURCE_READ_FAILED';

  constructor() {
    super('Workflow resource read failed');
    this.name = 'WorkflowResourceReadError';
  }
}

export interface WorkflowResourceReadProbe {
  afterOpen?: (path: string) => void;
  afterRead?: (path: string) => void;
}

/**
 * Reads non-repertoire workflow resources without following leaf or parent
 * aliases. Descriptor and path identities are rechecked because a plain
 * readFileSync would otherwise accept hard links and replacement races.
 */
export function readStableWorkflowResourceText(
  path: string,
  trustedBaseDir: string,
  probe: WorkflowResourceReadProbe = {},
): string {
  let fd: number | undefined;
  let approvedText: string | undefined;
  let operationError: WorkflowResourceReadError | undefined;
  let closeError: WorkflowResourceReadError | undefined;
  try {
    const relativePath = relative(trustedBaseDir, path);
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) throw failed();
    const root = lstatRequired(trustedBaseDir);
    assertApprovedRoot(root);
    const realRoot = realpathSync(trustedBaseDir);
    const segments = relativePath.split(sep);
    const directoryFrames: Array<{ path: string; realPath: string; stat: Stats }> = [];
    let directoryPath = trustedBaseDir;
    let expectedDirectoryRealPath = realRoot;
    for (const segment of segments.slice(0, -1)) {
      directoryPath = join(directoryPath, segment);
      expectedDirectoryRealPath = join(expectedDirectoryRealPath, segment);
      const stat = lstatRequired(directoryPath);
      assertApprovedDirectory(stat, root);
      if (realpathSync(directoryPath) !== expectedDirectoryRealPath) throw failed();
      directoryFrames.push({ path: directoryPath, realPath: expectedDirectoryRealPath, stat });
    }
    const expectedRealPath = join(realRoot, relativePath);
    const before = lstatRequired(path);
    assertApprovedFile(before, root);
    if (realpathSync(path) !== expectedRealPath) throw failed();

    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    assertApprovedFile(opened, root);
    if (!sameStableIdentity(before, opened) || opened.size > MAX_WORKFLOW_RESOURCE_BYTES) throw failed();
    probe.afterOpen?.(path);
    const bytes = readBounded(fd, opened.size);
    probe.afterRead?.(path);

    const openedAfter = fstatSync(fd);
    const pathAfter = lstatRequired(path);
    const rootAfter = lstatRequired(trustedBaseDir);
    if (
      bytes.length !== opened.size
      || !sameStableIdentity(root, rootAfter)
      || realpathSync(trustedBaseDir) !== realRoot
      || realpathSync(path) !== expectedRealPath
      || !sameStableIdentity(opened, openedAfter)
      || !sameStableIdentity(opened, pathAfter)
    ) throw failed();
    for (const frame of directoryFrames) {
      const after = lstatRequired(frame.path);
      if (!sameStableIdentity(frame.stat, after) || realpathSync(frame.path) !== frame.realPath) throw failed();
    }
    approvedText = safeReflectApply(safeBufferToStringMethod, bytes, ['utf-8']) as string;
  } catch (error) {
    operationError = error instanceof WorkflowResourceReadError ? error : failed();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        closeError = failed();
      }
    }
  }
  if (closeError !== undefined) throw closeError;
  if (operationError !== undefined) throw operationError;
  if (approvedText === undefined) throw failed();
  return approvedText;
}

function lstatRequired(path: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    throw failed();
  }
}

function assertApprovedRoot(stat: Stats): void {
  if (
    !(safeReflectApply(safeStatsIsDirectoryMethod, stat, []) as boolean)
    || (safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, []) as boolean)
    || (safeGetUid !== undefined && stat.uid !== safeGetUid())
    || (stat.mode & 0o022) !== 0
  ) throw failed();
}

function assertApprovedDirectory(stat: Stats, root: Stats): void {
  if (
    !(safeReflectApply(safeStatsIsDirectoryMethod, stat, []) as boolean)
    || (safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, []) as boolean)
    || stat.dev !== root.dev
    || (safeGetUid !== undefined && stat.uid !== safeGetUid())
    || (stat.mode & 0o022) !== 0
  ) throw failed();
}

function assertApprovedFile(stat: Stats, root: Stats): void {
  if (
    !(safeReflectApply(safeStatsIsFileMethod, stat, []) as boolean)
    || (safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, []) as boolean)
    || stat.dev !== root.dev
    || stat.nlink !== 1
    || (stat.mode & 0o022) !== 0
    || (safeGetUid !== undefined && stat.uid !== safeGetUid())
    || !safeNumberIsSafeInteger(stat.size)
    || stat.size < 0
  ) throw failed();
}

function sameStableIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readBounded(fd: number, expectedSize: number): Buffer {
  if (expectedSize > MAX_WORKFLOW_RESOURCE_BYTES) throw failed();
  const bytes = safeBufferAlloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const count = readSync(fd, bytes, offset, expectedSize - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (readSync(fd, safeBufferAlloc(1), 0, 1, expectedSize) !== 0) throw failed();
  return offset === expectedSize
    ? bytes
    : safeReflectApply(safeBufferSubarrayMethod, bytes, [0, offset]) as Buffer;
}

function failed(): WorkflowResourceReadError {
  return new WorkflowResourceReadError();
}
