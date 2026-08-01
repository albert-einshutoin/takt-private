import { describe, expect, it } from 'vitest';
import {
  createProjectTemplateSourceProvenancePlan,
} from '../../features/project-template/source-provenance-plan.js';
import {
  calculateProjectTemplateSourceProvenanceSha256,
} from '../../features/project-template/source-provenance.js';

const COMMIT_A = '0123456789abcdef0123456789abcdef01234567';
const COMMIT_B = 'abcdef0123456789abcdef0123456789abcdef01';

function provenance(version = '2.1.0'): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    source: {
      owner: 'acme',
      repo: 'takt-template',
      repositoryUrl: 'https://github.com/acme/takt-template',
      canonicalSource: `github:acme/takt-template@refs/tags/v${version}`,
      requestedRef: `refs/tags/v${version}`,
      releaseTag: `v${version}`,
      commit: COMMIT_A,
      descriptorSha256: 'a'.repeat(64),
    },
    archive: {
      sha256: 'b'.repeat(64),
      version,
      manifestSha256: 'c'.repeat(64),
    },
    dependencyVerification: {
      method: 'github-ref-to-commit-v1',
      declarationSha256: 'd'.repeat(64),
      count: 0,
    },
  };
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return value[key] as Record<string, unknown>;
}

describe('project template source provenance plan', () => {
  it('plans a first install with the next canonical lock and review', () => {
    const incoming = provenance();
    const plan = createProjectTemplateSourceProvenancePlan({
      incoming,
      previous: { state: 'absent' },
    });

    expect(plan.action).toBe('install');
    expect(plan.changes).toEqual(['SOURCE_ADDED']);
    expect(plan.hardConflict).toBe(false);
    expect(plan.reviewRequired).toBe(true);
    expect(plan.nextProvenance).toEqual(incoming);
    expect(plan.nextProvenanceSha256)
      .toBe(calculateProjectTemplateSourceProvenanceSha256(incoming));
    expect(plan.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('recognizes an unchanged source without requiring review', () => {
    const incoming = provenance();
    const plan = createProjectTemplateSourceProvenancePlan({
      incoming,
      previous: { state: 'present', provenance: incoming },
    });

    expect(plan.action).toBe('keep');
    expect(plan.changes).toEqual([]);
    expect(plan.reviewRequired).toBe(false);
    expect(plan.hardConflict).toBe(false);
    expect(plan.previousProvenanceSha256).toBe(plan.nextProvenanceSha256);
  });

  it('plans an ordinary forward release update', () => {
    const previous = provenance('2.1.0');
    const incoming = provenance('2.2.0');
    nested(incoming, 'source')['commit'] = COMMIT_B;
    nested(incoming, 'source')['descriptorSha256'] = 'e'.repeat(64);
    nested(incoming, 'archive')['sha256'] = 'f'.repeat(64);
    nested(incoming, 'archive')['manifestSha256'] = '1'.repeat(64);
    const plan = createProjectTemplateSourceProvenancePlan({
      incoming,
      previous: { state: 'present', provenance: previous },
    });

    expect(plan.action).toBe('update');
    expect(plan.changes).toEqual([
      'REF_CHANGED',
      'RELEASE_TAG_CHANGED',
      'VERSION_CHANGED',
      'COMMIT_CHANGED',
      'DESCRIPTOR_CHANGED',
      'ARCHIVE_CHANGED',
      'MANIFEST_CHANGED',
    ]);
    expect(plan.reviewRequired).toBe(true);
    expect(plan.hardConflict).toBe(false);
  });

  it('hard-blocks repository changes', () => {
    const incoming = provenance();
    const source = nested(incoming, 'source');
    source['owner'] = 'other';
    source['repositoryUrl'] = 'https://github.com/other/takt-template';
    source['canonicalSource'] =
      'github:other/takt-template@refs/tags/v2.1.0';
    const plan = createProjectTemplateSourceProvenancePlan({
      incoming,
      previous: { state: 'present', provenance: provenance() },
    });

    expect(plan.changes).toContain('REPOSITORY_CHANGED');
    expect(plan.conflicts).toContain('REPOSITORY_CHANGED');
    expect(plan.hardConflict).toBe(true);
    expect(plan.defaultApplyPossible).toBe(false);
  });

  it('hard-blocks semantic version downgrades', () => {
    const plan = createProjectTemplateSourceProvenancePlan({
      incoming: provenance('2.0.0'),
      previous: { state: 'present', provenance: provenance('2.1.0') },
    });

    expect(plan.conflicts).toContain('VERSION_DOWNGRADE');
    expect(plan.hardConflict).toBe(true);
  });

  it('hard-blocks a republished tag even when archive fields also changed', () => {
    const incoming = provenance();
    nested(incoming, 'source')['commit'] = COMMIT_B;
    nested(incoming, 'source')['descriptorSha256'] = 'e'.repeat(64);
    nested(incoming, 'archive')['sha256'] = 'f'.repeat(64);
    const plan = createProjectTemplateSourceProvenancePlan({
      incoming,
      previous: { state: 'present', provenance: provenance() },
    });

    expect(plan.conflicts).toContain('TAG_REPUBLISHED');
    expect(plan.hardConflict).toBe(true);
  });

  it('records dependency verification evidence changes', () => {
    const incoming = provenance('2.2.0');
    const evidence = nested(incoming, 'dependencyVerification');
    evidence['declarationSha256'] = 'e'.repeat(64);
    evidence['count'] = 1;
    const plan = createProjectTemplateSourceProvenancePlan({
      incoming,
      previous: { state: 'present', provenance: provenance('2.1.0') },
    });

    expect(plan.changes).toContain('DEPENDENCY_EVIDENCE_CHANGED');
  });

  it('rejects unavailable and invalid previous source state fail-closed', () => {
    for (const previous of [
      { state: 'unavailable' as const },
      { state: 'present' as const, provenance: { schemaVersion: '1.0' } },
    ]) {
      expect(() => createProjectTemplateSourceProvenancePlan({
        incoming: provenance(),
        previous,
      })).toThrow();
    }
  });
});
