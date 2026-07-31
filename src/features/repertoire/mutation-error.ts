export class RepertoireMutationError extends Error {
  readonly code = 'RECOVERY_REQUIRED' as const;

  constructor() {
    super('Repertoire package recovery is required');
    this.name = 'RepertoireMutationError';
  }
}

/** Remove errno path/cause details at the command boundary. */
export function normalizeRepertoireMutationError(error: unknown): unknown {
  if (isFilesystemError(error)) return new RepertoireMutationError();
  return error;
}

function isFilesystemError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code);
}
