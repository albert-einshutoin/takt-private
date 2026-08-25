import type {
  ProjectTemplateArtifactDownloadDecisionEvent,
  ProjectTemplateArtifactDownloadPolicy,
  ProjectTemplateArtifactDownloadRetryControl,
  ProjectTemplateArtifactDownloadTerminalControl,
} from '../src/infra/github/project-template-artifact-download-coordinator.js';
import type {
  ProjectTemplateArtifactDownloadBridge,
} from '../src/infra/github/project-template-artifact-download.js';

// @ts-expect-error Retry controls are nominal and cannot be structurally forged.
const forgedRetry: ProjectTemplateArtifactDownloadRetryControl = {
  retry: () => undefined,
  fail: () => undefined,
};
void forgedRetry;

// @ts-expect-error Terminal controls are nominal and cannot be structurally forged.
const forgedTerminal: ProjectTemplateArtifactDownloadTerminalControl = {
  fail: () => undefined,
};
void forgedTerminal;

// @ts-expect-error The D1 bridge remains nominal across the D3 seam.
const forgedBridge: ProjectTemplateArtifactDownloadBridge = {};
void forgedBridge;

declare const retryControl: ProjectTemplateArtifactDownloadRetryControl;
// @ts-expect-error Terminal failures cannot enter the retryable event branch.
const mismatchedEvent: ProjectTemplateArtifactDownloadDecisionEvent = {
  kind: 'retryable',
  failure: {
    code: 'INTERNAL',
    retryable: false,
    replaySafe: false,
  },
  control: retryControl,
};
void mismatchedEvent;

const returningPolicy: ProjectTemplateArtifactDownloadPolicy = {
  // @ts-expect-error Policy decisions must return exactly undefined.
  decide: () => 1,
};
void returningPolicy;

function routeDecision(event: ProjectTemplateArtifactDownloadDecisionEvent):
'retryable' | 'terminal' {
  switch (event.kind) {
    case 'retryable':
      event.control.retry;
      return 'retryable';
    case 'terminal':
      // @ts-expect-error Terminal policy cannot select a retry.
      event.control.retry;
      return 'terminal';
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
void routeDecision;
