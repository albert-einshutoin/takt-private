import { createHash } from 'node:crypto';
import {
  constants,
  Dir,
  lstatSync,
  opendirSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
} from 'node:path';
import { types } from 'node:util';
import type { Language } from '../../core/models/index.js';
import {
  ProjectTemplateRepertoireDependencyInspectionError,
  type ProjectTemplateRepertoireDependencyInspectionPort,
  type ProjectTemplateRepertoireDependencyInspectionRequest,
  type ProjectTemplateRepertoireDependencyObservation,
} from '../../features/project-template/repertoire-dependency-inspection-port.js';
import {
  MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES,
} from '../../features/project-template/source-descriptor.js';
import {
  TAKT_REPERTOIRE_LOCK_FILENAME,
  TAKT_REPERTOIRE_MANIFEST_FILENAME,
} from '../../features/repertoire/constants.js';
import { getRepertoireDir } from '../config/paths.js';
import {
  createProjectTemplateRepertoireSafeReadContext,
  readProjectTemplateRepertoireDirectory,
  readProjectTemplateRepertoireFile,
  type ProjectTemplateRepertoireRelativeWitness,
} from './project-template-repertoire-safe-read.js';
import {
  parseProjectTemplateRepertoireStrictLock,
} from './project-template-repertoire-strict-lock.js';

const WITNESS_DOMAIN =
  'takt.project-template.installed-repertoire-inspection.v1\u0000';
const SCOPE_PATTERN =
  /^@(?![a-z0-9-]*--)([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/(?!\.{1,2}$)(?!.*\.git$)([a-z0-9._-]{1,100})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MISSING_PARENT_DEPTH = 32;
const MAX_WITNESS_DIRECTORY_ENTRIES = 1024;
const TYPE_MASK = constants.S_IFMT;
const HEX = '0123456789abcdef';

const CAPTURED_CREATE_HASH = createHash;
const HASH_SAMPLE = CAPTURED_CREATE_HASH('sha256');
const CAPTURED_HASH_UPDATE = HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_SAMPLE.digest;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  Object.getOwnPropertyDescriptor;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_REFLECT_RECEIVER = Reflect;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_ARRAY_JOIN = Array.prototype.join;
const CAPTURED_NUMBER_IS_FINITE = Number.isFinite;
const CAPTURED_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const CAPTURED_STRING = String;
const CAPTURED_REGEXP_TEST = RegExp.prototype.test;
const CAPTURED_STRING_INDEX_OF = String.prototype.indexOf;
const CAPTURED_STRING_SLICE = String.prototype.slice;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;
const CAPTURED_GET_REPERTOIRE_DIR = getRepertoireDir;
const CAPTURED_IS_ABSOLUTE = isAbsolute;
const CAPTURED_DIRNAME = dirname;
const CAPTURED_LSTAT_SYNC = lstatSync;
const CAPTURED_OPENDIR_SYNC = opendirSync;
const CAPTURED_REALPATH_NATIVE = realpathSync.native;
const CAPTURED_DIR_READ_SYNC = Dir.prototype.readSync;
const CAPTURED_DIR_CLOSE_SYNC = Dir.prototype.closeSync;
const CAPTURED_PERFORMANCE = performance;
const CAPTURED_PERFORMANCE_NOW = performance.now;
const CAPTURED_ABORTED_GETTER =
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const INSPECTION_STOP_ERRORS = new WeakSet<object>();
const CAPTURED_WEAK_SET_ADD = WeakSet.prototype.add;
const CAPTURED_WEAK_SET_HAS = WeakSet.prototype.has;

export interface ProjectTemplateInstalledRepertoireDependencyInspectorContext {
  readonly projectRoot: string;
  readonly language: Language;
  readonly repertoireRoot?: string;
}

export type ProjectTemplateInstalledRepertoireInspectionPhase =
  | 'before-scope'
  | 'before-parent'
  | 'after-parent'
  | 'before-lock'
  | 'after-lock'
  | 'before-manifest'
  | 'after-manifest'
  | 'after-scope';

export type ProjectTemplateInstalledRepertoireInspectionIoSeam = (
  phase: ProjectTemplateInstalledRepertoireInspectionPhase,
  scope: `@${string}/${string}`,
  relativePath: string,
) => void;

interface InspectorState {
  readonly projectRootSha256: string;
  readonly language: Language;
  readonly repertoireRoot: string;
  readonly ioSeam?: ProjectTemplateInstalledRepertoireInspectionIoSeam;
}

interface ScopeParts {
  readonly scope: `@${string}/${string}`;
  readonly ownerSegment: string;
  readonly packageSegment: string;
  readonly packageRelativePath: string;
}

interface ScopeInspection {
  readonly observation: ProjectTemplateRepertoireDependencyObservation;
  readonly privateWitness: string;
}

interface InspectionInput {
  readonly signal?: AbortSignal;
  readonly deadlineMs: number;
  readonly scopes: readonly `@${string}/${string}`[];
}

function freeze<T>(value: T): Readonly<T> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Readonly<T>;
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

function append<T>(target: T[], value: T): void {
  defineOwn(target, target.length, value);
}

function joinArray(values: readonly string[], separator: string): string {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_ARRAY_JOIN,
    values,
    [separator],
  ) as string;
}

function test(pattern: RegExp, value: string): boolean {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_REGEXP_TEST,
    pattern,
    [value],
  ) as boolean;
}

