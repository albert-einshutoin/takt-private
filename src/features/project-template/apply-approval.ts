import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeTaktpackJson } from './canonical-json.js';
import {
  consumeProjectTemplateApprovalRecord,
  hasProjectTemplateApprovalClaim,
  initializeProjectTemplateApplyStorage,
  readProjectTemplateApprovalRecord,
  writeProjectTemplateApprovalRecord,
  type ProjectTemplateApplyStorage,
  type ProjectTemplateApplyStorageIo,
} from './apply-storage.js';
import type {
  ProjectTemplateApplyPlan,
} from './apply-plan-types.js';

const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const APPROVAL_CONTEXT = 'project-template-apply-review';

export interface ProjectTemplateApplyApprovalEvidence {
  readonly schemaVersion: '1.0';
  readonly approvalId: string;
  readonly nonce: string;
}

interface ProjectTemplateApplyApprovalRecord {
  readonly schemaVersion: '1.0';
  readonly approvalId: string;
  readonly nonce: string;
  readonly decision: 'approved' | 'rejected';
  readonly context: typeof APPROVAL_CONTEXT;
  readonly projectIdentity: string;
  readonly planId: string;
  readonly preconditionToken: string;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly reviewSurfaceSha256: string;
  readonly capabilitiesBefore: readonly string[];
  readonly capabilitiesAfter: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function planSeal(plan: ProjectTemplateApplyPlan): string {
  const body: Partial<ProjectTemplateApplyPlan> = { ...plan };
  delete body.planId;
  return sha256(canonicalizeTaktpackJson(body));
}

function projectIdentity(storage: ProjectTemplateApplyStorage): string {
  // Persist only a digest: absolute repository paths can contain account or
  // workspace details, while path + device still prevents cross-project use.
  return sha256(canonicalizeTaktpackJson({
    repoRoot: storage.repoRoot,
    device: storage.device,
    inode: storage.inode,
  }));
}

function reviewSurfaceSha256(plan: ProjectTemplateApplyPlan): string {
  return sha256(canonicalizeTaktpackJson({
    planId: plan.planId,
    preconditionToken: plan.preconditionToken,
    reviewRequiredPaths: plan.entries
      .filter((entry) => entry.reviewRequired)
      .map((entry) => entry.path),
    capabilitiesBefore: plan.capabilitiesBefore,
    capabilitiesAfter: plan.capabilitiesAfter,
  }));
}

function hasHardBlocker(plan: ProjectTemplateApplyPlan): boolean {
  return plan.incomingCompatibility === 'incompatible'
    || plan.entries.some((entry) => entry.action === 'conflict');
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isProjectTemplateApplyApprovalEvidence(
  value: unknown,
): value is ProjectTemplateApplyApprovalEvidence {
  return isRecord(value)
    && hasExactKeys(value, ['schemaVersion', 'approvalId', 'nonce'])
    && value['schemaVersion'] === '1.0'
    && typeof value['approvalId'] === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value['approvalId'])
    && typeof value['nonce'] === 'string'
    && /^[a-f0-9-]{36}$/.test(value['nonce']);
}

/**
 * Internal test/broker boundary. Intentionally excluded from public package
 * barrels: Issue #145 owns the signed core-adapter handoff and Issue #147 owns
 * the human confirmation UI. Neither downstream may expose generic issuance.
 *
 * @internal
 */
export async function issueTrustedProjectTemplateApplyApproval(options: {
  projectRoot: string;
  plan: ProjectTemplateApplyPlan;
  baselineStrategy: 'conflict' | 'adopt-identical';
  decision: 'approved' | 'rejected';
  now?: Date;
  expiresInMs?: number;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<ProjectTemplateApplyApprovalEvidence> {
  if (options.plan.planId !== planSeal(options.plan)) {
    throw new Error('cannot approve an unsealed apply plan');
  }
  if (!options.plan.reviewRequired) {
    throw new Error('apply plan does not require review');
  }
  if (options.decision === 'approved' && hasHardBlocker(options.plan)) {
    throw new Error('hard-blocked apply plan cannot be approved');
  }
  const expiresInMs = options.expiresInMs ?? DEFAULT_APPROVAL_TTL_MS;
  if (
    !Number.isSafeInteger(expiresInMs)
    || expiresInMs <= 0
    || expiresInMs > MAX_APPROVAL_TTL_MS
  ) {
    throw new Error('approval expiry is invalid');
  }
  const now = options.now ?? new Date();
  const storage = await initializeProjectTemplateApplyStorage({
    repoPath: options.projectRoot,
    ...(options.io === undefined ? {} : { io: options.io }),
  });
  const approvalId = `approval-${randomUUID()}`;
  const nonce = randomUUID();
  const record: ProjectTemplateApplyApprovalRecord = {
    schemaVersion: '1.0',
    approvalId,
    nonce,
    decision: options.decision,
    context: APPROVAL_CONTEXT,
    projectIdentity: projectIdentity(storage),
    planId: options.plan.planId,
    preconditionToken: options.plan.preconditionToken,
    baselineStrategy: options.baselineStrategy,
    reviewSurfaceSha256: reviewSurfaceSha256(options.plan),
    capabilitiesBefore: [...options.plan.capabilitiesBefore],
    capabilitiesAfter: [...options.plan.capabilitiesAfter],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
  };
  await writeProjectTemplateApprovalRecord({
    storage,
    approvalId,
    record,
  });
  return Object.freeze({
    schemaVersion: '1.0',
    approvalId,
    nonce,
  });
}

export async function consumeProjectTemplateApplyApprovalEvidence(options: {
  storage: ProjectTemplateApplyStorage;
  plan: ProjectTemplateApplyPlan;
  baselineStrategy: 'conflict' | 'adopt-identical';
  evidence: ProjectTemplateApplyApprovalEvidence;
  now?: Date;
}): Promise<boolean> {
  if (
    !isProjectTemplateApplyApprovalEvidence(options.evidence)
    || hasHardBlocker(options.plan)
  ) return false;
  try {
    if (await hasProjectTemplateApprovalClaim({
      storage: options.storage,
      approvalId: options.evidence.approvalId,
    })) return false;
  } catch {
    return false;
  }
  let value: unknown;
  try {
    value = await readProjectTemplateApprovalRecord({
      storage: options.storage,
      approvalId: options.evidence.approvalId,
    });
  } catch {
    return false;
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'approvalId',
      'nonce',
      'decision',
      'context',
      'projectIdentity',
      'planId',
      'preconditionToken',
      'baselineStrategy',
      'reviewSurfaceSha256',
      'capabilitiesBefore',
      'capabilitiesAfter',
      'issuedAt',
      'expiresAt',
    ])
  ) return false;
  const now = options.now ?? new Date();
  const issuedAt = typeof value['issuedAt'] === 'string'
    ? Date.parse(value['issuedAt'])
    : Number.NaN;
  const expiresAt = typeof value['expiresAt'] === 'string'
    ? Date.parse(value['expiresAt'])
    : Number.NaN;
  if (
    value['schemaVersion'] !== '1.0'
    || value['approvalId'] !== options.evidence.approvalId
    || value['nonce'] !== options.evidence.nonce
    || value['decision'] !== 'approved'
    || value['context'] !== APPROVAL_CONTEXT
    || value['projectIdentity'] !== projectIdentity(options.storage)
    || value['planId'] !== options.plan.planId
    || value['preconditionToken'] !== options.plan.preconditionToken
    || value['baselineStrategy'] !== options.baselineStrategy
    || value['reviewSurfaceSha256'] !== reviewSurfaceSha256(options.plan)
    || canonicalizeTaktpackJson(value['capabilitiesBefore'])
      !== canonicalizeTaktpackJson(options.plan.capabilitiesBefore)
    || canonicalizeTaktpackJson(value['capabilitiesAfter'])
      !== canonicalizeTaktpackJson(options.plan.capabilitiesAfter)
    || !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt > now.getTime()
    || expiresAt <= now.getTime()
  ) return false;
  try {
    await consumeProjectTemplateApprovalRecord({
      storage: options.storage,
      approvalId: options.evidence.approvalId,
      claim: {
        schemaVersion: '1.0',
        approvalId: options.evidence.approvalId,
        nonce: options.evidence.nonce,
        planId: options.plan.planId,
        claimedAt: now.toISOString(),
      },
    });
    return true;
  } catch {
    return false;
  }
}
