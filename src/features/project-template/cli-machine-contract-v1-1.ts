import {
  parseProjectTemplateCliJson,
  serializeProjectTemplateCliJson,
  snapshotProjectTemplateCliJson,
} from './cli-bounded-json.js';
import {
  PROJECT_TEMPLATE_CLI_ERROR_EXIT_CODES,
  type ProjectTemplateCliCommand,
  type ProjectTemplateCliErrorCode,
  type ProjectTemplateCliMode,
  type ProjectTemplateCliRecoveryState,
  type ProjectTemplateCliReviewCode,
  type ProjectTemplateCliWarning,
} from './cli-machine-contract.js';
import { ProjectTemplateCliContractError } from './cli-contract-error.js';
import { PROJECT_TEMPLATE_CLASSIFICATION_REASONS } from './classifier-types.js';
import {
  MAX_TEMPLATE_PATH_LENGTH,
  PROJECT_TEMPLATE_PATH_PATTERN_SOURCE,
} from './validation.js';

export { ProjectTemplateCliContractError as ProjectTemplateCliV1_1ContractError };

export const PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1 = '1.1' as const;
export const PROJECT_TEMPLATE_CLI_SUPPORTED_SCHEMA_VERSIONS = Object.freeze([
  '1.0',
  PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1,
] as const);
export const MAX_PROJECT_TEMPLATE_CLI_DETAIL_ITEMS_V1_1 = 256;
const MAX_PROJECT_TEMPLATE_CLI_CAPABILITY_WARNING_TOTAL_V1_1 = 4_096 * 3;

export type ProjectTemplateCliCapabilityV1_1 =
  | 'executable'
  | 'github-write'
  | 'external-command';
export type ProjectTemplateCliActionV1_1 =
  | 'add'
  | 'update'
  | 'keep'
  | 'delete'
  | 'conflict'
  | 'excluded';

export type ProjectTemplateCliSourceV1_1 =
  | {
    readonly kind: 'local-import';
    readonly sourceId: string;
    readonly revision: string;
    readonly archiveId: string;
    readonly manifestId: string;
  }
  | {
    readonly kind: 'github';
    readonly sourceId: string;
    readonly owner: string;
    readonly repo: string;
    readonly requestedRef: string;
    readonly resolvedCommit: string;
    readonly releaseTag: string | null;
    readonly assetName: string | null;
    readonly archiveId: string;
    readonly manifestId: string;
  };

export interface ProjectTemplateCliCollectionV1_1<T> {
  readonly items: readonly T[];
  readonly totalCount: number;
  readonly truncated: boolean;
}

export interface ProjectTemplateCliTargetV1_1 {
  readonly itemId: string;
  readonly targetId: string;
  readonly manifestId: string;
  readonly path: string;
  readonly policy: 'managed' | 'merge' | 'scaffold' | 'excluded';
  readonly action: ProjectTemplateCliActionV1_1;
  readonly reason: string;
  readonly reviewRequired: boolean;
  readonly capabilitiesBefore: readonly ProjectTemplateCliCapabilityV1_1[];
  readonly capabilitiesAfter: readonly ProjectTemplateCliCapabilityV1_1[];
}

export interface ProjectTemplateCliConflictV1_1 {
  readonly conflictId: string;
  readonly targetId: string;
  readonly manifestId: string;
  readonly path: string;
  readonly reason: string;
  readonly safeDefaultAction: 'abort';
  readonly allowedActions: readonly ['abort'];
}

export interface ProjectTemplateCliCapabilityWarningV1_1 {
  readonly warningId: string;
  readonly targetId: string;
  readonly manifestId: string;
  readonly path: string;
  readonly capability: ProjectTemplateCliCapabilityV1_1;
}

export interface ProjectTemplateCliInspectTargetV1_1 {
  readonly targetId: string;
  readonly manifestId: string;
  readonly path: string;
  readonly policy: 'managed' | 'merge' | 'scaffold' | 'excluded';
  readonly capabilities: readonly ProjectTemplateCliCapabilityV1_1[];
}

export interface ProjectTemplateCliInspectResultV1_1 {
  readonly packId: string;
  readonly entryCount: number;
  readonly archiveBytes: number;
  readonly dependencyCount: number;
  readonly readiness: 'ready' | 'review-required' | 'blocked' | 'recovery-required';
  readonly reviewCodes: readonly ProjectTemplateCliReviewCode[];
  readonly detail: {
    readonly identity: {
      readonly packFormatVersion: '1.0';
      readonly packVersion: string;
      readonly archiveId: string;
      readonly manifestId: string;
    };
    readonly compatibility: {
      readonly status: 'unknown' | 'compatible' | 'incompatible';
      readonly minTaktVersion: string;
      readonly maxTaktVersion: string | null;
      readonly currentTaktVersion: string | null;
    };
    readonly source: ProjectTemplateCliSourceV1_1;
    readonly declaredCapabilities: readonly ProjectTemplateCliCapabilityV1_1[];
    readonly detectedCapabilities: readonly ProjectTemplateCliCapabilityV1_1[];
    readonly targets: ProjectTemplateCliCollectionV1_1<ProjectTemplateCliInspectTargetV1_1>;
    readonly capabilityWarnings:
      ProjectTemplateCliCollectionV1_1<ProjectTemplateCliCapabilityWarningV1_1>;
  };
}