function sha256(value: string | Uint8Array): string {
  const hash = CAPTURED_CREATE_HASH('sha256');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [value]);
  const digest = CAPTURED_REFLECT_APPLY(
    CAPTURED_HASH_DIGEST,
    hash,
    [],
  ) as Uint8Array;
  let result = '';
  for (let index = 0; index < 32; index += 1) {
    const byte = digest[index]!;
    result += HEX[(byte >>> 4) & 0x0f]! + HEX[byte & 0x0f]!;
  }
  return result;
}

function identity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:`
    + `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function witnessIdentity(
  witness: ProjectTemplateRepertoireRelativeWitness,
): string {
  return `${witness.dev}:${witness.ino}:${witness.mode}:${witness.nlink}:`
    + `${witness.size}:${witness.mtimeMs}:${witness.ctimeMs}`;
}

function isDirectory(stat: Stats): boolean {
  return (stat.mode & TYPE_MASK) === constants.S_IFDIR;
}

function isSymbolicLink(stat: Stats): boolean {
  return (stat.mode & TYPE_MASK) === constants.S_IFLNK;
}

function fixedFailure(
  code: 'INVALID_ARGUMENT' | 'ABORTED' | 'TIMEOUT',
): ProjectTemplateRepertoireDependencyInspectionError {
  const error = new ProjectTemplateRepertoireDependencyInspectionError(
    code,
    code === 'ABORTED'
      ? 'Project template repertoire dependency inspection was aborted'
      : code === 'TIMEOUT'
        ? 'Project template repertoire dependency inspection timed out'
        : 'Project template repertoire dependency inspector input is invalid',
  );
  CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_SET_ADD,
    INSPECTION_STOP_ERRORS,
    [error],
  );
  return error;
}

function isStopFailure(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_SET_HAS,
      INSPECTION_STOP_ERRORS,
      [value],
    ) === true;
}

function checkpoint(
  request: InspectionInput,
): void {
  if (
    request.signal !== undefined
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_ABORTED_GETTER,
      request.signal,
      [],
    ) === true
  ) throw fixedFailure('ABORTED');
  const now = CAPTURED_REFLECT_APPLY(
    CAPTURED_PERFORMANCE_NOW,
    CAPTURED_PERFORMANCE,
    [],
  ) as number;
  if (now >= request.deadlineMs) throw fixedFailure('TIMEOUT');
}

