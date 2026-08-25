import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { ProjectTemplateValidationError } from './errors.js';
import {
  consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim,
  type ProjectTemplateRepertoireDependencyInspectionSnapshot,
  type ProjectTemplateRepertoireDependencyObservation,
} from './repertoire-dependency-inspection-port.js';
import {
  calculateProjectTemplateRepertoireDependencyDeclarationSha256,
} from './repertoire-dependency-canonical.js';
import {
  calculateProjectTemplateRepertoireDependencyLockSha256,
  MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES,
  parseProjectTemplateRepertoireDependencyLockJson,
  type ProjectTemplateRepertoireDependencyLockV1,
} from './repertoire-dependency-lock.js';
import {
  parseProjectTemplateRepertoireDependencies,
  type ProjectTemplateRepertoireCapabilityV1,
  type ProjectTemplateRepertoireDependencyV1,
} from './source-descriptor.js';
import type {
  ProjectTemplateRepertoireDependencyChangeCode,
  ProjectTemplateRepertoireDependencyInstalledConflictCode,
  ProjectTemplateLocalEmptyRepertoireDependencyPlanOptions,
  ProjectTemplateRepertoireDependencyMetadataChangeCode,
  ProjectTemplateRepertoireDependencyPlan,
  ProjectTemplateRepertoireDependencyPlanAction,
  ProjectTemplateRepertoireDependencyPlanEntry,
  ProjectTemplateRepertoireDependencyPlanGlobalConflictCode,
  ProjectTemplateRepertoireDependencyPlanOptions,
  ProjectTemplateRepertoireDependencyPreviousLockState,
} from './repertoire-dependency-plan-types.js';

export type {
  ProjectTemplateRepertoireDependencyChangeCode,
  ProjectTemplateRepertoireDependencyInstalledConflictCode,
  ProjectTemplateLocalEmptyRepertoireDependencyPlanOptions,
  ProjectTemplateRepertoireDependencyMetadataChangeCode,
  ProjectTemplateRepertoireDependencyPlan,
  ProjectTemplateRepertoireDependencyPlanAction,
  ProjectTemplateRepertoireDependencyPlanEntry,
  ProjectTemplateRepertoireDependencyPlanGlobalConflictCode,
  ProjectTemplateRepertoireDependencyPlanOptions,
  ProjectTemplateRepertoireDependencyPlanSummary,
  ProjectTemplateRepertoireDependencyPreviousLockInput,
  ProjectTemplateRepertoireDependencyPreviousLockState,
} from './repertoire-dependency-plan-types.js';

const PLAN_ID_DOMAIN =
  'takt.project-template.repertoire-dependency-plan.v1\u0000';
const LOCAL_EMPTY_PRECONDITION_DOMAIN =
  'takt.project-template.local-empty-dependency-precondition.v1\u0000';
const REFS_TAGS_PREFIX = 'refs/tags/';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_JSON_RECEIVER = JSON;
const CAPTURED_REFLECT_RECEIVER = Reflect;
const CAPTURED_CREATE_HASH = createHash;
const CAPTURED_JSON_STRINGIFY = JSON.stringify;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  Object.getOwnPropertyDescriptor;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_STRING_SLICE = String.prototype.slice;
const CAPTURED_STRING_LAST_INDEX_OF = String.prototype.lastIndexOf;
const CAPTURED_STRING_STARTS_WITH = String.prototype.startsWith;
const CAPTURED_STRING = String;
const CAPTURED_REGEXP_TEST = RegExp.prototype.test;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;
const CAPTURED_BUFFER_RECEIVER = Buffer;
const CAPTURED_BUFFER_BYTE_LENGTH = Buffer.byteLength;
const CAPTURED_WEAK_MAP_GET = WeakMap.prototype.get;
const CAPTURED_WEAK_MAP_SET = WeakMap.prototype.set;
const HASH_SAMPLE = CAPTURED_CREATE_HASH('sha256');
const CAPTURED_HASH_UPDATE = HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_SAMPLE.digest;
const CAPTURED_UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const CAPTURED_UINT8_ARRAY = Uint8Array;
const CAPTURED_TYPED_ARRAY_PROTOTYPE = CAPTURED_REFLECT_APPLY(
  CAPTURED_OBJECT_GET_PROTOTYPE_OF,
  CAPTURED_OBJECT_RECEIVER,
  [CAPTURED_UINT8_ARRAY_PROTOTYPE],
) as object;
const CAPTURED_TYPED_ARRAY_BYTE_LENGTH_GETTER = (() => {
  const descriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    CAPTURED_OBJECT_RECEIVER,
    [CAPTURED_TYPED_ARRAY_PROTOTYPE, 'byteLength'],
  ) as PropertyDescriptor | undefined;
  if (descriptor?.get === undefined) throw new Error('byteLength unavailable');
  return descriptor.get;
})();

