import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  parseProjectTemplateRepertoireDependencies,
  type ProjectTemplateRepertoireCapabilityV1,
  type ProjectTemplateRepertoireDependencyV1,
} from './source-descriptor.js';
import {
  SEMVER_PATTERN_SOURCE,
  SOURCE_REF_PATTERN_SOURCE,
} from './validation.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;
const SEMVER_PATTERN = new RegExp(SEMVER_PATTERN_SOURCE);
const SOURCE_REF_PATTERN = new RegExp(SOURCE_REF_PATTERN_SOURCE);
const INSTALLED_SOURCE_PATTERN =
  /^github:(?![a-z0-9-]*--)[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/(?!\.{1,2}$)(?!.*\.git$)[a-z0-9._-]{1,100}$/;
const MAX_INSTALLED_REF_LENGTH = 256;
const MAX_INSTALLED_VERSION_LENGTH = 128;
const PRECONDITION_TOKEN_DOMAIN =
  'takt.project-template.repertoire-dependency-inspection-precondition.v1\u0000';

const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_ARRAY_INCLUDES = Array.prototype.includes;
const CAPTURED_ARRAY_MAP = Array.prototype.map;
const CAPTURED_ARRAY_PUSH = Array.prototype.push;
const CAPTURED_CREATE_HASH = createHash;
const CAPTURED_JSON_STRINGIFY = JSON.stringify;
const CAPTURED_NUMBER = Number;
const CAPTURED_NUMBER_IS_FINITE = Number.isFinite;
const CAPTURED_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const CAPTURED_STRING = String;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  Object.getOwnPropertyDescriptor;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const CAPTURED_ARRAY_PROTOTYPE = Array.prototype;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_REGEXP_TEST = RegExp.prototype.test;
const CAPTURED_TYPES_IS_PROMISE = types.isPromise;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;
const CAPTURED_WEAK_MAP_GET = WeakMap.prototype.get;
const CAPTURED_WEAK_MAP_SET = WeakMap.prototype.set;
const CAPTURED_WEAK_MAP_DELETE = WeakMap.prototype.delete;
const CAPTURED_PERFORMANCE = performance;
const CAPTURED_PERFORMANCE_NOW = performance.now;
const CAPTURED_ABORT_SIGNAL_PROTOTYPE = AbortSignal.prototype;
const CAPTURED_ABORTED_GETTER = (() => {
  const descriptor = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    'aborted',
  );
  if (descriptor?.get === undefined) {
    throw new Error('AbortSignal aborted intrinsic is unavailable');
  }
  return descriptor.get;
})();
const HASH_PROTOTYPE_SAMPLE = CAPTURED_CREATE_HASH('sha256');
const CAPTURED_HASH_UPDATE = HASH_PROTOTYPE_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_PROTOTYPE_SAMPLE.digest;

export type ProjectTemplateRepertoireDependencyInspectionErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_AUTHORITY'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'INSPECTION_FAILED'
  | 'BRIDGE_FAILURE';

export class ProjectTemplateRepertoireDependencyInspectionError extends Error {
  constructor(
    public readonly code:
      ProjectTemplateRepertoireDependencyInspectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectTemplateRepertoireDependencyInspectionError';
  }
}

export interface ProjectTemplateRepertoireDependencyInspectionRequest {
  readonly sourceDescriptorSha256: string;
  readonly manifestSha256: string;
  readonly dependencies: readonly ProjectTemplateRepertoireDependencyV1[];
  readonly signal?: AbortSignal;
  /** Absolute deadline in the captured monotonic performance time domain. */
  readonly deadlineMs: number;
}

export type ProjectTemplateRepertoireDependencyObservation =
  | {
    readonly scope: `@${string}/${string}`;
    readonly state: 'missing';
  }
  | {
    readonly scope: `@${string}/${string}`;
    readonly state: 'invalid';
    readonly reason: 'INVALID_INSTALLATION';
  }
  | {
    readonly scope: `@${string}/${string}`;
    readonly state: 'installed';
    readonly installed: {
      readonly source: `github:${string}/${string}`;
      readonly ref: string;
      readonly version: string;
      readonly commit: string;
      readonly capabilities:
        readonly ProjectTemplateRepertoireCapabilityV1[];
    };
  };

