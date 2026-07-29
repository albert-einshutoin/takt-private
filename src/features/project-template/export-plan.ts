import { join } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { calculateProjectTemplateManifestSha256, validateManifestLockPair } from './binding.js';
import { TaktpackError } from './errors.js';
import { scanProjectTemplateDirectory } from './filesystem-scan.js';
import { parseProjectTemplateManifest } from './manifest.js';
import type {
  ProjectTemplateExportOptions,
  ProjectTemplateExportFile,
  ProjectTemplateExportPlan,
  TaktpackDescriptorV1,
  TaktpackExportReportV1,
} from './archive-types.js';
import type {
  ProjectTemplateClassificationReason,
} from './classifier-types.js';
import type {
  TemplateCapability,
  TemplateEntry,
  TemplateEntryPolicy,
} from './types.js';

const DESCRIPTOR: TaktpackDescriptorV1 = {
  format: 'taktpack',
  version: '1.0',
  archive: 'ustar',
  contentAddressed: true,
};

interface ExportSourceState {
  rootRealPath: string;
  rootSnapshot: ProjectTemplateExportFile['snapshot'];
  files: ProjectTemplateExportFile[];
}

const EXPORT_SOURCE_STATES = new WeakMap<ProjectTemplateExportPlan, ExportSourceState>();

export function getProjectTemplateExportSourceState(
  plan: ProjectTemplateExportPlan,
): ExportSourceState | undefined {
  return EXPORT_SOURCE_STATES.get(plan);
}

function incrementReason(
  reasons: Partial<Record<ProjectTemplateClassificationReason, number>>,
  reason: ProjectTemplateClassificationReason,
): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

/**
 * Converts the redacted scanner result into immutable archive metadata.
 * Excluded paths stay in the report only: runtime and secret paths are never
 * opened merely to obtain a digest for an archive they cannot enter.
 */
