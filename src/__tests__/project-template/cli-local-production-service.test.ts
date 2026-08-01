import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import {
  createProductionProjectTemplateCliLocalApplyPort,
  settleProjectTemplateCliLocalExecutionAfterLease,
} from '../../features/project-template/local-transaction-apply-facade.js';

const roots: string[] = [];

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function fixture(options: {
  readonly commit?: string;
  readonly workflowName?: string;
} = {}): Promise<{ archivePath: string; targetRoot: string }> {
  const sourceRoot = root('takt-local-service-source-');
  mkdirSync(join(sourceRoot, '.takt'), { mode: 0o700 });
  mkdirSync(join(sourceRoot, '.takt', 'workflows'), { mode: 0o700 });
  writeFileSync(
    join(sourceRoot, '.takt', 'workflows', 'review.yaml'),
    `name: ${options.workflowName ?? 'review'}
max_steps: 10
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`,
  );
  const exportPlan = await createProjectTemplateExportPlan(sourceRoot, {
    packVersion: '1.0.0',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'local',
      uri: '.',
      ref: 'workspace',
      commit: options.commit ?? 'a'.repeat(40),
    },
  });
  const archivePath = join(sourceRoot, 'template.taktpack');
  await writeTaktpack(archivePath, exportPlan);
  return { archivePath, targetRoot: root('takt-local-service-target-') };
}

