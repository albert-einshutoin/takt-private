/**
 * RunMeta — 実行メタデータの管理モジュール
 *
 * ランのメタデータ（task, workflow, status, 開始・終了時刻など）を
 * .takt/runs/{slug}/meta.json へ書き出す責務を担う。
 */

import { writeFileAtomic, ensureDir } from '../../../infra/config/index.js';
import type { RunMeta } from '../../../core/workflow/run/run-meta.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import type { WorkflowResumePoint } from '../../../core/models/index.js';
import type { WorkflowTraceDiscovery } from '../../../core/workflow/observability/traceDiscovery.js';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertProjectTemplateRunStartPermitOwned,
  ProjectTemplateCoordinationError,
  withProjectTemplateRunStartPermit,
  type ProjectTemplateRunStartPermit,
} from '../../project-template/apply-lease.js';

export interface DirectResumeMetadata {
  readonly sourceRunSlug: string;
  readonly resumeMode: 'requeue' | 'retry' | 'instruct';
}

export interface RunMetaManagerOptions {
  readonly traceDiscovery?: WorkflowTraceDiscovery;
  readonly projectTemplateRunStartPermit?: ProjectTemplateRunStartPermit;
  readonly projectTemplateCoordinationRoot?: string;
  readonly writeRunMetaFile?: (path: string, content: string) => void;
}

type PersistedRunMeta = Omit<RunMeta, 'resumePoint' | 'sourceRunSlug' | 'resumeMode'> & {
  resume_point?: WorkflowResumePoint;
  source_run_slug?: string;
  resume_mode?: DirectResumeMetadata['resumeMode'];
};

export class RunMetaManager {
  private readonly runMeta: RunMeta;
  private readonly metaAbs: string;
  private readonly mirrorMetaAbs?: string;
  private readonly mirrorRunRootAbs?: string;
  private readonly writeRunMetaFile: (path: string, content: string) => void;
  private finalized = false;

  constructor(
    runPaths: RunPaths,
    task: string,
    workflowName: string,
    directResume?: DirectResumeMetadata,
    options?: RunMetaManagerOptions,
  ) {
    this.metaAbs = runPaths.metaAbs;
    this.writeRunMetaFile = options?.writeRunMetaFile ?? writeFileAtomic;
    if (
      options?.projectTemplateCoordinationRoot !== undefined
      && options.projectTemplateRunStartPermit === undefined
    ) {
      throw new ProjectTemplateCoordinationError();
    }
    const actualProjectRoot = resolve(runPaths.runRootAbs, '../../..');
    const coordinationRoot = options?.projectTemplateCoordinationRoot === undefined
      ? actualProjectRoot
      : resolve(options.projectTemplateCoordinationRoot);
    if (options?.projectTemplateCoordinationRoot !== undefined) {
      const canonicalActualRoot = realpathSync.native(actualProjectRoot);
      const canonicalCoordinationRoot = realpathSync.native(coordinationRoot);
      if (canonicalActualRoot !== canonicalCoordinationRoot) {
        const mirrorSlug = resolveProjectTemplateRunMirrorSlug(
          canonicalCoordinationRoot,
          canonicalActualRoot,
          runPaths.slug,
        );
        const mirrorPaths = buildMirrorRunPaths(coordinationRoot, mirrorSlug);
        this.mirrorMetaAbs = mirrorPaths.metaAbs;
        this.mirrorRunRootAbs = mirrorPaths.runRootAbs;
      }
    }
    this.runMeta = {
      task,
      workflow: workflowName,
      runSlug: runPaths.slug,
      runRoot: runPaths.runRootRel,
      reportDirectory: runPaths.reportsRel,
      contextDirectory: runPaths.contextRel,
      logsDirectory: runPaths.logsRel,
      status: 'running',
      startTime: new Date().toISOString(),
      ...(directResume ? {
        sourceRunSlug: directResume.sourceRunSlug,
        resumeMode: directResume.resumeMode,
      } : {}),
      ...(options?.traceDiscovery ? {
        observability: {
          traceDiscovery: options.traceDiscovery,
        },
      } : {}),
    };
    // Publish running evidence while holding the same short coordination
    // mutex used by template apply. This closes the preflight/start race.
    const projectRoot = coordinationRoot;
    const publishRunningEvidence = () => {
      ensureDir(runPaths.runRootAbs);
      if (this.mirrorRunRootAbs !== undefined) {
        ensureDir(this.mirrorRunRootAbs);
      }
      this.writeRunMeta(this.runMeta);
    };
    // Some embedding callers intentionally bootstrap a brand-new project path.
    // No template apply can own a lease before that root exists, so preserving
    // the legacy creation flow is safe; existing roots remain fail-closed.
    if (options?.projectTemplateRunStartPermit) {
      assertProjectTemplateRunStartPermitOwned(
        projectRoot,
        options.projectTemplateRunStartPermit,
      );
      publishRunningEvidence();
    } else if (existsSync(projectRoot)) {
      withProjectTemplateRunStartPermit(projectRoot, publishRunningEvidence);
    } else {
      publishRunningEvidence();
    }
  }

