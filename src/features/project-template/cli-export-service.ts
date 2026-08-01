import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ProjectTemplateExportOptions, ProjectTemplateExportPlan } from './archive-types.js';
import {
  captureTaktpackOutputPrecondition,
  writeTaktpackWithOutputPrecondition,
  type CapturedTaktpackOutputPrecondition,
  type TaktpackOutputPreconditionProjection,
  type TaktpackWriterIoSeam,
} from './archive-writer.js';
import { inspectProjectTemplateApplyGuard } from './apply-guard.js';
import { canonicalizeTaktpackJson } from './canonical-json.js';
import {
  createProjectTemplateCliFailure,
  createProjectTemplateCliSuccess,
  projectTemplateCliExitCodeForErrorCode,
  type ProjectTemplateCliErrorCode,
  type ProjectTemplateCliMutationOptions,
  type ProjectTemplateCliOutcome,
  type ProjectTemplateCliReadiness,
  type ProjectTemplateCliReviewCode,
} from './cli-machine-contract.js';
import { TaktpackError } from './errors.js';
import {
  consumeProjectTemplateCliMutationAdmission,
  ProjectTemplateCliInvalidAdmission,
  snapshotProjectTemplateCliOwnData,
  type ProjectTemplateCliMutationAdmission,
} from './cli-lifecycle.js';
import {
  createProjectTemplateExportPlan,
  getProjectTemplateExportSourceState,
} from './export-plan.js';
import {
  isProjectTemplateCliExportApprovalError,
  snapshotProjectTemplateExportApprovals,
  type ProjectTemplateExportApprovalProjection,
} from './cli-export-approvals.js';

const EXPORT_PLAN_DOMAIN = 'takt.project-template.cli-export-plan.v1';

interface ProjectTemplateCliExportInput {
  readonly projectRoot: string;
  readonly outputPath: string;
  readonly exportOptions: ProjectTemplateExportOptions;
  readonly mutation: ProjectTemplateCliMutationOptions;
  readonly signal?: AbortSignal;
  readonly admitMutation?: ProjectTemplateCliMutationAdmission;
}

interface PlannedExport {
  readonly plan: ProjectTemplateExportPlan;
  readonly planId: string;
  readonly absentTargetPlanId: string;
  readonly output: CapturedTaktpackOutputPrecondition;
}

export type ProjectTemplateCliExportPhase =
  | 'after-project-root'
  | 'after-export-plan'
  | 'after-output-capture'
  | 'before-dry-run-success'
  | 'after-final-output-capture';

export interface ProjectTemplateCliExportTestSeam {
  readonly onPhase?: (phase: ProjectTemplateCliExportPhase) => void;
  readonly writerIoSeam?: TaktpackWriterIoSeam;
}

class CliExportBoundaryError extends Error {
  constructor(readonly code: ProjectTemplateCliErrorCode) {
    super('project template CLI export boundary rejected the operation');
    this.name = 'CliExportBoundaryError';
  }
}

function failure(
  mode: ProjectTemplateCliMutationOptions['mode'],
  code: ProjectTemplateCliErrorCode,
): ProjectTemplateCliOutcome {
  return {
    envelope: createProjectTemplateCliFailure({
      command: 'project-template export',
      mode,
      code,
    }),
    exitCode: projectTemplateCliExitCodeForErrorCode(code),
  };
}