/**
 * Synchronous observation boundary. Implementations may inspect private-takt
 * installation state, but filesystem handles and raw failures stay private.
 */
export interface ProjectTemplateRepertoireDependencyInspectionPort {
  inspect(
    request: ProjectTemplateRepertoireDependencyInspectionRequest,
  ): unknown;
}

export interface VerifiedProjectTemplateRepertoireDependencyInspection {
  readonly kind:
    'verified-project-template-repertoire-dependency-inspection';
  readonly sourceDescriptorSha256: string;
  readonly manifestSha256: string;
  readonly declarationSha256: string;
  readonly preconditionToken: string;
  readonly observations:
    readonly ProjectTemplateRepertoireDependencyObservation[];
}

/**
 * Authority-free evidence returned to planning after the single-use claim is
 * consumed. The distinct kind prevents structural reuse as fresh authority.
 */
export interface ProjectTemplateRepertoireDependencyInspectionSnapshot {
  readonly kind:
    'project-template-repertoire-dependency-inspection-snapshot';
  readonly sourceDescriptorSha256: string;
  readonly manifestSha256: string;
  readonly declarationSha256: string;
  readonly preconditionToken: string;
  readonly observations:
    readonly ProjectTemplateRepertoireDependencyObservation[];
}

declare const projectTemplateRepertoireDependencyInspectionPlanningClaimBrand:
unique symbol;

/** Opaque, process-local ownership of one inspection for planning only. */
export interface ProjectTemplateRepertoireDependencyInspectionPlanningClaim {
  readonly inspection:
    VerifiedProjectTemplateRepertoireDependencyInspection;
  readonly [
    projectTemplateRepertoireDependencyInspectionPlanningClaimBrand
  ]: true;
}

interface InspectionOptions {
  readonly request: ProjectTemplateRepertoireDependencyInspectionRequest;
  readonly port: {
    readonly receiver: object;
    readonly inspect:
      ProjectTemplateRepertoireDependencyInspectionPort['inspect'];
  };
}

interface InspectionAuthority {
  readonly inspection:
    VerifiedProjectTemplateRepertoireDependencyInspection;
  state:
    | 'active'
    | 'claiming'
    | 'planning-owned'
    | 'consumed'
    | 'disposed';
}

const INSPECTION_AUTHORITIES = new WeakMap<object, InspectionAuthority>();
const PLANNING_CLAIM_AUTHORITIES =
  new WeakMap<object, InspectionAuthority>();

function freeze<T>(value: T): Readonly<T> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE,
    Object,
    [value],
  ) as Readonly<T>;
}

function regexpTest(pattern: RegExp, value: string): boolean {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_REGEXP_TEST,
    pattern,
    [value],
  ) as boolean;
}

function authorityGet(
  map: WeakMap<object, InspectionAuthority>,
  key: object,
): InspectionAuthority | undefined {
  // Why: authority transitions must not call mutable WeakMap prototype
  // methods, which could reenter between reservation and retirement.
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_MAP_GET,
    map,
    [key],
  ) as InspectionAuthority | undefined;
}

function authoritySet(
  map: WeakMap<object, InspectionAuthority>,
  key: object,
  authority: InspectionAuthority,
): void {
  CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_MAP_SET,
    map,
    [key, authority],
  );
}

function authorityDelete(
  map: WeakMap<object, InspectionAuthority>,
  key: object,
): void {
  CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_MAP_DELETE, map, [key]);
}

function inspectionError(
  code: ProjectTemplateRepertoireDependencyInspectionErrorCode,
  message: string,
): ProjectTemplateRepertoireDependencyInspectionError {
  return freeze(
    new ProjectTemplateRepertoireDependencyInspectionError(code, message),
  ) as ProjectTemplateRepertoireDependencyInspectionError;
}

function invalidArgument():
ProjectTemplateRepertoireDependencyInspectionError {
  return inspectionError(
    'INVALID_ARGUMENT',
    'Project template repertoire dependency inspection input is invalid',
  );
}

function invalidAuthority():
ProjectTemplateRepertoireDependencyInspectionError {
  return inspectionError(
    'INVALID_AUTHORITY',
    'Project template repertoire dependency inspection authority is invalid',
  );
}

