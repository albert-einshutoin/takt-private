import type {
  DeepReadonly,
  TaktpackInspectResult,
} from './archive-types.js';
import type {
  GithubTemplateDownloadReceiptV1,
} from './github-download-receipt.js';

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (
    typeof value !== 'object'
    || value === null
    || Object.isFrozen(value)
  ) return value as DeepReadonly<T>;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}

/**
 * Takes an owned immutable copy because the inspector result itself is not a
 * retained filesystem authority and must not remain mutable across awaits.
 */
export function snapshotGithubTemplateDownloadReceiptInspection(
  inspection: TaktpackInspectResult,
): DeepReadonly<TaktpackInspectResult> {
  return deepFreeze(structuredClone(inspection));
}

/**
 * Private canonical receipt↔archive contract shared by D2a and D2b.
 * Runtime compatibility status/currentVersion are intentionally excluded:
 * they describe the current runtime, not persisted provenance.
 */
export function requireGithubTemplateDownloadReceiptArtifactBinding(
  receipt: GithubTemplateDownloadReceiptV1,
  inspection: DeepReadonly<TaktpackInspectResult>,
  openedBytes: number,
): void {
  const archive = receipt.payload.archive;
  const source = receipt.payload.source;
  const manifest = inspection.manifest;
  if (
    openedBytes !== archive.bytes
    || inspection.archiveSha256 !== archive.sha256
    || inspection.manifestSha256 !== archive.manifestSha256
    || manifest.packVersion !== archive.version
    || manifest.source.kind !== 'github'
    || manifest.source.uri !== source.repositoryUrl
    || manifest.source.ref !== source.releaseTag
    || manifest.source.commit !== source.commit
    || manifest.source.uri !== archive.source.uri
    || manifest.source.ref !== archive.source.ref
    || manifest.source.commit !== archive.source.commit
    || manifest.takt.minVersion !== archive.takt.minVersion
    || manifest.takt.maxVersion !== archive.takt.maxVersion
  ) throw new Error();
}
