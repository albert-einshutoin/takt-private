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
  detectEditWorkflows,
} from '../../features/repertoire/pack-summary.js';
import {
  TAKT_REPERTOIRE_LOCK_FILENAME,
  TAKT_REPERTOIRE_MANIFEST_FILENAME,
} from '../../features/repertoire/constants.js';
import {
  getBuiltinProviderOptionsDir,
  getGlobalProviderOptionsDir,
  getProjectProviderOptionsDir,
  getRepertoireDir,
} from '../config/paths.js';
import type {
  ScopedProviderOptionsCandidateDirs,
} from '../config/loaders/providerOptionsLookupDirectories.js';
import {
  createProjectTemplateRepertoireSafeReadContext,
  readProjectTemplateRepertoireDirectory,
  readProjectTemplateRepertoireFile,
  type ProjectTemplateRepertoireRelativeWitness,
} from './project-template-repertoire-safe-read.js';
import {
  parseProjectTemplateRepertoireStrictLock,
} from './project-template-repertoire-strict-lock.js';
import {
  authorizeProjectTemplateRepertoireRelativeProviderCandidates,
  captureProjectTemplateRepertoireCapabilitySnapshot,
  getProjectTemplateRepertoireCapabilityAccessWitnessFragment,
  getProjectTemplateRepertoireCapabilityFileAccess,
  getProjectTemplateRepertoireCapabilitySnapshotErrorCode,
  getProjectTemplateRepertoireAuthorizedRelativeProviderFiles,
  PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT,
  revalidateProjectTemplateRepertoireCapabilitySnapshot,
  type ProjectTemplateRepertoireCapabilityApprovedLayer,
  type ProjectTemplateRepertoireCapabilitySnapshot,
} from './project-template-repertoire-capability-snapshot.js';

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
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_HAS_OWN_PROPERTY = Object.prototype.hasOwnProperty;
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
const CAPTURED_STRING_STARTS_WITH = String.prototype.startsWith;
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
const CAPTURED_TYPED_ARRAY_PROTOTYPE = CAPTURED_REFLECT_APPLY(
  CAPTURED_OBJECT_GET_PROTOTYPE_OF,
  CAPTURED_OBJECT_RECEIVER,
  [Uint8Array.prototype],
);
const CAPTURED_TYPED_ARRAY_BYTE_LENGTH_GETTER = CAPTURED_REFLECT_APPLY(
  CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
  CAPTURED_OBJECT_RECEIVER,
  [CAPTURED_TYPED_ARRAY_PROTOTYPE, 'byteLength'],
)!.get!;
const INTERNAL_FAILURE = CAPTURED_REFLECT_APPLY(
  CAPTURED_OBJECT_FREEZE,
  CAPTURED_OBJECT_RECEIVER,
  [CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE,
    CAPTURED_OBJECT_RECEIVER,
    [null],
  )],
) as object;

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
  readonly baseCapabilityLayers:
    readonly ProjectTemplateRepertoireCapabilityApprovedLayer[];
  readonly ioSeam?: ProjectTemplateInstalledRepertoireInspectionIoSeam;
}

interface ScopeParts {
  readonly scope: `@${string}/${string}`;
  readonly ownerSegment: string;
  readonly packageSegment: string;
  readonly packageRelativePath: string;
}

interface ScopeInspection {
  readonly observation?: ProjectTemplateRepertoireDependencyObservation;
  readonly installed?: {
    readonly scope: `@${string}/${string}`;
    readonly source: `github:${string}/${string}`;
    readonly ref: string;
    readonly version: string;
    readonly commit: string;
    readonly capabilities: readonly [] | readonly ['edit'];
    readonly capabilitySnapshot: ProjectTemplateRepertoireCapabilitySnapshot;
  };
  readonly privateWitness: string;
}

interface RealmDescriptorSnapshot {
  readonly key: PropertyKey;
  readonly configurable: boolean;
  readonly enumerable: boolean;
  readonly writable?: boolean;
  readonly value?: unknown;
  readonly get?: (() => unknown);
  readonly set?: ((value: unknown) => void);
}

interface RealmSurfaceSnapshot {
  readonly target: object;
  readonly descriptors: readonly RealmDescriptorSnapshot[];
}

interface RealmBindingSnapshot {
  readonly key: 'Array' | 'Object' | 'String' | 'Set' | 'Map' | 'RegExp' | 'JSON';
  readonly value: object;
  readonly descriptor: RealmDescriptorSnapshot;
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

function snapshotDescriptor(
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): RealmDescriptorSnapshot {
  if (descriptor === undefined) throw INTERNAL_FAILURE;
  const value = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_HAS_OWN_PROPERTY,
    descriptor,
    ['value'],
  ) === true;
  return freeze(value
    ? {
        key,
        configurable: descriptor.configurable === true,
        enumerable: descriptor.enumerable === true,
        writable: descriptor.writable === true,
        value: descriptor.value,
      }
    : {
        key,
        configurable: descriptor.configurable === true,
        enumerable: descriptor.enumerable === true,
        get: descriptor.get,
        set: descriptor.set,
      });
}

