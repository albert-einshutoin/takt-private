import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  acquireProjectTemplateApplyLease,
  assertProjectTemplateMutationLeaseOwned,
  type ProjectTemplateApplyLease,
  type ProjectTemplateMutationLease,
} from './apply-lease.js';
import {
  captureProjectTemplateBackupFile,
  initializeProjectTemplateApplyStorage,
  parseProjectTemplateApplyJournal,
  readProjectTemplateBackupManifest,
  reclaimProjectTemplatePreparationOrphans,
  removeProjectTemplateBackupGeneration,
  removeProjectTemplateStagingTransaction,
  resolveProjectTemplateApplyTarget,
  writeProjectTemplateApplyJournal,
  writeProjectTemplateBackupManifest,
  writeProjectTemplateStagingFile,
  type ProjectTemplateApplyJournal,
  type ProjectTemplateApplyStorage,
  type ProjectTemplateApplyTarget,
  type ProjectTemplateBackupEntryState,
  type ProjectTemplateBackupManifest,
  type ProjectTemplateStagingFile,
} from './apply-storage.js';
import {
  linearizePreparedProjectTemplateRemoteTransaction,
} from './remote-transaction-linearization.js';

export type ProjectTemplateCompanionLockTransactionPhase =
  | 'content-lock-staged'
  | 'repertoire-lock-staged'
  | 'source-provenance-staged'
  | 'content-lock-backed-up'
  | 'repertoire-lock-backed-up'
  | 'source-provenance-backed-up'
  | 'journal-durable'
  | 'approval-consumed'
  | 'content-lock-published'
  | 'repertoire-lock-published'
  | 'source-provenance-published'
  | 'committed-marker-durable'
  | 'cleanup-complete';

interface CompanionOutput {
  readonly target: Exclude<ProjectTemplateApplyTarget,
    { kind: 'template-entry' } | { kind: 'lock' }>;
  readonly phasePrefix: 'content-lock' | 'repertoire-lock' | 'source-provenance';
  readonly content: Uint8Array;
}

interface PreparedOperation extends CompanionOutput {
  readonly staged: ProjectTemplateStagingFile;
  readonly before: ProjectTemplateBackupEntryState;
  readonly after: Extract<ProjectTemplateBackupEntryState, { kind: 'file' }>;
}

function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function mode(value: number): string {
  return `0${(value & 0o777).toString(8).padStart(3, '0')}`;
}

function assertOwned(
  _storage: ProjectTemplateApplyStorage,
  lease: ProjectTemplateApplyLease,
): void {
  assertProjectTemplateMutationLeaseOwned(
    dirname(dirname(lease.lockPath)),
    lease as ProjectTemplateMutationLease,
  );
}

async function currentState(
  storage: ProjectTemplateApplyStorage,
  target: ProjectTemplateApplyTarget,
): Promise<ProjectTemplateBackupEntryState> {
  const resolved = resolveProjectTemplateApplyTarget(storage, target);
  let before;
  try {
    before = await storage.io.lstat(resolved.absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    throw error;
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || before.dev !== storage.device
    || before.size > 4 * 1024 * 1024
  ) throw new Error('companion lock target is unsafe');
  const content = await storage.io.readFile(
    resolved.absolutePath,
    4 * 1024 * 1024,
  );
  const after = await storage.io.lstat(resolved.absolutePath);
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.mode !== after.mode
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || before.nlink !== after.nlink
  ) throw new Error('companion lock target changed during read');
  const digest = hash(content);
  return {
    kind: 'file',
    sha256: digest,
    bytes: content.byteLength,
    mode: mode(after.mode),
    blobRelativePath: `blobs/${digest}`,
    modifiedAt: after.mtime.toISOString(),
  };
}

async function publish(
  storage: ProjectTemplateApplyStorage,
  staged: ProjectTemplateStagingFile,
): Promise<void> {
  const target = resolveProjectTemplateApplyTarget(storage, staged.target);
  await storage.io.chmod(staged.absolutePath, 0o600);
  await storage.io.fsyncFile(staged.absolutePath);
  await storage.io.rename(staged.absolutePath, target.absolutePath);
  await storage.io.fsyncDirectory(dirname(target.absolutePath));
}

async function writeJournal(
  storage: ProjectTemplateApplyStorage,
  value: Omit<ProjectTemplateApplyJournal, 'schemaVersion'>,
): Promise<void> {
  await writeProjectTemplateApplyJournal({
    storage,
    journal: { schemaVersion: '1.1', ...value },
  });
}

