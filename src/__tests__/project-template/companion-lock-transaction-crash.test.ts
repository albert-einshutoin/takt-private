import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeOwnedProjectTemplateCompanionLockTransaction,
  ProjectTemplateCompanionLockRecoveryError,
  ProjectTemplateCompanionLockRollbackError,
  ProjectTemplateCompanionLockTargetDriftError,
  recoverProjectTemplateCompanionLockTransaction,
  type ProjectTemplateCompanionLockTransactionPhase,
} from '../../features/project-template/companion-lock-transaction.js';
import {
  acquireProjectTemplateApplyLease,
} from '../../features/project-template/apply-lease.js';
import {
  initializeProjectTemplateApplyStorage,
} from '../../features/project-template/apply-storage.js';
import {
  readProjectTemplateCompanionLockState,
} from '../../features/project-template/companion-lock-state-reader.js';
import {
  readProjectTemplateMergeBaseline,
} from '../../features/project-template/merge-baseline-store.js';
import {
  PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
} from '../../features/project-template/repertoire-dependency-lock.js';
import {
  PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
} from '../../features/project-template/source-provenance.js';
import {
  calculateProjectTemplateTargetPreconditionToken,
  captureProjectTemplateTargetSnapshot,
} from '../../features/project-template/target-snapshot.js';

const CONTENT_LOCK_PATH = '.takt-template-lock.json';
const CONTENT_ENTRY_PATH = '.takt/workflows/review.yaml';
const BASELINE = new TextEncoder().encode('name: next\n');
const BASELINE_SHA256 = createHash('sha256').update(BASELINE).digest('hex');
const roots: string[] = [];

function makeRepo(): string {
  const value = mkdtempSync(join(tmpdir(), 'takt-companion-transaction-'));
  roots.push(value);
  mkdirSync(join(value, '.takt'), { mode: 0o700 });
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

const TARGET_PATHS = [
  CONTENT_ENTRY_PATH,
  CONTENT_LOCK_PATH,
  PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
  PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
] as const;

function cohort(prefix: 'old' | 'new'): Readonly<Record<string, Uint8Array>> {
  return Object.freeze(Object.fromEntries(TARGET_PATHS.map((path) => [
    path,
    new TextEncoder().encode(`${prefix}:${path}\n`),
  ])));
}

function writeCohort(projectRoot: string, value: Readonly<Record<string, Uint8Array>>): void {
  for (const path of TARGET_PATHS) {
    mkdirSync(join(projectRoot, path, '..'), { recursive: true });
    writeFileSync(join(projectRoot, path), value[path]!, { mode: 0o600 });
  }
}

function readCohort(projectRoot: string): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(TARGET_PATHS.map((path) => [
    path,
    readFileSync(join(projectRoot, path), 'utf8'),
  ])));
}

async function contentPrecondition(
  projectRoot: string,
  candidatePaths: readonly string[] = ['workflows/review.yaml'],
): Promise<string> {
  return calculateProjectTemplateTargetPreconditionToken(
    await captureProjectTemplateTargetSnapshot(projectRoot, candidatePaths),
  );
}

const CRASH_PHASES = [
  'merge-baseline-0-staged',
  'content-entry-0-staged',
  'content-lock-staged',
  'repertoire-lock-staged',
  'source-provenance-staged',
  'merge-baseline-0-backed-up',
  'content-entry-0-backed-up',
  'content-lock-backed-up',
  'repertoire-lock-backed-up',
  'source-provenance-backed-up',
  'journal-durable',
  'approval-consumed',
  'merge-baseline-0-before-fsync',
  'merge-baseline-0-after-fsync',
  'merge-baseline-0-before-rename',
  'merge-baseline-0-after-rename',
  'merge-baseline-0-published',
  'content-entry-0-before-fsync',
  'content-entry-0-after-fsync',
  'content-entry-0-before-rename',
  'content-entry-0-after-rename',
  'content-entry-0-published',
  'content-lock-before-fsync',
  'content-lock-after-fsync',
  'content-lock-before-rename',
  'content-lock-after-rename',
  'content-lock-published',
  'repertoire-lock-before-fsync',
  'repertoire-lock-after-fsync',
  'repertoire-lock-before-rename',
  'repertoire-lock-after-rename',
  'repertoire-lock-published',
  'source-provenance-before-fsync',
  'source-provenance-after-fsync',
  'source-provenance-before-rename',
  'source-provenance-after-rename',
  'source-provenance-published',
  'committed-marker-durable',
  'cleanup-complete',
] as const satisfies readonly ProjectTemplateCompanionLockTransactionPhase[];

