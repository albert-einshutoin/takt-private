import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeTaktpack } from '../../features/project-template/archive-writer.js';
import { createProjectTemplateExportPlan } from '../../features/project-template/export-plan.js';
import {
  rollbackOwnedProjectTemplateApply,
} from '../../features/project-template/apply-executor.js';
import {
  acquireProjectTemplateApplyLease,
} from '../../features/project-template/apply-lease.js';
import {
  createProjectTemplateApplyStorageIo,
  initializeProjectTemplateApplyStorage,
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

const roots: string[] = [];

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function installed(): Promise<{
  readonly projectRoot: string;
  readonly backupId: string;
  readonly contentPath: string;
}> {
  const sourceRoot = root('takt-rollback-source-');
  const workflowPath = join(sourceRoot, '.takt', 'workflows', 'review.yaml');
  mkdirSync(dirname(workflowPath), { recursive: true });
  writeFileSync(workflowPath, `name: review
max_steps: 10
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
  const projectRoot = root('takt-rollback-target-');
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
    projectRoot,
    backupId: committed.backupId,
    contentPath: join(projectRoot, '.takt', 'workflows', 'review.yaml'),
  };
}

describe('owned project template rollback executor', () => {
  it('does not return a plan when abort arrives during the final target await', async () => {
    const value = await installed();
    const controller = new AbortController();
    const finalTarget = join(value.projectRoot, '.takt-template-source-lock.json');
    const io = createProjectTemplateApplyStorageIo({
      after(operation, path) {
        if (operation === 'lstat' && path === finalTarget) controller.abort();
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
    } finally {
      lease.release();
    }
    expect(existsSync(value.contentPath)).toBe(false);
    expect(readProjectTemplateCompanionLockState(value.projectRoot).state)
      .toBe('first-install');
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
      })).resolves.toEqual({ status: 'not_started', code: 'ROLLBACK_DRIFT' });
    } finally {
      lease.release();
    }
    expect(readFileSync(value.contentPath, 'utf8')).toBe('foreign\n');
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
      })).resolves.toEqual({ status: 'not_started', code: 'INTERRUPTED' });
    } finally {
      lease.release();
    }
    expect(readFileSync(value.contentPath)).toEqual(before);
  });
});