export interface ProjectTemplateCliExportReasonV1_1 {
  readonly detailId: string;
  readonly manifestId: string;
  readonly classification: 'excluded' | 'blocked';
  readonly reason: string;
  readonly count: number;
  readonly paths: readonly string[];
}

export interface ProjectTemplateCliExportResultV1_1 {
  readonly planId: string;
  readonly entryCount: number;
  readonly archiveBytes: number;
  readonly dependencyCount: number;
  readonly readiness: 'ready' | 'review-required' | 'blocked' | 'recovery-required';
  readonly reviewCodes: readonly ProjectTemplateCliReviewCode[];
  readonly detail: {
    readonly manifestId: string;
    readonly securitySummary: {
      readonly counts: {
        readonly portable: number;
        readonly excluded: number;
        readonly blocked: number;
        readonly reviewRequired: number;
      };
      readonly reasons: ProjectTemplateCliCollectionV1_1<ProjectTemplateCliExportReasonV1_1>;
    };
  };
}

export interface ProjectTemplateCliPreviewResultV1_1 {
  readonly planId: string;
  readonly changeCount: number;
  readonly conflictCount: number;
  readonly dependencyCount: number;
  readonly readiness: 'ready' | 'review-required' | 'blocked' | 'recovery-required';
  readonly reviewCodes: readonly ProjectTemplateCliReviewCode[];
  readonly detail: {
    readonly manifestId: string;
    readonly source: ProjectTemplateCliSourceV1_1;
    readonly targetCount: number;
    readonly actionCounts: Readonly<Record<ProjectTemplateCliActionV1_1, number>>;
    readonly targets: ProjectTemplateCliCollectionV1_1<ProjectTemplateCliTargetV1_1>;
    readonly conflicts: ProjectTemplateCliCollectionV1_1<ProjectTemplateCliConflictV1_1>;
    readonly capabilityWarnings:
      ProjectTemplateCliCollectionV1_1<ProjectTemplateCliCapabilityWarningV1_1>;
  };
}

export type ProjectTemplateCliListResultV1_1 =
  | {
    readonly installed: false;
    readonly backupIds: readonly string[];
    readonly recoveryState: ProjectTemplateCliRecoveryState;
    readonly detail: { readonly source: null };
  }
  | {
    readonly installed: true;
    readonly targetId: string;
    readonly sourceProvenance: {
      readonly kind: 'local-import' | 'github';
      readonly sourceId: string;
      readonly revision: string;
      readonly version: string;
      readonly archiveId: string;
      readonly manifestId: string;
    };
    readonly backupIds: readonly string[];
    readonly recoveryState: ProjectTemplateCliRecoveryState;
    readonly detail: { readonly source: ProjectTemplateCliSourceV1_1 };
  };

export type ProjectTemplateCliV1_1Result =
  | ProjectTemplateCliInspectResultV1_1
  | ProjectTemplateCliExportResultV1_1
  | ProjectTemplateCliPreviewResultV1_1
  | ProjectTemplateCliListResultV1_1;

export type ProjectTemplateCliV1_1SuccessEnvelope =
  | ProjectTemplateCliV1_1CommandSuccessEnvelope<
    'project-template inspect', ProjectTemplateCliInspectResultV1_1
  >
  | ProjectTemplateCliV1_1CommandSuccessEnvelope<
    'project-template export', ProjectTemplateCliExportResultV1_1
  >
  | ProjectTemplateCliV1_1CommandSuccessEnvelope<
    'project-template diff', ProjectTemplateCliPreviewResultV1_1
  >
  | ProjectTemplateCliV1_1CommandSuccessEnvelope<
    'project-template apply', ProjectTemplateCliPreviewResultV1_1
  >
  | ProjectTemplateCliV1_1CommandSuccessEnvelope<
    'project-template list', ProjectTemplateCliListResultV1_1
  >;

export interface ProjectTemplateCliV1_1CommandSuccessEnvelope<
  Command extends Exclude<ProjectTemplateCliCommand, 'project-template'>,
  Result extends ProjectTemplateCliV1_1Result,
> {
  readonly schemaVersion: typeof PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1;
  readonly command: Command;
  readonly status: 'success';
  readonly mode: 'dry-run';
  readonly result: Result;
  readonly warnings: readonly ProjectTemplateCliWarning[];
}

export interface ProjectTemplateCliV1_1FailureEnvelope {
  readonly schemaVersion: typeof PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1;
  readonly command: ProjectTemplateCliCommand;
  readonly status: 'error';
  readonly mode: ProjectTemplateCliMode;
  readonly error: { readonly code: ProjectTemplateCliErrorCode };
  readonly warnings: readonly ProjectTemplateCliWarning[];
}

export type ProjectTemplateCliV1_1Envelope =
  | ProjectTemplateCliV1_1SuccessEnvelope
  | ProjectTemplateCliV1_1FailureEnvelope;

