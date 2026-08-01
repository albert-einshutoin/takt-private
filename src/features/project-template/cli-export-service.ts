import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Stats } from 'node:fs';
import type { ProjectTemplateExportOptions, ProjectTemplateExportPlan } from './archive-types.js';
import { writeTaktpack } from './archive-writer.js';
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
  createProjectTemplateExportPlan,
  getProjectTemplateExportSourceState,
} from './export-plan.js';

const EXPORT_PLAN_DOMAIN = 'takt.project-template.cli-export-plan.v1';

interface ProjectTemplateCliExportInput {
  readonly projectRoot: string;
  readonly outputPath: string;
  readonly exportOptions: ProjectTemplateExportOptions;
  readonly mutation: ProjectTemplateCliMutationOptions;
  readonly signal?: AbortSignal;
}

interface StatIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
  readonly size: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface OutputPrecondition {
  readonly canonicalPath: string;
  readonly parent: {
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly uid: number;
    readonly gid: number;
  };
  readonly target: { readonly state: 'absent' } | {
    readonly state: 'regular-file';
    readonly snapshot: StatIdentity;
  };
}

interface PlannedExport {
  readonly plan: ProjectTemplateExportPlan;
  readonly planId: string;
  readonly absentTargetPlanId: string;
  readonly output: OutputPrecondition;
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

function statIdentity(stat: Stats): StatIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function inspectOutputPrecondition(
  projectRoot: string,
  outputPath: string,
): Promise<OutputPrecondition> {
  if (!isAbsolute(outputPath) || basename(outputPath) === '.' || basename(outputPath) === '..') {
    throw new CliExportBoundaryError('INVALID_ARGUMENT');
  }
  const requestedParent = dirname(resolve(outputPath));
  let canonicalParent: string;
  let parentStat: Stats;
  try {
    canonicalParent = await realpath(requestedParent);
    parentStat = await lstat(canonicalParent);
  } catch {
    throw new CliExportBoundaryError('SECURITY_GUARD');
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new CliExportBoundaryError('SECURITY_GUARD');
  }
  const permissions = parentStat.mode & 0o7777;
  if ((permissions & 0o002) !== 0 && (permissions & 0o1000) === 0) {
    throw new CliExportBoundaryError('SECURITY_GUARD');
  }
  const canonicalPath = join(canonicalParent, basename(outputPath));
  const taktRoot = join(projectRoot, '.takt');
  if (isInside(taktRoot, canonicalPath)) {
    // Why: placing the archive under its own scanned source makes the export
    // mutate the snapshot it is proving and can recursively package artifacts.
    throw new CliExportBoundaryError('SECURITY_GUARD');
  }

  let target: OutputPrecondition['target'];
  try {
    const targetStat = await lstat(canonicalPath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) {
      throw new CliExportBoundaryError('SECURITY_GUARD');
    }
    target = { state: 'regular-file', snapshot: statIdentity(targetStat) };
  } catch (error) {
    if (error instanceof CliExportBoundaryError) throw error;
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new CliExportBoundaryError('SECURITY_GUARD');
    }
    target = { state: 'absent' };
  }
  return {
    canonicalPath,
    parent: {
      dev: parentStat.dev,
      ino: parentStat.ino,
      mode: parentStat.mode,
      uid: parentStat.uid,
      gid: parentStat.gid,
    },
    target,
  };
}

function calculatePlanId(
  projectRoot: string,
  plan: ProjectTemplateExportPlan,
  output: OutputPrecondition,
  force: boolean,
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
  return createHash('sha256').update(canonicalizeTaktpackJson({
    domain: EXPORT_PLAN_DOMAIN,
    force,
    source,
    plan: {
      descriptor: plan.descriptor,
      manifest: plan.manifest,
      lock: plan.lock,
      report: plan.report,
    },
    output,
  })).digest('hex');
}

async function createPlannedExport(
  input: ProjectTemplateCliExportInput,
  projectRoot: string,
): Promise<PlannedExport> {
  const plan = await createProjectTemplateExportPlan(projectRoot, input.exportOptions);
  const output = await inspectOutputPrecondition(projectRoot, input.outputPath);
  const planId = calculatePlanId(projectRoot, plan, output, input.mutation.force);
  const absentTargetPlanId = calculatePlanId(projectRoot, plan, {
    ...output,
    target: { state: 'absent' },
  }, input.mutation.force);
  return { plan, planId, absentTargetPlanId, output };
}