function snapshotInspectionInput(value: unknown): InspectionInput {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_TYPES_IS_PROXY(value)
    || CAPTURED_ARRAY_IS_ARRAY(value)
  ) throw fixedFailure('INVALID_ARGUMENT');
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const allowed = [
    'sourceDescriptorSha256',
    'manifestSha256',
    'dependencies',
    'signal',
    'deadlineMs',
  ];
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    CAPTURED_REFLECT_RECEIVER,
    [descriptors],
  ) as PropertyKey[];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (
      typeof key !== 'string'
      || (
        key !== allowed[0]
        && key !== allowed[1]
        && key !== allowed[2]
        && key !== allowed[3]
        && key !== allowed[4]
      )
      || !('value' in descriptors[key]!)
    ) throw fixedFailure('INVALID_ARGUMENT');
  }
  const deadlineMs = descriptors['deadlineMs']?.value;
  const signal = descriptors['signal']?.value;
  const dependencies = descriptors['dependencies']?.value;
  const sourceDescriptorSha256 =
    descriptors['sourceDescriptorSha256']?.value;
  const manifestSha256 = descriptors['manifestSha256']?.value;
  if (
    typeof sourceDescriptorSha256 !== 'string'
    || !test(SHA256_PATTERN, sourceDescriptorSha256)
    || typeof manifestSha256 !== 'string'
    || !test(SHA256_PATTERN, manifestSha256)
    || typeof deadlineMs !== 'number'
    || !CAPTURED_NUMBER_IS_FINITE(deadlineMs)
    || deadlineMs < 0
    || !CAPTURED_ARRAY_IS_ARRAY(dependencies)
    || CAPTURED_TYPES_IS_PROXY(dependencies)
  ) throw fixedFailure('INVALID_ARGUMENT');
  if (signal !== undefined) {
    try {
      CAPTURED_REFLECT_APPLY(CAPTURED_ABORTED_GETTER, signal, []);
    } catch {
      throw fixedFailure('INVALID_ARGUMENT');
    }
  }
  const lengthDescriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    CAPTURED_OBJECT_RECEIVER,
    [dependencies, 'length'],
  ) as PropertyDescriptor | undefined;
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || !CAPTURED_NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value
      > MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES
  ) throw fixedFailure('INVALID_ARGUMENT');
  const scopes: `@${string}/${string}`[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const dependencyDescriptor = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      CAPTURED_OBJECT_RECEIVER,
      [dependencies, CAPTURED_STRING(index)],
    ) as PropertyDescriptor | undefined;
    if (
      dependencyDescriptor === undefined
      || !('value' in dependencyDescriptor)
      || typeof dependencyDescriptor.value !== 'object'
      || dependencyDescriptor.value === null
      || CAPTURED_TYPES_IS_PROXY(dependencyDescriptor.value)
    ) throw fixedFailure('INVALID_ARGUMENT');
    const scopeDescriptor = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      CAPTURED_OBJECT_RECEIVER,
      [dependencyDescriptor.value, 'scope'],
    ) as PropertyDescriptor | undefined;
    if (
      scopeDescriptor === undefined
      || !('value' in scopeDescriptor)
      || typeof scopeDescriptor.value !== 'string'
    ) throw fixedFailure('INVALID_ARGUMENT');
    append(scopes, scopeDescriptor.value as `@${string}/${string}`);
  }
  return freeze({
    signal,
    deadlineMs,
    scopes: freeze(scopes),
  });
}

function exactContext(
  value: ProjectTemplateInstalledRepertoireDependencyInspectorContext,
): InspectorState {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_TYPES_IS_PROXY(value)
    || CAPTURED_ARRAY_IS_ARRAY(value)
  ) throw fixedFailure('INVALID_ARGUMENT');
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    CAPTURED_REFLECT_RECEIVER,
    [descriptors],
  ) as PropertyKey[];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (
      typeof key !== 'string'
      || (
        key !== 'projectRoot'
        && key !== 'language'
        && key !== 'repertoireRoot'
      )
      || !('value' in descriptors[key]!)
    ) throw fixedFailure('INVALID_ARGUMENT');
  }
  const projectRoot = descriptors['projectRoot']?.value;
  const language = descriptors['language']?.value;
  const configuredRoot = descriptors['repertoireRoot']?.value;
  if (
    typeof projectRoot !== 'string'
    || !CAPTURED_IS_ABSOLUTE(projectRoot)
    || (language !== 'en' && language !== 'ja')
    || (
      configuredRoot !== undefined
      && (
        typeof configuredRoot !== 'string'
        || !CAPTURED_IS_ABSOLUTE(configuredRoot)
      )
    )
  ) throw fixedFailure('INVALID_ARGUMENT');
  let repertoireRoot = configuredRoot === undefined
    ? CAPTURED_GET_REPERTOIRE_DIR()
    : configuredRoot;
  try {
    const rootStat = CAPTURED_LSTAT_SYNC(repertoireRoot);
    if (!isSymbolicLink(rootStat)) {
      repertoireRoot = CAPTURED_REALPATH_NATIVE(repertoireRoot);
    }
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw fixedFailure('INVALID_ARGUMENT');
  }
  return freeze({
    projectRootSha256: sha256(projectRoot),
    language,
    repertoireRoot,
  });
}

