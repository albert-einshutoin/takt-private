import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import {
  assertProjectTemplateApplyPreview,
  projectTemplateApplyPreviewReviewSurfaceSha256,
} from './apply-preview.js';
import type { ProjectTemplateApplyPreview } from './apply-preview-types.js';
import {
  initializeProjectTemplateApplyStorage,
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
const CAPTURED_WEAK_MAP_SET = WeakMap.prototype.set;
const HASH_SAMPLE = CAPTURED_CREATE_HASH('sha256');
const CAPTURED_HASH_UPDATE = HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_SAMPLE.digest;

declare const APPROVAL_EVIDENCE_BRAND: unique symbol;

export interface ProjectTemplateApplyPreviewApprovalEvidence {
  readonly schemaVersion: '1.0';
  readonly approvalId: string;
  readonly [APPROVAL_EVIDENCE_BRAND]: true;
}

interface ProjectTemplateApplyPreviewApprovalAuthority {
  readonly approvalId: string;
  readonly nonce: string;
  readonly projectIdentity: string;
}

interface ProjectTemplateApplyPreviewApprovalRecord {
  readonly schemaVersion: '1.0';
  readonly approvalId: string;
  readonly nonce: string;
  readonly decision: 'approved';
  readonly context: typeof APPROVAL_CONTEXT;
  readonly projectIdentity: string;
  readonly previewId: string;
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
  readonly now: Date;
  readonly expiresInMs: number;
  readonly io?: ProjectTemplateApplyStorageIo;
}

// Serialized evidence is deliberately insufficient: authority exists only for
// the exact object returned after the private record is durably published.
const APPROVAL_AUTHORITIES =
  new WeakMap<object, ProjectTemplateApplyPreviewApprovalAuthority>();

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
  const now = descriptors['now']?.value as unknown ?? new CAPTURED_DATE();
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
  return {
    projectRoot,
    preview: descriptors['preview']!.value as ProjectTemplateApplyPreview,
    baselineStrategy,
    now: now as Date,
    expiresInMs,
    ...(descriptors['io'] === undefined
      ? {}
      : { io: descriptors['io'].value as ProjectTemplateApplyStorageIo }),
  };
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
  const preview = assertProjectTemplateApplyPreview(options.preview);
  if (!preview.reviewRequired) {
    invalidIssuance('apply preview does not require review');
  }
  if (preview.hardConflict) {
    invalidIssuance('hard-conflicted apply preview cannot be approved');
  }
  if (preview.defaultApplyPossible) {
    invalidIssuance('default-applicable apply preview cannot be approved');
  }
  const nowMs = CAPTURED_REFLECT_APPLY(
    CAPTURED_DATE_GET_TIME,
    options.now,
    [],
  ) as number;
  const approvalId = `approval-${CAPTURED_RANDOM_UUID()}`;
  const nonce = CAPTURED_RANDOM_UUID();
  let storage: ProjectTemplateApplyStorage;
  try {
    storage = await initializeProjectTemplateApplyStorage({
      repoPath: options.projectRoot,
      ...(options.io === undefined ? {} : { io: options.io }),
    });
    const identity = projectIdentity(storage);
    const record: ProjectTemplateApplyPreviewApprovalRecord = {
      schemaVersion: '1.0',
      approvalId,
      nonce,
      decision: 'approved',
      context: APPROVAL_CONTEXT,
      projectIdentity: identity,
      previewId: preview.previewId,
      contentPlanId: preview.bindings.contentPlanId,
      contentPreconditionToken: preview.bindings.contentPreconditionToken,
      repertoireDependencyPlanId: preview.bindings.repertoireDependencyPlanId,
      repertoireDependencyPreconditionToken:
        preview.bindings.repertoireDependencyPreconditionToken,
      baselineStrategy: options.baselineStrategy,
      reviewSurfaceSha256:
        projectTemplateApplyPreviewReviewSurfaceSha256(preview),
      issuedAt: CAPTURED_REFLECT_APPLY(
        CAPTURED_DATE_TO_ISO_STRING,
        options.now,
        [],
      ) as string,
      expiresAt: CAPTURED_REFLECT_APPLY(
        CAPTURED_DATE_TO_ISO_STRING,
        new CAPTURED_DATE(nowMs + options.expiresInMs),
        [],
      ) as string,
    };
    await writeProjectTemplateApprovalRecord({ storage, approvalId, record });
    const evidence = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_FREEZE,
      CAPTURED_OBJECT_RECEIVER,
      [{ schemaVersion: '1.0' as const, approvalId }],
    ) as ProjectTemplateApplyPreviewApprovalEvidence;
    CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_MAP_SET, APPROVAL_AUTHORITIES, [
      evidence,
      CAPTURED_REFLECT_APPLY(CAPTURED_OBJECT_FREEZE, CAPTURED_OBJECT_RECEIVER, [{
        approvalId,
        nonce,
        projectIdentity: identity,
      }]),
    ]);
    return evidence;
  } catch {
    // Storage paths, injected hook errors, and secrets must not cross the
    // issuance boundary. No authority is registered before durable success.
    throw new Error('project template apply preview approval issuance failed');
  }
}
