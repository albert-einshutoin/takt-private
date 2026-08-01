import {
  consumeProjectTemplateApplyPreviewApproval,
  issueOwnedProjectTemplateApplyPreviewApproval,
  revokeProjectTemplateApplyPreviewApproval,
  type ProjectTemplateApplyPreviewApprovalEvidence,
} from './apply-preview-approval.js';
import { runProjectTemplateDoctor } from './apply-doctor.js';
import { inspectProjectTemplateApplyGuard } from './apply-guard.js';
import {
  acquireProjectTemplateApplyLease,
  assertProjectTemplateMutationLeaseOwned,
  type ProjectTemplateMutationLease,
} from './apply-lease.js';
import { initializeProjectTemplateApplyStorage } from './apply-storage.js';
import {
  executeOwnedProjectTemplateCompanionLockTransaction,
  ProjectTemplateCompanionLockRecoveryError,
  ProjectTemplateCompanionLockRollbackError,
} from './companion-lock-transaction.js';
import {
  ProjectTemplateCompanionLockStateError,
  readProjectTemplateCompanionLockState,
} from './companion-lock-state-reader.js';
import type {
  ProjectTemplateCliLocalApplyPort,
  ProjectTemplateCliLocalDerivedPlan,
  ProjectTemplateCliLocalExecutionResult,
} from './cli-local-apply-service.js';
import {
  deriveLocalProjectTemplateTransaction,
  type DerivedLocalProjectTemplateTransaction,
} from './local-transaction-derivation.js';
import { ProjectTemplateRemoteTransactionLinearizationError } from './remote-transaction-linearization.js';
import { ProjectTemplateValidationError, TaktpackError } from './errors.js';

interface ActiveLocalDerivation {
  readonly transactionPlanId: string;
  state: 'active' | 'consumed';
}

const LOCAL_DERIVATION_AUTHORITIES = new WeakMap<object, ActiveLocalDerivation>();

function conflictCount(
  derived: DerivedLocalProjectTemplateTransaction,
): number {
  return derived.preview.compositionConflicts.length
    + derived.preview.contentHardConflicts.length
    + (derived.preview.dependencyHardConflict ? 1 : 0)
    + (derived.preview.sourceHardConflict ? 1 : 0);
}