const PLAN_CANONICAL_BODIES = new WeakMap<object, string>();

interface PreviousSnapshot {
  readonly state: ProjectTemplateRepertoireDependencyPreviousLockState;
  readonly lock?: ProjectTemplateRepertoireDependencyLockV1;
  readonly lockSha256?: string;
}

interface PreviousRawSnapshot {
  readonly state: 'absent' | 'present' | 'unavailable';
  readonly content?: string | Uint8Array;
}

function freeze<T>(value: T): Readonly<T> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Readonly<T>;
}

function ownDescriptors(value: object): Record<PropertyKey, PropertyDescriptor> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
}

function ownKeys(value: object): PropertyKey[] {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    CAPTURED_REFLECT_RECEIVER,
    [value],
  ) as PropertyKey[];
}

function exactDataValues(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) !== CAPTURED_OBJECT_PROTOTYPE
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) !== null
  ) {
    throw new ProjectTemplateValidationError(
      'NON_PLAIN_OBJECT',
      `${field} must be an exact plain data object`,
      field,
    );
  }
  const descriptors = ownDescriptors(value);
  const keys = ownKeys(descriptors);
  if (keys.length !== expectedKeys.length) invalidOptions(field);
  const snapshot = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE,
    CAPTURED_OBJECT_RECEIVER,
    [null],
  ) as Record<string, unknown>;
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]!;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      invalidOptions(field);
    }
    snapshot[key] = descriptor.value;
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string' || descriptors[key] === undefined) {
      invalidOptions(field);
    }
    let found = false;
    for (let expectedIndex = 0; expectedIndex < expectedKeys.length; expectedIndex += 1) {
      if (key === expectedKeys[expectedIndex]) found = true;
    }
    if (!found) invalidOptions(field);
  }
  return snapshot;
}

function invalidOptions(field: string): never {
  throw new ProjectTemplateValidationError(
    'INVALID_LOCK',
    `${field} does not match the dependency planning schema`,
    field,
  );
}

function snapshotOptions(value: unknown): {
  readonly inspectionClaim: unknown;
  readonly incomingLock: ProjectTemplateRepertoireDependencyLockV1;
  readonly previousRaw: PreviousRawSnapshot;
} {
  const options = exactDataValues(
    value,
    ['inspectionClaim', 'incomingLock', 'previousLock'],
    'repertoireDependencyPlan',
  );
  // Incoming content is rejected before the single-use authority is touched.
  const incomingLock = parseIncomingLock(options['incomingLock']);
  const previousEnvelope = exactDataValuesByState(options['previousLock']);
  return freeze({
    inspectionClaim: options['inspectionClaim'],
    incomingLock,
    previousRaw: snapshotPreviousRaw(previousEnvelope),
  });
}

function snapshotLocalEmptyOptions(value: unknown): {
  readonly incomingLock: ProjectTemplateRepertoireDependencyLockV1;
  readonly previousRaw: PreviousRawSnapshot;
} {
  const options = exactDataValues(
    value,
    ['incomingLock', 'previousLock'],
    'localEmptyRepertoireDependencyPlan',
  );
  const incomingLock = parseIncomingLock(options['incomingLock']);
  if (incomingLock.dependencies.length !== 0) {
    invalidOptions('localEmptyRepertoireDependencyPlan.incomingLock.dependencies');
  }
  const previousRaw = snapshotPreviousRaw(
    exactDataValuesByState(options['previousLock']),
  );
  if (previousRaw.state === 'unavailable') {
    invalidOptions('localEmptyRepertoireDependencyPlan.previousLock.state');
  }
  return freeze({ incomingLock, previousRaw });
}