function descriptorBagValue(
  descriptors: PropertyDescriptorMap,
  key: PropertyKey,
): PropertyDescriptor {
  const own = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    CAPTURED_OBJECT_RECEIVER,
    [descriptors, key],
  ) as PropertyDescriptor | undefined;
  if (!isOwnDataDescriptor(own) || typeof own.value !== 'object') {
    throw INTERNAL_FAILURE;
  }
  return own.value as PropertyDescriptor;
}

function snapshotSurface(target: object): RealmSurfaceSnapshot {
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    CAPTURED_REFLECT_RECEIVER,
    [target],
  ) as PropertyKey[];
  const descriptorBag = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    CAPTURED_OBJECT_RECEIVER,
    [target],
  ) as PropertyDescriptorMap;
  const descriptors: RealmDescriptorSnapshot[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    append(descriptors, snapshotDescriptor(
      key,
      descriptorBagValue(descriptorBag, key),
    ));
  }
  return freeze({ target, descriptors: freeze(descriptors) });
}

function sameDescriptor(
  expected: RealmDescriptorSnapshot,
  actual: PropertyDescriptor | undefined,
): boolean {
  if (
    actual === undefined
    || actual.configurable !== expected.configurable
    || actual.enumerable !== expected.enumerable
  ) return false;
  const actualIsData = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_HAS_OWN_PROPERTY,
    actual,
    ['value'],
  ) === true;
  const expectedIsData = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_HAS_OWN_PROPERTY,
    expected,
    ['value'],
  ) === true;
  return actualIsData === expectedIsData
    && (actualIsData
      ? actual.writable === expected.writable
        && actual.value === expected.value
      : actual.get === expected.get && actual.set === expected.set);
}

const DETECTOR_REALM_BINDING_NAMES = freeze([
  'Array',
  'Object',
  'String',
  'Set',
  'Map',
  'RegExp',
  'JSON',
] as const);
const DETECTOR_REALM_BINDINGS: readonly RealmBindingSnapshot[] = (() => {
  const snapshots: RealmBindingSnapshot[] = [];
  for (let index = 0; index < DETECTOR_REALM_BINDING_NAMES.length; index += 1) {
    const key = DETECTOR_REALM_BINDING_NAMES[index]!;
    const descriptor = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      CAPTURED_OBJECT_RECEIVER,
      [globalThis, key],
    ) as PropertyDescriptor | undefined;
    if (descriptor === undefined || typeof descriptor.value !== 'object'
      && typeof descriptor.value !== 'function') throw INTERNAL_FAILURE;
    append(snapshots, freeze({
      key,
      value: descriptor.value as object,
      descriptor: snapshotDescriptor(key, descriptor),
    }));
  }
  return freeze(snapshots);
})();
const DETECTOR_REALM_SURFACES: readonly RealmSurfaceSnapshot[] = freeze([
  snapshotSurface(Array),
  snapshotSurface(Array.prototype),
  snapshotSurface(Object),
  snapshotSurface(Object.prototype),
  snapshotSurface(String),
  snapshotSurface(String.prototype),
  snapshotSurface(Set),
  snapshotSurface(Set.prototype),
  snapshotSurface(Map),
  snapshotSurface(Map.prototype),
  snapshotSurface(RegExp),
  snapshotSurface(RegExp.prototype),
  snapshotSurface(JSON),
]);

/**
 * Why: detectEditWorkflows is intentionally the sole semantic classifier, but
 * it and its YAML/config helpers use mutable realm intrinsics. Exact module-init
 * descriptors prevent prototype replacement from silently downgrading edit
 * detection while keeping the trusted detector implementation unchanged.
 */
function attestDetectorRealm(): void {
  for (let index = 0; index < DETECTOR_REALM_BINDINGS.length; index += 1) {
    const expected = DETECTOR_REALM_BINDINGS[index]!;
    const actual = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      CAPTURED_OBJECT_RECEIVER,
      [globalThis, expected.key],
    ) as PropertyDescriptor | undefined;
    if (!sameDescriptor(expected.descriptor, actual)
      || actual?.value !== expected.value) throw INTERNAL_FAILURE;
  }
  for (let index = 0; index < DETECTOR_REALM_SURFACES.length; index += 1) {
    const surface = DETECTOR_REALM_SURFACES[index]!;
    const keys = CAPTURED_REFLECT_APPLY(
      CAPTURED_REFLECT_OWN_KEYS,
      CAPTURED_REFLECT_RECEIVER,
      [surface.target],
    ) as PropertyKey[];
    const descriptorBag = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      CAPTURED_OBJECT_RECEIVER,
      [surface.target],
    ) as PropertyDescriptorMap;
    if (keys.length !== surface.descriptors.length) throw INTERNAL_FAILURE;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const expected = surface.descriptors[keyIndex]!;
      if (keys[keyIndex] !== expected.key || !sameDescriptor(
        expected,
        descriptorBagValue(descriptorBag, expected.key),
      )) throw INTERNAL_FAILURE;
    }
  }
}

function test(pattern: RegExp, value: string): boolean {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_REGEXP_TEST,
    pattern,
    [value],
  ) as boolean;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_HAS_OWN_PROPERTY,
    value,
    [key],
  ) as boolean;
}

function isOwnDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && hasOwn(descriptor, 'value');
}

