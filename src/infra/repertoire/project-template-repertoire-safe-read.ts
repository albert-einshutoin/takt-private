import { Buffer } from 'node:buffer';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

const MAX_RELATIVE_PATH_LENGTH = 1024;
const MAX_RELATIVE_PATH_DEPTH = 32;
const MAX_DIRECTORY_ENTRIES = 1024;
const FILE_LIMITS = {
  lock: 64 * 1024,
  manifest: 64 * 1024,
  workflow: 1024 * 1024,
  provider: 1024 * 1024,
} as const;
const PORTABLE_SEGMENT_PATTERN =
  /^(?![ .])(?!.*[ .]$)[A-Za-z0-9._-]+$/;
const WINDOWS_RESERVED_SEGMENT_PATTERN =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i;
// eslint-disable-next-line no-control-regex -- portable paths reject C0/DEL.
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_REFLECT_APPLY = Reflect.apply;

const SAFE_READ_CONTEXTS =
  new WeakMap<ProjectTemplateRepertoireSafeReadContext, SafeReadState>();

export type ProjectTemplateRepertoireSafeReadFileClass =
  keyof typeof FILE_LIMITS;

export type ProjectTemplateRepertoireSafeReadPhase =
  | 'before-lstat'
  | 'after-lstat'
  | 'after-open'
  | 'after-fstat'
  | 'after-content'
  | 'after-postcheck'
  | 'before-close'
  | 'after-close';

export type ProjectTemplateRepertoireSafeReadRaceHook = (
  relativePath: string,
  phase: ProjectTemplateRepertoireSafeReadPhase,
) => void;

export type ProjectTemplateRepertoireSafeReadErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_CONTEXT'
  | 'INVALID_PATH'
  | 'UNSAFE_ROOT'
  | 'UNSAFE_ENTRY'
  | 'LIMIT_EXCEEDED'
  | 'CHANGED_DURING_READ'
  | 'READ_FAILED';

const ERROR_MESSAGES:
Record<ProjectTemplateRepertoireSafeReadErrorCode, string> = {
  INVALID_ARGUMENT: 'Repertoire safe-read argument is invalid',
  INVALID_CONTEXT: 'Repertoire safe-read context is invalid',
  INVALID_PATH: 'Repertoire relative path is invalid',
  UNSAFE_ROOT: 'Repertoire root is unsafe',
  UNSAFE_ENTRY: 'Repertoire entry is unsafe',
  LIMIT_EXCEEDED: 'Repertoire read limit was exceeded',
  CHANGED_DURING_READ: 'Repertoire entry changed during read',
  READ_FAILED: 'Repertoire read failed',
};

export class ProjectTemplateRepertoireSafeReadError extends Error {
  constructor(
    public readonly code: ProjectTemplateRepertoireSafeReadErrorCode,
  ) {
    super(ERROR_MESSAGES[code]);
    const descriptor = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_CREATE,
      CAPTURED_OBJECT_RECEIVER,
      [null],
    ) as PropertyDescriptor;
    // Why: even internal failures can cross an authority boundary; defining
    // the own name must not invoke a post-init prototype setter.
    descriptor.configurable = true;
    descriptor.enumerable = true;
    descriptor.value = 'ProjectTemplateRepertoireSafeReadError';
    descriptor.writable = true;
    CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_DEFINE_PROPERTY,
      CAPTURED_OBJECT_RECEIVER,
      [this, 'name', descriptor],
    );
  }
}

export interface ProjectTemplateRepertoireSafeReadContext {
  readonly kind: 'project-template-repertoire-safe-read-context';
}

interface Identity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface SafeReadState {
  readonly root: string;
  readonly rootIdentity: Identity;
  readonly raceHook?: ProjectTemplateRepertoireSafeReadRaceHook;
}

