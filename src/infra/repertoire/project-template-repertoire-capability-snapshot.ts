import { createHash } from 'node:crypto';
import {
  constants,
  lstatSync,
  readdirSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { types } from 'node:util';
import type { ProviderOptionsFileAccess } from '../config/loaders/workflowProviderOptionsResolver.js';
import {
  createProjectTemplateRepertoireSafeReadContext,
  detachProjectTemplateRepertoireSafeReadContextCallbacks,
  inspectProjectTemplateRepertoireEntry,
  narrowProjectTemplateRepertoireSafeReadContext,
  readProjectTemplateRepertoireDirectory,
  readProjectTemplateRepertoireFile,
  readProjectTemplateRepertoireRootDirectory,
  type ProjectTemplateRepertoireRelativeWitness,
  type ProjectTemplateRepertoireSafeReadContext,
} from './project-template-repertoire-safe-read.js';
import {
  parseProjectTemplateRepertoireCapabilityYaml,
} from './project-template-repertoire-capability-yaml.js';

export const PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT =
  '/__takt_repertoire_package__';
const SNAPSHOT_VIRTUAL_ROOT = '/__takt_capability_snapshot__';
const MAX_PACKAGE_FILES = 500;
const MAX_REQUEST_FILES = 4096;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_ENTRIES = 8192;
const MAX_DEPTH = 32;
const YAML_EXTENSION = /\.ya?ml$/;
const SCOPE = /^@(?![a-z0-9-]*--)[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/(?!\.{1,2}$)(?!.*\.git$)[a-z0-9._-]{1,100}$/;
const CAPTURED_ABORTED_GETTER =
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const CAPTURED_PERFORMANCE_NOW = performance.now;
const CAPTURED_PERFORMANCE = performance;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_ARRAY_INCLUDES = Array.prototype.includes;
const CAPTURED_ARRAY_JOIN = Array.prototype.join;
const CAPTURED_ARRAY_SORT = Array.prototype.sort;
const CAPTURED_REGEXP_TEST = RegExp.prototype.test;
const CAPTURED_STRING_INCLUDES = String.prototype.includes;
const CAPTURED_STRING_SPLIT = String.prototype.split;
const CAPTURED_STRING_STARTS_WITH = String.prototype.startsWith;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;
const CAPTURED_LSTAT_SYNC = lstatSync;
const CAPTURED_READDIR_SYNC = readdirSync;
const CAPTURED_REALPATH_NATIVE = realpathSync.native;
const CAPTURED_DIRNAME = dirname;
const CAPTURED_IS_ABSOLUTE = isAbsolute;
const CAPTURED_WEAK_MAP_GET = WeakMap.prototype.get;
const CAPTURED_WEAK_MAP_SET = WeakMap.prototype.set;
const SNAPSHOT_STATES = new WeakMap<object, SnapshotState>();
const SNAPSHOT_ERRORS = new WeakSet<object>();
const CAPTURED_WEAK_SET_ADD = WeakSet.prototype.add;
const CAPTURED_WEAK_SET_HAS = WeakSet.prototype.has;
const HASH_SAMPLE = createHash('sha256');
const CAPTURED_HASH_UPDATE = HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_SAMPLE.digest;
let CAPTURE_ACTIVE = false;

export type ProjectTemplateRepertoireCapabilitySnapshotErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_CAPABILITY'
  | 'UNSAFE_INPUT'
  | 'LIMIT_EXCEEDED'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'OUTSIDE_REGISTRY'
  | 'MISSING'
  | 'CHANGED';

const ERROR_MESSAGES:
Record<ProjectTemplateRepertoireCapabilitySnapshotErrorCode, string> = {
  INVALID_ARGUMENT: 'Repertoire capability snapshot argument is invalid',
  INVALID_CAPABILITY: 'Repertoire capability input is invalid',
  UNSAFE_INPUT: 'Repertoire capability input is unsafe',
  LIMIT_EXCEEDED: 'Repertoire capability snapshot limit was exceeded',
  ABORTED: 'Repertoire capability snapshot was aborted',
  TIMEOUT: 'Repertoire capability snapshot timed out',
  OUTSIDE_REGISTRY: 'Provider options path is outside the snapshot registry',
  MISSING: 'Provider options file is missing from the snapshot registry',
  CHANGED: 'Repertoire capability input changed after capture',
};

export class ProjectTemplateRepertoireCapabilitySnapshotError extends Error {
  declare public readonly code:
    ProjectTemplateRepertoireCapabilitySnapshotErrorCode;

  constructor(code: ProjectTemplateRepertoireCapabilitySnapshotErrorCode) {
    super(ERROR_MESSAGES[code]);
    defineOwn(this, 'code', code);
    defineOwn(this, 'name', 'ProjectTemplateRepertoireCapabilitySnapshotError');
    CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_SET_ADD, SNAPSHOT_ERRORS, [this]);
  }
}

export type ProjectTemplateRepertoireCapabilityFileRole =
  | 'package'
  | 'project'
  | 'global'
  | 'builtin'
  | 'scoped';

export interface ProjectTemplateRepertoireCapabilitySnapshotFile {
  readonly role: ProjectTemplateRepertoireCapabilityFileRole;
  readonly scope?: `@${string}/${string}`;
  readonly relativePath: string;
  readonly virtualPath: string;
  /** Private input text. Never include in public ports or failures. */
  readonly text: string;
  readonly sha256: string;
}

/**
 * Infra-private capability input snapshot. It intentionally contains no
 * callable, filesystem root, lease, disposer, or apply authority.
 */
export interface ProjectTemplateRepertoireCapabilitySnapshot {
  readonly kind: 'project-template-repertoire-capability-snapshot';
  readonly scope: `@${string}/${string}`;
  readonly workflowFiles:
    readonly ProjectTemplateRepertoireCapabilitySnapshotFile[];
  readonly providerOptionsFiles:
    readonly ProjectTemplateRepertoireCapabilitySnapshotFile[];
  readonly providerOptionsCandidateDirs: readonly string[];
  readonly scopedProviderOptionsCandidateDirs: readonly {
    readonly scope: `@${string}/${string}`;
    readonly candidateDir: string;
  }[];
  readonly privateWitnessFragment: string;
}

export interface ProjectTemplateRepertoireCapabilityApprovedLayer {
  readonly role: 'project' | 'global' | 'builtin' | 'scoped';
  readonly root: string;
  readonly scope?: `@${string}/${string}`;
}

export interface ProjectTemplateRepertoireCapabilityBudgetSeam {
  readonly maxPackageFiles?: number;
  readonly maxRequestFiles?: number;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  /** Test-only accounting seam for already consumed traversal entries. */
  readonly initialEntries?: number;
}

export type ProjectTemplateRepertoireCapabilitySnapshotIoSeam = (
  phase: 'before-directory' | 'after-directory' | 'before-file' | 'after-file',
  role: ProjectTemplateRepertoireCapabilityFileRole,
  relativePath: string,
) => void;

export interface CaptureProjectTemplateRepertoireCapabilitySnapshotInput {
  readonly repertoireContext: ProjectTemplateRepertoireSafeReadContext;
  readonly packageRelativePath: string;
  readonly scope: `@${string}/${string}`;
  readonly approvedLayers?:
    readonly ProjectTemplateRepertoireCapabilityApprovedLayer[];
  readonly signal?: AbortSignal;
  readonly deadlineMs: number;
  /** Accounting seam for the already captured lock/manifest request files. */
  readonly requestFileCount?: number;
  readonly budgetSeam?: ProjectTemplateRepertoireCapabilityBudgetSeam;
  readonly ioSeam?: ProjectTemplateRepertoireCapabilitySnapshotIoSeam;
}

export interface RevalidateProjectTemplateRepertoireCapabilitySnapshotInput {
  readonly signal?: AbortSignal;
  readonly deadlineMs: number;
}

interface Control {
  readonly signal?: AbortSignal;
  readonly deadlineMs: number;
}

interface Budget {
  packageFiles: number;
  requestFiles: number;
  bytes: number;
  entries: number;
  readonly maxPackageFiles: number;
  readonly maxRequestFiles: number;
  readonly maxBytes: number;
  readonly maxEntries: number;
}

interface CapturedDirectory {
  readonly context: ProjectTemplateRepertoireSafeReadContext;
  readonly relativePath: string;
  readonly depth: number;
  readonly entries: readonly string[];
  readonly witness: ProjectTemplateRepertoireRelativeWitness;
}

interface CapturedFile {
  readonly context: ProjectTemplateRepertoireSafeReadContext;
  readonly fileClass: 'workflow' | 'provider';
  readonly relativePath: string;
  readonly text: string;
  readonly sha256: string;
  readonly witness: ProjectTemplateRepertoireRelativeWitness;
}

interface SnapshotState {
  readonly directories: readonly CapturedDirectory[];
  readonly files: readonly CapturedFile[];
  readonly registry: Readonly<Record<string, string>>;
  readonly knownPrefixes: readonly string[];
  readonly fileAccess: ProviderOptionsFileAccess;
  readonly missingRoots: readonly CapturedMissingRoot[];
}

interface CapturedMissingRoot {
  readonly root: string;
  readonly parent: string;
  readonly parentIdentity: string;
  readonly parentEntries: readonly string[];
}

interface CaptureState {
  readonly control: Control;
  readonly budget: Budget;
  readonly ioSeam?: ProjectTemplateRepertoireCapabilitySnapshotIoSeam;
  readonly directories: CapturedDirectory[];
  readonly files: CapturedFile[];
  readonly workflowFiles: ProjectTemplateRepertoireCapabilitySnapshotFile[];
  readonly providerFiles: ProjectTemplateRepertoireCapabilitySnapshotFile[];
  readonly registry: Record<string, string>;
  readonly knownPrefixes: string[];
  readonly witnessParts: string[];
  readonly missingRoots: CapturedMissingRoot[];
}

function defineOwn(target: object, key: PropertyKey, value: unknown): void {
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

function freeze<T>(value: T): Readonly<T> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Readonly<T>;
}

function append<T>(values: T[], value: T): void {
  defineOwn(values, values.length, value);
}

function failure(
  code: ProjectTemplateRepertoireCapabilitySnapshotErrorCode,
): ProjectTemplateRepertoireCapabilitySnapshotError {
  return new ProjectTemplateRepertoireCapabilitySnapshotError(code);
}

function isFailure(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_SET_HAS,
      SNAPSHOT_ERRORS,
      [value],
    ) === true;
}

