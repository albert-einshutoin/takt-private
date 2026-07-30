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
