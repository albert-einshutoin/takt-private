import { createHash, randomBytes } from 'node:crypto';
import {
  Dir,
  Stats,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import {
  captureDirectoryTreeProof,
  readApprovedRegularFile,
  sameTreeProof,
  type TreeProof,
} from './filesystem-proof.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
export const MAX_MAINTENANCE_TRANSACTIONS = 4_096;
export const MAX_MAINTENANCE_AGGREGATE_ENTRIES = 65_536;
export const MAX_MAINTENANCE_AGGREGATE_BYTES = 1024 * 1024 * 1024;
export const MAX_MAINTENANCE_METADATA_BYTES = 16 * 1024 * 1024;
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeBufferToStringMethod = Buffer.prototype.toString;
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const safeDirReadSyncMethod = Dir.prototype.readSync;
const safeDirCloseSyncMethod = Dir.prototype.closeSync;
const safeOpenDirectorySync = opendirSync.bind(undefined);
const safeArrayIsArray = Array.isArray.bind(Array);
const safeArraySortMethod = Array.prototype.sort;
const safeArrayPushMethod = Array.prototype.push;
const safeArrayJoinMethod = Array.prototype.join;
const safeStringStartsWithMethod = String.prototype.startsWith;
const safeJsonParse = JSON.parse.bind(JSON);
const safeJsonStringify = JSON.stringify.bind(JSON);
const safeBufferFrom = Buffer.from.bind(Buffer);
const safeNumberIsSafeInteger = Number.isSafeInteger.bind(Number);
const safeMathMin = Math.min.bind(Math);
const MAX_TRANSACTION_CHILDREN = 8;

export class RepertoireMaintenanceError extends Error {
  readonly code = 'RECOVERY_REQUIRED' as const;

  constructor() {
    super('Repertoire package recovery is required');
    this.name = 'RepertoireMaintenanceError';
  }
}

export class RepertoireMaintenanceCapacityError extends Error {
  readonly code = 'MAINTENANCE_REQUIRED' as const;

  constructor() {
    super('Repertoire maintenance cleanup is required');
    this.name = 'RepertoireMaintenanceCapacityError';
  }
}

export type MaintenancePayloadKind = 'payload' | 'partial';
export type MaintenanceClassification = { complete: string[]; incomplete: string[] };
type PortableTreeSummary = { digest: string; entries: number; bytes: number };
export type MaintenanceClassificationLimits = Partial<{
  transactions: number;
  entries: number;
  bytes: number;
  metadataBytes: number;
}>;
type ClassificationOptions = {
  /** Test-only lower limits for exact boundary coverage. */
  limits?: MaintenanceClassificationLimits;
  /** Test-only proof that aggregate preflight occurs before payload reads. */
  onPayloadOpen?: () => void;
  /** Test-only proof of metadata short-circuit read counts. */
  onMetadataRead?: () => void;
  /** Test-only observation of bounded directory entry reads. */
  onDirectoryEntryRead?: () => void;
  /** Test-only observation after the captured closeSync succeeds. */
  onDirectoryClose?: () => void;
};
type PreparedTransaction = {
  transaction: string;
  transactionEntries?: string[];
  intent?: ReturnType<typeof readApprovedRegularFile>;
  outcome?: ReturnType<typeof readApprovedRegularFile>;
  completeRecord?: ReturnType<typeof readApprovedRegularFile>;
  parsedIntent?: Record<string, unknown>;
  parsedOutcome?: Record<string, unknown>;
  parsedComplete?: Record<string, unknown>;
};

export interface DetachToMaintenanceOptions {
  globalConfigDir: string;
  sourceDir: string;
  containmentRoot: string;
  expected: TreeProof;
  kind: MaintenancePayloadKind;
  /** Test-only deterministic crash/fault boundary. */
  onPhase?: (phase: MaintenanceTransactionPhase) => void;
  /** Test-only direct filesystem operation fault injection. */
  beforeFilesystemOperation?: (operation: MaintenanceFilesystemOperation) => void;
  /** Test-only lower startup classification limits. */
  maintenanceLimits?: MaintenanceClassificationLimits;
}

export type MaintenanceFilesystemOperation =
  | 'maintenance-root-mkdir'
  | 'maintenance-root-fsync'
  | 'transactions-root-mkdir'
  | 'transactions-root-fsync'
  | 'transaction-mkdir'
  | 'transaction-parent-fsync'
  | 'intent-write'
  | 'intent-file-fsync'
  | 'intent-parent-fsync'
  | 'rename'
  | 'source-parent-fsync'
  | 'destination-parent-fsync'
  | 'payload-proof'
  | 'outcome-write'
  | 'outcome-file-fsync'
  | 'complete-write'
  | 'complete-file-fsync'
  | 'complete-pending-rename'
  | 'complete-parent-fsync';

export type MaintenanceTransactionPhase =
  | 'maintenance-root-created'
  | 'maintenance-root-durable'
  | 'transactions-root-created'
  | 'transactions-root-durable'
  | 'transaction-created'
  | 'intent-written'
  | 'intent-durable'
  | 'before-rename'
  | 'after-rename'
  | 'rename-durable'
  | 'proof-complete'
  | 'outcome-written'
  | 'outcome-durable'
  | 'complete-written'
  | 'complete-pending-durable'
  | 'complete-renamed'
  | 'complete-durable';

/** Fail closed at startup when a prior mutation did not publish its outcome. */
export function assertMaintenanceTransactionsReady(globalConfigDir: string): void {
  const classification = classifyMaintenanceTransactions(globalConfigDir);
  if (classification.incomplete.length !== 0) throw recoveryRequired();
}

export function classifyMaintenanceTransactions(
  globalConfigDir: string,
  options: ClassificationOptions = {},
): MaintenanceClassification {
  try {
    const transactionsRoot = transactionRoot(globalConfigDir);
    const limits = {
      transactions: options.limits?.transactions ?? MAX_MAINTENANCE_TRANSACTIONS,
      entries: options.limits?.entries ?? MAX_MAINTENANCE_AGGREGATE_ENTRIES,
      bytes: options.limits?.bytes ?? MAX_MAINTENANCE_AGGREGATE_BYTES,
      metadataBytes: options.limits?.metadataBytes ?? MAX_MAINTENANCE_METADATA_BYTES,
    };
    let entries: string[];
    try {
      entries = readDirectoryBounded(
        transactionsRoot,
        limits.transactions,
        options.onDirectoryEntryRead,
        options.onDirectoryClose,
        maintenanceRequired,
      );
    } catch (error) {
      if (isMissing(error)) return { complete: [], incomplete: [] };
      throw error;
    }
    safeReflectApply(safeArraySortMethod, entries, []);
    const result: MaintenanceClassification = { complete: [], incomplete: [] };
    const prepared: PreparedTransaction[] = [];
    let aggregateEntries = 0;
    let aggregateBytes = 0;
    let metadataBytes = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const transaction = join(transactionsRoot, entries[index]!);
      const stat = lstatSync(transaction);
      if (!isDirectory(stat) || isSymbolicLink(stat)) throw recoveryRequired();
      const item: PreparedTransaction = { transaction };
      try {
        item.transactionEntries = readDirectoryBounded(
          transaction,
          MAX_TRANSACTION_CHILDREN,
          options.onDirectoryEntryRead,
          options.onDirectoryClose,
          recoveryRequired,
        );
        safeReflectApply(safeArraySortMethod, item.transactionEntries, []);
        item.intent = readApprovedRegularFile(join(transaction, 'intent.json'), transaction);
        options.onMetadataRead?.();
        metadataBytes += item.intent.bytes.length;
        if (metadataBytes > limits.metadataBytes) throw maintenanceRequired();
        item.outcome = readApprovedRegularFile(join(transaction, 'outcome.json'), transaction);
        options.onMetadataRead?.();
        metadataBytes += item.outcome.bytes.length;
        if (metadataBytes > limits.metadataBytes) throw maintenanceRequired();
        item.completeRecord = readApprovedRegularFile(join(transaction, 'complete'), transaction);
        options.onMetadataRead?.();
        metadataBytes += item.completeRecord.bytes.length;
        if (metadataBytes > limits.metadataBytes) throw maintenanceRequired();
        item.parsedIntent = parseRecord(item.intent.bytes);
        item.parsedOutcome = parseRecord(item.outcome.bytes);
        item.parsedComplete = parseRecord(item.completeRecord.bytes);
        if (!hasValidPortableMetadata(item)) throw recoveryRequired();
        aggregateEntries += item.parsedIntent.payloadEntries as number;
        aggregateBytes += item.parsedIntent.payloadBytes as number;
      } catch (error) {
        if (error instanceof RepertoireMaintenanceCapacityError) throw error;
        // Incomplete/corrupt metadata is classified without opening its payload.
      }
      safeReflectApply(safeArrayPushMethod, prepared, [item]);
    }
    if (aggregateEntries > limits.entries || aggregateBytes > limits.bytes) {
      throw maintenanceRequired();
    }
    const actualBudget = { entries: 0, bytes: 0 };
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index]!;
      let complete = false;
      try {
        if (!hasValidPortableMetadata(item)) throw recoveryRequired();
        const parsedIntent = item.parsedIntent!;
        const parsedOutcome = item.parsedOutcome!;
        const kind = parsedIntent.kind;
        const expectedEntries = typeof kind === 'string'
          ? ['complete', 'intent.json', kind, 'outcome.json']
          : [];
        safeReflectApply(safeArraySortMethod, expectedEntries, []);
        options.onPayloadOpen?.();
        const payloadSummary = kind === 'payload' || kind === 'partial'
          ? capturePortableTreeSummary(join(item.transaction, kind), {
            aggregate: actualBudget,
            limits,
            onDirectoryEntryRead: options.onDirectoryEntryRead,
            onDirectoryClose: options.onDirectoryClose,
          })
          : undefined;
        complete = sameEntries(item.transactionEntries!, expectedEntries)
          && payloadSummary !== undefined
          && payloadSummary.digest === parsedOutcome.actualPortableDigest
          && payloadSummary.entries === parsedOutcome.payloadEntries
          && payloadSummary.bytes === parsedOutcome.payloadBytes;
      } catch (error) {
        if (error instanceof RepertoireMaintenanceCapacityError) throw error;
        complete = false;
      }
      safeReflectApply(safeArrayPushMethod, complete ? result.complete : result.incomplete, [item.transaction]);
    }
    return result;
  } catch (error) {
    if (
      error instanceof RepertoireMaintenanceError
      || error instanceof RepertoireMaintenanceCapacityError
    ) throw error;
    throw recoveryRequired();
  }
}

