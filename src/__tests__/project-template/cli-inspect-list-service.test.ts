import { mkdirSync, mkdtempSync, readdirSync, rmSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaktpackError } from '../../features/project-template/errors.js';
import {
  inspectProjectTemplateForCliWithDependencies,
  listProjectTemplatesForCli,
  listProjectTemplatesForCliWithDependencies,
  type ProjectTemplateCliInspectListDependencies,
} from '../../features/project-template/cli-inspect-list-service.js';

const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const roots: string[] = [];

function localSourceProvenance(descriptorSha256 = SHA) {
  return {
    schemaVersion: '1.0' as const,
    source: {
      kind: 'local-import' as const,
      uri: 'private/path-must-not-leak',
      ref: 'workspace' as const,
      commit: COMMIT,
      descriptorSha256,
    },
    archive: {
      sha256: SHA_B,
      version: '2.1.0',
      manifestSha256: SHA,
    },
    dependencyVerification: {
      method: 'local-empty-v1' as const,
      declarationSha256: SHA,
      count: 0 as const,
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

  it('rejects a source reached through a symlinked parent before inspection', async () => {
    const inspect = vi.fn();
    const outcome = await inspectProjectTemplateForCliWithDependencies({
      cwd: '/safe/repo',
      sourcePath: 'linked/template.taktpack',
    }, inspectDependencies({
      realpath: vi.fn(async (path: string) => path.endsWith('.taktpack')
        ? '/outside/template.taktpack'
        : path),
      inspectTaktpack: inspect,
    }));

    expect(outcome).toMatchObject({
      exitCode: 24,
      envelope: { status: 'error', error: { code: 'SOURCE_INTEGRITY_FAILED' } },
    });
    expect(inspect).not.toHaveBeenCalled();
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

  it('returns INTERRUPTED when the signal aborts while core inspection is awaited', async () => {
    const controller = new AbortController();
    const outcome = await inspectProjectTemplateForCliWithDependencies({
      cwd: '/safe/repo',
      sourcePath: 'template.taktpack',
      signal: controller.signal,
    }, inspectDependencies({
      inspectTaktpack: vi.fn(async () => {
        controller.abort();
        return {
          archiveSha256: SHA,
          manifest: { entries: [] },
          compatibility: { status: 'compatible' },
        };
      }),
    }));

    expect(outcome).toMatchObject({
      exitCode: 130,
      envelope: { status: 'error', error: { code: 'INTERRUPTED' } },
    });
  });

  it('rechecks cancellation after the final source identity await', async () => {
    const controller = new AbortController();
    let realpathCalls = 0;
    const outcome = await inspectProjectTemplateForCliWithDependencies({
      cwd: '/safe/repo',
      sourcePath: 'template.taktpack',
      signal: controller.signal,
    }, inspectDependencies({
      realpath: vi.fn(async (path: string) => {
        realpathCalls += 1;
        if (realpathCalls === 4) controller.abort();
        return path;
      }),
    }));

    expect(outcome).toMatchObject({
      exitCode: 130,
      envelope: { status: 'error', error: { code: 'INTERRUPTED' } },
    });
  });
});

describe('project-template list CLI service', () => {
  it('keeps a new repository byte-for-byte untouched while listing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-cli-list-'));
    roots.push(root);
    const before = readdirSync(root);

    const outcome = await listProjectTemplatesForCli({ cwd: root });

    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: {
        result: { installed: false, backupIds: [], recoveryState: 'clean' },
      },
    });
    expect(readdirSync(root)).toEqual(before);
  });

  it('reads installed state from the canonical project-template control root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-cli-list-installed-'));
    roots.push(root);
    mkdirSync(join(root, '.takt-template-state', 'merge-baselines'), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(join(root, '.takt-template-state', 'backups'), { mode: 0o700 });

    const outcome = await listProjectTemplatesForCliWithDependencies({ cwd: root }, {
      readCompanionLockState: vi.fn(() => ({
        state: 'update',
        previousLocksSha256: SHA,
        contentLock: { manifestSha256: SHA },
        sourceProvenance: localSourceProvenance(),
      })),
      inspectApplyGuard: vi.fn(() => ({ blocks: [] })),
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: {
        result: {
          installed: true,
          targetId: SHA,
          sourceProvenance: {
            kind: 'local-import',
            sourceId: SHA,
            revision: COMMIT,
            version: '2.1.0',
            archiveId: SHA_B,
            manifestId: SHA,
          },
          backupIds: [],
          recoveryState: 'clean',
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('private/path-must-not-leak');
  });

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
    expect(listBackupIds).toHaveBeenCalledWith('/safe/repo', false, undefined);
  });

  it('returns only the installed target and a bounded backup generation list', async () => {
    const backupIds = ['backup-2', 'backup-1'];
    const outcome = await listProjectTemplatesForCliWithDependencies({ cwd: '/safe/repo' }, {
      readCompanionLockState: vi.fn(() => ({
        state: 'update',
        contentLock: { manifestSha256: SHA },
        previousLocksSha256: SHA,
        sourceProvenance: localSourceProvenance(),
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
          sourceProvenance: {
            kind: 'local-import',
            sourceId: SHA,
            revision: COMMIT,
            version: '2.1.0',
            archiveId: SHA_B,
            manifestId: SHA,
          },
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
        previousLocksSha256: SHA,
        sourceProvenance: localSourceProvenance(),
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

  it('returns INTERRUPTED when cancellation arrives while backups are awaited', async () => {
    const controller = new AbortController();
    const outcome = await listProjectTemplatesForCliWithDependencies({
      cwd: '/safe/repo',
      signal: controller.signal,
    }, {
      readCompanionLockState: vi.fn(() => ({
        state: 'update',
        contentLock: { manifestSha256: SHA },
        previousLocksSha256: SHA,
        sourceProvenance: localSourceProvenance(),
      })),
      inspectApplyGuard: vi.fn(() => ({ blocks: [] })),
      listBackupIds: vi.fn(async () => {
        controller.abort();
        return [];
      }),
    });

    expect(outcome).toMatchObject({
      exitCode: 130,
      envelope: { status: 'error', error: { code: 'INTERRUPTED' } },
    });
  });

  it('fails closed when the companion cohort changes during backup collection', async () => {
    const otherSha = 'b'.repeat(64);
    const readCompanionLockState = vi.fn()
      .mockReturnValueOnce({
        state: 'update',
        contentLock: { manifestSha256: SHA },
        previousLocksSha256: SHA,
        sourceProvenance: localSourceProvenance(),
      })
      .mockReturnValueOnce({
        state: 'update',
        contentLock: { manifestSha256: otherSha },
        previousLocksSha256: otherSha,
        sourceProvenance: localSourceProvenance(otherSha),
      });

    const outcome = await listProjectTemplatesForCliWithDependencies({ cwd: '/safe/repo' }, {
      readCompanionLockState,
      inspectApplyGuard: vi.fn(() => ({ blocks: [] })),
      listBackupIds: vi.fn(async () => []),
    });

    expect(outcome).toMatchObject({
      exitCode: 22,
      envelope: { status: 'error', error: { code: 'TARGET_DRIFT' } },
    });
    expect(readCompanionLockState).toHaveBeenCalledTimes(2);
  });

  it('fails closed when only the installed source provenance changes', async () => {
    const readCompanionLockState = vi.fn()
      .mockReturnValueOnce({
        state: 'update',
        contentLock: { manifestSha256: SHA },
        previousLocksSha256: SHA,
        sourceProvenance: localSourceProvenance(),
      })
      .mockReturnValueOnce({
        state: 'update',
        contentLock: { manifestSha256: SHA },
        previousLocksSha256: SHA,
        sourceProvenance: localSourceProvenance(SHA_B),
      });

    const outcome = await listProjectTemplatesForCliWithDependencies({ cwd: '/safe/repo' }, {
      readCompanionLockState,
      inspectApplyGuard: vi.fn(() => ({ blocks: [] })),
      listBackupIds: vi.fn(async () => []),
    });

    expect(outcome).toMatchObject({
      exitCode: 22,
      envelope: { status: 'error', error: { code: 'TARGET_DRIFT' } },
    });
  });

  it('rejects nested provenance proxies without invoking descriptor traps', async () => {
    const descriptorTrap = vi.fn(Reflect.getOwnPropertyDescriptor);
    const sourceProvenance = localSourceProvenance();
    const hostileSource = new Proxy(sourceProvenance.source, {
      getOwnPropertyDescriptor: descriptorTrap,
    });
    const outcome = await listProjectTemplatesForCliWithDependencies({ cwd: '/safe/repo' }, {
      readCompanionLockState: vi.fn(() => ({
        state: 'update',
        contentLock: { manifestSha256: SHA },
        previousLocksSha256: SHA,
        sourceProvenance: { ...sourceProvenance, source: hostileSource },
      })),
      inspectApplyGuard: vi.fn(() => ({ blocks: [] })),
      listBackupIds: vi.fn(async () => []),
    });

    expect(outcome).toMatchObject({
      exitCode: 23,
      envelope: { status: 'error', error: { code: 'SECURITY_GUARD' } },
    });
    expect(descriptorTrap).not.toHaveBeenCalled();
  });

  it('fails as recovery-required when recovery appears during backup collection', async () => {
    const inspectApplyGuard = vi.fn()
      .mockReturnValueOnce({ blocks: [] })
      .mockReturnValueOnce({ blocks: [{ code: 'RECOVERY_REQUIRED' }] });
    const outcome = await listProjectTemplatesForCliWithDependencies({ cwd: '/safe/repo' }, {
      readCompanionLockState: vi.fn(() => ({
        state: 'first-install',
        previousLocksSha256: SHA,
      })),
      inspectApplyGuard,
      listBackupIds: vi.fn(async () => []),
    });

    expect(outcome).toMatchObject({
      exitCode: 25,
      envelope: { status: 'error', error: { code: 'RECOVERY_REQUIRED' } },
    });
    expect(inspectApplyGuard).toHaveBeenCalledTimes(2);
  });
});
