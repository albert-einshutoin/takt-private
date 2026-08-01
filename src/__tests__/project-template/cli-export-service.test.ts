import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeProjectTemplateCliExport } from '../../features/project-template/cli-export-service.js';
import type { ProjectTemplateExportOptions } from '../../features/project-template/archive-types.js';

const cleanupRoots = new Set<string>();
const exportOptions: ProjectTemplateExportOptions = {
  packVersion: '1.0.0',
  takt: { minVersion: '0.48.0' },
  source: {
    kind: 'local',
    uri: '.',
    ref: 'workspace',
    commit: 'a'.repeat(40),
  },
};

function makeFixture(): { root: string; sourcePath: string; outputPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'takt-cli-export-'));
  cleanupRoots.add(root);
  const sourcePath = join(root, '.takt', 'workflows', 'review.yaml');
  mkdirSync(join(sourcePath, '..'), { recursive: true });
  writeFileSync(sourcePath, 'name: review\n');
  const outputDir = join(root, 'exports');
  mkdirSync(outputDir);
  return { root, sourcePath, outputPath: join(outputDir, 'template.taktpack') };
}

function dryRun(root: string, outputPath: string, force = false) {
  return executeProjectTemplateCliExport({
    projectRoot: root,
    outputPath,
    exportOptions,
    mutation: { mode: 'dry-run', force },
  });
}

afterEach(() => {
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
  cleanupRoots.clear();
});

