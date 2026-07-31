import { Buffer } from 'node:buffer';
import {
  closeSync,
  constants,
  Dir,
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
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_WEAK_MAP_GET = WeakMap.prototype.get;
const CAPTURED_WEAK_MAP_SET = WeakMap.prototype.set;
const CAPTURED_WEAK_SET_ADD = WeakSet.prototype.add;
const CAPTURED_WEAK_SET_HAS = WeakSet.prototype.has;
const CAPTURED_REGEXP_TEST = RegExp.prototype.test;
const CAPTURED_STRING_INCLUDES = String.prototype.includes;
const CAPTURED_STRING_NORMALIZE = String.prototype.normalize;
const CAPTURED_STRING_SPLIT = String.prototype.split;
const CAPTURED_STRING_STARTS_WITH = String.prototype.startsWith;
const CAPTURED_STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const CAPTURED_BUFFER_ALLOC_UNSAFE = Buffer.allocUnsafe;
const CAPTURED_BUFFER_COPY = Buffer.prototype.copy;
const CAPTURED_DIR_READ_SYNC = Dir.prototype.readSync;
const CAPTURED_DIR_CLOSE_SYNC = Dir.prototype.closeSync;
const CAPTURED_CLOSE_SYNC = closeSync;
const CAPTURED_FSTAT_SYNC = fstatSync;
const CAPTURED_LSTAT_SYNC = lstatSync;
const CAPTURED_OPEN_SYNC = openSync;
const CAPTURED_OPENDIR_SYNC = opendirSync;
const CAPTURED_READ_SYNC = readSync;
const CAPTURED_REALPATH_NATIVE = realpathSync.native;
const CAPTURED_IS_ABSOLUTE = isAbsolute;
const CAPTURED_JOIN = join;

const SAFE_READ_CONTEXTS =
  new WeakMap<ProjectTemplateRepertoireSafeReadContext, SafeReadState>();
const SAFE_READ_ERRORS = new WeakSet<object>();

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
  declare public readonly code: ProjectTemplateRepertoireSafeReadErrorCode;

  constructor(
    code: ProjectTemplateRepertoireSafeReadErrorCode,
  ) {
    const validatedCode = validateErrorCode(code);
    super(errorMessage(validatedCode));
    defineOwn(this, 'code', validatedCode);
    CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_SET_ADD,
      SAFE_READ_ERRORS,
      [this],
    );
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

function validateErrorCode(
  code: unknown,
): ProjectTemplateRepertoireSafeReadErrorCode {
  switch (code) {
    case 'INVALID_ARGUMENT':
    case 'INVALID_CONTEXT':
    case 'INVALID_PATH':
    case 'UNSAFE_ROOT':
    case 'UNSAFE_ENTRY':
    case 'LIMIT_EXCEEDED':
    case 'CHANGED_DURING_READ':
    case 'READ_FAILED':
      return code;
    default:
      return 'INVALID_ARGUMENT';
  }
}

function errorMessage(
  code: ProjectTemplateRepertoireSafeReadErrorCode,
): string {
  switch (code) {
    case 'INVALID_ARGUMENT': return ERROR_MESSAGES.INVALID_ARGUMENT;
    case 'INVALID_CONTEXT': return ERROR_MESSAGES.INVALID_CONTEXT;
    case 'INVALID_PATH': return ERROR_MESSAGES.INVALID_PATH;
    case 'UNSAFE_ROOT': return ERROR_MESSAGES.UNSAFE_ROOT;
    case 'UNSAFE_ENTRY': return ERROR_MESSAGES.UNSAFE_ENTRY;
    case 'LIMIT_EXCEEDED': return ERROR_MESSAGES.LIMIT_EXCEEDED;
    case 'CHANGED_DURING_READ': return ERROR_MESSAGES.CHANGED_DURING_READ;
    case 'READ_FAILED': return ERROR_MESSAGES.READ_FAILED;
    default: return ERROR_MESSAGES.INVALID_ARGUMENT;
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

function isFailure(
  value: unknown,
): value is ProjectTemplateRepertoireSafeReadError {
  return typeof value === 'object'
    && value !== null
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_SET_HAS,
      SAFE_READ_ERRORS,
      [value],
    ) === true;
}

function freeze<T>(value: T): Readonly<T> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Readonly<T>;
}

function defineOwn(
  target: object,
  key: PropertyKey,
  value: unknown,
): void {
  const descriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE,
    CAPTURED_OBJECT_RECEIVER,
    [null],
  ) as PropertyDescriptor;
  descriptor.configurable = true;
  descriptor.enumerable = true;
  descriptor.value = value;
  descriptor.writable = true;
  CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_DEFINE_PROPERTY,
    CAPTURED_OBJECT_RECEIVER,
    [target, key, descriptor],
  );
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
  return freeze({
    kind,
    relativePath,
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
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
  if (typeof context !== 'object' || context === null) {
    throw failure('INVALID_CONTEXT');
  }
  const state = CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_MAP_GET,
    SAFE_READ_CONTEXTS,
    [context],
  ) as SafeReadState | undefined;
  if (state === undefined) throw failure('INVALID_CONTEXT');
  return state;
}