export interface ProjectTemplateRepertoireRelativeWitness {
  readonly kind: 'file' | 'directory';
  readonly relativePath: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface ProjectTemplateRepertoireSafeFileRead {
  readonly kind: 'file';
  readonly relativePath: string;
  /** Private infrastructure bytes; never include these in public errors. */
  readonly content: Buffer;
  readonly witness: ProjectTemplateRepertoireRelativeWitness;
}

export interface ProjectTemplateRepertoireSafeDirectoryRead {
  readonly kind: 'directory';
  readonly relativePath: string;
  readonly entries: readonly string[];
  readonly witness: ProjectTemplateRepertoireRelativeWitness;
}

function failure(
  code: ProjectTemplateRepertoireSafeReadErrorCode,
): ProjectTemplateRepertoireSafeReadError {
  return new ProjectTemplateRepertoireSafeReadError(code);
}

function identity(stat: Stats): Identity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function relativeWitness(
  kind: 'file' | 'directory',
  relativePath: string,
  value: Identity,
): ProjectTemplateRepertoireRelativeWitness {
  return Object.freeze({
    kind,
    relativePath,
    ...value,
  });
}

function invokePhase(
  state: SafeReadState,
  relativePath: string,
  phase: ProjectTemplateRepertoireSafeReadPhase,
): void {
  if (state.raceHook === undefined) return;
  try {
    state.raceHook(relativePath, phase);
  } catch {
    throw failure('READ_FAILED');
  }
}

function requireContext(
  context: ProjectTemplateRepertoireSafeReadContext,
): SafeReadState {
  if (
    typeof context !== 'object'
    || context === null
    || !SAFE_READ_CONTEXTS.has(context)
  ) throw failure('INVALID_CONTEXT');
  return SAFE_READ_CONTEXTS.get(context)!;
}

function validateRelativePath(relativePath: unknown): string[] {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.length > MAX_RELATIVE_PATH_LENGTH
    || relativePath === '.'
    || isAbsolute(relativePath)
    || relativePath.startsWith('/')
    || relativePath.startsWith('\\')
    || /^[A-Za-z]:/.test(relativePath)
    || relativePath.includes('\\')
    || relativePath.includes('//')
    || CONTROL_PATTERN.test(relativePath)
  ) throw failure('INVALID_PATH');
  const segments = relativePath.split('/');
  if (
    segments.length === 0
    || segments.length > MAX_RELATIVE_PATH_DEPTH
  ) throw failure('INVALID_PATH');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (
      segment === '.'
      || segment === '..'
      || segment.length > 255
      || WINDOWS_RESERVED_SEGMENT_PATTERN.test(segment)
      || !PORTABLE_SEGMENT_PATTERN.test(segment)
    ) throw failure('INVALID_PATH');
  }
  return segments;
}

function safeLstat(path: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    throw failure('READ_FAILED');
  }
}

function requireStableRoot(state: SafeReadState): void {
  let current: Stats;
  try {
    current = lstatSync(state.root);
  } catch {
    throw failure('UNSAFE_ROOT');
  }
  if (
    !current.isDirectory()
    || current.isSymbolicLink()
    || !sameIdentity(identity(current), state.rootIdentity)
  ) throw failure('UNSAFE_ROOT');
}

function requireUnchangedRoot(state: SafeReadState): void {
  try {
    requireStableRoot(state);
  } catch {
    throw failure('CHANGED_DURING_READ');
  }
}

function requireCanonicalPath(
  state: SafeReadState,
  segments: readonly string[],
  includeFinal: boolean,
): string {
  let current = state.root;
  const count = includeFinal ? segments.length : segments.length - 1;
  for (let index = 0; index < count; index += 1) {
    current = join(current, segments[index]!);
    const stat = safeLstat(current);
    if (
      stat.isSymbolicLink()
      || (index < count - 1 && !stat.isDirectory())
    ) throw failure('UNSAFE_ENTRY');
    let canonical: string;
    try {
      canonical = realpathSync.native(current);
    } catch {
      throw failure('READ_FAILED');
    }
    if (canonical !== current) throw failure('UNSAFE_ENTRY');
  }
  return join(state.root, ...segments);
}

function openNoFollow(path: string, directory: boolean): number {
  // Why: platforms without O_NOFOLLOW are allowed only behind the canonical
  // realpath and full pre/post identity checks performed by the caller.
  const noFollow = typeof constants.O_NOFOLLOW === 'number'
    ? constants.O_NOFOLLOW
    : 0;
  const directoryFlag = directory
    && typeof constants.O_DIRECTORY === 'number'
    ? constants.O_DIRECTORY
    : 0;
  try {
    return openSync(path, constants.O_RDONLY | noFollow | directoryFlag);
  } catch {
    throw failure('UNSAFE_ENTRY');
  }
}

function requireEntryType(
  stat: Stats,
  directory: boolean,
): void {
  if (
    stat.isSymbolicLink()
    || (directory ? !stat.isDirectory() : !stat.isFile())
    || (!directory && stat.nlink !== 1)
  ) throw failure('UNSAFE_ENTRY');
}

