import { createHash } from 'node:crypto';
import {
  Stats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

export const PROOF_MAX_DEPTH = 32;
export const PROOF_MAX_ENTRIES = 4_096;
export const PROOF_MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
export const PROOF_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const safeReflectApply = Reflect.apply.bind(Reflect);
const safeArraySortMethod = Array.prototype.sort;
const safeArrayJoinMethod = Array.prototype.join;
const safeArrayPushMethod = Array.prototype.push;
const safeStringStartsWithMethod = String.prototype.startsWith;
const safeBigIntToStringMethod = BigInt.prototype.toString;
const safeStatsIsFileMethod = Stats.prototype.isFile;
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const safeNumber = Number;
const safeBufferAlloc = Buffer.alloc.bind(Buffer);
const safeBufferConcat = Buffer.concat.bind(Buffer);
const FILE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

export class RepertoireFilesystemProofError extends Error {
  readonly code = 'RECOVERY_REQUIRED' as const;

  constructor() {
    super('Repertoire filesystem state could not be proven safe');
    this.name = 'RepertoireFilesystemProofError';
  }
}

export type FileProof = {
  path: string;
  realpath: string;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  digest: string;
  stableIdentity: string;
};

export type ApprovedFile = { proof: FileProof; bytes: Buffer };

export type TreeProof = {
  dev: number;
  ino: number;
  mode: number;
  realpath: string;
  contentFingerprint: string;
  stableIdentity: string;
};

export type ParentProof = {
  dev: number;
  ino: number;
  mode: number;
  realpath: string;
  stableIdentity: string;
};

export type TreeProofProbe = {
  /** Test-only race injection after a directory's first sorted listing. */
  afterDirectoryRead?: (directory: string) => void;
};

export function readApprovedRegularFile(path: string, containmentRoot: string): ApprovedFile {
  try {
    const rootRealpath = realpathSync(containmentRoot);
    const pathBefore = lstatBigInt(path);
    assertRegularFile(pathBefore);
    const resolvedBefore = realpathSync(path);
    assertContained(resolvedBefore, rootRealpath);
    let fd: number | undefined;
    try {
      fd = openSync(path, FILE_OPEN_FLAGS);
      const opened = fstatSync(fd, { bigint: true });
      assertRegularFile(opened);
      assertSameStableStat(pathBefore, opened);
      if (opened.size > BigInt(PROOF_MAX_SINGLE_FILE_BYTES)) throw recovery();
      const bytes = readBounded(fd, safeNumber(opened.size));
      const openedAfter = fstatSync(fd, { bigint: true });
      const pathAfter = lstatBigInt(path);
      const resolvedAfter = realpathSync(path);
      assertSameStableStat(opened, openedAfter);
      assertSameStableStat(opened, pathAfter);
      if (resolvedBefore !== resolvedAfter || bytes.length !== safeNumber(opened.size)) throw recovery();
      const stableIdentity = stableStatDigest(openedAfter);
      return {
        bytes,
        proof: {
          path,
          realpath: resolvedAfter,
          dev: safeNumber(openedAfter.dev),
          ino: safeNumber(openedAfter.ino),
          mode: safeNumber(openedAfter.mode),
          nlink: safeNumber(openedAfter.nlink),
          size: safeNumber(openedAfter.size),
          digest: createHash('sha256').update(bytes).digest('hex'),
          stableIdentity,
        },
      };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  } catch (error) {
    if (error instanceof RepertoireFilesystemProofError) throw error;
    throw recovery();
  }
}

export function captureRegularFileProof(path: string, containmentRoot: string): FileProof {
  return readApprovedRegularFile(path, containmentRoot).proof;
}

export function captureDirectoryTreeProof(
  path: string,
  containmentRoot: string,
  probe: TreeProofProbe = {},
): TreeProof {
  try {
    const containmentRealpath = realpathSync(containmentRoot);
    const first = captureTreeSnapshot(path, containmentRealpath, probe);
    const second = captureTreeSnapshot(path, containmentRealpath, {});
    if (first.snapshotDigest !== second.snapshotDigest) throw recovery();
    return second.proof;
  } catch (error) {
    if (error instanceof RepertoireFilesystemProofError) throw error;
    throw recovery();
  }
}

export function captureNearestParentProof(path: string, containmentRoot: string): ParentProof {
  try {
    const containmentRealpath = realpathSync(containmentRoot);
    let candidate = dirname(path);
    let stat: BigIntStats;
    while (true) {
      try {
        stat = lstatBigInt(candidate);
        break;
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parent = dirname(candidate);
        if (parent === candidate) throw recovery();
        candidate = parent;
      }
    }
    assertDirectory(stat);
    const resolved = realpathSync(candidate);
    assertContained(resolved, containmentRealpath);
    return {
      dev: safeNumber(stat.dev),
      ino: safeNumber(stat.ino),
      mode: safeNumber(stat.mode),
      realpath: resolved,
      stableIdentity: stableStatDigest(stat),
    };
  } catch (error) {
    if (error instanceof RepertoireFilesystemProofError) throw error;
    throw recovery();
  }
}

export function sameFileProof(left: FileProof, right: FileProof): boolean {
  return left.path === right.path && left.realpath === right.realpath
    && left.stableIdentity === right.stableIdentity && left.digest === right.digest;
}

export function sameTreeProof(left: TreeProof, right: TreeProof, allowRelocation = false): boolean {
  return left.stableIdentity === right.stableIdentity
    && left.contentFingerprint === right.contentFingerprint
    && (allowRelocation || left.realpath === right.realpath);
}

export function sameParentProof(left: ParentProof, right: ParentProof): boolean {
  return left.stableIdentity === right.stableIdentity && left.realpath === right.realpath;
}

function captureTreeSnapshot(
  path: string,
  containmentRealpath: string,
  probe: TreeProofProbe,
): { proof: TreeProof; snapshotDigest: string } {
  const root = lstatBigInt(path);
  assertDirectory(root);
  const rootRealpath = realpathSync(path);
  assertContained(rootRealpath, containmentRealpath);
  const budget = { entries: 0, totalBytes: 0 };
  const records: string[] = [];
  visitTree(path, path, rootRealpath, records, budget, 0, probe);
  const fresh = lstatBigInt(path);
  assertDirectory(fresh);
  assertSameStableStat(root, fresh);
  const stableIdentity = stableStatDigest(fresh);
  const contentFingerprint = createHash('sha256').update(safeArrayJoin(records, '\0')).digest('hex');
  return {
    proof: {
      dev: safeNumber(fresh.dev),
      ino: safeNumber(fresh.ino),
      mode: safeNumber(fresh.mode),
      realpath: rootRealpath,
      contentFingerprint,
      stableIdentity,
    },
    snapshotDigest: createHash('sha256')
      .update(`${stableIdentity}\0${contentFingerprint}\0${budget.entries}\0${budget.totalBytes}`)
      .digest('hex'),
  };
}

function visitTree(
  root: string,
  directory: string,
  rootRealpath: string,
  records: string[],
  budget: { entries: number; totalBytes: number },
  depth: number,
  probe: TreeProofProbe,
): void {
  if (depth > PROOF_MAX_DEPTH) throw recovery();
  const directoryBefore = lstatBigInt(directory);
  assertDirectory(directoryBefore);
  const entriesBefore = sortedEntries(directory);
  probe.afterDirectoryRead?.(directory);
  for (let index = 0; index < entriesBefore.length; index += 1) {
    budget.entries += 1;
    if (budget.entries > PROOF_MAX_ENTRIES) throw recovery();
    const entry = entriesBefore[index]!;
    const child = join(directory, entry);
    const stat = lstatBigInt(child);
    const childRealpath = realpathSync(child);
    assertContained(childRealpath, rootRealpath);
    const relativePath = relative(root, child);
    if (isDirectory(stat) && !isSymbolicLink(stat)) {
      safeArrayPush(records, `d:${relativePath}:${stableStatDigest(stat)}`);
      visitTree(root, child, rootRealpath, records, budget, depth + 1, probe);
      continue;
    }
    assertRegularFile(stat);
    const approved = readApprovedRegularFile(child, root);
    budget.totalBytes += approved.bytes.length;
    if (budget.totalBytes > PROOF_MAX_TOTAL_BYTES) throw recovery();
    safeArrayPush(records, safeArrayJoin([
      'f', relativePath, approved.proof.stableIdentity, approved.proof.digest,
    ], ':'));
  }
  const entriesAfter = sortedEntries(directory);
  const directoryAfter = lstatBigInt(directory);
  assertSameStableStat(directoryBefore, directoryAfter);
  if (safeArrayJoin(entriesBefore, '\0') !== safeArrayJoin(entriesAfter, '\0')) throw recovery();
}

function readBounded(fd: number, expectedSize: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < expectedSize) {
    const chunk = safeBufferAlloc(Math.min(64 * 1024, expectedSize - total));
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    safeArrayPush(chunks, count === chunk.length ? chunk : chunk.subarray(0, count));
  }
  const probe = safeBufferAlloc(1);
  if (readSync(fd, probe, 0, 1, null) !== 0) throw recovery();
  return safeBufferConcat(chunks, total);
}

function sortedEntries(directory: string): string[] {
  return safeArraySort(readdirSync(directory));
}

function lstatBigInt(path: string): BigIntStats {
  return lstatSync(path, { bigint: true });
}

function stableStatDigest(stat: BigIntStats): string {
  return safeArrayJoin([
    bigintString(stat.dev), bigintString(stat.ino), bigintString(stat.mode),
    bigintString(stat.uid), bigintString(stat.nlink), bigintString(stat.size),
    bigintString(stat.mtimeNs), bigintString(stat.ctimeNs),
  ], ':');
}

function assertSameStableStat(left: BigIntStats, right: BigIntStats): void {
  if (stableStatDigest(left) !== stableStatDigest(right)) throw recovery();
}

function isFile(stat: BigIntStats): boolean {
  return safeReflectApply(safeStatsIsFileMethod, stat, []) as boolean;
}

function isDirectory(stat: BigIntStats): boolean {
  return safeReflectApply(safeStatsIsDirectoryMethod, stat, []) as boolean;
}

function isSymbolicLink(stat: BigIntStats): boolean {
  return safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, []) as boolean;
}

