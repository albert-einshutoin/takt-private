import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeTaktpack } from '../../features/project-template/archive-writer.js';
import { createProjectTemplateExportPlan } from '../../features/project-template/export-plan.js';
import {
  recoverProjectTemplateApply,
  rollbackOwnedProjectTemplateApply,
} from '../../features/project-template/apply-executor.js';
import { inspectProjectTemplateApplyGuard } from '../../features/project-template/apply-guard.js';
import {
  acquireProjectTemplateApplyLease,
  writeProjectTemplateRecoveryRequiredMarker,
} from '../../features/project-template/apply-lease.js';
import {
  createProjectTemplateApplyStorageIo,
  initializeProjectTemplateApplyStorage,
  readProjectTemplateBackupManifest,
  resolveProjectTemplateApplyTarget,
  writeProjectTemplateBackupManifest,
  type ProjectTemplateApplyStorage,
} from '../../features/project-template/apply-storage.js';
import {
  ProjectTemplateCompanionLockRecoveryError,
  executeOwnedProjectTemplateCompanionLockTransaction,
  recoverProjectTemplateCompanionLockTransactionForTest,
} from '../../features/project-template/companion-lock-transaction.js';
import {
  readProjectTemplateCompanionLockState,
} from '../../features/project-template/companion-lock-state-reader.js';
import {
  deriveLocalProjectTemplateTransaction,
} from '../../features/project-template/local-transaction-derivation.js';
import {
  deriveProjectTemplateRollbackPlan,
} from '../../features/project-template/rollback-plan.js';
import {
  createProductionProjectTemplateCliRollbackService as createCoreRollbackService,
  type ProjectTemplateCliRollbackOptions,
} from '../../features/project-template/cli-rollback-service.js';
import { startProjectTemplateCliLifecycle } from '../../features/project-template/cli-lifecycle.js';

const roots: string[] = [];

type RollbackTestOptions =
  | Extract<ProjectTemplateCliRollbackOptions, { mode: 'dry-run' }>
  | Omit<Extract<ProjectTemplateCliRollbackOptions, { mode: 'apply' }>, 'admitMutation'>;

