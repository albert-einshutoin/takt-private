import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertProjectTemplateApplyLeaseAvailable,
  inspectProjectTemplateApplyGuard,
  ProjectTemplateApplyLeaseUnavailableError,
  resolveProjectTemplateApplyLeasePath,
  resolveProjectTemplateRecoveryRequiredPath,
  resolveProjectTemplateRunStartMutexPath,
  type ProjectTemplateApplyGuardBlockCode,
} from '../../features/project-template/apply-guard.js';

const cleanupDirs = new Set<string>();
const now = new Date('2026-07-30T12:00:00.000Z');

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-project-template-apply-guard-'));
  cleanupDirs.add(dir);
  return dir;
}

function writeRunMeta(
  repoPath: string,
  slug: string,
  values: Record<string, unknown>,
): string {
  const runDir = join(repoPath, '.takt', 'runs', slug);
  mkdirSync(runDir, { recursive: true });
  const metaPath = join(runDir, 'meta.json');
  writeFileSync(metaPath, JSON.stringify({
    task: `Task ${slug}`,
    workflow: 'subscription-devloop',
    status: 'completed',
    startTime: '2026-07-30T11:00:00.000Z',
    ...values,
  }));
  return metaPath;
}

function writeLifecycleFile(
  repoPath: string,
  name: 'state.json' | 'stop-request.json',
  value: unknown,
): string {
  const stateDir = join(repoPath, '.devloop', 'daemon');
  mkdirSync(stateDir, { recursive: true });
  const filePath = join(stateDir, name);
  writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value));
  return filePath;
}