  updateStep(stepName: string, iteration: number, resumePoint?: WorkflowResumePoint): void {
    this.runMeta.currentStep = stepName;
    this.runMeta.currentIteration = iteration;
    delete this.runMeta.phase;
    this.runMeta.resumePoint = resumePoint;
    this.writeRunMeta(this.runMeta);
  }

  updatePhase(stepName: string, iteration: number, phase: 1 | 2 | 3): void {
    this.runMeta.currentStep = stepName;
    this.runMeta.currentIteration = iteration;
    this.runMeta.phase = phase;
    this.writeRunMeta(this.runMeta);
  }

  updateResumePoint(resumePoint?: WorkflowResumePoint): void {
    this.runMeta.resumePoint = resumePoint;
    this.writeRunMeta(this.runMeta);
  }

  finalize(status: 'completed' | 'aborted', iterations?: number): void {
    this.writeRunMeta({
      ...this.runMeta,
      status,
      endTime: new Date().toISOString(),
      ...(iterations != null ? { iterations } : {}),
    } satisfies RunMeta);
    this.finalized = true;
  }

  get isFinalized(): boolean {
    return this.finalized;
  }

  private writeRunMeta(meta: RunMeta): void {
    const updatedAt = new Date().toISOString();
    const { resumePoint, sourceRunSlug, resumeMode, ...baseMeta } = meta;
    const serialized: PersistedRunMeta = {
      ...baseMeta,
      updatedAt,
      ...(resumePoint ? { resume_point: resumePoint } : {}),
      ...(sourceRunSlug ? { source_run_slug: sourceRunSlug } : {}),
      ...(resumeMode ? { resume_mode: resumeMode } : {}),
    };
    this.runMeta.updatedAt = updatedAt;
    const content = JSON.stringify(serialized, null, 2);
    // The canonical record is authoritative for execution tooling. The mirror
    // is deliberately written second so any mirror failure leaves either a
    // running record or unreadable/missing evidence in the coordination root,
    // both of which keep template apply fail-closed.
    this.writeRunMetaFile(this.metaAbs, content);
    if (this.mirrorMetaAbs !== undefined) {
      this.writeRunMetaFile(this.mirrorMetaAbs, content);
    }
  }
}

function buildMirrorRunPaths(
  coordinationRoot: string,
  slug: string,
): Pick<RunPaths, 'runRootAbs' | 'metaAbs'> {
  const runRootAbs = resolve(coordinationRoot, '.takt', 'runs', slug);
  return {
    runRootAbs,
    metaAbs: resolve(runRootAbs, 'meta.json'),
  };
}

export function resolveProjectTemplateRunMirrorSlug(
  canonicalCoordinationRoot: string,
  canonicalRunRoot: string,
  runSlug: string,
): string {
  const digest = createHash('sha256')
    .update(canonicalCoordinationRoot)
    .update('\0')
    .update(canonicalRunRoot)
    .update('\0')
    .update(runSlug)
    .digest('hex');
  return `project-template-worktree-${digest}`;
}
