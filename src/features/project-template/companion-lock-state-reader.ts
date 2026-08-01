import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseTemplateLock, serializeTemplateLock } from './lock.js';
import {
  MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES,
  parseProjectTemplateRepertoireDependencyLockJson,
  PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
  type ProjectTemplateRepertoireDependencyLockV1,
} from './repertoire-dependency-lock.js';
import {
  MAX_PROJECT_TEMPLATE_SOURCE_PROVENANCE_BYTES,
  parseProjectTemplateSourceProvenanceJson,
  PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
  type ProjectTemplateSourceProvenanceV1,
} from './source-provenance.js';
import type { TemplateLockV1 } from './types.js';

const CONTENT_LOCK_PATH = '.takt-template-lock.json';
const MAX_CONTENT_LOCK_BYTES = 4 * 1024 * 1024;
const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const DIRECTORY_FLAG = process.platform === 'win32' ? 0 : constants.O_DIRECTORY;
const PREVIOUS_LOCKS_DOMAIN =
  'takt.project-template.previous-companion-locks.v1\u0000';

export type ProjectTemplateCompanionLockStateErrorCode =
  | 'UNSAFE_ROOT'
  | 'MIXED_STATE'
  | 'UNSAFE_LOCK'
  | 'UNREADABLE_LOCK'
  | 'INVALID_LOCK'
  | 'LIMIT_EXCEEDED';

export class ProjectTemplateCompanionLockStateError extends Error {
  constructor(
    public readonly code: ProjectTemplateCompanionLockStateErrorCode,
  ) {
    super('project template companion lock state cannot be proven safe');
    this.name = 'ProjectTemplateCompanionLockStateError';
    Object.freeze(this);
  }
}

interface OpenedLock {
  readonly path: string;
  readonly fd: number;
  readonly before: Stats;
  readonly content: Uint8Array;
}

interface MissingLock {
  readonly path: string;
}

type ObservedLock = OpenedLock | MissingLock;

export interface ProjectTemplateFirstInstallCompanionLockState {
  readonly state: 'first-install';
  readonly previousLocksSha256: string;
}

export interface ProjectTemplateUpdateCompanionLockState {
  readonly state: 'update';
  readonly contentLock: Readonly<TemplateLockV1>;
  readonly repertoireLock: ProjectTemplateRepertoireDependencyLockV1;
  readonly sourceProvenance: ProjectTemplateSourceProvenanceV1;
  readonly lockSha256: Readonly<Record<
    | typeof CONTENT_LOCK_PATH
    | typeof PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH
    | typeof PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
    string
  >>;
  readonly previousLocksSha256: string;
}

export type ProjectTemplateCompanionLockState =
  | ProjectTemplateFirstInstallCompanionLockState
  | ProjectTemplateUpdateCompanionLockState;

function fail(code: ProjectTemplateCompanionLockStateErrorCode): never {
  throw new ProjectTemplateCompanionLockStateError(code);
}

function sameStats(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function maxBytes(path: string): number {
  if (path.endsWith(PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH)) {
    return MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES;
  }
  if (path.endsWith(PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH)) {
    return MAX_PROJECT_TEMPLATE_SOURCE_PROVENANCE_BYTES;
  }
  return MAX_CONTENT_LOCK_BYTES;
}

function observe(path: string): ObservedLock {
  let pathStat: Stats;
  try {
    pathStat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path };
    fail('UNREADABLE_LOCK');
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1) {
    fail('UNSAFE_LOCK');
  }

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') fail('UNSAFE_LOCK');
    fail('UNREADABLE_LOCK');
  }
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile()
      || before.nlink !== 1
      || !sameStats(pathStat, before)
    ) fail('UNSAFE_LOCK');
    if (before.size < 0 || before.size > maxBytes(path)) fail('LIMIT_EXCEEDED');

    const content = new Uint8Array(before.size + 1);
    let offset = 0;
    while (offset < content.byteLength) {
      const count = readSync(
        fd,
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    if (offset !== before.size) fail('UNSAFE_LOCK');
    const after = fstatSync(fd);
    if (!sameStats(before, after)) fail('UNSAFE_LOCK');
    return {
      path,
      fd,
      before,
      content: content.slice(0, offset),
    };
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // The original failure remains fail-closed.
    }
    throw error;
  }
}

function isOpened(value: ObservedLock): value is OpenedLock {
  return 'fd' in value;
}

function closeAll(observed: readonly ObservedLock[]): void {
  let closeFailed = false;
  for (let index = 0; index < observed.length; index += 1) {
    const lock = observed[index]!;
    if (!isOpened(lock)) continue;
    try {
      closeSync(lock.fd);
    } catch {
      closeFailed = true;
    }
  }
  if (closeFailed) fail('UNREADABLE_LOCK');
}

function verifyRootStable(path: string, fd: number, before: Stats): void {
  let opened: Stats;
  let current: Stats;
  try {
    opened = fstatSync(fd);
    current = lstatSync(path);
  } catch {
    fail('UNSAFE_ROOT');
  }
  if (
    !opened.isDirectory()
    || current.isSymbolicLink()
    || !current.isDirectory()
    || !sameStats(before, opened)
    || !sameStats(before, current)
  ) fail('UNSAFE_ROOT');
}

