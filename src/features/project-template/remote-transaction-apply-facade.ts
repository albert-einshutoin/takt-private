import { types } from 'node:util';
import type {
  ProjectTemplateApplyPreviewApprovalEvidence,
} from './apply-preview-approval.js';
import {
  consumeProjectTemplateApplyPreviewApproval,
  validateProjectTemplateApplyPreviewApproval,
} from './apply-preview-approval.js';
import type { ProjectTemplateApplyResult } from './apply-executor.js';
import { initializeProjectTemplateApplyStorage } from './apply-storage.js';
import {
  inspectProjectTemplateApplyGuard,
} from './apply-guard.js';
import {
  acquireProjectTemplateApplyLease,
  assertProjectTemplateMutationLeaseOwned,
  type ProjectTemplateApplyLease,
  type ProjectTemplateMutationLease,
} from './apply-lease.js';
import { resolve } from 'node:path';
import {
  assertClaimedVerifiedGithubTemplateDownloadReceiptForPreview,
  claimVerifiedGithubTemplateDownloadReceiptForApply,
  consumeVerifiedGithubTemplateDownloadReceiptApplyClaim,
  readGithubTemplateDownloadReceiptByReceiptKey,
} from './github-download-receipt-offline-read.js';
import type {
  GithubTemplateDownloadReceiptVerifier,
} from './github-download-receipt-storage.js';
import type {
  ProjectTemplateRepertoireDependencyInspectionPort,
} from './repertoire-dependency-inspection-port.js';
import {
  deriveGithubTemplateDownloadArtifactPaths,
} from './github-download-receipt-paths.js';
import { materializeTaktpackContents } from './archive-inspector.js';
import {
  createRemotePreviewOperationContext,
} from './remote-preview-operation.js';
import {
  deriveGithubProjectTemplateRemoteTransaction,
} from './remote-transaction-derivation.js';
import {
  executeOwnedProjectTemplateCompanionLockTransaction,
} from './companion-lock-transaction.js';
import { runProjectTemplateDoctor } from './apply-doctor.js';
import { readProjectTemplateCompanionLockState } from './companion-lock-state-reader.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REMOTE_APPLY_DERIVATION_TIMEOUT_MS = 5_000;

export type GithubProjectTemplateRemoteApplyErrorCode =
  | 'INVALID_OPTIONS'
  | 'INVALID_AUTHORITY'
  | 'TRANSACTION_PLAN_MISMATCH'
  | 'HARD_CONFLICT'
  | 'APPROVAL_INVALID'
  | 'TRUSTED_INFRASTRUCTURE_UNAVAILABLE';

export class GithubProjectTemplateRemoteApplyError extends Error {
  readonly operatorDetail: string;

  constructor(public readonly code: GithubProjectTemplateRemoteApplyErrorCode) {
    super(code === 'INVALID_OPTIONS'
      ? 'GitHub project template remote apply options are invalid'
      : code === 'INVALID_AUTHORITY'
        ? 'GitHub project template remote apply authority is invalid'
        : code === 'TRANSACTION_PLAN_MISMATCH'
          ? 'GitHub project template remote transaction plan changed'
          : code === 'HARD_CONFLICT'
            ? 'GitHub project template remote transaction has a hard conflict'
            : code === 'APPROVAL_INVALID'
              ? 'GitHub project template remote approval is invalid'
              : 'GitHub project template remote apply infrastructure is unavailable');
    this.name = 'GithubProjectTemplateRemoteApplyError';
    // Fixed operator details remain useful for diagnostics without retaining
    // caller input, filesystem paths, receipt material, or inspection output.
    this.operatorDetail = code === 'INVALID_OPTIONS'
      ? 'public-options-rejected'
      : code === 'INVALID_AUTHORITY'
        ? 'process-local-authority-rejected'
        : code === 'TRANSACTION_PLAN_MISMATCH'
          ? 'fresh-transaction-id-differs'
          : code === 'HARD_CONFLICT'
            ? 'fresh-transaction-plan-is-not-executable'
            : code === 'APPROVAL_INVALID'
              ? 'fresh-preview-approval-not-authorized'
              : 'trusted-infrastructure-not-composed';
    Object.freeze(this);
  }
}