function exactDataValuesByState(value: unknown): Record<string, unknown> {
  const base = exactDataValuesWithAllowedKeys(value, 'previousLock');
  if (base['state'] === 'absent' || base['state'] === 'unavailable') {
    if (ownKeys(base).length !== 1) invalidOptions('previousLock');
    return base;
  }
  if (base['state'] === 'present') {
    if (ownKeys(base).length !== 2 || !('content' in base)) {
      invalidOptions('previousLock');
    }
    return base;
  }
  invalidOptions('previousLock.state');
}

function exactDataValuesWithAllowedKeys(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) !== CAPTURED_OBJECT_PROTOTYPE
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) !== null
  ) invalidOptions(field);
  const descriptors = ownDescriptors(value);
  const keys = ownKeys(descriptors);
  const snapshot = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE,
    CAPTURED_OBJECT_RECEIVER,
    [null],
  ) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (
      typeof key !== 'string'
      || (key !== 'state' && key !== 'content')
      || !('value' in descriptors[key]!)
    ) invalidOptions(field);
    snapshot[key] = descriptors[key]!.value;
  }
  if (!('state' in snapshot)) invalidOptions(field);
  return snapshot;
}

function parseIncomingLock(
  value: unknown,
): ProjectTemplateRepertoireDependencyLockV1 {
  const lock = exactDataValues(
    value,
    [
      'schemaVersion',
      'sourceDescriptorSha256',
      'manifestSha256',
      'dependencies',
    ],
    'incomingLock',
  );
  if (lock['schemaVersion'] !== '1.0') invalidOptions('incomingLock.schemaVersion');
  const sourceDescriptorSha256 = strictSha256(
    lock['sourceDescriptorSha256'],
    'incomingLock.sourceDescriptorSha256',
  );
  const manifestSha256 = strictSha256(
    lock['manifestSha256'],
    'incomingLock.manifestSha256',
  );
  const dependencies = parseProjectTemplateRepertoireDependencies(
    lock['dependencies'],
    'repertoireDependencyLock.dependencies',
  );
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index]!;
    freeze(dependency.capabilities);
    freeze(dependency);
  }
  freeze(dependencies);
  return freeze({
    schemaVersion: '1.0',
    sourceDescriptorSha256,
    manifestSha256,
    dependencies,
  });
}

function strictSha256(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !CAPTURED_REFLECT_APPLY(CAPTURED_REGEXP_TEST, SHA256_PATTERN, [value])
  ) invalidOptions(field);
  return value;
}

function snapshotPreviousRaw(
  value: Record<string, unknown>,
): PreviousRawSnapshot {
  if (value['state'] === 'absent') return freeze({ state: 'absent' });
  if (value['state'] === 'unavailable') return freeze({ state: 'unavailable' });
  const content = value['content'];
  if (typeof content === 'string') {
    assertPreviousByteLimit(CAPTURED_REFLECT_APPLY(
      CAPTURED_BUFFER_BYTE_LENGTH,
      CAPTURED_BUFFER_RECEIVER,
      [content, 'utf8'],
    ) as number);
    return freeze({ state: 'present', content });
  }
  if (
    typeof content !== 'object'
    || content === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [content])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [content],
    ) !== CAPTURED_UINT8_ARRAY_PROTOTYPE
  ) invalidOptions('previousLock.content');
  const byteLength = previousByteLength(content);
  assertPreviousByteLimit(byteLength);
  const descriptors = ownDescriptors(content);
  const keys = ownKeys(descriptors);
  if (keys.length !== byteLength) invalidOptions('previousLock.content');
  const snapshot = new CAPTURED_UINT8_ARRAY(byteLength);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
    if (
      key !== CAPTURED_STRING(index)
      || descriptor === undefined
      || !('value' in descriptor)
      || typeof descriptor.value !== 'number'
    ) invalidOptions('previousLock.content');
    snapshot[index] = descriptor.value;
  }
  return freeze({ state: 'present', content: snapshot });
}

