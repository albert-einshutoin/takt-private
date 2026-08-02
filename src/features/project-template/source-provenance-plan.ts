import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  calculateProjectTemplateSourceProvenanceSha256,
  parseProjectTemplateSourceProvenance,
  type ProjectTemplateGithubSourceProvenanceV1,
  type ProjectTemplateLocalSourceProvenanceV1,
  type ProjectTemplateSourceProvenanceV1,
} from './source-provenance.js';
import { compareSemVer } from './validation.js';

const PLAN_ID_DOMAIN = 'takt.project-template.source-provenance-plan.v1\u0000';
const SOURCE_PROVENANCE_PLAN_SEALS = new WeakMap<object, string>();

export type ProjectTemplateSourceProvenanceChange =
  | 'SOURCE_ADDED'
  | 'REPOSITORY_CHANGED'
  | 'REF_CHANGED'
  | 'RELEASE_TAG_CHANGED'
  | 'VERSION_CHANGED'
  | 'COMMIT_CHANGED'
  | 'DESCRIPTOR_CHANGED'
  | 'ARCHIVE_CHANGED'
  | 'MANIFEST_CHANGED'
  | 'DEPENDENCY_EVIDENCE_CHANGED';

export type ProjectTemplateSourceProvenanceConflict =
  | 'REPOSITORY_CHANGED'
  | 'VERSION_DOWNGRADE'
  | 'TAG_REPUBLISHED';

export type ProjectTemplateSourceProvenancePrevious =
  | { readonly state: 'absent' }
  | {
    readonly state: 'present';
    readonly provenance: unknown;
  }
  | { readonly state: 'unavailable' };

export interface CreateProjectTemplateSourceProvenancePlanOptions {
  readonly incoming: unknown;
  readonly previous: ProjectTemplateSourceProvenancePrevious;
}

export interface ProjectTemplateSourceProvenancePlan {
  readonly schemaVersion: '1.0';
  readonly planId: string;
  readonly action: 'install' | 'keep' | 'update';
  readonly changes: readonly ProjectTemplateSourceProvenanceChange[];
  readonly conflicts: readonly ProjectTemplateSourceProvenanceConflict[];
  readonly previousProvenanceSha256?: string;
  readonly nextProvenanceSha256: string;
  readonly nextProvenance: ProjectTemplateSourceProvenanceV1;
  readonly reviewRequired: boolean;
  readonly hardConflict: boolean;
  readonly defaultApplyPossible: boolean;
}

function exactOptions(value: unknown): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new TypeError('source provenance plan options are invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2
    || !keys.includes('incoming')
    || !keys.includes('previous')
    || keys.some((key) => typeof key !== 'string')
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor))
  ) throw new TypeError('source provenance plan options are invalid');
  return {
    incoming: descriptors['incoming']!.value,
    previous: descriptors['previous']!.value,
  };
}

function parsePrevious(value: unknown): ProjectTemplateSourceProvenanceV1 | undefined {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new TypeError('previous source provenance state is invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('previous source provenance state is invalid');
  }
  const state = descriptors['state'];
  if (state === undefined || !('value' in state)) {
    throw new TypeError('previous source provenance state is invalid');
  }
  if (state.value === 'absent' && keys.length === 1) return undefined;
  if (
    state.value === 'present'
    && keys.length === 2
    && descriptors['provenance'] !== undefined
    && 'value' in descriptors['provenance']
  ) return parseProjectTemplateSourceProvenance(descriptors['provenance'].value);
  throw new TypeError('previous source provenance state is invalid');
}

function changed(
  changes: ProjectTemplateSourceProvenanceChange[],
  condition: boolean,
  code: ProjectTemplateSourceProvenanceChange,
): void {
  if (condition) changes.push(code);
}

function evidenceChanged(
  left: ProjectTemplateSourceProvenanceV1['dependencyVerification'],
  right: ProjectTemplateSourceProvenanceV1['dependencyVerification'],
): boolean {
  return left.method !== right.method
    || left.declarationSha256 !== right.declarationSha256
    || left.count !== right.count;
}

function isLocalSourceProvenance(
  value: ProjectTemplateSourceProvenanceV1,
): value is ProjectTemplateLocalSourceProvenanceV1 {
  return 'kind' in value.source && value.source.kind === 'local-import';
}

function isGithubSourceProvenance(
  value: ProjectTemplateSourceProvenanceV1,
): value is ProjectTemplateGithubSourceProvenanceV1 {
  return !isLocalSourceProvenance(value);
}

