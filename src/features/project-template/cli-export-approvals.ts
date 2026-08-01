import { types } from 'node:util';
import type { ProjectTemplateExportOptions } from './archive-types.js';
import { ProjectTemplateValidationError } from './errors.js';
import {
  MAX_TEMPLATE_ENTRIES,
  MAX_TEMPLATE_PATH_LENGTH,
  parsePortablePath,
  TEMPLATE_CAPABILITIES,
} from './validation.js';

type ApprovedPolicy = 'managed' | 'merge' | 'scaffold';

export interface ProjectTemplateExportApprovalProjection {
  readonly policies: readonly Readonly<{ path: string; policy: ApprovedPolicy }>[];
  readonly approvedCapabilities: readonly string[];
}

const MAX_POLICY_VALUE_LENGTH = 8;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_SORT = Array.prototype.sort;
const OBJECT_CREATE = Object.create;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_PROTOTYPE = Object.prototype;
const OBJECT_HAS_OWN = Object.prototype.hasOwnProperty;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const STRING_INDEX_OF = String.prototype.indexOf;
const STRING_LAST_INDEX_OF = String.prototype.lastIndexOf;
const STRING_SLICE = String.prototype.slice;
const TYPES_IS_PROXY = types.isProxy;
const VALIDATION_ERROR_PROTOTYPE = ProjectTemplateValidationError.prototype;

export class ProjectTemplateCliExportApprovalError extends Error {
  constructor() {
    super('project template export approval is invalid');
    this.name = 'ProjectTemplateCliExportApprovalError';
  }
}

const APPROVAL_ERROR_PROTOTYPE = ProjectTemplateCliExportApprovalError.prototype;

export function isProjectTemplateCliExportApprovalError(
  error: unknown,
): error is ProjectTemplateCliExportApprovalError {
  return error !== null && typeof error === 'object' && !TYPES_IS_PROXY(error)
    && OBJECT_GET_PROTOTYPE_OF(error) === APPROVAL_ERROR_PROTOTYPE;
}

function invalid(): never {
  throw new ProjectTemplateCliExportApprovalError();
}

function append<T>(values: T[], value: T): void {
  REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, OBJECT_CONSTRUCTOR, [values, `${values.length}`, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  }]);
}

function define(target: object, key: string, value: unknown): void {
  REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, OBJECT_CONSTRUCTOR, [target, key, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  }]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertKeys(
  descriptors: Record<PropertyKey, PropertyDescriptor | undefined>,
  kind: 'cli' | 'export',
): void {
  const keys = REFLECT_OWN_KEYS(descriptors);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string') invalid();
    const allowed = kind === 'cli'
      ? key === 'policies' || key === 'capabilities'
      : key === 'packVersion' || key === 'takt' || key === 'source'
        || key === 'policies' || key === 'approvedCapabilities';
    if (!allowed) invalid();
  }
}

function strings(value: unknown, maxItems: number): string[] {
  if (value === undefined) return [];
  if (!ARRAY_IS_ARRAY(value) || TYPES_IS_PROXY(value)
    || OBJECT_GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE) invalid();
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value) as unknown as Record<
  PropertyKey, PropertyDescriptor | undefined
  >;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
    || typeof lengthDescriptor.value !== 'number'
    || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value) || lengthDescriptor.value < 0
    || lengthDescriptor.value > maxItems) invalid();
  const length = lengthDescriptor.value as number;
  const keys = REFLECT_OWN_KEYS(descriptors);
  if (keys.length !== length + 1) invalid();
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[`${index}`];
    if (descriptor === undefined || !('value' in descriptor)
      || typeof descriptor.value !== 'string') invalid();
    append(result, descriptor.value);
  }
  return result;
}

function isCapability(value: string): boolean {
  return value === TEMPLATE_CAPABILITIES[0]
    || value === TEMPLATE_CAPABILITIES[1]
    || value === TEMPLATE_CAPABILITIES[2];
}

function canonicalizeEntries(
  entries: Array<{ path: string; policy: ApprovedPolicy }>,
  capabilities: string[],
): {
  readonly options: Pick<ProjectTemplateExportOptions, 'policies' | 'approvedCapabilities'>;
  readonly projection: ProjectTemplateExportApprovalProjection;
} {
  REFLECT_APPLY(ARRAY_SORT, entries, [(
    left: { path: string }, right: { path: string },
  ) => compareText(left.path, right.path)]);
  REFLECT_APPLY(ARRAY_SORT, capabilities, [compareText]);
  const policies = OBJECT_CREATE(null) as Record<string, ApprovedPolicy>;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    define(policies, entry.path, entry.policy);
    OBJECT_FREEZE(entry);
  }
  const frozenEntries = OBJECT_FREEZE(entries);
  const frozenCapabilities = OBJECT_FREEZE(capabilities);
  // Why: approvals authorize archive content. A frozen canonical projection is
  // reused by planning and hashing so hostile getters or prototype changes cannot
  // alter consent between preview and apply.
  return OBJECT_FREEZE({
    options: OBJECT_FREEZE({
      policies: OBJECT_FREEZE(policies),
      approvedCapabilities: frozenCapabilities as never,
    }),
    projection: OBJECT_FREEZE({
      policies: frozenEntries,
      approvedCapabilities: frozenCapabilities,
    }),
  });
}

