import type {
  ProjectTemplateRepertoireDependencyInspectionPlanningClaim,
} from '../src/features/project-template/repertoire-dependency-inspection-port.js';
import {
  createProjectTemplateRepertoireDependencyPlan,
  type ProjectTemplateRepertoireDependencyPlan,
  type ProjectTemplateRepertoireDependencyPlanOptions,
} from '../src/features/project-template/repertoire-dependency-plan.js';

declare const claim: ProjectTemplateRepertoireDependencyInspectionPlanningClaim;

const options: ProjectTemplateRepertoireDependencyPlanOptions = {
  inspectionClaim: claim,
  incomingLock: {
    schemaVersion: '1.0',
    sourceDescriptorSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    dependencies: [],
  },
  previousLock: { state: 'absent' },
};
const plan: ProjectTemplateRepertoireDependencyPlan =
  createProjectTemplateRepertoireDependencyPlan(options);
void plan.planId;

// @ts-expect-error A verified inspection is not single-use planning ownership.
options.inspectionClaim = options.inspectionClaim.inspection;
// @ts-expect-error Present state requires bounded canonical content.
options.previousLock = { state: 'present' };
// @ts-expect-error Future schemas require a distinct plan contract.
plan.schemaVersion = '2.0';