function verifyCohortStable(observed: readonly ObservedLock[]): void {
  for (let index = 0; index < observed.length; index += 1) {
    const lock = observed[index]!;
    if (isOpened(lock)) {
      let pathStat: Stats;
      try {
        pathStat = lstatSync(lock.path);
      } catch {
        fail('UNSAFE_LOCK');
      }
      if (
        pathStat.isSymbolicLink()
        || !pathStat.isFile()
        || !sameStats(lock.before, pathStat)
        || !sameStats(lock.before, fstatSync(lock.fd))
      ) fail('UNSAFE_LOCK');
    } else {
      try {
        lstatSync(lock.path);
        fail('MIXED_STATE');
      } catch (error) {
        if (error instanceof ProjectTemplateCompanionLockStateError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          fail('UNREADABLE_LOCK');
        }
      }
    }
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function previousLocksSha256(
  hashes: Readonly<Record<string, string>> | undefined,
): string {
  const body = hashes === undefined
    ? '{"state":"first-install"}'
    : JSON.stringify({
      state: 'update',
      content: hashes[CONTENT_LOCK_PATH],
      repertoire: hashes[PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH],
      source: hashes[PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH],
    });
  return sha256(`${PREVIOUS_LOCKS_DOMAIN}${body}`);
}

function decodeUtf8(content: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(content);
  } catch {
    fail('INVALID_LOCK');
  }
}

function parseContentLock(content: Uint8Array): Readonly<TemplateLockV1> {
  const json = decodeUtf8(content);
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    fail('INVALID_LOCK');
  }
  let parsed: TemplateLockV1;
  try {
    parsed = parseTemplateLock(raw);
  } catch {
    fail('INVALID_LOCK');
  }
  if (serializeTemplateLock(parsed) !== json) fail('INVALID_LOCK');
  Object.freeze(parsed.source);
  for (let index = 0; index < parsed.entries.length; index += 1) {
    Object.freeze(parsed.entries[index]!.capabilities);
    Object.freeze(parsed.entries[index]);
  }
  Object.freeze(parsed.entries);
  Object.freeze(parsed.capabilities);
  return Object.freeze(parsed);
}

/**
 * Reads the formal content, repertoire, and source locks as one cohort.
 *
 * Why: a portable install is either new (000) or previously committed (111).
 * Accepting a partial cohort would turn crash residue or tampering into an
 * invented baseline. FDs stay open through the final path-identity check and
 * are disposed before any parsed state is returned.
 */
export function readProjectTemplateCompanionLockState(
  projectRoot: string,
): ProjectTemplateCompanionLockState {
  const absoluteRoot = resolve(projectRoot);
  let rootStat: Stats;
  try {
    rootStat = lstatSync(absoluteRoot);
  } catch {
    fail('UNSAFE_ROOT');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('UNSAFE_ROOT');

  let rootFd: number;
  try {
    rootFd = openSync(
      absoluteRoot,
      constants.O_RDONLY | NO_FOLLOW | DIRECTORY_FLAG,
    );
    verifyRootStable(absoluteRoot, rootFd, rootStat);
  } catch (error) {
    if (error instanceof ProjectTemplateCompanionLockStateError) throw error;
    fail('UNSAFE_ROOT');
  }

  const observed: ObservedLock[] = [];
  let closeFailure = false;
  try {
    observed.push(observe(join(absoluteRoot, CONTENT_LOCK_PATH)));
    observed.push(observe(join(
      absoluteRoot,
      PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
    )));
    observed.push(observe(join(
      absoluteRoot,
      PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
    )));
    const present = observed.filter(isOpened).length;
    if (present !== 0 && present !== 3) fail('MIXED_STATE');
    verifyCohortStable(observed);
    verifyRootStable(absoluteRoot, rootFd, rootStat);

    if (present === 0) {
      return Object.freeze({
        state: 'first-install' as const,
        previousLocksSha256: previousLocksSha256(undefined),
      });
    }

    const content = observed[0] as OpenedLock;
    const repertoire = observed[1] as OpenedLock;
    const source = observed[2] as OpenedLock;
    let contentLock: Readonly<TemplateLockV1>;
    let repertoireLock: ProjectTemplateRepertoireDependencyLockV1;
    let sourceProvenance: ProjectTemplateSourceProvenanceV1;
    try {
      contentLock = parseContentLock(content.content);
      repertoireLock = parseProjectTemplateRepertoireDependencyLockJson(
        repertoire.content,
      );
      sourceProvenance = parseProjectTemplateSourceProvenanceJson(source.content);
    } catch (error) {
      if (error instanceof ProjectTemplateCompanionLockStateError) throw error;
      fail('INVALID_LOCK');
    }
    const lockSha256 = Object.freeze({
      [CONTENT_LOCK_PATH]: sha256(content.content),
      [PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH]:
        sha256(repertoire.content),
      [PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH]: sha256(source.content),
    });
    return Object.freeze({
      state: 'update' as const,
      contentLock,
      repertoireLock,
      sourceProvenance,
      lockSha256,
      previousLocksSha256: previousLocksSha256(lockSha256),
    });
  } finally {
    try {
      closeAll(observed);
    } catch {
      closeFailure = true;
    }
    try {
      closeSync(rootFd);
    } catch {
      closeFailure = true;
    }
    if (closeFailure) fail('UNREADABLE_LOCK');
  }
}
