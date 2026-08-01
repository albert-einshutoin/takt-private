import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { PROJECT_TEMPLATE_TRANSACTION_LIMITS } from './transaction-limits.js';
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
  type ProjectTemplateApplyStorageIo,
  type ProjectTemplateApplyTarget,
  type ProjectTemplateBackupEntryState,
  type ProjectTemplateBackupManifest,
  type ProjectTemplateStagingFile,
} from './apply-storage.js';
import {
  linearizePreparedProjectTemplateRemoteTransaction,
  ProjectTemplateRemoteTransactionLinearizationError,
} from './remote-transaction-linearization.js';

type TransactionTargetPhase =
  | `content-entry-${number}`
  | 'content-lock'
  | 'repertoire-lock'
  | 'source-provenance';

export type ProjectTemplateCompanionLockTransactionPhase =
  | `${TransactionTargetPhase}-staged`
  | `${TransactionTargetPhase}-backed-up`
  | `${TransactionTargetPhase}-before-fsync`
  | `${TransactionTargetPhase}-after-fsync`
  | `${TransactionTargetPhase}-before-rename`
  | `${TransactionTargetPhase}-after-rename`
  | `${TransactionTargetPhase}-published`
  | 'journal-durable'
  | 'approval-consumed'
  | 'committed-marker-durable'
  | 'cleanup-complete';

interface TransactionOutput {
  readonly target: Exclude<ProjectTemplateApplyTarget, { kind: 'lock' }>;
  readonly phasePrefix: TransactionTargetPhase;
  readonly action: 'write' | 'delete';
  readonly content?: Uint8Array;
  readonly targetMode?: string;
}

interface PreparedOperation extends TransactionOutput {
  readonly staged?: ProjectTemplateStagingFile;
  readonly before: ProjectTemplateBackupEntryState;
  readonly after: ProjectTemplateBackupEntryState;
}

export class ProjectTemplateCompanionLockRollbackError extends Error {
  readonly code: ProjectTemplateRemoteTransactionLinearizationError['code'];
  readonly operatorDetail: string;
  readonly rollbackFailure = 'OFFLINE_ROLLBACK_FAILED' as const;
  readonly #rollbackError: unknown;

  constructor(
    primary: ProjectTemplateRemoteTransactionLinearizationError,
    rollbackError: unknown,
  ) {
    super(primary.message, { cause: primary });
    this.name = 'ProjectTemplateCompanionLockRollbackError';
    this.code = primary.code;
    this.operatorDetail = `${primary.operatorDetail};offline-rollback-failed`;
    // Retain the secondary failure for trusted diagnostics without exposing a
    // raw path or secret through the public operator detail.
    this.#rollbackError = rollbackError;
  }

  hasRetainedRollbackFailure(): boolean {
    return this.#rollbackError !== undefined;
  }
}

export class ProjectTemplateCompanionLockRecoveryError extends Error {
  readonly code = 'RECOVERY_BLOCKED' as const;
  readonly operatorDetail = 'recovery-evidence-inconsistent' as const;

