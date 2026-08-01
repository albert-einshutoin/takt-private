import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeTaktpack } from '../../features/project-template/archive-writer.js';
import {
  createProductionProjectTemplateCliLocalApplyService,
} from '../../features/project-template/cli-local-apply-service.js';
import { createProjectTemplateExportPlan } from '../../features/project-template/export-plan.js';
import {
  acquireProjectTemplateApplyLease,
} from '../../features/project-template/apply-lease.js';

const roots: string[] = [];

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function fixture(): Promise<{ archivePath: string; targetRoot: string }> {
  const sourceRoot = root('takt-local-service-source-');
  mkdirSync(join(sourceRoot, '.takt'), { mode: 0o700 });
  const exportPlan = await createProjectTemplateExportPlan(sourceRoot, {
    packVersion: '1.0.0',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'local',
      uri: '.',
      ref: 'workspace',
      commit: 'a'.repeat(40),
    },
  });
  const archivePath = join(sourceRoot, 'template.taktpack');
  await writeTaktpack(archivePath, exportPlan);
  return { archivePath, targetRoot: root('takt-local-service-target-') };
}

describe('production local project-template CLI composition', () => {
  it('re-derives under lease and commits the exact first-install cohort', async () => {
    const { archivePath, targetRoot } = await fixture();
    const service = createProductionProjectTemplateCliLocalApplyService();
    const common = {
      cwd: targetRoot,
      sourcePath: archivePath,
      currentTaktVersion: '0.48.0',
      force: true,
    };
    const preview = await service.diff(common);
    if (preview.envelope.status !== 'success') throw new Error('expected preview');
    const result = await service.apply({
      ...common,
      mode: 'apply',
      expectedPlanId: preview.envelope.result.planId,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      envelope: {
        status: 'success',
        result: {
          planId: preview.envelope.result.planId,
          applied: true,
          recoveryState: 'clean',
        },
      },
    });
    for (const path of [
      '.takt-template-lock.json',
      '.takt-template-repertoire-lock.json',
      '.takt-template-source-lock.json',
    ]) expect(existsSync(join(targetRoot, path))).toBe(true);
    expect(existsSync(join(targetRoot, '.takt-template-state', 'apply.lock')))
      .toBe(false);
  });

  it('leaves no approval artifact when an existing lease blocks admission', async () => {
    const { archivePath, targetRoot } = await fixture();
    const lease = acquireProjectTemplateApplyLease(targetRoot);
    try {
      const service = createProductionProjectTemplateCliLocalApplyService();
      const result = await service.apply({
        cwd: targetRoot,
        sourcePath: archivePath,
        currentTaktVersion: '0.48.0',
        force: true,
        mode: 'apply',
        expectedPlanId: 'a'.repeat(64),
      });

      expect(result).toMatchObject({
        envelope: { status: 'error', error: { code: 'LEASE_UNAVAILABLE' } },
      });
      expect(existsSync(join(targetRoot, '.takt-template-state', 'approvals')))
        .toBe(false);
    } finally {
      lease.release();
    }
  });
});