function ownDataValue(
  descriptors: Record<PropertyKey, PropertyDescriptor>,
  key: PropertyKey,
): unknown {
  if (!hasOwn(descriptors, key)) return undefined;
  const descriptor = descriptors[key];
  return isOwnDataDescriptor(descriptor) ? descriptor.value : undefined;
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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  // Why: direct .length dispatches through the mutable shared TypedArray
  // prototype and would expose private provenance buffers to hostile getters.
  const leftLength = CAPTURED_REFLECT_APPLY(
    CAPTURED_TYPED_ARRAY_BYTE_LENGTH_GETTER,
    left,
    [],
  ) as number;
  const rightLength = CAPTURED_REFLECT_APPLY(
    CAPTURED_TYPED_ARRAY_BYTE_LENGTH_GETTER,
    right,
    [],
  ) as number;
  if (leftLength !== rightLength) return false;
  for (let index = 0; index < leftLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameFileEvidence(
  before: {
    readonly content: Uint8Array;
    readonly witness: ProjectTemplateRepertoireRelativeWitness;
  },
  after: {
    readonly content: Uint8Array;
    readonly witness: ProjectTemplateRepertoireRelativeWitness;
  },
): boolean {
  return witnessIdentity(before.witness) === witnessIdentity(after.witness)
    && sha256(before.content) === sha256(after.content)
    && sameBytes(before.content, after.content);
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
      || !isOwnDataDescriptor(descriptors[key])
    ) throw fixedFailure('INVALID_ARGUMENT');
  }
  const deadlineMs = ownDataValue(descriptors, 'deadlineMs');
  const signal = ownDataValue(descriptors, 'signal');
  const dependencies = ownDataValue(descriptors, 'dependencies');
  const sourceDescriptorSha256 = ownDataValue(
    descriptors,
    'sourceDescriptorSha256',
  );
  const manifestSha256 = ownDataValue(descriptors, 'manifestSha256');
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
  const capturedSignal = signal as AbortSignal | undefined;
  const boundary: InspectionInput = freeze({
    signal: capturedSignal,
    deadlineMs,
    scopes: freeze([]) as readonly `@${string}/${string}`[],
  });
  checkpoint(boundary);
  const lengthDescriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    CAPTURED_OBJECT_RECEIVER,
    [dependencies, 'length'],
  ) as PropertyDescriptor | undefined;
  if (
    lengthDescriptor === undefined
    || !isOwnDataDescriptor(lengthDescriptor)
    || !CAPTURED_NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value
      > MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCIES
  ) throw fixedFailure('INVALID_ARGUMENT');
  const scopes: `@${string}/${string}`[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    checkpoint(boundary);
    const dependencyDescriptor = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      CAPTURED_OBJECT_RECEIVER,
      [dependencies, CAPTURED_STRING(index)],
    ) as PropertyDescriptor | undefined;
    if (
      dependencyDescriptor === undefined
      || !isOwnDataDescriptor(dependencyDescriptor)
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
      || !isOwnDataDescriptor(scopeDescriptor)
      || typeof scopeDescriptor.value !== 'string'
    ) throw fixedFailure('INVALID_ARGUMENT');
    append(scopes, scopeDescriptor.value as `@${string}/${string}`);
  }
  checkpoint(boundary);
  return freeze({
    signal: capturedSignal,
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
      || !isOwnDataDescriptor(descriptors[key])
    ) throw fixedFailure('INVALID_ARGUMENT');
  }
  const projectRoot = ownDataValue(descriptors, 'projectRoot');
  const language = ownDataValue(descriptors, 'language');
  const configuredRoot = ownDataValue(descriptors, 'repertoireRoot');
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
    baseCapabilityLayers: freeze([
      freeze({
        role: 'project' as const,
        root: getProjectProviderOptionsDir(projectRoot),
      }),
      freeze({
        role: 'global' as const,
        root: getGlobalProviderOptionsDir(),
      }),
      freeze({
        role: 'builtin' as const,
        root: getBuiltinProviderOptionsDir(language),
      }),
    ]),
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

function stableDirectoryListing(
  path: string,
  request: InspectionInput,
): string {
  checkpoint(request);
  const before = CAPTURED_LSTAT_SYNC(path);
  checkpoint(request);
  if (!isDirectory(before) || isSymbolicLink(before)) throw INTERNAL_FAILURE;
  checkpoint(request);
  const directory = CAPTURED_OPENDIR_SYNC(path);
  let result: string | undefined;
  let pendingFailure: unknown;
  let closeFailed = false;
  try {
    checkpoint(request);
    const names: string[] = [];
    while (names.length <= MAX_WITNESS_DIRECTORY_ENTRIES) {
      checkpoint(request);
      const entry = CAPTURED_REFLECT_APPLY(
        CAPTURED_DIR_READ_SYNC,
        directory,
        [],
      ) as ReturnType<Dir['readSync']>;
      checkpoint(request);
      if (entry === null) break;
      append(names, entry.name);
    }
    if (names.length > MAX_WITNESS_DIRECTORY_ENTRIES) throw INTERNAL_FAILURE;
    for (let index = 1; index < names.length; index += 1) {
      checkpoint(request);
      const value = names[index]!;
      let cursor = index;
      while (cursor > 0 && names[cursor - 1]! > value) {
        if ((cursor & 31) === 0) checkpoint(request);
        defineOwn(names, cursor, names[cursor - 1]!);
        cursor -= 1;
      }
      defineOwn(names, cursor, value);
    }
    checkpoint(request);
    const after = CAPTURED_LSTAT_SYNC(path);
    checkpoint(request);
    if (identity(before) !== identity(after)) throw INTERNAL_FAILURE;
    result = `${identity(after)}:${sha256(joinArray(names, '\u0000'))}`;
  } catch (error) {
    pendingFailure = error;
  } finally {
    try {
      CAPTURED_REFLECT_APPLY(CAPTURED_DIR_CLOSE_SYNC, directory, []);
    } catch {
      closeFailed = true;
    }
  }
  // Why: close is always attempted first; cancellation has precedence over a
  // redacted close failure once the descriptor can no longer leak.
  try {
    checkpoint(request);
  } catch (error) {
    if (isStopFailure(error)) throw error;
    throw INTERNAL_FAILURE;
  }
  if (isStopFailure(pendingFailure)) throw pendingFailure;
  if (closeFailed || pendingFailure !== undefined) throw INTERNAL_FAILURE;
  if (result === undefined) throw INTERNAL_FAILURE;
  return result;
}

