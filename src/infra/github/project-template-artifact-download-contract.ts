/**
 * Maximum chunk crossing the authenticated attempt/bridge boundary.
 *
 * Keeping this shared prevents D2 and D3 from drifting while storage retains
 * its independent, broader hostile-stream limit as defense in depth.
 */
export const MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES = 64 * 1024;

/** GitHub status codes whose pre-delivery failures may be retried by policy. */
export function isRetryableProjectTemplateArtifactHttpStatus(
  statusCode: number,
): boolean {
  return statusCode === 408
    || statusCode === 429
    || statusCode === 500
    || statusCode === 502
    || statusCode === 503
    || statusCode === 504;
}