function bridgeFailure():
ProjectTemplateRepertoireDependencyInspectionError {
  return inspectionError(
    'BRIDGE_FAILURE',
    'Project template repertoire dependency inspection bridge returned an invalid result',
  );
}

type DescriptorMap = Record<PropertyKey, PropertyDescriptor | undefined>;

function exactOwnDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_TYPES_IS_PROXY(value)
    || CAPTURED_ARRAY_IS_ARRAY(value)
  ) throw new Error();
  const prototype = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_PROTOTYPE_OF,
    Object,
    [value],
  ) as object | null;
  if (prototype !== CAPTURED_OBJECT_PROTOTYPE && prototype !== null) {
    throw new Error();
  }
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    Object,
    [value],
  ) as unknown as DescriptorMap;
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    Reflect,
    [descriptors],
  ) as PropertyKey[];
  const snapshot = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE,
    Object,
    [null],
  ) as Record<string, unknown>;
  // Why: `for...of` would consult a mutable Array iterator after module init,
  // allowing reentry before this exact-record snapshot is complete.
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex]!;
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || !CAPTURED_REFLECT_APPLY(
        CAPTURED_ARRAY_INCLUDES,
        allowedKeys,
        [key],
      )
      || descriptor === undefined
      || !('value' in descriptor)
    ) throw new Error();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactOwnDataArray(
  value: unknown,
  expectedLength?: number,
  maxLength?: number,
): unknown[] {
  if (
    !CAPTURED_ARRAY_IS_ARRAY(value)
    || CAPTURED_TYPES_IS_PROXY(value)
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      Object,
      [value],
    ) !== CAPTURED_ARRAY_PROTOTYPE
  ) throw new Error();
  // Why: expected-length and bounded-capability failures must precede an
  // attacker-sized descriptor enumeration.
  const lengthDescriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    Object,
    [value, 'length'],
  ) as PropertyDescriptor | undefined;
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || !CAPTURED_NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || (
      expectedLength !== undefined
      && lengthDescriptor.value !== expectedLength
    )
    || (
      maxLength !== undefined
      && lengthDescriptor.value > maxLength
    )
  ) throw new Error();
  const length = lengthDescriptor.value as number;
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    Object,
    [value],
  ) as unknown as DescriptorMap;
  const snapshottedLengthDescriptor = descriptors['length'];
  if (
    snapshottedLengthDescriptor === undefined
    || !('value' in snapshottedLengthDescriptor)
    || snapshottedLengthDescriptor.value !== length
  ) throw new Error();
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    Reflect,
    [descriptors],
  ) as PropertyKey[];
  if (keys.length !== length + 1) throw new Error();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[CAPTURED_STRING(index)];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error();
    }
    CAPTURED_REFLECT_APPLY(
      CAPTURED_ARRAY_PUSH,
      result,
      [descriptor.value],
    );
  }
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex]!;
    if (
      key !== 'length'
      && (
        typeof key !== 'string'
        || !regexpTest(ARRAY_INDEX_PATTERN, key)
        || CAPTURED_NUMBER(key) >= length
      )
    ) throw new Error();
  }
  return result;
}

function snapshotSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_TYPES_IS_PROXY(value)
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      Object,
      [value],
    ) !== CAPTURED_ABORT_SIGNAL_PROTOTYPE
  ) throw new Error();
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    Object,
    [value],
  ) as unknown as DescriptorMap;
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    Reflect,
    [descriptors],
  ) as PropertyKey[];
  // Node carries private symbol-backed AbortSignal slots. Permit only symbol
  // data slots; caller-visible string fields and accessors remain forbidden.
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex]!;
    const descriptor = descriptors[key];
    if (
      typeof key !== 'symbol'
      || descriptor === undefined
      || !('value' in descriptor)
    ) throw new Error();
  }
  CAPTURED_REFLECT_APPLY(CAPTURED_ABORTED_GETTER, value, []);
  return value as AbortSignal;
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_ABORTED_GETTER,
    signal,
    [],
  ) as boolean;
}

