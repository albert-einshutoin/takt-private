import { ProjectTemplateValidationError } from './errors.js';
import {
  calculateProjectTemplateRepertoireDependencyPlanId,
  type ProjectTemplateRepertoireDependencyPlan,
  type ProjectTemplateRepertoireDependencyPlanEntry,
} from './repertoire-dependency-plan.js';
import type {
  ProjectTemplateRepertoireDependencyObservation,
} from './repertoire-dependency-inspection-port.js';
import type {
  ProjectTemplateRepertoireDependencyLockV1,
} from './repertoire-dependency-lock.js';
import type {
  ProjectTemplateRepertoireCapabilityV1,
  ProjectTemplateRepertoireDependencyV1,
} from './source-descriptor.js';

type PreviewScalar = string | number | boolean | null;
type PreviewValue =
  | PreviewScalar
  | readonly PreviewValue[]
  | { readonly [key: string]: PreviewValue };

interface DependencyValuePreview {
  readonly source: string;
  readonly ref: string;
  readonly version: string;
  readonly commit: string;
  readonly capabilities: readonly ProjectTemplateRepertoireCapabilityV1[];
}

type InstalledPreview =
  | { readonly state: 'missing' }
  | {
    readonly state: 'invalid';
    readonly reason: 'INVALID_INSTALLATION';
  }
  | ({ readonly state: 'installed' } & DependencyValuePreview);

interface DependencyEntryPreview {
  readonly scope: string;
  readonly action: string;
  readonly changes: readonly string[];
  readonly installedConflicts: readonly string[];
  readonly previous?: DependencyValuePreview;
  readonly required?: DependencyValuePreview;
  readonly installed?: InstalledPreview;
}

interface DependencyPlanPreview {
  readonly schemaVersion: '1.0';
  readonly planId: string;
  readonly sourceDescriptorSha256: string;
  readonly manifestSha256: string;
  readonly declarationSha256: string;
  readonly previousLockState: string;
  readonly previousLockSha256?: string;
  readonly metadataChanges: readonly string[];
  readonly globalConflicts: readonly string[];
  readonly flags: {
    readonly reviewRequired: boolean;
    readonly hardConflict: boolean;
    readonly defaultApplyPossible: boolean;
  };
  readonly summary: {
    readonly counts: {
      readonly add: number;
      readonly update: number;
      readonly keep: number;
      readonly remove: number;
      readonly unknown: number;
    };
    readonly conflicts: number;
    readonly metadataChanges: readonly string[];
    readonly metadataChangeCount: number;
    readonly reviewRequired: boolean;
    readonly hardConflict: boolean;
  };
  readonly entries: readonly DependencyEntryPreview[];
  readonly nextLock?: PreviewValue;
}

const REFS_TAGS_PREFIX = 'refs/tags/';
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_ARRAY_RECEIVER = Array;
const CAPTURED_JSON_RECEIVER = JSON;
const CAPTURED_REFLECT_RECEIVER = Reflect;
const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_JSON_STRINGIFY = JSON.stringify;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_STRING = String;
const CAPTURED_STRING_LAST_INDEX_OF = String.prototype.lastIndexOf;
const CAPTURED_STRING_SLICE = String.prototype.slice;
const CAPTURED_STRING_STARTS_WITH = String.prototype.startsWith;
const CAPTURED_ARRAY_JOIN = Array.prototype.join;

function freeze<T>(value: T): Readonly<T> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Readonly<T>;
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

function requireSealedPlan(
  value: ProjectTemplateRepertoireDependencyPlan,
): ProjectTemplateRepertoireDependencyPlan {
  // Why: membership/identity validation happens before any public field read.
  // A forged Proxy or accessor therefore cannot turn preview into an input
  // parser or reenter another authority boundary.
  const calculated = calculateProjectTemplateRepertoireDependencyPlanId(value);
  if (value.planId !== calculated) {
    throw new ProjectTemplateValidationError(
      'INVALID_LOCK',
      'repertoire dependency preview requires a sealed plan identity',
      'repertoireDependencyPlan.planId',
    );
  }
  return value;
}

function dependencyPreview(
  dependency: ProjectTemplateRepertoireDependencyV1,
): DependencyValuePreview {
  const separator = CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_LAST_INDEX_OF,
    dependency.source,
    ['@'],
  ) as number;
  const source = CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_SLICE,
    dependency.source,
    [0, separator],
  ) as string;
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
  return freeze({
    source,
    ref,
    version: dependency.version,
    commit: dependency.commit,
    capabilities: dependency.capabilities,
  });
}