export interface ProjectTemplateCliV1_1Outcome {
  readonly envelope: ProjectTemplateCliV1_1Envelope;
  readonly exitCode: number;
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type RecordJson = Readonly<Record<string, Json>>;

// Why: this module is a trust boundary used by long-lived hosts. Capture every
// validation intrinsic before plugins can poison ambient prototypes, then call
// them through Reflect.apply so validation cannot be weakened after import.
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_OBJECT_KEYS = Object.keys;
const CAPTURED_OBJECT_HAS_OWN = Object.hasOwn;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_FROM_ENTRIES = Object.fromEntries;
const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_ARRAY_MAP = Array.prototype.map;
const CAPTURED_ARRAY_SOME = Array.prototype.some;
const CAPTURED_ARRAY_REDUCE = Array.prototype.reduce;
const CAPTURED_ARRAY_PUSH = Array.prototype.push;
const CAPTURED_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const CAPTURED_REGEXP_TEST = RegExp.prototype.test;
const CAPTURED_STRING_NORMALIZE = String.prototype.normalize;
const CAPTURED_SET = Set;
const CAPTURED_SET_HAS = Set.prototype.has;
const CAPTURED_SET_ADD = Set.prototype.add;
const CAPTURED_MAP = Map;
const CAPTURED_MAP_GET = Map.prototype.get;
const CAPTURED_MAP_SET = Map.prototype.set;

function apply<T>(fn: (...args: never[]) => T, receiver: unknown, args: unknown[]): T {
  return CAPTURED_REFLECT_APPLY(fn, receiver, args) as T;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return apply(CAPTURED_OBJECT_FREEZE, Object, [value]) as Readonly<T>;
}

function regexpTest(pattern: RegExp, value: string): boolean {
  return apply(CAPTURED_REGEXP_TEST, pattern, [value]);
}

function setHas<T>(set: ReadonlySet<T>, value: T): boolean {
  return apply(CAPTURED_SET_HAS, set, [value]);
}

function setAdd<T>(set: Set<T>, value: T): void {
  apply(CAPTURED_SET_ADD, set, [value]);
}

function mapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  apply(CAPTURED_MAP_SET, map, [key, value]);
}

const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_GITHUB_COMPONENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;
const SYMBOLIC = /^[A-Z][A-Z0-9_]{0,63}$/u;
const TOKEN = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u;
const PORTABLE_PATH = new RegExp(PROJECT_TEMPLATE_PATH_PATTERN_SOURCE, 'u');
const CAPABILITIES = new CAPTURED_SET<ProjectTemplateCliCapabilityV1_1>([
  'executable', 'github-write', 'external-command',
]);
const ACTIONS = new CAPTURED_SET<ProjectTemplateCliActionV1_1>([
  'add', 'update', 'keep', 'delete', 'conflict', 'excluded',
]);
const POLICIES = new CAPTURED_SET(['managed', 'merge', 'scaffold', 'excluded']);
const WARNING_CODES = new CAPTURED_SET([
  'DEPRECATED_SOURCE', 'PARTIAL_RESULT', 'RECOVERY_AVAILABLE',
  'REVIEW_REQUIRED', 'UPDATE_AVAILABLE',
]);
const REVIEW_CODES = new CAPTURED_SET<ProjectTemplateCliReviewCode>([
  'ACTIVE_RUN', 'DEPENDENCY_CONFLICT', 'HARD_CONFLICT', 'RECOVERY_REQUIRED',
  'REVIEW_REQUIRED', 'SOURCE_DRIFT', 'TARGET_DRIFT',
]);
const CLASSIFICATION_REASONS = new CAPTURED_SET<string>(PROJECT_TEMPLATE_CLASSIFICATION_REASONS);
const COMMANDS = new CAPTURED_SET<ProjectTemplateCliCommand>([
  'project-template', 'project-template export', 'project-template inspect',
  'project-template diff', 'project-template apply', 'project-template update',
  'project-template rollback', 'project-template list',
]);

function invalid(): never {
  throw new ProjectTemplateCliContractError(
    'PROTOCOL_ERROR',
    'machine value does not match the closed schema 1.1 contract',
  );
}

function record(value: Json | undefined): RecordJson {
  if (value === null || value === undefined
    || apply(CAPTURED_ARRAY_IS_ARRAY, Array, [value]) || typeof value !== 'object') invalid();
  return value as RecordJson;
}

function exact(value: Json | undefined, keys: readonly string[]): RecordJson {
  const result = record(value);
  const actual = apply(CAPTURED_OBJECT_KEYS, Object, [result]) as string[];
  if (actual.length !== keys.length) invalid();
  const closed = apply(CAPTURED_OBJECT_CREATE, Object, [null]) as Record<string, Json>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (!apply(CAPTURED_OBJECT_HAS_OWN, Object, [result, key])) invalid();
    closed[key] = result[key]!;
  }
  return freeze(closed);
}

function count(value: Json | undefined, maximum = 8_192): number {
  if (typeof value !== 'number'
    || !apply(CAPTURED_NUMBER_IS_SAFE_INTEGER, Number, [value])
    || value < 0 || value > maximum) invalid();
  return value;
}