function readNow(): number {
  const now = CAPTURED_REFLECT_APPLY(
    CAPTURED_PERFORMANCE_NOW,
    CAPTURED_PERFORMANCE,
    [],
  ) as unknown;
  if (
    typeof now !== 'number'
    || !CAPTURED_NUMBER_IS_FINITE(now)
    || now < 0
  ) throw bridgeFailure();
  return now;
}

function requireActivePreflight(
  signal: AbortSignal | undefined,
  deadlineMs: number,
): void {
  // Why: abort is the caller's explicit cancellation and therefore remains
  // the deterministic primary error when cancellation and expiry coincide.
  if (signalAborted(signal)) {
    throw inspectionError(
      'ABORTED',
      'Project template repertoire dependency inspection was aborted',
    );
  }
  if (readNow() >= deadlineMs) {
    throw inspectionError(
      'TIMEOUT',
      'Project template repertoire dependency inspection timed out',
    );
  }
}

function snapshotDependencies(
  value: unknown,
): readonly ProjectTemplateRepertoireDependencyV1[] {
  const parsed = parseProjectTemplateRepertoireDependencies(
    value,
    'request.dependencies',
  );
  return freeze(CAPTURED_REFLECT_APPLY(
    CAPTURED_ARRAY_MAP,
    parsed,
    [(dependency: ProjectTemplateRepertoireDependencyV1) => freeze({
      scope: dependency.scope,
      version: dependency.version,
      source: dependency.source,
      commit: dependency.commit,
      capabilities: freeze(
        dependency.capabilities.length === 0 ? [] : ['edit'],
      ),
    })],
  )) as readonly ProjectTemplateRepertoireDependencyV1[];
}

function snapshotRequest(
  value: unknown,
): ProjectTemplateRepertoireDependencyInspectionRequest {
  const request = exactOwnDataRecord(value, [
    'sourceDescriptorSha256',
    'manifestSha256',
    'dependencies',
    'signal',
    'deadlineMs',
  ]);
  if (
    typeof request['sourceDescriptorSha256'] !== 'string'
    || !regexpTest(SHA256_PATTERN, request['sourceDescriptorSha256'])
    || typeof request['manifestSha256'] !== 'string'
    || !regexpTest(SHA256_PATTERN, request['manifestSha256'])
    || typeof request['deadlineMs'] !== 'number'
    || !CAPTURED_NUMBER_IS_FINITE(request['deadlineMs'])
    || request['deadlineMs'] < 0
  ) throw new Error();
  const signal = snapshotSignal(request['signal']);
  const dependencies = snapshotDependencies(request['dependencies']);
  return freeze({
    sourceDescriptorSha256: request['sourceDescriptorSha256'],
    manifestSha256: request['manifestSha256'],
    dependencies,
    ...(signal === undefined ? {} : { signal }),
    deadlineMs: request['deadlineMs'],
  }) as ProjectTemplateRepertoireDependencyInspectionRequest;
}

function snapshotPort(
  value: unknown,
): InspectionOptions['port'] {
  const port = exactOwnDataRecord(value, ['inspect']);
  const inspect = port['inspect'];
  if (
    typeof inspect !== 'function'
    || CAPTURED_TYPES_IS_PROXY(inspect)
  ) throw new Error();
  return freeze({
    receiver: value as object,
    inspect: inspect as
      ProjectTemplateRepertoireDependencyInspectionPort['inspect'],
  });
}

function snapshotOptions(value: unknown): InspectionOptions {
  try {
    const options = exactOwnDataRecord(value, ['request', 'port']);
    return freeze({
      request: snapshotRequest(options['request']),
      port: snapshotPort(options['port']),
    });
  } catch (error) {
    void error;
    throw invalidArgument();
  }
}

function snapshotCapabilities(
  value: unknown,
): readonly ProjectTemplateRepertoireCapabilityV1[] {
  const capabilities = exactOwnDataArray(value, undefined, 1);
  if (
    capabilities.length > 1
    || (capabilities.length === 1 && capabilities[0] !== 'edit')
  ) throw new Error();
  return freeze(
    capabilities as ProjectTemplateRepertoireCapabilityV1[],
  );
}