export interface ApplyGithubProjectTemplateRemoteTransactionOptions {
  readonly cacheRoot: string;
  readonly receiptKey: string;
  readonly expectedTransactionPlanId: string;
  readonly approvalEvidence: ProjectTemplateApplyPreviewApprovalEvidence;
  readonly projectRoot: string;
  readonly currentTaktVersion: string;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly signal?: AbortSignal;
}

interface ProjectTemplateRemoteApplyCompositionDependencies {
  readonly verifier: GithubTemplateDownloadReceiptVerifier;
  readonly repertoireInspectionPort:
    ProjectTemplateRepertoireDependencyInspectionPort;
}

export interface ProjectTemplateRemoteApplyComposition {
  apply(
    value: ApplyGithubProjectTemplateRemoteTransactionOptions,
  ): Promise<ProjectTemplateApplyResult>;
}

declare const remoteApplyLeaseExecutionClaimBrand: unique symbol;

export interface ProjectTemplateRemoteApplyLeaseExecutionClaim {
  readonly kind: 'project-template-remote-apply-lease-execution-claim';
  readonly [remoteApplyLeaseExecutionClaimBrand]: true;
}

interface ActiveRemoteApplyLeaseExecutionClaim {
  readonly projectRoot: string;
  readonly lease: ProjectTemplateMutationLease;
  state: 'active' | 'consumed';
}

const REMOTE_APPLY_LEASE_EXECUTION_CLAIMS = new WeakMap<
  ProjectTemplateRemoteApplyLeaseExecutionClaim,
  ActiveRemoteApplyLeaseExecutionClaim
>();

function invalidOptions(): never {
  throw new GithubProjectTemplateRemoteApplyError('INVALID_OPTIONS');
}

function invalidAuthority(): never {
  throw new GithubProjectTemplateRemoteApplyError('INVALID_AUTHORITY');
}

export function claimProjectTemplateRemoteApplyLeaseForExecution(value: {
  readonly projectRoot: string;
  readonly lease: ProjectTemplateApplyLease;
}): ProjectTemplateRemoteApplyLeaseExecutionClaim {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) invalidAuthority();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2
    || !keys.includes('projectRoot')
    || !keys.includes('lease')
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor))
  ) invalidAuthority();
  const projectRoot = descriptors['projectRoot']!.value;
  const lease = descriptors['lease']!.value as ProjectTemplateMutationLease;
  if (
    typeof projectRoot !== 'string'
    || projectRoot.length === 0
    || typeof lease !== 'object'
    || lease === null
  ) invalidAuthority();
  try {
    assertProjectTemplateMutationLeaseOwned(projectRoot, lease);
    if (lease.operation !== 'apply') invalidAuthority();
  } catch {
    invalidAuthority();
  }
  const claim = Object.freeze({
    kind: 'project-template-remote-apply-lease-execution-claim' as const,
  }) as ProjectTemplateRemoteApplyLeaseExecutionClaim;
  REMOTE_APPLY_LEASE_EXECUTION_CLAIMS.set(claim, {
    projectRoot: resolve(projectRoot),
    lease,
    state: 'active',
  });
  return claim;
}

export function consumeProjectTemplateRemoteApplyLeaseExecutionClaim(value: {
  readonly projectRoot: string;
  readonly claim: ProjectTemplateRemoteApplyLeaseExecutionClaim;
}): ProjectTemplateMutationLease {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) invalidAuthority();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2
    || !keys.includes('projectRoot')
    || !keys.includes('claim')
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor))
  ) invalidAuthority();
  const projectRoot = descriptors['projectRoot']!.value;
  const claim = descriptors['claim']!.value as
    ProjectTemplateRemoteApplyLeaseExecutionClaim;
  const active = (
    typeof claim === 'object' && claim !== null
  ) ? REMOTE_APPLY_LEASE_EXECUTION_CLAIMS.get(claim) : undefined;
  if (
    typeof projectRoot !== 'string'
    || active === undefined
    || active.state !== 'active'
    || active.projectRoot !== resolve(projectRoot)
  ) invalidAuthority();
  try {
    assertProjectTemplateMutationLeaseOwned(projectRoot, active.lease);
  } catch {
    invalidAuthority();
  }
  active.state = 'consumed';
  return active.lease;
}