function validateRelativePath(relativePath: unknown): string[] {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.length > MAX_RELATIVE_PATH_LENGTH
    || relativePath === '.'
    || CAPTURED_REFLECT_APPLY(CAPTURED_IS_ABSOLUTE, undefined, [relativePath])
    || CAPTURED_REFLECT_APPLY(CAPTURED_STRING_STARTS_WITH, relativePath, ['/'])
    || CAPTURED_REFLECT_APPLY(CAPTURED_STRING_STARTS_WITH, relativePath, ['\\'])
    || CAPTURED_REFLECT_APPLY(CAPTURED_REGEXP_TEST, /^[A-Za-z]:/, [relativePath])
    || CAPTURED_REFLECT_APPLY(CAPTURED_STRING_INCLUDES, relativePath, ['\\'])
    || CAPTURED_REFLECT_APPLY(CAPTURED_STRING_INCLUDES, relativePath, ['//'])
    || CAPTURED_REFLECT_APPLY(CAPTURED_REGEXP_TEST, CONTROL_PATTERN, [relativePath])
  ) throw failure('INVALID_PATH');
  const segments = CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_SPLIT,
    relativePath,
    ['/'],
  ) as string[];
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
      || CAPTURED_REFLECT_APPLY(
        CAPTURED_REGEXP_TEST,
        WINDOWS_RESERVED_SEGMENT_PATTERN,
        [segment],
      )
      || !CAPTURED_REFLECT_APPLY(
        CAPTURED_REGEXP_TEST,
        PORTABLE_SEGMENT_PATTERN,
        [segment],
      )
    ) throw failure('INVALID_PATH');
  }
  return segments;
}

function safeLstat(path: string): Stats {
  try {
    return CAPTURED_LSTAT_SYNC(path);
  } catch {
    throw failure('READ_FAILED');
  }
}

function requireStableRoot(state: SafeReadState): void {
  let current: Stats;
  try {
    current = CAPTURED_LSTAT_SYNC(state.root);
  } catch {
    throw failure('UNSAFE_ROOT');
  }
  if (
    !isDirectory(current)
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
    current = CAPTURED_JOIN(current, segments[index]!);
    const stat = safeLstat(current);
    if (
      isSymbolicLink(stat)
      || (index < count - 1 && !isDirectory(stat))
    ) throw failure('UNSAFE_ENTRY');
    let canonical: string;
    try {
      canonical = CAPTURED_REALPATH_NATIVE(current);
    } catch {
      throw failure('READ_FAILED');
    }
    if (canonical !== current) throw failure('UNSAFE_ENTRY');
  }
  let result = state.root;
  for (let index = 0; index < segments.length; index += 1) {
    result = CAPTURED_JOIN(result, segments[index]!);
  }
  return result;
}

function fileType(stat: Stats): number {
  return stat.mode & constants.S_IFMT;
}

function isDirectory(stat: Stats): boolean {
  return fileType(stat) === constants.S_IFDIR;
}

function isSymbolicLink(stat: Stats): boolean {
  return fileType(stat) === constants.S_IFLNK;
}

function isFile(stat: Stats): boolean {
  return fileType(stat) === constants.S_IFREG;
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
    return CAPTURED_OPEN_SYNC(
      path,
      constants.O_RDONLY | noFollow | directoryFlag,
    );
  } catch {
    throw failure('UNSAFE_ENTRY');
  }
}

function requireEntryType(
  stat: Stats,
  directory: boolean,
): void {
  if (
    isSymbolicLink(stat)
    || (directory ? !isDirectory(stat) : !isFile(stat))
    || (!directory && stat.nlink !== 1)
  ) throw failure('UNSAFE_ENTRY');
}

function postcheck(
  state: SafeReadState,
  absolutePath: string,
  before: Identity,
  descriptor: number,
  directory: boolean,
  segments: readonly string[],
): Identity {
  try {
    const descriptorAfter = CAPTURED_FSTAT_SYNC(descriptor);
    const pathAfter = CAPTURED_LSTAT_SYNC(absolutePath);
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
    return descriptorIdentity;
  } catch (error) {
    if (isFailure(error) && error.code === 'CHANGED_DURING_READ') throw error;
    throw failure('CHANGED_DURING_READ');
  }
}

