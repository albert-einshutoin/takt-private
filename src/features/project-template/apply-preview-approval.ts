import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { types } from 'node:util';
import {
  assertProjectTemplateApplyPreview,
  projectTemplateApplyPreviewReviewSurfaceSha256,
} from './apply-preview.js';
import type { ProjectTemplateApplyPreview } from './apply-preview-types.js';
import {
  assertProjectTemplateMutationLeaseOwned,
  type ProjectTemplateMutationLease,
} from './apply-lease.js';
import {
  consumeProjectTemplateApprovalRecord,
  hasProjectTemplateApprovalClaim,
  initializeProjectTemplateApplyStorage,
  readProjectTemplateApprovalRecord,
  writeProjectTemplateApprovalRecord,
  type ProjectTemplateApplyStorage,
  type ProjectTemplateApplyStorageIo,
} from './apply-storage.js';
import { canonicalizeTaktpackJson } from './canonical-json.js';

const APPROVAL_CONTEXT = 'project-template-apply-preview-review';
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_APPROVAL_TTL_MS = 5 * 60 * 1000;
const CAPTURED_CREATE_HASH = createHash;
const CAPTURED_RANDOM_UUID = randomUUID;
const CAPTURED_DATE = Date;
const CAPTURED_DATE_GET_TIME = Date.prototype.getTime;
const CAPTURED_DATE_PARSE = Date.parse;
const CAPTURED_DATE_TO_ISO_STRING = Date.prototype.toISOString;
const CAPTURED_NUMBER_IS_FINITE = Number.isFinite;
const CAPTURED_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const CAPTURED_NUMBER_RECEIVER = Number;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_REFLECT_RECEIVER = Reflect;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;
const CAPTURED_WEAK_MAP_DELETE = WeakMap.prototype.delete;
const CAPTURED_WEAK_MAP_GET = WeakMap.prototype.get;
const CAPTURED_WEAK_MAP_HAS = WeakMap.prototype.has;
const CAPTURED_WEAK_MAP_SET = WeakMap.prototype.set;
const HASH_SAMPLE = CAPTURED_CREATE_HASH('sha256');
const CAPTURED_HASH_UPDATE = HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_SAMPLE.digest;

declare const APPROVAL_EVIDENCE_BRAND: unique symbol;

/**
 * Opaque process-local approval evidence. A matching durable record, literal,
 * clone, or deserialized object is not authority without the private brand.
 */
export interface ProjectTemplateApplyPreviewApprovalEvidence {
  readonly schemaVersion: '1.0';
  readonly approvalId: string;
  readonly [APPROVAL_EVIDENCE_BRAND]: true;
}

interface ProjectTemplateApplyPreviewApprovalAuthority {
  state: 'active' | 'consuming' | 'revoking' | 'consumed' | 'revoked';
  readonly record: ProjectTemplateApplyPreviewApprovalRecord;
}

interface ProjectTemplateApplyPreviewApprovalRecord {
  readonly schemaVersion: '1.0';
  readonly approvalId: string;
  readonly nonce: string;
  readonly decision: 'approved';
  readonly context: typeof APPROVAL_CONTEXT;
  readonly projectIdentity: string;
  readonly previewId: string;
  readonly transactionPlanId?: string;
  readonly contentPlanId: string;
  readonly contentPreconditionToken: string;
  readonly repertoireDependencyPlanId: string;
  readonly repertoireDependencyPreconditionToken: string;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly reviewSurfaceSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface ApprovalIssuanceOptionsSnapshot {
  readonly projectRoot: string;
  readonly preview: ProjectTemplateApplyPreview;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly io?: ProjectTemplateApplyStorageIo;
}

// Serialized evidence is deliberately insufficient: authority exists only for
// the exact object returned after the private record is durably published.
const APPROVAL_AUTHORITIES =
  new WeakMap<object, ProjectTemplateApplyPreviewApprovalAuthority>();
const BURNED_APPROVAL_IDS = new Set<string>();
const CAPTURED_SET_ADD = Set.prototype.add;

function sha256(value: string): string {
  const hash = CAPTURED_CREATE_HASH('sha256');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [value, 'utf8']);
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_HASH_DIGEST,
    hash,
    ['hex'],
  ) as string;
}