  constructor() {
    super('project template companion lock recovery is blocked');
    this.name = 'ProjectTemplateCompanionLockRecoveryError';
    Object.freeze(this);
  }
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
  phasePrefix?: TransactionTargetPhase,
  onPhase?: (phase: ProjectTemplateCompanionLockTransactionPhase) => void,
): Promise<void> {
  const target = resolveProjectTemplateApplyTarget(storage, staged.target);
  if (staged.target.kind === 'template-entry') {
    const relativeParent = dirname(staged.target.path);
    let current = storage.targetRoot;
    for (const segment of [
      '',
      ...(relativeParent === '.' ? [] : relativeParent.split('/')),
    ]) {
      if (segment !== '') current = join(current, segment);
      try {
        const stat = await storage.io.lstat(current);
        if (
          stat.isSymbolicLink()
          || !stat.isDirectory()
          || stat.dev !== storage.device
        ) throw new Error('template target parent is unsafe');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await storage.io.mkdir(current, 0o700);
        await storage.io.fsyncDirectory(dirname(current));
      }
    }
  }
  // The staging inode is private while unpublished, then receives the sealed
  // target mode before rename so the durable after-witness matches reality.
  await storage.io.chmod(staged.absolutePath, Number.parseInt(staged.targetMode, 8));
  const beforeWitness = await storage.io.lstat(staged.absolutePath);
  const content = await storage.io.readFile(staged.absolutePath, staged.bytes);
  const afterWitness = await storage.io.lstat(staged.absolutePath);
  if (
    beforeWitness.isSymbolicLink()
    || !beforeWitness.isFile()
    || beforeWitness.nlink !== 1
    || beforeWitness.dev !== storage.device
    || beforeWitness.size !== staged.bytes
    || hash(content) !== staged.sha256
    || beforeWitness.dev !== afterWitness.dev
    || beforeWitness.ino !== afterWitness.ino
    || beforeWitness.mode !== afterWitness.mode
    || beforeWitness.size !== afterWitness.size
    || beforeWitness.mtimeMs !== afterWitness.mtimeMs
    || beforeWitness.ctimeMs !== afterWitness.ctimeMs
    || beforeWitness.nlink !== afterWitness.nlink
    || (storage.platform !== 'win32' && mode(afterWitness.mode) !== staged.targetMode)
  ) throw new Error('companion lock staging witness changed before publish');
  if (phasePrefix !== undefined) onPhase?.(`${phasePrefix}-before-fsync`);
  await storage.io.fsyncFile(staged.absolutePath);
  if (phasePrefix !== undefined) onPhase?.(`${phasePrefix}-after-fsync`);
  if (phasePrefix !== undefined) onPhase?.(`${phasePrefix}-before-rename`);
  await storage.io.rename(staged.absolutePath, target.absolutePath);
  if (phasePrefix !== undefined) onPhase?.(`${phasePrefix}-after-rename`);
  await storage.io.fsyncDirectory(dirname(target.absolutePath));
}

function targetParentDirectories(
  storage: ProjectTemplateApplyStorage,
  target: ProjectTemplateApplyTarget,
): string[] {
  if (target.kind !== 'template-entry') return [];
  const resolved = resolveProjectTemplateApplyTarget(storage, target);
  const relativeParent = relative(storage.targetRoot, dirname(resolved.absolutePath))
    .split(sep).join('/');
  const result = [''];
  let current = '';
  for (const segment of relativeParent === '' ? [] : relativeParent.split('/')) {
    current = current === '' ? segment : `${current}/${segment}`;
    result.push(current);
  }
  return result;
}

async function collectMissingTargetDirectories(
  storage: ProjectTemplateApplyStorage,
  outputs: readonly TransactionOutput[],
): Promise<string[]> {
  const candidates = new Set(outputs.flatMap((output) => (
    targetParentDirectories(storage, output.target)
  )));
  const missing: string[] = [];
  for (const relativePath of [...candidates].sort(
    (left, right) => left.split('/').length - right.split('/').length
      || left.localeCompare(right),
  )) {
    const absolutePath = relativePath === ''
      ? storage.targetRoot
      : join(storage.targetRoot, relativePath);
    try {
      const stat = await storage.io.lstat(absolutePath);
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== storage.device) {
        throw new Error('template target parent is unsafe');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(relativePath);
    }
  }
  return missing;
}

async function removeCreatedTargetDirectories(
  storage: ProjectTemplateApplyStorage,
  directories: readonly string[],
): Promise<void> {
  for (const relativePath of [...directories].sort(
    (left, right) => right.split('/').length - left.split('/').length
      || right.localeCompare(left),
  )) {
    const absolutePath = relativePath === ''
      ? storage.targetRoot
      : join(storage.targetRoot, relativePath);
    try {
      const stat = await storage.io.lstat(absolutePath);
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== storage.device) {
        throw new Error('created target directory is unsafe');
      }
      await storage.io.rmdir(absolutePath);
      await storage.io.fsyncDirectory(dirname(absolutePath));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    }
  }
}