function previousByteLength(value: object): number {
  try {
    return CAPTURED_REFLECT_APPLY(
      CAPTURED_TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
  } catch {
    invalidOptions('previousLock.content');
  }
}

function assertPreviousByteLimit(byteLength: number): void {
  if (byteLength > MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES) {
    throw new ProjectTemplateValidationError(
      'LIMIT_EXCEEDED',
      `previousLock.content exceeds the ${MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES} byte limit`,
      'previousLock.content',
    );
  }
}

function parsePrevious(raw: PreviousRawSnapshot): PreviousSnapshot {
  if (raw.state === 'absent') return freeze({ state: 'absent' });
  if (raw.state === 'unavailable') return freeze({ state: 'unavailable' });
  try {
    const lock = parseProjectTemplateRepertoireDependencyLockJson(raw.content!);
    return freeze({
      state: 'valid',
      lock,
      lockSha256: calculateProjectTemplateRepertoireDependencyLockSha256(lock),
    });
  } catch {
    // Why: semantic parser failures are sealed only after authority transfer;
    // malformed evidence cannot reenter while the same claim is still active.
    return freeze({ state: 'invalid' });
  }
}

function append<T>(values: T[], value: T): void {
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
    [values, CAPTURED_STRING(values.length), descriptor],
  );
}

function dependencyChanges(
  previous: ProjectTemplateRepertoireDependencyV1,
  incoming: ProjectTemplateRepertoireDependencyV1,
): readonly ProjectTemplateRepertoireDependencyChangeCode[] {
  const changes: ProjectTemplateRepertoireDependencyChangeCode[] = [];
  if (previous.source !== incoming.source) append(changes, 'SOURCE_CHANGED');
  if (previous.version !== incoming.version) append(changes, 'VERSION_CHANGED');
  if (previous.commit !== incoming.commit) append(changes, 'COMMIT_CHANGED');
  const previousEdit = hasEdit(previous.capabilities);
  const incomingEdit = hasEdit(incoming.capabilities);
  if (!previousEdit && incomingEdit) append(changes, 'EDIT_CAPABILITY_ADDED');
  if (previousEdit && !incomingEdit) append(changes, 'EDIT_CAPABILITY_REMOVED');
  return freeze(changes);
}

function hasEdit(
  capabilities: readonly ProjectTemplateRepertoireCapabilityV1[],
): boolean {
  return capabilities.length === 1;
}

function requiredInstalledSource(dependency: ProjectTemplateRepertoireDependencyV1): {
  readonly source: `github:${string}/${string}`;
  readonly ref: string;
} {
  const separator = CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_LAST_INDEX_OF,
    dependency.source,
    ['@'],
  ) as number;
  const source = CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_SLICE,
    dependency.source,
    [0, separator],
  ) as `github:${string}/${string}`;
  let ref = CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_SLICE,
    dependency.source,
    [separator + 1],
  ) as string;
  if (CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_STARTS_WITH,
    ref,
    [REFS_TAGS_PREFIX],
  )) {
    ref = CAPTURED_REFLECT_APPLY(
      CAPTURED_STRING_SLICE,
      ref,
      [REFS_TAGS_PREFIX.length],
    ) as string;
  }
  return freeze({ source, ref });
}

function installedConflicts(
  dependency: ProjectTemplateRepertoireDependencyV1,
  observation: ProjectTemplateRepertoireDependencyObservation,
): readonly ProjectTemplateRepertoireDependencyInstalledConflictCode[] {
  if (observation.state === 'missing') return freeze(['NOT_INSTALLED']);
  if (observation.state === 'invalid') return freeze(['INVALID_INSTALLATION']);
  const required = requiredInstalledSource(dependency);
  const conflicts: ProjectTemplateRepertoireDependencyInstalledConflictCode[] = [];
  if (observation.installed.source !== required.source) {
    append(conflicts, 'SOURCE_MISMATCH');
  }
  if (observation.installed.ref !== required.ref) append(conflicts, 'REF_MISMATCH');
  if (observation.installed.version !== dependency.version) {
    append(conflicts, 'VERSION_MISMATCH');
  }
  if (observation.installed.commit !== dependency.commit) {
    append(conflicts, 'COMMIT_MISMATCH');
  }
  if (hasEdit(observation.installed.capabilities) !== hasEdit(dependency.capabilities)) {
    append(conflicts, 'CAPABILITY_MISMATCH');
  }
  return freeze(conflicts);
}