function projectIdentity(storage: ProjectTemplateApplyStorage): string {
  // Match the legacy approval identity without persisting an absolute path.
  return sha256(canonicalizeTaktpackJson({
    repoRoot: storage.repoRoot,
    device: storage.device,
    inode: storage.inode,
  }));
}

function invalidIssuance(message: string): never {
  throw new Error(message);
}

function isAllowedOptionKey(value: PropertyKey): boolean {
  return value === 'projectRoot'
    || value === 'preview'
    || value === 'baselineStrategy'
    || value === 'now'
    || value === 'expiresInMs'
    || value === 'io';
}

function snapshotOptions(value: unknown): ApprovalIssuanceOptionsSnapshot {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) !== CAPTURED_OBJECT_PROTOTYPE
  ) invalidIssuance('apply preview approval options are invalid');
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
    if (!isAllowedOptionKey(keys[index]!)) {
      invalidIssuance('apply preview approval options are invalid');
    }
  }
  const required = ['projectRoot', 'preview', 'baselineStrategy'];
  for (let index = 0; index < required.length; index += 1) {
    const descriptor = descriptors[required[index]!];
    if (descriptor === undefined || !('value' in descriptor)) {
      invalidIssuance('apply preview approval options are invalid');
    }
  }
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[keys[index]!];
    if (descriptor === undefined || !('value' in descriptor)) {
      invalidIssuance('apply preview approval options are invalid');
    }
  }
  const projectRoot = descriptors['projectRoot']!.value as unknown;
  const baselineStrategy = descriptors['baselineStrategy']!.value as unknown;
  const expiresInMs = descriptors['expiresInMs']?.value as unknown
    ?? DEFAULT_APPROVAL_TTL_MS;
  const nowDescriptor = descriptors['now'];
  const now = nowDescriptor === undefined || nowDescriptor.value === undefined
    ? new CAPTURED_DATE()
    : nowDescriptor.value as unknown;
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    invalidIssuance('apply preview approval project root is invalid');
  }
  if (baselineStrategy !== 'conflict' && baselineStrategy !== 'adopt-identical') {
    invalidIssuance('apply preview approval baseline strategy is invalid');
  }
  if (
    typeof expiresInMs !== 'number'
    || !CAPTURED_REFLECT_APPLY(
      CAPTURED_NUMBER_IS_SAFE_INTEGER,
      CAPTURED_NUMBER_RECEIVER,
      [expiresInMs],
    )
    || expiresInMs <= 0
    || expiresInMs > MAX_APPROVAL_TTL_MS
  ) invalidIssuance('apply preview approval expiry is invalid');
  if (
    typeof now !== 'object'
    || now === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [now])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [now],
    )
      !== CAPTURED_DATE.prototype
  ) invalidIssuance('apply preview approval time is invalid');
  const nowMs = CAPTURED_REFLECT_APPLY(
    CAPTURED_DATE_GET_TIME,
    now,
    [],
  ) as number;
  if (!CAPTURED_REFLECT_APPLY(
    CAPTURED_NUMBER_IS_FINITE,
    CAPTURED_NUMBER_RECEIVER,
    [nowMs],
  )) {
    invalidIssuance('apply preview approval time is invalid');
  }
  // Convert caller-owned mutable Date state to immutable primitives before the
  // first await. No later issuance step retains or re-reads the Date object.
  const issuedAt = CAPTURED_REFLECT_APPLY(
    CAPTURED_DATE_TO_ISO_STRING,
    new CAPTURED_DATE(nowMs),
    [],
  ) as string;
  const expiresAt = CAPTURED_REFLECT_APPLY(
    CAPTURED_DATE_TO_ISO_STRING,
    new CAPTURED_DATE(nowMs + expiresInMs),
    [],
  ) as string;
  return {
    projectRoot,
    preview: descriptors['preview']!.value as ProjectTemplateApplyPreview,
    baselineStrategy,
    issuedAt,
    expiresAt,
    ...(descriptors['io'] === undefined
      ? {}
      : { io: descriptors['io'].value as ProjectTemplateApplyStorageIo }),
  };
}