function pathPostcheck(
  state: SafeReadState,
  absolutePath: string,
  before: Identity,
  directory: boolean,
  segments: readonly string[],
): void {
  try {
    const pathAfter = CAPTURED_LSTAT_SYNC(absolutePath);
    requireEntryType(pathAfter, directory);
    requireCanonicalPath(state, segments, true);
    requireUnchangedRoot(state);
    if (!sameIdentity(before, identity(pathAfter))) {
      throw failure('CHANGED_DURING_READ');
    }
  } catch {
    throw failure('CHANGED_DURING_READ');
  }
}

export function createProjectTemplateRepertoireSafeReadContext(
  root: string,
  raceHook?: ProjectTemplateRepertoireSafeReadRaceHook,
): ProjectTemplateRepertoireSafeReadContext {
  if (
    typeof root !== 'string'
    || !CAPTURED_REFLECT_APPLY(CAPTURED_IS_ABSOLUTE, undefined, [root])
    || (
      raceHook !== undefined
      && typeof raceHook !== 'function'
    )
  ) throw failure('INVALID_ARGUMENT');
  let canonicalRoot: string;
  let rootStat: Stats;
  try {
    canonicalRoot = CAPTURED_REALPATH_NATIVE(root);
    rootStat = CAPTURED_LSTAT_SYNC(canonicalRoot);
  } catch {
    throw failure('UNSAFE_ROOT');
  }
  if (
    !isDirectory(rootStat)
    || isSymbolicLink(rootStat)
  ) throw failure('UNSAFE_ROOT');
  const context = freeze({
    kind: 'project-template-repertoire-safe-read-context' as const,
  });
  const state = freeze({
    root: canonicalRoot,
    rootIdentity: identity(rootStat),
    raceHook,
  });
  CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_MAP_SET,
    SAFE_READ_CONTEXTS,
    [context, state],
  );
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
    const descriptorBefore = CAPTURED_FSTAT_SYNC(descriptor);
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
    const chunks = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_CREATE,
      CAPTURED_OBJECT_RECEIVER,
      [null],
    ) as Record<number, Buffer>;
    const chunkLengths = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_CREATE,
      CAPTURED_OBJECT_RECEIVER,
      [null],
    ) as Record<number, number>;
    let chunkCount = 0;
    let total = 0;
    while (total <= limit) {
      const remaining = limit + 1 - total;
      const chunk = CAPTURED_REFLECT_APPLY(
        CAPTURED_BUFFER_ALLOC_UNSAFE,
        Buffer,
        [remaining < 64 * 1024 ? remaining : 64 * 1024],
      ) as Buffer;
      const count = CAPTURED_READ_SYNC(
        descriptor,
        chunk,
        0,
        chunk.length,
        null,
      );
      if (count === 0) break;
      defineOwn(chunks, chunkCount, chunk);
      defineOwn(chunkLengths, chunkCount, count);
      chunkCount += 1;
      total += count;
    }
    if (total > limit) throw failure('LIMIT_EXCEEDED');
    const content = CAPTURED_REFLECT_APPLY(
      CAPTURED_BUFFER_ALLOC_UNSAFE,
      Buffer,
      [total],
    ) as Buffer;
    let contentOffset = 0;
    for (let index = 0; index < chunkCount; index += 1) {
      const count = chunkLengths[index]!;
      CAPTURED_REFLECT_APPLY(
        CAPTURED_BUFFER_COPY,
        chunks[index]!,
        [content, contentOffset, 0, count],
      );
      contentOffset += count;
    }
    invokePhase(state, relativePath, 'after-content');
    let stable = postcheck(
      state,
      absolutePath,
      before,
      descriptor,
      false,
      segments,
    );
    if (stable.size !== total) throw failure('CHANGED_DURING_READ');
    invokePhase(state, relativePath, 'after-postcheck');
    stable = postcheck(
      state,
      absolutePath,
      before,
      descriptor,
      false,
      segments,
    );
    if (stable.size !== total) throw failure('CHANGED_DURING_READ');
    invokePhase(state, relativePath, 'before-close');
    stable = postcheck(
      state,
      absolutePath,
      before,
      descriptor,
      false,
      segments,
    );
    if (stable.size !== total) throw failure('CHANGED_DURING_READ');
    try {
      CAPTURED_CLOSE_SYNC(descriptor);
    } catch {
      throw failure('READ_FAILED');
    }
    closed = true;
    invokePhase(state, relativePath, 'after-close');
    pathPostcheck(state, absolutePath, before, false, segments);
    return freeze({
      kind: 'file' as const,
      relativePath,
      content,
      witness: relativeWitness('file', relativePath, stable),
    });
  } catch (error) {
    if (!closed) {
      try {
        CAPTURED_CLOSE_SYNC(descriptor);
      } catch {
        throw failure('READ_FAILED');
      }
    }
    if (isFailure(error)) throw error;
    throw failure('READ_FAILED');
  }
}