function checkpoint(control: Control): void {
  if (control.signal !== undefined) {
    let aborted: boolean;
    try {
      aborted = CAPTURED_REFLECT_APPLY(
        CAPTURED_ABORTED_GETTER,
        control.signal,
        [],
      ) as boolean;
    } catch {
      throw failure('INVALID_ARGUMENT');
    }
    if (aborted) throw failure('ABORTED');
  }
  const now = CAPTURED_REFLECT_APPLY(
    CAPTURED_PERFORMANCE_NOW,
    CAPTURED_PERFORMANCE,
    [],
  ) as number;
  if (now >= control.deadlineMs) throw failure('TIMEOUT');
}

function witnessIdentity(value: ProjectTemplateRepertoireRelativeWitness): string {
  return `${value.dev}:${value.ino}:${value.mode}:${value.nlink}:`
    + `${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

function directoryEvidence(value: CapturedDirectory): string {
  return `${value.relativePath}:${witnessIdentity(value.witness)}:`
    + join(value.entries, '\u0000');
}

function sha256(value: string): string {
  const hash = createHash('sha256');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [value]);
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_HASH_DIGEST,
    hash,
    ['hex'],
  ) as string;
}

function join(values: readonly string[], separator: string): string {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_ARRAY_JOIN,
    values,
    [separator],
  ) as string;
}

function statsIdentity(value: Stats): string {
  return `${value.dev}:${value.ino}:${value.mode}:${value.nlink}:`
    + `${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

function isMissingError(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && (value as NodeJS.ErrnoException).code === 'ENOENT';
}

function captureMissingRoot(
  root: string,
  control: Control,
): CapturedMissingRoot | undefined {
  if (
    typeof root !== 'string'
    || !CAPTURED_REFLECT_APPLY(CAPTURED_IS_ABSOLUTE, undefined, [root])
  ) throw failure('INVALID_ARGUMENT');
  try {
    CAPTURED_LSTAT_SYNC(root);
    return undefined;
  } catch (error) {
    if (!isMissingError(error)) throw failure('UNSAFE_INPUT');
  }
  let parent = root;
  for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
    checkpoint(control);
    const next = CAPTURED_REFLECT_APPLY(
      CAPTURED_DIRNAME,
      undefined,
      [parent],
    ) as string;
    if (next === parent) throw failure('UNSAFE_INPUT');
    parent = next;
    let stat: Stats;
    try {
      stat = CAPTURED_LSTAT_SYNC(parent);
    } catch (error) {
      if (isMissingError(error)) continue;
      throw failure('UNSAFE_INPUT');
    }
    if (
      (stat.mode & constants.S_IFMT) !== constants.S_IFDIR
    ) throw failure('UNSAFE_INPUT');
    CAPTURED_REALPATH_NATIVE(parent);
    const entries = CAPTURED_READDIR_SYNC(parent);
    if (entries.length > 1024) throw failure('LIMIT_EXCEEDED');
    CAPTURED_REFLECT_APPLY(CAPTURED_ARRAY_SORT, entries, []);
    return freeze({
      root,
      parent,
      parentIdentity: statsIdentity(stat),
      parentEntries: freeze(entries),
    }) as CapturedMissingRoot;
  }
  throw failure('LIMIT_EXCEEDED');
}

function revalidateMissingRoot(value: CapturedMissingRoot): void {
  try {
    CAPTURED_LSTAT_SYNC(value.root);
    throw failure('CHANGED');
  } catch (error) {
    if (isFailure(error)) throw error;
    if (!isMissingError(error)) throw failure('CHANGED');
  }
  let stat: Stats;
  let entries: string[];
  try {
    stat = CAPTURED_LSTAT_SYNC(value.parent);
    entries = CAPTURED_READDIR_SYNC(value.parent);
    CAPTURED_REFLECT_APPLY(CAPTURED_ARRAY_SORT, entries, []);
  } catch {
    throw failure('CHANGED');
  }
  if (
    statsIdentity(stat) !== value.parentIdentity
    || join(entries, '\u0000') !== join(value.parentEntries, '\u0000')
  ) throw failure('CHANGED');
}

function sortFiles(
  values: ProjectTemplateRepertoireCapabilitySnapshotFile[],
): void {
  CAPTURED_REFLECT_APPLY(CAPTURED_ARRAY_SORT, values, [
    (
      left: ProjectTemplateRepertoireCapabilitySnapshotFile,
      right: ProjectTemplateRepertoireCapabilitySnapshotFile,
    ) => left.virtualPath < right.virtualPath
      ? -1
      : left.virtualPath > right.virtualPath ? 1 : 0,
  ]);
}

function limit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure('INVALID_ARGUMENT');
  }
  return value;
}