async function burnFailedApproval(options: {
  storage: ProjectTemplateApplyStorage;
  approvalId: string;
  burnedAt: string;
}): Promise<void> {
  CAPTURED_REFLECT_APPLY(CAPTURED_SET_ADD, BURNED_APPROVAL_IDS, [
    options.approvalId,
  ]);
  try {
    await consumeProjectTemplateApprovalRecord({
      storage: options.storage,
      approvalId: options.approvalId,
      claim: {
        schemaVersion: '1.0',
        approvalId: options.approvalId,
        context: APPROVAL_CONTEXT,
        state: 'burned',
        burnedAt: options.burnedAt,
      },
    });
  } catch {
    // The process-local burn still prevents authority creation in this run;
    // consumption also checks the durable claim before trusting a record.
  }
}

function validateApprovalPreview(
  value: ProjectTemplateApplyPreview,
): ProjectTemplateApplyPreview {
  const preview = assertProjectTemplateApplyPreview(value);
  if (!preview.reviewRequired) {
    invalidIssuance('apply preview does not require review');
  }
  if (preview.hardConflict) {
    invalidIssuance('hard-conflicted apply preview cannot be approved');
  }
  if (preview.defaultApplyPossible) {
    invalidIssuance('default-applicable apply preview cannot be approved');
  }
  return preview;
}

async function publishApproval(options: {
  readonly snapshot: ApprovalIssuanceOptionsSnapshot;
  readonly preview: ProjectTemplateApplyPreview;
  readonly storage: ProjectTemplateApplyStorage;
  readonly assertAuthority?: () => void;
}): Promise<ProjectTemplateApplyPreviewApprovalEvidence> {
  const { snapshot, preview, storage } = options;
  const approvalId = `approval-${CAPTURED_RANDOM_UUID()}`;
  const nonce = CAPTURED_RANDOM_UUID();
  let record: ProjectTemplateApplyPreviewApprovalRecord | undefined;
  try {
    options.assertAuthority?.();
    const identity = projectIdentity(storage);
    record = {
      schemaVersion: '1.0',
      approvalId,
      nonce,
      decision: 'approved',
      context: APPROVAL_CONTEXT,
      projectIdentity: identity,
      previewId: preview.previewId,
      ...(preview.transactionPlanId === undefined
        ? {}
        : { transactionPlanId: preview.transactionPlanId }),
      contentPlanId: preview.bindings.contentPlanId,
      contentPreconditionToken: preview.bindings.contentPreconditionToken,
      repertoireDependencyPlanId: preview.bindings.repertoireDependencyPlanId,
      repertoireDependencyPreconditionToken:
        preview.bindings.repertoireDependencyPreconditionToken,
      baselineStrategy: snapshot.baselineStrategy,
      reviewSurfaceSha256:
        projectTemplateApplyPreviewReviewSurfaceSha256(preview),
      issuedAt: snapshot.issuedAt,
      expiresAt: snapshot.expiresAt,
    };
    options.assertAuthority?.();
    await writeProjectTemplateApprovalRecord({ storage, approvalId, record });
    options.assertAuthority?.();
    const evidence = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_FREEZE,
      CAPTURED_OBJECT_RECEIVER,
      [{ schemaVersion: '1.0' as const, approvalId }],
    ) as ProjectTemplateApplyPreviewApprovalEvidence;
    CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_MAP_SET, APPROVAL_AUTHORITIES, [
      evidence,
      { state: 'active', record },
    ]);
    return evidence;
  } catch {
    if (record !== undefined) {
      await burnFailedApproval({
        storage,
        approvalId,
        burnedAt: snapshot.issuedAt,
      });
    }
    throw new Error('project template apply preview approval issuance failed');
  }
}

/**
 * Internal trusted broker boundary. This function is intentionally absent from
 * public barrels; callers cannot turn a cloned preview into apply authority.
 *
 * @internal
 */
export async function issueTrustedProjectTemplateApplyPreviewApproval(
  value: unknown,
): Promise<ProjectTemplateApplyPreviewApprovalEvidence> {
  const options = snapshotOptions(value);
  const preview = validateApprovalPreview(options.preview);
  let storage: ProjectTemplateApplyStorage;
  try {
    storage = await initializeProjectTemplateApplyStorage({
      repoPath: options.projectRoot,
      ...(options.io === undefined ? {} : { io: options.io }),
    });
  } catch {
    throw new Error('project template apply preview approval issuance failed');
  }
  return publishApproval({ snapshot: options, preview, storage });
}

