import {
  renderProjectTemplateApplyPreviewHuman,
  renderProjectTemplateApplyPreviewJson,
  type ProjectTemplateApplyPreview,
  type ProjectTemplateApplyPreviewApprovalEvidence,
  type ProjectTemplateApplyPreviewBindings,
  type ProjectTemplateApplyPreviewCompositionConflictCode,
  type ProjectTemplateApplyPreviewContentHardConflict,
} from '../src/index.js';

declare const preview: ProjectTemplateApplyPreview;
declare const evidence: ProjectTemplateApplyPreviewApprovalEvidence;

const human: string = renderProjectTemplateApplyPreviewHuman(preview);
const json: string = renderProjectTemplateApplyPreviewJson(preview);
const bindings: ProjectTemplateApplyPreviewBindings = preview.bindings;
const compositionConflict: ProjectTemplateApplyPreviewCompositionConflictCode =
  preview.compositionConflicts[0]!;
const contentConflict: ProjectTemplateApplyPreviewContentHardConflict =
  preview.contentHardConflicts[0]!;
void human;
void json;
void bindings;
void compositionConflict;
void contentConflict;

// @ts-expect-error Approval evidence is branded process-local authority.
const forgedEvidence: ProjectTemplateApplyPreviewApprovalEvidence = {
  schemaVersion: '1.0',
  approvalId: 'approval-forged',
};
void forgedEvidence;

// @ts-expect-error Approval evidence cannot be rendered as a preview.
renderProjectTemplateApplyPreviewHuman(evidence);
// @ts-expect-error A preview cannot be consumed where evidence is required.
const swappedEvidence: ProjectTemplateApplyPreviewApprovalEvidence = preview;
void swappedEvidence;