function errno(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    CAPTURED_OBJECT_RECEIVER,
    [value, 'code'],
  ) as PropertyDescriptor | undefined;
  return isOwnDataDescriptor(descriptor)
    && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function missingRootWitness(root: string, request: InspectionInput): string {
  let current = root;
  let missingDepth = 0;
  while (missingDepth < MAX_MISSING_PARENT_DEPTH) {
    checkpoint(request);
    try {
      return `root-missing:${missingDepth}:${sha256(current)}:`
        + stableDirectoryListing(current, request);
    } catch (error) {
      if (isStopFailure(error)) throw error;
      checkpoint(request);
      if (errno(error) !== 'ENOENT') throw error;
      const parent = CAPTURED_DIRNAME(current);
      if (parent === current) throw error;
      current = parent;
      missingDepth += 1;
    }
  }
  throw INTERNAL_FAILURE;
}

function invalid(
  request: InspectionInput,
  scope: ScopeParts,
  detail: string,
): ScopeInspection {
  checkpoint(request);
  return {
    observation: freeze({
      scope: scope.scope,
      state: 'invalid',
      reason: 'INVALID_INSTALLATION' as const,
    }),
    privateWitness: `invalid:${detail}`,
  };
}

function missing(
  request: InspectionInput,
  scope: ScopeParts,
  detail: string,
): ScopeInspection {
  checkpoint(request);
  return {
    observation: freeze({
      scope: scope.scope,
      state: 'missing',
    }),
    privateWitness: `missing:${detail}`,
  };
}

function capabilityLayers(
  state: InspectorState,
  current: ScopeParts,
  scopes: readonly ScopeParts[],
): readonly ProjectTemplateRepertoireCapabilityApprovedLayer[] {
  const layers: ProjectTemplateRepertoireCapabilityApprovedLayer[] = [];
  for (let index = 0; index < state.baseCapabilityLayers.length; index += 1) {
    append(layers, state.baseCapabilityLayers[index]!);
  }
  for (let index = 0; index < scopes.length; index += 1) {
    const scope = scopes[index]!;
    if (scope.scope === current.scope) continue;
    append(layers, freeze({
      role: 'scoped' as const,
      root: appendPath(
        appendPath(
          appendPath(state.repertoireRoot, scope.ownerSegment),
          scope.packageSegment,
        ),
        'provider-options',
      ),
      scope: scope.scope,
    }));
  }
  return freeze(layers);
}

function capabilityScopedCandidateDirs(
  snapshot: ProjectTemplateRepertoireCapabilitySnapshot,
): ScopedProviderOptionsCandidateDirs {
  const values = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE,
    CAPTURED_OBJECT_RECEIVER,
    [null],
  ) as Record<string, readonly string[]>;
  defineOwn(
    values,
    CAPTURED_REFLECT_APPLY(CAPTURED_STRING_SLICE, snapshot.scope, [1]),
    freeze([`${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/provider-options`]),
  );
  for (
    let index = 0;
    index < snapshot.scopedProviderOptionsCandidateDirs.length;
    index += 1
  ) {
    const entry = snapshot.scopedProviderOptionsCandidateDirs[index]!;
    defineOwn(
      values,
      CAPTURED_REFLECT_APPLY(CAPTURED_STRING_SLICE, entry.scope, [1]),
      freeze([entry.candidateDir]),
    );
  }
  return freeze({
    get(key: string): readonly string[] | undefined {
      return values[key];
    },
  }) as unknown as ScopedProviderOptionsCandidateDirs;
}

function requireExactDataValue(
  target: object,
  key: PropertyKey,
  enumerable = true,
): unknown {
  const descriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    CAPTURED_OBJECT_RECEIVER,
    [target, key],
  ) as PropertyDescriptor | undefined;
  if (
    !isOwnDataDescriptor(descriptor)
    || descriptor.configurable !== true
    || descriptor.enumerable !== enumerable
    || descriptor.writable !== true
  ) throw INTERNAL_FAILURE;
  return descriptor.value;
}