/**
 * Issues an internal approval only while the caller still owns the apply
 * lease. Reasserting ownership around durable publication prevents a stale
 * derivation from leaving usable approval authority after lease loss.
 *
 * @internal
 */
export async function issueOwnedProjectTemplateApplyPreviewApproval(
  value: unknown,
): Promise<ProjectTemplateApplyPreviewApprovalEvidence> {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) !== CAPTURED_OBJECT_PROTOTYPE
  ) invalidIssuance('owned apply preview approval options are invalid');
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
  const allowed = [
    'projectRoot', 'storage', 'lease', 'preview', 'baselineStrategy',
    'now', 'expiresInMs',
  ];
  if (
    keys.length < 5
    || keys.length > allowed.length
    || keys.some((key) => typeof key !== 'string' || !allowed.includes(key))
    || keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !('value' in descriptor);
    })
  ) invalidIssuance('owned apply preview approval options are invalid');
  for (const key of ['projectRoot', 'storage', 'lease', 'preview', 'baselineStrategy']) {
    if (descriptors[key] === undefined) {
      invalidIssuance('owned apply preview approval options are invalid');
    }
  }
  const projectRoot = descriptors['projectRoot']!.value as unknown;
  const storage = descriptors['storage']!.value as ProjectTemplateApplyStorage;
  const lease = descriptors['lease']!.value as ProjectTemplateMutationLease;
  const snapshot = snapshotOptions({
    projectRoot,
    preview: descriptors['preview']!.value,
    baselineStrategy: descriptors['baselineStrategy']!.value,
    ...(descriptors['now'] === undefined
      ? {}
      : { now: descriptors['now'].value }),
    ...(descriptors['expiresInMs'] === undefined
      ? {}
      : { expiresInMs: descriptors['expiresInMs'].value }),
  });
  const preview = validateApprovalPreview(snapshot.preview);
  let canonicalProjectRoot: string;
  try {
    canonicalProjectRoot = await realpath(resolve(projectRoot as string));
  } catch {
    invalidIssuance('owned apply preview approval authority is invalid');
  }
  if (storage.repoRoot !== canonicalProjectRoot) {
    invalidIssuance('owned apply preview approval authority is invalid');
  }
  const assertAuthority = (): void => {
    if (
      typeof projectRoot !== 'string'
      || lease.operation !== 'apply'
    ) invalidIssuance('owned apply preview approval authority is invalid');
    assertProjectTemplateMutationLeaseOwned(projectRoot, lease);
  };
  assertAuthority();
  return publishApproval({
    snapshot,
    preview,
    storage,
    assertAuthority,
  });
}

interface ApprovalOperationSnapshot {
  readonly storage: ProjectTemplateApplyStorage;
  readonly preview?: ProjectTemplateApplyPreview;
  readonly baselineStrategy?: 'conflict' | 'adopt-identical';
  readonly evidence: unknown;
  readonly nowMs: number;
}

function operationNow(value: unknown, provided: boolean): number | undefined {
  const now = provided ? value : new CAPTURED_DATE();
  if (
    typeof now !== 'object'
    || now === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [now])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [now],
    ) !== CAPTURED_DATE.prototype
  ) return undefined;
  const nowMs = CAPTURED_REFLECT_APPLY(
    CAPTURED_DATE_GET_TIME,
    now,
    [],
  ) as number;
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_NUMBER_IS_FINITE,
    CAPTURED_NUMBER_RECEIVER,
    [nowMs],
  ) ? nowMs : undefined;
}

