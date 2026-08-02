import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  MAX_TEMPLATE_ENTRIES,
  MAX_TEMPLATE_PATH_LENGTH,
  PROJECT_TEMPLATE_PATH_PATTERN_SOURCE,
} from './validation.js';
import type {
  ProjectTemplateApplyAction,
  ProjectTemplateApplyReasonCode,
} from './apply-plan-types.js';
import type { TemplateCapability, TemplateEntryPolicy } from './types.js';

export const MAX_PROJECT_TEMPLATE_CLI_REVIEW_ITEMS_V1_1 = 256;

const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PUSH = Array.prototype.push;
const ARRAY_SORT = Array.prototype.sort;
const ARRAY_SLICE = Array.prototype.slice;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const REGEXP_TEST = RegExp.prototype.test;
const STRING_NORMALIZE = String.prototype.normalize;
const TYPES_IS_PROXY = types.isProxy;
const CAPTURED_SET = Set;
const SET_HAS = Set.prototype.has;
const SET_ADD = Set.prototype.add;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const HASH_SAMPLE = createHash('sha256');
const HASH_UPDATE = HASH_SAMPLE.update;
const HASH_DIGEST = HASH_SAMPLE.digest;

function apply<T>(fn: (...args: never[]) => T, receiver: unknown, args: unknown[]): T {
  return REFLECT_APPLY(fn, receiver, args) as T;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return apply(OBJECT_FREEZE, Object, [value]) as Readonly<T>;
}

function push<T>(target: T[], value: T): void {
  apply(ARRAY_PUSH, target, [value]);
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const PORTABLE_PATH_PATTERN = new RegExp(PROJECT_TEMPLATE_PATH_PATTERN_SOURCE, 'u');
const TOKEN_PATTERN = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u;
const POLICIES = new CAPTURED_SET<TemplateEntryPolicy>([
  'managed', 'merge', 'scaffold', 'excluded',
]);
const ACTIONS = new CAPTURED_SET<ProjectTemplateApplyAction>([
  'add', 'update', 'keep', 'delete', 'conflict', 'excluded',
]);
const REASONS = new CAPTURED_SET<ProjectTemplateApplyReasonCode>([
  'UPSTREAM_CHANGED',
  'LOCAL_CHANGED',
  'BOTH_CHANGED',
  'SEMANTIC_MERGE_REQUIRED',
  'SEMANTIC_MERGED',
  'CONFLICT',
  'BASE_UNAVAILABLE',
  'ALREADY_CURRENT',
  'UNCHANGED',
  'NEW_ENTRY',
  'DESTINATION_EXISTS',
  'LOCAL_UNCHANGED_TEMPLATE_DELETED',
  'LOCAL_CHANGED_TEMPLATE_DELETED',
  'ALREADY_ABSENT',
  'SCAFFOLD_MISSING',
  'SCAFFOLD_PRESERVED',
  'POLICY_EXCLUDED',
  'LEGACY_BASELINE_REQUIRED',
  'BASELINE_ADOPTED',
  'POLICY_CHANGED',
  'RENAME_DETECTED',
  'AMBIGUOUS_RENAME',
  'CASE_ONLY_RENAME',
  'DESTINATION_CASE_COLLISION',
  'DESTINATION_PATH_COLLISION',
  'LOCAL_DELETED',
  'LOCAL_DELETED_UPSTREAM_CHANGED',
]);
const CAPABILITY_ORDER = [
  'executable', 'github-write', 'external-command',
] as const satisfies readonly TemplateCapability[];
const CAPABILITIES = new CAPTURED_SET<TemplateCapability>(CAPABILITY_ORDER);

export interface ProjectTemplateCliReviewItemInputV1_1 {
  readonly path: string;
  readonly policy: TemplateEntryPolicy;
  readonly action: ProjectTemplateApplyAction;
  readonly reason: ProjectTemplateApplyReasonCode;
  readonly reviewRequired: boolean;
  readonly capabilities: readonly TemplateCapability[];
}

export interface ProjectTemplateCliReviewProjectionInputV1_1 {
  readonly manifestId: string;
  readonly items: readonly ProjectTemplateCliReviewItemInputV1_1[];
}

export interface ProjectTemplateCliReviewItemV1_1
  extends ProjectTemplateCliReviewItemInputV1_1 {
  readonly id: string;
  readonly targetId: string;
}

export interface ProjectTemplateCliReviewConflictV1_1 {
  readonly id: string;
  readonly targetId: string;
  readonly path: string;
  readonly reason: ProjectTemplateApplyReasonCode;
  readonly safeDefaultAction: 'abort';
  readonly allowedActions: readonly ['abort'];
}

export interface ProjectTemplateCliCapabilityWarningV1_1 {
  readonly id: string;
  readonly targetId: string;
  readonly capability: TemplateCapability;
}

export interface ProjectTemplateCliReviewProjectionV1_1 {
  readonly items: readonly ProjectTemplateCliReviewItemV1_1[];
  readonly conflicts: readonly ProjectTemplateCliReviewConflictV1_1[];
  readonly warnings: readonly ProjectTemplateCliCapabilityWarningV1_1[];
  readonly summary: {
    readonly totalItems: number;
    readonly emittedItems: number;
    readonly omittedItems: number;
    readonly totalConflicts: number;
    readonly emittedConflicts: number;
    readonly omittedConflicts: number;
    readonly totalWarnings: number;
    readonly emittedWarnings: number;
    readonly omittedWarnings: number;
    readonly truncated: boolean;
  };
}

type JsonRecord = Readonly<Record<string, unknown>>;

function exactRecord(value: unknown, keys: readonly string[], field: string): JsonRecord {
  if (typeof value !== 'object'
    || value === null
    || apply(TYPES_IS_PROXY, types, [value])
    || apply(ARRAY_IS_ARRAY, Array, [value])) {
    throw new TypeError(`${field} must be an exact object`);
  }
  const prototype = apply(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be an exact object`);
  }
  const descriptors = apply(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    Object,
    [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const actual = apply(REFLECT_OWN_KEYS, Reflect, [descriptors]) as PropertyKey[];
  if (actual.length !== keys.length) {
    throw new TypeError(`${field} contains unknown or missing keys`);
  }
  for (const key of actual) {
    let allowed = false;
    for (const expected of keys) {
      if (key === expected) allowed = true;
    }
    if (!allowed) throw new TypeError(`${field} contains unknown or missing keys`);
  }
  const snapshot = apply(OBJECT_CREATE, Object, [null]) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${field}.${key} must be enumerable own data`);
    }
    snapshot[key] = descriptor.value;
  }
  return freeze(snapshot);
}