async function derive(options: {
  readonly cwd: string;
  readonly sourcePath: string;
  readonly currentTaktVersion: string;
  readonly signal?: AbortSignal;
}): Promise<ProjectTemplateCliLocalDerivedPlan> {
  const derived = await deriveLocalProjectTemplateTransaction({
    archivePath: options.sourcePath,
    projectRoot: options.cwd,
    currentTaktVersion: options.currentTaktVersion,
    baselineStrategy: 'adopt-identical',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const authority = Object.freeze({
    kind: 'project-template-local-derivation-authority' as const,
  });
  LOCAL_DERIVATION_AUTHORITIES.set(authority, {
    transactionPlanId: derived.preview.transactionPlanId,
    state: 'active',
  });
  const conflicts = conflictCount(derived);
  return Object.freeze({
    transactionPlanId: derived.preview.transactionPlanId,
    changeCount: derived.contentEntries.length,
    conflictCount: conflicts,
    dependencyCount: 0,
    reviewRequired: derived.preview.reviewRequired,
    hardConflict: derived.preview.hardConflict,
    defaultApplyPossible: derived.preview.defaultApplyPossible,
    forceApplicable:
      derived.preview.reviewRequired && !derived.preview.hardConflict,
    authority,
  });
}

function guardFailure(
  report: ReturnType<typeof inspectProjectTemplateApplyGuard>,
): ProjectTemplateCliLocalExecutionResult | undefined {
  if (report.passed) return undefined;
  const codes = report.blocks.map((block) => block.code);
  if (codes.includes('RECOVERY_REQUIRED') || codes.includes('RECOVERY_REQUIRED_UNKNOWN')) {
    return { status: 'recovery_required' };
  }
  if (codes.includes('APPLY_LEASE_PRESENT') || codes.includes('APPLY_LEASE_UNKNOWN')) {
    return { status: 'not_started', code: 'LEASE_UNAVAILABLE' };
  }
  return { status: 'not_started', code: 'APPLY_GUARD_BLOCKED' };
}

function deriveFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): ProjectTemplateCliLocalExecutionResult {
  if (
    signal?.aborted === true
    || (error instanceof TaktpackError && error.code === 'OPERATION_ABORTED')
    || (error instanceof Error && error.name === 'AbortError')
  ) return { status: 'not_started', code: 'INTERRUPTED' };
  if (
    error instanceof TaktpackError
    || error instanceof ProjectTemplateValidationError
    || error instanceof ProjectTemplateCompanionLockStateError
  ) return { status: 'not_started', code: 'SOURCE_INTEGRITY_FAILED' };
  return { status: 'not_started', code: 'SECURITY_GUARD' };
}

/** @internal Finalizes the closed result only after lease cleanup is proven. */
export function settleProjectTemplateCliLocalExecutionAfterLease(
  result: ProjectTemplateCliLocalExecutionResult,
  release: () => void,
): ProjectTemplateCliLocalExecutionResult {
  try {
    release();
    return result;
  } catch {
    return { status: 'indeterminate' };
  }
}

async function execute(options: {
  readonly cwd: string;
  readonly sourcePath: string;
  readonly currentTaktVersion: string;
  readonly expectedTransactionPlanId: string;
  readonly force: boolean;
  readonly derived: ProjectTemplateCliLocalDerivedPlan;
  readonly signal?: AbortSignal;
}): Promise<ProjectTemplateCliLocalExecutionResult> {
  const authority = typeof options.derived.authority === 'object'
    && options.derived.authority !== null
    ? LOCAL_DERIVATION_AUTHORITIES.get(options.derived.authority)
    : undefined;
  if (
    authority === undefined
    || authority.state !== 'active'
    || authority.transactionPlanId !== options.expectedTransactionPlanId
  ) return { status: 'not_started', code: 'SECURITY_GUARD' };
  authority.state = 'consumed';

  const initialBlock = guardFailure(inspectProjectTemplateApplyGuard({
    repoPath: options.cwd,
  }));
  if (initialBlock !== undefined) return initialBlock;

  let lease: ReturnType<typeof acquireProjectTemplateApplyLease>;
  try {
    lease = acquireProjectTemplateApplyLease(options.cwd);
  } catch {
    return { status: 'not_started', code: 'LEASE_UNAVAILABLE' };
  }
  let evidence: ProjectTemplateApplyPreviewApprovalEvidence | undefined;
  let storage: Awaited<ReturnType<typeof initializeProjectTemplateApplyStorage>>
    | undefined;
  let result: ProjectTemplateCliLocalExecutionResult;
  try {
    result = await (async (): Promise<ProjectTemplateCliLocalExecutionResult> => {
      assertProjectTemplateMutationLeaseOwned(
        options.cwd,
        lease as ProjectTemplateMutationLease,
      );
      const ownedBlock = guardFailure(inspectProjectTemplateApplyGuard({
        repoPath: options.cwd,
        ownedLease: lease,
      }));
      if (ownedBlock !== undefined) return ownedBlock;

      // The only mutation-authorizing plan is derived after lease acquisition.
      let fresh: DerivedLocalProjectTemplateTransaction;
      try {
        fresh = await deriveLocalProjectTemplateTransaction({
          archivePath: options.sourcePath,
          projectRoot: options.cwd,
          currentTaktVersion: options.currentTaktVersion,
          baselineStrategy: 'adopt-identical',
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        return deriveFailure(error, options.signal);
      }
      assertProjectTemplateMutationLeaseOwned(
        options.cwd,
        lease as ProjectTemplateMutationLease,
      );
      if (fresh.preview.transactionPlanId !== options.expectedTransactionPlanId) {
        return { status: 'not_started', code: 'TARGET_DRIFT' };
      }
      if (fresh.preview.hardConflict || conflictCount(fresh) !== 0) {
        return { status: 'not_started', code: 'SECURITY_GUARD' };
      }
      if (fresh.preview.reviewRequired && !options.force) {
        return { status: 'not_started', code: 'APPROVAL_REQUIRED' };
      }

      storage = await initializeProjectTemplateApplyStorage({ repoPath: options.cwd });
      assertProjectTemplateMutationLeaseOwned(
        options.cwd,
        lease as ProjectTemplateMutationLease,
      );
      if (fresh.preview.reviewRequired) {
        evidence = await issueOwnedProjectTemplateApplyPreviewApproval({
          projectRoot: options.cwd,
          storage,
          lease,
          preview: fresh.preview,
          baselineStrategy: 'adopt-identical',
        });
      }
      const committed = await executeOwnedProjectTemplateCompanionLockTransaction({
        storage,
        lease,
        transactionPlanId: fresh.preview.transactionPlanId,
        preconditionToken: fresh.preview.bindings.contentPreconditionToken,
        expectedPreviousLocksSha256:
          fresh.preview.bindings.previousLocksSha256,
        outputs: {
          contentEntries: fresh.contentEntries,
          mergeBaselines: fresh.mergeBaselines,
          ...fresh.companionOutputs,
        },
        async consumeApproval() {
          if (evidence === undefined) return true;
          return await consumeProjectTemplateApplyPreviewApproval({
            storage: storage!,
            preview: fresh.preview,
            baselineStrategy: 'adopt-identical',
            evidence,
          });
        },
        runDoctor() {
          if (!runProjectTemplateDoctor(options.cwd).passed) {
            throw new Error('project template doctor rejected local transaction');
          }
          if (readProjectTemplateCompanionLockState(options.cwd).state !== 'update') {
            throw new Error('project template companion cohort is incomplete');
          }
        },
      });
      return {
        status: 'committed',
        backupId: committed.backupId,
        transactionPlanId: committed.planId,
      };
    })();
  } catch (error) {
    let revocationFailed = false;
    if (storage !== undefined && evidence !== undefined) {
      try {
        await revokeProjectTemplateApplyPreviewApproval({ storage, evidence });
      } catch {
        revocationFailed = true;
      }
    }
    if (revocationFailed) result = { status: 'indeterminate' };
    else if (
      error instanceof ProjectTemplateCompanionLockRollbackError
      || error instanceof ProjectTemplateCompanionLockRecoveryError
    ) result = { status: 'recovery_required' };
    else if (error instanceof ProjectTemplateRemoteTransactionLinearizationError) {
      result = error.code === 'PUBLISH_FAILED'
        ? { status: 'not_started', code: 'APPLY_FAILED_ROLLED_BACK' }
        : { status: 'not_started', code: 'APPROVAL_INVALID' };
    } else result = deriveFailure(error, options.signal);
  }
  return settleProjectTemplateCliLocalExecutionAfterLease(
    result,
    () => lease.release(),
  );
}

export function createProductionProjectTemplateCliLocalApplyPort():
ProjectTemplateCliLocalApplyPort {
  return Object.freeze({
    inspectGuard(cwd) {
      return inspectProjectTemplateApplyGuard({ repoPath: cwd });
    },
    derive,
    execute,
  });
}