async function removeJournal(storage: ProjectTemplateApplyStorage): Promise<void> {
  try {
    await storage.io.unlink(storage.journalPath);
    await storage.io.fsyncDirectory(dirname(storage.journalPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function executeOwnedProjectTemplateCompanionLockTransaction(
  options: {
    readonly storage: ProjectTemplateApplyStorage;
    readonly lease: ProjectTemplateApplyLease;
    readonly transactionPlanId: string;
    readonly preconditionToken: string;
    readonly outputs: {
      readonly contentLock: Uint8Array;
      readonly repertoireLock: Uint8Array;
      readonly sourceProvenance: Uint8Array;
    };
    readonly consumeApproval: () => Promise<boolean>;
    readonly runDoctor: () => void | Promise<void>;
    readonly onPhase?: (phase: ProjectTemplateCompanionLockTransactionPhase) => void;
  },
): Promise<{ readonly status: 'committed'; readonly transactionPlanId: string }> {
  const storage = options.storage;
  assertOwned(storage, options.lease);
  const transactionId = `remote-${randomUUID()}`;
  const backupId = `backup-${randomUUID()}`;
  const outputs: readonly CompanionOutput[] = [
    { target: { kind: 'content-lock' }, phasePrefix: 'content-lock', content: options.outputs.contentLock },
    { target: { kind: 'repertoire-lock' }, phasePrefix: 'repertoire-lock', content: options.outputs.repertoireLock },
    { target: { kind: 'source-provenance' }, phasePrefix: 'source-provenance', content: options.outputs.sourceProvenance },
  ];

  return linearizePreparedProjectTemplateRemoteTransaction({
    async prepare() {
      const observed = new Map<string, ProjectTemplateBackupEntryState>();
      for (const output of outputs) {
        observed.set(output.phasePrefix, await currentState(storage, output.target));
        assertOwned(storage, options.lease);
      }
      const staged: Array<CompanionOutput & { staged: ProjectTemplateStagingFile }> = [];
      for (const output of outputs) {
        staged.push({
          ...output,
          staged: await writeProjectTemplateStagingFile({
            storage,
            transactionId,
            target: output.target,
            content: output.content,
            expectedSha256: hash(output.content),
            targetMode: '0600',
          }),
        });
        assertOwned(storage, options.lease);
        options.onPhase?.(`${output.phasePrefix}-staged`);
      }
      const operations: PreparedOperation[] = [];
      for (const output of staged) {
        const before = observed.get(output.phasePrefix)!;
        let capturedBefore = before;
        if (before.kind === 'file') {
          const captured = await captureProjectTemplateBackupFile({
            storage,
            backupId,
            target: output.target,
            expectedSha256: before.sha256,
            expectedMode: before.mode,
            maxBytes: before.bytes,
          });
          assertOwned(storage, options.lease);
          capturedBefore = {
            kind: 'file',
            sha256: captured.sha256,
            bytes: captured.bytes,
            mode: captured.targetMode,
            blobRelativePath: captured.relativePath,
            ...(before.modifiedAt === undefined
              ? {}
              : { modifiedAt: before.modifiedAt }),
          };
        }
        operations.push({
          ...output,
          before: capturedBefore,
          after: {
            kind: 'file',
            sha256: output.staged.sha256,
            bytes: output.staged.bytes,
            mode: output.staged.targetMode,
            blobRelativePath: `blobs/${output.staged.sha256}`,
          },
        });
        options.onPhase?.(`${output.phasePrefix}-backed-up`);
      }
      await writeJournal(storage, {
        transactionId,
        planId: options.transactionPlanId,
        backupId,
        state: 'prepared',
        completedOperations: [],
        createdTargetDirectories: [],
        updatedAt: new Date().toISOString(),
      });
      assertOwned(storage, options.lease);
      options.onPhase?.('journal-durable');
      const manifest: ProjectTemplateBackupManifest = {
        schemaVersion: '1.1',
        backupId,
        planId: options.transactionPlanId,
        preconditionToken: options.preconditionToken,
        createdAt: new Date().toISOString(),
        createdTargetDirectories: [],
        entries: operations.map((operation) => ({
          target: operation.target,
          action: operation.before.kind === 'absent' ? 'add' : 'update',
          before: operation.before,
          after: operation.after,
        })),
      };
      await writeProjectTemplateBackupManifest({ storage, manifest });
      assertOwned(storage, options.lease);
      return Object.freeze({ transactionId, backupId, operations });
    },
    async consumeApproval() {
      const consumed = await options.consumeApproval();
      if (consumed) options.onPhase?.('approval-consumed');
      return consumed;
    },
    async publish(prepared) {
      const completedOperations: string[] = [];
      await writeJournal(storage, {
        transactionId,
        planId: options.transactionPlanId,
        backupId,
        state: 'committing',
        completedOperations,
        createdTargetDirectories: [],
        updatedAt: new Date().toISOString(),
      });
      assertOwned(storage, options.lease);
      for (const operation of prepared.operations) {
        await publish(storage, operation.staged);
        assertOwned(storage, options.lease);
        completedOperations.push(operation.phasePrefix);
        await writeJournal(storage, {
          transactionId,
          planId: options.transactionPlanId,
          backupId,
          state: 'committing',
          completedOperations,
          createdTargetDirectories: [],
          updatedAt: new Date().toISOString(),
        });
        assertOwned(storage, options.lease);
        options.onPhase?.(`${operation.phasePrefix}-published`);
      }
      await options.runDoctor();
      assertOwned(storage, options.lease);
      await writeJournal(storage, {
        transactionId,
        planId: options.transactionPlanId,
        backupId,
        state: 'committed',
        completedOperations,
        createdTargetDirectories: [],
        updatedAt: new Date().toISOString(),
      });
      assertOwned(storage, options.lease);
      options.onPhase?.('committed-marker-durable');
      await removeProjectTemplateStagingTransaction({ storage, transactionId });
      assertOwned(storage, options.lease);
      await removeJournal(storage);
      assertOwned(storage, options.lease);
      options.onPhase?.('cleanup-complete');
      return {
        status: 'committed' as const,
        transactionPlanId: options.transactionPlanId,
      };
    },
    assertAuthority() {
      assertOwned(storage, options.lease);
    },
  });
}

async function readJournal(
  storage: ProjectTemplateApplyStorage,
): Promise<ProjectTemplateApplyJournal | undefined> {
  try {
    const content = await storage.io.readFile(
      storage.journalPath,
      4 * 1024 * 1024,
    );
    return parseProjectTemplateApplyJournal(
      JSON.parse(content.toString('utf8')) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function restoreBefore(
  storage: ProjectTemplateApplyStorage,
  manifest: ProjectTemplateBackupManifest,
): Promise<void> {
  const recoveryId = `recovery-${randomUUID()}`;
  for (const entry of [...manifest.entries].reverse()) {
    const target = resolveProjectTemplateApplyTarget(storage, entry.target);
    if (entry.before.kind === 'absent') {
      try {
        await storage.io.unlink(target.absolutePath);
        await storage.io.fsyncDirectory(dirname(target.absolutePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      continue;
    }
    const content = await storage.io.readFile(
      join(storage.backupsRoot, manifest.backupId, entry.before.blobRelativePath),
      entry.before.bytes,
    );
    if (hash(content) !== entry.before.sha256) {
      throw new Error('companion lock backup failed integrity validation');
    }
    const staged = await writeProjectTemplateStagingFile({
      storage,
      transactionId: recoveryId,
      target: entry.target,
      content,
      expectedSha256: entry.before.sha256,
      targetMode: entry.before.mode,
    });
    await publish(storage, staged);
  }
  await removeProjectTemplateStagingTransaction({
    storage,
    transactionId: recoveryId,
  });
}

async function recoverOwned(
  projectRoot: string,
  lease: ProjectTemplateApplyLease,
): Promise<{ readonly status: 'none' | 'committed' | 'rolled-back' }> {
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: projectRoot,
    });
    assertOwned(storage, lease);
    const journal = await readJournal(storage);
    assertOwned(storage, lease);
    if (journal === undefined) {
      await reclaimProjectTemplatePreparationOrphans({ storage });
      assertOwned(storage, lease);
      return { status: 'none' };
    }
    let manifest: ProjectTemplateBackupManifest;
    try {
      manifest = await readProjectTemplateBackupManifest({
        storage,
        backupId: journal.backupId,
      });
    } catch (error) {
      if (journal.state !== 'prepared' || journal.completedOperations.length !== 0) {
        throw error;
      }
      await removeProjectTemplateStagingTransaction({
        storage,
        transactionId: journal.transactionId,
      });
      await removeProjectTemplateBackupGeneration({
        storage,
        backupId: journal.backupId,
      });
      await removeJournal(storage);
      return { status: 'rolled-back' };
    }
    assertOwned(storage, lease);
    if (manifest.planId !== journal.planId) {
      throw new Error('companion transaction journal plan mismatch');
    }
    if (journal.state === 'committed') {
      await removeProjectTemplateStagingTransaction({
        storage,
        transactionId: journal.transactionId,
      });
      await removeJournal(storage);
      return { status: 'committed' };
    }
    await restoreBefore(storage, manifest);
    assertOwned(storage, lease);
    await removeProjectTemplateStagingTransaction({
      storage,
      transactionId: journal.transactionId,
    });
    await removeJournal(storage);
    return { status: 'rolled-back' };
}

export async function recoverProjectTemplateCompanionLockTransaction(
  options: { readonly projectRoot: string },
): Promise<{ readonly status: 'none' | 'committed' | 'rolled-back' }> {
  const lease = acquireProjectTemplateApplyLease(options.projectRoot);
  let result:
    { readonly status: 'none' | 'committed' | 'rolled-back' } | undefined;
  let primaryError: unknown;
  try {
    result = await recoverOwned(options.projectRoot, lease);
  } catch (error) {
    primaryError = error;
  }
  try {
    lease.release();
  } catch (releaseError) {
    primaryError ??= releaseError;
  }
  if (primaryError !== undefined) throw primaryError;
  return result!;
}
