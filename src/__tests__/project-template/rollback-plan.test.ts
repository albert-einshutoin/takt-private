import { describe, expect, it } from 'vitest';
import {
  createProjectTemplateRollbackPlan,
} from '../../features/project-template/rollback-plan.js';

const HASH = {
  manifest: 'a'.repeat(64),
  target: 'b'.repeat(64),
  cohort: 'c'.repeat(64),
};

describe('project template rollback plan', () => {
  it('seals the exact backup, manifest, current target, and companion cohort', () => {
    const plan = createProjectTemplateRollbackPlan({
      backupId: 'backup-1',
      backupManifestSha256: HASH.manifest,
      currentTargetSha256: HASH.target,
      currentCompanionLocksSha256: HASH.cohort,
    });

    expect(plan).toEqual({
      schemaVersion: '1.0',
      backupId: 'backup-1',
      backupManifestSha256: HASH.manifest,
      currentTargetSha256: HASH.target,
      currentCompanionLocksSha256: HASH.cohort,
      planId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.isFrozen(plan)).toBe(true);

    for (const changed of [
      { backupId: 'backup-2' },
      { backupManifestSha256: 'd'.repeat(64) },
      { currentTargetSha256: 'e'.repeat(64) },
      { currentCompanionLocksSha256: 'f'.repeat(64) },
    ]) {
      expect(createProjectTemplateRollbackPlan({
        backupId: 'backup-1',
        backupManifestSha256: HASH.manifest,
        currentTargetSha256: HASH.target,
        currentCompanionLocksSha256: HASH.cohort,
        ...changed,
      }).planId).not.toBe(plan.planId);
    }
  });

  it.each([
    { backupId: '../backup' },
    { backupManifestSha256: 'A'.repeat(64) },
    { currentTargetSha256: 'short' },
    { currentCompanionLocksSha256: '0'.repeat(63) },
  ])('rejects unbounded or non-canonical witness input %#', (changed) => {
    expect(() => createProjectTemplateRollbackPlan({
      backupId: 'backup-1',
      backupManifestSha256: HASH.manifest,
      currentTargetSha256: HASH.target,
      currentCompanionLocksSha256: HASH.cohort,
      ...changed,
    })).toThrow();
  });
});