function hash(value: Json | undefined): string {
  if (typeof value !== 'string' || !regexpTest(HASH, value)) invalid();
  return value;
}

function commit(value: Json | undefined): string {
  if (typeof value !== 'string' || !regexpTest(COMMIT, value)) invalid();
  return value;
}

function safeString(value: Json | undefined, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0
    || value.length > maximum || regexpTest(TOKEN, value)) invalid();
  return value;
}

function nullableSafeString(value: Json | undefined, maximum: number): string | null {
  if (value === null) return null;
  return safeString(value, maximum);
}

function portablePath(value: Json | undefined): string {
  if (typeof value !== 'string' || value.length === 0
    || value.length > MAX_TEMPLATE_PATH_LENGTH
    || apply(CAPTURED_STRING_NORMALIZE, value, ['NFC']) !== value
    || !regexpTest(PORTABLE_PATH, value)
    || regexpTest(TOKEN, value)) invalid();
  return value;
}

function array(value: Json | undefined, maximum: number): readonly Json[] {
  if (!apply(CAPTURED_ARRAY_IS_ARRAY, Array, [value])) invalid();
  const values = value as readonly Json[];
  if (values.length > maximum) invalid();
  return values;
}

function uniqueStrings<T extends string>(
  value: Json | undefined,
  allowed: ReadonlySet<T>,
  maximum: number,
): readonly T[] {
  const values = array(value, maximum);
  const result: T[] = [];
  const seen = new CAPTURED_SET<T>();
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index]!;
    if (typeof item !== 'string' || !setHas(allowed, item as T)
      || setHas(seen, item as T)) invalid();
    setAdd(seen, item as T);
    apply(CAPTURED_ARRAY_PUSH, result, [item as T]);
  }
  return result;
}

function warnings(value: Json | undefined): readonly ProjectTemplateCliWarning[] {
  const values = array(value, 10);
  const seen = new CAPTURED_SET<string>();
  return apply(CAPTURED_ARRAY_MAP, values, [(item: Json) => {
    const warning = exact(item, ['code']);
    const code = warning.code;
    if (typeof code !== 'string' || !setHas(WARNING_CODES, code) || setHas(seen, code)) invalid();
    setAdd(seen, code);
    return { code } as ProjectTemplateCliWarning;
  }]) as readonly ProjectTemplateCliWarning[];
}

function reviewSummary(result: RecordJson): void {
  if (result.readiness !== 'ready' && result.readiness !== 'review-required'
    && result.readiness !== 'blocked' && result.readiness !== 'recovery-required') invalid();
  const codes = uniqueStrings(result.reviewCodes, REVIEW_CODES, 32);
  if ((result.readiness === 'ready') !== (codes.length === 0)) invalid();
}

function source(value: Json | undefined): ProjectTemplateCliSourceV1_1 {
  const raw = record(value);
  if (raw.kind === 'local-import') {
    const local = exact(raw, ['kind', 'sourceId', 'revision', 'archiveId', 'manifestId']);
    return {
      kind: 'local-import', sourceId: hash(local.sourceId), revision: commit(local.revision),
      archiveId: hash(local.archiveId), manifestId: hash(local.manifestId),
    };
  }
  if (raw.kind !== 'github') invalid();
  const github = exact(raw, [
    'kind', 'sourceId', 'owner', 'repo', 'requestedRef', 'resolvedCommit',
    'releaseTag', 'assetName', 'archiveId', 'manifestId',
  ]);
  const owner = safeString(github.owner, 100);
  const repo = safeString(github.repo, 100);
  if (!regexpTest(SAFE_GITHUB_COMPONENT, owner)
    || !regexpTest(SAFE_GITHUB_COMPONENT, repo)) invalid();
  return {
    kind: 'github', sourceId: hash(github.sourceId), owner, repo,
    requestedRef: safeString(github.requestedRef, 256),
    resolvedCommit: commit(github.resolvedCommit),
    releaseTag: nullableSafeString(github.releaseTag, 256),
    assetName: nullableSafeString(github.assetName, 255),
    archiveId: hash(github.archiveId), manifestId: hash(github.manifestId),
  };
}

function collection(
  value: Json | undefined,
  validate: (item: Json) => Readonly<Record<string, unknown>>,
  totalMaximum = 4_096,
): { items: readonly Readonly<Record<string, unknown>>[]; totalCount: number; truncated: boolean } {
  const raw = exact(value, ['items', 'totalCount', 'truncated']);
  const items = apply(
    CAPTURED_ARRAY_MAP,
    array(raw.items, MAX_PROJECT_TEMPLATE_CLI_DETAIL_ITEMS_V1_1),
    [validate],
  ) as readonly Readonly<Record<string, unknown>>[];
  const totalCount = count(raw.totalCount, totalMaximum);
  if (typeof raw.truncated !== 'boolean' || totalCount < items.length
    || raw.truncated !== (totalCount > items.length)) invalid();
  return { items, totalCount, truncated: raw.truncated };
}