function snapshotOperationOptions(
  value: unknown,
  operation: 'consume' | 'revoke',
): ApprovalOperationSnapshot | undefined {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) !== CAPTURED_OBJECT_PROTOTYPE
  ) return undefined;
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
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !('value' in descriptor)
      || (key !== 'storage'
        && key !== 'evidence'
        && key !== 'now'
        && (operation !== 'consume'
          || (key !== 'preview' && key !== 'baselineStrategy')))
    ) return undefined;
  }
  const storage = descriptors['storage'];
  const evidence = descriptors['evidence'];
  if (
    storage === undefined
    || !('value' in storage)
    || evidence === undefined
    || !('value' in evidence)
  ) return undefined;
  const nowDescriptor = descriptors['now'];
  const nowMs = operationNow(
    nowDescriptor?.value,
    nowDescriptor !== undefined && nowDescriptor.value !== undefined,
  );
  if (nowMs === undefined) return undefined;
  if (operation === 'revoke') {
    if (keys.length < 2 || keys.length > 3) return undefined;
    return {
      storage: storage.value as ProjectTemplateApplyStorage,
      evidence: evidence.value,
      nowMs,
    };
  }
  const preview = descriptors['preview'];
  const baseline = descriptors['baselineStrategy'];
  if (
    preview === undefined
    || !('value' in preview)
    || baseline === undefined
    || !('value' in baseline)
    || (baseline.value !== 'conflict' && baseline.value !== 'adopt-identical')
    || keys.length < 4
    || keys.length > 5
  ) return undefined;
  return {
    storage: storage.value as ProjectTemplateApplyStorage,
    preview: preview.value as ProjectTemplateApplyPreview,
    baselineStrategy: baseline.value,
    evidence: evidence.value,
    nowMs,
  };
}

function authorityFor(
  value: unknown,
): ProjectTemplateApplyPreviewApprovalAuthority | undefined {
  return typeof value === 'object' && value !== null
    ? CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_MAP_GET,
      APPROVAL_AUTHORITIES,
      [value],
    ) as ProjectTemplateApplyPreviewApprovalAuthority | undefined
    : undefined;
}

/** @internal Tests membership in the private process-local authority registry. */
export function isProjectTemplateApplyPreviewApprovalEvidence(
  value: unknown,
): value is ProjectTemplateApplyPreviewApprovalEvidence {
  return typeof value === 'object'
    && value !== null
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_MAP_HAS,
      APPROVAL_AUTHORITIES,
      [value],
    ) as boolean;
}

function finishAuthority(
  evidence: object,
  authority: ProjectTemplateApplyPreviewApprovalAuthority,
  state: 'consumed' | 'revoked',
): void {
  authority.state = state;
  CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_MAP_DELETE,
    APPROVAL_AUTHORITIES,
    [evidence],
  );
}

function parseApprovalRecord(
  value: unknown,
): ProjectTemplateApplyPreviewApprovalRecord | undefined {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) !== CAPTURED_OBJECT_PROTOTYPE
  ) return undefined;
  const expected = [
    'schemaVersion', 'approvalId', 'nonce', 'decision', 'context',
    'projectIdentity', 'previewId', 'contentPlanId',
    'contentPreconditionToken', 'repertoireDependencyPlanId',
    'repertoireDependencyPreconditionToken', 'baselineStrategy',
    'reviewSurfaceSha256', 'issuedAt', 'expiresAt',
  ];
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
  const transactionDescriptor = descriptors['transactionPlanId'];
  if (transactionDescriptor !== undefined) expected.push('transactionPlanId');
  if (keys.length !== expected.length) return undefined;
  for (let index = 0; index < expected.length; index += 1) {
    const descriptor = descriptors[expected[index]!];
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
  }
  for (let index = 0; index < keys.length; index += 1) {
    let known = false;
    for (let cursor = 0; cursor < expected.length; cursor += 1) {
      if (keys[index] === expected[cursor]) known = true;
    }
    if (!known) return undefined;
  }
  const record = value as ProjectTemplateApplyPreviewApprovalRecord;
  if (
    record.schemaVersion !== '1.0'
    || typeof record.approvalId !== 'string'
    || typeof record.nonce !== 'string'
    || record.decision !== 'approved'
    || record.context !== APPROVAL_CONTEXT
    || typeof record.projectIdentity !== 'string'
    || typeof record.previewId !== 'string'
    || (record.transactionPlanId !== undefined
      && typeof record.transactionPlanId !== 'string')
    || typeof record.contentPlanId !== 'string'
    || typeof record.contentPreconditionToken !== 'string'
    || typeof record.repertoireDependencyPlanId !== 'string'
    || typeof record.repertoireDependencyPreconditionToken !== 'string'
    || (record.baselineStrategy !== 'conflict'
      && record.baselineStrategy !== 'adopt-identical')
    || typeof record.reviewSurfaceSha256 !== 'string'
    || typeof record.issuedAt !== 'string'
    || typeof record.expiresAt !== 'string'
  ) return undefined;
  return record;
}