function addKnownPrefix(state: CaptureState, value: string): void {
  if (!CAPTURED_REFLECT_APPLY(
    CAPTURED_ARRAY_INCLUDES,
    state.knownPrefixes,
    [value],
  )) append(state.knownPrefixes, value);
}

function invokeSeam(
  state: CaptureState,
  phase: Parameters<ProjectTemplateRepertoireCapabilitySnapshotIoSeam>[0],
  role: ProjectTemplateRepertoireCapabilityFileRole,
  relativePath: string,
): void {
  checkpoint(state.control);
  if (state.ioSeam !== undefined) state.ioSeam(phase, role, relativePath);
  checkpoint(state.control);
}

function readDirectory(
  state: CaptureState,
  context: ProjectTemplateRepertoireSafeReadContext,
  revalidationContext: ProjectTemplateRepertoireSafeReadContext,
  relativePath: string,
  role: ProjectTemplateRepertoireCapabilityFileRole,
  depth: number,
): ReturnType<typeof readProjectTemplateRepertoireRootDirectory> {
  if (depth > MAX_DEPTH) throw failure('LIMIT_EXCEEDED');
  invokeSeam(state, 'before-directory', role, relativePath);
  const result = relativePath === ''
    ? readProjectTemplateRepertoireRootDirectory(context)
    : readProjectTemplateRepertoireDirectory(context, relativePath);
  invokeSeam(state, 'after-directory', role, relativePath);
  state.budget.entries += result.entries.length;
  if (state.budget.entries > state.budget.maxEntries) {
    throw failure('LIMIT_EXCEEDED');
  }
  append(state.directories, freeze({
    context: revalidationContext,
    relativePath,
    depth,
    entries: result.entries,
    witness: result.witness,
  }) as CapturedDirectory);
  append(state.witnessParts, `d:${role}:${directoryEvidence(
    state.directories[state.directories.length - 1]!,
  )}`);
  return result;
}