function inspectTarget(value: Json): Readonly<Record<string, unknown>> {
  const item = exact(value, ['targetId', 'manifestId', 'path', 'policy', 'capabilities']);
  if (typeof item.policy !== 'string' || !setHas(POLICIES, item.policy)) invalid();
  return {
    targetId: hash(item.targetId), manifestId: hash(item.manifestId), path: portablePath(item.path),
    policy: item.policy,
    capabilities: uniqueStrings(item.capabilities, CAPABILITIES, 3),
  };
}

function previewTarget(value: Json): Readonly<Record<string, unknown>> {
  const item = exact(value, [
    'itemId', 'targetId', 'manifestId', 'path', 'policy', 'action', 'reason',
    'reviewRequired', 'capabilitiesBefore', 'capabilitiesAfter',
  ]);
  if (typeof item.policy !== 'string' || !setHas(POLICIES, item.policy)
    || typeof item.action !== 'string'
    || !setHas(ACTIONS, item.action as ProjectTemplateCliActionV1_1)
    || typeof item.reason !== 'string' || !regexpTest(SYMBOLIC, item.reason)
    || typeof item.reviewRequired !== 'boolean') invalid();
  if ((item.policy === 'excluded') !== (item.action === 'excluded')) invalid();
  if (item.policy === 'scaffold'
    && item.action !== 'add' && item.action !== 'keep' && item.action !== 'conflict') invalid();
  return {
    itemId: hash(item.itemId), targetId: hash(item.targetId), manifestId: hash(item.manifestId),
    path: portablePath(item.path), policy: item.policy, action: item.action, reason: item.reason,
    reviewRequired: item.reviewRequired,
    capabilitiesBefore: uniqueStrings(item.capabilitiesBefore, CAPABILITIES, 3),
    capabilitiesAfter: uniqueStrings(item.capabilitiesAfter, CAPABILITIES, 3),
  };
}

function conflict(value: Json): Readonly<Record<string, unknown>> {
  const item = exact(value, [
    'conflictId', 'targetId', 'manifestId', 'path', 'reason',
    'safeDefaultAction', 'allowedActions',
  ]);
  const actions = array(item.allowedActions, 1);
  if (item.safeDefaultAction !== 'abort' || actions.length !== 1 || actions[0] !== 'abort'
    || typeof item.reason !== 'string' || !regexpTest(SYMBOLIC, item.reason)) invalid();
  return {
    conflictId: hash(item.conflictId), targetId: hash(item.targetId),
    manifestId: hash(item.manifestId), path: portablePath(item.path), reason: item.reason,
    safeDefaultAction: 'abort', allowedActions: ['abort'],
  };
}

function capabilityWarning(value: Json): Readonly<Record<string, unknown>> {
  const item = exact(value, [
    'warningId', 'targetId', 'manifestId', 'path', 'capability',
  ]);
  if (typeof item.capability !== 'string'
    || !setHas(CAPABILITIES, item.capability as ProjectTemplateCliCapabilityV1_1)) invalid();
  return {
    warningId: hash(item.warningId), targetId: hash(item.targetId),
    manifestId: hash(item.manifestId), path: portablePath(item.path), capability: item.capability,
  };
}

function assertUnique(items: readonly Readonly<Record<string, unknown>>[], key: string): void {
  const seen = new CAPTURED_SET<unknown>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const identity = item[key];
    if (setHas(seen, identity)) invalid();
    setAdd(seen, identity);
  }
}

function assertPartialWarning(
  rootWarnings: readonly ProjectTemplateCliWarning[],
  collections: readonly { truncated: boolean }[],
): void {
  const partial = apply(CAPTURED_ARRAY_SOME, collections, [
    ({ truncated }: { readonly truncated: boolean }) => truncated,
  ]);
  const hasPartialWarning = apply(CAPTURED_ARRAY_SOME, rootWarnings, [
    ({ code }: ProjectTemplateCliWarning) => code === 'PARTIAL_RESULT',
  ]);
  if (partial !== hasPartialWarning) invalid();
}

