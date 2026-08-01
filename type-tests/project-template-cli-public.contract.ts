import {
  PROJECT_TEMPLATE_CLI_SCHEMA_VERSION,
  parseProjectTemplateCliMutationOptions,
  presentProjectTemplateCliEnvelope,
  type ProjectTemplateCliEnvelope,
  type ProjectTemplateCliMutationOptions,
} from '../src/index.js';

// Raw authority/lifecycle primitives stay internal to the project-template
// composition boundary; package consumers receive validated schema entrypoints.
// @ts-expect-error raw envelope constructor is not a root package export
import { createProjectTemplateCliSuccess } from '../src/index.js';
// @ts-expect-error raw lifecycle control is not a root package export
import { startProjectTemplateCliLifecycle } from '../src/index.js';
// @ts-expect-error raw outcome writer is not a root package export
import { writeProjectTemplateCliOutcome } from '../src/index.js';

void PROJECT_TEMPLATE_CLI_SCHEMA_VERSION;
void presentProjectTemplateCliEnvelope;
void createProjectTemplateCliSuccess;
void startProjectTemplateCliLifecycle;
void writeProjectTemplateCliOutcome;

const options: ProjectTemplateCliMutationOptions =
  parseProjectTemplateCliMutationOptions([]);
if (options.mode === 'apply') {
  const expectedPlanId: string = options.expectedPlanId;
  void expectedPlanId;
} else {
  // @ts-expect-error dry-run carries no expectedPlanId authority
  const expectedPlanId: string = options.expectedPlanId;
  void expectedPlanId;
}

declare const envelope: ProjectTemplateCliEnvelope;
presentProjectTemplateCliEnvelope(envelope);