function guardSummary(projectRoot: string): {
  readonly readiness: ProjectTemplateCliReadiness;
  readonly reviewCodes: readonly ProjectTemplateCliReviewCode[];
  readonly applyError?: ProjectTemplateCliErrorCode;
} {
  const blocks = inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).blocks;
  if (blocks.length === 0) return { readiness: 'ready', reviewCodes: [] };
  if (blocks.some((block) => block.code === 'ACTIVE_RUN' || block.code === 'STALE_RUN')) {
    return { readiness: 'blocked', reviewCodes: ['ACTIVE_RUN'], applyError: 'ACTIVE_RUN' };
  }
  if (blocks.some((block) => block.code === 'RECOVERY_REQUIRED'
    || block.code === 'RECOVERY_REQUIRED_UNKNOWN')) {
    return {
      readiness: 'recovery-required',
      reviewCodes: ['RECOVERY_REQUIRED'],
      applyError: 'RECOVERY_REQUIRED',
    };
  }
  return { readiness: 'blocked', reviewCodes: ['HARD_CONFLICT'], applyError: 'SECURITY_GUARD' };
}

function mapError(error: unknown): ProjectTemplateCliErrorCode {
  if (error instanceof CliExportBoundaryError) return error.code;
  if (error instanceof Error && error.name === 'AbortError') return 'INTERRUPTED';
  if (!(error instanceof TaktpackError)) return 'INTERNAL';
  switch (error.code) {
    case 'EXPORT_REVIEW_REQUIRED': return 'REVIEW_REQUIRED';
    case 'SOURCE_CHANGED': return 'PLAN_DRIFT';
    case 'OUTPUT_EXISTS':
    case 'UNSAFE_OUTPUT_TARGET': return 'TARGET_DRIFT';
    case 'OPERATION_ABORTED': return 'INTERRUPTED';
    case 'OPERATION_TIMEOUT': return 'SOURCE_UNAVAILABLE';
    case 'HASH_MISMATCH': return 'SOURCE_INTEGRITY_FAILED';
    case 'DURABILITY_FAILED':
    case 'CLEANUP_FAILED':
      return error.artifactState === 'published' ? 'RESULT_INDETERMINATE' : 'INTERNAL';
    case 'INVALID_EXPORT_PLAN':
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
): Promise<ProjectTemplateCliOutcome> {
  const mode = input.mutation.mode;
  try {
    input.signal?.throwIfAborted();
    if (!isAbsolute(input.projectRoot)) throw new CliExportBoundaryError('INVALID_ARGUMENT');
    const projectRoot = await realpath(resolve(input.projectRoot));
    const initialGuard = guardSummary(projectRoot);
    if (mode === 'apply' && initialGuard.applyError !== undefined) {
      return failure(mode, initialGuard.applyError);
    }
    const planned = await createPlannedExport(input, projectRoot);
    const baseResult = {
      planId: planned.planId,
      entryCount: planned.plan.manifest.entries.length,
      archiveBytes: 0,
      // Export does not resolve repertoire dependencies; dependency planning
      // belongs to inspect/diff and therefore remains explicitly empty here.
      dependencyCount: 0,
      readiness: initialGuard.readiness,
      reviewCodes: initialGuard.reviewCodes,
    };
    if (mode === 'dry-run') {
      return {
        envelope: createProjectTemplateCliSuccess({
          command: 'project-template export',
          mode,
          result: baseResult,
        }),
        exitCode: 0,
      };
    }
    if (input.mutation.expectedPlanId !== planned.planId) {
      const code = planned.output.target.state === 'regular-file'
        && input.mutation.expectedPlanId === planned.absentTargetPlanId
        ? 'TARGET_DRIFT'
        : 'PLAN_DRIFT';
      return failure(mode, code);
    }
    const finalGuard = guardSummary(projectRoot);
    if (finalGuard.applyError !== undefined) return failure(mode, finalGuard.applyError);
    if (!input.mutation.force && planned.output.target.state !== 'absent') {
      return failure(mode, 'TARGET_DRIFT');
    }
    input.signal?.throwIfAborted();
    const finalOutput = await inspectOutputPrecondition(projectRoot, input.outputPath);
    const finalPlanId = calculatePlanId(
      projectRoot,
      planned.plan,
      finalOutput,
      input.mutation.force,
    );
    if (finalPlanId !== planned.planId) return failure(mode, 'TARGET_DRIFT');
    const archive = await writeTaktpack(finalOutput.canonicalPath, planned.plan, {
      force: input.mutation.force,
      signal: input.signal,
    });
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
    return failure(mode, mapError(error));
  }
}
