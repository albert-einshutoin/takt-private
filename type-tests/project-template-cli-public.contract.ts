import {
  PROJECT_TEMPLATE_CLI_SCHEMA_VERSION,
  PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1,
  parseProjectTemplateCliV1_1EnvelopeJson,
  parseProjectTemplateCliEnvelopeJson,
  parseProjectTemplateCliMutationOptions,
  presentProjectTemplateCliEnvelope,
  type ProjectTemplateCliEnvelope,
  type ProjectTemplateCliV1_1Envelope,
  type ProjectTemplateCliMutationOptions,
} from '../src/index.js';
import {
  startProjectTemplateCliLifecycle as startProjectTemplateCliFeatureLifecycle,
} from '../src/features/project-template/index.js';

// Raw authority/lifecycle primitives stay internal to the project-template
// composition boundary; package consumers receive validated schema entrypoints.
// @ts-expect-error raw envelope constructor is not a root package export
import { createProjectTemplateCliSuccess } from '../src/index.js';
// @ts-expect-error raw lifecycle control is not a root package export
import { startProjectTemplateCliLifecycle } from '../src/index.js';
// @ts-expect-error raw outcome writer is not a root package export
import { writeProjectTemplateCliOutcome } from '../src/index.js';

void PROJECT_TEMPLATE_CLI_SCHEMA_VERSION;
void PROJECT_TEMPLATE_CLI_SCHEMA_VERSION_V1_1;
void parseProjectTemplateCliEnvelopeJson;
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

startProjectTemplateCliFeatureLifecycle({
  command: 'project-template inspect', mode: 'dry-run', schemaVersion: '1.1',
  dispose: () => undefined,
  // @ts-expect-error schema 1.1 lifecycle cannot accept a schema 1.0 handler
  async handle() { return { envelope, exitCode: 0 }; },
});

declare const envelopeV1_1: ProjectTemplateCliV1_1Envelope;
const parsedV1_1: ProjectTemplateCliV1_1Envelope =
  parseProjectTemplateCliV1_1EnvelopeJson('{}');
void parsedV1_1;
if (envelopeV1_1.status === 'success') {
  if (envelopeV1_1.command === 'project-template inspect') {
    const manifestId: string = envelopeV1_1.result.detail.identity.manifestId;
    const sourceKind: 'local-import' | 'github' = envelopeV1_1.result.detail.source.kind;
    void manifestId;
    void sourceKind;
    // @ts-expect-error inspect detail cannot be consumed as a mutation preview
    envelopeV1_1.result.detail.actionCounts;
  }
  if (envelopeV1_1.command === 'project-template diff') {
    const addCount: number = envelopeV1_1.result.detail.actionCounts.add;
    const targetPath: string | undefined = envelopeV1_1.result.detail.targets.items[0]?.path;
    void addCount;
    void targetPath;
  }
  if (envelopeV1_1.command === 'project-template list'
    && envelopeV1_1.result.installed) {
    const source = envelopeV1_1.result.detail.source;
    if (source.kind === 'github') {
      const owner: string = source.owner;
      const commit: string = source.resolvedCommit;
      void owner;
      void commit;
    }
  }
}

if (envelope.status === 'success') {
  if (envelope.command === 'project-template inspect') {
    const mode: 'dry-run' = envelope.mode;
    const archiveBytes: number = envelope.result.archiveBytes;
    void mode;
    void archiveBytes;
  }
  if (envelope.command === 'project-template apply') {
    if (envelope.mode === 'apply') {
      const applied: true = envelope.result.applied;
      const recoveryState: 'clean' = envelope.result.recoveryState;
      void applied;
      void recoveryState;
    } else {
      const changeCount: number = envelope.result.changeCount;
      void changeCount;
    }
  }
}