function isYaml(relativePath: string): boolean {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_REGEXP_TEST,
    YAML_EXTENSION,
    [relativePath],
  ) as boolean;
}

function captureFile(
  state: CaptureState,
  context: ProjectTemplateRepertoireSafeReadContext,
  revalidationContext: ProjectTemplateRepertoireSafeReadContext,
  relativePath: string,
  virtualPath: string,
  role: ProjectTemplateRepertoireCapabilityFileRole,
  scope: `@${string}/${string}` | undefined,
  kind: 'workflow' | 'provider-options',
): void {
  invokeSeam(state, 'before-file', role, relativePath);
  if (
    state.budget.requestFiles >= state.budget.maxRequestFiles
    || (
      role === 'package'
      && state.budget.packageFiles >= state.budget.maxPackageFiles
    )
  ) throw failure('LIMIT_EXCEEDED');
  // Why: reject from stable metadata before content allocation/read so one
  // final file cannot cross the request-wide 32 MiB authority boundary.
  const inspected = inspectProjectTemplateRepertoireEntry(
    context,
    relativePath,
  );
  if (inspected.kind !== 'file') throw failure('UNSAFE_INPUT');
  if (inspected.witness.size > state.budget.maxBytes - state.budget.bytes) {
    throw failure('LIMIT_EXCEEDED');
  }
  const read = readProjectTemplateRepertoireFile(
    context,
    relativePath,
    kind === 'workflow' ? 'workflow' : 'provider',
  );
  state.budget.requestFiles += 1;
  if (role === 'package') state.budget.packageFiles += 1;
  state.budget.bytes += read.witness.size;
  if (
    state.budget.requestFiles > state.budget.maxRequestFiles
    || state.budget.packageFiles > state.budget.maxPackageFiles
    || state.budget.bytes > state.budget.maxBytes
  ) throw failure('LIMIT_EXCEEDED');
  let parsed;
  try {
    parsed = parseProjectTemplateRepertoireCapabilityYaml(read.content, kind);
  } catch {
    throw failure('INVALID_CAPABILITY');
  }
  invokeSeam(state, 'after-file', role, relativePath);
  const publicFile = freeze({
    role,
    ...(scope === undefined ? {} : { scope }),
    relativePath,
    virtualPath,
    text: parsed.text,
    sha256: parsed.sha256,
  }) as ProjectTemplateRepertoireCapabilitySnapshotFile;
  if (kind === 'workflow') append(state.workflowFiles, publicFile);
  else append(state.providerFiles, publicFile);
  if (state.registry[virtualPath] !== undefined) {
    throw failure('UNSAFE_INPUT');
  }
  defineOwn(state.registry, virtualPath, parsed.text);
  append(state.files, freeze({
    context: revalidationContext,
    fileClass: kind === 'workflow' ? 'workflow' : 'provider',
    relativePath,
    text: parsed.text,
    sha256: parsed.sha256,
    witness: read.witness,
  }) as CapturedFile);
  append(state.witnessParts, `f:${role}:${relativePath}:`
    + `${witnessIdentity(read.witness)}:${parsed.sha256}`);
}