function validateDetectorArray(value: unknown): readonly unknown[] {
  if (
    !CAPTURED_ARRAY_IS_ARRAY(value)
    || CAPTURED_TYPES_IS_PROXY(value)
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) !== Array.prototype
  ) throw INTERNAL_FAILURE;
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    CAPTURED_REFLECT_RECEIVER,
    [value],
  ) as PropertyKey[];
  if (keys.length !== value.length + 1 || keys[keys.length - 1] !== 'length') {
    throw INTERNAL_FAILURE;
  }
  for (let index = 0; index < value.length; index += 1) {
    const key = CAPTURED_STRING(index);
    if (keys[index] !== key) {
      throw INTERNAL_FAILURE;
    }
    requireExactDataValue(value, key);
  }
  const lengthDescriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    CAPTURED_OBJECT_RECEIVER,
    [value, 'length'],
  ) as PropertyDescriptor | undefined;
  if (
    !isOwnDataDescriptor(lengthDescriptor)
    || lengthDescriptor.value !== value.length
    || lengthDescriptor.enumerable !== false
    || lengthDescriptor.configurable !== false
    || lengthDescriptor.writable !== true
  ) throw INTERNAL_FAILURE;
  return value as unknown[];
}

function validateDetectorStringArray(value: unknown): readonly string[] {
  const values = validateDetectorArray(value);
  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== 'string') throw INTERNAL_FAILURE;
  }
  return values as string[];
}

function validateDetectorOutput(value: unknown): readonly {
  readonly name: string;
  readonly allowedTools: readonly string[];
  readonly hasEdit: boolean;
  readonly requiredPermissionModes: readonly string[];
}[] {
  const output = validateDetectorArray(value) as unknown[];
  for (let index = 0; index < output.length; index += 1) {
    const entry = output[index];
    if (
      typeof entry !== 'object'
      || entry === null
      || CAPTURED_TYPES_IS_PROXY(entry)
      || CAPTURED_REFLECT_APPLY(
        CAPTURED_OBJECT_GET_PROTOTYPE_OF,
        CAPTURED_OBJECT_RECEIVER,
        [entry],
      ) !== Object.prototype
    ) throw INTERNAL_FAILURE;
    const keys = CAPTURED_REFLECT_APPLY(
      CAPTURED_REFLECT_OWN_KEYS,
      CAPTURED_REFLECT_RECEIVER,
      [entry],
    ) as PropertyKey[];
    const expectedKeys = freeze([
      'name',
      'allowedTools',
      'hasEdit',
      'requiredPermissionModes',
    ]);
    if (keys.length !== expectedKeys.length) throw INTERNAL_FAILURE;
    for (let keyIndex = 0; keyIndex < expectedKeys.length; keyIndex += 1) {
      if (keys[keyIndex] !== expectedKeys[keyIndex]) throw INTERNAL_FAILURE;
    }
    if (
      typeof requireExactDataValue(entry, 'name') !== 'string'
      || typeof requireExactDataValue(entry, 'hasEdit') !== 'boolean'
    ) throw INTERNAL_FAILURE;
    validateDetectorStringArray(requireExactDataValue(entry, 'allowedTools'));
    validateDetectorStringArray(
      requireExactDataValue(entry, 'requiredPermissionModes'),
    );
  }
  return output as ReturnType<typeof validateDetectorOutput>;
}

function detectInstalledCapabilities(
  state: InspectorState,
  snapshot: ProjectTemplateRepertoireCapabilitySnapshot,
): { readonly capabilities: readonly [] | readonly ['edit']; readonly witness: string } {
  authorizeProjectTemplateRepertoireRelativeProviderCandidates(snapshot);
  const workflows: Array<{
    readonly name: string;
    readonly content: string;
    readonly relativePath: string;
  }> = [];
  const workflowWitness: string[] = [];
  for (let index = 0; index < snapshot.workflowFiles.length; index += 1) {
    const file = snapshot.workflowFiles[index]!;
    const name = CAPTURED_REFLECT_APPLY(
      CAPTURED_STRING_SLICE,
      file.relativePath,
      ['workflows/'.length],
    ) as string;
    append(workflows, freeze({
      name,
      content: file.text,
      relativePath: file.relativePath,
    }));
    append(workflowWitness, file.sha256);
  }
  const packageProviders: Array<{
    readonly name: string;
    readonly content: string;
    readonly relativePath: string;
  }> = [];
  for (let index = 0; index < snapshot.providerOptionsFiles.length; index += 1) {
    const file = snapshot.providerOptionsFiles[index]!;
    if (
      file.role !== 'package'
      || !CAPTURED_REFLECT_APPLY(
        CAPTURED_STRING_STARTS_WITH,
        file.relativePath,
        ['provider-options/'],
      )
    ) continue;
    append(packageProviders, freeze({
      name: CAPTURED_REFLECT_APPLY(
        CAPTURED_STRING_SLICE,
        file.relativePath,
        ['provider-options/'.length],
      ) as string,
      content: file.text,
      relativePath: file.relativePath,
    }));
  }
  const authorizedRelativeProviders =
    getProjectTemplateRepertoireAuthorizedRelativeProviderFiles(snapshot);
  for (
    let index = 0;
    index < authorizedRelativeProviders.length;
    index += 1
  ) {
    const file = authorizedRelativeProviders[index]!;
    append(packageProviders, freeze({
      name: file.relativePath,
      content: file.text,
      relativePath: file.relativePath,
    }));
  }
  const candidateDirs: string[] = [];
  for (
    let index = 1;
    index < snapshot.providerOptionsCandidateDirs.length;
    index += 1
  ) append(candidateDirs, snapshot.providerOptionsCandidateDirs[index]!);
  attestDetectorRealm();
  const detectedRaw = detectEditWorkflows(
    freeze(workflows) as unknown as Parameters<typeof detectEditWorkflows>[0],
    freeze(packageProviders) as unknown as NonNullable<
      Parameters<typeof detectEditWorkflows>[1]
    >,
    freeze({
      providerOptionsCandidateDirs: freeze(candidateDirs),
      providerOptionsScopedCandidateDirs:
        capabilityScopedCandidateDirs(snapshot),
      fileAccess: getProjectTemplateRepertoireCapabilityFileAccess(snapshot),
      context: freeze({
        projectDir: '/__takt_capability_snapshot__/project',
        lang: state.language,
        workflowDir:
          `${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/workflows`,
        repertoireDir: '/__takt_capability_snapshot__/repertoire',
      }),
    }),
  );
  attestDetectorRealm();
  const detected = validateDetectorOutput(detectedRaw);
  const resultWitness: string[] = [];
  for (let index = 0; index < detected.length; index += 1) {
    const result = detected[index]!;
    append(resultWitness, sha256(
      `${result.name}:${result.hasEdit}:`
      + `${joinArray(result.allowedTools, '\u0000')}:`
      + joinArray(result.requiredPermissionModes, '\u0000'),
    ));
  }
  const capabilities = detected.length === 0
    ? freeze([]) as readonly []
    : freeze(['edit']) as readonly ['edit'];
  return freeze({
    capabilities,
    witness: sha256(
      `${snapshot.privateWitnessFragment}:`
      + `${getProjectTemplateRepertoireCapabilityAccessWitnessFragment(snapshot)}:`
      + `${joinArray(workflowWitness, '\u0000')}:`
      + joinArray(resultWitness, '\u0000'),
    ),
  });
}