function observationPreview(
  observation: ProjectTemplateRepertoireDependencyObservation,
): InstalledPreview {
  if (observation.state === 'missing') return freeze({ state: 'missing' });
  if (observation.state === 'invalid') {
    return freeze({ state: 'invalid', reason: observation.reason });
  }
  return freeze({
    state: 'installed',
    source: observation.installed.source,
    ref: observation.installed.ref,
    version: observation.installed.version,
    commit: observation.installed.commit,
    capabilities: observation.installed.capabilities,
  });
}

function entryPreview(
  entry: ProjectTemplateRepertoireDependencyPlanEntry,
): DependencyEntryPreview {
  return freeze({
    scope: entry.scope,
    action: entry.action,
    changes: entry.changes,
    installedConflicts: entry.installedConflicts,
    ...(entry.previous === undefined
      ? {}
      : { previous: dependencyPreview(entry.previous) }),
    ...(entry.incoming === undefined
      ? {}
      : { required: dependencyPreview(entry.incoming) }),
    ...(entry.observation === undefined
      ? {}
      : { installed: observationPreview(entry.observation) }),
  });
}

function lockPreview(
  lock: ProjectTemplateRepertoireDependencyLockV1,
): PreviewValue {
  const dependencies: PreviewValue[] = [];
  for (let index = 0; index < lock.dependencies.length; index += 1) {
    const dependency = lock.dependencies[index]!;
    const preview = dependencyPreview(dependency);
    append(dependencies, freeze({
      scope: dependency.scope,
      source: preview.source,
      ref: preview.ref,
      version: preview.version,
      commit: preview.commit,
      capabilities: preview.capabilities,
    }));
  }
  freeze(dependencies);
  return freeze({
    schemaVersion: lock.schemaVersion,
    sourceDescriptorSha256: lock.sourceDescriptorSha256,
    manifestSha256: lock.manifestSha256,
    dependencies,
  });
}

function createPreview(
  value: ProjectTemplateRepertoireDependencyPlan,
): DependencyPlanPreview {
  const plan = requireSealedPlan(value);
  const entries: DependencyEntryPreview[] = [];
  for (let index = 0; index < plan.dependencies.length; index += 1) {
    append(entries, entryPreview(plan.dependencies[index]!));
  }
  freeze(entries);
  const counts = plan.summary.counts;
  return freeze({
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    sourceDescriptorSha256: plan.sourceDescriptorSha256,
    manifestSha256: plan.manifestSha256,
    declarationSha256: plan.declarationSha256,
    previousLockState: plan.previousLockState,
    ...(plan.previousLockSha256 === undefined
      ? {}
      : { previousLockSha256: plan.previousLockSha256 }),
    metadataChanges: plan.metadataChanges,
    globalConflicts: plan.globalConflicts,
    flags: freeze({
      reviewRequired: plan.reviewRequired,
      hardConflict: plan.hardConflict,
      defaultApplyPossible: plan.defaultApplyPossible,
    }),
    summary: freeze({
      counts: freeze({
        add: counts.add,
        update: counts.update,
        keep: counts.keep,
        remove: counts.remove,
        unknown: counts.unknown,
      }),
      conflicts: plan.summary.conflicts,
      metadataChanges: plan.summary.metadataChanges,
      metadataChangeCount: plan.summary.metadataChangeCount,
      reviewRequired: plan.summary.reviewRequired,
      hardConflict: plan.summary.hardConflict,
    }),
    entries,
    ...(plan.nextLock === undefined
      ? {}
      : { nextLock: lockPreview(plan.nextLock) }),
  });
}

function canonicalString(value: string): string {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_JSON_STRINGIFY,
    CAPTURED_JSON_RECEIVER,
    [value],
  ) as string;
}