function createEntry(
  action: ProjectTemplateRepertoireDependencyPlanAction,
  previous: ProjectTemplateRepertoireDependencyV1 | undefined,
  incoming: ProjectTemplateRepertoireDependencyV1 | undefined,
  changes: readonly ProjectTemplateRepertoireDependencyChangeCode[],
  observation: ProjectTemplateRepertoireDependencyObservation | undefined,
  useObservation: boolean,
): ProjectTemplateRepertoireDependencyPlanEntry {
  const conflicts = incoming !== undefined && observation !== undefined && useObservation
    ? installedConflicts(incoming, observation)
    : freeze([] as ProjectTemplateRepertoireDependencyInstalledConflictCode[]);
  return freeze({
    scope: (incoming ?? previous)!.scope,
    action,
    changes,
    installedConflicts: conflicts,
    ...(previous === undefined ? {} : { previous }),
    ...(incoming === undefined ? {} : { incoming }),
    ...(observation === undefined || !useObservation ? {} : { observation }),
  });
}

function buildEntries(
  incoming: readonly ProjectTemplateRepertoireDependencyV1[],
  previous: PreviousSnapshot,
  inspection: ProjectTemplateRepertoireDependencyInspectionSnapshot,
  bindingMatches: boolean,
): readonly ProjectTemplateRepertoireDependencyPlanEntry[] {
  const entries: ProjectTemplateRepertoireDependencyPlanEntry[] = [];
  if (previous.state === 'invalid' || previous.state === 'unavailable') {
    for (let index = 0; index < incoming.length; index += 1) {
      append(entries, createEntry(
        'unknown',
        undefined,
        incoming[index]!,
        freeze([] as ProjectTemplateRepertoireDependencyChangeCode[]),
        bindingMatches ? inspection.observations[index] : undefined,
        bindingMatches,
      ));
    }
    return freeze(entries);
  }
  const before = previous.lock?.dependencies ?? [];
  let beforeIndex = 0;
  let incomingIndex = 0;
  while (beforeIndex < before.length || incomingIndex < incoming.length) {
    const oldDependency = before[beforeIndex];
    const newDependency = incoming[incomingIndex];
    if (newDependency === undefined || (
      oldDependency !== undefined && oldDependency.scope < newDependency.scope
    )) {
      append(entries, createEntry(
        'remove', oldDependency, undefined, freeze(['REMOVED']), undefined, false,
      ));
      beforeIndex += 1;
    } else if (oldDependency === undefined || newDependency.scope < oldDependency.scope) {
      append(entries, createEntry(
        'add', undefined, newDependency, freeze(['ADDED']),
        bindingMatches ? inspection.observations[incomingIndex] : undefined,
        bindingMatches,
      ));
      incomingIndex += 1;
    } else {
      const changes = dependencyChanges(oldDependency, newDependency);
      append(entries, createEntry(
        changes.length === 0 ? 'keep' : 'update',
        oldDependency,
        newDependency,
        changes,
        bindingMatches ? inspection.observations[incomingIndex] : undefined,
        bindingMatches,
      ));
      beforeIndex += 1;
      incomingIndex += 1;
    }
  }
  return freeze(entries);
}

function canonicalString(value: string): string {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_JSON_STRINGIFY,
    CAPTURED_JSON_RECEIVER,
    [value],
  ) as string;
}

function canonicalStringArray(values: readonly string[]): string {
  let json = '[';
  for (let index = 0; index < values.length; index += 1) {
    if (index !== 0) json += ',';
    json += canonicalString(values[index]!);
  }
  return `${json}]`;
}

function canonicalDependency(value: ProjectTemplateRepertoireDependencyV1): string {
  return '{"scope":' + canonicalString(value.scope)
    + ',"version":' + canonicalString(value.version)
    + ',"source":' + canonicalString(value.source)
    + ',"commit":' + canonicalString(value.commit)
    + ',"capabilities":' + canonicalStringArray(value.capabilities)
    + '}';
}