async function deletePublishedTarget(
  storage: ProjectTemplateApplyStorage,
  target: ProjectTemplateApplyTarget,
): Promise<void> {
  const resolved = resolveProjectTemplateApplyTarget(storage, target);
  try {
    const stat = await storage.io.lstat(resolved.absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error('transaction delete target is unsafe');
    }
    await storage.io.unlink(resolved.absolutePath);
    await storage.io.fsyncDirectory(dirname(resolved.absolutePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
      readonly contentEntries?: readonly (
        | {
          readonly path: string;
          readonly action: 'write';
          readonly content: Uint8Array;
          readonly mode: string;
        }
        | { readonly path: string; readonly action: 'delete' }
      )[];
      readonly contentLock: Uint8Array;
      readonly repertoireLock: Uint8Array;
      readonly sourceProvenance: Uint8Array;
    };
    readonly consumeApproval: () => Promise<boolean>;
    readonly runDoctor: () => void | Promise<void>;
    readonly onPhase?: (phase: ProjectTemplateCompanionLockTransactionPhase) => void;
  },
): Promise<{
  readonly status: 'committed';
  readonly backupId: string;
  readonly planId: string;
}> {
  const storage = options.storage;
  assertOwned(storage, options.lease);
  const transactionId = `remote-${randomUUID()}`;
  const backupId = `backup-${randomUUID()}`;
  const contentOutputs = (options.outputs.contentEntries ?? [])
      .slice()
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry, index): TransactionOutput => entry.action === 'delete'
        ? {
            target: { kind: 'template-entry', path: entry.path },
            phasePrefix: `content-entry-${index}`,
            action: 'delete',
          }
        : {
            target: { kind: 'template-entry', path: entry.path },
            phasePrefix: `content-entry-${index}`,
            action: 'write',
            content: entry.content,
            targetMode: entry.mode,
          });
  const outputs: readonly TransactionOutput[] = [
    ...contentOutputs,
    { target: { kind: 'content-lock' }, phasePrefix: 'content-lock', action: 'write', content: options.outputs.contentLock, targetMode: '0600' },
    { target: { kind: 'repertoire-lock' }, phasePrefix: 'repertoire-lock', action: 'write', content: options.outputs.repertoireLock, targetMode: '0600' },
    { target: { kind: 'source-provenance' }, phasePrefix: 'source-provenance', action: 'write', content: options.outputs.sourceProvenance, targetMode: '0600' },
  ];

  try {
    return await linearizePreparedProjectTemplateRemoteTransaction({
    async prepare() {
      const observed = new Map<string, ProjectTemplateBackupEntryState>();
      for (const output of outputs) {
        observed.set(output.phasePrefix, await currentState(storage, output.target));
        assertOwned(storage, options.lease);
      }
      const staged: Array<TransactionOutput & { staged?: ProjectTemplateStagingFile }> = [];
      for (const output of outputs) {
        let stagedFile: ProjectTemplateStagingFile | undefined;
        if (output.action === 'write') {
          stagedFile = await writeProjectTemplateStagingFile({
            storage,
            transactionId,
            target: output.target,
            content: output.content!,
            expectedSha256: hash(output.content!),
            targetMode: output.targetMode!,
          });
        }
        staged.push({
          ...output,
          ...(stagedFile === undefined ? {} : { staged: stagedFile }),
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
          after: output.action === 'delete'
            ? { kind: 'absent' }
            : {
              kind: 'file',
              sha256: output.staged!.sha256,
              bytes: output.staged!.bytes,
              mode: output.staged!.targetMode,
              blobRelativePath: `blobs/${output.staged!.sha256}`,
            },
        });
        options.onPhase?.(`${output.phasePrefix}-backed-up`);
      }
      const createdTargetDirectories = await collectMissingTargetDirectories(
        storage,
        outputs,
      );
      await writeJournal(storage, {
        transactionId,
        planId: options.transactionPlanId,
        backupId,
        state: 'prepared',
        completedOperations: [],
        createdTargetDirectories,
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
        createdTargetDirectories,
        entries: operations.map((operation) => ({
          target: operation.target,
          action: operation.action === 'delete'
            ? 'delete'
            : operation.before.kind === 'absent' ? 'add' : 'update',
          before: operation.before,
          after: operation.after,
        })),
      };
      await writeProjectTemplateBackupManifest({ storage, manifest });
      assertOwned(storage, options.lease);
      return Object.freeze({
        transactionId,
        backupId,
        operations,
        createdTargetDirectories,
      });
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
        createdTargetDirectories: prepared.createdTargetDirectories,
        updatedAt: new Date().toISOString(),
      });
      assertOwned(storage, options.lease);
      for (const operation of prepared.operations) {
        if (operation.action === 'delete') {
          await deletePublishedTarget(storage, operation.target);
        } else {
          await publish(
            storage,
            operation.staged!,
            operation.phasePrefix,
            options.onPhase,
          );
        }
        assertOwned(storage, options.lease);
        completedOperations.push(
          resolveProjectTemplateApplyTarget(storage, operation.target).key,
        );
        await writeJournal(storage, {
          transactionId,
          planId: options.transactionPlanId,
          backupId,
          state: 'committing',
          completedOperations,
          createdTargetDirectories: prepared.createdTargetDirectories,
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
        createdTargetDirectories: prepared.createdTargetDirectories,
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
        backupId,
        planId: options.transactionPlanId,
      };
    },
    assertAuthority() {
      assertOwned(storage, options.lease);
    },
    });
  } catch (error) {
    if (error instanceof ProjectTemplateRemoteTransactionLinearizationError) {
      // Recovery runs under the already-owned lease. It never reacquires or
      // consults network, receipt, cache, or approval state; a post-consume
      // failure therefore burns authority while restoring the old cohort.
      try {
        await recoverOwnedStorage(storage, options.lease);
      } catch (rollbackError) {
        // The durable journal stays available for the next offline recovery.
        // The wrapper preserves both failures while its public detail remains
        // deliberately path- and secret-free.
        throw new ProjectTemplateCompanionLockRollbackError(error, rollbackError);
      }
    }
    throw error;
  }
}

