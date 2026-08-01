import { types } from 'node:util';
import type { ProjectTemplateApplyApprovalEvidence } from './apply-approval.js';
import type { ProjectTemplateApplyResult } from './apply-executor.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type GithubProjectTemplateRemoteApplyErrorCode =
  | 'INVALID_OPTIONS'
  | 'TRUSTED_INFRASTRUCTURE_UNAVAILABLE';

export class GithubProjectTemplateRemoteApplyError extends Error {
  constructor(public readonly code: GithubProjectTemplateRemoteApplyErrorCode) {
    super(code === 'INVALID_OPTIONS'
      ? 'GitHub project template remote apply options are invalid'
      : 'GitHub project template remote apply infrastructure is unavailable');
    this.name = 'GithubProjectTemplateRemoteApplyError';
    Object.freeze(this);
  }
}

export interface ApplyGithubProjectTemplateRemoteTransactionOptions {
  readonly cacheRoot: string;
  readonly receiptKey: string;
  readonly expectedTransactionPlanId: string;
  readonly approvalEvidence: ProjectTemplateApplyApprovalEvidence;
  readonly projectRoot: string;
  readonly currentTaktVersion: string;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly signal?: AbortSignal;
}

function invalidOptions(): never {
  throw new GithubProjectTemplateRemoteApplyError('INVALID_OPTIONS');
}

function snapshotOptions(
  value: ApplyGithubProjectTemplateRemoteTransactionOptions,
): Readonly<ApplyGithubProjectTemplateRemoteTransactionOptions> {
  // Why: caller-supplied verifier or inspection functions must be rejected by
  // shape before any value can execute a getter or acquire apply authority.
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) invalidOptions();
  const allowed = new Set([
    'cacheRoot',
    'receiptKey',
    'expectedTransactionPlanId',
    'approvalEvidence',
    'projectRoot',
    'currentTaktVersion',
    'baselineStrategy',
    'signal',
  ]);
  const required = [
    'cacheRoot',
    'receiptKey',
    'expectedTransactionPlanId',
    'approvalEvidence',
    'projectRoot',
    'currentTaktVersion',
    'baselineStrategy',
  ] as const;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key))
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor))
    || required.some((key) => descriptors[key] === undefined)
  ) invalidOptions();
  const cacheRoot = descriptors['cacheRoot']!.value;
  const receiptKey = descriptors['receiptKey']!.value;
  const expectedTransactionPlanId =
    descriptors['expectedTransactionPlanId']!.value;
  const approvalEvidence = descriptors['approvalEvidence']!.value;
  const projectRoot = descriptors['projectRoot']!.value;
  const currentTaktVersion = descriptors['currentTaktVersion']!.value;
  const baselineStrategy = descriptors['baselineStrategy']!.value;
  if (
    typeof cacheRoot !== 'string'
    || cacheRoot.length === 0
    || typeof receiptKey !== 'string'
    || !SHA256_PATTERN.test(receiptKey)
    || typeof expectedTransactionPlanId !== 'string'
    || !SHA256_PATTERN.test(expectedTransactionPlanId)
    || typeof projectRoot !== 'string'
    || projectRoot.length === 0
    || typeof currentTaktVersion !== 'string'
    || currentTaktVersion.length === 0
    || (baselineStrategy !== 'conflict'
      && baselineStrategy !== 'adopt-identical')
  ) invalidOptions();
  return Object.freeze({
    cacheRoot,
    receiptKey,
    expectedTransactionPlanId,
    approvalEvidence: approvalEvidence as ProjectTemplateApplyApprovalEvidence,
    projectRoot,
    currentTaktVersion,
    baselineStrategy,
    ...(descriptors['signal'] === undefined
      ? {}
      : { signal: descriptors['signal'].value as AbortSignal }),
  });
}

export async function applyGithubProjectTemplateRemoteTransaction(
  value: ApplyGithubProjectTemplateRemoteTransactionOptions,
): Promise<ProjectTemplateApplyResult> {
  // Trusted receipt verification and installed-state inspection are composed
  // internally in later stages; they are intentionally absent from options.
  void snapshotOptions(value);
  throw new GithubProjectTemplateRemoteApplyError(
    'TRUSTED_INFRASTRUCTURE_UNAVAILABLE',
  );
}