function inspectScope(
  state: InspectorState,
  request: InspectionInput,
  safeContext: ReturnType<
  typeof createProjectTemplateRepertoireSafeReadContext
  >,
  scope: ScopeParts,
  scopes: readonly ScopeParts[],
): ScopeInspection {
  invokeSeam(state, request, 'before-scope', scope.scope, scope.packageRelativePath);
  invokeSeam(state, request, 'before-parent', scope.scope, scope.ownerSegment);
  const ownerPath = appendPath(state.repertoireRoot, scope.ownerSegment);
  try {
    checkpoint(request);
    CAPTURED_LSTAT_SYNC(ownerPath);
    checkpoint(request);
  } catch (error) {
    if (isStopFailure(error)) throw error;
    checkpoint(request);
    if (errno(error) === 'ENOENT') {
      try {
        const listing = stableDirectoryListing(state.repertoireRoot, request);
        try {
          checkpoint(request);
          CAPTURED_LSTAT_SYNC(ownerPath);
          checkpoint(request);
          return invalid(request, scope, 'owner-race');
        } catch (afterError) {
          if (isStopFailure(afterError)) throw afterError;
          checkpoint(request);
          if (errno(afterError) !== 'ENOENT') {
            return invalid(request, scope, 'owner-parent');
          }
        }
        return missing(request, scope, `owner:${listing}`);
      } catch {
        return invalid(request, scope, 'owner-parent');
      }
    }
    return invalid(request, scope, 'owner');
  }
  let owner;
  try {
    checkpoint(request);
    owner = readProjectTemplateRepertoireDirectory(
      safeContext,
      scope.ownerSegment,
    );
    checkpoint(request);
  } catch {
    return invalid(request, scope, 'owner');
  }
  invokeSeam(state, request, 'after-parent', scope.scope, scope.ownerSegment);
  const packagePath = appendPath(ownerPath, scope.packageSegment);
  try {
    checkpoint(request);
    CAPTURED_LSTAT_SYNC(packagePath);
    checkpoint(request);
  } catch (error) {
    if (isStopFailure(error)) throw error;
    checkpoint(request);
    if (errno(error) === 'ENOENT') {
      let ownerAfter;
      try {
        checkpoint(request);
        ownerAfter = readProjectTemplateRepertoireDirectory(
          safeContext,
          scope.ownerSegment,
        );
        checkpoint(request);
      } catch {
        return invalid(request, scope, 'package-parent');
      }
      try {
        checkpoint(request);
        CAPTURED_LSTAT_SYNC(packagePath);
        checkpoint(request);
        return invalid(request, scope, 'package-race');
      } catch (afterError) {
        if (isStopFailure(afterError)) throw afterError;
        checkpoint(request);
        if (errno(afterError) !== 'ENOENT') {
          return invalid(request, scope, 'package-parent');
        }
      }
      if (
        witnessIdentity(ownerAfter.witness)
          !== witnessIdentity(owner.witness)
        || joinArray(ownerAfter.entries, '\u0000')
          !== joinArray(owner.entries, '\u0000')
      ) return invalid(request, scope, 'package-parent');
      return missing(
        request,
        scope,
        `package:${witnessIdentity(owner.witness)}:`
        + sha256(joinArray(owner.entries, '\u0000')),
      );
    }
    return invalid(request, scope, 'package');
  }
  let packageDirectory;
  try {
    checkpoint(request);
    packageDirectory = readProjectTemplateRepertoireDirectory(
      safeContext,
      scope.packageRelativePath,
    );
    checkpoint(request);
  } catch {
    return invalid(request, scope, 'package');
  }
  const lockRelativePath =
    `${scope.packageRelativePath}/${TAKT_REPERTOIRE_LOCK_FILENAME}`;
  const manifestRelativePath =
    `${scope.packageRelativePath}/${TAKT_REPERTOIRE_MANIFEST_FILENAME}`;
  try {
    invokeSeam(state, request, 'before-lock', scope.scope, lockRelativePath);
    checkpoint(request);
    const lockRead = readProjectTemplateRepertoireFile(
      safeContext,
      lockRelativePath,
      'lock',
    );
    checkpoint(request);
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
    checkpoint(request);
    invokeSeam(
      state,
      request,
      'after-manifest',
      scope.scope,
      manifestRelativePath,
    );
    const capabilitySnapshot =
      captureProjectTemplateRepertoireCapabilitySnapshot({
        repertoireContext: safeContext,
        packageRelativePath: scope.packageRelativePath,
        scope: scope.scope,
        approvedLayers: capabilityLayers(state, scope, scopes),
        signal: request.signal,
        deadlineMs: request.deadlineMs,
        requestFileCount: 2,
      });
    const detectedCapabilities = detectInstalledCapabilities(
      state,
      capabilitySnapshot,
    );
    invokeSeam(
      state,
      request,
      'after-scope',
      scope.scope,
      scope.packageRelativePath,
    );
    // Why: after the last external callback, re-read the complete evidence
    // chain without another inspector seam. Individual safe reads retain their
    // own no-follow and post-close checks, while this chain prevents mixing
    // old file bytes with a later directory snapshot.
    checkpoint(request);
    revalidateProjectTemplateRepertoireCapabilitySnapshot(
      capabilitySnapshot,
      { signal: request.signal, deadlineMs: request.deadlineMs },
    );
    checkpoint(request);
    const lockAfter = readProjectTemplateRepertoireFile(
      safeContext,
      lockRelativePath,
      'lock',
    );
    checkpoint(request);
    const manifestAfter = readProjectTemplateRepertoireFile(
      safeContext,
      manifestRelativePath,
      'manifest',
    );
    checkpoint(request);
    const packageAfter = readProjectTemplateRepertoireDirectory(
      safeContext,
      scope.packageRelativePath,
    );
    checkpoint(request);
    const ownerAfter = readProjectTemplateRepertoireDirectory(
      safeContext,
      scope.ownerSegment,
    );
    checkpoint(request);
    if (
      !sameFileEvidence(lockRead, lockAfter)
      || !sameFileEvidence(manifestRead, manifestAfter)
      || witnessIdentity(packageAfter.witness)
        !== witnessIdentity(packageDirectory.witness)
      || joinArray(packageAfter.entries, '\u0000')
        !== joinArray(packageDirectory.entries, '\u0000')
      || witnessIdentity(ownerAfter.witness)
        !== witnessIdentity(owner.witness)
      || joinArray(ownerAfter.entries, '\u0000')
        !== joinArray(owner.entries, '\u0000')
    ) return invalid(request, scope, 'coherence');
    checkpoint(request);
    return {
      installed: freeze({
        scope: scope.scope,
        source: lock.source as `github:${string}/${string}`,
        ref: lock.ref,
        version: lock.version,
        commit: lock.commit,
        capabilities: detectedCapabilities.capabilities,
        capabilitySnapshot,
      }),
      privateWitness: 'installed:'
        + `${witnessIdentity(packageDirectory.witness)}:`
        + `${witnessIdentity(lockRead.witness)}:`
        + `${witnessIdentity(manifestRead.witness)}:`
        + `${sha256(lockRead.content)}:${sha256(manifestRead.content)}:`
        + detectedCapabilities.witness,
    };
  } catch (error) {
    if (isStopFailure(error)) throw error;
    const capabilityCode =
      getProjectTemplateRepertoireCapabilitySnapshotErrorCode(error);
    if (capabilityCode === 'ABORTED') throw fixedFailure('ABORTED');
    if (capabilityCode === 'TIMEOUT') throw fixedFailure('TIMEOUT');
    return invalid(request, scope, 'io');
  }
}