function assertDirectory(stat: BigIntStats): void {
  if (!isDirectory(stat) || isSymbolicLink(stat)) throw recovery();
}

function assertRegularFile(stat: BigIntStats): void {
  if (!isFile(stat) || isSymbolicLink(stat) || stat.nlink !== 1n) throw recovery();
}

function assertContained(path: string, root: string): void {
  const relativePath = relative(root, path);
  if (safeStringStartsWith(relativePath, '..') || isAbsolute(relativePath)) throw recovery();
}

function bigintString(value: bigint): string {
  return safeReflectApply(safeBigIntToStringMethod, value, [10]) as string;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function recovery(): RepertoireFilesystemProofError {
  return new RepertoireFilesystemProofError();
}

function safeArraySort(values: string[]): string[] {
  return safeReflectApply(safeArraySortMethod, values, []) as string[];
}

function safeArrayJoin(values: string[], separator: string): string {
  return safeReflectApply(safeArrayJoinMethod, values, [separator]) as string;
}

function safeArrayPush<T>(values: T[], value: T): void {
  safeReflectApply(safeArrayPushMethod, values, [value]);
}

function safeStringStartsWith(value: string, search: string): boolean {
  return safeReflectApply(safeStringStartsWithMethod, value, [search]) as boolean;
}