function postcheck(
  state: SafeReadState,
  relativePath: string,
  absolutePath: string,
  before: Identity,
  descriptor: number,
  directory: boolean,
  segments: readonly string[],
): Identity {
  try {
    const descriptorAfter = fstatSync(descriptor);
    const pathAfter = lstatSync(absolutePath);
    requireEntryType(descriptorAfter, directory);
    requireEntryType(pathAfter, directory);
    const descriptorIdentity = identity(descriptorAfter);
    const pathIdentity = identity(pathAfter);
    requireCanonicalPath(state, segments, true);
    requireUnchangedRoot(state);
    if (
      !sameIdentity(before, descriptorIdentity)
      || !sameIdentity(before, pathIdentity)
    ) throw failure('CHANGED_DURING_READ');
    invokePhase(state, relativePath, 'after-postcheck');
    return descriptorIdentity;
  } catch {
    throw failure('CHANGED_DURING_READ');
  }
}

function closeDescriptor(
  state: SafeReadState,
  relativePath: string,
  descriptor: number,
): void {
  invokePhase(state, relativePath, 'before-close');
  try {
    closeSync(descriptor);
  } catch {
    throw failure('READ_FAILED');
  }
  invokePhase(state, relativePath, 'after-close');
}

export function createProjectTemplateRepertoireSafeReadContext(
  root: string,
  raceHook?: ProjectTemplateRepertoireSafeReadRaceHook,
): ProjectTemplateRepertoireSafeReadContext {
  if (
    typeof root !== 'string'
    || !isAbsolute(root)
    || (
      raceHook !== undefined
      && typeof raceHook !== 'function'
    )
  ) throw failure('INVALID_ARGUMENT');
  let canonicalRoot: string;
  let rootStat: Stats;
  try {
    canonicalRoot = realpathSync.native(root);
    rootStat = lstatSync(canonicalRoot);
  } catch {
    throw failure('UNSAFE_ROOT');
  }
  if (
    !rootStat.isDirectory()
    || rootStat.isSymbolicLink()
  ) throw failure('UNSAFE_ROOT');
  const context = Object.freeze({
    kind: 'project-template-repertoire-safe-read-context' as const,
  });
  SAFE_READ_CONTEXTS.set(context, {
    root: canonicalRoot,
    rootIdentity: identity(rootStat),
    ...(raceHook === undefined ? {} : { raceHook }),
  });
  return context;
}

export function readProjectTemplateRepertoireFile(
  context: ProjectTemplateRepertoireSafeReadContext,
  relativePath: string,
  fileClass: ProjectTemplateRepertoireSafeReadFileClass,
): ProjectTemplateRepertoireSafeFileRead {
  const state = requireContext(context);
  if (
    fileClass !== 'lock'
    && fileClass !== 'manifest'
    && fileClass !== 'workflow'
    && fileClass !== 'provider'
  ) throw failure('INVALID_ARGUMENT');
  const segments = validateRelativePath(relativePath);
  requireStableRoot(state);
  const absolutePath = requireCanonicalPath(state, segments, true);
  invokePhase(state, relativePath, 'before-lstat');
  const pathBefore = safeLstat(absolutePath);
  requireEntryType(pathBefore, false);
  const before = identity(pathBefore);
  invokePhase(state, relativePath, 'after-lstat');
  const descriptor = openNoFollow(absolutePath, false);
  let closed = false;
  try {
    invokePhase(state, relativePath, 'after-open');
    const descriptorBefore = fstatSync(descriptor);
    try {
      requireEntryType(descriptorBefore, false);
    } catch {
      throw failure('CHANGED_DURING_READ');
    }
    if (!sameIdentity(before, identity(descriptorBefore))) {
      throw failure('CHANGED_DURING_READ');
    }
    invokePhase(state, relativePath, 'after-fstat');
    const limit = FILE_LIMITS[fileClass];
    if (before.size > limit) throw failure('LIMIT_EXCEEDED');
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const remaining = limit + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(count === chunk.length ? chunk : chunk.subarray(0, count));
      total += count;
    }
    if (total > limit) throw failure('LIMIT_EXCEEDED');
    const content = Buffer.concat(chunks, total);
    invokePhase(state, relativePath, 'after-content');
    const stable = postcheck(
      state,
      relativePath,
      absolutePath,
      before,
      descriptor,
      false,
      segments,
    );
    if (stable.size !== total) throw failure('CHANGED_DURING_READ');
    closeDescriptor(state, relativePath, descriptor);
    closed = true;
    return Object.freeze({
      kind: 'file' as const,
      relativePath,
      content,
      witness: relativeWitness('file', relativePath, stable),
    });
  } catch (error) {
    if (!closed) {
      try {
        closeSync(descriptor);
      } catch {
        throw failure('READ_FAILED');
      }
    }
    if (error instanceof ProjectTemplateRepertoireSafeReadError) throw error;
    throw failure('READ_FAILED');
  }
}