function walk(
  state: CaptureState,
  context: ProjectTemplateRepertoireSafeReadContext,
  revalidationContext: ProjectTemplateRepertoireSafeReadContext,
  relativePath: string,
  virtualPath: string,
  role: ProjectTemplateRepertoireCapabilityFileRole,
  scope: `@${string}/${string}` | undefined,
  defaultKind: 'workflow' | 'provider-options',
  depth: number,
): void {
  const directory = readDirectory(
    state,
    context,
    revalidationContext,
    relativePath,
    role,
    depth,
  );
  addKnownPrefix(state, virtualPath);
  for (let entryIndex = 0; entryIndex < directory.entries.length; entryIndex += 1) {
    if (depth >= MAX_DEPTH) throw failure('LIMIT_EXCEEDED');
    const entry = directory.entries[entryIndex]!;
    checkpoint(state.control);
    const childRelative = relativePath === '' ? entry : `${relativePath}/${entry}`;
    const childVirtual = `${virtualPath}/${entry}`;
    const inspected = inspectProjectTemplateRepertoireEntry(
      context,
      childRelative,
    );
    if (inspected.kind === 'directory') {
      walk(
        state,
        context,
        revalidationContext,
        childRelative,
        childVirtual,
        role,
        scope,
        defaultKind,
        depth + 1,
      );
      continue;
    }
    if (!isYaml(childRelative)) continue;
    const kind = defaultKind === 'workflow'
      && CAPTURED_REFLECT_APPLY(
        CAPTURED_STRING_INCLUDES,
        childRelative,
        ['/provider-options/'],
      )
      ? 'provider-options'
      : defaultKind;
    try {
      captureFile(
        state,
        context,
        revalidationContext,
        childRelative,
        childVirtual,
        role,
        scope,
        kind,
      );
    } catch (error) {
      if (isFailure(error)) throw error;
      throw failure('UNSAFE_INPUT');
    }
  }
}

function rootContains(entries: readonly string[], expected: string): boolean {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_ARRAY_INCLUDES,
    entries,
    [expected],
  ) as boolean;
}

function virtualLayerRoot(
  layer: ProjectTemplateRepertoireCapabilityApprovedLayer,
): string {
  if (layer.role === 'scoped') {
    if (layer.scope === undefined || !CAPTURED_REFLECT_APPLY(
      CAPTURED_REGEXP_TEST,
      SCOPE,
      [layer.scope],
    )) {
      throw failure('INVALID_ARGUMENT');
    }
    return `${SNAPSHOT_VIRTUAL_ROOT}/repertoire/${layer.scope}/provider-options`;
  }
  if (layer.scope !== undefined) throw failure('INVALID_ARGUMENT');
  return `${SNAPSHOT_VIRTUAL_ROOT}/${layer.role}/provider-options`;
}