function createProductionProjectTemplateCliRollbackService() {
  const core = createCoreRollbackService();
  return {
    rollback(options: RollbackTestOptions) {
      if (options.mode === 'dry-run') return core.rollback(options);
      return startProjectTemplateCliLifecycle({
        command: 'project-template rollback',
        mode: 'apply',
        dispose: () => undefined,
        handle: ({ admitMutation, signal }) => core.rollback({
          ...options,
          signal: options.signal ?? signal,
          admitMutation,
        }),
      }).result;
    },
  };
}

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function applyVersion(projectRoot: string, maxSteps: number): Promise<{
  readonly backupId: string;
  readonly contentPath: string;
}> {
  const sourceRoot = root('takt-rollback-source-');
  const workflowPath = join(sourceRoot, '.takt', 'workflows', 'review.yaml');
  mkdirSync(dirname(workflowPath), { recursive: true });
  writeFileSync(workflowPath, `name: review
max_steps: ${maxSteps}
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
  const exportPlan = await createProjectTemplateExportPlan(sourceRoot, {
    packVersion: '1.0.0',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'local', uri: '.', ref: 'workspace', commit: 'a'.repeat(40),
    },
  });
  const archivePath = join(sourceRoot, 'template.taktpack');
  await writeTaktpack(archivePath, exportPlan);
  const derived = await deriveLocalProjectTemplateTransaction({
    archivePath,
    projectRoot,
    currentTaktVersion: '0.48.0',
    baselineStrategy: 'adopt-identical',
  });
  const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
  const lease = acquireProjectTemplateApplyLease(projectRoot);
  let committed;
  try {
    committed = await executeOwnedProjectTemplateCompanionLockTransaction({
      storage,
      lease,
      transactionPlanId: derived.preview.transactionPlanId,
      preconditionToken: derived.preview.bindings.contentPreconditionToken,
      candidatePaths: derived.candidatePaths,
      expectedPreviousLocksSha256: derived.preview.bindings.previousLocksSha256,
      outputs: {
        contentEntries: derived.contentEntries,
        mergeBaselines: derived.mergeBaselines,
        ...derived.companionOutputs,
      },
      async consumeApproval() { return true; },
      runDoctor() {},
    });
  } finally {
    lease.release();
  }
  return {
    backupId: committed.backupId,
    contentPath: join(projectRoot, '.takt', 'workflows', 'review.yaml'),
  };
}

async function installed(): Promise<{
  readonly projectRoot: string;
  readonly backupId: string;
  readonly contentPath: string;
}> {
  const projectRoot = root('takt-rollback-target-');
  return { projectRoot, ...await applyVersion(projectRoot, 10) };
}

async function updatedInstallation(): Promise<{
  readonly projectRoot: string;
  readonly backupId: string;
  readonly contentPath: string;
  readonly blobPath: string;
}> {
  const first = await installed();
  const updated = await applyVersion(first.projectRoot, 11);
  const storage = await initializeProjectTemplateApplyStorage({
    repoPath: first.projectRoot,
  });
  const manifest = await readProjectTemplateBackupManifest({
    storage,
    backupId: updated.backupId,
  });
  const file = manifest.entries.find((entry) => entry.before.kind === 'file');
  if (file?.before.kind !== 'file') throw new Error('expected rollback backup blob');
  return {
    projectRoot: first.projectRoot,
    backupId: updated.backupId,
    contentPath: first.contentPath,
    blobPath: join(storage.backupsRoot, updated.backupId, file.before.blobRelativePath),
  };
}

describe('owned project template rollback executor', () => {
  it.each([
    ['corrupt', (path: string) => writeFileSync(path, 'corrupt')],
    ['missing', (path: string) => unlinkSync(path)],
    ['symlink', (path: string) => {
      const outside = `${path}.outside`;
      writeFileSync(outside, 'outside', { mode: 0o600 });
      unlinkSync(path);
      symlinkSync(outside, path);
    }],
    ['hardlink', (path: string) => linkSync(path, `${path}.alias`)],
  ] as const)('rejects a %s schema 1.1 backup blob before preview authority', async (
    _kind,
    mutate,
  ) => {
    const value = await updatedInstallation();
    const before = readFileSync(value.contentPath);
    mutate(value.blobPath);
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
    });

    const preview = await createProductionProjectTemplateCliRollbackService().rollback({
      cwd: value.projectRoot,
      backupId: value.backupId,
      force: false,
      mode: 'dry-run',
    });

    expect(preview.envelope).toMatchObject({
      status: 'error', error: { code: 'BACKUP_UNAVAILABLE' },
    });
    expect(readFileSync(value.contentPath)).toEqual(before);
    expect(existsSync(storage.journalPath)).toBe(false);
    expect(inspectProjectTemplateApplyGuard({ repoPath: value.projectRoot }).passed)
      .toBe(true);
  });

  it('routes rollback-owned journal recovery away from the companion-lock path', async () => {
    const value = await updatedInstallation();
    let journalPath = '';
    let crashed = false;
    const crashIo = createProjectTemplateApplyStorageIo({
      after(operation, path) {
        if (!crashed && operation === 'rename' && path === journalPath) {
          crashed = true;
          throw new Error('process terminated after rollback journal publication');
        }
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
      io: crashIo,
    });
    journalPath = storage.journalPath;
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toMatchObject({ status: 'recovery_required' });
    } finally {
      lease.release();
    }

    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      transactionId: string;
    };
    const originalManifestPath = join(
      storage.backupsRoot, value.backupId, 'manifest.json',
    );
    const replacement = JSON.parse(readFileSync(originalManifestPath, 'utf8')) as {
      createdAt: string;
    };
    replacement.createdAt = '2026-08-02T03:04:05.000Z';
    writeFileSync(originalManifestPath, `${JSON.stringify(replacement)}\n`);
    chmodSync(originalManifestPath, 0o600);
    const targetBefore = readFileSync(value.contentPath);
    let originalManifestRead = false;
    const companionIo = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (operation === 'read' && path === originalManifestPath) {
          originalManifestRead = true;
          throw new Error('companion recovery read rollback original manifest');
        }
      },
    });

    await expect(recoverProjectTemplateCompanionLockTransactionForTest({
      projectRoot: value.projectRoot,
      io: companionIo,
    })).rejects.toBeInstanceOf(ProjectTemplateCompanionLockRecoveryError);
    expect(originalManifestRead).toBe(false);
    expect(readFileSync(value.contentPath)).toEqual(targetBefore);
    expect(existsSync(journalPath)).toBe(true);
    expect(existsSync(join(storage.stagingRoot, journal.transactionId))).toBe(true);

    await expect(recoverProjectTemplateApply({ projectRoot: value.projectRoot }))
      .resolves.toEqual({ status: 'rolled_back', backupId: value.backupId });
    expect(readFileSync(value.contentPath, 'utf8')).toContain('max_steps: 10');
    expect(existsSync(journalPath)).toBe(false);
  });

  it('rejects backup blob drift between preview and owned apply before journaling', async () => {
    const value = await updatedInstallation();
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
    });
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const before = readFileSync(value.contentPath);
    writeFileSync(value.blobPath, 'drifted');
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toMatchObject({ status: 'not_started', code: 'BACKUP_UNAVAILABLE' });
    } finally {
      lease.release();
    }
    expect(readFileSync(value.contentPath)).toEqual(before);
    expect(existsSync(storage.journalPath)).toBe(false);
    expect(inspectProjectTemplateApplyGuard({ repoPath: value.projectRoot }).passed)
      .toBe(true);
  });

  it('restores from staged bytes when the blob path drifts after fresh preflight', async () => {
    const value = await updatedInstallation();
    let blobReads = 0;
    let armed = false;
    let raced = false;
    const io = createProjectTemplateApplyStorageIo({
      after(operation, path) {
        if (operation !== 'read') return;
        if (path === value.blobPath) {
          blobReads += 1;
          if (blobReads === 2) armed = true;
          return;
        }
        if (armed && !raced) {
          raced = true;
          writeFileSync(value.blobPath, 'post-preflight-drift');
        }
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
      io,
    });
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toEqual({ status: 'rolled_back', backupId: value.backupId });
    } finally {
      lease.release();
    }
    expect(raced).toBe(true);
    expect(readFileSync(value.contentPath, 'utf8')).toContain('max_steps: 10');
    expect(existsSync(storage.journalPath)).toBe(false);
  });

  it.each([
    ['corrupt', (path: string) => writeFileSync(path, '{corrupt')],
    ['missing', (path: string) => unlinkSync(path)],
    ['symlink', (path: string) => {
      const outside = `${path}.outside`;
      writeFileSync(outside, '{}', { mode: 0o600 });
      unlinkSync(path);
      symlinkSync(outside, path);
    }],
  ] as const)(
    'recovers a crashed rollback after the original manifest becomes %s',
    async (_state, mutateManifest) => {
    const value = await updatedInstallation();
    let journalPath = '';
    let crashed = false;
    let originalManifestPath = '';
    const crashIo = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (crashed && operation === 'rename' && path === journalPath) {
          throw new Error('process terminated before journal replacement');
        }
      },
      after(operation, path) {
        if (!crashed && operation === 'rename' && path === journalPath) {
          crashed = true;
          writeFileSync(value.blobPath, 'original-blob-drift-after-journal');
          mutateManifest(originalManifestPath);
          throw new Error('process terminated after journal publication');
        }
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
      io: crashIo,
    });
    journalPath = storage.journalPath;
    originalManifestPath = join(
      storage.backupsRoot,
      value.backupId,
      'manifest.json',
    );
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toMatchObject({ status: 'recovery_required' });
    } finally {
      lease.release();
    }
    expect(crashed).toBe(true);
    expect(existsSync(storage.journalPath)).toBe(true);
    const transactionId = (JSON.parse(
      readFileSync(storage.journalPath, 'utf8'),
    ) as { transactionId: string }).transactionId;

    const recoveryIo = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (
          operation === 'read'
          && (path === value.blobPath || path === originalManifestPath)
        ) {
          throw new Error('recovery reopened replaceable original backup evidence');
        }
      },
    });
    await expect(recoverProjectTemplateApply({
      projectRoot: value.projectRoot,
      io: recoveryIo,
    })).resolves.toEqual({ status: 'rolled_back', backupId: value.backupId });
    expect(readFileSync(value.contentPath, 'utf8')).toContain('max_steps: 10');
    expect(existsSync(join(storage.stagingRoot, transactionId))).toBe(false);
  });

  it.each([
    ['manifest tamper', (storage: ProjectTemplateApplyStorage, transactionId: string) => {
      writeFileSync(
        join(storage.stagingRoot, transactionId, 'rollback-manifest.json'),
        '{tampered',
      );
    }],
    ['valid same-ID cohort replacement', (
      storage: ProjectTemplateApplyStorage,
      transactionId: string,
    ) => {
      const manifestPath = join(
        storage.stagingRoot, transactionId, 'rollback-manifest.json',
      );
      const staged = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        createdAt: string;
        entries: Array<{
          target: Parameters<typeof resolveProjectTemplateApplyTarget>[1];
          before: { kind: string; sha256?: string; bytes?: number };
        }>;
      };
      staged.createdAt = '2026-08-02T01:02:03.000Z';
      const file = staged.entries.find((entry) => entry.before.kind === 'file');
      if (file === undefined) throw new Error('expected staged file entry');
      const replacement = Buffer.from('alternate rollback bytes');
      file.before.sha256 = createHash('sha256').update(replacement).digest('hex');
      file.before.bytes = replacement.byteLength;
      const stagedBlobPath = join(
        storage.stagingRoot,
        transactionId,
        resolveProjectTemplateApplyTarget(storage, file.target).stagingRelativePath,
      );
      writeFileSync(stagedBlobPath, replacement);
      chmodSync(stagedBlobPath, 0o600);
      writeFileSync(manifestPath, `${JSON.stringify(staged)}\n`);
      chmodSync(manifestPath, 0o600);
    }],
    ['transaction directory symlink', (
      storage: ProjectTemplateApplyStorage,
      transactionId: string,
    ) => {
      const transactionRoot = join(storage.stagingRoot, transactionId);
      const outside = join(storage.stagingRoot, `${transactionId}-outside`);
      renameSync(transactionRoot, outside);
      symlinkSync(outside, transactionRoot);
    }],
    ['journal binding missing', (storage: ProjectTemplateApplyStorage) => {
      const journal = JSON.parse(readFileSync(storage.journalPath, 'utf8')) as Record<string, unknown>;
      delete journal.rollbackManifestSha256;
      writeFileSync(storage.journalPath, `${JSON.stringify(journal)}\n`);
    }],
    ['journal binding invalid', (storage: ProjectTemplateApplyStorage) => {
      const journal = JSON.parse(readFileSync(storage.journalPath, 'utf8')) as Record<string, unknown>;
      journal.rollbackManifestSha256 = 'invalid';
      writeFileSync(storage.journalPath, `${JSON.stringify(journal)}\n`);
    }],
    ['journal binding tampered', (storage: ProjectTemplateApplyStorage) => {
      const journal = JSON.parse(readFileSync(storage.journalPath, 'utf8')) as Record<string, unknown>;
      journal.rollbackManifestSha256 = '0'.repeat(64);
      writeFileSync(storage.journalPath, `${JSON.stringify(journal)}\n`);
    }],
  ] as const)('fails closed after crashed rollback %s', async (_case, mutateStaging) => {
    const value = await updatedInstallation();
    let journalPath = '';
    let crashed = false;
    const crashIo = createProjectTemplateApplyStorageIo({
      after(operation, path) {
        if (!crashed && operation === 'rename' && path === journalPath) {
          crashed = true;
          throw new Error('process terminated after journal publication');
        }
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
      io: crashIo,
    });
    journalPath = storage.journalPath;
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toMatchObject({ status: 'recovery_required' });
    } finally {
      lease.release();
    }
    const transactionId = (JSON.parse(
      readFileSync(storage.journalPath, 'utf8'),
    ) as { transactionId: string }).transactionId;
    const targetBefore = readFileSync(value.contentPath);
    mutateStaging(storage, transactionId);

    await expect(recoverProjectTemplateApply({ projectRoot: value.projectRoot }))
      .resolves.toMatchObject({
        status: 'recovery_required',
        code: 'RECOVERY_REQUIRED',
      });
    expect(existsSync(storage.journalPath)).toBe(true);
    expect(readFileSync(value.contentPath)).toEqual(targetBefore);
    expect(inspectProjectTemplateApplyGuard({ repoPath: value.projectRoot }).passed)
      .toBe(false);
  });

  it('fails closed when a private transaction directory performs an ABA swap during read', async () => {
    const value = await updatedInstallation();
    let journalPath = '';
    let crashed = false;
    const crashIo = createProjectTemplateApplyStorageIo({
      after(operation, path) {
        if (!crashed && operation === 'rename' && path === journalPath) {
          crashed = true;
          throw new Error('process terminated after journal publication');
        }
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
      io: crashIo,
    });
    journalPath = storage.journalPath;
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toMatchObject({ status: 'recovery_required' });
    } finally {
      lease.release();
    }
    const transactionId = (JSON.parse(readFileSync(journalPath, 'utf8')) as {
      transactionId: string;
    }).transactionId;
    const transactionRoot = join(storage.stagingRoot, transactionId);
    const alternateRoot = join(storage.stagingRoot, `${transactionId}-alternate`);
    const savedRoot = join(storage.stagingRoot, `${transactionId}-saved`);
    cpSync(transactionRoot, alternateRoot, { recursive: true });
    const alternateManifestPath = join(alternateRoot, 'rollback-manifest.json');
    const alternateManifest = JSON.parse(
      readFileSync(alternateManifestPath, 'utf8'),
    ) as { createdAt: string };
    alternateManifest.createdAt = '2026-08-02T02:03:04.000Z';
    writeFileSync(alternateManifestPath, `${JSON.stringify(alternateManifest)}\n`);
    chmodSync(alternateManifestPath, 0o600);
    const stagedManifestPath = join(transactionRoot, 'rollback-manifest.json');
    let swapped = false;
    const recoveryIo = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (!swapped && operation === 'read' && path === stagedManifestPath) {
          renameSync(transactionRoot, savedRoot);
          renameSync(alternateRoot, transactionRoot);
          swapped = true;
        }
      },
      after(operation, path) {
        if (swapped && operation === 'read' && path === stagedManifestPath) {
          renameSync(transactionRoot, alternateRoot);
          renameSync(savedRoot, transactionRoot);
        }
      },
    });
    const targetBefore = readFileSync(value.contentPath);

    await expect(recoverProjectTemplateApply({
      projectRoot: value.projectRoot,
      io: recoveryIo,
    })).resolves.toMatchObject({ status: 'recovery_required' });
    expect(swapped).toBe(true);
    expect(readFileSync(value.contentPath)).toEqual(targetBefore);
    expect(existsSync(journalPath)).toBe(true);
  });

  it('does not publish a journal when durable rollback staging fails', async () => {
    const value = await updatedInstallation();
    let stagingRoot = '';
    let injected = false;
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (
          !injected
          && operation === 'write'
          && path.startsWith(stagingRoot)
          && path.includes(`${sep}.rollback-manifest.json.`)
        ) {
          injected = true;
          throw new Error('durable staging failed');
        }
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
      io,
    });
    stagingRoot = storage.stagingRoot;
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const before = readFileSync(value.contentPath);
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toMatchObject({ status: 'not_started', code: 'BACKUP_UNAVAILABLE' });
    } finally {
      lease.release();
    }
    expect(injected).toBe(true);
    expect(readFileSync(value.contentPath)).toEqual(before);
    expect(existsSync(storage.journalPath)).toBe(false);
    expect(inspectProjectTemplateApplyGuard({ repoPath: value.projectRoot }).passed)
      .toBe(true);
  });

  it('retains one manifest digest through every rollback journal rewrite', async () => {
    const value = await updatedInstallation();
    let journalPath = '';
    const observed: string[] = [];
    const io = createProjectTemplateApplyStorageIo({
      after(operation, path) {
        if (operation !== 'rename' || path !== journalPath) return;
        const journal = JSON.parse(readFileSync(path, 'utf8')) as {
          rollbackManifestSha256?: string;
        };
        if (journal.rollbackManifestSha256 !== undefined) {
          observed.push(journal.rollbackManifestSha256);
        }
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
      io,
    });
    journalPath = storage.journalPath;
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toEqual({ status: 'rolled_back', backupId: value.backupId });
    } finally {
      lease.release();
    }
    expect(observed.length).toBeGreaterThan(1);
    expect(new Set(observed).size).toBe(1);
    expect(observed[0]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('keeps an explicit schema 1.0 backup unavailable to CLI rollback', async () => {
    const projectRoot = root('takt-legacy-cli-rollback-');
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    await writeProjectTemplateBackupManifest({
      storage,
      manifest: {
        schemaVersion: '1.0',
        backupId: 'backup-legacy',
        planId: 'a'.repeat(64),
        preconditionToken: 'b'.repeat(64),
        createdAt: '2026-08-02T00:00:00.000Z',
        createdTargetDirectories: [],
        entries: [{
          target: { kind: 'lock' },
          action: 'add',
          before: { kind: 'absent' },
          after: { kind: 'absent' },
        }],
      },
    });

    const preview = await createProductionProjectTemplateCliRollbackService().rollback({
      cwd: projectRoot,
      backupId: 'backup-legacy',
      force: false,
      mode: 'dry-run',
    });
    expect(preview.envelope).toMatchObject({
      status: 'error', error: { code: 'BACKUP_UNAVAILABLE' },
    });
  });

  it('runs dry-run then expected-plan apply through the production service', async () => {
    const value = await installed();
    const service = createProductionProjectTemplateCliRollbackService();
    const preview = await service.rollback({
      cwd: value.projectRoot,
      backupId: value.backupId,
      force: false,
      mode: 'dry-run',
    });
    expect(preview.envelope).toMatchObject({
      status: 'success',
      result: { recoveryState: 'clean', readiness: 'ready' },
    });
    const planId = preview.envelope.status === 'success'
      && 'planId' in preview.envelope.result
      ? preview.envelope.result.planId : '';
    const applied = await service.rollback({
      cwd: value.projectRoot,
      backupId: value.backupId,
      force: false,
      mode: 'apply',
      expectedPlanId: planId,
    });
    expect(applied.envelope).toMatchObject({
      status: 'success', mode: 'apply',
      result: { planId, rolledBack: true, backupId: value.backupId },
    });
    expect(existsSync(value.contentPath)).toBe(false);
  });

  it('does not return a plan when abort arrives during the final target await', async () => {
    const value = await installed();
    const controller = new AbortController();
    const finalTarget = join(value.projectRoot, '.takt-template-source-lock.json');
    const io = createProjectTemplateApplyStorageIo({
      after(operation, path) {
        if (operation === 'read' && path.endsWith(finalTarget)) controller.abort();
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
      io,
    });

    await expect(deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('restores the exact backup and verifies the resulting 000 cohort', async () => {
    const value = await installed();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: value.projectRoot });
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({
        storage,
        lease,
        plan,
      })).resolves.toEqual({ status: 'rolled_back', backupId: value.backupId });
      expect(existsSync(storage.journalPath)).toBe(false);
    } finally {
      lease.release();
    }
    expect(existsSync(value.contentPath)).toBe(false);
    expect(readProjectTemplateCompanionLockState(value.projectRoot).state)
      .toBe('first-install');
    expect(inspectProjectTemplateApplyGuard({ repoPath: value.projectRoot }).passed)
      .toBe(true);
  });

  it('restores an update backup and verifies the resulting 111 cohort', async () => {
    const value = await installed();
    const updated = await applyVersion(value.projectRoot, 11);
    expect(readFileSync(value.contentPath, 'utf8')).toContain('max_steps: 11');
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: value.projectRoot });
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: updated.backupId,
    });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toEqual({ status: 'rolled_back', backupId: updated.backupId });
    } finally {
      lease.release();
    }
    expect(readFileSync(value.contentPath, 'utf8')).toContain('max_steps: 10');
    expect(readProjectTemplateCompanionLockState(value.projectRoot).state).toBe('update');
    expect(inspectProjectTemplateApplyGuard({ repoPath: value.projectRoot }).passed).toBe(true);
  });

  it('preserves a foreign target when the sealed rollback plan drifts', async () => {
    const value = await installed();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: value.projectRoot });
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    writeFileSync(value.contentPath, 'foreign\n');
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({
        storage,
        lease,
        plan,
      })).resolves.toMatchObject({ status: 'not_started', code: 'ROLLBACK_DRIFT' });
    } finally {
      lease.release();
    }
    expect(readFileSync(value.contentPath, 'utf8')).toBe('foreign\n');
  });

  it('preserves an edit introduced after the journal and before unlink', async () => {
    const value = await installed();
    let journalPath = '';
    let raced = false;
    const io = createProjectTemplateApplyStorageIo({
      after(operation, path) {
        if (!raced && operation === 'rename' && path === journalPath) {
          raced = true;
          writeFileSync(value.contentPath, 'foreign-before-unlink\n');
        }
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: value.projectRoot, io });
    journalPath = storage.journalPath;
    const plan = await deriveProjectTemplateRollbackPlan({ storage, backupId: value.backupId });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toMatchObject({ status: 'recovery_required' });
    } finally {
      lease.release();
    }
    expect(readFileSync(value.contentPath, 'utf8')).toBe('foreign-before-unlink\n');
  });

  it('preserves an edit introduced after staging fsync and before restore rename', async () => {
    const value = await installed();
    const updated = await applyVersion(value.projectRoot, 11);
    let stagingRoot = '';
    let raced = false;
    const io = createProjectTemplateApplyStorageIo({
      after(operation, path) {
        if (!raced && operation === 'file-fsync' && path.startsWith(stagingRoot)) {
          raced = true;
          writeFileSync(value.contentPath, 'foreign-before-rename\n');
        }
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
      io,
    });
    stagingRoot = storage.stagingRoot;
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: updated.backupId,
    });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toMatchObject({ status: 'recovery_required' });
    } finally {
      lease.release();
    }
    expect(raced).toBe(true);
    expect(readFileSync(value.contentPath, 'utf8')).toBe('foreign-before-rename\n');
  });

  it('maps an abort before mutation admission without changing the target', async () => {
    const value = await installed();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: value.projectRoot });
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const before = readFileSync(value.contentPath);
    const controller = new AbortController();
    controller.abort();
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({
        storage,
        lease,
        plan,
        signal: controller.signal,
      })).resolves.toMatchObject({ status: 'not_started', code: 'INTERRUPTED' });
    } finally {
      lease.release();
    }
    expect(readFileSync(value.contentPath)).toEqual(before);
  });

  it('reports terminal cleanup failure as indeterminate', async () => {
    const value = await installed();
    let journalPath = '';
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (operation === 'unlink' && path === journalPath) {
          throw new Error('injected terminal journal cleanup failure');
        }
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
      io,
    });
    journalPath = storage.journalPath;
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toEqual({ status: 'indeterminate', backupId: value.backupId });
    } finally {
      lease.release();
    }
    expect(existsSync(value.contentPath)).toBe(false);
  });

  it('removes the terminal journal before reporting staging cleanup failure', async () => {
    const value = await installed();
    let journalPath = '';
    let stagingRoot = '';
    let rollbackStagingRoot = '';
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (
          operation === 'rmdir'
          && rollbackStagingRoot !== ''
          && path === rollbackStagingRoot
        ) throw new Error('injected terminal staging cleanup failure');
      },
      after(operation, path) {
        if (operation !== 'rename' || path !== journalPath) return;
        const transactionId = (JSON.parse(readFileSync(path, 'utf8')) as {
          transactionId: string;
        }).transactionId;
        if (transactionId.startsWith('rollback-')) {
          rollbackStagingRoot = join(stagingRoot, transactionId);
        }
      },
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: value.projectRoot,
      io,
    });
    journalPath = storage.journalPath;
    stagingRoot = storage.stagingRoot;
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      const result = await rollbackOwnedProjectTemplateApply({ storage, lease, plan });
      expect(result).toEqual({ status: 'indeterminate', backupId: value.backupId });
    } finally {
      lease.release();
    }
    expect(existsSync(journalPath)).toBe(false);
  });

  it.each(['marker-unlink', 'marker-fsync', 'marker-corrupt', 'journal-unlink'] as const)(
    'retains a recoverable journal when terminal cleanup fails at %s',
    async (fault) => {
      const value = await installed();
      let setupJournalPath = '';
      let setupInjected = false;
      const setupIo = createProjectTemplateApplyStorageIo({
        before(operation, path) {
          if (!setupInjected && operation === 'unlink' && path === setupJournalPath) {
            setupInjected = true;
            throw new Error('retain terminal journal for cleanup recovery test');
          }
        },
      });
      const storage = await initializeProjectTemplateApplyStorage({
        repoPath: value.projectRoot,
        io: setupIo,
      });
      setupJournalPath = storage.journalPath;
      const manifest = await readProjectTemplateBackupManifest({
        storage,
        backupId: value.backupId,
      });
      const plan = await deriveProjectTemplateRollbackPlan({
        storage,
        backupId: value.backupId,
      });
      const lease = acquireProjectTemplateApplyLease(value.projectRoot);
      try {
        await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
          .resolves.toEqual({ status: 'indeterminate', backupId: value.backupId });
      } finally {
        lease.release();
      }
      expect(setupInjected).toBe(true);
      const journal = JSON.parse(readFileSync(storage.journalPath, 'utf8')) as {
        transactionId: string;
      };
      const markerPath = join(storage.controlRoot, 'recovery-required.json');
      writeProjectTemplateRecoveryRequiredMarker(value.projectRoot, {
        token: journal.transactionId,
        transactionId: journal.transactionId,
      });
      if (fault === 'marker-corrupt') {
        writeFileSync(markerPath, '{corrupt');
      }
      let markerRemoved = false;
      let injected = false;
      const recoveryIo = createProjectTemplateApplyStorageIo({
        before(operation, path) {
          if (
            !injected
            && fault === 'marker-unlink'
            && operation === 'unlink'
            && path === markerPath
          ) {
            injected = true;
            throw new Error('injected marker unlink failure');
          }
          if (
            !injected
            && fault === 'marker-fsync'
            && markerRemoved
            && operation === 'directory-fsync'
            && path === storage.controlRoot
          ) {
            injected = true;
            throw new Error('injected marker directory fsync failure');
          }
          if (
            !injected
            && fault === 'journal-unlink'
            && operation === 'unlink'
            && path === storage.journalPath
          ) {
            injected = true;
            throw new Error('injected journal unlink failure');
          }
        },
        after(operation, path) {
          if (operation === 'unlink' && path === markerPath) markerRemoved = true;
        },
      });

      await expect(recoverProjectTemplateApply({
        projectRoot: value.projectRoot,
        io: recoveryIo,
      })).resolves.toMatchObject({ status: 'recovery_required' });
      expect(existsSync(storage.journalPath)).toBe(true);
      if (fault !== 'marker-corrupt') expect(injected).toBe(true);

      if (fault === 'marker-corrupt') {
        writeFileSync(markerPath, `${JSON.stringify({
          version: 1,
          token: journal.transactionId,
          transactionId: journal.transactionId,
        })}\n`);
        chmodSync(markerPath, 0o600);
      }
      await expect(recoverProjectTemplateApply({ projectRoot: value.projectRoot }))
        .resolves.toEqual({ status: 'rolled_back', backupId: manifest.backupId });
      expect(existsSync(storage.journalPath)).toBe(false);
      expect(existsSync(markerPath)).toBe(false);
    },
  );

  it('rejects a structural clone of the sealed rollback authority', async () => {
    const value = await installed();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: value.projectRoot });
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const before = readFileSync(value.contentPath);
    const lease = acquireProjectTemplateApplyLease(value.projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({
        storage,
        lease,
        plan: { ...plan },
      })).resolves.toMatchObject({ status: 'not_started', code: 'SECURITY_GUARD' });
    } finally {
      lease.release();
    }
    expect(readFileSync(value.contentPath)).toEqual(before);
  });
});
