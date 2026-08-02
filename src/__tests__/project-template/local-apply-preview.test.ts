import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createProjectTemplateApplyPlan } from '../../features/project-template/apply-plan.js';
import {
  createProjectTemplateLocalApplyPreview,
  renderProjectTemplateApplyPreviewJson,
} from '../../features/project-template/apply-preview.js';
import { calculateProjectTemplateManifestSha256 } from '../../features/project-template/binding.js';
import { serializeTemplateLock } from '../../features/project-template/lock.js';
import {
  calculateProjectTemplateRepertoireDependencyLockSha256,
} from '../../features/project-template/repertoire-dependency-lock.js';
import {
  createLocalEmptyProjectTemplateRepertoireDependencyPlan,
} from '../../features/project-template/repertoire-dependency-plan.js';
import {
  createProjectTemplateSourceProvenancePlan,
} from '../../features/project-template/source-provenance-plan.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ARCHIVE_SHA = 'b'.repeat(64);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function plans() {
  const manifest = {
    schemaVersion: '1.0' as const,
    packVersion: '2.0.0',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'local' as const,
      uri: '.',
      ref: 'workspace' as const,
      commit: COMMIT,
    },
    capabilities: [],
    entries: [],
  };
  const manifestSha256 = calculateProjectTemplateManifestSha256(manifest);
  const contentPlan = createProjectTemplateApplyPlan({
    incomingManifest: manifest,
    incomingContents: [],
    localEntries: [],
    targetRootState: 'missing',
    missingPathTracking: {},
    incomingInspection: {
      archiveSha256: ARCHIVE_SHA,
      manifestSha256,
      currentTaktVersion: '0.48.0',
      compatibilityStatus: 'compatible',
    },
    baselineStrategy: 'adopt-identical',
  });
  const incomingDependencyLock = {
    schemaVersion: '1.0' as const,
    sourceDescriptorSha256: 'a'.repeat(64),
    manifestSha256,
    dependencies: [],
  };
  const repertoireDependencyPlan =
    createLocalEmptyProjectTemplateRepertoireDependencyPlan({
      incomingLock: incomingDependencyLock,
      previousLock: { state: 'absent' },
    });
  const sourceProvenancePlan = createProjectTemplateSourceProvenancePlan({
    incoming: {
      schemaVersion: '1.0',
      source: {
        kind: 'local-import',
        uri: '.',
        ref: 'workspace',
        commit: COMMIT,
        descriptorSha256: 'a'.repeat(64),
      },
      archive: {
        sha256: ARCHIVE_SHA,
        version: '2.0.0',
        manifestSha256,
      },
      dependencyVerification: {
        method: 'local-empty-v1',
        declarationSha256: sha256('[]'),
        count: 0,
      },
    },
    previous: { state: 'absent' },
  });
  const nextContentLock = {
    schemaVersion: '1.0' as const,
    manifestSha256,
    packVersion: manifest.packVersion,
    source: manifest.source,
    capabilities: [],
    entries: [],
  };
  return {
    contentPlan,
    repertoireDependencyPlan,
    sourceProvenancePlan,
    nextContentLockSha256: sha256(serializeTemplateLock(nextContentLock)),
    nextRepertoireLockSha256:
      calculateProjectTemplateRepertoireDependencyLockSha256(
        incomingDependencyLock,
      ),
  };
}

function preview(overrides: Record<string, unknown> = {}) {
  return createProjectTemplateLocalApplyPreview({
    ...plans(),
    previousLocksSha256: 'f'.repeat(64),
    baselineStrategy: 'adopt-identical',
    ...overrides,
  } as never);
}

describe('local project template transaction preview', () => {
  it('binds the local archive and exact 000 cohort without GitHub authority', () => {
    const result = preview();
    const rendered = renderProjectTemplateApplyPreviewJson(result);

    expect(result.transactionPlanId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bindings.transactionPlanId).toBe(result.transactionPlanId);
    expect(result.bindings.previousLocksSha256).toBe('f'.repeat(64));
    expect(result.sourceHardConflict).toBe(false);
    expect(rendered).toContain(result.transactionPlanId);
    expect(rendered).not.toContain('github-ref-to-commit-v1');
    expect(rendered).not.toContain('repositoryUrl');
  });

  it('domain-binds current and next locks and baseline independently', () => {
    const original = preview();
    for (const override of [
      { previousLocksSha256: '7'.repeat(64) },
      { nextContentLockSha256: '6'.repeat(64) },
      { nextRepertoireLockSha256: '5'.repeat(64) },
      { baselineStrategy: 'conflict' },
    ]) {
      expect(preview(override).transactionPlanId)
        .not.toBe(original.transactionPlanId);
    }
  });

  it('rejects remote provenance and cloned planning authority', () => {
    const value = plans();
    const remoteSource = {
      ...value,
      sourceProvenancePlan: createProjectTemplateSourceProvenancePlan({
        incoming: {
          schemaVersion: '1.0',
          source: {
            owner: 'acme',
            repo: 'template',
            repositoryUrl: 'https://github.com/acme/template',
            canonicalSource: 'github:acme/template@refs/tags/v2.0.0',
            requestedRef: 'refs/tags/v2.0.0',
            releaseTag: 'v2.0.0',
            commit: COMMIT,
            descriptorSha256: 'a'.repeat(64),
          },
          archive: {
            sha256: ARCHIVE_SHA,
            version: '2.0.0',
            manifestSha256: value.contentPlan.incomingManifestSha256,
          },
          dependencyVerification: {
            method: 'github-ref-to-commit-v1',
            declarationSha256: sha256('[]'),
            count: 0,
          },
        },
        previous: { state: 'absent' },
      }),
    };
    expect(() => createProjectTemplateLocalApplyPreview({
      ...remoteSource,
      previousLocksSha256: 'f'.repeat(64),
      baselineStrategy: 'adopt-identical',
    })).toThrow();
    expect(() => createProjectTemplateLocalApplyPreview({
      ...value,
      sourceProvenancePlan: structuredClone(value.sourceProvenancePlan),
      previousLocksSha256: 'f'.repeat(64),
      baselineStrategy: 'adopt-identical',
    })).toThrow();
  });
});
