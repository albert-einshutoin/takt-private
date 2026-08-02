import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
} from '../../features/project-template/apply-lease.js';
import {
  createProjectTemplateApplyStorageIo,
  initializeProjectTemplateApplyStorage,
  readProjectTemplateBackupManifest,
  writeProjectTemplateBackupManifest,
} from '../../features/project-template/apply-storage.js';
import {
  executeOwnedProjectTemplateCompanionLockTransaction,
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

  it('recovers a crashed rollback from durable staging without reopening backup blobs', async () => {
    const value = await updatedInstallation();
    let journalPath = '';
    let crashed = false;
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
    expect(crashed).toBe(true);
    expect(existsSync(storage.journalPath)).toBe(true);
    const transactionId = (JSON.parse(
      readFileSync(storage.journalPath, 'utf8'),
    ) as { transactionId: string }).transactionId;

    const recoveryIo = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (operation === 'read' && path === value.blobPath) {
          throw new Error('recovery reopened the original backup blob');
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

  it('does not publish a journal when durable rollback staging fails', async () => {
    const value = await updatedInstallation();
    let stagingRoot = '';
    let injected = false;
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (!injected && operation === 'write' && path.startsWith(stagingRoot)) {
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