function validateInspect(result: RecordJson, rootWarnings: readonly ProjectTemplateCliWarning[]): void {
  const raw = exact(result, [
    'packId', 'entryCount', 'archiveBytes', 'dependencyCount', 'readiness', 'reviewCodes', 'detail',
  ]);
  reviewSummary(raw);
  const detail = exact(raw.detail, [
    'identity', 'compatibility', 'source', 'declaredCapabilities',
    'detectedCapabilities', 'targets', 'capabilityWarnings',
  ]);
  const identity = exact(detail.identity, ['packFormatVersion', 'packVersion', 'archiveId', 'manifestId']);
  if (identity.packFormatVersion !== '1.0') invalid();
  safeString(identity.packVersion, 128);
  const archiveId = hash(identity.archiveId);
  const manifestId = hash(identity.manifestId);
  if (hash(raw.packId) !== archiveId) invalid();
  count(raw.entryCount, 4_096); count(raw.archiveBytes, 40 * 1024 * 1024); count(raw.dependencyCount, 128);
  const compatibility = exact(detail.compatibility, [
    'status', 'minTaktVersion', 'maxTaktVersion', 'currentTaktVersion',
  ]);
  if (compatibility.status !== 'unknown' && compatibility.status !== 'compatible'
    && compatibility.status !== 'incompatible') invalid();
  safeString(compatibility.minTaktVersion, 128);
  nullableSafeString(compatibility.maxTaktVersion, 128);
  nullableSafeString(compatibility.currentTaktVersion, 128);
  const provenance = source(detail.source);
  if (provenance.archiveId !== archiveId || provenance.manifestId !== manifestId) invalid();
  uniqueStrings(detail.declaredCapabilities, CAPABILITIES, 3);
  uniqueStrings(detail.detectedCapabilities, CAPABILITIES, 3);
  const targets = collection(detail.targets, inspectTarget);
  const capabilityWarnings = collection(
    detail.capabilityWarnings,
    capabilityWarning,
    MAX_PROJECT_TEMPLATE_CLI_CAPABILITY_WARNING_TOTAL_V1_1,
  );
  if (targets.totalCount !== raw.entryCount) invalid();
  assertUnique(targets.items, 'targetId'); assertUnique(targets.items, 'path');
  const targetIds = new CAPTURED_SET<unknown>();
  for (let index = 0; index < targets.items.length; index += 1) {
    setAdd(targetIds, targets.items[index]!.targetId);
  }
  for (let index = 0; index < targets.items.length; index += 1) {
    const item = targets.items[index]!;
    if (item.manifestId !== manifestId) invalid();
  }
  for (let index = 0; index < capabilityWarnings.items.length; index += 1) {
    const item = capabilityWarnings.items[index]!;
    if (item.manifestId !== manifestId) invalid();
    if (!setHas(targetIds, item.targetId)) invalid();
  }
  assertUnique(capabilityWarnings.items, 'warningId');
  assertPartialWarning(rootWarnings, [targets, capabilityWarnings]);
}

function validateExport(result: RecordJson, rootWarnings: readonly ProjectTemplateCliWarning[]): void {
  const raw = exact(result, [
    'planId', 'entryCount', 'archiveBytes', 'dependencyCount', 'readiness', 'reviewCodes', 'detail',
  ]);
  hash(raw.planId); count(raw.entryCount, 4_096); count(raw.archiveBytes, 40 * 1024 * 1024);
  count(raw.dependencyCount, 128); reviewSummary(raw);
  const detail = exact(raw.detail, ['manifestId', 'securitySummary']);
  const manifestId = hash(detail.manifestId);
  const summary = exact(detail.securitySummary, ['counts', 'reasons']);
  const counts = exact(summary.counts, ['portable', 'excluded', 'blocked', 'reviewRequired']);
  const portable = count(counts.portable, 4_096);
  const excluded = count(counts.excluded, 8_193);
  const blocked = count(counts.blocked, 8_193);
  count(counts.reviewRequired, 4_096);
  if (portable !== raw.entryCount || (blocked > 0 && raw.readiness !== 'blocked')) invalid();
  const reasons = collection(summary.reasons, (value) => {
    const item = exact(value, [
      'detailId', 'manifestId', 'classification', 'reason', 'count', 'paths',
    ]);
    if (item.classification !== 'excluded' && item.classification !== 'blocked') invalid();
    if (typeof item.reason !== 'string' || !setHas(CLASSIFICATION_REASONS, item.reason)) invalid();
    return {
      detailId: hash(item.detailId), manifestId: hash(item.manifestId),
      classification: item.classification, reason: item.reason, count: count(item.count, 8_193),
      paths: apply(CAPTURED_ARRAY_MAP, array(item.paths, 8), [portablePath]),
    };
  }, 8_193);
  const reportedReasons = apply(CAPTURED_ARRAY_REDUCE, reasons.items, [
    (sum: number, item: Readonly<Record<string, unknown>>) => sum + (item.count as number),
    0,
  ]) as number;
  if (!reasons.truncated && reportedReasons !== excluded + blocked) invalid();
  for (let index = 0; index < reasons.items.length; index += 1) {
    if (reasons.items[index]!.manifestId !== manifestId) invalid();
  }
  assertUnique(reasons.items, 'detailId');
  assertPartialWarning(rootWarnings, [reasons]);
}

