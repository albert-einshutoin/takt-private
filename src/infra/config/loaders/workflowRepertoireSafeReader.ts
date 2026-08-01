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
import { WorkflowDiscoveryReadError } from './workflowDiscoveryError.js';

export const MAX_REPERTOIRE_WORKFLOW_BYTES = 2 * 1024 * 1024;

const safeReflectApply = Reflect.apply.bind(Reflect);
const safeStatsIsFileMethod = Stats.prototype.isFile;
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const safeBufferAlloc = Buffer.alloc.bind(Buffer);
const safeBufferSubarrayMethod = Buffer.prototype.subarray;
const safeBufferToStringMethod = Buffer.prototype.toString;
const safeNumberIsSafeInteger = Number.isSafeInteger.bind(Number);
const safeGetUid = typeof process.getuid === 'function' ? process.getuid.bind(process) : undefined;

export interface RepertoireWorkflowReadAuthority {
  assertRead(): void;
  expectedRealPath: string;
  path: string;
  repertoireDir: string;
}

export interface RepertoireWorkflowReadProbe {
  /** Test-only race injection after the approved descriptor has been opened. */
  afterOpen?: (path: string) => void;
  /** Test-only race injection after bounded bytes have been read. */
  afterRead?: (path: string) => void;
}

/** @internal Returns the only bytes that workflow parsing may consume for repertoire YAML. */
export function readApprovedRepertoireWorkflowText(
  authority: RepertoireWorkflowReadAuthority,
  probe: RepertoireWorkflowReadProbe = {},
): string {
  const { assertRead, expectedRealPath, path, repertoireDir } = authority;
  let fd: number | undefined;
  let approvedText: string | undefined;
  let operationError: WorkflowDiscoveryReadError | undefined;
  let closeError: WorkflowDiscoveryReadError | undefined;
  try {
    const root = lstatApproved(repertoireDir, assertRead);
    if (
      !(safeReflectApply(safeStatsIsDirectoryMethod, root, []) as boolean)
      || (safeReflectApply(safeStatsIsSymbolicLinkMethod, root, []) as boolean)
      || (safeGetUid !== undefined && root.uid !== safeGetUid())
      || (root.mode & 0o022) !== 0
    ) throw failed();
    const before = lstatApproved(path, assertRead);
    assertApprovedWorkflowFile(before, root);
    assertRead();
    const resolvedBefore = realpathSync(path);
    if (resolvedBefore !== expectedRealPath) throw failed();

    assertRead();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertRead();
    const opened = fstatSync(fd);
    assertApprovedWorkflowFile(opened, root);
    if (!sameStableIdentity(before, opened) || opened.size > MAX_REPERTOIRE_WORKFLOW_BYTES) {
      throw failed();
    }
    probe.afterOpen?.(path);
    const bytes = readBounded(fd, opened.size, assertRead);
    probe.afterRead?.(path);

    assertRead();
    const openedAfter = fstatSync(fd);
    const pathAfter = lstatApproved(path, assertRead);
    assertRead();
    const resolvedAfter = realpathSync(path);
    if (
      bytes.length !== opened.size
      || resolvedAfter !== resolvedBefore
      || !sameStableIdentity(opened, openedAfter)
      || !sameStableIdentity(opened, pathAfter)
    ) throw failed();
    approvedText = safeReflectApply(safeBufferToStringMethod, bytes, ['utf-8']) as string;
  } catch (error) {
    operationError = error instanceof WorkflowDiscoveryReadError ? error : failed();
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

function lstatApproved(path: string, assertRead: () => void): Stats {
  assertRead();
  try {
    return lstatSync(path);
  } catch {
    throw failed();
  }
}

function assertApprovedWorkflowFile(stat: Stats, root: Stats): void {
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

function readBounded(fd: number, expectedSize: number, assertRead: () => void): Buffer {
  if (expectedSize > MAX_REPERTOIRE_WORKFLOW_BYTES) throw failed();
  const bytes = safeBufferAlloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    assertRead();
    const count = readSync(fd, bytes, offset, expectedSize - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  assertRead();
  if (readSync(fd, safeBufferAlloc(1), 0, 1, expectedSize) !== 0) throw failed();
  return offset === expectedSize
    ? bytes
    : safeReflectApply(safeBufferSubarrayMethod, bytes, [0, offset]) as Buffer;
}

function failed(): WorkflowDiscoveryReadError {
  return new WorkflowDiscoveryReadError();
}