function calculatePlanId(
  projectRoot: string,
  plan: ProjectTemplateExportPlan,
  output: TaktpackOutputPreconditionProjection,
  approvals: ProjectTemplateExportApprovalProjection,
): string {
  const state = getProjectTemplateExportSourceState(plan);
  if (state === undefined) throw new CliExportBoundaryError('INTERNAL');
  const source = {
    projectRoot,
    rootRealPath: state.rootRealPath,
    rootSnapshot: state.rootSnapshot,
    files: state.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      mode: file.mode,
      sha256: file.sha256,
      snapshot: file.snapshot,
    })),
  };
  // Why: this identifier is a CLI authorization token, not an archive hash.
  // Domain separation prevents a content digest from being replayed as consent.
  // Force remains apply-time authorization rather than plan identity so the documented
  // dry-run can approve the exact existing output before --apply --force replaces it.
  return createHash('sha256').update(canonicalizeTaktpackJson({
    domain: EXPORT_PLAN_DOMAIN,
    source,
    plan: {
      descriptor: plan.descriptor,
      manifest: plan.manifest,
      lock: plan.lock,
      report: plan.report,
    },
    approvals: {
      policies: approvals.policies,
      approvedCapabilities: approvals.approvedCapabilities,
    },
    output,
  })).digest('hex');
}

async function createPlannedExport(
  input: ProjectTemplateCliExportInput,
  projectRoot: string,
  approvals: ProjectTemplateExportApprovalProjection,
  testSeam: ProjectTemplateCliExportTestSeam,
): Promise<PlannedExport> {
  const plan = await createProjectTemplateExportPlan(projectRoot, input.exportOptions);
  testSeam.onPhase?.('after-export-plan');
  input.signal?.throwIfAborted();
  const output = await captureTaktpackOutputPrecondition(input.outputPath, {
    forbiddenRoot: join(projectRoot, '.takt'),
  });
  testSeam.onPhase?.('after-output-capture');
  input.signal?.throwIfAborted();
  const planId = calculatePlanId(
    projectRoot, plan, output.projection, approvals,
  );
  const absentTargetPlanId = calculatePlanId(projectRoot, plan, {
    ...output.projection,
    target: { state: 'absent' },
  }, approvals);
  return { plan, planId, absentTargetPlanId, output };
}

function guardSummary(projectRoot: string): {
  readonly readiness: ProjectTemplateCliReadiness;
  readonly reviewCodes: readonly ProjectTemplateCliReviewCode[];
  readonly applyError?: ProjectTemplateCliErrorCode;
} {
  const blocks = inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).blocks;
  if (blocks.length === 0) return { readiness: 'ready', reviewCodes: [] };
  // Why: recovery means a prior mutation has indeterminate durable state, so it must
  // retain the recovery/exit-25 contract even when an active run is also present.
  if (blocks.some((block) => block.code === 'RECOVERY_REQUIRED'
    || block.code === 'RECOVERY_REQUIRED_UNKNOWN')) {
    return {
      readiness: 'recovery-required',
      reviewCodes: ['RECOVERY_REQUIRED'],
      applyError: 'RECOVERY_REQUIRED',
    };
  }
  if (blocks.some((block) => block.code === 'ACTIVE_RUN' || block.code === 'STALE_RUN')) {
    return { readiness: 'blocked', reviewCodes: ['ACTIVE_RUN'], applyError: 'ACTIVE_RUN' };
  }
  return { readiness: 'blocked', reviewCodes: ['HARD_CONFLICT'], applyError: 'SECURITY_GUARD' };
}