function snapshotInstalled(value: unknown):
Extract<ProjectTemplateRepertoireDependencyObservation, {
  readonly state: 'installed';
}>['installed'] {
  const installed = exactOwnDataRecord(value, [
    'source',
    'ref',
    'version',
    'commit',
    'capabilities',
  ]);
  if (
    typeof installed['source'] !== 'string'
    || typeof installed['ref'] !== 'string'
    || typeof installed['version'] !== 'string'
    || typeof installed['commit'] !== 'string'
    || !regexpTest(COMMIT_PATTERN, installed['commit'])
    || installed['ref'].length === 0
    || installed['ref'].length > MAX_INSTALLED_REF_LENGTH
    || !regexpTest(SOURCE_REF_PATTERN, installed['ref'])
    || installed['version'].length === 0
    || installed['version'].length > MAX_INSTALLED_VERSION_LENGTH
    || !regexpTest(SEMVER_PATTERN, installed['version'])
    || !regexpTest(INSTALLED_SOURCE_PATTERN, installed['source'])
  ) throw new Error();
  return freeze({
    source: installed['source'] as `github:${string}/${string}`,
    ref: installed['ref'],
    version: installed['version'],
    commit: installed['commit'],
    capabilities: snapshotCapabilities(installed['capabilities']),
  });
}

function snapshotObservation(
  value: unknown,
  expectedScope: string,
): ProjectTemplateRepertoireDependencyObservation {
  const envelope = exactOwnDataRecord(value, [
    'scope',
    'state',
    'reason',
    'installed',
  ]);
  if (envelope['scope'] !== expectedScope) throw new Error();
  if (envelope['state'] === 'missing') {
    const missing = exactOwnDataRecord(value, ['scope', 'state']);
    return freeze({
      scope: missing['scope'] as `@${string}/${string}`,
      state: 'missing',
    });
  }
  if (envelope['state'] === 'invalid') {
    const invalid = exactOwnDataRecord(value, [
      'scope',
      'state',
      'reason',
    ]);
    if (invalid['reason'] !== 'INVALID_INSTALLATION') throw new Error();
    return freeze({
      scope: invalid['scope'] as `@${string}/${string}`,
      state: 'invalid',
      reason: 'INVALID_INSTALLATION' as const,
    });
  }
  if (envelope['state'] === 'installed') {
    const installed = exactOwnDataRecord(value, [
      'scope',
      'state',
      'installed',
    ]);
    return freeze({
      scope: installed['scope'] as `@${string}/${string}`,
      state: 'installed',
      installed: snapshotInstalled(installed['installed']),
    });
  }
  throw new Error();
}

function snapshotRawResult(
  value: unknown,
  dependencies: readonly ProjectTemplateRepertoireDependencyV1[],
): {
  readonly witnessSha256: string;
  readonly observations:
    readonly ProjectTemplateRepertoireDependencyObservation[];
} {
  try {
    // Why: a synchronous bridge cannot silently widen into async work. Native
    // promises and functions are rejected before any property (including
    // caller-controlled `then`) is read.
    if (
      typeof value === 'function'
      || (
        typeof value === 'object'
        && value !== null
        && CAPTURED_TYPES_IS_PROMISE(value)
      )
    ) throw new Error();
    const raw = exactOwnDataRecord(value, [
      'witnessSha256',
      'observations',
    ]);
    if (
      typeof raw['witnessSha256'] !== 'string'
      || !regexpTest(SHA256_PATTERN, raw['witnessSha256'])
    ) throw new Error();
    const rawObservations = exactOwnDataArray(
      raw['observations'],
      dependencies.length,
      dependencies.length,
    );
    const observations =
      CAPTURED_REFLECT_APPLY(
        CAPTURED_ARRAY_MAP,
        rawObservations,
        [(
          observation: unknown,
          index: number,
        ) => snapshotObservation(
          observation,
          dependencies[index]!.scope,
        )],
      ) as ProjectTemplateRepertoireDependencyObservation[];
    return freeze({
      witnessSha256: raw['witnessSha256'],
      observations: freeze(observations),
    });
  } catch {
    throw bridgeFailure();
  }
}

function sha256(value: string): string {
  const hash = CAPTURED_CREATE_HASH('sha256');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [value, 'utf8']);
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_HASH_DIGEST,
    hash,
    ['hex'],
  ) as string;
}

