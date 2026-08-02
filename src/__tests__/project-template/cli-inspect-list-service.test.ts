import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaktpackError } from '../../features/project-template/errors.js';
import {
  inspectProjectTemplateForCliV1_1WithDependencies,
  inspectProjectTemplateForCliWithDependencies,
  listProjectTemplatesForCli,
  listProjectTemplatesForCliV1_1WithDependencies,
  listProjectTemplatesForCliWithDependencies,
  type ProjectTemplateCliInspectListDependencies,
} from '../../features/project-template/cli-inspect-list-service.js';
import {
  initializeProjectTemplateApplyStorage,
  writeProjectTemplateBackupManifest,
  type ProjectTemplateBackupManifest,
} from '../../features/project-template/apply-storage.js';

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

function backupManifest(
  backupId: string,
  schemaVersion: '1.0' | '1.1',
): ProjectTemplateBackupManifest {
  const targets = schemaVersion === '1.0'
    ? [{ kind: 'lock' as const }]
    : [
      { kind: 'content-lock' as const },
      { kind: 'repertoire-lock' as const },
      { kind: 'source-provenance' as const },
    ];
  return {
    schemaVersion,
    backupId,
    planId: SHA,
    preconditionToken: SHA_B,
    createdAt: schemaVersion === '1.0'
      ? '2026-08-01T00:00:00.000Z' : '2026-08-02T00:00:00.000Z',
    createdTargetDirectories: [],
    entries: targets.map((target) => ({
      target,
      action: 'add' as const,
      before: { kind: 'absent' as const },
      after: { kind: 'absent' as const },
    })),
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

function inspectV1_1Archive(entries: readonly unknown[], sourceKind: string = 'local') {
  return {
    archiveSha256: SHA,
    manifestSha256: SHA_B,
    descriptor: { version: '1.0' as const },
    manifest: {
      packVersion: '1.2.3',
      takt: { minVersion: '0.48.0' },
      source: {
        kind: sourceKind,
        uri: sourceKind === 'github' ? 'https://github.com/owner/template' : '.',
        ref: sourceKind === 'github' ? 'v1.2.3' : 'workspace',
        commit: COMMIT,
      },
      capabilities: [],
      entries,
    },
    compatibility: {
      status: 'compatible' as const,
      minVersion: '0.48.0',
      currentVersion: '0.48.0',
    },
  };
}

describe('project-template inspect CLI service', () => {
  it('validates every entry before truncating detail and aggregates tail capabilities', async () => {
    const entries = Array.from({ length: 257 }, (_, index) => ({
      path: `workflows/${String(index).padStart(3, '0')}.yaml`,
      policy: 'managed' as const,
      capabilities: index === 256 ? ['external-command' as const] : [],
    }));
    const outcome = await inspectProjectTemplateForCliV1_1WithDependencies({
      cwd: '/safe/repo', sourcePath: 'template.taktpack',
      currentTaktVersion: '0.48.0', schemaVersion: '1.1',
    }, inspectDependencies({
      inspectTaktpack: vi.fn(async () => inspectV1_1Archive(entries)),
    }));

    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: {
        schemaVersion: '1.1',
        warnings: [{ code: 'PARTIAL_RESULT' }],
        result: { detail: {
          detectedCapabilities: ['external-command'],
          targets: { totalCount: 257, truncated: true },
          capabilityWarnings: { items: [], totalCount: 1, truncated: true },
        } },
      },
    });
    if (outcome.envelope.status !== 'success') throw new Error('expected success');
    expect(outcome.envelope.result.detail.targets.items).toHaveLength(256);
  });

  it('emits one warning for every capability on an affected target', async () => {
    const outcome = await inspectProjectTemplateForCliV1_1WithDependencies({
      cwd: '/safe/repo', sourcePath: 'template.taktpack', schemaVersion: '1.1',
    }, inspectDependencies({
      inspectTaktpack: vi.fn(async () => inspectV1_1Archive([{
        path: 'workflows/release.yaml', policy: 'managed',
        capabilities: ['executable', 'github-write', 'external-command'],
      }])),
    }));

    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: { result: { detail: { capabilityWarnings: {
        totalCount: 3, truncated: false,
        items: [
          { capability: 'executable' },
          { capability: 'github-write' },
          { capability: 'external-command' },
        ],
      } } } },
    });
  });

  it('rejects an invalid tail entry outside the 256-row display budget', async () => {
    let accessed = false;
    const hostileTail = { policy: 'managed', capabilities: [] } as Record<string, unknown>;
    Object.defineProperty(hostileTail, 'path', { enumerable: true, get() {
      accessed = true;
      throw new Error('must not execute');
    } });
    const entries: unknown[] = Array.from({ length: 256 }, (_, index) => ({
      path: `workflows/${String(index).padStart(3, '0')}.yaml`,
      policy: 'managed', capabilities: [],
    }));
    entries.push(hostileTail);

    const outcome = await inspectProjectTemplateForCliV1_1WithDependencies({
      cwd: '/safe/repo', sourcePath: 'template.taktpack', schemaVersion: '1.1',
    }, inspectDependencies({
      inspectTaktpack: vi.fn(async () => inspectV1_1Archive(entries)),
    }));

    expect(accessed).toBe(false);
    expect(outcome).toMatchObject({
      exitCode: 24,
      envelope: { schemaVersion: '1.1', error: { code: 'SOURCE_INTEGRITY_FAILED' } },
    });
  });

  it.each([
    ['accessor entry', () => {
      let accessed = false;
      const entry = { policy: 'managed', capabilities: [] } as Record<string, unknown>;
      Object.defineProperty(entry, 'path', { enumerable: true, get() {
        accessed = true;
        throw new Error('must not execute');
      } });
      return { entries: [entry], accessed: () => accessed };
    }],
    ['proxy entry', () => {
      let accessed = false;
      const entry = new Proxy({ path: 'workflows/a.yaml', policy: 'managed', capabilities: [] }, {
        getOwnPropertyDescriptor() {
          accessed = true;
          throw new Error('must not execute');
        },
      });
      return { entries: [entry], accessed: () => accessed };
    }],
    ['sparse entries', () => {
      const entries = new Array(1) as unknown[];
      return { entries, accessed: () => false };
    }],
    ['poisoned array prototype', () => {
      let accessed = false;
      const prototype = Object.create(Array.prototype) as Record<string, unknown>;
      Object.defineProperty(prototype, 'slice', { get() {
        accessed = true;
        throw new Error('must not execute');
      } });
      const entries = [{ path: 'workflows/a.yaml', policy: 'managed', capabilities: [] }];
      Object.setPrototypeOf(entries, prototype);
      return { entries, accessed: () => accessed };
    }],
  ])('rejects hostile %s without executing caller code', async (_label, createHostile) => {
    const hostile = createHostile();
    const outcome = await inspectProjectTemplateForCliV1_1WithDependencies({
      cwd: '/safe/repo', sourcePath: 'template.taktpack', schemaVersion: '1.1',
    }, inspectDependencies({
      inspectTaktpack: vi.fn(async () => inspectV1_1Archive(hostile.entries)),
    }));

    expect(hostile.accessed()).toBe(false);
    expect(outcome).toMatchObject({
      exitCode: 24,
      envelope: { schemaVersion: '1.1', error: { code: 'SOURCE_INTEGRITY_FAILED' } },
    });
  });

  it.each(['future-provider', 'git'])(
    'fails closed for unsupported manifest source kind %s',
    async (sourceKind) => {
    const outcome = await inspectProjectTemplateForCliV1_1WithDependencies({
      cwd: '/safe/repo', sourcePath: 'template.taktpack', schemaVersion: '1.1',
    }, inspectDependencies({
      inspectTaktpack: vi.fn(async () => inspectV1_1Archive([
        { path: 'workflows/a.yaml', policy: 'managed', capabilities: [] },
      ], sourceKind)),
    }));

    expect(outcome).toMatchObject({
      exitCode: 24,
      envelope: { schemaVersion: '1.1', error: { code: 'SOURCE_INTEGRITY_FAILED' } },
    });
    },
  );

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

  it('reports incompatible archive inspection as a hard conflict', async () => {
    const outcome = await inspectProjectTemplateForCliWithDependencies({
      cwd: '/safe/repo',
      sourcePath: 'template.taktpack',
    }, inspectDependencies({
      inspectTaktpack: vi.fn(async () => ({
        archiveSha256: SHA,
        manifest: { entries: [] },
        compatibility: { status: 'incompatible' },
      })),
    }));

    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: {
        status: 'success',
        result: {
          readiness: 'blocked',
          reviewCodes: ['HARD_CONFLICT'],
        },
      },
    });
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
  it('exposes bounded GitHub provenance only in schema 1.1 detail', async () => {
    const githubProvenance = {
      ...localSourceProvenance(),
      source: {
        owner: 'owner', repo: 'template', repositoryUrl: 'https://github.com/owner/template',
        canonicalSource: 'github:owner/template@v1.0.0', requestedRef: 'v1.0.0',
        releaseTag: 'v1.0.0', assetName: 'template.taktpack', commit: COMMIT,
        descriptorSha256: SHA,
      },
      dependencyVerification: {
        method: 'github-ref-to-commit-v1' as const,
        declarationSha256: SHA,
        count: 0 as const,
      },
    };
    const outcome = await listProjectTemplatesForCliV1_1WithDependencies({ cwd: '/safe/repo' }, {
      readCompanionLockState: vi.fn(() => ({
        state: 'update', contentLock: { manifestSha256: SHA },
        previousLocksSha256: SHA, sourceProvenance: githubProvenance,
      })),
      inspectApplyGuard: vi.fn(() => ({ blocks: [] })),
      listBackupIds: vi.fn(async () => []),
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: { schemaVersion: '1.1', result: { detail: { source: {
        kind: 'github', owner: 'owner', repo: 'template', requestedRef: 'v1.0.0',
        resolvedCommit: COMMIT, releaseTag: 'v1.0.0', assetName: 'template.taktpack',
      } } } },
    });
    expect(JSON.stringify(outcome)).not.toContain('repositoryUrl');
  });

  it('hides a validated schema 1.0-only backup from CLI discovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-cli-list-legacy-only-'));
    roots.push(root);
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: root });
    await writeProjectTemplateBackupManifest({
      storage,
      manifest: backupManifest('backup-legacy', '1.0'),
    });

    const outcome = await listProjectTemplatesForCliWithDependencies({ cwd: root }, {
      readCompanionLockState: vi.fn(() => ({
        state: 'update',
        contentLock: { manifestSha256: SHA },
        previousLocksSha256: SHA,
        sourceProvenance: localSourceProvenance(),
      })),
      inspectApplyGuard: vi.fn(() => ({ blocks: [] })),
    });
    expect(outcome.envelope).toMatchObject({
      status: 'success', result: { backupIds: [] },
    });
  });

  it('lists only the eligible schema 1.1 backup from a mixed backup store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-cli-list-mixed-schema-'));
    roots.push(root);
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: root });
    await writeProjectTemplateBackupManifest({
      storage,
      manifest: backupManifest('backup-legacy', '1.0'),
    });
    await writeProjectTemplateBackupManifest({
      storage,
      manifest: backupManifest('backup-modern', '1.1'),
    });

    const outcome = await listProjectTemplatesForCliWithDependencies({ cwd: root }, {
      readCompanionLockState: vi.fn(() => ({
        state: 'update',
        contentLock: { manifestSha256: SHA },
        previousLocksSha256: SHA,
        sourceProvenance: localSourceProvenance(),
      })),
      inspectApplyGuard: vi.fn(() => ({ blocks: [] })),
    });
    expect(outcome.envelope).toMatchObject({
      status: 'success', result: { backupIds: ['backup-modern'] },
    });
  });

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

  it('prioritizes a real non-terminal recovery journal over a mixed companion cohort', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-cli-list-recovery-mixed-'));
    roots.push(root);
    const controlRoot = join(root, '.takt-template-state');
    mkdirSync(controlRoot, { recursive: true });
    writeFileSync(join(controlRoot, 'journal.json'), JSON.stringify({
      schemaVersion: '1.0',
      transactionId: 'transaction-1',
      planId: SHA,
      backupId: 'backup-1',
      state: 'committing',
      completedOperations: [],
      createdTargetDirectories: [],
      updatedAt: '2026-08-02T00:00:00.000Z',
    }));
    // One lock from the three-file cohort is a real interrupted mixed state.
    writeFileSync(join(root, '.takt-template-lock.json'), '{}');

    const outcome = await listProjectTemplatesForCli({ cwd: root });

    expect(outcome).toMatchObject({
      exitCode: 25,
      envelope: { status: 'error', error: { code: 'RECOVERY_REQUIRED' } },
    });
  });

  it('keeps an ordinary mixed companion cohort classified as source integrity failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-cli-list-mixed-'));
    roots.push(root);
    writeFileSync(join(root, '.takt-template-lock.json'), '{}');

    const outcome = await listProjectTemplatesForCli({ cwd: root });

    expect(outcome).toMatchObject({
      exitCode: 24,
      envelope: { status: 'error', error: { code: 'SOURCE_INTEGRITY_FAILED' } },
    });
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
