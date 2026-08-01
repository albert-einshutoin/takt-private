import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeOwnedProjectTemplateCompanionLockTransaction,
  ProjectTemplateCompanionLockRollbackError,
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
  PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
} from '../../features/project-template/repertoire-dependency-lock.js';
import {
  PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
} from '../../features/project-template/source-provenance.js';

const CONTENT_LOCK_PATH = '.takt-template-lock.json';
const CONTENT_ENTRY_PATH = '.takt/workflows/review.yaml';
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

const CRASH_PHASES = [
  'content-entry-0-staged',
  'content-lock-staged',
  'repertoire-lock-staged',
  'source-provenance-staged',
  'content-entry-0-backed-up',
  'content-lock-backed-up',
  'repertoire-lock-backed-up',
  'source-provenance-backed-up',
  'journal-durable',
  'approval-consumed',
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
          preconditionToken: 'b'.repeat(64),
          outputs: {
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
    const execute = () => executeOwnedProjectTemplateCompanionLockTransaction({
      storage,
      lease,
      transactionPlanId: 'a'.repeat(64),
      preconditionToken: 'b'.repeat(64),
      outputs: {
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
        preconditionToken: 'b'.repeat(64),
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