function canonicalString(value: string): string {
  const json = CAPTURED_REFLECT_APPLY(
    CAPTURED_JSON_STRINGIFY,
    JSON,
    [value],
  ) as string | undefined;
  if (json === undefined) throw bridgeFailure();
  return json;
}

function canonicalCapabilities(
  capabilities: readonly ProjectTemplateRepertoireCapabilityV1[],
): string {
  return capabilities.length === 0 ? '[]' : '["edit"]';
}

function canonicalDependencies(
  dependencies: readonly ProjectTemplateRepertoireDependencyV1[],
): string {
  let json = '[';
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index]!;
    if (index !== 0) json += ',';
    json += '{"scope":'
      + canonicalString(dependency.scope)
      + ',"version":'
      + canonicalString(dependency.version)
      + ',"source":'
      + canonicalString(dependency.source)
      + ',"commit":'
      + canonicalString(dependency.commit)
      + ',"capabilities":'
      + canonicalCapabilities(dependency.capabilities)
      + '}';
  }
  return `${json}]`;
}

function canonicalObservations(
  observations:
    readonly ProjectTemplateRepertoireDependencyObservation[],
): string {
  let json = '[';
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    if (index !== 0) json += ',';
    json += '{"scope":' + canonicalString(observation.scope)
      + ',"state":' + canonicalString(observation.state);
    if (observation.state === 'invalid') {
      json += ',"reason":"INVALID_INSTALLATION"';
    } else if (observation.state === 'installed') {
      json += ',"installed":{"source":'
        + canonicalString(observation.installed.source)
        + ',"ref":'
        + canonicalString(observation.installed.ref)
        + ',"version":'
        + canonicalString(observation.installed.version)
        + ',"commit":'
        + canonicalString(observation.installed.commit)
        + ',"capabilities":'
        + canonicalCapabilities(observation.installed.capabilities)
        + '}';
    }
    json += '}';
  }
  return `${json}]`;
}

function createVerifiedInspection(
  request: ProjectTemplateRepertoireDependencyInspectionRequest,
  witnessSha256: string,
  observations:
    readonly ProjectTemplateRepertoireDependencyObservation[],
): VerifiedProjectTemplateRepertoireDependencyInspection {
  const declarationSha256 = sha256(
    canonicalDependencies(request.dependencies),
  );
  const preconditionBody = '{"schemaVersion":"1.0"'
    + ',"sourceDescriptorSha256":'
    + canonicalString(request.sourceDescriptorSha256)
    + ',"manifestSha256":'
    + canonicalString(request.manifestSha256)
    + ',"declarationSha256":'
    + canonicalString(declarationSha256)
    + ',"witnessSha256":'
    + canonicalString(witnessSha256)
    + ',"observations":'
    + canonicalObservations(observations)
    + '}';
  return freeze({
    kind: 'verified-project-template-repertoire-dependency-inspection',
    sourceDescriptorSha256: request.sourceDescriptorSha256,
    manifestSha256: request.manifestSha256,
    declarationSha256,
    preconditionToken: sha256(
      PRECONDITION_TOKEN_DOMAIN + preconditionBody,
    ),
    observations,
  }) as VerifiedProjectTemplateRepertoireDependencyInspection;
}

export function inspectProjectTemplateRepertoireDependencies(
  optionsValue: {
    readonly request:
      ProjectTemplateRepertoireDependencyInspectionRequest;
    readonly port: ProjectTemplateRepertoireDependencyInspectionPort;
  },
): VerifiedProjectTemplateRepertoireDependencyInspection {
  const options = snapshotOptions(optionsValue);
  requireActivePreflight(
    options.request.signal,
    options.request.deadlineMs,
  );

  let rawResult: unknown;
  let portFailed = false;
  try {
    rawResult = CAPTURED_REFLECT_APPLY(
      options.port.inspect,
      options.port.receiver,
      [options.request],
    );
  } catch {
    // Do not retain, stringify, or attach an untrusted thrown value.
    portFailed = true;
  }

  requireActivePreflight(
    options.request.signal,
    options.request.deadlineMs,
  );
  if (portFailed) {
    throw inspectionError(
      'INSPECTION_FAILED',
      'Project template repertoire dependency inspection failed',
    );
  }
  const raw = snapshotRawResult(
    rawResult,
    options.request.dependencies,
  );
  const inspection = createVerifiedInspection(
    options.request,
    raw.witnessSha256,
    raw.observations,
  );
  authoritySet(INSPECTION_AUTHORITIES, inspection, {
    inspection,
    state: 'active',
  });
  return inspection;
}

