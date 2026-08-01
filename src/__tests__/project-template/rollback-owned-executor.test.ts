import { createHash } from 'node:crypto';
import {
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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeTaktpack } from '../../features/project-template/archive-writer.js';
import { createProjectTemplateExportPlan } from '../../features/project-template/export-plan.js';
import {
  applyProjectTemplatePlan,
  PROJECT_TEMPLATE_LOCK_PATH,
  rollbackOwnedProjectTemplateApply,
} from '../../features/project-template/apply-executor.js';
import { inspectProjectTemplateApplyGuard } from '../../features/project-template/apply-guard.js';
import {
  acquireProjectTemplateApplyLease,
} from '../../features/project-template/apply-lease.js';
import {
  createProjectTemplateApplyStorageIo,
  initializeProjectTemplateApplyStorage,
  listProjectTemplateBackupIdsBounded,
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
import {
  PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
} from '../../features/project-template/source-provenance.js';
import {
  calculateProjectTemplateManifestSha256,
  captureProjectTemplateTargetSnapshot,
  createProjectTemplateApplyPlan,
  parseTemplateLock,
  type ProjectTemplateIncomingContent,
  type ProjectTemplateManifestV1,
} from '../../features/project-template/index.js';

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

async function applyLegacyVersion(projectRoot: string, maxSteps = 7): Promise<{
  readonly backupId: string;
  readonly contentPath: string;
}> {
  mkdirSync(join(projectRoot, '.takt'), { recursive: true });
  const path = 'workflows/legacy.yaml';
  const content = `name: legacy
max_steps: ${maxSteps}
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`;
  const incomingManifest: ProjectTemplateManifestV1 = {
    schemaVersion: '1.0',
    packVersion: '1.0.0',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'local', uri: '.', ref: 'workspace', commit: 'b'.repeat(40),
    },
    capabilities: [],
    entries: [{
      path,
      policy: 'managed',
      mode: '0644',
      sha256: createHash('sha256').update(content).digest('hex'),
    }],
  };
  const incomingContents: ProjectTemplateIncomingContent[] = [{
    path,
    content: Buffer.from(content),
  }];
  const snapshot = await captureProjectTemplateTargetSnapshot(projectRoot, [path]);
  const baseLock = existsSync(join(projectRoot, PROJECT_TEMPLATE_LOCK_PATH))
    ? parseTemplateLock(JSON.parse(
      readFileSync(join(projectRoot, PROJECT_TEMPLATE_LOCK_PATH), 'utf8'),
    ) as unknown)
    : undefined;
  const incomingInspection = {
    archiveSha256: 'd'.repeat(64),
    manifestSha256: calculateProjectTemplateManifestSha256(incomingManifest),
    currentTaktVersion: '0.48.0',
    compatibilityStatus: 'compatible' as const,
  };
  const plan = createProjectTemplateApplyPlan({
    ...(baseLock === undefined ? {} : { baseLock }),
    incomingManifest,
    localEntries: snapshot.entries,
    targetRootState: snapshot.rootState,
    missingPathTracking: snapshot.missingPathTracking,
    incomingContents,
    incomingInspection,
    baselineStrategy: baseLock === undefined ? 'adopt-identical' : 'conflict',
  });
  const applied = await applyProjectTemplatePlan({
    projectRoot,
    plan,
    incomingManifest,
    incomingContents,
    incomingInspection,
    baselineStrategy: baseLock === undefined ? 'adopt-identical' : 'conflict',
  });
  if (applied.status !== 'committed') {
    throw new Error(`legacy apply failed: ${JSON.stringify(applied)}`);
  }
  return {
    backupId: applied.backupId,
    contentPath: join(projectRoot, '.takt', path),
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

describe('owned project template rollback executor', () => {
  it('lists and rolls back a schema 1.0 backup created by the public apply API', async () => {
    const projectRoot = root('takt-legacy-rollback-target-');
    const value = await applyLegacyVersion(projectRoot);
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    await expect(listProjectTemplateBackupIdsBounded({ storage }))
      .resolves.toContain(value.backupId);

    const service = createProductionProjectTemplateCliRollbackService();
    const preview = await service.rollback({
      cwd: projectRoot,
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
      cwd: projectRoot,
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

  it.each([
    ['legacy lock', (value: Awaited<ReturnType<typeof applyLegacyVersion>>, projectRoot: string) => {
      writeFileSync(join(projectRoot, PROJECT_TEMPLATE_LOCK_PATH), '{}\n');
    }],
    ['managed target', (value: Awaited<ReturnType<typeof applyLegacyVersion>>) => {
      writeFileSync(value.contentPath, 'foreign\n');
    }],
    ['modern companion', (
      _value: Awaited<ReturnType<typeof applyLegacyVersion>>,
      projectRoot: string,
    ) => {
      writeFileSync(join(projectRoot, PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH), '{}\n');
    }],
  ])('rejects %s drift after a schema 1.0 preview', async (_name, mutate) => {
    const projectRoot = root('takt-legacy-rollback-drift-');
    const value = await applyLegacyVersion(projectRoot);
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    mutate(value, projectRoot);
    const lease = acquireProjectTemplateApplyLease(projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
        .resolves.toMatchObject({ status: 'not_started', code: 'ROLLBACK_DRIFT' });
    } finally {
      lease.release();
    }
    expect(existsSync(value.contentPath)).toBe(true);
  });

  it('rejects a mixed target kind injected into a schema 1.0 manifest', async () => {
    const projectRoot = root('takt-legacy-rollback-manifest-');
    const value = await applyLegacyVersion(projectRoot);
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const manifestPath = join(storage.backupsRoot, value.backupId, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entries: Array<{ target: { kind: string } }>;
    };
    const templateEntry = manifest.entries.find(({ target }) => (
      target.kind === 'template-entry'
    ));
    if (templateEntry === undefined) throw new Error('legacy template entry is missing');
    templateEntry.target = { kind: 'source-provenance' };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    const preview = await createProductionProjectTemplateCliRollbackService().rollback({
      cwd: projectRoot,
      backupId: value.backupId,
      force: false,
      mode: 'dry-run',
    });
    expect(preview.envelope).toMatchObject({
      status: 'error',
      error: { code: 'BACKUP_UNAVAILABLE' },
    });
    expect(existsSync(value.contentPath)).toBe(true);
  });

  it('rejects a non-generator action/state transition in a schema 1.0 manifest', async () => {
    const projectRoot = root('takt-legacy-rollback-transition-');
    const value = await applyLegacyVersion(projectRoot);
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const manifestPath = join(storage.backupsRoot, value.backupId, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entries: Array<{ action: string; before: { kind: string }; after: { kind: string } }>;
    };
    const added = manifest.entries.find((entry) => (
      entry.before.kind === 'absent' && entry.after.kind === 'file'
    ));
    if (added === undefined) throw new Error('legacy add transition is missing');
    added.action = 'delete';
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    const preview = await createProductionProjectTemplateCliRollbackService().rollback({
      cwd: projectRoot,
      backupId: value.backupId,
      force: false,
      mode: 'dry-run',
    });
    expect(preview.envelope).toMatchObject({
      status: 'error', error: { code: 'BACKUP_UNAVAILABLE' },
    });
  });

  it('rejects a malformed installed legacy lock before preview', async () => {
    const projectRoot = root('takt-legacy-rollback-lock-');
    const value = await applyLegacyVersion(projectRoot);
    writeFileSync(join(projectRoot, PROJECT_TEMPLATE_LOCK_PATH), '{}\n');

    const preview = await createProductionProjectTemplateCliRollbackService().rollback({
      cwd: projectRoot,
      backupId: value.backupId,
      force: false,
      mode: 'dry-run',
    });
    expect(preview.envelope).toMatchObject({
      status: 'error', error: { code: 'BACKUP_UNAVAILABLE' },
    });
    expect(existsSync(value.contentPath)).toBe(true);
  });

  it.each(['symlink', 'hardlink'] as const)(
    'rejects a %s legacy before blob before preview',
    async (kind) => {
      const projectRoot = root('takt-legacy-rollback-blob-');
      await applyLegacyVersion(projectRoot, 7);
      const value = await applyLegacyVersion(projectRoot, 8);
      const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
      const manifestPath = join(storage.backupsRoot, value.backupId, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        entries: Array<{
          target: { kind: string };
          before: { kind: string; blobRelativePath?: string };
        }>;
      };
      const entry = manifest.entries.find((candidate) => (
        candidate.target.kind === 'template-entry'
        && candidate.before.kind === 'file'
      ));
      if (entry?.before.blobRelativePath === undefined) {
        throw new Error('legacy before blob is missing');
      }
      const blobPath = join(
        storage.backupsRoot,
        value.backupId,
        entry.before.blobRelativePath,
      );
      const peerPath = join(storage.backupsRoot, value.backupId, `${kind}-peer`);
      if (kind === 'symlink') {
        writeFileSync(peerPath, readFileSync(blobPath));
        unlinkSync(blobPath);
        symlinkSync(peerPath, blobPath);
      } else {
        linkSync(blobPath, peerPath);
      }

      const preview = await createProductionProjectTemplateCliRollbackService().rollback({
        cwd: projectRoot,
        backupId: value.backupId,
        force: false,
        mode: 'dry-run',
      });
      expect(preview.envelope).toMatchObject({
        status: 'error', error: { code: 'BACKUP_UNAVAILABLE' },
      });
      expect(readFileSync(value.contentPath, 'utf8')).toContain('max_steps: 8');
    },
  );

  it('rejects a symlinked target ancestor before legacy preview', async () => {
    const projectRoot = root('takt-legacy-rollback-ancestor-');
    const value = await applyLegacyVersion(projectRoot);
    const workflowsPath = join(projectRoot, '.takt', 'workflows');
    const displacedPath = join(projectRoot, '.takt', 'displaced-workflows');
    renameSync(workflowsPath, displacedPath);
    symlinkSync(displacedPath, workflowsPath, 'dir');

    const preview = await createProductionProjectTemplateCliRollbackService().rollback({
      cwd: projectRoot,
      backupId: value.backupId,
      force: false,
      mode: 'dry-run',
    });
    expect(preview.envelope).toMatchObject({
      status: 'error', error: { code: 'BACKUP_UNAVAILABLE' },
    });
  });

  it.each(['symlink', 'hardlink'] as const)(
    'rejects a %s legacy target before preview',
    async (kind) => {
      const projectRoot = root('takt-legacy-rollback-target-safety-');
      const value = await applyLegacyVersion(projectRoot);
      const peerPath = join(projectRoot, `${kind}-target-peer`);
      if (kind === 'symlink') {
        writeFileSync(peerPath, readFileSync(value.contentPath));
        unlinkSync(value.contentPath);
        symlinkSync(peerPath, value.contentPath);
      } else {
        linkSync(value.contentPath, peerPath);
      }
      const preview = await createProductionProjectTemplateCliRollbackService().rollback({
        cwd: projectRoot,
        backupId: value.backupId,
        force: false,
        mode: 'dry-run',
      });
      expect(preview.envelope).toMatchObject({
        status: 'error', error: { code: 'BACKUP_UNAVAILABLE' },
      });
    },
  );

  it.each(['manifest', 'blob'] as const)(
    'rejects %s drift after a schema 1.0 preview',
    async (kind) => {
      const projectRoot = root('takt-legacy-rollback-backup-drift-');
      await applyLegacyVersion(projectRoot, 7);
      const value = await applyLegacyVersion(projectRoot, 8);
      const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
      const plan = await deriveProjectTemplateRollbackPlan({
        storage,
        backupId: value.backupId,
      });
      const manifestPath = join(storage.backupsRoot, value.backupId, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        createdAt: string;
        entries: Array<{ before: { kind: string; blobRelativePath?: string } }>;
      };
      if (kind === 'manifest') {
        manifest.createdAt = new Date(Date.parse(manifest.createdAt) + 1_000).toISOString();
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      } else {
        const before = manifest.entries.find((entry) => entry.before.kind === 'file')?.before;
        if (before?.blobRelativePath === undefined) throw new Error('before blob is missing');
        writeFileSync(
          join(storage.backupsRoot, value.backupId, before.blobRelativePath),
          'foreign\n',
        );
      }
      const lease = acquireProjectTemplateApplyLease(projectRoot);
      try {
        await expect(rollbackOwnedProjectTemplateApply({ storage, lease, plan }))
          .resolves.toMatchObject({ status: 'not_started' });
      } finally {
        lease.release();
      }
      expect(readFileSync(value.contentPath, 'utf8')).toContain('max_steps: 8');
    },
  );

  it('consumes a schema 1.0 rollback authority exactly once', async () => {
    const projectRoot = root('takt-legacy-rollback-authority-');
    const value = await applyLegacyVersion(projectRoot);
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const plan = await deriveProjectTemplateRollbackPlan({
      storage,
      backupId: value.backupId,
    });
    const firstLease = acquireProjectTemplateApplyLease(projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({
        storage, lease: firstLease, plan,
      })).resolves.toMatchObject({ status: 'rolled_back' });
    } finally {
      firstLease.release();
    }
    const secondLease = acquireProjectTemplateApplyLease(projectRoot);
    try {
      await expect(rollbackOwnedProjectTemplateApply({
        storage, lease: secondLease, plan,
      })).resolves.toMatchObject({ status: 'not_started', code: 'SECURITY_GUARD' });
    } finally {
      secondLease.release();
    }
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
