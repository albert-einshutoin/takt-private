import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  calculateProjectTemplateManifestSha256,
} from '../../features/project-template/binding.js';
import { createProjectTemplateApplyPlan } from '../../features/project-template/apply-plan.js';
import {
  claimProjectTemplateRepertoireDependencyInspectionForPlanning,
  inspectProjectTemplateRepertoireDependencies,
} from '../../features/project-template/repertoire-dependency-inspection-port.js';
import {
  createProjectTemplateRepertoireDependencyPlan,
} from '../../features/project-template/repertoire-dependency-plan.js';
import {
  calculateProjectTemplateRepertoireDependencyLockSha256,
} from '../../features/project-template/repertoire-dependency-lock.js';
import {
  createProjectTemplateSourceProvenancePlan,
} from '../../features/project-template/source-provenance-plan.js';
import {
  createProjectTemplateRemoteApplyPreview,
  renderProjectTemplateApplyPreviewJson,
} from '../../features/project-template/apply-preview.js';
import { serializeTemplateLock } from '../../features/project-template/lock.js';
import {
  consumeProjectTemplateApplyPreviewApproval,
  issueTrustedProjectTemplateApplyPreviewApproval,
} from '../../features/project-template/apply-preview-approval.js';
import {
  initializeProjectTemplateApplyStorage,
} from '../../features/project-template/apply-storage.js';
import { canonicalizeTaktpackJson } from '../../features/project-template/canonical-json.js';

const RECEIPT_KEY = '9'.repeat(64);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const roots: string[] = [];

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function repository(): string {
  const value = mkdtempSync(join(tmpdir(), 'takt-remote-approval-'));
  roots.push(value);
  mkdirSync(join(value, '.takt'), { mode: 0o700 });
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sourceProvenance(manifestSha256: string): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    source: {
      owner: 'acme',
      repo: 'takt-template',
      repositoryUrl: 'https://github.com/acme/takt-template',
      canonicalSource: 'github:acme/takt-template@refs/tags/v2.0.0',
      requestedRef: 'refs/tags/v2.0.0',
      releaseTag: 'v2.0.0',
      commit: COMMIT,
      descriptorSha256: 'a'.repeat(64),
    },
    archive: {
      sha256: 'b'.repeat(64),
      version: '2.0.0',
      manifestSha256,
    },
    dependencyVerification: {
      method: 'github-ref-to-commit-v1',
      declarationSha256: sha256('[]'),
      count: 0,
    },
  };
}