async function readJournal(
  storage: ProjectTemplateApplyStorage,
): Promise<ProjectTemplateApplyJournal | undefined> {
  try {
    const content = await storage.io.readFile(
      storage.journalPath,
      PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxJournalBytes,
    );
    return parseProjectTemplateApplyJournal(
      JSON.parse(content.toString('utf8')) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function stateMatches(
  actual: ProjectTemplateBackupEntryState,
  expected: ProjectTemplateBackupEntryState,
  platform: NodeJS.Platform,
): boolean {
  return actual.kind === 'absent'
    ? expected.kind === 'absent'
    : expected.kind === 'file'
      && actual.sha256 === expected.sha256
      && actual.bytes === expected.bytes
      && (platform === 'win32' || actual.mode === expected.mode);
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function recoveryBlocked(): never {
  throw new ProjectTemplateCompanionLockRecoveryError();
}

async function validateRecoveryEvidence(
  storage: ProjectTemplateApplyStorage,
  journal: ProjectTemplateApplyJournal,
  manifest: ProjectTemplateBackupManifest,
): Promise<Set<string>> {
  if (
    manifest.schemaVersion !== journal.schemaVersion
    || manifest.planId !== journal.planId
    || manifest.backupId !== journal.backupId
    || !sameStringArray(
      manifest.createdTargetDirectories,
      journal.createdTargetDirectories,
    )
  ) recoveryBlocked();

  const keys = manifest.entries.map((entry) => (
    resolveProjectTemplateApplyTarget(storage, entry.target).key
  ));
  if (new Set(keys).size !== keys.length) recoveryBlocked();
  for (const entry of manifest.entries) {
    const validAction = entry.action === 'add'
      ? entry.before.kind === 'absent' && entry.after.kind === 'file'
      : entry.action === 'update'
        ? entry.before.kind === 'file' && entry.after.kind === 'file'
        : entry.action === 'delete'
          && entry.before.kind === 'file' && entry.after.kind === 'absent';
    if (!validAction) recoveryBlocked();
  }
  const completed = journal.completedOperations;
  const rollbackOrder = [...keys].reverse();
  const rollingBack = journal.state === 'rolling-back';
  if (
    new Set(completed).size !== completed.length
    || completed.some((key, index) => key !== (
      rollingBack ? rollbackOrder[index] : keys[index]
    ))
  ) recoveryBlocked();

  const fullCompletionRequired = journal.state === 'verifying'
    || journal.state === 'committed';
  if (
    (journal.state === 'prepared' && completed.length !== 0)
    || (fullCompletionRequired && completed.length !== keys.length)
    || !['prepared', 'committing', 'verifying', 'committed', 'rolling-back']
      .includes(journal.state)
  ) recoveryBlocked();

  const restore = new Set<string>();
  const states: Array<'before' | 'after'> = [];
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index]!;
    const actual = await currentState(storage, entry.target);
    const matchesBefore = stateMatches(actual, entry.before, storage.platform);
    const matchesAfter = stateMatches(actual, entry.after, storage.platform);
    if (!matchesBefore && !matchesAfter) recoveryBlocked();
    const state = matchesAfter && !matchesBefore ? 'after' : 'before';
    states.push(state);
    if (state === 'after') restore.add(keys[index]!);
  }

  if (journal.state === 'prepared' && states.some((state) => state !== 'before')) {
    recoveryBlocked();
  }
  if (journal.state === 'committed' || journal.state === 'verifying') {
    if (states.some((state) => state !== 'after')) recoveryBlocked();
  } else if (rollingBack) {
    const restored = new Set(completed);
    for (let index = 0; index < states.length; index += 1) {
      if (restored.has(keys[index]!) && states[index] !== 'before') recoveryBlocked();
    }
  } else if (journal.state === 'committing') {
    for (let index = 0; index < states.length; index += 1) {
      if (index < completed.length && states[index] !== 'after') recoveryBlocked();
      if (index > completed.length && states[index] !== 'before') recoveryBlocked();
    }
  }
  return restore;
}

async function restoreBefore(
  storage: ProjectTemplateApplyStorage,
  journal: ProjectTemplateApplyJournal,
  manifest: ProjectTemplateBackupManifest,
  backupBytes: ReadonlyMap<string, Buffer>,
  beforeTargetRestore?: (target: ProjectTemplateApplyTarget) => void,
): Promise<void> {
  const recoveryId = `recovery-${randomUUID()}`;
  const restored = journal.state === 'rolling-back'
    ? [...journal.completedOperations]
    : [];
  if (journal.state !== 'rolling-back') {
    await writeProjectTemplateApplyJournal({
      storage,
      journal: {
        ...journal,
        state: 'rolling-back',
        completedOperations: restored,
        updatedAt: new Date().toISOString(),
      },
    });
  }
  for (const entry of [...manifest.entries].reverse()) {
    const target = resolveProjectTemplateApplyTarget(storage, entry.target);
    if (restored.includes(target.key)) continue;
    beforeTargetRestore?.(entry.target);
    const actual = await currentState(storage, entry.target);
    if (!stateMatches(actual, entry.before, storage.platform)) {
      if (!stateMatches(actual, entry.after, storage.platform)) recoveryBlocked();
      if (entry.before.kind === 'absent') {
        try {
          await storage.io.unlink(target.absolutePath);
          await storage.io.fsyncDirectory(dirname(target.absolutePath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      } else {
        const content = backupBytes.get(target.key);
        if (content === undefined) recoveryBlocked();
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
    }
    restored.push(target.key);
    await writeProjectTemplateApplyJournal({
      storage,
      journal: {
        ...journal,
        state: 'rolling-back',
        completedOperations: restored,
        updatedAt: new Date().toISOString(),
      },
    });
  }
  await removeCreatedTargetDirectories(storage, manifest.createdTargetDirectories);
  await removeProjectTemplateStagingTransaction({
    storage,
    transactionId: recoveryId,
  });
}

async function preflightRecoveryBackupBytes(
  storage: ProjectTemplateApplyStorage,
  manifest: ProjectTemplateBackupManifest,
  restoreKeys: ReadonlySet<string>,
): Promise<ReadonlyMap<string, Buffer>> {
  const result = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    const target = resolveProjectTemplateApplyTarget(storage, entry.target);
    if (!restoreKeys.has(target.key) || entry.before.kind === 'absent') continue;
    totalBytes += entry.before.bytes;
    if (
      !Number.isSafeInteger(totalBytes)
      || totalBytes > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxBytes
    ) {
      recoveryBlocked();
    }
    const content = await storage.io.readPrivateFile(
      join(storage.backupsRoot, manifest.backupId, entry.before.blobRelativePath),
      entry.before.bytes,
      storage.device,
    );
    if (content.byteLength !== entry.before.bytes || hash(content) !== entry.before.sha256) {
      recoveryBlocked();
    }
    result.set(target.key, content);
  }
  return result;
}

async function recoverOwnedStorage(
  storage: ProjectTemplateApplyStorage,
  lease: ProjectTemplateApplyLease,
  beforeTargetRestore?: (target: ProjectTemplateApplyTarget) => void,
): Promise<{ readonly status: 'none' | 'committed' | 'rolled-back' }> {
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
    } catch {
      let manifestMissing = false;
      try {
        await storage.io.lstat(join(
          storage.backupsRoot,
          journal.backupId,
          'manifest.json',
        ));
      } catch (statError) {
        manifestMissing = (statError as NodeJS.ErrnoException).code === 'ENOENT';
      }
      if (
        !manifestMissing
        || journal.state !== 'prepared'
        || journal.completedOperations.length !== 0
      ) {
        throw new ProjectTemplateCompanionLockRecoveryError();
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
    let restoreKeys: Set<string>;
    try {
      restoreKeys = await validateRecoveryEvidence(storage, journal, manifest);
    } catch {
      throw new ProjectTemplateCompanionLockRecoveryError();
    }
    if (journal.state === 'committed') {
      await removeProjectTemplateStagingTransaction({
        storage,
        transactionId: journal.transactionId,
      });
      await removeJournal(storage);
      return { status: 'committed' };
    }
    let backupBytes: ReadonlyMap<string, Buffer>;
    try {
      backupBytes = await preflightRecoveryBackupBytes(storage, manifest, restoreKeys);
    } catch {
      throw new ProjectTemplateCompanionLockRecoveryError();
    }
    await restoreBefore(
      storage, journal, manifest, backupBytes, beforeTargetRestore,
    );
    assertOwned(storage, lease);
    await removeProjectTemplateStagingTransaction({
      storage,
      transactionId: journal.transactionId,
    });
    await removeJournal(storage);
    await removeProjectTemplateBackupGeneration({
      storage,
      backupId: journal.backupId,
    });
    await reclaimProjectTemplatePreparationOrphans({ storage });
    return { status: 'rolled-back' };
}

export async function recoverProjectTemplateCompanionLockTransaction(
  options: { readonly projectRoot: string },
): Promise<{ readonly status: 'none' | 'committed' | 'rolled-back' }> {
  return await recoverProjectTemplateCompanionLockTransactionInternal(options);
}

/** @internal Fault and race orchestration for recovery tests. */
export async function recoverProjectTemplateCompanionLockTransactionForTest(
  options: {
    readonly projectRoot: string;
    readonly io?: ProjectTemplateApplyStorageIo;
    readonly beforeTargetRestore?: (target: ProjectTemplateApplyTarget) => void;
  },
): Promise<{ readonly status: 'none' | 'committed' | 'rolled-back' }> {
  return await recoverProjectTemplateCompanionLockTransactionInternal(options);
}

async function recoverProjectTemplateCompanionLockTransactionInternal(
  options: {
    readonly projectRoot: string;
    readonly io?: ProjectTemplateApplyStorageIo;
    readonly beforeTargetRestore?: (target: ProjectTemplateApplyTarget) => void;
  },
): Promise<{ readonly status: 'none' | 'committed' | 'rolled-back' }> {
  const lease = acquireProjectTemplateApplyLease(options.projectRoot);
  let result:
    { readonly status: 'none' | 'committed' | 'rolled-back' } | undefined;
  let primaryError: unknown;
  try {
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: options.projectRoot,
      ...(options.io === undefined ? {} : { io: options.io }),
    });
    result = await recoverOwnedStorage(
      storage, lease, options.beforeTargetRestore,
    );
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