function canonicalObservation(value: ProjectTemplateRepertoireDependencyObservation): string {
  let json = '{"scope":' + canonicalString(value.scope)
    + ',"state":' + canonicalString(value.state);
  if (value.state === 'invalid') {
    json += ',"reason":"INVALID_INSTALLATION"';
  } else if (value.state === 'installed') {
    json += ',"installed":{"source":' + canonicalString(value.installed.source)
      + ',"ref":' + canonicalString(value.installed.ref)
      + ',"version":' + canonicalString(value.installed.version)
      + ',"commit":' + canonicalString(value.installed.commit)
      + ',"capabilities":' + canonicalStringArray(value.installed.capabilities)
      + '}';
  }
  return `${json}}`;
}

function canonicalEntries(
  entries: readonly ProjectTemplateRepertoireDependencyPlanEntry[],
): string {
  let json = '[';
  for (let index = 0; index < entries.length; index += 1) {
    if (index !== 0) json += ',';
    const entry = entries[index]!;
    json += '{"scope":' + canonicalString(entry.scope)
      + ',"action":' + canonicalString(entry.action)
      + ',"changes":' + canonicalStringArray(entry.changes)
      + ',"installedConflicts":' + canonicalStringArray(entry.installedConflicts);
    if (entry.previous !== undefined) {
      json += ',"previous":' + canonicalDependency(entry.previous);
    }
    if (entry.incoming !== undefined) {
      json += ',"incoming":' + canonicalDependency(entry.incoming);
    }
    if (entry.observation !== undefined) {
      json += ',"observation":' + canonicalObservation(entry.observation);
    }
    json += '}';
  }
  return `${json}]`;
}

function canonicalLock(value: ProjectTemplateRepertoireDependencyLockV1): string {
  let dependencies = '[';
  for (let index = 0; index < value.dependencies.length; index += 1) {
    if (index !== 0) dependencies += ',';
    dependencies += canonicalDependency(value.dependencies[index]!);
  }
  dependencies += ']';
  return '{"schemaVersion":"1.0","sourceDescriptorSha256":'
    + canonicalString(value.sourceDescriptorSha256)
    + ',"manifestSha256":' + canonicalString(value.manifestSha256)
    + ',"dependencies":' + dependencies + '}';
}

function canonicalPlanBody(
  plan: Omit<ProjectTemplateRepertoireDependencyPlan, 'planId'>,
): string {
  const counts = plan.summary.counts;
  let json = '{"schemaVersion":"1.0","preconditionToken":'
    + canonicalString(plan.preconditionToken)
    + ',"sourceDescriptorSha256":' + canonicalString(plan.sourceDescriptorSha256)
    + ',"manifestSha256":' + canonicalString(plan.manifestSha256)
    + ',"declarationSha256":' + canonicalString(plan.declarationSha256)
    + ',"previousLockState":' + canonicalString(plan.previousLockState);
  if (plan.previousLockSha256 !== undefined) {
    json += ',"previousLockSha256":' + canonicalString(plan.previousLockSha256);
  }
  json += ',"metadataChanges":' + canonicalStringArray(plan.metadataChanges)
    + ',"globalConflicts":' + canonicalStringArray(plan.globalConflicts)
    + ',"dependencies":' + canonicalEntries(plan.dependencies)
    + ',"summary":{"counts":{"add":' + CAPTURED_STRING(counts.add)
    + ',"keep":' + CAPTURED_STRING(counts.keep)
    + ',"update":' + CAPTURED_STRING(counts.update)
    + ',"remove":' + CAPTURED_STRING(counts.remove)
    + ',"unknown":' + CAPTURED_STRING(counts.unknown)
    + '},"conflicts":' + CAPTURED_STRING(plan.summary.conflicts)
    + ',"metadataChanges":'
    + canonicalStringArray(plan.summary.metadataChanges)
    + ',"metadataChangeCount":'
    + CAPTURED_STRING(plan.summary.metadataChangeCount)
    + ',"reviewRequired":' + CAPTURED_STRING(plan.summary.reviewRequired)
    + ',"hardConflict":' + CAPTURED_STRING(plan.summary.hardConflict)
    + '},"reviewRequired":' + CAPTURED_STRING(plan.reviewRequired)
    + ',"hardConflict":' + CAPTURED_STRING(plan.hardConflict)
    + ',"defaultApplyPossible":' + CAPTURED_STRING(plan.defaultApplyPossible);
  if (plan.nextLock !== undefined) json += ',"nextLock":' + canonicalLock(plan.nextLock);
  return `${json}}`;
}

