import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';

const safeReflectApply = Reflect.apply.bind(Reflect);
const safeArraySortMethod = Array.prototype.sort;
const safeArrayJoinMethod = Array.prototype.join;
const safeArrayPushMethod = Array.prototype.push;
const safeStringStartsWithMethod = String.prototype.startsWith;
const safeNumber = Number;
const safeArraySort = (values: string[]): string[] => (
  safeReflectApply(safeArraySortMethod, values, []) as string[]
);
const safeArrayJoin = (values: string[], separator: string): string => (
  safeReflectApply(safeArrayJoinMethod, values, [separator]) as string
);
const safeArrayPush = <T>(values: T[], value: T): void => {
  safeReflectApply(safeArrayPushMethod, values, [value]);
};
const safeStringStartsWith = (value: string, search: string): boolean => (
  safeReflectApply(safeStringStartsWithMethod, value, [search]) as boolean
);

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
};

export type TreeProof = {
  dev: number;
  ino: number;
  mode: number;
  realpath: string;
  contentFingerprint: string;
};

export type ParentProof = {
  dev: number;
  ino: number;
  mode: number;
  realpath: string;
};

type FileStat = NonNullable<ReturnType<typeof lstatSync>>;

export function captureRegularFileProof(path: string, containmentRoot: string): FileProof {
  try {
    const rootRealpath = realpathSync(containmentRoot);
    const before = lstatSync(path);
    const resolvedBefore = realpathSync(path);
    assertContained(resolvedBefore, rootRealpath);
    assertRegularFile(before);
    const bytes = readFileSync(path);
    const after = lstatSync(path);
    const resolvedAfter = realpathSync(path);
    assertRegularFile(after);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.mode !== after.mode
      || before.nlink !== after.nlink
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || resolvedBefore !== resolvedAfter
    ) throw new RepertoireFilesystemProofError();
    return {
      path,
      realpath: resolvedAfter,
      dev: safeNumber(after.dev),
      ino: safeNumber(after.ino),
      mode: after.mode,
      nlink: after.nlink,
      size: safeNumber(after.size),
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if (error instanceof RepertoireFilesystemProofError) throw error;
    throw new RepertoireFilesystemProofError();
  }
}

export function captureDirectoryTreeProof(path: string, containmentRoot: string): TreeProof {
  try {
    const containmentRealpath = realpathSync(containmentRoot);
    const root = lstatSync(path);
    assertDirectory(root);
    const rootRealpath = realpathSync(path);
    assertContained(rootRealpath, containmentRealpath);
    const records: string[] = [];
    visitTree(path, path, rootRealpath, records);
    const fresh = lstatSync(path);
    assertDirectory(fresh);
    if (root.dev !== fresh.dev || root.ino !== fresh.ino || root.mode !== fresh.mode) {
      throw new RepertoireFilesystemProofError();
    }
    return {
      dev: safeNumber(fresh.dev),
      ino: safeNumber(fresh.ino),
      mode: fresh.mode,
      realpath: rootRealpath,
      contentFingerprint: createHash('sha256').update(safeArrayJoin(records, '\0')).digest('hex'),
    };
  } catch (error) {
    if (error instanceof RepertoireFilesystemProofError) throw error;
    throw new RepertoireFilesystemProofError();
  }
}

export function captureNearestParentProof(path: string, containmentRoot: string): ParentProof {
  try {
    const containmentRealpath = realpathSync(containmentRoot);
    let candidate = dirname(path);
    while (!existsSync(candidate)) {
      const parent = dirname(candidate);
      if (parent === candidate) throw new RepertoireFilesystemProofError();
      candidate = parent;
    }
    const stat = lstatSync(candidate);
    assertDirectory(stat);
    const resolved = realpathSync(candidate);
    assertContained(resolved, containmentRealpath);
    return { dev: safeNumber(stat.dev), ino: safeNumber(stat.ino), mode: stat.mode, realpath: resolved };
  } catch (error) {
    if (error instanceof RepertoireFilesystemProofError) throw error;
    throw new RepertoireFilesystemProofError();
  }
}

export function sameFileProof(left: FileProof, right: FileProof): boolean {
  return left.path === right.path && left.realpath === right.realpath
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size && left.digest === right.digest;
}

export function sameTreeProof(left: TreeProof, right: TreeProof, allowRelocation = false): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.contentFingerprint === right.contentFingerprint
    && (allowRelocation || left.realpath === right.realpath);
}

export function sameParentProof(left: ParentProof, right: ParentProof): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.realpath === right.realpath;
}

function visitTree(root: string, directory: string, rootRealpath: string, records: string[]): void {
  const entries = safeArraySort(readdirSync(directory));
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const child = `${directory}/${entry}`;
    const stat = lstatSync(child);
    const childRealpath = realpathSync(child);
    assertContained(childRealpath, rootRealpath);
    const relativePath = relative(root, child);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      safeArrayPush(records, `d:${relativePath}:${stat.dev}:${stat.ino}:${stat.mode}`);
      visitTree(root, child, rootRealpath, records);
      continue;
    }
    assertRegularFile(stat);
    const proof = captureRegularFileProof(child, root);
    safeArrayPush(records, safeArrayJoin([
      'f', relativePath, `${proof.dev}`, `${proof.ino}`, `${proof.mode}`,
      `${proof.nlink}`, `${proof.size}`, proof.digest,
    ], ':'));
  }
}

function assertDirectory(stat: FileStat): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RepertoireFilesystemProofError();
}

function assertRegularFile(stat: FileStat): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new RepertoireFilesystemProofError();
  }
}

function assertContained(path: string, root: string): void {
  const relativePath = relative(root, path);
  if (safeStringStartsWith(relativePath, '..') || isAbsolute(relativePath)) {
    throw new RepertoireFilesystemProofError();
  }
}