function orderedLayers(
  input: readonly ProjectTemplateRepertoireCapabilityApprovedLayer[],
): ProjectTemplateRepertoireCapabilityApprovedLayer[] {
  const result: ProjectTemplateRepertoireCapabilityApprovedLayer[] = [];
  const unscopedRoles = ['project', 'global', 'builtin'] as const;
  for (let roleIndex = 0; roleIndex < unscopedRoles.length; roleIndex += 1) {
    const role = unscopedRoles[roleIndex]!;
    let found: ProjectTemplateRepertoireCapabilityApprovedLayer | undefined;
    for (let index = 0; index < input.length; index += 1) {
      const layer = input[index]!;
      if (layer.role !== role) continue;
      if (found !== undefined) throw failure('INVALID_ARGUMENT');
      found = layer;
    }
    if (found !== undefined) append(result, found);
  }
  const scoped: ProjectTemplateRepertoireCapabilityApprovedLayer[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const layer = input[index]!;
    if (layer.role === 'scoped') append(scoped, layer);
    else if (
      layer.role !== 'project'
      && layer.role !== 'global'
      && layer.role !== 'builtin'
    ) throw failure('INVALID_ARGUMENT');
  }
  CAPTURED_REFLECT_APPLY(CAPTURED_ARRAY_SORT, scoped, [(
    left: ProjectTemplateRepertoireCapabilityApprovedLayer,
    right: ProjectTemplateRepertoireCapabilityApprovedLayer,
  ) => (left.scope ?? '') < (right.scope ?? '')
    ? -1
    : (left.scope ?? '') > (right.scope ?? '') ? 1 : 0]);
  for (let index = 0; index < scoped.length; index += 1) {
    if (
      index > 0
      && scoped[index - 1]!.scope === scoped[index]!.scope
    ) throw failure('INVALID_ARGUMENT');
    append(result, scoped[index]!);
  }
  return result;
}

function makeFileAccess(
  registry: Readonly<Record<string, string>>,
  knownPrefixes: readonly string[],
  control: Control,
): ProviderOptionsFileAccess {
  // Why: the runtime resolver accepts a filesystem-like interface. Restricting
  // it to captured virtual directories makes accidental node-fs fallback and
  // reads outside approved roots structurally impossible.
  function requireKnown(path: string): void {
    checkpoint(control);
    if (
      typeof path !== 'string'
      || CAPTURED_TYPES_IS_PROXY(path)
      || path[0] !== '/'
      || CAPTURED_REFLECT_APPLY(CAPTURED_STRING_INCLUDES, path, ['\\'])
      || CAPTURED_REFLECT_APPLY(CAPTURED_STRING_INCLUDES, path, ['\0'])
    ) {
      throw failure('OUTSIDE_REGISTRY');
    }
    const segments = CAPTURED_REFLECT_APPLY(
      CAPTURED_STRING_SPLIT,
      path,
      ['/'],
    ) as string[];
    for (let index = 1; index < segments.length; index += 1) {
      if (
        segments[index] === ''
        || segments[index] === '.'
        || segments[index] === '..'
      ) throw failure('OUTSIDE_REGISTRY');
    }
    for (let index = 0; index < knownPrefixes.length; index += 1) {
      const prefix = knownPrefixes[index]!;
      if (path === prefix || CAPTURED_REFLECT_APPLY(
        CAPTURED_STRING_STARTS_WITH,
        path,
        [`${prefix}/`],
      )) {
        checkpoint(control);
        return;
      }
    }
    throw failure('OUTSIDE_REGISTRY');
  }
  return freeze({
    exists(path: string): boolean {
      requireKnown(path);
      return registry[path] !== undefined;
    },
    readText(path: string): string {
      requireKnown(path);
      const value = registry[path];
      if (value === undefined) throw failure('MISSING');
      return value;
    },
    realpath(path: string): string {
      requireKnown(path);
      return path;
    },
    isSymlink(path: string): boolean {
      requireKnown(path);
      return false;
    },
  });
}

