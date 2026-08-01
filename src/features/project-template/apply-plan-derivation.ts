import { prepareProjectTemplateApplyPlan } from './apply-plan.js';
import type {
  ProjectTemplateIncomingContent,
  ProjectTemplateIncomingInspectionEvidence,
  PreparedProjectTemplateApplyPlan,
} from './apply-plan-types.js';
import {
  captureProjectTemplateTargetSnapshot,
} from './target-snapshot.js';
import type { ProjectTemplateManifestV1, TemplateLockV1 } from './types.js';
import type {
  ProjectTemplateRemotePreviewOperationContext,
} from './remote-preview-operation.js';

/**
 * Re-derives a content plan from current target evidence. Preview and apply
 * share this boundary so approval cannot seal a different three-way merge
 * interpretation from the executor's final verification.
 */
export async function deriveProjectTemplateApplyPlanFromCurrentTarget(options: {
  readonly projectRoot: string;
  readonly baseLock?: TemplateLockV1;
  readonly baseContents: readonly ProjectTemplateIncomingContent[];
  readonly incomingManifest: ProjectTemplateManifestV1;
  readonly incomingContents: readonly ProjectTemplateIncomingContent[];
  readonly incomingInspection: ProjectTemplateIncomingInspectionEvidence;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly operationContext?: ProjectTemplateRemotePreviewOperationContext;
}): Promise<PreparedProjectTemplateApplyPlan> {
  const candidatePaths = [
    ...new Set([
      ...(options.baseLock?.entries.map((entry) => entry.path) ?? []),
      ...options.incomingManifest.entries.map((entry) => entry.path),
    ]),
  ];
  const snapshot = await captureProjectTemplateTargetSnapshot(
    options.projectRoot,
    candidatePaths,
    options.operationContext,
  );
  return prepareProjectTemplateApplyPlan({
    ...(options.baseLock === undefined ? {} : { baseLock: options.baseLock }),
    baseContents: options.baseContents,
    incomingManifest: options.incomingManifest,
    incomingContents: options.incomingContents,
    localEntries: snapshot.entries,
    targetRootState: snapshot.rootState,
    missingPathTracking: snapshot.missingPathTracking,
    incomingInspection: options.incomingInspection,
    baselineStrategy: options.baselineStrategy,
  });
}