function blockCodes(repoPath: string): ProjectTemplateApplyGuardBlockCode[] {
  return inspectProjectTemplateApplyGuard({
    repoPath,
    now,
    staleAfterMinutes: 60,
  }).blocks.map((block) => block.code);
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describe('project template apply guard', () => {
  it('keeps coordination locks outside the managed .takt target', () => {
    const repoPath = makeTempRepo();

    expect(resolveProjectTemplateApplyLeasePath(repoPath)).toBe(
      join(resolve(repoPath), '.takt-template-state', 'apply.lock'),
    );
    expect(resolveProjectTemplateRunStartMutexPath(repoPath)).toBe(
      join(resolve(repoPath), '.takt-template-state', 'run-start.lock'),
    );
    expect(resolveProjectTemplateRecoveryRequiredPath(repoPath)).toBe(
      join(resolve(repoPath), '.takt-template-state', 'recovery-required.json'),
    );
  });

  it('passes only when run and personal daemon evidence is clear', () => {
    const repoPath = makeTempRepo();
    writeRunMeta(repoPath, 'completed-run', { status: 'completed' });

    const report = inspectProjectTemplateApplyGuard({ repoPath, now });

    expect(report).toMatchObject({
      status: 'pass',
      passed: true,
      repoPath: resolve(repoPath),
      blocks: [],
    });
  });

  it('blocks active and stale running runs separately', () => {
    const repoPath = makeTempRepo();
    writeRunMeta(repoPath, 'active-run', {
      status: 'running',
      updatedAt: '2026-07-30T11:30:00.000Z',
    });
    writeRunMeta(repoPath, 'stale-run', {
      status: 'running',
      updatedAt: '2026-07-30T09:00:00.000Z',
    });

    expect(blockCodes(repoPath)).toEqual(['ACTIVE_RUN', 'STALE_RUN']);
  });

  it.each([
    ['broken JSON', '{broken', 'RUN_METADATA_INVALID'],
    ['unreadable metadata path', undefined, 'RUN_METADATA_UNREADABLE'],
  ] as const)('fails closed for %s', (_name, content, code) => {
    const repoPath = makeTempRepo();
    const runDir = join(repoPath, '.takt', 'runs', 'unknown-run');
    mkdirSync(runDir, { recursive: true });
    const metaPath = join(runDir, 'meta.json');
    if (content === undefined) mkdirSync(metaPath);
    else writeFileSync(metaPath, content);

    expect(blockCodes(repoPath)).toContain(code);
  });

  it('fails closed when run metadata is missing', () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, '.takt', 'runs', 'missing-meta'), { recursive: true });

    expect(blockCodes(repoPath)).toContain('RUN_METADATA_MISSING');
  });

  it('ignores only a structurally valid DebugLogger directory without meta.json', () => {
    const repoPath = makeTempRepo();
    mkdirSync(
      join(repoPath, '.takt', 'runs', 'debug-2026-07-30T11-22-33', 'logs'),
      { recursive: true },
    );

    expect(blockCodes(repoPath)).not.toContain('RUN_METADATA_MISSING');
  });

  it('does not treat a DebugLogger-shaped symlink as an ignorable run directory', () => {
    const repoPath = makeTempRepo();
    const target = join(repoPath, 'debug-log-target');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(repoPath, '.takt', 'runs'), { recursive: true });
    symlinkSync(
      target,
      join(repoPath, '.takt', 'runs', 'debug-2026-07-30T11-22-33'),
    );

    expect(blockCodes(repoPath)).toContain('RUN_METADATA_UNREADABLE');
  });

  it.each([
    'debug-custom',
    'debug-2026-99-99T99-99-99',
    'debug-2026-07-30T11-22-33-extra',
  ])('keeps unknown or malformed debug-like run directory %s fail-closed', (slug) => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, '.takt', 'runs', slug), { recursive: true });

    expect(blockCodes(repoPath)).toContain('RUN_METADATA_MISSING');
  });

  it('keeps a DebugLogger-named directory with malformed meta.json fail-closed', () => {
    const repoPath = makeTempRepo();
    const runDir = join(
      repoPath,
      '.takt',
      'runs',
      'debug-2026-07-30T11-22-33',
    );
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'meta.json'), '{broken');

    expect(blockCodes(repoPath)).toContain('RUN_METADATA_INVALID');
  });

  it('blocks a live personal daemon', () => {
    const repoPath = makeTempRepo();
    writeLifecycleFile(repoPath, 'state.json', {
      version: 1,
      pid: 4242,
      startedAt: '2026-07-30T11:00:00.000Z',
      updatedAt: '2026-07-30T11:30:00.000Z',
      repoPath: resolve(repoPath),
      command: 'devloopd start',
      status: 'running',
      cycleCount: 1,
    });

    const report = inspectProjectTemplateApplyGuard({
      repoPath,
      now,
      probeProcess: () => 'alive',
    });

    expect(report.blocks).toContainEqual(expect.objectContaining({
      code: 'PERSONAL_DAEMON_RUNNING',
      pid: 4242,
    }));
  });

  it('fails closed for malformed lifecycle state and a stop request', () => {
    const repoPath = makeTempRepo();
    writeLifecycleFile(repoPath, 'state.json', '{broken');
    writeLifecycleFile(repoPath, 'stop-request.json', {
      version: 1,
      requestedAt: now.toISOString(),
      reason: 'maintenance',
    });

    expect(blockCodes(repoPath)).toEqual([
      'LIFECYCLE_STATE_INVALID',
      'STOP_REQUEST_PRESENT',
    ]);
  });

  it.each(['dead', 'unknown'] as const)(
    'fails closed when daemon process identity is %s',
    (probeResult) => {
      const repoPath = makeTempRepo();
      writeLifecycleFile(repoPath, 'state.json', {
        version: 1,
        pid: 4242,
        startedAt: '2026-07-30T11:00:00.000Z',
        updatedAt: '2026-07-30T11:30:00.000Z',
        repoPath: resolve(repoPath),
        command: 'devloopd start',
        status: 'running',
        cycleCount: 1,
      });

      const report = inspectProjectTemplateApplyGuard({
        repoPath,
        now,
        probeProcess: () => probeResult,
      });

      expect(report.blocks).toContainEqual(expect.objectContaining({
        code: 'PROCESS_IDENTITY_UNKNOWN',
        pid: 4242,
      }));
    },
  );

  it('converts process probe errors into a fail-closed report', () => {
    const repoPath = makeTempRepo();
    writeLifecycleFile(repoPath, 'state.json', {
      version: 1,
      pid: 4242,
      startedAt: '2026-07-30T11:00:00.000Z',
      updatedAt: '2026-07-30T11:30:00.000Z',
      repoPath: resolve(repoPath),
      command: 'devloopd start',
      status: 'running',
      cycleCount: 1,
    });

    const report = inspectProjectTemplateApplyGuard({
      repoPath,
      probeProcess: () => {
        throw new Error('permission denied');
      },
    });

    expect(report.blocks).toContainEqual(expect.objectContaining({
      code: 'PROCESS_IDENTITY_UNKNOWN',
    }));
  });

  it('allows an empty persistent automation schedules directory', () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, '.devloop', 'schedules'), { recursive: true });

    expect(inspectProjectTemplateApplyGuard({ repoPath }).passed).toBe(true);
  });

  it('blocks persistent automation when a schedule entry exists', () => {
    const repoPath = makeTempRepo();
    const schedulesPath = join(repoPath, '.devloop', 'schedules');
    mkdirSync(schedulesPath, { recursive: true });
    writeFileSync(join(schedulesPath, 'nightly.json'), '{}');

    expect(blockCodes(repoPath)).toContain('PERSISTENT_AUTOMATION_PRESENT');
  });

  it('fails closed when the schedules directory is a symlink', () => {
    const repoPath = makeTempRepo();
    const target = join(repoPath, 'external-schedules');
    mkdirSync(target);
    mkdirSync(join(repoPath, '.devloop'));
    symlinkSync(target, join(repoPath, '.devloop', 'schedules'));

    expect(blockCodes(repoPath)).toContain('PERSISTENT_AUTOMATION_UNKNOWN');
  });

  it('fails closed when the schedules path cannot be read as a directory', () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, '.devloop'));
    writeFileSync(join(repoPath, '.devloop', 'schedules'), 'not a directory');

    expect(blockCodes(repoPath)).toContain('PERSISTENT_AUTOMATION_UNKNOWN');
  });

  it('allows run startup only while the shared apply lease is absent', () => {
    const repoPath = makeTempRepo();
    expect(() => assertProjectTemplateApplyLeaseAvailable(repoPath)).not.toThrow();

    const lockPath = resolveProjectTemplateApplyLeasePath(repoPath);
    mkdirSync(join(lockPath, '..'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      token: 'apply-owner',
      pid: process.pid,
    }));

    let thrown: unknown;
    try {
      assertProjectTemplateApplyLeaseAvailable(repoPath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectTemplateApplyLeaseUnavailableError);
    expect(thrown).toMatchObject({ code: 'APPLY_LEASE_PRESENT', lockPath });
  });

  it('fails closed when a shared apply lease is malformed', () => {
    const repoPath = makeTempRepo();
    const lockPath = resolveProjectTemplateApplyLeasePath(repoPath);
    mkdirSync(join(lockPath, '..'), { recursive: true });
    writeFileSync(lockPath, '{broken');

    expect(() => assertProjectTemplateApplyLeaseAvailable(repoPath)).toThrow(
      ProjectTemplateApplyLeaseUnavailableError,
    );
  });

  it('allows only the apply operation that proves ownership of the lease token', () => {
    const repoPath = makeTempRepo();
    const lockPath = resolveProjectTemplateApplyLeasePath(repoPath);
    mkdirSync(join(lockPath, '..'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      token: 'apply-owner',
      pid: process.pid,
    }));

    const owned = inspectProjectTemplateApplyGuard({
      repoPath,
      ownedLease: { lockPath, token: 'apply-owner', pid: process.pid },
    });
    const wrongToken = inspectProjectTemplateApplyGuard({
      repoPath,
      ownedLease: { lockPath, token: 'different-owner', pid: process.pid },
    });

    expect(owned.passed).toBe(true);
    expect(wrongToken.blocks.map((block) => block.code)).toContain('APPLY_LEASE_UNKNOWN');
  });

  it('fails closed when claimed lease ownership has no durable lock', () => {
    const repoPath = makeTempRepo();
    const report = inspectProjectTemplateApplyGuard({
      repoPath,
      ownedLease: {
        lockPath: resolveProjectTemplateApplyLeasePath(repoPath),
        token: 'apply-owner',
        pid: process.pid,
      },
    });

    expect(report.blocks.map((block) => block.code)).toContain('APPLY_LEASE_UNKNOWN');
  });

  it.each([
    ['symlink', (path: string, repoPath: string) => {
      const source = join(repoPath, 'run-meta-source.json');
      writeFileSync(source, '{}');
      symlinkSync(source, path);
    }],
    ['hardlink', (path: string, repoPath: string) => {
      const source = join(repoPath, 'run-meta-source.json');
      writeFileSync(source, '{}');
      linkSync(source, path);
    }],
    ['oversize', (path: string) => writeFileSync(path, Buffer.alloc(1024 * 1024 + 1))],
  ] as const)('treats %s run metadata as unknown', (_name, install) => {
    const repoPath = makeTempRepo();
    const runDir = join(repoPath, '.takt', 'runs', 'unsafe-run');
    mkdirSync(runDir, { recursive: true });
    install(join(runDir, 'meta.json'), repoPath);

    expect(blockCodes(repoPath)).toContain('RUN_METADATA_UNREADABLE');
  });

  it.each([
    ['symlink', (path: string, repoPath: string) => {
      const source = join(repoPath, 'lifecycle-source.json');
      writeFileSync(source, '{}');
      symlinkSync(source, path);
    }],
    ['hardlink', (path: string, repoPath: string) => {
      const source = join(repoPath, 'lifecycle-source.json');
      writeFileSync(source, '{}');
      linkSync(source, path);
    }],
    ['oversize', (path: string) => writeFileSync(path, Buffer.alloc(1024 * 1024 + 1))],
  ] as const)('treats %s lifecycle state as unknown', (_name, install) => {
    const repoPath = makeTempRepo();
    const statePath = join(repoPath, '.devloop', 'daemon', 'state.json');
    mkdirSync(join(repoPath, '.devloop', 'daemon'), { recursive: true });
    install(statePath, repoPath);

    expect(blockCodes(repoPath)).toContain('LIFECYCLE_STATE_UNREADABLE');
  });

  it.each([
    ['symlink', (path: string, repoPath: string) => {
      const source = join(repoPath, 'lease-source.json');
      writeFileSync(source, JSON.stringify({ version: 1, token: 'unsafe-owner' }));
      symlinkSync(source, path);
    }],
    ['hardlink', (path: string, repoPath: string) => {
      const source = join(repoPath, 'lease-source.json');
      writeFileSync(source, JSON.stringify({ version: 1, token: 'unsafe-owner' }));
      linkSync(source, path);
    }],
    ['oversize', (path: string) => writeFileSync(path, Buffer.alloc(1024 * 1024 + 1))],
  ] as const)('treats %s apply lease as unknown', (_name, install) => {
    const repoPath = makeTempRepo();
    const lockPath = resolveProjectTemplateApplyLeasePath(repoPath);
    mkdirSync(join(lockPath, '..'), { recursive: true });
    install(lockPath, repoPath);

    expect(blockCodes(repoPath)).toContain('APPLY_LEASE_UNKNOWN');
  });

  it.each([
    ['symlink', (path: string, repoPath: string) => {
      const source = join(repoPath, 'recovery-source.json');
      writeFileSync(source, JSON.stringify({
        version: 1,
        token: 'owner',
        transactionId: 'transaction-1',
      }));
      symlinkSync(source, path);
    }],
    ['hardlink', (path: string, repoPath: string) => {
      const source = join(repoPath, 'recovery-source.json');
      writeFileSync(source, JSON.stringify({
        version: 1,
        token: 'owner',
        transactionId: 'transaction-1',
      }));
      linkSync(source, path);
    }],
    ['oversize', (path: string) => writeFileSync(path, Buffer.alloc(1024 * 1024 + 1))],
  ] as const)('treats %s recovery marker as unknown', (_name, install) => {
    const repoPath = makeTempRepo();
    const markerPath = resolveProjectTemplateRecoveryRequiredPath(repoPath);
    mkdirSync(join(markerPath, '..'), { recursive: true });
    install(markerPath, repoPath);

    expect(blockCodes(repoPath)).toContain('RECOVERY_REQUIRED_UNKNOWN');
    expect(() => assertProjectTemplateApplyLeaseAvailable(repoPath))
      .toThrow(ProjectTemplateApplyLeaseUnavailableError);
  });

  it('blocks a durable non-terminal apply journal even when no marker exists', () => {
    const repoPath = makeTempRepo();
    const journalPath = join(repoPath, '.takt-template-state', 'journal.json');
    mkdirSync(join(journalPath, '..'), { recursive: true });
    writeFileSync(journalPath, JSON.stringify({
      schemaVersion: '1.0',
      transactionId: 'apply-transaction-1',
      planId: 'a'.repeat(64),
      backupId: 'backup-1',
      state: 'committing',
      completedOperations: [],
      createdTargetDirectories: [],
      updatedAt: now.toISOString(),
    }));

    expect(blockCodes(repoPath)).toContain('RECOVERY_REQUIRED');
    expect(() => assertProjectTemplateApplyLeaseAvailable(repoPath))
      .toThrow(ProjectTemplateApplyLeaseUnavailableError);
  });

  it('fails closed for a terminal journal that violates the canonical schema', () => {
    const repoPath = makeTempRepo();
    const journalPath = join(repoPath, '.takt-template-state', 'journal.json');
    mkdirSync(join(journalPath, '..'), { recursive: true });
    writeFileSync(journalPath, JSON.stringify({
      schemaVersion: '1.0',
      transactionId: 'apply-transaction-1',
      planId: 'not-a-sha256',
      backupId: 'backup-1',
      state: 'committed',
      completedOperations: [],
      updatedAt: now.toISOString(),
    }));

    expect(blockCodes(repoPath)).toContain('RECOVERY_REQUIRED_UNKNOWN');
  });
});