function captureSnapshotUnchecked(
  input: CaptureProjectTemplateRepertoireCapabilitySnapshotInput,
): ProjectTemplateRepertoireCapabilitySnapshot {
  if (
    typeof input !== 'object'
    || input === null
    || CAPTURED_TYPES_IS_PROXY(input)
    || !CAPTURED_REFLECT_APPLY(CAPTURED_REGEXP_TEST, SCOPE, [input.scope])
    || typeof input.packageRelativePath !== 'string'
    || typeof input.deadlineMs !== 'number'
    || Number.isNaN(input.deadlineMs)
    || (input.ioSeam !== undefined && typeof input.ioSeam !== 'function')
  ) throw failure('INVALID_ARGUMENT');
  const budgetSeam = input.budgetSeam;
  const budget: Budget = {
    packageFiles: 0,
    requestFiles: limit(input.requestFileCount, 0),
    bytes: 0,
    entries: limit(budgetSeam?.initialEntries, 0),
    maxPackageFiles: limit(budgetSeam?.maxPackageFiles, MAX_PACKAGE_FILES),
    maxRequestFiles: limit(budgetSeam?.maxRequestFiles, MAX_REQUEST_FILES),
    maxBytes: limit(budgetSeam?.maxBytes, MAX_TOTAL_BYTES),
    maxEntries: limit(budgetSeam?.maxEntries, MAX_TOTAL_ENTRIES),
  };
  if (budget.requestFiles > budget.maxRequestFiles) {
    throw failure('LIMIT_EXCEEDED');
  }
  if (budget.entries > budget.maxEntries) throw failure('LIMIT_EXCEEDED');
  const state: CaptureState = {
    control: { signal: input.signal, deadlineMs: input.deadlineMs },
    budget,
    ioSeam: input.ioSeam,
    directories: [],
    files: [],
    workflowFiles: [],
    providerFiles: [],
    registry: CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_CREATE,
      CAPTURED_OBJECT_RECEIVER,
      [null],
    ) as Record<string, string>,
    knownPrefixes: [],
    witnessParts: [],
    missingRoots: [],
  };
  try {
    checkpoint(state.control);
    const packageContext = narrowProjectTemplateRepertoireSafeReadContext(
      input.repertoireContext,
      input.packageRelativePath,
    );
    const packageRevalidationContext =
      detachProjectTemplateRepertoireSafeReadContextCallbacks(packageContext);
    const packageRoot = readDirectory(
      state,
      packageContext,
      packageRevalidationContext,
      '',
      'package',
      0,
    );
    const packageProviderRoot =
      `${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/provider-options`;
    addKnownPrefix(state, packageProviderRoot);
    if (rootContains(packageRoot.entries, 'workflows')) {
      walk(
        state,
        packageContext,
        packageRevalidationContext,
        'workflows',
        `${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/workflows`,
        'package',
        input.scope,
        'workflow',
        1,
      );
    }
    if (rootContains(packageRoot.entries, 'provider-options')) {
      walk(
        state,
        packageContext,
        packageRevalidationContext,
        'provider-options',
        packageProviderRoot,
        'package',
        input.scope,
        'provider-options',
        1,
      );
    }
    const candidateDirs = [packageProviderRoot];
    const scopedDirs: {
      scope: `@${string}/${string}`;
      candidateDir: string;
    }[] = [];
    const layers = orderedLayers(input.approvedLayers ?? []);
    for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
      const layer = layers[layerIndex]!;
      checkpoint(state.control);
      if (
        layer.role !== 'project'
        && layer.role !== 'global'
        && layer.role !== 'builtin'
        && layer.role !== 'scoped'
      ) throw failure('INVALID_ARGUMENT');
      if (layer.role === 'scoped' && layer.scope === input.scope) {
        throw failure('INVALID_ARGUMENT');
      }
      const virtualRoot = virtualLayerRoot(layer);
      addKnownPrefix(state, virtualRoot);
      const missing = captureMissingRoot(layer.root, state.control);
      checkpoint(state.control);
      if (missing !== undefined) {
        state.budget.entries += missing.parentEntries.length;
        if (state.budget.entries > state.budget.maxEntries) {
          throw failure('LIMIT_EXCEEDED');
        }
        append(state.missingRoots, missing);
        append(state.witnessParts, `m:${layer.role}:${sha256(layer.root)}:`
          + `${missing.parentIdentity}:`
          + sha256(join(missing.parentEntries, '\u0000')));
        if (layer.role === 'scoped') {
          append(scopedDirs, {
            scope: layer.scope!,
            candidateDir: virtualRoot,
          });
        } else {
          append(candidateDirs, virtualRoot);
        }
        continue;
      }
      const context = createProjectTemplateRepertoireSafeReadContext(
        layer.root,
      );
      const revalidationContext =
        detachProjectTemplateRepertoireSafeReadContextCallbacks(context);
      walk(
        state,
        context,
        revalidationContext,
        '',
        virtualRoot,
        layer.role,
        layer.scope,
        'provider-options',
        0,
      );
      if (layer.role === 'scoped') {
        append(scopedDirs, { scope: layer.scope!, candidateDir: virtualRoot });
      } else {
        append(candidateDirs, virtualRoot);
      }
    }
    sortFiles(state.workflowFiles);
    sortFiles(state.providerFiles);
    CAPTURED_REFLECT_APPLY(CAPTURED_ARRAY_SORT, state.witnessParts, []);
    const registry = freeze(state.registry);
    const knownPrefixes = freeze(state.knownPrefixes);
    const fileAccess = makeFileAccess(registry, knownPrefixes, state.control);
    const frozenScopedDirs: {
      readonly scope: `@${string}/${string}`;
      readonly candidateDir: string;
    }[] = [];
    for (let index = 0; index < scopedDirs.length; index += 1) {
      append(frozenScopedDirs, freeze(scopedDirs[index]!));
    }
    const snapshot = freeze({
      kind: 'project-template-repertoire-capability-snapshot' as const,
      scope: input.scope,
      workflowFiles: freeze(state.workflowFiles),
      providerOptionsFiles: freeze(state.providerFiles),
      providerOptionsCandidateDirs: freeze(candidateDirs),
      scopedProviderOptionsCandidateDirs: freeze(frozenScopedDirs),
      privateWitnessFragment: sha256(join(state.witnessParts, '\n')),
    });
    CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_MAP_SET,
      SNAPSHOT_STATES,
      [snapshot, freeze({
        directories: freeze(state.directories),
        files: freeze(state.files),
        registry,
        knownPrefixes,
        fileAccess,
        missingRoots: freeze(state.missingRoots),
      })],
    );
    return snapshot;
  } catch (error) {
    if (isFailure(error)) throw error;
    throw failure('UNSAFE_INPUT');
  }
}