function validatePreview(result: RecordJson, rootWarnings: readonly ProjectTemplateCliWarning[]): void {
  const raw = exact(result, [
    'planId', 'changeCount', 'conflictCount', 'dependencyCount', 'readiness', 'reviewCodes', 'detail',
  ]);
  hash(raw.planId); const changeCount = count(raw.changeCount); const conflictCount = count(raw.conflictCount);
  count(raw.dependencyCount, 128); reviewSummary(raw);
  const detail = exact(raw.detail, [
    'manifestId', 'source', 'targetCount', 'actionCounts',
    'targets', 'conflicts', 'capabilityWarnings',
  ]);
  const manifestId = hash(detail.manifestId);
  const provenance = source(detail.source);
  if (provenance.manifestId !== manifestId) invalid();
  const targetCount = count(detail.targetCount, 4_096);
  const actionCounts = exact(detail.actionCounts, ACTION_ORDER);
  const countEntries = apply(CAPTURED_ARRAY_MAP, ACTION_ORDER, [
    (action: ProjectTemplateCliActionV1_1) => [action, count(actionCounts[action], 4_096)],
  ]) as [ProjectTemplateCliActionV1_1, number][];
  const counts = apply(CAPTURED_OBJECT_FROM_ENTRIES, Object, [countEntries]) as Record<
  ProjectTemplateCliActionV1_1, number
  >;
  const countedTargets = apply(CAPTURED_ARRAY_REDUCE, ACTION_ORDER, [
    (sum: number, action: ProjectTemplateCliActionV1_1) => sum + counts[action],
    0,
  ]) as number;
  if (countedTargets !== targetCount
    || counts.conflict !== conflictCount
    || counts.add! + counts.update! + counts.delete! !== changeCount) invalid();
  const targets = collection(detail.targets, previewTarget);
  const conflicts = collection(detail.conflicts, conflict);
  const capabilityWarnings = collection(
    detail.capabilityWarnings,
    capabilityWarning,
    MAX_PROJECT_TEMPLATE_CLI_CAPABILITY_WARNING_TOTAL_V1_1,
  );
  if (targets.totalCount !== targetCount || conflicts.totalCount !== conflictCount) invalid();
  assertUnique(targets.items, 'itemId'); assertUnique(targets.items, 'targetId'); assertUnique(targets.items, 'path');
  assertUnique(conflicts.items, 'conflictId'); assertUnique(capabilityWarnings.items, 'warningId');
  const byTarget = new CAPTURED_MAP<unknown, Readonly<Record<string, unknown>>>();
  for (let index = 0; index < targets.items.length; index += 1) {
    const item = targets.items[index]!;
    mapSet(byTarget, item.targetId, item);
  }
  const emittedCountEntries = apply(CAPTURED_ARRAY_MAP, ACTION_ORDER, [
    (action: ProjectTemplateCliActionV1_1) => [action, 0],
  ]) as [ProjectTemplateCliActionV1_1, number][];
  const emittedCounts = apply(
    CAPTURED_OBJECT_FROM_ENTRIES,
    Object,
    [emittedCountEntries],
  ) as Record<ProjectTemplateCliActionV1_1, number>;
  for (let index = 0; index < targets.items.length; index += 1) {
    const item = targets.items[index]!;
    if (item.manifestId !== manifestId) invalid();
    emittedCounts[item.action as ProjectTemplateCliActionV1_1] += 1;
  }
  if (!targets.truncated && apply(CAPTURED_ARRAY_SOME, ACTION_ORDER, [
    (action: ProjectTemplateCliActionV1_1) => emittedCounts[action] !== counts[action],
  ])) invalid();
  for (let index = 0; index < conflicts.items.length; index += 1) {
    const item = conflicts.items[index]!;
    const target = apply(CAPTURED_MAP_GET, byTarget, [item.targetId]);
    if (item.manifestId !== manifestId || target === undefined || target.path !== item.path
      || target.action !== 'conflict' || target.reason !== item.reason) invalid();
  }
  for (let index = 0; index < capabilityWarnings.items.length; index += 1) {
    const item = capabilityWarnings.items[index]!;
    const target = apply(CAPTURED_MAP_GET, byTarget, [item.targetId]);
    if (item.manifestId !== manifestId || target === undefined || target.path !== item.path) invalid();
  }
  assertPartialWarning(rootWarnings, [targets, conflicts, capabilityWarnings]);
}

const ACTION_ORDER = Object.freeze([
  'add', 'update', 'keep', 'delete', 'conflict', 'excluded',
] as const satisfies readonly ProjectTemplateCliActionV1_1[]);

function validateList(result: RecordJson): void {
  if (result.installed === false) {
    const raw = exact(result, ['installed', 'backupIds', 'recoveryState', 'detail']);
    const detail = exact(raw.detail, ['source']);
    if (detail.source !== null) invalid();
    backupIds(raw.backupIds); recoveryState(raw.recoveryState);
    return;
  }
  const raw = exact(result, [
    'installed', 'targetId', 'sourceProvenance', 'backupIds', 'recoveryState', 'detail',
  ]);
  if (raw.installed !== true) invalid();
  const targetId = hash(raw.targetId);
  const legacy = exact(raw.sourceProvenance, [
    'kind', 'sourceId', 'revision', 'version', 'archiveId', 'manifestId',
  ]);
  if (legacy.kind !== 'local-import' && legacy.kind !== 'github') invalid();
  hash(legacy.sourceId); commit(legacy.revision); safeString(legacy.version, 128);
  hash(legacy.archiveId); if (hash(legacy.manifestId) !== targetId) invalid();
  const detail = exact(raw.detail, ['source']);
  const provenance = source(detail.source);
  if (provenance.manifestId !== targetId || provenance.sourceId !== legacy.sourceId
    || provenance.archiveId !== legacy.archiveId) invalid();
  backupIds(raw.backupIds); recoveryState(raw.recoveryState);
}

function backupIds(value: Json | undefined): void {
  const values = array(value, 32);
  const seen = new CAPTURED_SET<string>();
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index]!;
    if (typeof item !== 'string' || !regexpTest(SAFE_ID, item)
      || regexpTest(TOKEN, item) || setHas(seen, item)) invalid();
    setAdd(seen, item);
  }
}

