import type {
  ProjectTemplateArtifactSingleAttempt,
  ProjectTemplateArtifactSingleAttemptFailure,
} from '../src/infra/github/project-template-artifact-download-attempt.js';

// @ts-expect-error A structural object cannot forge the nominal capability.
const forged: ProjectTemplateArtifactSingleAttempt = {
  pull: () => undefined,
  dispose: () => undefined,
};
void forged;

function narrowFailure(
  failure: ProjectTemplateArtifactSingleAttemptFailure,
): number | undefined {
  switch (failure.code) {
    case 'HTTP_STATUS':
      return failure.statusCode;
    case 'NETWORK':
    case 'DNS_REJECTED':
    case 'INVALID_RESPONSE':
    case 'OUTPUT_LIMIT':
    case 'INTERNAL':
      return undefined;
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}
void narrowFailure;

const network = {} as Extract<
ProjectTemplateArtifactSingleAttemptFailure,
{ readonly code: 'NETWORK' }
>;
// @ts-expect-error statusCode is available only for HTTP_STATUS.
void network.statusCode;

// @ts-expect-error Terminal DNS failures cannot be retryable.
const retryableDns: ProjectTemplateArtifactSingleAttemptFailure = {
  code: 'DNS_REJECTED',
  retryable: true,
  replaySafe: true,
};
void retryableDns;

// @ts-expect-error Retryability and replay safety cannot disagree.
const mismatchedNetwork: ProjectTemplateArtifactSingleAttemptFailure = {
  code: 'NETWORK',
  retryable: true,
  replaySafe: false,
};
void mismatchedNetwork;

const terminalWithStatus: ProjectTemplateArtifactSingleAttemptFailure = {
  code: 'INTERNAL',
  retryable: false,
  replaySafe: false,
  // @ts-expect-error statusCode exists only on HTTP_STATUS.
  statusCode: 500,
};
void terminalWithStatus;