export function captureProjectTemplateRepertoireCapabilitySnapshot(
  input: CaptureProjectTemplateRepertoireCapabilitySnapshotInput,
): ProjectTemplateRepertoireCapabilitySnapshot {
  if (CAPTURE_ACTIVE) throw failure('UNSAFE_INPUT');
  CAPTURE_ACTIVE = true;
  try {
    return captureSnapshotUnchecked(input);
  } catch (error) {
    if (isFailure(error)) throw error;
    throw failure('UNSAFE_INPUT');
  } finally {
    CAPTURE_ACTIVE = false;
  }
}

export function getProjectTemplateRepertoireCapabilityFileAccess(
  snapshot: ProjectTemplateRepertoireCapabilitySnapshot,
): ProviderOptionsFileAccess {
  const state = CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_MAP_GET,
    SNAPSHOT_STATES,
    [snapshot],
  ) as SnapshotState | undefined;
  if (state === undefined) throw failure('INVALID_ARGUMENT');
  return state.fileAccess;
}

export function revalidateProjectTemplateRepertoireCapabilitySnapshot(
  snapshot: ProjectTemplateRepertoireCapabilitySnapshot,
  input: RevalidateProjectTemplateRepertoireCapabilitySnapshotInput,
): void {
  const state = CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_MAP_GET,
    SNAPSHOT_STATES,
    [snapshot],
  ) as SnapshotState | undefined;
  if (state === undefined || typeof input !== 'object' || input === null) {
    throw failure('INVALID_ARGUMENT');
  }
  const control = { signal: input.signal, deadlineMs: input.deadlineMs };
  try {
    for (let index = 0; index < state.files.length; index += 1) {
      const file = state.files[index]!;
      checkpoint(control);
      const current = readProjectTemplateRepertoireFile(
        file.context,
        file.relativePath,
        file.fileClass,
      );
      const parsed = parseProjectTemplateRepertoireCapabilityYaml(
        current.content,
        file.fileClass === 'workflow' ? 'workflow' : 'provider-options',
      );
      if (
        witnessIdentity(current.witness) !== witnessIdentity(file.witness)
        || parsed.sha256 !== file.sha256
        || parsed.text !== file.text
      ) throw failure('CHANGED');
    }
    for (let index = 0; index < state.missingRoots.length; index += 1) {
      const missingRoot = state.missingRoots[index]!;
      checkpoint(control);
      revalidateMissingRoot(missingRoot);
    }
    const directories: CapturedDirectory[] = [];
    for (let index = 0; index < state.directories.length; index += 1) {
      append(directories, state.directories[index]!);
    }
    CAPTURED_REFLECT_APPLY(CAPTURED_ARRAY_SORT, directories, [
      (left: CapturedDirectory, right: CapturedDirectory) =>
        right.depth - left.depth,
    ]);
    for (let index = 0; index < directories.length; index += 1) {
      const directory = directories[index]!;
      checkpoint(control);
      const current = directory.relativePath === ''
        ? readProjectTemplateRepertoireRootDirectory(directory.context)
        : readProjectTemplateRepertoireDirectory(
          directory.context,
          directory.relativePath,
        );
      if (
        witnessIdentity(current.witness) !== witnessIdentity(directory.witness)
        || join(current.entries, '\u0000') !== join(
          directory.entries,
          '\u0000',
        )
      ) throw failure('CHANGED');
    }
    checkpoint(control);
  } catch (error) {
    if (isFailure(error)) throw error;
    throw failure('CHANGED');
  }
}