function mapError(error: unknown): ProjectTemplateCliErrorCode {
  if (error instanceof CliExportBoundaryError) return error.code;
  if (isProjectTemplateCliExportApprovalError(error)) return 'SECURITY_GUARD';
  if (error instanceof Error && error.name === 'AbortError') return 'INTERRUPTED';
  if (!(error instanceof TaktpackError)) return 'INTERNAL';
  switch (error.code) {
    case 'EXPORT_REVIEW_REQUIRED': return 'REVIEW_REQUIRED';
    case 'SOURCE_CHANGED': return 'PLAN_DRIFT';
    case 'OUTPUT_EXISTS':
      return 'TARGET_DRIFT';
    case 'UNSAFE_OUTPUT_TARGET':
      return error.field === 'outputCapture'
        ? 'SECURITY_GUARD'
        : error.artifactState === 'published'
          ? 'RESULT_INDETERMINATE'
          : 'TARGET_DRIFT';
    case 'OPERATION_ABORTED': return 'INTERRUPTED';
    case 'OPERATION_TIMEOUT': return 'SOURCE_UNAVAILABLE';
    case 'HASH_MISMATCH': return 'SOURCE_INTEGRITY_FAILED';
    case 'DURABILITY_FAILED':
    case 'CLEANUP_FAILED':
      return error.artifactState === 'published' ? 'RESULT_INDETERMINATE' : 'INTERNAL';
    case 'INVALID_EXPORT_PLAN':
      return error.field === 'policies' || error.field === 'approvedCapabilities'
        ? 'INVALID_ARGUMENT' : 'SECURITY_GUARD';
    case 'ARCHIVE_LIMIT_EXCEEDED':
    case 'UNSAFE_ARCHIVE_ENTRY':
    case 'INVALID_ARCHIVE_ORDER':
    case 'DUPLICATE_ARCHIVE_ENTRY':
    case 'TRUNCATED_ARCHIVE':
    case 'TRAILING_ARCHIVE_DATA':
    case 'INVALID_PACK':
    case 'MISSING_ARCHIVE_ENTRY':
    case 'ORPHAN_BLOB': return 'SECURITY_GUARD';
    case 'ARCHIVE_READ_FAILED': return 'SOURCE_UNAVAILABLE';
    case 'ARCHIVE_WRITE_FAILED': return 'INTERNAL';
  }
}