describe('project template CLI export service', () => {
  it('admits exact-once only after the exact export plan is revalidated', async () => {
    const fixture = makeFixture();
    const preview = await dryRun(fixture.root, fixture.outputPath);
    const planId = preview.envelope.status === 'success' && 'planId' in preview.envelope.result
      ? preview.envelope.result.planId : '';
    const controller = new AbortController();
    const admitMutation = vi.fn(() => controller.abort());
    const outcome = await executeProjectTemplateCliExport({
      projectRoot: fixture.root, outputPath: fixture.outputPath, exportOptions,
      mutation: { mode: 'apply', force: false, expectedPlanId: planId },
      signal: controller.signal, admitMutation,
    });
    expect(admitMutation).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ exitCode: 0, envelope: { status: 'success' } });
    expect(existsSync(fixture.outputPath)).toBe(true);
  });
  it('maps an admission interrupt before archive publication', async () => {
    const fixture = makeFixture();
    const preview = await dryRun(fixture.root, fixture.outputPath);
    const planId = preview.envelope.status === 'success' && 'planId' in preview.envelope.result
      ? preview.envelope.result.planId : '';
    const controller = new AbortController();
    const outcome = await executeProjectTemplateCliExport({
      projectRoot: fixture.root, outputPath: fixture.outputPath, exportOptions,
      mutation: { mode: 'apply', force: false, expectedPlanId: planId }, signal: controller.signal,
      admitMutation() { controller.abort(); throw new Error('interrupt'); },
    });
    expect(outcome).toMatchObject({ exitCode: 130, envelope: { error: { code: 'INTERRUPTED' } } });
    expect(existsSync(fixture.outputPath)).toBe(false);
    const generic = await executeProjectTemplateCliExport({
      projectRoot: fixture.root, outputPath: fixture.outputPath, exportOptions,
      mutation: { mode: 'apply', force: false, expectedPlanId: planId },
      admitMutation() { throw new Error('failed'); },
    });
    expect(generic).toMatchObject({ exitCode: 70, envelope: { error: { code: 'INTERNAL' } } });
    expect(existsSync(fixture.outputPath)).toBe(false);
  });
  it('returns a deterministic closed dry-run DTO without writing an archive', async () => {
    const fixture = makeFixture();
    const admitMutation = vi.fn();

    const first = await executeProjectTemplateCliExport({
      projectRoot: fixture.root, outputPath: fixture.outputPath, exportOptions,
      mutation: { mode: 'dry-run', force: false }, admitMutation,
    });
    const second = await dryRun(fixture.root, fixture.outputPath);

    expect(first).toEqual(second);
    expect(admitMutation).not.toHaveBeenCalled();
    expect(first).toMatchObject({
      exitCode: 0,
      envelope: {
        command: 'project-template export',
        mode: 'dry-run',
        status: 'success',
        result: {
          planId: expect.stringMatching(/^[a-f0-9]{64}$/u),
          entryCount: 1,
          archiveBytes: 0,
          dependencyCount: 0,
          readiness: 'ready',
          reviewCodes: [],
        },
      },
    });
    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(JSON.stringify(first)).not.toContain(fixture.root);
  });

  it('binds source snapshots and output preconditions into the plan id', async () => {
    const fixture = makeFixture();
    const beforeSourceChange = await dryRun(fixture.root, fixture.outputPath, true);
    writeFileSync(fixture.sourcePath, 'name: changed\n');
    const afterSourceChange = await dryRun(fixture.root, fixture.outputPath, true);
    writeFileSync(fixture.outputPath, 'existing archive');
    const afterTargetChange = await dryRun(fixture.root, fixture.outputPath, true);

    expect(beforeSourceChange.envelope.status).toBe('success');
    expect(afterSourceChange.envelope.status).toBe('success');
    expect(afterTargetChange.envelope.status).toBe('success');
    if (
      beforeSourceChange.envelope.status === 'success'
      && afterSourceChange.envelope.status === 'success'
      && afterTargetChange.envelope.status === 'success'
    ) {
      expect(afterSourceChange.envelope.result.planId)
        .not.toBe(beforeSourceChange.envelope.result.planId);
      expect(afterTargetChange.envelope.result.planId)
        .not.toBe(afterSourceChange.envelope.result.planId);
    }
  });

  it('requires the exact fresh plan id before invoking the archive writer', async () => {
    const fixture = makeFixture();
    const admitMutation = vi.fn();

    const outcome = await executeProjectTemplateCliExport({
      projectRoot: fixture.root,
      outputPath: fixture.outputPath,
      exportOptions,
      mutation: { mode: 'apply', force: false, expectedPlanId: 'f'.repeat(64) },
      admitMutation,
    });

    expect(outcome).toMatchObject({
      exitCode: 22,
      envelope: { status: 'error', error: { code: 'PLAN_DRIFT' } },
    });
    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(readdirSync(join(fixture.root, 'exports'))).toEqual([]);
    expect(admitMutation).not.toHaveBeenCalled();
  });

  it('delegates the only archive write to the core atomic writer after re-planning', async () => {
    const fixture = makeFixture();
    const plan = await dryRun(fixture.root, fixture.outputPath);
    expect(plan.envelope.status).toBe('success');
    if (plan.envelope.status !== 'success') return;

    const outcome = await executeProjectTemplateCliExport({
      projectRoot: fixture.root,
      outputPath: fixture.outputPath,
      exportOptions,
      mutation: {
        mode: 'apply',
        force: false,
        expectedPlanId: plan.envelope.result.planId,
      },
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: {
        status: 'success',
        mode: 'apply',
        result: {
          planId: plan.envelope.result.planId,
          packId: expect.stringMatching(/^[a-f0-9]{64}$/u),
          entryCount: 1,
          archiveBytes: expect.any(Number),
          dependencyCount: 0,
          readiness: 'ready',
          reviewCodes: [],
        },
      },
    });
    expect(readFileSync(fixture.outputPath).byteLength).toBeGreaterThan(0);
    expect(readdirSync(join(fixture.root, 'exports'))).toEqual(['template.taktpack']);
  });

  it('detects source and absent-to-present output drift with zero writes', async () => {
    const sourceFixture = makeFixture();
    const sourcePlan = await dryRun(sourceFixture.root, sourceFixture.outputPath);
    expect(sourcePlan.envelope.status).toBe('success');
    if (sourcePlan.envelope.status !== 'success') return;
    writeFileSync(sourceFixture.sourcePath, 'name: drifted\n');
    const sourceOutcome = await executeProjectTemplateCliExport({
      projectRoot: sourceFixture.root,
      outputPath: sourceFixture.outputPath,
      exportOptions,
      mutation: {
        mode: 'apply', force: false, expectedPlanId: sourcePlan.envelope.result.planId,
      },
    });
    expect(sourceOutcome).toMatchObject({
      exitCode: 22,
      envelope: { status: 'error', error: { code: 'PLAN_DRIFT' } },
    });
    expect(existsSync(sourceFixture.outputPath)).toBe(false);

    const targetFixture = makeFixture();
    const targetPlan = await dryRun(targetFixture.root, targetFixture.outputPath, true);
    expect(targetPlan.envelope.status).toBe('success');
    if (targetPlan.envelope.status !== 'success') return;
    writeFileSync(targetFixture.outputPath, 'do not replace');
    const targetOutcome = await executeProjectTemplateCliExport({
      projectRoot: targetFixture.root,
      outputPath: targetFixture.outputPath,
      exportOptions,
      mutation: {
        mode: 'apply', force: true, expectedPlanId: targetPlan.envelope.result.planId,
      },
    });
    expect(targetOutcome).toMatchObject({
      exitCode: 22,
      envelope: { status: 'error', error: { code: 'TARGET_DRIFT' } },
    });
    expect(readFileSync(targetFixture.outputPath, 'utf8')).toBe('do not replace');
  });

  it.each(['symlink', 'hardlink'] as const)(
    'never replaces an unsafe %s output even with force',
    async (kind) => {
      const fixture = makeFixture();
      const protectedPath = join(fixture.root, 'protected');
      writeFileSync(protectedPath, 'protected');
      if (kind === 'symlink') symlinkSync(protectedPath, fixture.outputPath);
      else linkSync(protectedPath, fixture.outputPath);

      const outcome = await dryRun(fixture.root, fixture.outputPath, true);

      expect(outcome).toMatchObject({
        exitCode: 23,
        envelope: { status: 'error', error: { code: 'SECURITY_GUARD' } },
      });
      expect(readFileSync(protectedPath, 'utf8')).toBe('protected');
    },
  );

  it('does not let force bypass an active run', async () => {
    const fixture = makeFixture();
    const admitMutation = vi.fn();
    const runDir = join(fixture.root, '.takt', 'runs', 'active-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
      task: 'active task',
      workflow: 'subscription-devloop',
      status: 'running',
      startTime: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const plan = await dryRun(fixture.root, fixture.outputPath, true);
    expect(plan).toMatchObject({
      exitCode: 0,
      envelope: {
        status: 'success',
        result: { readiness: 'blocked', reviewCodes: ['ACTIVE_RUN'] },
      },
    });
    expect(plan.envelope.status).toBe('success');
    if (plan.envelope.status !== 'success') return;

    const outcome = await executeProjectTemplateCliExport({
      projectRoot: fixture.root,
      outputPath: fixture.outputPath,
      exportOptions,
      mutation: {
        mode: 'apply', force: true, expectedPlanId: plan.envelope.result.planId,
      },
      admitMutation,
    });
    expect(outcome).toMatchObject({
      exitCode: 23,
      envelope: { status: 'error', error: { code: 'ACTIVE_RUN' } },
    });
    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(admitMutation).not.toHaveBeenCalled();
  });

  it('honors a pre-aborted signal without leaving an archive or temp file', async () => {
    const fixture = makeFixture();
    const controller = new AbortController();
    controller.abort();

    const outcome = await executeProjectTemplateCliExport({
      projectRoot: fixture.root,
      outputPath: fixture.outputPath,
      exportOptions,
      mutation: { mode: 'dry-run', force: false },
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({
      exitCode: 130,
      envelope: { status: 'error', error: { code: 'INTERRUPTED' } },
    });
    expect(readdirSync(join(fixture.root, 'exports'))).toEqual([]);
  });

  it.each([
    'after-project-root',
    'after-export-plan',
    'after-output-capture',
    'before-dry-run-success',
  ] as const)('rechecks abort %s before returning a dry-run plan', async (abortPhase) => {
    const fixture = makeFixture();
    const controller = new AbortController();

    const outcome = await executeProjectTemplateCliExport({
      projectRoot: fixture.root,
      outputPath: fixture.outputPath,
      exportOptions,
      mutation: { mode: 'dry-run', force: false },
      signal: controller.signal,
    }, {
      onPhase(phase) {
        if (phase === abortPhase) controller.abort();
      },
    });

    expect(outcome).toMatchObject({
      exitCode: 130,
      envelope: { status: 'error', error: { code: 'INTERRUPTED' } },
    });
    expect(readdirSync(join(fixture.root, 'exports'))).toEqual([]);
  });

  it('rechecks abort after the final apply authority capture before writer admission', async () => {
    const fixture = makeFixture();
    const dry = await dryRun(fixture.root, fixture.outputPath);
    expect(dry.envelope.status).toBe('success');
    if (dry.envelope.status !== 'success') return;
    const controller = new AbortController();

    const outcome = await executeProjectTemplateCliExport({
      projectRoot: fixture.root,
      outputPath: fixture.outputPath,
      exportOptions,
      mutation: {
        mode: 'apply',
        force: false,
        expectedPlanId: dry.envelope.result.planId,
      },
      signal: controller.signal,
    }, {
      onPhase(phase) {
        if (phase === 'after-final-output-capture') controller.abort();
      },
    });

    expect(outcome).toMatchObject({
      exitCode: 130,
      envelope: { status: 'error', error: { code: 'INTERRUPTED' } },
    });
    expect(readdirSync(join(fixture.root, 'exports'))).toEqual([]);
  });

  it('reports retained publication recovery as indeterminate without replacing foreign output', async () => {
    const fixture = makeFixture();
    writeFileSync(fixture.outputPath, 'approved-old');
    const dry = await dryRun(fixture.root, fixture.outputPath, true);
    expect(dry.envelope.status).toBe('success');
    if (dry.envelope.status !== 'success') return;

    const outcome = await executeProjectTemplateCliExport({
      projectRoot: fixture.root,
      outputPath: fixture.outputPath,
      exportOptions,
      mutation: {
        mode: 'apply',
        force: true,
        expectedPlanId: dry.envelope.result.planId,
      },
    }, {
      writerIoSeam: {
        onPhase(phase) {
          if (phase === 'post-publish') {
            rmSync(fixture.outputPath);
            writeFileSync(fixture.outputPath, 'foreign-replacement');
          }
        },
      },
    });

    expect(outcome).toMatchObject({
      exitCode: 25,
      envelope: { status: 'error', error: { code: 'RESULT_INDETERMINATE' } },
    });
    expect(readFileSync(fixture.outputPath, 'utf8')).toBe('foreign-replacement');
    const outputDirectory = join(fixture.root, 'exports');
    const recoveryDirectories = readdirSync(outputDirectory)
      .filter((name) => name.startsWith('.taktpack-recovery-'));
    expect(recoveryDirectories).toHaveLength(1);
    const recoveryDirectory = join(outputDirectory, recoveryDirectories[0]!);
    const recoveryStat = statSync(recoveryDirectory);
    expect(recoveryStat.isDirectory()).toBe(true);
    expect(recoveryStat.mode & 0o777).toBe(0o700);
    if (typeof process.getuid === 'function') {
      expect(recoveryStat.uid).toBe(process.getuid());
    }
    expect(readdirSync(recoveryDirectory).sort()).toEqual([
      'archive.tmp',
      'rollback',
    ]);
  });
});