function recordMatches(options: {
  record: ProjectTemplateApplyPreviewApprovalRecord;
  authority: ProjectTemplateApplyPreviewApprovalAuthority;
  storage: ProjectTemplateApplyStorage;
  preview: ProjectTemplateApplyPreview;
  baselineStrategy: 'conflict' | 'adopt-identical';
  nowMs: number;
}): boolean {
  const expected = options.authority.record;
  const issuedAt = CAPTURED_REFLECT_APPLY(
    CAPTURED_DATE_PARSE,
    CAPTURED_DATE,
    [options.record.issuedAt],
  ) as number;
  const expiresAt = CAPTURED_REFLECT_APPLY(
    CAPTURED_DATE_PARSE,
    CAPTURED_DATE,
    [options.record.expiresAt],
  ) as number;
  return options.record.schemaVersion === '1.0'
    && options.record.approvalId === expected.approvalId
    && options.record.nonce === expected.nonce
    && options.record.decision === 'approved'
    && options.record.context === APPROVAL_CONTEXT
    && options.record.projectIdentity === expected.projectIdentity
    && options.record.projectIdentity === projectIdentity(options.storage)
    && options.record.previewId === expected.previewId
    && options.record.previewId === options.preview.previewId
    && options.record.transactionPlanId === expected.transactionPlanId
    && options.record.transactionPlanId === options.preview.transactionPlanId
    && options.record.contentPlanId === expected.contentPlanId
    && options.record.contentPlanId === options.preview.bindings.contentPlanId
    && options.record.contentPreconditionToken === expected.contentPreconditionToken
    && options.record.contentPreconditionToken
      === options.preview.bindings.contentPreconditionToken
    && options.record.repertoireDependencyPlanId
      === expected.repertoireDependencyPlanId
    && options.record.repertoireDependencyPlanId
      === options.preview.bindings.repertoireDependencyPlanId
    && options.record.repertoireDependencyPreconditionToken
      === expected.repertoireDependencyPreconditionToken
    && options.record.repertoireDependencyPreconditionToken
      === options.preview.bindings.repertoireDependencyPreconditionToken
    && options.record.baselineStrategy === expected.baselineStrategy
    && options.record.baselineStrategy === options.baselineStrategy
    && options.record.reviewSurfaceSha256 === expected.reviewSurfaceSha256
    && options.record.reviewSurfaceSha256
      === projectTemplateApplyPreviewReviewSurfaceSha256(options.preview)
    && options.record.issuedAt === expected.issuedAt
    && options.record.expiresAt === expected.expiresAt
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_NUMBER_IS_FINITE,
      CAPTURED_NUMBER_RECEIVER,
      [issuedAt],
    )
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_NUMBER_IS_FINITE,
      CAPTURED_NUMBER_RECEIVER,
      [expiresAt],
    )
    && issuedAt < expiresAt
    && issuedAt <= options.nowMs
    && options.nowMs < expiresAt;
}

function dispositionClaim(options: {
  authority: ProjectTemplateApplyPreviewApprovalAuthority;
  disposition: 'consumed' | 'revoked';
  claimedAt: string;
}): Record<string, string> {
  const record = options.authority.record;
  return {
    schemaVersion: '1.0',
    approvalId: record.approvalId,
    nonce: record.nonce,
    context: APPROVAL_CONTEXT,
    projectIdentity: record.projectIdentity,
    previewId: record.previewId,
    ...(record.transactionPlanId === undefined
      ? {}
      : { transactionPlanId: record.transactionPlanId }),
    contentPlanId: record.contentPlanId,
    repertoireDependencyPlanId: record.repertoireDependencyPlanId,
    disposition: options.disposition,
    claimedAt: options.claimedAt,
  };
}

function operationTimestamp(nowMs: number): string {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_DATE_TO_ISO_STRING,
    new CAPTURED_DATE(nowMs),
    [],
  ) as string;
}