function hashPlanBody(body: string): string {
  const hash = CAPTURED_CREATE_HASH('sha256');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [PLAN_ID_DOMAIN + body, 'utf8']);
  return CAPTURED_REFLECT_APPLY(CAPTURED_HASH_DIGEST, hash, ['hex']) as string;
}

/** Recalculates the domain-separated identity of a plan created in this process. */
export function calculateProjectTemplateRepertoireDependencyPlanId(
  plan: ProjectTemplateRepertoireDependencyPlan,
): string {
  const body = typeof plan === 'object' && plan !== null
    ? CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_MAP_GET, PLAN_CANONICAL_BODIES, [plan])
    : undefined;
  if (typeof body !== 'string') invalidOptions('repertoireDependencyPlan.planId');
  return hashPlanBody(body);
}

/** Builds the common sealed plan after its authority-specific input boundary. */
function createPlanFromSnapshots(
  incomingLock: ProjectTemplateRepertoireDependencyLockV1,
  previous: PreviousSnapshot,
  inspection: ProjectTemplateRepertoireDependencyInspectionSnapshot,
): ProjectTemplateRepertoireDependencyPlan {
  const declarationSha256 =
    calculateProjectTemplateRepertoireDependencyDeclarationSha256(
      incomingLock.dependencies,
    );
  const bindingMatches =
    inspection.sourceDescriptorSha256 === incomingLock.sourceDescriptorSha256
    && inspection.manifestSha256 === incomingLock.manifestSha256
    && inspection.declarationSha256 === declarationSha256;
  const globalConflicts:
    ProjectTemplateRepertoireDependencyPlanGlobalConflictCode[] = [];
  if (!bindingMatches) append(globalConflicts, 'INSPECTION_BINDING_MISMATCH');
  if (previous.state === 'invalid') {
    append(globalConflicts, 'PREVIOUS_LOCK_INVALID');
  } else if (previous.state === 'unavailable') {
    append(globalConflicts, 'PREVIOUS_LOCK_UNAVAILABLE');
  }
  freeze(globalConflicts);
  const metadataChanges:
    ProjectTemplateRepertoireDependencyMetadataChangeCode[] = [];
  if (previous.lock !== undefined) {
    if (
      previous.lock.sourceDescriptorSha256
      !== incomingLock.sourceDescriptorSha256
    ) append(metadataChanges, 'SOURCE_DESCRIPTOR_SHA256_CHANGED');
    if (previous.lock.manifestSha256 !== incomingLock.manifestSha256) {
      append(metadataChanges, 'MANIFEST_SHA256_CHANGED');
    }
  }
  freeze(metadataChanges);
  const dependencies = buildEntries(
    incomingLock.dependencies,
    previous,
    inspection,
    bindingMatches,
  );
  const counts: Record<ProjectTemplateRepertoireDependencyPlanAction, number> = {
    add: 0,
    keep: 0,
    update: 0,
    remove: 0,
    unknown: 0,
  };
  let installedConflictCount = 0;
  let reviewRequired =
    globalConflicts.length !== 0 || metadataChanges.length !== 0;
  for (let index = 0; index < dependencies.length; index += 1) {
    const entry = dependencies[index]!;
    counts[entry.action] += 1;
    installedConflictCount += entry.installedConflicts.length;
    if (entry.action !== 'keep' || entry.installedConflicts.length !== 0) {
      reviewRequired = true;
    }
  }
  freeze(counts);
  const hardConflict = globalConflicts.length !== 0 || installedConflictCount !== 0;
  const summary = freeze({
    counts,
    conflicts: globalConflicts.length + installedConflictCount,
    metadataChanges,
    metadataChangeCount: metadataChanges.length,
    reviewRequired,
    hardConflict,
  });
  const body = freeze({
    schemaVersion: '1.0' as const,
    preconditionToken: inspection.preconditionToken,
    sourceDescriptorSha256: incomingLock.sourceDescriptorSha256,
    manifestSha256: incomingLock.manifestSha256,
    declarationSha256,
    previousLockState: previous.state,
    ...(previous.lockSha256 === undefined
      ? {}
      : { previousLockSha256: previous.lockSha256 }),
    metadataChanges,
    globalConflicts,
    dependencies,
    summary,
    reviewRequired,
    hardConflict,
    defaultApplyPossible: !reviewRequired && !hardConflict,
    ...(!hardConflict ? { nextLock: incomingLock } : {}),
  });
  const canonicalBody = canonicalPlanBody(body);
  const plan = freeze({
    schemaVersion: body.schemaVersion,
    planId: hashPlanBody(canonicalBody),
    preconditionToken: body.preconditionToken,
    sourceDescriptorSha256: body.sourceDescriptorSha256,
    manifestSha256: body.manifestSha256,
    declarationSha256: body.declarationSha256,
    previousLockState: body.previousLockState,
    ...(body.previousLockSha256 === undefined
      ? {}
      : { previousLockSha256: body.previousLockSha256 }),
    metadataChanges: body.metadataChanges,
    globalConflicts: body.globalConflicts,
    dependencies: body.dependencies,
    summary: body.summary,
    reviewRequired: body.reviewRequired,
    hardConflict: body.hardConflict,
    defaultApplyPossible: body.defaultApplyPossible,
    ...(body.nextLock === undefined ? {} : { nextLock: body.nextLock }),
  }) as ProjectTemplateRepertoireDependencyPlan;
  CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_MAP_SET, PLAN_CANONICAL_BODIES, [
    plan,
    canonicalBody,
  ]);
  return plan;
}

