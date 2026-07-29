import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { calculateProjectTemplateManifestSha256, validateManifestLockPair } from './binding.js';
import { TaktpackError } from './errors.js';
import { scanProjectTemplateDirectory } from './filesystem-scan.js';
import { parseProjectTemplateManifest } from './manifest.js';
import { canonicalizeTaktpackJson } from './canonical-json.js';
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
  TemplateLockV1,
} from './types.js';
import { requireRecord } from './validation.js';

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
  seal: string;
  sealedPlan: {
    descriptor: TaktpackDescriptorV1;
    manifest: ReturnType<typeof parseProjectTemplateManifest>;
    lock: TemplateLockV1;
    report: TaktpackExportReportV1;
  };
}

const EXPORT_SOURCE_STATES = new WeakMap<ProjectTemplateExportPlan, ExportSourceState>();

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function calculatePlanSeal(
  plan: Pick<ProjectTemplateExportPlan, 'descriptor' | 'manifest' | 'lock' | 'report'>,
  files: readonly ProjectTemplateExportFile[],
): string {
  return createHash('sha256').update(canonicalizeTaktpackJson({
    descriptor: plan.descriptor,
    manifest: plan.manifest,
    lock: plan.lock,
    report: plan.report,
    files: files.map(({ path, bytes, mode, sha256 }) => ({ path, bytes, mode, sha256 })),
  })).digest('hex');
}

export function validateProjectTemplateExportPlanSeal(
  plan: ProjectTemplateExportPlan,
  state: ExportSourceState,
): boolean {
  return calculatePlanSeal(plan, state.files) === state.seal;
}

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

function parseExportPolicies(
  value: ProjectTemplateExportOptions['policies'],
): ReadonlyMap<string, Exclude<TemplateEntryPolicy, 'excluded'>> {
  let record: Record<string, unknown>;
  try {
    record = requireRecord(value ?? {}, 'policies');
  } catch {
    throw new TaktpackError(
      'INVALID_EXPORT_PLAN',
      'policies must be a plain own-property object without accessors',
      'policies',
    );
  }
  if (Object.getOwnPropertySymbols(record).length > 0) {
    throw new TaktpackError(
      'INVALID_EXPORT_PLAN',
      'policies must contain string keys only',
      'policies',
    );
  }
  const policies = new Map<string, Exclude<TemplateEntryPolicy, 'excluded'>>();
  // Approval lookup and unknown-key validation must consume the same immutable
  // own-property snapshot; reading the prototype could silently grant approval.
  for (const [path, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(record))) {
    const policy = descriptor.value;
    if (policy !== 'managed' && policy !== 'merge' && policy !== 'scaffold') {
      throw new TaktpackError(
        'INVALID_EXPORT_PLAN',
        'policy value is not supported',
        'policies',
      );
    }
    policies.set(path, policy);
  }
  return policies;
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
  const policies = parseExportPolicies(options.policies);
  const scan = await scanProjectTemplateDirectory(projectRoot);
  if (scan.scanStatus !== 'complete') {
    throw new TaktpackError(
      'INVALID_EXPORT_PLAN',
      `project template scan is ${scan.scanStatus}`,
      'scanStatus',
    );
  }

  const approvedCapabilities = new Set(options.approvedCapabilities ?? []);
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

  for (const [entryIndex, result] of scan.entries.entries()) {
    const entryField = `entries[${entryIndex}]`;
    if (result.classification === 'excluded') {
      counts.excluded += 1;
      incrementReason(excludedReasons, result.reasonCode);
      continue;
    }
    if (result.classification === 'blocked' || result.sha256 === undefined || result.mode === undefined) {
      throw new TaktpackError('INVALID_EXPORT_PLAN', `entry cannot be exported: ${result.reasonCode}`, entryField);
    }
    if (result.detectedCapabilities.inspectionStatus !== 'complete') {
      throw new TaktpackError('EXPORT_REVIEW_REQUIRED', 'capability inspection is incomplete', entryField);
    }

    const explicitPolicy = policies.get(result.relativePath);
    if (result.classification === 'project-owned' && explicitPolicy === undefined) {
      throw new TaktpackError('EXPORT_REVIEW_REQUIRED', 'project-owned entry requires an explicit policy', entryField);
    }
    const policy = explicitPolicy ?? result.suggestedPolicy;
    if (policy === undefined || policy === 'excluded') {
      throw new TaktpackError('INVALID_EXPORT_PLAN', 'included entry requires an export policy', entryField);
    }
    for (const capability of result.detectedCapabilities.capabilities) {
      if (!approvedCapabilities.has(capability)) {
        throw new TaktpackError('EXPORT_REVIEW_REQUIRED', `capability requires approval: ${capability}`, entryField);
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
      throw new TaktpackError('SOURCE_CHANGED', 'source changed after classification', entryField);
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

  const unknownPolicies = [...policies.keys()].filter((path) => !includedPaths.has(path));
  if (unknownPolicies.length > 0) {
    throw new TaktpackError('INVALID_EXPORT_PLAN', 'policy references a non-exportable path', 'policies');
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
    warnings: Object.freeze([]),
  };
  const rootPath = join(projectRoot, '.takt');
  const rootRealPath = await realpath(rootPath);
  const rootStat = await lstat(rootPath);
  const mutablePlan = { descriptor: structuredClone(DESCRIPTOR), manifest, lock, report };
  const sealedPlan = structuredClone(mutablePlan);
  const seal = calculatePlanSeal(mutablePlan, files);
  const plan = deepFreeze(mutablePlan) as ProjectTemplateExportPlan;
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
    files: deepFreeze(files),
    seal,
    sealedPlan: deepFreeze(sealedPlan),
  });
  return plan;
}
