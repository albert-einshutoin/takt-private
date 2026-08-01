import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeOwnedProjectTemplateCompanionLockTransaction,
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

const LOCK_PATHS = [
  CONTENT_LOCK_PATH,
  PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
  PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
] as const;

function cohort(prefix: 'old' | 'new'): Readonly<Record<string, Uint8Array>> {
  return Object.freeze(Object.fromEntries(LOCK_PATHS.map((path) => [
    path,
    new TextEncoder().encode(`${prefix}:${path}\n`),
  ])));
}

function writeCohort(projectRoot: string, value: Readonly<Record<string, Uint8Array>>): void {
  for (const path of LOCK_PATHS) {
    writeFileSync(join(projectRoot, path), value[path]!, { mode: 0o600 });
  }
}

function readCohort(projectRoot: string): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(LOCK_PATHS.map((path) => [
    path,
    readFileSync(join(projectRoot, path), 'utf8'),
  ])));
}

const CRASH_PHASES = [
  'content-lock-staged',
  'repertoire-lock-staged',
  'source-provenance-staged',
  'content-lock-backed-up',
  'repertoire-lock-backed-up',
  'source-provenance-backed-up',
  'journal-durable',
  'approval-consumed',
  'content-lock-published',
  'repertoire-lock-published',
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
        [oldValues[0], newValues[1], newValues[2]],
      );
    },
  );
});