function validateEntry(
  pathValue: string,
  policyValue: unknown,
  seen: Record<string, true>,
): { path: string; policy: ApprovedPolicy } {
  let path: string;
  try {
    path = parsePortablePath(pathValue, 'approvePolicy');
  } catch (error) {
    if (error !== null && typeof error === 'object' && !TYPES_IS_PROXY(error)
      && OBJECT_GET_PROTOTYPE_OF(error) === VALIDATION_ERROR_PROTOTYPE) return invalid();
    throw error;
  }
  if (path.length > MAX_TEMPLATE_PATH_LENGTH
    || (REFLECT_APPLY(OBJECT_HAS_OWN, seen, [path]) as boolean)
    || (policyValue !== 'managed' && policyValue !== 'merge' && policyValue !== 'scaffold')) {
    return invalid();
  }
  define(seen, path, true);
  return { path, policy: policyValue };
}

function canonicalizeCapabilities(value: unknown): string[] {
  const capabilities = strings(value, TEMPLATE_CAPABILITIES.length);
  const seen = OBJECT_CREATE(null) as Record<string, true>;
  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index]!;
    if (!isCapability(capability)
      || (REFLECT_APPLY(OBJECT_HAS_OWN, seen, [capability]) as boolean)) invalid();
    define(seen, capability, true);
  }
  return capabilities;
}

export function parseProjectTemplateCliExportApprovals(options: {
  readonly policies?: unknown;
  readonly capabilities?: unknown;
}): Pick<ProjectTemplateExportOptions, 'policies' | 'approvedCapabilities'> {
  if (options === null || typeof options !== 'object' || TYPES_IS_PROXY(options)
    || (OBJECT_GET_PROTOTYPE_OF(options) !== OBJECT_PROTOTYPE
      && OBJECT_GET_PROTOTYPE_OF(options) !== null)) invalid();
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(options);
  assertKeys(descriptors, 'cli');
  const policiesDescriptor = descriptors.policies;
  const capabilitiesDescriptor = descriptors.capabilities;
  if ((policiesDescriptor !== undefined && !('value' in policiesDescriptor))
    || (capabilitiesDescriptor !== undefined && !('value' in capabilitiesDescriptor))) invalid();
  const rawPolicies = policiesDescriptor !== undefined && 'value' in policiesDescriptor
    ? policiesDescriptor.value : undefined;
  const rawCapabilities = capabilitiesDescriptor !== undefined && 'value' in capabilitiesDescriptor
    ? capabilitiesDescriptor.value : undefined;
  const seen = OBJECT_CREATE(null) as Record<string, true>;
  const entries: Array<{ path: string; policy: ApprovedPolicy }> = [];
  const rawPolicyValues = strings(rawPolicies, MAX_TEMPLATE_ENTRIES);
  for (let index = 0; index < rawPolicyValues.length; index += 1) {
    const approval = rawPolicyValues[index]!;
    if (approval.length > MAX_TEMPLATE_PATH_LENGTH + 1 + MAX_POLICY_VALUE_LENGTH) invalid();
    const separator = REFLECT_APPLY(STRING_INDEX_OF, approval, ['=']) as number;
    if (separator <= 0 || separator !== (REFLECT_APPLY(
      STRING_LAST_INDEX_OF, approval, ['='],
    ) as number)) invalid();
    const path = REFLECT_APPLY(STRING_SLICE, approval, [0, separator]) as string;
    const policy = REFLECT_APPLY(STRING_SLICE, approval, [separator + 1]) as string;
    append(entries, validateEntry(path, policy, seen));
  }
  return canonicalizeEntries(entries, canonicalizeCapabilities(rawCapabilities)).options;
}

export function snapshotProjectTemplateExportApprovals(options: unknown): {
  readonly options: Pick<ProjectTemplateExportOptions, 'policies' | 'approvedCapabilities'>;
  readonly projection: ProjectTemplateExportApprovalProjection;
} {
  if (options === null || typeof options !== 'object' || TYPES_IS_PROXY(options)
    || (OBJECT_GET_PROTOTYPE_OF(options) !== OBJECT_PROTOTYPE
      && OBJECT_GET_PROTOTYPE_OF(options) !== null)) invalid();
  const outer = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(options);
  assertKeys(outer, 'export');
  const policiesDescriptor = outer.policies;
  const capabilitiesDescriptor = outer.approvedCapabilities;
  if ((policiesDescriptor !== undefined && !('value' in policiesDescriptor))
    || (capabilitiesDescriptor !== undefined && !('value' in capabilitiesDescriptor))) invalid();
  const policyValue = policiesDescriptor !== undefined && 'value' in policiesDescriptor
    ? policiesDescriptor.value : undefined;
  const entries: Array<{ path: string; policy: ApprovedPolicy }> = [];
  const seen = OBJECT_CREATE(null) as Record<string, true>;
  if (policyValue !== undefined) {
    if (policyValue === null || typeof policyValue !== 'object' || TYPES_IS_PROXY(policyValue)
      || (OBJECT_GET_PROTOTYPE_OF(policyValue) !== OBJECT_PROTOTYPE
        && OBJECT_GET_PROTOTYPE_OF(policyValue) !== null)) invalid();
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(policyValue);
    const keys = REFLECT_OWN_KEYS(descriptors);
    if (keys.length > MAX_TEMPLATE_ENTRIES) invalid();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== 'string') invalid();
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor)) invalid();
      append(entries, validateEntry(key, descriptor.value, seen));
    }
  }
  const capabilities = canonicalizeCapabilities(
    capabilitiesDescriptor !== undefined && 'value' in capabilitiesDescriptor
      ? capabilitiesDescriptor.value : undefined,
  );
  return canonicalizeEntries(entries, capabilities);
}