/**
 * Atomically removes a package from the active namespace without deleting it.
 * The durable intent exists before rename, so a restart can distinguish every
 * incomplete phase without guessing ownership from a pathname.
 */
export function detachToMaintenance(options: DetachToMaintenanceOptions): string {
  try {
    const classification = classifyMaintenanceTransactions(options.globalConfigDir, {
      ...(options.maintenanceLimits === undefined ? {} : { limits: options.maintenanceLimits }),
    });
    if (classification.incomplete.length !== 0) throw recoveryRequired();
    const transactionsRoot = transactionRoot(options.globalConfigDir);
    createAndSyncHierarchy(options.globalConfigDir, transactionsRoot, options);
    const nonce = safeReflectApply(
      safeBufferToStringMethod,
      randomBytes(32),
      ['hex'],
    ) as string;
    const transactionDir = join(transactionsRoot, nonce);
    options.beforeFilesystemOperation?.('transaction-mkdir');
    mkdirSync(transactionDir, { mode: PRIVATE_DIRECTORY_MODE });
    syncDirectory(transactionDir);
    options.beforeFilesystemOperation?.('transaction-parent-fsync');
    syncDirectory(transactionsRoot);
    options.onPhase?.('transaction-created');
    const destination = join(transactionDir, options.kind);
    const source = relative(options.globalConfigDir, options.sourceDir);
    if (
      source === '' || isAbsolute(source) || source === '..'
      || safeReflectApply(safeStringStartsWithMethod, source, ['../'])
    ) {
      throw recoveryRequired();
    }
    const portableBefore = capturePortableTreeSummary(options.sourceDir);
    const intent = safeBufferFrom(safeJsonStringify({
      version: 1,
      kind: options.kind,
      source,
      expectedPortableDigest: portableBefore.digest,
      payloadEntries: portableBefore.entries,
      payloadBytes: portableBefore.bytes,
      nonce,
    }));
    options.beforeFilesystemOperation?.('intent-write');
    writeFileSync(join(transactionDir, 'intent.json'), intent, {
      flag: 'wx', mode: PRIVATE_FILE_MODE,
    });
    options.onPhase?.('intent-written');
    options.beforeFilesystemOperation?.('intent-file-fsync');
    syncFile(join(transactionDir, 'intent.json'));
    options.beforeFilesystemOperation?.('intent-parent-fsync');
    syncDirectory(transactionDir);
    options.onPhase?.('intent-durable');

    if (!sameTreeProof(
      options.expected,
      captureDirectoryTreeProof(options.sourceDir, options.containmentRoot),
    )) throw recoveryRequired();

    options.onPhase?.('before-rename');
    options.beforeFilesystemOperation?.('rename');
    renameSync(options.sourceDir, destination);
    options.onPhase?.('after-rename');
    options.beforeFilesystemOperation?.('source-parent-fsync');
    syncDirectory(dirname(options.sourceDir));
    options.beforeFilesystemOperation?.('destination-parent-fsync');
    syncDirectory(transactionDir);
    syncDirectory(transactionsRoot);
    options.onPhase?.('rename-durable');
    options.beforeFilesystemOperation?.('payload-proof');
    const actual = captureDirectoryTreeProof(destination, options.globalConfigDir);
    if (!sameTreeProof(options.expected, actual, true)) throw recoveryRequired();
    const portableAfter = capturePortableTreeSummary(destination);
    if (!samePortableSummary(portableBefore, portableAfter)) throw recoveryRequired();
    options.onPhase?.('proof-complete');

    const outcome = safeBufferFrom(safeJsonStringify({
      version: 1,
      phase: 'detached',
      intentDigest: digestBytes(intent),
      actualPortableDigest: portableAfter.digest,
      payloadEntries: portableAfter.entries,
      payloadBytes: portableAfter.bytes,
    }));
    options.beforeFilesystemOperation?.('outcome-write');
    writeFileSync(join(transactionDir, 'outcome.json'), outcome, {
      flag: 'wx', mode: PRIVATE_FILE_MODE,
    });
    options.onPhase?.('outcome-written');
    options.beforeFilesystemOperation?.('outcome-file-fsync');
    syncFile(join(transactionDir, 'outcome.json'));
    syncDirectory(transactionDir);
    options.onPhase?.('outcome-durable');
    const complete = safeBufferFrom(safeJsonStringify({
      version: 1,
      phase: 'complete',
      intentDigest: digestBytes(intent),
      actualPortableDigest: portableAfter.digest,
      outcomeDigest: digestBytes(outcome),
    }));
    const pendingComplete = join(transactionDir, 'complete.pending');
    options.beforeFilesystemOperation?.('complete-write');
    writeFileSync(pendingComplete, complete, {
      flag: 'wx', mode: PRIVATE_FILE_MODE,
    });
    options.onPhase?.('complete-written');
    options.beforeFilesystemOperation?.('complete-file-fsync');
    syncFile(pendingComplete);
    options.onPhase?.('complete-pending-durable');
    options.beforeFilesystemOperation?.('complete-pending-rename');
    renameSync(pendingComplete, join(transactionDir, 'complete'));
    options.onPhase?.('complete-renamed');
    options.beforeFilesystemOperation?.('complete-parent-fsync');
    syncDirectory(transactionDir);
    syncDirectory(transactionsRoot);
    options.onPhase?.('complete-durable');
    return transactionDir;
  } catch (error) {
    if (
      error instanceof RepertoireMaintenanceError
      || error instanceof RepertoireMaintenanceCapacityError
    ) throw error;
    throw recoveryRequired();
  }
}