function scopeParts(value: unknown): ScopeParts | undefined {
  if (typeof value !== 'string' || !test(SCOPE_PATTERN, value)) {
    return undefined;
  }
  const slash = CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_INDEX_OF,
    value,
    ['/'],
  ) as number;
  const ownerSegment = CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_SLICE,
    value,
    [0, slash],
  ) as string;
  const packageSegment = CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_SLICE,
    value,
    [slash + 1],
  ) as string;
  const packageRelativePath = `${ownerSegment}/${packageSegment}`;
  return freeze({
    scope: value as `@${string}/${string}`,
    ownerSegment,
    packageSegment,
    packageRelativePath,
  });
}

function appendPath(parent: string, segment: string): string {
  return parent === '/' ? `/${segment}` : `${parent}/${segment}`;
}

function invokeSeam(
  state: InspectorState,
  request: InspectionInput,
  phase: ProjectTemplateInstalledRepertoireInspectionPhase,
  scope: `@${string}/${string}`,
  relativePath: string,
): void {
  checkpoint(request);
  if (state.ioSeam !== undefined) state.ioSeam(phase, scope, relativePath);
  checkpoint(request);
}

function stableDirectoryListing(path: string): string {
  const before = CAPTURED_LSTAT_SYNC(path);
  if (!isDirectory(before) || isSymbolicLink(before)) throw new Error();
  const directory = CAPTURED_OPENDIR_SYNC(path);
  const names: string[] = [];
  try {
    while (names.length <= MAX_WITNESS_DIRECTORY_ENTRIES) {
      const entry = CAPTURED_REFLECT_APPLY(
        CAPTURED_DIR_READ_SYNC,
        directory,
        [],
      ) as ReturnType<Dir['readSync']>;
      if (entry === null) break;
      append(names, entry.name);
    }
  } finally {
    CAPTURED_REFLECT_APPLY(CAPTURED_DIR_CLOSE_SYNC, directory, []);
  }
  if (names.length > MAX_WITNESS_DIRECTORY_ENTRIES) throw new Error();
  for (let index = 1; index < names.length; index += 1) {
    const value = names[index]!;
    let cursor = index;
    while (cursor > 0 && names[cursor - 1]! > value) {
      defineOwn(names, cursor, names[cursor - 1]!);
      cursor -= 1;
    }
    defineOwn(names, cursor, value);
  }
  const after = CAPTURED_LSTAT_SYNC(path);
  if (identity(before) !== identity(after)) throw new Error();
  return `${identity(after)}:${sha256(joinArray(names, '\u0000'))}`;
}

function errno(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    CAPTURED_OBJECT_RECEIVER,
    [value, 'code'],
  ) as PropertyDescriptor | undefined;
  return descriptor !== undefined && 'value' in descriptor
    && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function missingRootWitness(root: string): string {
  let current = root;
  let missingDepth = 0;
  while (missingDepth < MAX_MISSING_PARENT_DEPTH) {
    try {
      return `root-missing:${missingDepth}:${sha256(current)}:`
        + stableDirectoryListing(current);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
      const parent = CAPTURED_DIRNAME(current);
      if (parent === current) throw error;
      current = parent;
      missingDepth += 1;
    }
  }
  throw new Error();
}

function invalid(scope: ScopeParts, detail: string): ScopeInspection {
  return {
    observation: freeze({
      scope: scope.scope,
      state: 'invalid',
      reason: 'INVALID_INSTALLATION' as const,
    }),
    privateWitness: `invalid:${detail}`,
  };
}

function missing(scope: ScopeParts, detail: string): ScopeInspection {
  return {
    observation: freeze({
      scope: scope.scope,
      state: 'missing',
    }),
    privateWitness: `missing:${detail}`,
  };
}

