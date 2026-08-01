import type { Stats } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TaktpackError } from '../../features/project-template/errors.js';
import {
  inspectProjectTemplateForCliWithDependencies,
  listProjectTemplatesForCliWithDependencies,
  type ProjectTemplateCliInspectListDependencies,
} from '../../features/project-template/cli-inspect-list-service.js';

const SHA = 'a'.repeat(64);

function stableFile(size = 1024): Stats {
  return {
    dev: 1,
    ino: 2,
    nlink: 1,
    size,
    mode: 0o100600,
    mtimeMs: 10,
    ctimeMs: 11,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  } as Stats;
}

function stableDirectory(): Stats {
  return {
    ...stableFile(0),
    ino: 3,
    mode: 0o40700,
    isFile: () => false,
    isDirectory: () => true,
  } as Stats;
}

function inspectDependencies(
  overrides: Partial<ProjectTemplateCliInspectListDependencies> = {},
): Partial<ProjectTemplateCliInspectListDependencies> {
  return {
    lstat: vi.fn(async (path: string) => path.endsWith('.taktpack')
      ? stableFile()
      : stableDirectory()),
    realpath: vi.fn(async (path: string) => path),
    inspectTaktpack: vi.fn(async () => ({
      archiveSha256: SHA,
      manifest: { entries: [{ path: 'workflows/a.yaml' }] },
      compatibility: { status: 'compatible' },
    })),
    ...overrides,
  };
}

describe('project-template inspect CLI service', () => {
  it('projects bounded archive inspection into the exact closed 1.0 DTO', async () => {
    const inspect = vi.fn(async () => ({
      archiveSha256: SHA,
      manifest: { entries: [{ path: 'workflows/a.yaml' }] },
      compatibility: { status: 'compatible' },
      source: { repository: 'LEAK_CANARY_REPOSITORY', credential: 'LEAK_CANARY_TOKEN' },
    }));

    const outcome = await inspectProjectTemplateForCliWithDependencies({
      cwd: '/safe/repo',
      sourcePath: 'template.taktpack',
    }, inspectDependencies({ inspectTaktpack: inspect }));

    expect(outcome).toEqual({
      exitCode: 0,
      envelope: {
        schemaVersion: '1.0',
        command: 'project-template inspect',
        status: 'success',
        mode: 'dry-run',
        result: {
          packId: SHA,
          entryCount: 1,
          archiveBytes: 1024,
          dependencyCount: 0,
          readiness: 'ready',
          reviewCodes: [],
        },
        warnings: [],
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('LEAK_CANARY');
    expect(inspect).toHaveBeenCalledWith('/safe/repo/template.taktpack', expect.objectContaining({
      signal: undefined,
      limits: expect.objectContaining({ maxArchiveBytes: 40 * 1024 * 1024 }),
    }));
  });

  it('fails closed when the source identity changes during inspection', async () => {
    let sourceReads = 0;
    const outcome = await inspectProjectTemplateForCliWithDependencies({
      cwd: '/safe/repo',
      sourcePath: 'template.taktpack',
    }, inspectDependencies({
      lstat: vi.fn(async (path: string) => {
        if (!path.endsWith('.taktpack')) return stableDirectory();
        sourceReads += 1;
        return stableFile(sourceReads === 1 ? 1024 : 1025);
      }),
    }));

    expect(outcome).toMatchObject({
      exitCode: 24,
      envelope: { status: 'error', error: { code: 'SOURCE_INTEGRITY_FAILED' } },
    });
  });

  it('coarsens archive errors and aborts without leaking core details', async () => {
    const marker = 'LEAK_CANARY_PATH';
    const outcome = await inspectProjectTemplateForCliWithDependencies({
      cwd: '/safe/repo',
      sourcePath: 'template.taktpack',
    }, inspectDependencies({
      inspectTaktpack: vi.fn(async () => {
        throw new TaktpackError('HASH_MISMATCH', marker, marker);
      }),
    }));

    expect(outcome).toMatchObject({
      exitCode: 24,
      envelope: { status: 'error', error: { code: 'SOURCE_INTEGRITY_FAILED' } },
    });
    expect(JSON.stringify(outcome)).not.toContain(marker);
  });
});

describe('project-template list CLI service', () => {
  it('reports first-install with only bounded backup-generation identifiers', async () => {
    const listBackupIds = vi.fn(async () => [] as const);
    const outcome = await listProjectTemplatesForCliWithDependencies({ cwd: '/safe/repo' }, {
      readCompanionLockState: vi.fn(() => ({
        state: 'first-install',
        previousLocksSha256: SHA,
      })),
      inspectApplyGuard: vi.fn(() => ({ blocks: [] })),
      listBackupIds,
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: {
        result: { installed: false, backupIds: [], recoveryState: 'clean' },
      },
    });
    expect(listBackupIds).toHaveBeenCalledWith('/safe/repo', false);
  });

  it('returns only the installed target and a bounded backup generation list', async () => {
    const backupIds = ['backup-2', 'backup-1'];
    const outcome = await listProjectTemplatesForCliWithDependencies({ cwd: '/safe/repo' }, {
      readCompanionLockState: vi.fn(() => ({
        state: 'update',
        contentLock: { manifestSha256: SHA },
      })),
      inspectApplyGuard: vi.fn(() => ({ blocks: [] })),
      listBackupIds: vi.fn(async () => backupIds),
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: {
        result: {
          installed: true,
          targetId: SHA,
          backupIds: ['backup-1', 'backup-2'],
          recoveryState: 'clean',
        },
      },
    });
  });

  it('never downgrades recovery-required or oversized backup state to success', async () => {
    const base = {
      readCompanionLockState: vi.fn(() => ({
        state: 'update',
        contentLock: { manifestSha256: SHA },
      })),
    };
    const recovery = await listProjectTemplatesForCliWithDependencies({ cwd: '/safe/repo' }, {
      ...base,
      inspectApplyGuard: vi.fn(() => ({ blocks: [{ code: 'RECOVERY_REQUIRED' }] })),
      listBackupIds: vi.fn(async () => []),
    });
    const oversized = await listProjectTemplatesForCliWithDependencies({ cwd: '/safe/repo' }, {
      ...base,
      inspectApplyGuard: vi.fn(() => ({ blocks: [] })),
      listBackupIds: vi.fn(async () => Array.from({ length: 33 }, (_, index) => `backup-${index}`)),
    });

    expect(recovery).toMatchObject({
      exitCode: 25,
      envelope: { status: 'error', error: { code: 'RECOVERY_REQUIRED' } },
    });
    expect(oversized).toMatchObject({
      exitCode: 23,
      envelope: { status: 'error', error: { code: 'SECURITY_GUARD' } },
    });
  });
});