function calculatePlanId(value: Readonly<{
  action: string;
  changes: readonly string[];
  conflicts: readonly string[];
  previousProvenanceSha256?: string;
  nextProvenanceSha256: string;
}>): string {
  return createHash('sha256')
    .update(PLAN_ID_DOMAIN, 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

export function createProjectTemplateSourceProvenancePlan(
  options: CreateProjectTemplateSourceProvenancePlanOptions,
): ProjectTemplateSourceProvenancePlan {
  const snapshot = exactOptions(options);
  const incoming = parseProjectTemplateSourceProvenance(snapshot['incoming']);
  const previous = parsePrevious(snapshot['previous']);
  const nextProvenanceSha256 =
    calculateProjectTemplateSourceProvenanceSha256(incoming);
  const previousProvenanceSha256 = previous === undefined
    ? undefined
    : calculateProjectTemplateSourceProvenanceSha256(previous);
  const changes: ProjectTemplateSourceProvenanceChange[] = [];
  const conflicts: ProjectTemplateSourceProvenanceConflict[] = [];

  if (previous === undefined) {
    changes.push('SOURCE_ADDED');
  } else {
    const bothGithub = isGithubSourceProvenance(previous)
      && isGithubSourceProvenance(incoming);
    const bothLocal = isLocalSourceProvenance(previous)
      && isLocalSourceProvenance(incoming);
    // Changing provenance authority (local versus GitHub) is treated as a
    // source replacement, even if their content hashes happen to coincide.
    const repositoryChanged = bothGithub
      ? previous.source.owner !== incoming.source.owner
        || previous.source.repo !== incoming.source.repo
        || previous.source.repositoryUrl !== incoming.source.repositoryUrl
      : bothLocal
        ? previous.source.uri !== incoming.source.uri
        : true;
    changed(changes, repositoryChanged, 'REPOSITORY_CHANGED');
    changed(
      changes,
      bothGithub
        ? previous.source.requestedRef !== incoming.source.requestedRef
          || previous.source.canonicalSource !== incoming.source.canonicalSource
        : bothLocal
          ? previous.source.ref !== incoming.source.ref
          : true,
      'REF_CHANGED',
    );
    changed(
      changes,
      bothGithub
        ? previous.source.releaseTag !== incoming.source.releaseTag
        : false,
      'RELEASE_TAG_CHANGED',
    );
    changed(
      changes,
      previous.archive.version !== incoming.archive.version,
      'VERSION_CHANGED',
    );
    changed(
      changes,
      previous.source.commit !== incoming.source.commit,
      'COMMIT_CHANGED',
    );
    changed(
      changes,
      previous.source.descriptorSha256 !== incoming.source.descriptorSha256,
      'DESCRIPTOR_CHANGED',
    );
    changed(
      changes,
      previous.archive.sha256 !== incoming.archive.sha256,
      'ARCHIVE_CHANGED',
    );
    changed(
      changes,
      previous.archive.manifestSha256 !== incoming.archive.manifestSha256,
      'MANIFEST_CHANGED',
    );
    changed(
      changes,
      evidenceChanged(
        previous.dependencyVerification,
        incoming.dependencyVerification,
      ),
      'DEPENDENCY_EVIDENCE_CHANGED',
    );

    if (repositoryChanged) conflicts.push('REPOSITORY_CHANGED');
    if (compareSemVer(incoming.archive.version, previous.archive.version) < 0) {
      conflicts.push('VERSION_DOWNGRADE');
    }
    if (
      bothGithub
      && !repositoryChanged
      && previous.source.releaseTag === incoming.source.releaseTag
      && previous.source.commit !== incoming.source.commit
    ) conflicts.push('TAG_REPUBLISHED');
  }

  const action = previous === undefined
    ? 'install'
    : previousProvenanceSha256 === nextProvenanceSha256
      ? 'keep'
      : 'update';
  const frozenChanges = Object.freeze(changes);
  const frozenConflicts = Object.freeze(conflicts);
  const hardConflict = conflicts.length !== 0;
  const idBody = {
    action,
    changes: frozenChanges,
    conflicts: frozenConflicts,
    ...(previousProvenanceSha256 === undefined
      ? {}
      : { previousProvenanceSha256 }),
    nextProvenanceSha256,
  };
  const plan = Object.freeze({
    schemaVersion: '1.0' as const,
    planId: calculatePlanId(idBody),
    action,
    changes: frozenChanges,
    conflicts: frozenConflicts,
    ...(previousProvenanceSha256 === undefined
      ? {}
      : { previousProvenanceSha256 }),
    nextProvenanceSha256,
    nextProvenance: incoming,
    reviewRequired: changes.length !== 0,
    hardConflict,
    defaultApplyPossible: !hardConflict,
  });
  SOURCE_PROVENANCE_PLAN_SEALS.set(plan, plan.planId);
  return plan;
}

/** @internal Rejects cloned or deserialized source planning lookalikes. */
export function assertProjectTemplateSourceProvenancePlan(
  value: unknown,
): ProjectTemplateSourceProvenancePlan {
  const sealedId = typeof value === 'object' && value !== null
    ? SOURCE_PROVENANCE_PLAN_SEALS.get(value)
    : undefined;
  if (sealedId === undefined) {
    throw new TypeError('source provenance plan is not process-local');
  }
  const plan = value as ProjectTemplateSourceProvenancePlan;
  if (plan.planId !== sealedId) {
    throw new TypeError('source provenance plan identity changed');
  }
  return plan;
}