describe('project template companion lock transaction crash recovery', () => {
  it.each(['before-execute', 'after-backup'] as const)(
    'rejects foreign target drift %s before approval consumption',
    async (timing) => {
      const projectRoot = makeRepo();
      const oldCohort = cohort('old');
      const newCohort = cohort('new');
      writeCohort(projectRoot, oldCohort);
      const preconditionToken = await contentPrecondition(projectRoot);
      const foreign = 'foreign editor content\n';
      if (timing === 'before-execute') {
        writeFileSync(join(projectRoot, CONTENT_ENTRY_PATH), foreign);
      }
      const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
      const lease = acquireProjectTemplateApplyLease(projectRoot);
      let approvalConsumes = 0;
      try {
        await expect(executeOwnedProjectTemplateCompanionLockTransaction({
          storage,
          lease,
          transactionPlanId: 'a'.repeat(64),
          preconditionToken,
          candidatePaths: ['workflows/review.yaml'],
          outputs: {
            contentEntries: [{
              path: 'workflows/review.yaml',
              action: 'write',
              content: newCohort[CONTENT_ENTRY_PATH]!,
              mode: '0600',
            }],
            contentLock: newCohort[CONTENT_LOCK_PATH]!,
            repertoireLock: newCohort[PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH]!,
            sourceProvenance: newCohort[PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH]!,
          },
          async consumeApproval() {
            approvalConsumes += 1;
            return true;
          },
          runDoctor() {},
          onPhase(phase) {
            if (timing === 'after-backup' && phase === 'source-provenance-backed-up') {
              writeFileSync(join(projectRoot, CONTENT_ENTRY_PATH), foreign);
            }
          },
        })).rejects.toBeInstanceOf(ProjectTemplateCompanionLockTargetDriftError);
      } finally {
        lease.release();
      }
      expect(approvalConsumes).toBe(0);
      expect(readFileSync(join(projectRoot, CONTENT_ENTRY_PATH), 'utf8')).toBe(foreign);
      expect(readdirSync(storage.backupsRoot)).toEqual([]);
      expect(existsSync(storage.journalPath)).toBe(false);
    },
  );

  it('never overwrites a foreign edit introduced immediately before rename', async () => {
    const projectRoot = makeRepo();
    const oldCohort = cohort('old');
    const newCohort = cohort('new');
    writeCohort(projectRoot, oldCohort);
    const preconditionToken = await contentPrecondition(projectRoot);
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const lease = acquireProjectTemplateApplyLease(projectRoot);
    let approvalConsumes = 0;
    const foreign = 'foreign editor content\n';
    try {
      await expect(executeOwnedProjectTemplateCompanionLockTransaction({
        storage,
        lease,
        transactionPlanId: 'a'.repeat(64),
        preconditionToken,
        candidatePaths: ['workflows/review.yaml'],
        outputs: {
          contentEntries: [{
            path: 'workflows/review.yaml',
            action: 'write',
            content: newCohort[CONTENT_ENTRY_PATH]!,
            mode: '0600',
          }],
          contentLock: newCohort[CONTENT_LOCK_PATH]!,
          repertoireLock: newCohort[PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH]!,
          sourceProvenance: newCohort[PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH]!,
        },
        async consumeApproval() {
          approvalConsumes += 1;
          return true;
        },
        runDoctor() {},
        onPhase(phase) {
          if (phase === 'content-entry-0-before-rename') {
            writeFileSync(join(projectRoot, CONTENT_ENTRY_PATH), foreign);
          }
        },
      })).rejects.toBeInstanceOf(ProjectTemplateCompanionLockRollbackError);
    } finally {
      lease.release();
    }
    expect(approvalConsumes).toBe(1);
    expect(readFileSync(join(projectRoot, CONTENT_ENTRY_PATH), 'utf8')).toBe(foreign);
  });

  it('rechecks the exact companion witness before consuming approval', async () => {
    const projectRoot = makeRepo();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const lease = acquireProjectTemplateApplyLease(projectRoot);
    const expectedPreviousLocksSha256 = readProjectTemplateCompanionLockState(
      projectRoot,
    ).previousLocksSha256;
    let approvalConsumes = 0;
    try {
      let observedError: unknown;
      try {
        await executeOwnedProjectTemplateCompanionLockTransaction({
        storage,
        lease,
        transactionPlanId: 'a'.repeat(64),
        preconditionToken: await contentPrecondition(projectRoot, []),
        candidatePaths: [],
        expectedPreviousLocksSha256,
        outputs: {
          contentLock: cohort('new')[CONTENT_LOCK_PATH]!,
          repertoireLock:
            cohort('new')[PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH]!,
          sourceProvenance:
            cohort('new')[PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH]!,
        },
        async consumeApproval() {
          approvalConsumes += 1;
          return true;
        },
        runDoctor() {},
        onPhase(phase) {
          if (phase === 'journal-durable') {
            writeFileSync(join(projectRoot, CONTENT_LOCK_PATH), 'foreign\n');
          }
        },
        });
      } catch (error) {
        observedError = error;
      }
      expect(observedError).toBeInstanceOf(ProjectTemplateCompanionLockRollbackError);
      expect(approvalConsumes).toBe(0);
    } finally {
      lease.release();
    }
    expect(readFileSync(join(projectRoot, CONTENT_LOCK_PATH), 'utf8'))
      .toBe('foreign\n');
    await expect(recoverProjectTemplateCompanionLockTransaction({ projectRoot }))
      .rejects.toBeInstanceOf(ProjectTemplateCompanionLockRecoveryError);
    expect(readFileSync(join(projectRoot, CONTENT_LOCK_PATH), 'utf8'))
      .toBe('foreign\n');
  });

  it('publishes merge baselines inside the rollback and recovery transaction', async () => {
    const projectRoot = makeRepo();
    const oldCohort = cohort('old');
    const newCohort = cohort('new');
    writeCohort(projectRoot, oldCohort);
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const lease = acquireProjectTemplateApplyLease(projectRoot);
    try {
      await executeOwnedProjectTemplateCompanionLockTransaction({
        storage,
        lease,
        transactionPlanId: 'a'.repeat(64),
        preconditionToken: await contentPrecondition(projectRoot, []),
        candidatePaths: [],
        outputs: {
          mergeBaselines: [{ sha256: BASELINE_SHA256, content: BASELINE }],
          contentLock: newCohort[CONTENT_LOCK_PATH]!,
          repertoireLock:
            newCohort[PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH]!,
          sourceProvenance:
            newCohort[PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH]!,
        },
        async consumeApproval() { return true; },
        async runDoctor() {
          await expect(readProjectTemplateMergeBaseline({
            storage,
            expectedSha256: BASELINE_SHA256,
          })).resolves.toEqual(Buffer.from(BASELINE));
        },
      });
    } finally {
      lease.release();
    }
    await expect(readProjectTemplateMergeBaseline({
      storage,
      expectedSha256: BASELINE_SHA256,
    })).resolves.toEqual(Buffer.from(BASELINE));
  });

  it.each(CRASH_PHASES)(
    'converges to one complete cohort after a crash at %s',
    async (crashPhase) => {
      const projectRoot = makeRepo();
      const oldCohort = cohort('old');
      const newCohort = cohort('new');
      writeCohort(projectRoot, oldCohort);
      const storage = await initializeProjectTemplateApplyStorage({
        repoPath: projectRoot,
      });
      const lease = acquireProjectTemplateApplyLease(projectRoot);
      let approvalConsumes = 0;
      try {
        await expect(executeOwnedProjectTemplateCompanionLockTransaction({
          storage,
          lease,
          transactionPlanId: 'a'.repeat(64),
          preconditionToken: await contentPrecondition(projectRoot),
          candidatePaths: ['workflows/review.yaml'],
          outputs: {
            mergeBaselines: [{ sha256: BASELINE_SHA256, content: BASELINE }],
            contentEntries: [{
              path: 'workflows/review.yaml',
              action: 'write',
              content: newCohort[CONTENT_ENTRY_PATH]!,
              mode: '0600',
            }],
            contentLock: newCohort[CONTENT_LOCK_PATH]!,
            repertoireLock:
              newCohort[PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH]!,
            sourceProvenance:
              newCohort[PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH]!,
          },
          async consumeApproval() {
            approvalConsumes += 1;
            return true;
          },
          runDoctor() {},
          onPhase(phase) {
            if (phase === crashPhase) throw new Error('simulated crash');
          },
        })).rejects.toThrow();
      } finally {
        lease.release();
      }

      const consumesBeforeRecovery = approvalConsumes;
      await recoverProjectTemplateCompanionLockTransaction({ projectRoot });
      expect(approvalConsumes).toBe(consumesBeforeRecovery);

      const observed = Object.values(readCohort(projectRoot));
      const oldValues = Object.values(oldCohort).map((bytes) => (
        new TextDecoder().decode(bytes)
      ));
      const newValues = Object.values(newCohort).map((bytes) => (
        new TextDecoder().decode(bytes)
      ));
      const expected = crashPhase === 'committed-marker-durable'
        || crashPhase === 'cleanup-complete'
        ? newValues
        : oldValues;
      expect(observed).toEqual(expected);
      expect(observed).not.toEqual(
        [oldValues[0], newValues[1], newValues[2], newValues[3]],
      );
      expect(existsSync(storage.journalPath)).toBe(false);
      expect(readdirSync(storage.stagingRoot)).toEqual([]);
      expect(existsSync(join(storage.baselinesRoot, BASELINE_SHA256))).toBe(
        crashPhase === 'committed-marker-durable'
          || crashPhase === 'cleanup-complete',
      );
      expect(readdirSync(storage.backupsRoot)).toHaveLength(
        crashPhase === 'committed-marker-durable'
          || crashPhase === 'cleanup-complete' ? 1 : 0,
      );
    },
  );

  it('rolls back a doctor failure immediately while keeping approval burned', async () => {
    const projectRoot = makeRepo();
    const oldCohort = cohort('old');
    const newCohort = cohort('new');
    writeCohort(projectRoot, oldCohort);
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const lease = acquireProjectTemplateApplyLease(projectRoot);
    let approvalConsumes = 0;
    const preconditionToken = await contentPrecondition(projectRoot);
    const execute = () => executeOwnedProjectTemplateCompanionLockTransaction({
      storage,
      lease,
      transactionPlanId: 'a'.repeat(64),
      preconditionToken,
      candidatePaths: ['workflows/review.yaml'],
      outputs: {
        mergeBaselines: [{ sha256: BASELINE_SHA256, content: BASELINE }],
        contentEntries: [{
          path: 'workflows/review.yaml',
          action: 'write' as const,
          content: newCohort[CONTENT_ENTRY_PATH]!,
          mode: '0600',
        }],
        contentLock: newCohort[CONTENT_LOCK_PATH]!,
        repertoireLock: newCohort[PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH]!,
        sourceProvenance: newCohort[PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH]!,
      },
      async consumeApproval() {
        approvalConsumes += 1;
        return approvalConsumes === 1;
      },
      runDoctor() { throw new Error('doctor rejected transaction'); },
    });
    try {
      await expect(execute()).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
      expect(readCohort(projectRoot)).toEqual(Object.freeze(Object.fromEntries(
        TARGET_PATHS.map((path) => [path, new TextDecoder().decode(oldCohort[path]!)]),
      )));
      expect(existsSync(join(storage.baselinesRoot, BASELINE_SHA256))).toBe(false);
      await expect(execute()).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      expect(approvalConsumes).toBe(2);
    } finally {
      lease.release();
    }
    const consumesBeforeRecovery = approvalConsumes;
    await expect(recoverProjectTemplateCompanionLockTransaction({ projectRoot }))
      .resolves.toMatchObject({ status: 'none' });
    expect(approvalConsumes).toBe(consumesBeforeRecovery);
  });

  it('retains primary and rollback failure safely, then restart recovery converges offline', async () => {
    const projectRoot = makeRepo();
    const oldCohort = cohort('old');
    const newCohort = cohort('new');
    writeCohort(projectRoot, oldCohort);
    const normalStorage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    let failOneRecoveryRename = false;
    const storage = {
      ...normalStorage,
      io: {
        ...normalStorage.io,
        async rename(source: string, destination: string) {
          if (failOneRecoveryRename) {
            failOneRecoveryRename = false;
            throw new Error(`transient rollback failure at ${projectRoot}`);
          }
          await normalStorage.io.rename(source, destination);
        },
      },
    };
    const lease = acquireProjectTemplateApplyLease(projectRoot);
    let approvalConsumes = 0;
    let observedError: unknown;
    try {
      await executeOwnedProjectTemplateCompanionLockTransaction({
        storage,
        lease,
        transactionPlanId: 'a'.repeat(64),
        preconditionToken: await contentPrecondition(projectRoot),
        candidatePaths: ['workflows/review.yaml'],
        outputs: {
          contentEntries: [{
            path: 'workflows/review.yaml',
            action: 'write',
            content: newCohort[CONTENT_ENTRY_PATH]!,
            mode: '0600',
          }],
          contentLock: newCohort[CONTENT_LOCK_PATH]!,
          repertoireLock: newCohort[PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH]!,
          sourceProvenance: newCohort[PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH]!,
        },
        async consumeApproval() {
          approvalConsumes += 1;
          return true;
        },
        runDoctor() {
          failOneRecoveryRename = true;
          throw new Error('doctor rejected transaction');
        },
      });
    } catch (error) {
      observedError = error;
    } finally {
      lease.release();
    }
    expect(observedError).toBeInstanceOf(ProjectTemplateCompanionLockRollbackError);
    expect(observedError).toMatchObject({
      code: 'PUBLISH_FAILED',
      rollbackFailure: 'OFFLINE_ROLLBACK_FAILED',
    });
    expect((observedError as ProjectTemplateCompanionLockRollbackError).operatorDetail)
      .not.toContain(projectRoot);
    expect((observedError as ProjectTemplateCompanionLockRollbackError)
      .hasRetainedRollbackFailure()).toBe(true);

    const consumesBeforeRecovery = approvalConsumes;
    await expect(recoverProjectTemplateCompanionLockTransaction({ projectRoot }))
      .resolves.toMatchObject({ status: 'rolled-back' });
    expect(approvalConsumes).toBe(consumesBeforeRecovery);
    expect(readCohort(projectRoot)).toEqual(Object.freeze(Object.fromEntries(
      TARGET_PATHS.map((path) => [path, new TextDecoder().decode(oldCohort[path]!)]),
    )));
    expect(existsSync(normalStorage.journalPath)).toBe(false);
    expect(readdirSync(normalStorage.stagingRoot)).toEqual([]);
    expect(readdirSync(normalStorage.backupsRoot)).toEqual([]);
  });
});