function validateDirectoryEntryName(name: string): string {
  if (
    name.length === 0
    || name.length > 255
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || CONTROL_PATTERN.test(name)
    || !PORTABLE_SEGMENT_PATTERN.test(name)
  ) throw failure('UNSAFE_ENTRY');
  return name.normalize('NFC').toLowerCase();
}

function sortEntries(entries: string[]): void {
  for (let index = 1; index < entries.length; index += 1) {
    const value = entries[index]!;
    let cursor = index;
    while (cursor > 0 && entries[cursor - 1]! > value) {
      entries[cursor] = entries[cursor - 1]!;
      cursor -= 1;
    }
    entries[cursor] = value;
  }
}

export function readProjectTemplateRepertoireDirectory(
  context: ProjectTemplateRepertoireSafeReadContext,
  relativePath: string,
): ProjectTemplateRepertoireSafeDirectoryRead {
  const state = requireContext(context);
  const segments = validateRelativePath(relativePath);
  requireStableRoot(state);
  const absolutePath = requireCanonicalPath(state, segments, true);
  invokePhase(state, relativePath, 'before-lstat');
  const pathBefore = safeLstat(absolutePath);
  requireEntryType(pathBefore, true);
  const before = identity(pathBefore);
  invokePhase(state, relativePath, 'after-lstat');
  const descriptor = openNoFollow(absolutePath, true);
  let directory: ReturnType<typeof opendirSync> | undefined;
  let descriptorClosed = false;
  let directoryClosed = false;
  try {
    // Open the incremental reader before the first attacker-visible phase.
    // Both descriptors therefore bind the verified directory even if the
    // path is replaced and restored between later phase callbacks.
    directory = opendirSync(absolutePath);
    invokePhase(state, relativePath, 'after-open');
    const descriptorBefore = fstatSync(descriptor);
    try {
      requireEntryType(descriptorBefore, true);
    } catch {
      throw failure('CHANGED_DURING_READ');
    }
    if (!sameIdentity(before, identity(descriptorBefore))) {
      throw failure('CHANGED_DURING_READ');
    }
    invokePhase(state, relativePath, 'after-fstat');
    // Node has no synchronous fd-based readdir API. Keep both descriptors
    // open, read incrementally, then require the O_NOFOLLOW descriptor and
    // path identities to remain exact.
    const entries: string[] = [];
    const normalized = new Set<string>();
    while (entries.length <= MAX_DIRECTORY_ENTRIES) {
      const entry = directory.readSync();
      if (entry === null) break;
      const normalizedName = validateDirectoryEntryName(entry.name);
      if (normalized.has(normalizedName)) throw failure('UNSAFE_ENTRY');
      normalized.add(normalizedName);
      entries.push(entry.name);
    }
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw failure('LIMIT_EXCEEDED');
    }
    sortEntries(entries);
    invokePhase(state, relativePath, 'after-content');
    const stable = postcheck(
      state,
      relativePath,
      absolutePath,
      before,
      descriptor,
      true,
      segments,
    );
    invokePhase(state, relativePath, 'before-close');
    directory.closeSync();
    directoryClosed = true;
    closeSync(descriptor);
    descriptorClosed = true;
    invokePhase(state, relativePath, 'after-close');
    return Object.freeze({
      kind: 'directory' as const,
      relativePath,
      entries: Object.freeze(entries),
      witness: relativeWitness('directory', relativePath, stable),
    });
  } catch (error) {
    if (directory !== undefined && !directoryClosed) {
      try {
        directory.closeSync();
      } catch {
        throw failure('READ_FAILED');
      }
    }
    if (!descriptorClosed) {
      try {
        closeSync(descriptor);
      } catch {
        throw failure('READ_FAILED');
      }
    }
    if (error instanceof ProjectTemplateRepertoireSafeReadError) throw error;
    throw failure('READ_FAILED');
  }
}
