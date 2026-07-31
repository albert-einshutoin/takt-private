import {
  claimProjectTemplateRepertoireDependencyInspectionForPlanning,
  consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim,
  inspectProjectTemplateRepertoireDependencies,
  type ProjectTemplateRepertoireDependencyInspectionPlanningClaim,
  type ProjectTemplateRepertoireDependencyInspectionSnapshot,
  type VerifiedProjectTemplateRepertoireDependencyInspection,
} from '../src/features/project-template/repertoire-dependency-inspection-port.js';
import type { ProjectTemplateApplyPlan } from '../src/features/project-template/apply-plan-types.js';
import type {
  PreparedGithubTemplateDownloadReceipt,
} from '../src/features/project-template/github-download-receipt.js';
import type {
  ProjectTemplateMutationLease,
} from '../src/features/project-template/apply-lease.js';

const verified: VerifiedProjectTemplateRepertoireDependencyInspection =
  inspectProjectTemplateRepertoireDependencies({
    request: {
      sourceDescriptorSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      dependencies: [],
      deadlineMs: 1,
    },
    port: {
      inspect() {
        return {
          witnessSha256: 'c'.repeat(64),
          observations: [],
        };
      },
    },
  });

const claim: ProjectTemplateRepertoireDependencyInspectionPlanningClaim =
  claimProjectTemplateRepertoireDependencyInspectionForPlanning(verified);
const snapshot: ProjectTemplateRepertoireDependencyInspectionSnapshot =
  consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim(claim);
void snapshot.preconditionToken;

const forged = { inspection: verified };
// @ts-expect-error Planning ownership is nominal and cannot be forged.
const forgedClaim: ProjectTemplateRepertoireDependencyInspectionPlanningClaim =
  forged;
void forgedClaim;
// Runtime membership validation rejects structural clones accepted as unknown.
consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim(forged);

// @ts-expect-error Inspection planning authority is not an apply plan.
const applyPlan: ProjectTemplateApplyPlan = claim;
void applyPlan;
// @ts-expect-error Inspection planning authority is not a download receipt.
const receipt: PreparedGithubTemplateDownloadReceipt = claim;
void receipt;
// @ts-expect-error Inspection planning authority is not a mutation lease.
const lease: ProjectTemplateMutationLease = claim;
void lease;