function materializeInstalled(
  installed: NonNullable<ScopeInspection['installed']>,
): ProjectTemplateRepertoireDependencyObservation {
  return freeze({
    scope: installed.scope,
    state: 'installed' as const,
    installed: freeze({
      source: installed.source,
      ref: installed.ref,
      version: installed.version,
      commit: installed.commit,
      capabilities: installed.capabilities,
    }),
  });
}

function finalizeInspection(
  request: InspectionInput,
  witnessParts: readonly string[],
  observations: ProjectTemplateRepertoireDependencyObservation[],
): unknown {
  checkpoint(request);
  const witnessSha256 = sha256(
    WITNESS_DOMAIN + joinArray(witnessParts, '\n'),
  );
  checkpoint(request);
  return freeze({
    witnessSha256,
    observations: freeze(observations),
  });
}

function inspectRequest(
  state: InspectorState,
  request: ProjectTemplateRepertoireDependencyInspectionRequest,
): unknown {
  const input = snapshotInspectionInput(request);
  checkpoint(input);
  const observations: ProjectTemplateRepertoireDependencyObservation[] = [];
  const inspections: ScopeInspection[] = [];
  const scopes: ScopeParts[] = [];
  const witnessParts: string[] = [
    `language:${state.language}`,
    `project:${state.projectRootSha256}`,
    `root:${sha256(state.repertoireRoot)}`,
  ];
  let previousScope: string | undefined;
  // Why: every filesystem branch must consume the same canonical declaration
  // snapshot, including the missing-root fast path.
  for (let index = 0; index < input.scopes.length; index += 1) {
    checkpoint(input);
    const scope = scopeParts(input.scopes[index]);
    if (
      scope === undefined
      || (previousScope !== undefined && scope.scope <= previousScope)
    ) throw fixedFailure('INVALID_ARGUMENT');
    previousScope = scope.scope;
    append(scopes, scope);
  }
  checkpoint(input);
  let rootStat: Stats;
  try {
    checkpoint(input);
    rootStat = CAPTURED_LSTAT_SYNC(state.repertoireRoot);
    checkpoint(input);
  } catch (error) {
    if (isStopFailure(error)) throw error;
    checkpoint(input);
    if (errno(error) !== 'ENOENT') {
      rootStat = undefined as never;
    } else {
      let rootWitness: string | undefined;
      try {
        rootWitness = missingRootWitness(state.repertoireRoot, input);
      } catch (witnessError) {
        if (isStopFailure(witnessError)) throw witnessError;
        rootWitness = undefined;
      }
      for (let index = 0; index < scopes.length; index += 1) {
        checkpoint(input);
        const scope = scopes[index]!;
        const inspected = rootWitness === undefined
          ? invalid(input, scope, 'root-parent')
          : missing(input, scope, rootWitness);
        append(observations, inspected.observation!);
        append(
          witnessParts,
          `${index}:${scope.scope}:${inspected.observation!.state}:`
          + inspected.privateWitness,
        );
      }
      return finalizeInspection(input, witnessParts, observations);
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
      checkpoint(input);
      safeContext = createProjectTemplateRepertoireSafeReadContext(
        state.repertoireRoot,
      );
      checkpoint(input);
    } catch (error) {
      if (isStopFailure(error)) throw error;
      checkpoint(input);
      safeContext = undefined;
    }
  }
  for (let index = 0; index < scopes.length; index += 1) {
    checkpoint(input);
    const scope = scopes[index]!;
    const inspected = safeContext === undefined
      ? invalid(input, scope, 'root')
      : inspectScope(state, input, safeContext, scope, scopes);
    append(inspections, inspected);
  }

  // Why: scoped provider graphs are shared across dependency observations.
  // Retaining every snapshot until all seams finish prevents a later scope
  // callback from leaving an earlier installed capability silently stale.
  let coherenceFailure: string | undefined;
  for (let index = 0; index < inspections.length; index += 1) {
    const installed = inspections[index]!.installed;
    if (installed === undefined) continue;
    try {
      checkpoint(input);
      revalidateProjectTemplateRepertoireCapabilitySnapshot(
        installed.capabilitySnapshot,
        { signal: input.signal, deadlineMs: input.deadlineMs },
      );
      checkpoint(input);
    } catch (error) {
      if (isStopFailure(error)) throw error;
      const code = getProjectTemplateRepertoireCapabilitySnapshotErrorCode(error);
      if (code === 'ABORTED') throw fixedFailure('ABORTED');
      if (code === 'TIMEOUT') throw fixedFailure('TIMEOUT');
      coherenceFailure = sha256(
        `scope:${index}:${code ?? 'INVALID'}:`
        + installed.capabilitySnapshot.privateWitnessFragment,
      );
      break;
    }
  }
  if (coherenceFailure !== undefined) {
    for (let index = 0; index < scopes.length; index += 1) {
      const scope = scopes[index]!;
      const inspected = invalid(input, scope, `request-coherence:${coherenceFailure}`);
      append(observations, inspected.observation!);
      append(
        witnessParts,
        `${index}:${scope.scope}:invalid:${inspected.privateWitness}`,
      );
    }
    return finalizeInspection(input, witnessParts, observations);
  }
  for (let index = 0; index < inspections.length; index += 1) {
    const scope = scopes[index]!;
    const inspected = inspections[index]!;
    const observation = inspected.installed === undefined
      ? inspected.observation!
      : materializeInstalled(inspected.installed);
    append(observations, observation);
    append(
      witnessParts,
      `${index}:${scope.scope}:${observation.state}:${inspected.privateWitness}`,
    );
  }
  return finalizeInspection(input, witnessParts, observations);
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
    baseCapabilityLayers: snapshotted.baseCapabilityLayers,
    ioSeam,
  });
  let inspectionActive = false;
  const inspect = (request: ProjectTemplateRepertoireDependencyInspectionRequest):
  unknown => {
    if (inspectionActive) throw fixedFailure('INVALID_ARGUMENT');
    inspectionActive = true;
    try {
      return inspectRequest(state, request);
    } catch (error) {
      if (
        isStopFailure(error)
      ) throw error;
      throw fixedFailure('INVALID_ARGUMENT');
    } finally {
      inspectionActive = false;
    }
  };
  return freeze({ inspect });
}