function inspectScope(
  state: InspectorState,
  request: InspectionInput,
  safeContext: ReturnType<
  typeof createProjectTemplateRepertoireSafeReadContext
  >,
  scope: ScopeParts,
): ScopeInspection {
  invokeSeam(state, request, 'before-scope', scope.scope, scope.packageRelativePath);
  invokeSeam(state, request, 'before-parent', scope.scope, scope.ownerSegment);
  const ownerPath = appendPath(state.repertoireRoot, scope.ownerSegment);
  try {
    CAPTURED_LSTAT_SYNC(ownerPath);
  } catch (error) {
    if (errno(error) === 'ENOENT') {
      try {
        const listing = stableDirectoryListing(state.repertoireRoot);
        try {
          CAPTURED_LSTAT_SYNC(ownerPath);
          return invalid(scope, 'owner-race');
        } catch (afterError) {
          if (errno(afterError) !== 'ENOENT') {
            return invalid(scope, 'owner-parent');
          }
        }
        return missing(scope, `owner:${listing}`);
      } catch {
        return invalid(scope, 'owner-parent');
      }
    }
    return invalid(scope, 'owner');
  }
  let owner;
  try {
    owner = readProjectTemplateRepertoireDirectory(
      safeContext,
      scope.ownerSegment,
    );
  } catch {
    return invalid(scope, 'owner');
  }
  invokeSeam(state, request, 'after-parent', scope.scope, scope.ownerSegment);
  const packagePath = appendPath(ownerPath, scope.packageSegment);
  try {
    CAPTURED_LSTAT_SYNC(packagePath);
  } catch (error) {
    if (errno(error) === 'ENOENT') {
      let ownerAfter;
      try {
        ownerAfter = readProjectTemplateRepertoireDirectory(
          safeContext,
          scope.ownerSegment,
        );
      } catch {
        return invalid(scope, 'package-parent');
      }
      try {
        CAPTURED_LSTAT_SYNC(packagePath);
        return invalid(scope, 'package-race');
      } catch (afterError) {
        if (errno(afterError) !== 'ENOENT') {
          return invalid(scope, 'package-parent');
        }
      }
      if (
        witnessIdentity(ownerAfter.witness)
          !== witnessIdentity(owner.witness)
        || joinArray(ownerAfter.entries, '\u0000')
          !== joinArray(owner.entries, '\u0000')
      ) return invalid(scope, 'package-parent');
      return missing(
        scope,
        `package:${witnessIdentity(owner.witness)}:`
        + sha256(joinArray(owner.entries, '\u0000')),
      );
    }
    return invalid(scope, 'package');
  }
  let packageDirectory;
  try {
    packageDirectory = readProjectTemplateRepertoireDirectory(
      safeContext,
      scope.packageRelativePath,
    );
  } catch {
    return invalid(scope, 'package');
  }
  const lockRelativePath =
    `${scope.packageRelativePath}/${TAKT_REPERTOIRE_LOCK_FILENAME}`;
  const manifestRelativePath =
    `${scope.packageRelativePath}/${TAKT_REPERTOIRE_MANIFEST_FILENAME}`;
  try {
    invokeSeam(state, request, 'before-lock', scope.scope, lockRelativePath);
    const lockRead = readProjectTemplateRepertoireFile(
      safeContext,
      lockRelativePath,
      'lock',
    );
    invokeSeam(state, request, 'after-lock', scope.scope, lockRelativePath);
    const lock = parseProjectTemplateRepertoireStrictLock(lockRead.content);
    invokeSeam(
      state,
      request,
      'before-manifest',
      scope.scope,
      manifestRelativePath,
    );
    const manifestRead = readProjectTemplateRepertoireFile(
      safeContext,
      manifestRelativePath,
      'manifest',
    );
    invokeSeam(
      state,
      request,
      'after-manifest',
      scope.scope,
      manifestRelativePath,
    );
    invokeSeam(
      state,
      request,
      'after-scope',
      scope.scope,
      scope.packageRelativePath,
    );
    // Interim G3.2 contract: G3.3 replaces this empty set with strictly
    // parsed manifest capabilities. This infra-private port is not exported
    // from a package/public barrel.
    const capabilities = freeze([]) as readonly [];
    return {
      observation: freeze({
        scope: scope.scope,
        state: 'installed',
        installed: freeze({
          source: lock.source,
          ref: lock.ref,
          version: lock.version,
          commit: lock.commit,
          capabilities,
        }),
      }),
      privateWitness: 'installed:'
        + `${witnessIdentity(packageDirectory.witness)}:`
        + `${witnessIdentity(lockRead.witness)}:`
        + `${witnessIdentity(manifestRead.witness)}:`
        + `${sha256(lockRead.content)}:${sha256(manifestRead.content)}`,
    };
  } catch (error) {
    if (
      isStopFailure(error)
    ) throw error;
    return invalid(scope, 'io');
  }
}