function createAndSyncHierarchy(
  globalConfigDir: string,
  transactionsRoot: string,
  options: DetachToMaintenanceOptions,
): void {
  const maintenanceRoot = join(globalConfigDir, '.repertoire-maintenance');
  options.beforeFilesystemOperation?.('maintenance-root-mkdir');
  mkdirSync(maintenanceRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  options.onPhase?.('maintenance-root-created');
  options.beforeFilesystemOperation?.('maintenance-root-fsync');
  syncDirectory(globalConfigDir);
  syncDirectory(maintenanceRoot);
  options.onPhase?.('maintenance-root-durable');
  options.beforeFilesystemOperation?.('transactions-root-mkdir');
  mkdirSync(transactionsRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  options.onPhase?.('transactions-root-created');
  options.beforeFilesystemOperation?.('transactions-root-fsync');
  syncDirectory(maintenanceRoot);
  syncDirectory(transactionsRoot);
  options.onPhase?.('transactions-root-durable');
}

function syncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function transactionRoot(globalConfigDir: string): string {
  return join(globalConfigDir, '.repertoire-maintenance', 'transactions');
}

function hasValidPortableMetadata(item: PreparedTransaction): boolean {
  const intent = item.parsedIntent;
  const outcome = item.parsedOutcome;
  const complete = item.parsedComplete;
  if (
    intent === undefined || outcome === undefined || complete === undefined
    || item.intent === undefined || item.outcome === undefined
  ) return false;
  const payloadEntries = intent.payloadEntries;
  const payloadBytes = intent.payloadBytes;
  return intent.version === 1
    && intent.nonce === basename(item.transaction)
    && (intent.kind === 'payload' || intent.kind === 'partial')
    && typeof intent.expectedPortableDigest === 'string'
    && safeNumberIsSafeInteger(payloadEntries)
    && (payloadEntries as number) >= 0
    && (payloadEntries as number) <= 4_096
    && safeNumberIsSafeInteger(payloadBytes)
    && (payloadBytes as number) >= 0
    && (payloadBytes as number) <= 64 * 1024 * 1024
    && outcome.version === 1
    && outcome.phase === 'detached'
    && outcome.intentDigest === digestBytes(item.intent.bytes)
    && outcome.actualPortableDigest === intent.expectedPortableDigest
    && outcome.payloadEntries === payloadEntries
    && outcome.payloadBytes === payloadBytes
    && complete.version === 1
    && complete.phase === 'complete'
    && complete.intentDigest === outcome.intentDigest
    && complete.actualPortableDigest === outcome.actualPortableDigest
    && complete.outcomeDigest === digestBytes(item.outcome.bytes);
}

function sameEntries(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function capturePortableTreeSummary(
  root: string,
  aggregateOptions?: {
    aggregate: { entries: number; bytes: number };
    limits: { entries: number; bytes: number };
    onDirectoryEntryRead?: () => void;
    onDirectoryClose?: () => void;
  },
): PortableTreeSummary {
  const remaining = aggregateOptions === undefined ? undefined : {
    entries: aggregateOptions.limits.entries - aggregateOptions.aggregate.entries,
    bytes: aggregateOptions.limits.bytes - aggregateOptions.aggregate.bytes,
  };
  const first = capturePortableTreeSummaryOnce(
    root,
    remaining,
    aggregateOptions?.onDirectoryEntryRead,
    aggregateOptions?.onDirectoryClose,
  );
  const second = capturePortableTreeSummaryOnce(
    root,
    remaining,
    aggregateOptions?.onDirectoryEntryRead,
    aggregateOptions?.onDirectoryClose,
  );
  if (!samePortableSummary(first, second)) throw recoveryRequired();
  if (aggregateOptions !== undefined) {
    aggregateOptions.aggregate.entries += second.entries;
    aggregateOptions.aggregate.bytes += second.bytes;
    if (
      aggregateOptions.aggregate.entries > aggregateOptions.limits.entries
      || aggregateOptions.aggregate.bytes > aggregateOptions.limits.bytes
    ) throw maintenanceRequired();
  }
  return second;
}

function capturePortableTreeSummaryOnce(
  root: string,
  capacity?: { entries: number; bytes: number },
  onDirectoryEntryRead?: () => void,
  onDirectoryClose?: () => void,
): PortableTreeSummary {
  const records: string[] = ['d:.'];
  const budget = { entries: 0, bytes: 0 };
  visitPortableTree(
    root,
    root,
    records,
    budget,
    0,
    capacity,
    onDirectoryEntryRead,
    onDirectoryClose,
  );
  return {
    digest: createHash('sha256').update(
      safeReflectApply(safeArrayJoinMethod, records, ['\0']) as string,
    ).digest('hex'),
    entries: budget.entries,
    bytes: budget.bytes,
  };
}

function visitPortableTree(
  root: string,
  directory: string,
  records: string[],
  budget: { entries: number; bytes: number },
  depth: number,
  capacity?: { entries: number; bytes: number },
  onDirectoryEntryRead?: () => void,
  onDirectoryClose?: () => void,
): void {
  if (depth > 32) throw recoveryRequired();
  const treeRemaining = 4_096 - budget.entries;
  const capacityRemaining = capacity?.entries ?? treeRemaining;
  const remaining = safeMathMin(treeRemaining, capacityRemaining);
  const overflow = capacity !== undefined && capacityRemaining <= treeRemaining
    ? maintenanceRequired
    : recoveryRequired;
  const before = readDirectoryBounded(
    directory,
    remaining,
    onDirectoryEntryRead,
    onDirectoryClose,
    overflow,
  );
  safeReflectApply(safeArraySortMethod, before, []);
  for (let index = 0; index < before.length; index += 1) {
    budget.entries += 1;
    if (capacity !== undefined && budget.entries > capacity.entries) throw maintenanceRequired();
    if (budget.entries > 4_096) throw recoveryRequired();
    const path = join(directory, before[index]!);
    const stat = lstatSync(path);
    if (isSymbolicLink(stat)) throw recoveryRequired();
    const relativePath = relative(root, path);
    if (isDirectory(stat)) {
      safeReflectApply(safeArrayPushMethod, records, [`d:${relativePath}`]);
      visitPortableTree(
        root,
        path,
        records,
        budget,
        depth + 1,
        capacity,
        onDirectoryEntryRead,
        onDirectoryClose,
      );
      continue;
    }
    const approved = readApprovedRegularFile(path, root);
    budget.bytes += approved.bytes.length;
    if (capacity !== undefined && budget.bytes > capacity.bytes) throw maintenanceRequired();
    if (budget.bytes > 64 * 1024 * 1024) throw recoveryRequired();
    safeReflectApply(safeArrayPushMethod, records, [
      `f:${relativePath}:${approved.bytes.length}:${approved.proof.digest}`,
    ]);
  }
  const after = readDirectoryBounded(
    directory,
    before.length,
    onDirectoryEntryRead,
    onDirectoryClose,
    overflow,
  );
  safeReflectApply(safeArraySortMethod, after, []);
  if (!sameEntries(before, after)) throw recoveryRequired();
}

function samePortableSummary(left: PortableTreeSummary, right: PortableTreeSummary): boolean {
  return left.digest === right.digest && left.entries === right.entries && left.bytes === right.bytes;
}

function readDirectoryBounded(
  path: string,
  maximumEntries: number,
  onEntryRead: (() => void) | undefined,
  onClose: (() => void) | undefined,
  overflow: () => Error,
): string[] {
  let directory: Dir | undefined;
  const entries: string[] = [];
  let primaryFailure: { error: unknown } | undefined;
  let closeFailure: { error: unknown } | undefined;
  try {
    directory = safeOpenDirectorySync(path);
    while (true) {
      const entry = safeReflectApply(safeDirReadSyncMethod, directory, []);
      if (entry === null) break;
      onEntryRead?.();
      safeReflectApply(safeArrayPushMethod, entries, [entry.name]);
      if (entries.length > maximumEntries) throw overflow();
    }
  } catch (error) {
    primaryFailure = { error };
  } finally {
    if (directory !== undefined) {
      try {
        safeReflectApply(safeDirCloseSyncMethod, directory, []);
        onClose?.();
      } catch (error) {
        closeFailure = { error };
      }
    }
  }
  // A cleanup fault must never replace the classification that caused cleanup.
  if (primaryFailure !== undefined) throw primaryFailure.error;
  if (closeFailure !== undefined) throw closeFailure.error;
  return entries;
}

function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseRecord(bytes: Buffer): Record<string, unknown> {
  const value: unknown = safeJsonParse(safeReflectApply(
    safeBufferToStringMethod,
    bytes,
    ['utf8'],
  ) as string);
  if (typeof value !== 'object' || value === null || safeArrayIsArray(value)) throw recoveryRequired();
  return value as Record<string, unknown>;
}

function isDirectory(stat: ReturnType<typeof lstatSync>): boolean {
  return safeReflectApply(safeStatsIsDirectoryMethod, stat, []) as boolean;
}

function isSymbolicLink(stat: ReturnType<typeof lstatSync>): boolean {
  return safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, []) as boolean;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT';
}

function recoveryRequired(): RepertoireMaintenanceError {
  return new RepertoireMaintenanceError();
}

function maintenanceRequired(): RepertoireMaintenanceCapacityError {
  return new RepertoireMaintenanceCapacityError();
}