describe('production local project-template CLI composition', () => {
  it('reports an indeterminate result when lease release cannot be proven', () => {
    const committed = {
      status: 'committed' as const,
      backupId: 'backup-1',
      transactionPlanId: 'a'.repeat(64),
    };

    expect(settleProjectTemplateCliLocalExecutionAfterLease(
      committed,
      () => { throw new Error('release failed'); },
    )).toEqual({ status: 'indeterminate' });
  });

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
    expect(readFileSync(
      join(targetRoot, '.takt', 'workflows', 'review.yaml'),
      'utf8',
    )).toContain('initial_step: review');
    expect(existsSync(join(targetRoot, '.takt-template-state', 'apply.lock')))
      .toBe(false);
  });

  it('keeps an exact local 111 cohort without issuing a second approval', async () => {
    const { archivePath, targetRoot } = await fixture();
    const service = createProductionProjectTemplateCliLocalApplyService();
    const common = {
      cwd: targetRoot,
      sourcePath: archivePath,
      currentTaktVersion: '0.48.0',
      force: true,
    };
    const firstPreview = await service.diff(common);
    if (firstPreview.envelope.status !== 'success') throw new Error('preview failed');
    const first = await service.apply({
      ...common,
      mode: 'apply',
      expectedPlanId: firstPreview.envelope.result.planId,
    });
    expect(first.exitCode).toBe(0);
    const approvalRoot = join(targetRoot, '.takt-template-state', 'approvals');
    const approvalsBefore = readdirSync(approvalRoot).sort();

    const secondPreview = await service.diff({ ...common, force: false });
    if (secondPreview.envelope.status !== 'success') throw new Error('preview failed');
    expect(secondPreview.envelope.result.readiness).toBe('ready');
    const second = await service.apply({
      ...common,
      force: false,
      mode: 'apply',
      expectedPlanId: secondPreview.envelope.result.planId,
    });

    expect(second.exitCode).toBe(0);
    expect(readdirSync(approvalRoot).sort()).toEqual(approvalsBefore);
  });

  it('does not mutate when target or companion evidence drifts after diff', async () => {
    const targetFixture = await fixture();
    const service = createProductionProjectTemplateCliLocalApplyService();
    const common = {
      cwd: targetFixture.targetRoot,
      sourcePath: targetFixture.archivePath,
      currentTaktVersion: '0.48.0',
      force: true,
    };
    const preview = await service.diff(common);
    if (preview.envelope.status !== 'success') throw new Error('preview failed');
    mkdirSync(join(targetFixture.targetRoot, '.takt', 'workflows'), { recursive: true });
    const foreignPath = join(
      targetFixture.targetRoot,
      '.takt',
      'workflows',
      'review.yaml',
    );
    writeFileSync(foreignPath, 'name: foreign\n');
    const drift = await service.apply({
      ...common,
      mode: 'apply',
      expectedPlanId: preview.envelope.result.planId,
    });
    expect(drift).toMatchObject({
      envelope: { status: 'error', error: { code: 'PLAN_DRIFT' } },
    });
    expect(readFileSync(foreignPath, 'utf8')).toBe('name: foreign\n');
    expect(existsSync(join(targetFixture.targetRoot, '.takt-template-lock.json')))
      .toBe(false);

    const installed = await fixture();
    const installService = createProductionProjectTemplateCliLocalApplyService();
    const installCommon = {
      cwd: installed.targetRoot,
      sourcePath: installed.archivePath,
      currentTaktVersion: '0.48.0',
      force: true,
    };
    const installPreview = await installService.diff(installCommon);
    if (installPreview.envelope.status !== 'success') throw new Error('preview failed');
    expect((await installService.apply({
      ...installCommon,
      mode: 'apply',
      expectedPlanId: installPreview.envelope.result.planId,
    })).exitCode).toBe(0);
    const updatePreview = await installService.diff(installCommon);
    if (updatePreview.envelope.status !== 'success') throw new Error('preview failed');
    const sourceLock = join(installed.targetRoot, '.takt-template-source-lock.json');
    writeFileSync(sourceLock, 'foreign\n');
    const cohortDrift = await installService.apply({
      ...installCommon,
      mode: 'apply',
      expectedPlanId: updatePreview.envelope.result.planId,
    });
    expect(cohortDrift).toMatchObject({
      envelope: { status: 'error', error: { code: 'SOURCE_INTEGRITY_FAILED' } },
    });
    expect(readFileSync(sourceLock, 'utf8')).toBe('foreign\n');
  });

  it('does not mutate when the local archive changes after diff', async () => {
    const { archivePath, targetRoot } = await fixture();
    const service = createProductionProjectTemplateCliLocalApplyService();
    const common = {
      cwd: targetRoot,
      sourcePath: archivePath,
      currentTaktVersion: '0.48.0',
      force: true,
    };
    const preview = await service.diff(common);
    if (preview.envelope.status !== 'success') throw new Error('preview failed');
    writeFileSync(archivePath, Buffer.concat([
      readFileSync(archivePath),
      Buffer.from('foreign'),
    ]));

    const result = await service.apply({
      ...common,
      mode: 'apply',
      expectedPlanId: preview.envelope.result.planId,
    });

    expect(result).toMatchObject({
      envelope: { status: 'error', error: { code: 'SOURCE_INTEGRITY_FAILED' } },
    });
    expect(existsSync(join(targetRoot, '.takt-template-lock.json'))).toBe(false);
    expect(existsSync(join(targetRoot, '.takt-template-state', 'apply.lock')))
      .toBe(false);
  });

  it('classifies a valid archive replacement during lease admission as source integrity drift', async () => {
    const initial = await fixture();
    const replacement = await fixture({
      commit: 'b'.repeat(40),
      workflowName: 'replacement',
    });
    const port = createProductionProjectTemplateCliLocalApplyPort();
    const derived = await port.derive({
      cwd: initial.targetRoot,
      sourcePath: initial.archivePath,
      currentTaktVersion: '0.48.0',
    });
    copyFileSync(replacement.archivePath, initial.archivePath);

    await expect(port.execute({
      cwd: initial.targetRoot,
      sourcePath: initial.archivePath,
      currentTaktVersion: '0.48.0',
      expectedTransactionPlanId: derived.transactionPlanId,
      force: true,
      derived,
    })).resolves.toEqual({
      status: 'not_started',
      code: 'SOURCE_INTEGRITY_FAILED',
    });
  });

  it('classifies valid companion cohort replacement during lease admission as base-lock drift', async () => {
    const initial = await fixture({ commit: 'a'.repeat(40) });
    const replacement = await fixture({ commit: 'b'.repeat(40) });
    for (const value of [initial, replacement]) {
      const service = createProductionProjectTemplateCliLocalApplyService();
      const common = {
        cwd: value.targetRoot,
        sourcePath: value.archivePath,
        currentTaktVersion: '0.48.0',
        force: true,
      };
      const preview = await service.diff(common);
      if (preview.envelope.status !== 'success') throw new Error('preview failed');
      expect((await service.apply({
        ...common,
        mode: 'apply',
        expectedPlanId: preview.envelope.result.planId,
      })).exitCode).toBe(0);
    }
    const port = createProductionProjectTemplateCliLocalApplyPort();
    const derived = await port.derive({
      cwd: initial.targetRoot,
      sourcePath: initial.archivePath,
      currentTaktVersion: '0.48.0',
    });
    for (const path of [
      '.takt-template-lock.json',
      '.takt-template-repertoire-lock.json',
      '.takt-template-source-lock.json',
    ]) copyFileSync(join(replacement.targetRoot, path), join(initial.targetRoot, path));

    await expect(port.execute({
      cwd: initial.targetRoot,
      sourcePath: initial.archivePath,
      currentTaktVersion: '0.48.0',
      expectedTransactionPlanId: derived.transactionPlanId,
      force: false,
      derived,
    })).resolves.toEqual({ status: 'not_started', code: 'BASE_LOCK_DRIFT' });
  });

  it('classifies target replacement during lease admission as target drift', async () => {
    const value = await fixture();
    const port = createProductionProjectTemplateCliLocalApplyPort();
    const derived = await port.derive({
      cwd: value.targetRoot,
      sourcePath: value.archivePath,
      currentTaktVersion: '0.48.0',
    });
    const target = join(value.targetRoot, '.takt', 'workflows', 'review.yaml');
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, 'foreign\n');

    await expect(port.execute({
      cwd: value.targetRoot,
      sourcePath: value.archivePath,
      currentTaktVersion: '0.48.0',
      expectedTransactionPlanId: derived.transactionPlanId,
      force: true,
      derived,
    })).resolves.toEqual({ status: 'not_started', code: 'TARGET_DRIFT' });
    expect(readFileSync(target, 'utf8')).toBe('foreign\n');
  });

  it('maps an abort during the lease-held re-derive and releases the lease', async () => {
    const { archivePath, targetRoot } = await fixture();
    const port = createProductionProjectTemplateCliLocalApplyPort();
    const controller = new AbortController();
    const derived = await port.derive({
      cwd: targetRoot,
      sourcePath: archivePath,
      currentTaktVersion: '0.48.0',
      signal: controller.signal,
    });
    controller.abort();

    const result = await port.execute({
      cwd: targetRoot,
      sourcePath: archivePath,
      currentTaktVersion: '0.48.0',
      expectedTransactionPlanId: derived.transactionPlanId,
      force: true,
      derived,
      signal: controller.signal,
    });

    expect(result).toEqual({ status: 'not_started', code: 'INTERRUPTED' });
    expect(existsSync(join(targetRoot, '.takt-template-lock.json'))).toBe(false);
    expect(existsSync(join(targetRoot, '.takt-template-state', 'approvals')))
      .toBe(false);
    expect(existsSync(join(targetRoot, '.takt-template-state', 'apply.lock')))
      .toBe(false);
  });

  it('maps pre-admission abort to 130 without creating lease state', async () => {
    const { archivePath, targetRoot } = await fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await createProductionProjectTemplateCliLocalApplyService().apply({
      cwd: targetRoot,
      sourcePath: archivePath,
      currentTaktVersion: '0.48.0',
      force: true,
      mode: 'apply',
      expectedPlanId: 'a'.repeat(64),
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      exitCode: 130,
      envelope: { status: 'error', error: { code: 'INTERRUPTED' } },
    });
    expect(existsSync(join(targetRoot, '.takt-template-state'))).toBe(false);
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