/**
 * Consumes exactly one G2 planning claim and creates a review-only dependency
 * delta. All caller-controlled lock material is snapshotted first so invalid
 * incoming input never burns authority, while invalid persisted evidence is a
 * sealed conflict that cannot be bypassed with exception handling.
 */
export function createProjectTemplateRepertoireDependencyPlan(
  value: ProjectTemplateRepertoireDependencyPlanOptions,
): ProjectTemplateRepertoireDependencyPlan {
  const options = snapshotOptions(value);
  const inspection =
    consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim(
      options.inspectionClaim,
    );
  return createPlanFromSnapshots(
    options.incomingLock,
    parsePrevious(options.previousRaw),
    inspection,
  );
}

function calculateLocalEmptyPreconditionToken(
  incomingLock: ProjectTemplateRepertoireDependencyLockV1,
  previous: PreviousSnapshot,
): string {
  const hash = CAPTURED_CREATE_HASH('sha256');
  const body = canonicalLock(incomingLock)
    + '\u0000' + previous.state
    + '\u0000' + (previous.lockSha256 ?? '');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [
    LOCAL_EMPTY_PRECONDITION_DOMAIN + body,
    'utf8',
  ]);
  return CAPTURED_REFLECT_APPLY(CAPTURED_HASH_DIGEST, hash, ['hex']) as string;
}

/**
 * Builds the dependency member of a local archive transaction without
 * fabricating an external installation inspection. This boundary is valid
 * only for the schema 1.0 empty repertoire set, where there is nothing for an
 * external authority to observe.
 */
export function createLocalEmptyProjectTemplateRepertoireDependencyPlan(
  value: ProjectTemplateLocalEmptyRepertoireDependencyPlanOptions,
): ProjectTemplateRepertoireDependencyPlan {
  const options = snapshotLocalEmptyOptions(value);
  const previous = parsePrevious(options.previousRaw);
  const declarationSha256 =
    calculateProjectTemplateRepertoireDependencyDeclarationSha256([]);
  const inspection = freeze({
    kind: 'project-template-repertoire-dependency-inspection-snapshot' as const,
    sourceDescriptorSha256: options.incomingLock.sourceDescriptorSha256,
    manifestSha256: options.incomingLock.manifestSha256,
    declarationSha256,
    preconditionToken: calculateLocalEmptyPreconditionToken(
      options.incomingLock,
      previous,
    ),
    observations: freeze([] as ProjectTemplateRepertoireDependencyObservation[]),
  });
  return createPlanFromSnapshots(options.incomingLock, previous, inspection);
}