function requireActiveInspection(
  value: unknown,
): InspectionAuthority {
  const authority =
    typeof value === 'object' && value !== null
      ? authorityGet(INSPECTION_AUTHORITIES, value)
      : undefined;
  if (
    authority === undefined
    || authority.inspection !== value
    || authority.state !== 'active'
  ) throw invalidAuthority();
  return authority;
}

export function claimProjectTemplateRepertoireDependencyInspectionForPlanning(
  value: unknown,
): ProjectTemplateRepertoireDependencyInspectionPlanningClaim {
  const authority = requireActiveInspection(value);
  // Why: reserve before claim construction so reentry can never create two
  // planning owners for the same observation.
  authority.state = 'claiming';
  let claim:
    ProjectTemplateRepertoireDependencyInspectionPlanningClaim | undefined;
  try {
    claim = freeze({
      inspection: authority.inspection,
    }) as ProjectTemplateRepertoireDependencyInspectionPlanningClaim;
    authoritySet(PLANNING_CLAIM_AUTHORITIES, claim, authority);
    authority.state = 'planning-owned';
    return claim;
  } catch (error) {
    if (claim !== undefined) {
      authorityDelete(PLANNING_CLAIM_AUTHORITIES, claim);
    }
    authority.state = 'active';
    throw error;
  }
}

function requirePlanningClaim(
  value: unknown,
): {
  readonly claim:
    ProjectTemplateRepertoireDependencyInspectionPlanningClaim;
  readonly authority: InspectionAuthority;
} {
  // Why: membership is checked before reading `claim.inspection`; forged
  // accessors, Proxy traps, and cloned evidence therefore remain hook-free.
  const authority =
    typeof value === 'object' && value !== null
      ? authorityGet(PLANNING_CLAIM_AUTHORITIES, value)
      : undefined;
  if (
    authority === undefined
    || authority.state !== 'planning-owned'
  ) throw invalidAuthority();
  return {
    claim:
      value as ProjectTemplateRepertoireDependencyInspectionPlanningClaim,
    authority,
  };
}

function createSnapshot(
  inspection: VerifiedProjectTemplateRepertoireDependencyInspection,
): ProjectTemplateRepertoireDependencyInspectionSnapshot {
  return freeze({
    kind: 'project-template-repertoire-dependency-inspection-snapshot',
    sourceDescriptorSha256: inspection.sourceDescriptorSha256,
    manifestSha256: inspection.manifestSha256,
    declarationSha256: inspection.declarationSha256,
    preconditionToken: inspection.preconditionToken,
    observations: inspection.observations,
  }) as ProjectTemplateRepertoireDependencyInspectionSnapshot;
}

export function consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim(
  value: unknown,
): ProjectTemplateRepertoireDependencyInspectionSnapshot {
  const { claim, authority } = requirePlanningClaim(value);
  const snapshot = createSnapshot(authority.inspection);
  authority.state = 'consumed';
  authorityDelete(PLANNING_CLAIM_AUTHORITIES, claim);
  authorityDelete(INSPECTION_AUTHORITIES, authority.inspection);
  return snapshot;
}

export function disposeProjectTemplateRepertoireDependencyInspection(
  value: unknown,
): void {
  const authority = requireActiveInspection(value);
  authority.state = 'disposed';
  authorityDelete(INSPECTION_AUTHORITIES, authority.inspection);
}

export function disposeProjectTemplateRepertoireDependencyInspectionPlanningClaim(
  value: unknown,
): void {
  const { claim, authority } = requirePlanningClaim(value);
  authority.state = 'disposed';
  authorityDelete(PLANNING_CLAIM_AUTHORITIES, claim);
  authorityDelete(INSPECTION_AUTHORITIES, authority.inspection);
}