async function consumeReserved(options: {
  storage: ProjectTemplateApplyStorage;
  preview: ProjectTemplateApplyPreview;
  baselineStrategy: 'conflict' | 'adopt-identical';
  evidence: object;
  authority: ProjectTemplateApplyPreviewApprovalAuthority;
  nowMs: number;
}): Promise<boolean> {
  try {
    if (
      options.authority.record.projectIdentity !== projectIdentity(options.storage)
      || await hasProjectTemplateApprovalClaim({
        storage: options.storage,
        approvalId: options.authority.record.approvalId,
      })
    ) return false;
    const value = await readProjectTemplateApprovalRecord({
      storage: options.storage,
      approvalId: options.authority.record.approvalId,
    });
    const record = parseApprovalRecord(value);
    if (record === undefined || !recordMatches({ ...options, record })) return false;
    await consumeProjectTemplateApprovalRecord({
      storage: options.storage,
      approvalId: record.approvalId,
      claim: dispositionClaim({
        authority: options.authority,
        disposition: 'consumed',
        claimedAt: operationTimestamp(options.nowMs),
      }),
    });
    return true;
  } catch {
    return false;
  } finally {
    finishAuthority(options.evidence, options.authority, 'consumed');
  }
}

/**
 * @internal Revalidates the exact durable approval without reserving or
 * consuming it. Remote apply uses this before preparation; the single-use
 * consume remains the later linearization point after every output is staged.
 */
export async function validateProjectTemplateApplyPreviewApproval(
  value: unknown,
): Promise<boolean> {
  const options = snapshotOperationOptions(value, 'consume');
  if (options === undefined) return false;
  const authority = authorityFor(options.evidence);
  if (authority === undefined || authority.state !== 'active') return false;
  let preview: ProjectTemplateApplyPreview;
  try {
    preview = assertProjectTemplateApplyPreview(options.preview);
  } catch {
    return false;
  }
  try {
    if (
      authority.record.projectIdentity !== projectIdentity(options.storage)
      || await hasProjectTemplateApprovalClaim({
        storage: options.storage,
        approvalId: authority.record.approvalId,
      })
    ) return false;
    const record = parseApprovalRecord(await readProjectTemplateApprovalRecord({
      storage: options.storage,
      approvalId: authority.record.approvalId,
    }));
    return record !== undefined && recordMatches({
      record,
      authority,
      storage: options.storage,
      preview,
      baselineStrategy: options.baselineStrategy!,
      nowMs: options.nowMs,
    });
  } catch {
    return false;
  }
}

/** @internal Atomically consumes a single-use preview approval. */
export async function consumeProjectTemplateApplyPreviewApproval(
  value: unknown,
): Promise<boolean> {
  const options = snapshotOperationOptions(value, 'consume');
  if (options === undefined) return false;
  const authority = authorityFor(options.evidence);
  if (authority === undefined || authority.state !== 'active') {
    return false;
  }
  let preview: ProjectTemplateApplyPreview;
  try {
    preview = assertProjectTemplateApplyPreview(options.preview);
  } catch {
    return false;
  }
  authority.state = 'consuming';
  return consumeReserved({
    storage: options.storage,
    preview,
    baselineStrategy: options.baselineStrategy!,
    evidence: options.evidence as object,
    authority,
    nowMs: options.nowMs,
  });
}

async function revokeReserved(options: {
  storage: ProjectTemplateApplyStorage;
  evidence: object;
  authority: ProjectTemplateApplyPreviewApprovalAuthority;
  nowMs: number;
}): Promise<boolean> {
  try {
    if (
      options.authority.record.projectIdentity !== projectIdentity(options.storage)
      || await hasProjectTemplateApprovalClaim({
        storage: options.storage,
        approvalId: options.authority.record.approvalId,
      })
    ) return false;
    await consumeProjectTemplateApprovalRecord({
      storage: options.storage,
      approvalId: options.authority.record.approvalId,
      claim: dispositionClaim({
        authority: options.authority,
        disposition: 'revoked',
        claimedAt: operationTimestamp(options.nowMs),
      }),
    });
    return true;
  } catch {
    return false;
  } finally {
    finishAuthority(options.evidence, options.authority, 'revoked');
  }
}

/** @internal Irreversibly revokes an active preview approval. */
export async function revokeProjectTemplateApplyPreviewApproval(
  value: unknown,
): Promise<boolean> {
  const options = snapshotOperationOptions(value, 'revoke');
  if (options === undefined) return false;
  const authority = authorityFor(options.evidence);
  if (authority === undefined || authority.state !== 'active') {
    return false;
  }
  authority.state = 'revoking';
  return revokeReserved({
    storage: options.storage,
    evidence: options.evidence as object,
    authority,
    nowMs: options.nowMs,
  });
}