function inspectRequest(
  state: InspectorState,
  request: ProjectTemplateRepertoireDependencyInspectionRequest,
): unknown {
  const input = snapshotInspectionInput(request);
  checkpoint(input);
  const observations: ProjectTemplateRepertoireDependencyObservation[] = [];
  const witnessParts: string[] = [
    `language:${state.language}`,
    `project:${state.projectRootSha256}`,
    `root:${sha256(state.repertoireRoot)}`,
  ];
  let rootStat: Stats;
  try {
    rootStat = CAPTURED_LSTAT_SYNC(state.repertoireRoot);
  } catch (error) {
    if (errno(error) !== 'ENOENT') {
      rootStat = undefined as never;
    } else {
      let rootWitness: string | undefined;
      try {
        rootWitness = missingRootWitness(state.repertoireRoot);
      } catch {
        rootWitness = undefined;
      }
      for (let index = 0; index < input.scopes.length; index += 1) {
        const scope = scopeParts(input.scopes[index]);
        if (scope === undefined) throw fixedFailure('INVALID_ARGUMENT');
        const inspected = rootWitness === undefined
          ? invalid(scope, 'root-parent')
          : missing(scope, rootWitness);
        append(observations, inspected.observation);
        append(
          witnessParts,
          `${index}:${scope.scope}:${inspected.observation.state}:`
          + inspected.privateWitness,
        );
      }
      return freeze({
        witnessSha256: sha256(WITNESS_DOMAIN + joinArray(witnessParts, '\n')),
        observations: freeze(observations),
      });
    }
  }
  const validRoot = rootStat !== undefined
    && isDirectory(rootStat)
    && !isSymbolicLink(rootStat);
  if (rootStat !== undefined) {
    append(witnessParts, `root-identity:${identity(rootStat)}`);
  }
  let safeContext: ReturnType<
  typeof createProjectTemplateRepertoireSafeReadContext
  > | undefined;
  if (validRoot) {
    try {
      safeContext = createProjectTemplateRepertoireSafeReadContext(
        state.repertoireRoot,
      );
    } catch {
      safeContext = undefined;
    }
  }
  let previousScope: string | undefined;
  for (let index = 0; index < input.scopes.length; index += 1) {
    checkpoint(input);
    const scope = scopeParts(input.scopes[index]);
    if (
      scope === undefined
      || (previousScope !== undefined && scope.scope <= previousScope)
    ) throw fixedFailure('INVALID_ARGUMENT');
    previousScope = scope.scope;
    const inspected = safeContext === undefined
      ? invalid(scope, 'root')
      : inspectScope(state, input, safeContext, scope);
    append(observations, inspected.observation);
    append(
      witnessParts,
      `${index}:${scope.scope}:${inspected.observation.state}:`
      + inspected.privateWitness,
    );
  }
  checkpoint(input);
  return freeze({
    witnessSha256: sha256(WITNESS_DOMAIN + joinArray(witnessParts, '\n')),
    observations: freeze(observations),
  });
}

/**
 * Creates the infra-private installed repertoire inspection bridge.
 *
 * G3.2 verifies provenance and manifest identity only. Capabilities remain an
 * empty interim value until G3.3 installs strict manifest semantic parsing.
 */
export function createProjectTemplateInstalledRepertoireDependencyInspectionPort(
  context:
    ProjectTemplateInstalledRepertoireDependencyInspectorContext,
  ioSeam?: ProjectTemplateInstalledRepertoireInspectionIoSeam,
): ProjectTemplateRepertoireDependencyInspectionPort {
  const snapshotted = exactContext(context);
  if (
    ioSeam !== undefined
    && (typeof ioSeam !== 'function' || CAPTURED_TYPES_IS_PROXY(ioSeam))
  ) throw fixedFailure('INVALID_ARGUMENT');
  const state = freeze({
    projectRootSha256: snapshotted.projectRootSha256,
    language: snapshotted.language,
    repertoireRoot: snapshotted.repertoireRoot,
    ioSeam,
  });
  const inspect = (request: ProjectTemplateRepertoireDependencyInspectionRequest):
  unknown => {
    try {
      return inspectRequest(state, request);
    } catch (error) {
      if (
        isStopFailure(error)
      ) throw error;
      throw fixedFailure('INVALID_ARGUMENT');
    }
  };
  return freeze({ inspect });
}