export async function executeProjectTemplateCliExport(
  input: ProjectTemplateCliExportInput,
  testSeam: ProjectTemplateCliExportTestSeam = {},
): Promise<ProjectTemplateCliOutcome> {
  let mode: ProjectTemplateCliMutationOptions['mode'] = 'dry-run';
  let mutationAdmitted = false;
  try {
    const snapshot = snapshotProjectTemplateCliOwnData(input,
      ['projectRoot', 'outputPath', 'exportOptions', 'mutation'],
      ['signal', 'admitMutation']);
    const mutation = snapshotProjectTemplateCliOwnData(snapshot['mutation'],
      ['mode', 'force'], ['expectedPlanId']);
    const applyMode = mutation['mode'] === 'apply';
    if ((!applyMode && mutation['mode'] !== 'dry-run')
      || typeof mutation['force'] !== 'boolean'
      || (applyMode && (!('expectedPlanId' in mutation) || !('admitMutation' in snapshot)))
      || typeof snapshot['projectRoot'] !== 'string' || typeof snapshot['outputPath'] !== 'string'
      || (snapshot['signal'] !== undefined && !(snapshot['signal'] instanceof AbortSignal))) {
      throw new ProjectTemplateCliInvalidAdmission();
    }
    mode = mutation['mode'] as ProjectTemplateCliMutationOptions['mode'];
    const rawExportOptions = snapshotProjectTemplateCliOwnData(snapshot['exportOptions'],
      ['packVersion', 'takt', 'source'], ['policies', 'approvedCapabilities']);
    const approvalSnapshot = snapshotProjectTemplateExportApprovals(rawExportOptions);
    const exportOptions: ProjectTemplateExportOptions = {
      packVersion: rawExportOptions['packVersion'] as string,
      takt: rawExportOptions['takt'] as ProjectTemplateExportOptions['takt'],
      source: rawExportOptions['source'] as ProjectTemplateExportOptions['source'],
      policies: approvalSnapshot.options.policies,
      approvedCapabilities: approvalSnapshot.options.approvedCapabilities,
    };
    input = { ...snapshot, mutation, exportOptions } as unknown as ProjectTemplateCliExportInput;
    input.signal?.throwIfAborted();
    if (!isAbsolute(input.projectRoot)) throw new CliExportBoundaryError('INVALID_ARGUMENT');
    const projectRoot = await realpath(resolve(input.projectRoot));
    testSeam.onPhase?.('after-project-root');
    input.signal?.throwIfAborted();
    const initialGuard = guardSummary(projectRoot);
    if (mode === 'apply' && initialGuard.applyError !== undefined) {
      return failure(mode, initialGuard.applyError);
    }
    const approvals = approvalSnapshot.projection;
    const planned = await createPlannedExport(input, projectRoot, approvals, testSeam);
    const reviewSummary = initialGuard.readiness === 'ready'
      && planned.output.projection.target.state === 'regular-file'
      ? {
        readiness: 'review-required' as const,
        reviewCodes: ['REVIEW_REQUIRED'] as const,
      }
      : initialGuard;
    const baseResult = {
      planId: planned.planId,
      entryCount: planned.plan.manifest.entries.length,
      archiveBytes: 0,
      // Export does not resolve repertoire dependencies; dependency planning
      // belongs to inspect/diff and therefore remains explicitly empty here.
      dependencyCount: 0,
      readiness: reviewSummary.readiness,
      reviewCodes: reviewSummary.reviewCodes,
    };
    if (mode === 'dry-run') {
      testSeam.onPhase?.('before-dry-run-success');
      input.signal?.throwIfAborted();
      return {
        envelope: createProjectTemplateCliSuccess({
          command: 'project-template export',
          mode,
          result: baseResult,
        }),
        exitCode: 0,
      };
    }
    const applyMutation = input.mutation as Extract<ProjectTemplateCliMutationOptions, { mode: 'apply' }>;
    if (applyMutation.expectedPlanId !== planned.planId) {
      const code = planned.output.projection.target.state === 'regular-file'
        && applyMutation.expectedPlanId === planned.absentTargetPlanId
        ? 'TARGET_DRIFT'
        : 'PLAN_DRIFT';
      return failure(mode, code);
    }
    const finalGuard = guardSummary(projectRoot);
    if (finalGuard.applyError !== undefined) return failure(mode, finalGuard.applyError);
    if (!input.mutation.force && planned.output.projection.target.state !== 'absent') {
      // Why: the exact plan already binds this regular output. Missing force is
      // an approval decision, not evidence that the target changed after review.
      return failure(mode, 'APPROVAL_REQUIRED');
    }
    input.signal?.throwIfAborted();
    const finalOutput = await captureTaktpackOutputPrecondition(input.outputPath, {
      forbiddenRoot: join(projectRoot, '.takt'),
    });
    testSeam.onPhase?.('after-final-output-capture');
    input.signal?.throwIfAborted();
    const finalPlanId = calculatePlanId(
      projectRoot,
      planned.plan,
      finalOutput.projection,
      approvals,
    );
    if (finalPlanId !== planned.planId) return failure(mode, 'TARGET_DRIFT');
    try {
      consumeProjectTemplateCliMutationAdmission(input.admitMutation);
      mutationAdmitted = true;
    } catch (error) {
      return failure(mode, input.signal?.aborted === true ? 'INTERRUPTED'
        : error instanceof ProjectTemplateCliInvalidAdmission ? 'SECURITY_GUARD' : 'INTERNAL');
    }
    const archive = await writeTaktpackWithOutputPrecondition(
      input.outputPath,
      planned.plan,
      finalOutput.authority,
      { force: input.mutation.force },
      testSeam.writerIoSeam,
    );
    return {
      envelope: createProjectTemplateCliSuccess({
        command: 'project-template export',
        mode,
        result: {
          ...baseResult,
          archiveBytes: archive.bytes,
          packId: archive.archiveSha256,
        },
      }),
      exitCode: 0,
    };
  } catch (error) {
    if (mutationAdmitted) return failure(mode, 'RESULT_INDETERMINATE');
    if (error instanceof ProjectTemplateCliInvalidAdmission) {
      return failure(mode, 'SECURITY_GUARD');
    }
    return failure(mode, mapError(error));
  }
}