function canonicalJson(value: PreviewValue): string {
  if (typeof value === 'string') return canonicalString(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return CAPTURED_STRING(value);
  }
  if (value === null) return 'null';
  if (CAPTURED_REFLECT_APPLY(
    CAPTURED_ARRAY_IS_ARRAY,
    CAPTURED_ARRAY_RECEIVER,
    [value],
  )) {
    const array = value as readonly PreviewValue[];
    let json = '[';
    for (let index = 0; index < array.length; index += 1) {
      if (index !== 0) json += ',';
      json += canonicalJson(array[index]!);
    }
    return `${json}]`;
  }
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
  let json = '{';
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]! as string;
    if (index !== 0) json += ',';
    json += canonicalString(key) + ':'
      + canonicalJson(descriptors[key]!.value as PreviewValue);
  }
  return `${json}}`;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? '[]' : canonicalJson(values);
}

function dependencyHuman(
  label: string,
  value: DependencyValuePreview,
): string {
  return `  ${label}: source=${canonicalString(value.source)}`
    + ` ref=${canonicalString(value.ref)}`
    + ` version=${canonicalString(value.version)}`
    + ` commit=${canonicalString(value.commit)}`
    + ` capabilities=${list(value.capabilities)}`;
}

function installedHuman(value: InstalledPreview): string {
  if (value.state === 'missing') return '  installed: state=missing';
  if (value.state === 'invalid') {
    return `  installed: state=invalid reason=${value.reason}`;
  }
  return '  installed: state=installed'
    + ` source=${canonicalString(value.source)}`
    + ` ref=${canonicalString(value.ref)}`
    + ` version=${canonicalString(value.version)}`
    + ` commit=${canonicalString(value.commit)}`
    + ` capabilities=${list(value.capabilities)}`;
}

/** Renders a line-safe human review from a process-local sealed G4 plan. */
export function renderProjectTemplateRepertoireDependencyPlanHuman(
  value: ProjectTemplateRepertoireDependencyPlan,
): string {
  const preview = createPreview(value);
  const lines: string[] = [];
  append(lines, `repertoire-dependency-plan schema=${preview.schemaVersion}`);
  append(lines, `planId=${preview.planId}`);
  append(lines, 'hashes:'
    + ` sourceDescriptor=${preview.sourceDescriptorSha256}`
    + ` manifest=${preview.manifestSha256}`
    + ` declaration=${preview.declarationSha256}`);
  append(lines, `previousLock: state=${preview.previousLockState}`
    + (preview.previousLockSha256 === undefined
      ? ''
      : ` sha256=${preview.previousLockSha256}`));
  append(lines, `summary: add=${preview.summary.counts.add}`
    + ` update=${preview.summary.counts.update}`
    + ` keep=${preview.summary.counts.keep}`
    + ` remove=${preview.summary.counts.remove}`
    + ` unknown=${preview.summary.counts.unknown}`
    + ` conflicts=${preview.summary.conflicts}`
    + ` metadataChanges=${preview.summary.metadataChangeCount}`);
  append(lines, `metadataChanges: ${list(preview.metadataChanges)}`);
  append(lines, `globalConflicts: ${list(preview.globalConflicts)}`);
  append(lines, `flags: reviewRequired=${preview.flags.reviewRequired}`
    + ` hardConflict=${preview.flags.hardConflict}`
    + ` defaultApplyPossible=${preview.flags.defaultApplyPossible}`);
  append(lines, `nextLock=${preview.nextLock === undefined ? 'absent' : 'present'}`);
  if (preview.entries.length === 0) {
    append(lines, 'dependencies: <none>');
  } else {
    append(lines, 'dependencies:');
    for (let index = 0; index < preview.entries.length; index += 1) {
      const entry = preview.entries[index]!;
      append(lines, `- scope=${canonicalString(entry.scope)} action=${entry.action}`
        + ` changes=${list(entry.changes)}`
        + ` conflicts=${list(entry.installedConflicts)}`);
      if (entry.previous !== undefined) {
        append(lines, dependencyHuman('previous', entry.previous));
      }
      if (entry.required !== undefined) {
        append(lines, dependencyHuman('required', entry.required));
      }
      if (entry.installed !== undefined) {
        append(lines, installedHuman(entry.installed));
      }
    }
  }
  return CAPTURED_REFLECT_APPLY(CAPTURED_ARRAY_JOIN, lines, ['\n']) as string;
}

/** Renders the canonical machine-readable review DTO, never an input form. */
export function renderProjectTemplateRepertoireDependencyPlanJson(
  value: ProjectTemplateRepertoireDependencyPlan,
): string {
  return canonicalJson(createPreview(value) as unknown as PreviewValue);
}