export async function createProjectTemplateExportPlan(
  projectRoot: string,
  options: ProjectTemplateExportOptions,
): Promise<ProjectTemplateExportPlan> {
  const scan = await scanProjectTemplateDirectory(projectRoot);
  if (scan.scanStatus !== 'complete') {
    throw new TaktpackError(
      'INVALID_EXPORT_PLAN',
      `project template scan is ${scan.scanStatus}`,
      'scanStatus',
    );
  }

  const approvedCapabilities = new Set(options.approvedCapabilities ?? []);
  const policies = options.policies ?? {};
  const includedPaths = new Set<string>();
  const entries: TemplateEntry[] = [];
  const files: ProjectTemplateExportFile[] = [];
  const topCapabilities = new Set<TemplateCapability>();
  const excludedReasons: Partial<Record<ProjectTemplateClassificationReason, number>> = {};
  const counts: Record<TemplateEntryPolicy, number> = {
    managed: 0,
    merge: 0,
    scaffold: 0,
    excluded: 0,
  };

  for (const result of scan.entries) {
    if (result.classification === 'excluded') {
      counts.excluded += 1;
      incrementReason(excludedReasons, result.reasonCode);
      continue;
    }
    if (result.classification === 'blocked' || result.sha256 === undefined || result.mode === undefined) {
      throw new TaktpackError('INVALID_EXPORT_PLAN', `entry cannot be exported: ${result.reasonCode}`, result.relativePath);
    }
    if (result.detectedCapabilities.inspectionStatus !== 'complete') {
      throw new TaktpackError('EXPORT_REVIEW_REQUIRED', 'capability inspection is incomplete', result.relativePath);
    }

    const explicitPolicy = policies[result.relativePath];
    if (result.classification === 'project-owned' && explicitPolicy === undefined) {
      throw new TaktpackError('EXPORT_REVIEW_REQUIRED', 'project-owned entry requires an explicit policy', result.relativePath);
    }
    const policy = explicitPolicy ?? result.suggestedPolicy;
    if (policy === undefined || policy === 'excluded') {
      throw new TaktpackError('INVALID_EXPORT_PLAN', 'included entry requires an export policy', result.relativePath);
    }
    for (const capability of result.detectedCapabilities.capabilities) {
      if (!approvedCapabilities.has(capability)) {
        throw new TaktpackError('EXPORT_REVIEW_REQUIRED', `capability requires approval: ${capability}`, result.relativePath);
      }
      topCapabilities.add(capability);
    }

    includedPaths.add(result.relativePath);
    counts[policy] += 1;
    entries.push({
      path: result.relativePath,
      policy,
      mode: result.mode,
      sha256: result.sha256,
      ...(result.detectedCapabilities.capabilities.length === 0
        ? {}
        : { capabilities: result.detectedCapabilities.capabilities }),
    });
    const absolutePath = join(projectRoot, '.takt', result.relativePath);
    const snapshot = await lstat(absolutePath);
    const snapshotMode = `0${(snapshot.mode & 0o777).toString(8).padStart(3, '0')}`;
    if (
      !snapshot.isFile()
      || snapshot.isSymbolicLink()
      || snapshot.nlink !== 1
      || snapshot.size !== result.bytes
      || snapshotMode !== result.mode
    ) {
      throw new TaktpackError('SOURCE_CHANGED', 'source changed after classification', result.relativePath);
    }
    files.push({
      path: result.relativePath,
      absolutePath,
      bytes: result.bytes,
      mode: result.mode,
      sha256: result.sha256,
      snapshot: {
        dev: snapshot.dev,
        ino: snapshot.ino,
        nlink: snapshot.nlink,
        size: snapshot.size,
        mode: snapshot.mode,
        mtimeMs: snapshot.mtimeMs,
        ctimeMs: snapshot.ctimeMs,
      },
    });
  }

  const unknownPolicies = Object.keys(policies).filter((path) => !includedPaths.has(path));
  if (unknownPolicies.length > 0) {
    throw new TaktpackError('INVALID_EXPORT_PLAN', 'policy references a non-exportable path', unknownPolicies[0]);
  }

  entries.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  files.sort((left, right) => left.sha256.localeCompare(right.sha256, 'en-US'));
  const capabilities = [...topCapabilities].sort((left, right) => left.localeCompare(right, 'en-US'));
  const manifest = parseProjectTemplateManifest({
    schemaVersion: '1.0',
    packVersion: options.packVersion,
    takt: options.takt,
    source: options.source,
    ...(capabilities.length === 0 ? {} : { capabilities }),
    entries,
  });
  const lock = {
    schemaVersion: '1.0' as const,
    manifestSha256: calculateProjectTemplateManifestSha256(manifest),
    packVersion: manifest.packVersion,
    source: manifest.source,
    capabilities,
    entries: manifest.entries.map((entry) => ({
      path: entry.path,
      policy: entry.policy,
      mode: entry.mode,
      sha256: entry.sha256,
      capabilities: entry.capabilities ?? [],
    })),
  };
  validateManifestLockPair(manifest, lock);
  const report: TaktpackExportReportV1 = {
    schemaVersion: '1.0',
    counts,
    excludedReasons,
    warnings: [],
  };
  const rootPath = join(projectRoot, '.takt');
  const rootRealPath = await realpath(rootPath);
  const rootStat = await lstat(rootPath);
  const plan: ProjectTemplateExportPlan = { descriptor: DESCRIPTOR, manifest, lock, report };
  EXPORT_SOURCE_STATES.set(plan, {
    rootRealPath,
    rootSnapshot: {
      dev: rootStat.dev,
      ino: rootStat.ino,
      nlink: rootStat.nlink,
      size: rootStat.size,
      mode: rootStat.mode,
      mtimeMs: rootStat.mtimeMs,
      ctimeMs: rootStat.ctimeMs,
    },
    files,
  });
  return plan;
}
