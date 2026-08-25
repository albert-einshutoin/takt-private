import {
  DEFAULT_TAKTPACK_LIMITS,
  type TaktpackLimits,
} from './archive-types.js';
import { TaktpackError } from './errors.js';

export type TaktpackEntryKind = 'pack' | 'manifest' | 'report' | 'blob';

export function resolveTaktpackLimits(
  input: Partial<TaktpackLimits> | undefined,
): TaktpackLimits {
  const bounded = (key: keyof TaktpackLimits): number => {
    const requested = input?.[key] ?? DEFAULT_TAKTPACK_LIMITS[key];
    if (!Number.isSafeInteger(requested) || requested < 0) {
      throw new TaktpackError(
        'ARCHIVE_LIMIT_EXCEEDED',
        `${key} must be a non-negative safe integer`,
        key,
      );
    }
    return Math.min(requested, DEFAULT_TAKTPACK_LIMITS[key]);
  };
  return {
    maxEntries: bounded('maxEntries'),
    maxPackJsonBytes: bounded('maxPackJsonBytes'),
    maxManifestJsonBytes: bounded('maxManifestJsonBytes'),
    maxExportReportJsonBytes: bounded('maxExportReportJsonBytes'),
    maxBlobBytes: bounded('maxBlobBytes'),
    maxTotalBytes: bounded('maxTotalBytes'),
    maxArchiveBytes: bounded('maxArchiveBytes'),
  };
}

export function maxBytesForTaktpackEntry(
  kind: TaktpackEntryKind,
  limits: TaktpackLimits,
): number {
  switch (kind) {
    case 'pack': return limits.maxPackJsonBytes;
    case 'manifest': return limits.maxManifestJsonBytes;
    case 'report': return limits.maxExportReportJsonBytes;
    case 'blob': return limits.maxBlobBytes;
  }
}
