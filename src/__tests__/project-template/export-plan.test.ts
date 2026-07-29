import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateExportPlan,
  validateManifestLockPair,
} from '../../features/project-template/index.js';

const roots: string[] = [];
const source = {
  kind: 'local' as const,
  uri: '.',
  ref: 'workspace' as const,
  commit: 'a'.repeat(40),
};

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'taktpack-plan-'));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, '.takt', relativePath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template export plan', () => {
  it('builds a manifest, lock, file plan, and redacted exclusion counts', async () => {
    const root = makeProject({
      'workflows/review.yaml': 'name: review\n',
      'tasks.yaml': 'private runtime task',
    });

    const plan = await createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
    });

    expect(plan.manifest.entries).toEqual([
      expect.objectContaining({
        path: 'workflows/review.yaml',
        policy: 'merge',
        mode: '0644',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect((plan as unknown as Record<string, unknown>)['files']).toBeUndefined();
    expect(plan.report).toMatchObject({
      counts: { managed: 0, merge: 1, scaffold: 0, excluded: 1 },
      excludedReasons: { RUNTIME_STATE: 1 },
      warnings: [],
    });
    expect(Object.isFrozen(plan.report.warnings)).toBe(true);
    expect(JSON.stringify(plan.report)).not.toContain(root);
    expect(JSON.stringify(plan)).not.toContain(root);
    expect(() => validateManifestLockPair(plan.manifest, plan.lock)).not.toThrow();
  });

  it('fails closed when the scan contains a sensitive file', async () => {
    const root = makeProject({
      'workflows/review.yaml': 'name: review\n',
      '.env': 'TOKEN=secret',
    });

    await expect(createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
    })).rejects.toMatchObject({ code: 'INVALID_EXPORT_PLAN' });
  });

  it('requires explicit approval for detected capabilities', async () => {
    const root = makeProject({
      'workflows/release.yaml': 'steps:\n  - run: npm test\n',
    });
    const options = {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
    };

    await expect(createProjectTemplateExportPlan(root, options))
      .rejects.toMatchObject({ code: 'EXPORT_REVIEW_REQUIRED' });

    const approved = await createProjectTemplateExportPlan(root, {
      ...options,
      approvedCapabilities: ['external-command'],
    });
    expect(approved.manifest.capabilities).toEqual(['external-command']);
    expect(approved.manifest.entries[0]?.capabilities).toEqual(['external-command']);
  });

  it('requires an explicit policy for project-owned configuration', async () => {
    const root = makeProject({ 'config.yaml': 'language: ja\n' });
    const options = {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
    };

    await expect(createProjectTemplateExportPlan(root, options))
      .rejects.toMatchObject({ code: 'EXPORT_REVIEW_REQUIRED' });

    const approved = await createProjectTemplateExportPlan(root, {
      ...options,
      policies: { 'config.yaml': 'managed' },
    });
    expect(approved.manifest.entries[0]?.policy).toBe('managed');
  });
});