function validateDirectoryEntryName(name: string): string {
  if (
    name.length === 0
    || name.length > 255
    || name === '.'
    || name === '..'
    || CAPTURED_REFLECT_APPLY(CAPTURED_STRING_INCLUDES, name, ['/'])
    || CAPTURED_REFLECT_APPLY(CAPTURED_STRING_INCLUDES, name, ['\\'])
    || CAPTURED_REFLECT_APPLY(CAPTURED_REGEXP_TEST, CONTROL_PATTERN, [name])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_REGEXP_TEST,
      WINDOWS_RESERVED_SEGMENT_PATTERN,
      [name],
    )
    || !CAPTURED_REFLECT_APPLY(
      CAPTURED_REGEXP_TEST,
      PORTABLE_SEGMENT_PATTERN,
      [name],
    )
  ) throw failure('UNSAFE_ENTRY');
  const normalized = CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_NORMALIZE,
    name,
    ['NFC'],
  ) as string;
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_TO_LOWER_CASE,
    normalized,
    [],
  ) as string;
}

function sortEntries(entries: string[]): void {
  for (let index = 1; index < entries.length; index += 1) {
    const value = entries[index]!;
    let cursor = index;
    while (cursor > 0 && entries[cursor - 1]! > value) {
      defineOwn(entries, cursor, entries[cursor - 1]!);
      cursor -= 1;
    }
    defineOwn(entries, cursor, value);
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
    directory = CAPTURED_OPENDIR_SYNC(absolutePath);
    invokePhase(state, relativePath, 'after-open');
    const descriptorBefore = CAPTURED_FSTAT_SYNC(descriptor);
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
    const normalized: string[] = [];
    while (entries.length <= MAX_DIRECTORY_ENTRIES) {
      const entry = CAPTURED_REFLECT_APPLY(
        CAPTURED_DIR_READ_SYNC,
        directory,
        [],
      ) as ReturnType<Dir['readSync']>;
      if (entry === null) break;
      const normalizedName = validateDirectoryEntryName(entry.name);
      for (let index = 0; index < normalized.length; index += 1) {
        if (normalized[index] === normalizedName) {
          throw failure('UNSAFE_ENTRY');
        }
      }
      defineOwn(normalized, normalized.length, normalizedName);
      defineOwn(entries, entries.length, entry.name);
    }
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw failure('LIMIT_EXCEEDED');
    }
    sortEntries(entries);
    invokePhase(state, relativePath, 'after-content');
    let stable = postcheck(
      state,
      absolutePath,
      before,
      descriptor,
      true,
      segments,
    );
    invokePhase(state, relativePath, 'after-postcheck');
    stable = postcheck(
      state,
      absolutePath,
      before,
      descriptor,
      true,
      segments,
    );
    invokePhase(state, relativePath, 'before-close');
    stable = postcheck(
      state,
      absolutePath,
      before,
      descriptor,
      true,
      segments,
    );
    CAPTURED_REFLECT_APPLY(CAPTURED_DIR_CLOSE_SYNC, directory, []);
    directoryClosed = true;
    CAPTURED_CLOSE_SYNC(descriptor);
    descriptorClosed = true;
    invokePhase(state, relativePath, 'after-close');
    pathPostcheck(state, absolutePath, before, true, segments);
    return freeze({
      kind: 'directory' as const,
      relativePath,
      entries: freeze(entries),
      witness: relativeWitness('directory', relativePath, stable),
    });
  } catch (error) {
    if (directory !== undefined && !directoryClosed) {
      try {
        CAPTURED_REFLECT_APPLY(CAPTURED_DIR_CLOSE_SYNC, directory, []);
      } catch {
        throw failure('READ_FAILED');
      }
    }
    if (!descriptorClosed) {
      try {
        CAPTURED_CLOSE_SYNC(descriptor);
      } catch {
        throw failure('READ_FAILED');
      }
    }
    if (isFailure(error)) throw error;
    throw failure('READ_FAILED');
  }
}