function recoveryState(value: Json | undefined): asserts value is ProjectTemplateCliRecoveryState {
  if (value !== 'clean' && value !== 'recovery-required') invalid();
}

function snapshot(value: unknown): Json {
  try {
    return snapshotProjectTemplateCliJson(value) as Json;
  } catch (error) {
    if (error instanceof ProjectTemplateCliContractError) throw error;
    return invalid();
  }
}

export function snapshotProjectTemplateCliV1_1Envelope(value: unknown): ProjectTemplateCliV1_1Envelope {
  const root = record(snapshot(value));
  if (root.schemaVersion !== PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1
    || typeof root.command !== 'string'
    || !setHas(COMMANDS, root.command as ProjectTemplateCliCommand)
    || (root.mode !== 'dry-run' && root.mode !== 'apply')
    || (root.status !== 'success' && root.status !== 'error')) invalid();
  const command = root.command as ProjectTemplateCliCommand;
  const mode = root.mode;
  const rootWarnings = warnings(root.warnings);
  if (root.status === 'error') {
    const failure = exact(root, ['schemaVersion', 'command', 'status', 'mode', 'error', 'warnings']);
    const error = exact(failure.error, ['code']);
    if (typeof error.code !== 'string'
      || !apply(CAPTURED_OBJECT_HAS_OWN, Object, [
        PROJECT_TEMPLATE_CLI_ERROR_EXIT_CODES,
        error.code,
      ])) invalid();
    // Rebuild from the closed field set so even a future validator regression
    // cannot accidentally return an unknown caller-owned root property.
    return snapshot({
      schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1,
      command,
      status: 'error',
      mode,
      error: { code: error.code },
      warnings: rootWarnings,
    }) as unknown as ProjectTemplateCliV1_1FailureEnvelope;
  }
  exact(root, ['schemaVersion', 'command', 'status', 'mode', 'result', 'warnings']);
  if (command === 'project-template' || mode !== 'dry-run') invalid();
  const result = record(root.result);
  if (command === 'project-template inspect') validateInspect(result, rootWarnings);
  else if (command === 'project-template export') validateExport(result, rootWarnings);
  else if (command === 'project-template diff' || command === 'project-template apply') {
    validatePreview(result, rootWarnings);
  } else if (command === 'project-template list') validateList(result);
  else invalid();
  return snapshot({
    schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1,
    command,
    status: 'success',
    mode: 'dry-run',
    result: root.result,
    warnings: rootWarnings,
  }) as unknown as ProjectTemplateCliV1_1SuccessEnvelope;
}

export function createProjectTemplateCliV1_1Success(value: unknown): ProjectTemplateCliV1_1SuccessEnvelope {
  const envelope = snapshotProjectTemplateCliV1_1Envelope(value);
  if (envelope.status !== 'success') invalid();
  return envelope;
}

export function createProjectTemplateCliV1_1Failure(value: unknown): ProjectTemplateCliV1_1FailureEnvelope {
  const envelope = snapshotProjectTemplateCliV1_1Envelope(value);
  if (envelope.status !== 'error') invalid();
  return envelope;
}

export function createProjectTemplateCliV1_1FailureFor(input: {
  readonly command: ProjectTemplateCliCommand;
  readonly mode: ProjectTemplateCliMode;
  readonly code: ProjectTemplateCliErrorCode;
  readonly warnings?: readonly ProjectTemplateCliWarning[];
}): ProjectTemplateCliV1_1FailureEnvelope {
  return createProjectTemplateCliV1_1Failure({
    schemaVersion: PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1,
    command: input.command,
    status: 'error',
    mode: input.mode,
    error: { code: input.code },
    warnings: input.warnings ?? [],
  });
}

export function snapshotProjectTemplateCliV1_1Outcome(value: unknown): ProjectTemplateCliV1_1Outcome {
  const raw = exact(snapshot(value), ['envelope', 'exitCode']);
  const envelope = snapshotProjectTemplateCliV1_1Envelope(raw.envelope);
  const expected = envelope.status === 'success'
    ? 0
    : PROJECT_TEMPLATE_CLI_ERROR_EXIT_CODES[envelope.error.code];
  if (raw.exitCode !== expected) invalid();
  return { envelope, exitCode: expected };
}

export function parseProjectTemplateCliV1_1EnvelopeJson(text: unknown): ProjectTemplateCliV1_1Envelope {
  return snapshotProjectTemplateCliV1_1Envelope(parseProjectTemplateCliJson(text));
}

export function presentProjectTemplateCliV1_1Envelope(envelope: ProjectTemplateCliV1_1Envelope): string {
  return serializeProjectTemplateCliJson(snapshotProjectTemplateCliV1_1Envelope(envelope));
}

export async function writeProjectTemplateCliV1_1Outcome(
  outcome: ProjectTemplateCliV1_1Outcome,
  write: (chunk: string) => void | Promise<void>,
): Promise<void> {
  const validated = snapshotProjectTemplateCliV1_1Outcome(outcome);
  await write(serializeProjectTemplateCliJson(validated.envelope));
}