function snapshotMethodPort<Method extends (...args: never[]) => unknown>(
  value: unknown,
  methodName: string,
): { readonly receiver: object; readonly method: Method } {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) invalidOptions();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const descriptor = descriptors[methodName];
  if (
    keys.length !== 1
    || keys[0] !== methodName
    || descriptor === undefined
    || !('value' in descriptor)
    || typeof descriptor.value !== 'function'
    || types.isProxy(descriptor.value)
  ) invalidOptions();
  return Object.freeze({ receiver: value, method: descriptor.value as Method });
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
    approvalEvidence:
      approvalEvidence as ProjectTemplateApplyPreviewApprovalEvidence,
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

/** @internal Trusted infrastructure composition; intentionally not root-exported. */
export function createProjectTemplateRemoteApplyComposition(
  value: ProjectTemplateRemoteApplyCompositionDependencies,
): ProjectTemplateRemoteApplyComposition {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) invalidOptions();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2
    || !keys.includes('verifier')
    || !keys.includes('repertoireInspectionPort')
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor))
  ) invalidOptions();
  const verifier = snapshotMethodPort<
    GithubTemplateDownloadReceiptVerifier['verify']
  >(descriptors['verifier']!.value, 'verify');
  const inspection = snapshotMethodPort<
    ProjectTemplateRepertoireDependencyInspectionPort['inspect']
  >(descriptors['repertoireInspectionPort']!.value, 'inspect');
  const trusted = Object.freeze({
    verifier: Object.freeze({
      verify: Object.freeze((request: Parameters<
        GithubTemplateDownloadReceiptVerifier['verify']
      >[0]) => Reflect.apply(verifier.method, verifier.receiver, [request])),
    }),
    repertoireInspectionPort: Object.freeze({
      inspect: Object.freeze((request: Parameters<
        ProjectTemplateRepertoireDependencyInspectionPort['inspect']
      >[0]) => Reflect.apply(inspection.method, inspection.receiver, [request])),
    }),
  });
  return Object.freeze({
    async apply(
      input: ApplyGithubProjectTemplateRemoteTransactionOptions,
    ): Promise<ProjectTemplateApplyResult> {
      const options = snapshotOptions(input);
      const operationContext = createRemotePreviewOperationContext(
        options.signal,
        performance.now() + REMOTE_APPLY_DERIVATION_TIMEOUT_MS,
      );
      const initialGuard = inspectProjectTemplateApplyGuard({
        repoPath: options.projectRoot,
      });
      if (!initialGuard.passed) {
        throw new GithubProjectTemplateRemoteApplyError(
          'TRUSTED_INFRASTRUCTURE_UNAVAILABLE',
        );
      }
      const lease = acquireProjectTemplateApplyLease(options.projectRoot);
      try {
        assertProjectTemplateMutationLeaseOwned(
          options.projectRoot,
          lease as ProjectTemplateMutationLease,
        );
        const ownedGuard = inspectProjectTemplateApplyGuard({
          repoPath: options.projectRoot,
          ownedLease: lease,
        });
        if (!ownedGuard.passed) {
          throw new GithubProjectTemplateRemoteApplyError(
            'TRUSTED_INFRASTRUCTURE_UNAVAILABLE',
          );
        }
        const verified = await readGithubTemplateDownloadReceiptByReceiptKey({
          cacheRoot: options.cacheRoot,
          receiptKey: options.receiptKey,
          verifier: trusted.verifier,
        });
        assertProjectTemplateMutationLeaseOwned(
          options.projectRoot,
          lease as ProjectTemplateMutationLease,
        );
        // Reservation follows the fresh authenticated read synchronously.
        const claim = claimVerifiedGithubTemplateDownloadReceiptForApply(
          verified,
        );
        let materialized: Awaited<ReturnType<
          typeof materializeTaktpackContents
        >>;
        try {
          const claimed =
            assertClaimedVerifiedGithubTemplateDownloadReceiptForPreview(
              claim,
              {
                cacheRoot: options.cacheRoot,
                receiptKey: options.receiptKey,
                artifactSha256: verified.artifactSha256,
              },
            );
          const artifactPaths = deriveGithubTemplateDownloadArtifactPaths({
            cacheRoot: options.cacheRoot,
            archiveSha256: claimed.artifactSha256,
          });
          materialized = await materializeTaktpackContents(
            artifactPaths.artifactPath,
            {
              currentTaktVersion: options.currentTaktVersion,
              ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
              deadlineMs: operationContext.deadlineMs,
            },
          );
          assertProjectTemplateMutationLeaseOwned(
            options.projectRoot,
            lease as ProjectTemplateMutationLease,
          );
          if (
            materialized.inspection.archiveSha256 !== claimed.artifactSha256
            || materialized.inspection.archiveSha256
              !== claimed.receipt.payload.archive.sha256
            || materialized.inspection.manifestSha256
              !== claimed.receipt.payload.archive.manifestSha256
            || materialized.inspection.manifestSha256
              !== claimed.inspection.manifestSha256
          ) {
            throw new GithubProjectTemplateRemoteApplyError(
              'TRUSTED_INFRASTRUCTURE_UNAVAILABLE',
            );
          }
        } finally {
          consumeVerifiedGithubTemplateDownloadReceiptApplyClaim(claim);
        }
        const derived = await deriveGithubProjectTemplateRemoteTransaction({
          verified,
          materialized,
          receiptKey: options.receiptKey,
          projectRoot: options.projectRoot,
          currentTaktVersion: options.currentTaktVersion,
          repertoireInspectionPort: trusted.repertoireInspectionPort,
          baselineStrategy: options.baselineStrategy,
          operationContext,
          assertAuthority() {
            assertProjectTemplateMutationLeaseOwned(
              options.projectRoot,
              lease as ProjectTemplateMutationLease,
            );
          },
        });
        assertProjectTemplateMutationLeaseOwned(
          options.projectRoot,
          lease as ProjectTemplateMutationLease,
        );
        const preview = derived.preview;
        if (preview.transactionPlanId !== options.expectedTransactionPlanId) {
          throw new GithubProjectTemplateRemoteApplyError(
            'TRANSACTION_PLAN_MISMATCH',
          );
        }
        if (preview.hardConflict) {
          throw new GithubProjectTemplateRemoteApplyError('HARD_CONFLICT');
        }
        const storage = await initializeProjectTemplateApplyStorage({
          repoPath: options.projectRoot,
        });
        assertProjectTemplateMutationLeaseOwned(
          options.projectRoot,
          lease as ProjectTemplateMutationLease,
        );
        if (!await validateProjectTemplateApplyPreviewApproval({
          storage,
          preview,
          baselineStrategy: options.baselineStrategy,
          evidence: options.approvalEvidence,
        })) {
          throw new GithubProjectTemplateRemoteApplyError('APPROVAL_INVALID');
        }
        assertProjectTemplateMutationLeaseOwned(
          options.projectRoot,
          lease as ProjectTemplateMutationLease,
        );
        return await executeOwnedProjectTemplateCompanionLockTransaction({
          storage,
          lease,
          transactionPlanId: preview.transactionPlanId,
          preconditionToken: preview.bindings.contentPreconditionToken,
          outputs: {
            contentEntries: derived.contentEntries,
            ...derived.companionOutputs,
          },
          async consumeApproval() {
            return await consumeProjectTemplateApplyPreviewApproval({
              storage,
              preview,
              baselineStrategy: options.baselineStrategy,
              evidence: options.approvalEvidence,
            });
          },
          runDoctor() {
            if (!runProjectTemplateDoctor(options.projectRoot).passed) {
              throw new Error('project template doctor rejected transaction');
            }
            // The cohort reader proves all three companion files are from one
            // semantically consistent generation before commit is durable.
            if (
              readProjectTemplateCompanionLockState(options.projectRoot).state
                !== 'update'
            ) throw new Error('project template companion cohort is incomplete');
          },
        });
      } finally {
        lease.release();
      }
    },
  });
}