function denseArray(value: unknown, maximum: number, field: string): readonly unknown[] {
  if (typeof value !== 'object'
    || value === null
    || apply(TYPES_IS_PROXY, types, [value])
    || !apply(ARRAY_IS_ARRAY, Array, [value])
    || apply(OBJECT_GET_PROTOTYPE_OF, Object, [value]) !== Array.prototype) {
    throw new TypeError(`${field} must be a dense plain array`);
  }
  const length = apply(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    Object,
    [value, 'length'],
  )?.value as unknown;
  if (!apply(NUMBER_IS_SAFE_INTEGER, Number, [length])
    || (length as number) < 0
    || (length as number) > maximum) {
    throw new TypeError(`${field} exceeds its item limit`);
  }
  const keys = apply(REFLECT_OWN_KEYS, Reflect, [value]) as PropertyKey[];
  if (keys.length !== (length as number) + 1) throw new TypeError(`${field} must be dense`);
  const snapshot: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = apply(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      Object,
      [value, String(index)],
    ) as PropertyDescriptor | undefined;
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${field}[${index}] must be enumerable own data`);
    }
    push(snapshot, descriptor.value);
  }
  return freeze(snapshot);
}

function stableId(domain: string, fields: readonly string[]): string {
  const hash = createHash('sha256');
  apply(HASH_UPDATE, hash, [`${domain}\0`]);
  for (const field of fields) {
    // Why: length framing prevents different field boundaries from producing
    // the same identity without admitting an internal plan or authority token.
    const bytes = apply(BUFFER_BYTE_LENGTH, Buffer, [field, 'utf8']);
    apply(HASH_UPDATE, hash, [`${bytes}:`]);
    apply(HASH_UPDATE, hash, [field]);
  }
  return apply(HASH_DIGEST, hash, ['hex']) as string;
}

function validatePolicyAction(
  policy: TemplateEntryPolicy,
  action: ProjectTemplateApplyAction,
  field: string,
): void {
  const valid = policy === 'excluded'
    ? action === 'excluded'
    : policy === 'scaffold'
      ? action === 'add' || action === 'keep' || action === 'conflict'
      : action !== 'excluded';
  if (!valid) throw new TypeError(`${field} has an invalid policy/action pair`);
}

function parseCapabilities(value: unknown, field: string): readonly TemplateCapability[] {
  const values = denseArray(value, CAPABILITIES.size, field);
  const seen = new CAPTURED_SET<TemplateCapability>();
  for (let index = 0; index < values.length; index += 1) {
    const capability = values[index];
    if (typeof capability !== 'string'
      || !apply(SET_HAS, CAPABILITIES, [capability as TemplateCapability])
      || apply(SET_HAS, seen, [capability as TemplateCapability])) {
      throw new TypeError(`${field} contains an unknown or duplicate capability`);
    }
    apply(SET_ADD, seen, [capability as TemplateCapability]);
  }
  const capabilities: TemplateCapability[] = [];
  for (const capability of CAPABILITY_ORDER) {
    if (apply(SET_HAS, seen, [capability])) push(capabilities, capability);
  }
  return freeze(capabilities);
}

function parseItem(value: unknown, index: number): ProjectTemplateCliReviewItemInputV1_1 {
  const field = `items[${index}]`;
  const record = exactRecord(value, [
    'path', 'policy', 'action', 'reason', 'reviewRequired', 'capabilities',
  ], field);
  const path = record['path'];
  if (typeof path !== 'string'
    || path.length === 0
    || path.length > MAX_TEMPLATE_PATH_LENGTH
    || apply(STRING_NORMALIZE, path, ['NFC']) !== path
    || !apply(REGEXP_TEST, PORTABLE_PATH_PATTERN, [path])) {
    throw new TypeError(`${field}.path must be a portable relative path`);
  }
  if (apply(REGEXP_TEST, TOKEN_PATTERN, [path])) {
    throw new TypeError(`${field}.path contains credential material`);
  }
  const policy = record['policy'];
  const action = record['action'];
  const reason = record['reason'];
  if (typeof policy !== 'string'
    || !apply(SET_HAS, POLICIES, [policy as TemplateEntryPolicy])) {
    throw new TypeError(`${field}.policy is unsupported`);
  }
  if (typeof action !== 'string'
    || !apply(SET_HAS, ACTIONS, [action as ProjectTemplateApplyAction])) {
    throw new TypeError(`${field}.action is unsupported`);
  }
  if (typeof reason !== 'string'
    || !apply(SET_HAS, REASONS, [reason as ProjectTemplateApplyReasonCode])) {
    throw new TypeError(`${field}.reason is unsupported`);
  }
  if (typeof record['reviewRequired'] !== 'boolean') {
    throw new TypeError(`${field}.reviewRequired must be boolean`);
  }
  validatePolicyAction(
    policy as TemplateEntryPolicy,
    action as ProjectTemplateApplyAction,
    field,
  );
  return freeze({
    path,
    policy: policy as TemplateEntryPolicy,
    action: action as ProjectTemplateApplyAction,
    reason: reason as ProjectTemplateApplyReasonCode,
    reviewRequired: record['reviewRequired'],
    capabilities: parseCapabilities(record['capabilities'], `${field}.capabilities`),
  });
}

function snapshotInput(value: unknown): ProjectTemplateCliReviewProjectionInputV1_1 {
  // Descriptor-only traversal rejects Proxy, accessors, sparse arrays, symbols,
  // and exotic prototypes before reading caller-controlled properties. The
  // shallow closed shape also lets all 4,096 core items reach deterministic
  // public truncation without first constructing a multi-megabyte JSON copy.
  const root = exactRecord(value, ['manifestId', 'items'], 'reviewProjection');
  if (typeof root['manifestId'] !== 'string'
    || !apply(REGEXP_TEST, HASH_PATTERN, [root['manifestId']])) {
    throw new TypeError('reviewProjection.manifestId must be a lowercase SHA-256');
  }
  const rawItems = denseArray(root['items'], MAX_TEMPLATE_ENTRIES, 'reviewProjection.items');
  const items: ProjectTemplateCliReviewItemInputV1_1[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    push(items, parseItem(rawItems[index], index));
  }
  const paths = new CAPTURED_SET<string>();
  for (const current of items) {
    if (apply(SET_HAS, paths, [current.path])) {
      throw new TypeError('reviewProjection.items contains duplicate paths');
    }
    apply(SET_ADD, paths, [current.path]);
  }
  apply(ARRAY_SORT, items, [
    (left: ProjectTemplateCliReviewItemInputV1_1,
      right: ProjectTemplateCliReviewItemInputV1_1) => (
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ),
  ]);
  return freeze({
    manifestId: root['manifestId'],
    items: freeze(items),
  });
}

export function createProjectTemplateCliReviewProjectionV1_1(
  input: ProjectTemplateCliReviewProjectionInputV1_1,
): ProjectTemplateCliReviewProjectionV1_1 {
  const snapshot = snapshotInput(input);
  const allItems: ProjectTemplateCliReviewItemV1_1[] = [];
  for (const current of snapshot.items) {
    const targetId = stableId('takt.project-template.cli-review.target.v1', [
      snapshot.manifestId, current.path,
    ]);
    const id = stableId('takt.project-template.cli-review.item.v1', [
      targetId,
      current.policy,
      current.action,
      current.reason,
      current.reviewRequired ? 'true' : 'false',
      ...current.capabilities,
    ]);
    push(allItems, freeze({ ...current, id, targetId }) as ProjectTemplateCliReviewItemV1_1);
  }
  const allConflicts: ProjectTemplateCliReviewConflictV1_1[] = [];
  const allWarnings: ProjectTemplateCliCapabilityWarningV1_1[] = [];
  for (const current of allItems) {
    if (current.action === 'conflict') {
      push(allConflicts, freeze({
        id: stableId('takt.project-template.cli-review.conflict.v1', [
          current.targetId, current.reason,
        ]),
        targetId: current.targetId,
        path: current.path,
        reason: current.reason,
        safeDefaultAction: 'abort' as const,
        allowedActions: freeze(['abort'] as ['abort']),
      }));
    }
    for (const capability of current.capabilities) {
      push(allWarnings, freeze({
        id: stableId('takt.project-template.cli-review.warning.v1', [
          current.targetId, capability,
        ]),
        targetId: current.targetId,
        capability,
      }));
    }
  }

  const items = freeze(apply(
    ARRAY_SLICE,
    allItems,
    [0, MAX_PROJECT_TEMPLATE_CLI_REVIEW_ITEMS_V1_1],
  ) as ProjectTemplateCliReviewItemV1_1[]);
  const emittedTargetIds = new CAPTURED_SET<string>();
  for (const current of items) apply(SET_ADD, emittedTargetIds, [current.targetId]);
  const conflictsBuffer: ProjectTemplateCliReviewConflictV1_1[] = [];
  for (const conflict of allConflicts) {
    if (conflictsBuffer.length >= MAX_PROJECT_TEMPLATE_CLI_REVIEW_ITEMS_V1_1) break;
    if (apply(SET_HAS, emittedTargetIds, [conflict.targetId])) push(conflictsBuffer, conflict);
  }
  const warningsBuffer: ProjectTemplateCliCapabilityWarningV1_1[] = [];
  for (const warning of allWarnings) {
    if (warningsBuffer.length >= MAX_PROJECT_TEMPLATE_CLI_REVIEW_ITEMS_V1_1) break;
    if (apply(SET_HAS, emittedTargetIds, [warning.targetId])) push(warningsBuffer, warning);
  }
  const conflicts = freeze(conflictsBuffer);
  const warnings = freeze(warningsBuffer);
  const summary = freeze({
    totalItems: allItems.length,
    emittedItems: items.length,
    omittedItems: allItems.length - items.length,
    totalConflicts: allConflicts.length,
    emittedConflicts: conflicts.length,
    omittedConflicts: allConflicts.length - conflicts.length,
    totalWarnings: allWarnings.length,
    emittedWarnings: warnings.length,
    omittedWarnings: allWarnings.length - warnings.length,
    truncated: allItems.length !== items.length
      || allConflicts.length !== conflicts.length
      || allWarnings.length !== warnings.length,
  });
  return freeze({ items, conflicts, warnings, summary });
}
