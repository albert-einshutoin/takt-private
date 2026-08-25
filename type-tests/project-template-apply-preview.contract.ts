import type { ProjectTemplateApplyPlan } from '../src/features/project-template/apply-plan-types.js';
import type { ProjectTemplateRepertoireDependencyPlan } from '../src/features/project-template/repertoire-dependency-plan.js';
import {
  assertProjectTemplateApplyPreview,
  createProjectTemplateApplyPreview,
  renderProjectTemplateApplyPreviewHuman,
  renderProjectTemplateApplyPreviewJson,
  type ProjectTemplateApplyPreview,
  type ProjectTemplateApplyPreviewOptions,
} from '../src/features/project-template/apply-preview.js';

declare const contentPlan: ProjectTemplateApplyPlan;
declare const repertoireDependencyPlan: ProjectTemplateRepertoireDependencyPlan;

const options: ProjectTemplateApplyPreviewOptions = {
  contentPlan,
  repertoireDependencyPlan,
};
const preview: ProjectTemplateApplyPreview =
  createProjectTemplateApplyPreview(options);
const asserted: ProjectTemplateApplyPreview =
  assertProjectTemplateApplyPreview(preview);
const human: string = renderProjectTemplateApplyPreviewHuman(asserted);
const json: string = renderProjectTemplateApplyPreviewJson(asserted);
void human;
void json;

createProjectTemplateApplyPreview({
  // @ts-expect-error Content and dependency plans cannot be swapped.
  contentPlan: repertoireDependencyPlan,
  // @ts-expect-error Content and dependency plans cannot be swapped.
  repertoireDependencyPlan: contentPlan,
});
