/**
 * RunMeta — 実行メタデータの管理モジュール
 *
 * ランのメタデータ（task, workflow, status, 開始・終了時刻など）を
 * .takt/runs/{slug}/meta.json へ書き出す責務を担う。
 */

import type { RunMeta } from '../../../core/workflow/run/run-meta.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import type { WorkflowResumePoint } from '../../../core/models/index.js';
import type { WorkflowTraceDiscovery } from '../../../core/workflow/observability/traceDiscovery.js';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  assertProjectTemplateRunStartPermitOwned,
  ProjectTemplateCoordinationError,
  withProjectTemplateRunStartPermit,
  type ProjectTemplateRunStartPermit,
} from '../../project-template/apply-lease.js';
import {
  writeRunMetaFileDurably,
  type RunMetaStorageIo,
} from './runMetaStorage.js';
import { isDebugLoggerRunSlug } from '../../../shared/utils/debug.js';

export interface DirectResumeMetadata {
  readonly sourceRunSlug: string;
  readonly resumeMode: 'requeue' | 'retry' | 'instruct';
}

export interface RunMetaManagerOptions {
  readonly traceDiscovery?: WorkflowTraceDiscovery;
  readonly projectTemplateRunStartPermit?: ProjectTemplateRunStartPermit;
  readonly projectTemplateCoordinationRoot?: string;
  readonly runMetaStorageIo?: RunMetaStorageIo;
}

type PersistedRunMeta = Omit<RunMeta, 'resumePoint' | 'sourceRunSlug' | 'resumeMode'> & {
  resume_point?: WorkflowResumePoint;
  source_run_slug?: string;
  resume_mode?: DirectResumeMetadata['resumeMode'];
};

export class RunMetaManager {
  private readonly runMeta: RunMeta;
  private readonly metaAbs: string;
  private readonly actualProjectRoot: string;
  private readonly mirrorMetaAbs?: string;
  private readonly mirrorRunRootAbs?: string;
  private readonly mirrorProjectRoot?: string;
  private readonly runMetaStorageIo: RunMetaStorageIo | undefined;
  private finalized = false;

  constructor(
    runPaths: RunPaths,
    task: string,
    workflowName: string,
    directResume?: DirectResumeMetadata,
    options?: RunMetaManagerOptions,
  ) {
    if (isDebugLoggerRunSlug(runPaths.slug)) {
      throw new Error('run metadata slug is reserved for DebugLogger');
    }
    this.runMetaStorageIo = options?.runMetaStorageIo;
    if (
      options?.projectTemplateCoordinationRoot !== undefined
      && options.projectTemplateRunStartPermit === undefined
    ) {
      throw new ProjectTemplateCoordinationError();
    }
    const requestedActualProjectRoot = resolve(runPaths.runRootAbs, '../../..');
    // Workspace aliases such as macOS /tmp are legitimate. Canonicalize the
    // trusted project root once, then keep all RunMeta writes beneath it so the
    // storage layer can still reject symlinks introduced inside the project.
    const actualProjectRoot = existsSync(requestedActualProjectRoot)
      ? realpathSync.native(requestedActualProjectRoot)
      : requestedActualProjectRoot;
    this.actualProjectRoot = actualProjectRoot;
    this.metaAbs = resolve(
      actualProjectRoot,
      relative(requestedActualProjectRoot, runPaths.metaAbs),
    );
    const requestedCoordinationRoot = options?.projectTemplateCoordinationRoot === undefined
      ? actualProjectRoot
      : resolve(options.projectTemplateCoordinationRoot);
    const coordinationRoot = existsSync(requestedCoordinationRoot)
      ? realpathSync.native(requestedCoordinationRoot)
      : requestedCoordinationRoot;
    if (options?.projectTemplateCoordinationRoot !== undefined) {
      if (actualProjectRoot !== coordinationRoot) {
        const mirrorSlug = resolveProjectTemplateRunMirrorSlug(
          coordinationRoot,
          actualProjectRoot,
          runPaths.slug,
        );
        const mirrorPaths = buildMirrorRunPaths(coordinationRoot, mirrorSlug);
        this.mirrorMetaAbs = mirrorPaths.metaAbs;
        this.mirrorRunRootAbs = mirrorPaths.runRootAbs;
        this.mirrorProjectRoot = coordinationRoot;
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
      this.writeRunMeta(this.runMeta);
    };
    // Some embedding callers intentionally bootstrap a brand-new project path.
    // No template apply can own a lease before that root exists, so preserving
    // the legacy creation flow is safe; existing roots remain fail-closed.
    if (options?.projectTemplateRunStartPermit) {
      assertProjectTemplateRunStartPermitOwned(
        requestedCoordinationRoot,
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
    writeRunMetaFileDurably(
      this.metaAbs,
      content,
      this.actualProjectRoot,
      this.runMetaStorageIo,
    );
    if (this.mirrorMetaAbs !== undefined) {
      writeRunMetaFileDurably(
        this.mirrorMetaAbs,
        content,
        this.mirrorProjectRoot!,
        this.runMetaStorageIo,
      );
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