function plans() {
  const manifest = {
    schemaVersion: '1.0' as const,
    packVersion: '2.0.0',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'github' as const,
      uri: 'https://github.com/acme/takt-template' as const,
      ref: 'refs/tags/v2.0.0',
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
      archiveSha256: 'b'.repeat(64),
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
  const inspection = inspectProjectTemplateRepertoireDependencies({
    request: {
      sourceDescriptorSha256: 'a'.repeat(64),
      manifestSha256,
      dependencies: [],
      deadlineMs: Number.MAX_SAFE_INTEGER,
    },
    port: {
      inspect: () => ({ witnessSha256: 'e'.repeat(64), observations: [] }),
    },
  });
  const repertoireDependencyPlan = createProjectTemplateRepertoireDependencyPlan({
    inspectionClaim:
      claimProjectTemplateRepertoireDependencyInspectionForPlanning(inspection),
    incomingLock: incomingDependencyLock,
    previousLock: { state: 'absent' },
  });
  const provenance = sourceProvenance(manifestSha256);
  const sourceProvenancePlan = createProjectTemplateSourceProvenancePlan({
    incoming: provenance,
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
  return createProjectTemplateRemoteApplyPreview({
    ...plans(),
    receiptKey: RECEIPT_KEY,
    previousLocksSha256: 'f'.repeat(64),
    baselineStrategy: 'adopt-identical',
    ...overrides,
  } as never);
}

describe('remote project template composite preview', () => {
  it('binds content, dependency, source, cohort, preconditions, and baseline', () => {
    const result = preview();

    expect(result.transactionPlanId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bindings.transactionPlanId).toBe(result.transactionPlanId);
    expect(result.bindings.sourceProvenancePlanId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceHardConflict).toBe(false);
    expect(result.reviewRequired).toBe(true);
    expect(result.hardConflict).toBe(false);
    expect(result.defaultApplyPossible).toBe(false);
    expect(renderProjectTemplateApplyPreviewJson(result))
      .toContain(result.transactionPlanId);
    expect(renderProjectTemplateApplyPreviewJson(result)).not.toContain(RECEIPT_KEY);
  });

  it('domain-binds receipt, current and next locks, and baseline independently', () => {
    const original = preview();
    for (const override of [
      { receiptKey: '8'.repeat(64) },
      { previousLocksSha256: '7'.repeat(64) },
      { nextContentLockSha256: '6'.repeat(64) },
      { nextRepertoireLockSha256: '5'.repeat(64) },
      { baselineStrategy: 'conflict' },
    ]) {
      expect(preview(override).transactionPlanId).not.toBe(original.transactionPlanId);
    }
  });

  it('hard-blocks source provenance conflicts and cross-plan binding mismatches', () => {
    const pair = plans();
    const incoming = sourceProvenance(pair.contentPlan.incomingManifestSha256);
    (incoming['archive'] as Record<string, unknown>)['manifestSha256'] = '4'.repeat(64);
    const mismatchedSource = createProjectTemplateSourceProvenancePlan({
      incoming,
      previous: { state: 'absent' },
    });
    const mismatch = preview({ sourceProvenancePlan: mismatchedSource });
    expect(mismatch.compositionConflicts).toContain('SOURCE_MANIFEST_BINDING_MISMATCH');
    expect(mismatch.hardConflict).toBe(true);

    const previous = sourceProvenance(pair.contentPlan.incomingManifestSha256);
    const republished = sourceProvenance(pair.contentPlan.incomingManifestSha256);
    (republished['source'] as Record<string, unknown>)['commit'] =
      'abcdef0123456789abcdef0123456789abcdef01';
    const conflictPlan = createProjectTemplateSourceProvenancePlan({
      incoming: republished,
      previous: { state: 'present', provenance: previous },
    });
    const conflict = preview({ sourceProvenancePlan: conflictPlan });
    expect(conflict.sourceHardConflict).toBe(true);
    expect(conflict.hardConflict).toBe(true);
    expect(conflict.defaultApplyPossible).toBe(false);
  });

  it('rejects lookalike or incomplete transaction inputs', () => {
    const options = {
      ...plans(),
      receiptKey: RECEIPT_KEY,
      previousLocksSha256: 'f'.repeat(64),
      baselineStrategy: 'adopt-identical' as const,
    };
    expect(() => createProjectTemplateRemoteApplyPreview({
      ...options,
      sourceProvenancePlan: structuredClone(options.sourceProvenancePlan),
    } as never)).toThrow();
    expect(() => createProjectTemplateRemoteApplyPreview({
      ...options,
      nextContentLockSha256: undefined,
    } as never)).toThrow();
  });

  it('approval explicitly binds previewId and transactionPlanId single-use', async () => {
    const projectRoot = repository();
    const value = preview();
    const now = new Date('2026-08-01T00:00:00.000Z');
    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'adopt-identical',
      now,
    });
    const recordPath = join(
      projectRoot,
      '.takt-template-state',
      'approvals',
      `${evidence.approvalId}.json`,
    );
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    expect(record['previewId']).toBe(value.previewId);
    expect(record['transactionPlanId']).toBe(value.transactionPlanId);

    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage,
      preview: value,
      baselineStrategy: 'adopt-identical',
      evidence,
      now: new Date('2026-08-01T00:01:00.000Z'),
    })).resolves.toBe(true);
    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage,
      preview: value,
      baselineStrategy: 'adopt-identical',
      evidence,
      now: new Date('2026-08-01T00:01:00.000Z'),
    })).resolves.toBe(false);

    const tamperedEvidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'adopt-identical',
      now,
    });
    const tamperedPath = join(
      projectRoot,
      '.takt-template-state',
      'approvals',
      `${tamperedEvidence.approvalId}.json`,
    );
    const tampered = JSON.parse(readFileSync(tamperedPath, 'utf8')) as Record<string, unknown>;
    tampered['transactionPlanId'] = '0'.repeat(64);
    writeFileSync(tamperedPath, `${canonicalizeTaktpackJson(tampered)}\n`, { mode: 0o600 });
    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage,
      preview: value,
      baselineStrategy: 'adopt-identical',
      evidence: tamperedEvidence,
      now: new Date('2026-08-01T00:01:00.000Z'),
    })).resolves.toBe(false);
  });
});
