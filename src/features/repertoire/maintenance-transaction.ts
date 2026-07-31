import { createHash, randomBytes } from 'node:crypto';
import {
  Stats,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
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
const MAX_TRANSACTIONS = 4_096;
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeBufferToStringMethod = Buffer.prototype.toString;
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const safeArrayIsArray = Array.isArray.bind(Array);
const safeArraySortMethod = Array.prototype.sort;
const safeArrayPushMethod = Array.prototype.push;
const safeStringStartsWithMethod = String.prototype.startsWith;
const safeJsonParse = JSON.parse.bind(JSON);
const safeJsonStringify = JSON.stringify.bind(JSON);
const safeBufferFrom = Buffer.from.bind(Buffer);

export class RepertoireMaintenanceError extends Error {
  readonly code = 'RECOVERY_REQUIRED' as const;

  constructor() {
    super('Repertoire package recovery is required');
    this.name = 'RepertoireMaintenanceError';
  }
}

export type MaintenancePayloadKind = 'payload' | 'partial';
export type MaintenanceClassification = { complete: string[]; incomplete: string[] };

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
}

export type MaintenanceFilesystemOperation =
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
  | 'complete-file-fsync';

export type MaintenanceTransactionPhase =
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
  | 'complete-durable';

/** Fail closed at startup when a prior mutation did not publish its outcome. */
export function assertMaintenanceTransactionsReady(globalConfigDir: string): void {
  const classification = classifyMaintenanceTransactions(globalConfigDir);
  if (classification.incomplete.length !== 0) throw recoveryRequired();
}

export function classifyMaintenanceTransactions(
  globalConfigDir: string,
): MaintenanceClassification {
  try {
    const transactionsRoot = transactionRoot(globalConfigDir);
    let entries: string[];
    try {
      entries = readdirSync(transactionsRoot);
    } catch (error) {
      if (isMissing(error)) return { complete: [], incomplete: [] };
      throw error;
    }
    if (entries.length > MAX_TRANSACTIONS) throw recoveryRequired();
    safeReflectApply(safeArraySortMethod, entries, []);
    const result: MaintenanceClassification = { complete: [], incomplete: [] };
    for (let index = 0; index < entries.length; index += 1) {
      const transaction = join(transactionsRoot, entries[index]!);
      const stat = lstatSync(transaction);
      if (!isDirectory(stat) || isSymbolicLink(stat)) throw recoveryRequired();
      let complete = false;
      try {
        const transactionEntries = readdirSync(transaction);
        safeReflectApply(safeArraySortMethod, transactionEntries, []);
        const intent = readApprovedRegularFile(join(transaction, 'intent.json'), transaction);
        const outcome = readApprovedRegularFile(join(transaction, 'outcome.json'), transaction);
        const completeRecord = readApprovedRegularFile(join(transaction, 'complete'), transaction);
        const parsedIntent = parseRecord(intent.bytes);
        const parsedOutcome = parseRecord(outcome.bytes);
        const parsedComplete = parseRecord(completeRecord.bytes);
        const kind = parsedIntent.kind;
        const expectedEntries = typeof kind === 'string'
          ? ['complete', 'intent.json', kind, 'outcome.json']
          : [];
        safeReflectApply(safeArraySortMethod, expectedEntries, []);
        const payloadProof = kind === 'payload' || kind === 'partial'
          ? captureDirectoryTreeProof(join(transaction, kind), globalConfigDir)
          : undefined;
        complete = sameEntries(transactionEntries, expectedEntries)
          && parsedIntent.version === 1
          && parsedIntent.nonce === basename(transaction)
          && parsedOutcome.version === 1
          && parsedOutcome.phase === 'detached'
          && parsedOutcome.intentDigest === digestBytes(intent.bytes)
          && typeof parsedOutcome.actualProofDigest === 'string'
          && parsedComplete.version === 1
          && parsedComplete.phase === 'complete'
          && parsedComplete.intentDigest === parsedOutcome.intentDigest
          && parsedComplete.actualProofDigest === parsedOutcome.actualProofDigest
          && parsedComplete.outcomeDigest === digestBytes(outcome.bytes)
          && payloadProof !== undefined
          && digestTree(payloadProof) === parsedOutcome.actualProofDigest;
      } catch {
        complete = false;
      }
      safeReflectApply(safeArrayPushMethod, complete ? result.complete : result.incomplete, [transaction]);
    }
    return result;
  } catch (error) {
    if (error instanceof RepertoireMaintenanceError) throw error;
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
    assertMaintenanceTransactionsReady(options.globalConfigDir);
    const transactionsRoot = transactionRoot(options.globalConfigDir);
    createAndSyncHierarchy(options.globalConfigDir, transactionsRoot);
    const nonce = safeReflectApply(
      safeBufferToStringMethod,
      randomBytes(32),
      ['hex'],
    ) as string;
    const transactionDir = join(transactionsRoot, nonce);
    mkdirSync(transactionDir, { mode: PRIVATE_DIRECTORY_MODE });
    syncDirectory(transactionDir);
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
    const intent = safeBufferFrom(safeJsonStringify({
      version: 1,
      kind: options.kind,
      source,
      expectedTreeDigest: digestTree(options.expected),
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
    options.onPhase?.('proof-complete');

    const outcome = safeBufferFrom(safeJsonStringify({
      version: 1,
      phase: 'detached',
      intentDigest: digestBytes(intent),
      actualProofDigest: digestTree(actual),
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
      actualProofDigest: digestTree(actual),
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
    renameSync(pendingComplete, join(transactionDir, 'complete'));
    syncDirectory(transactionDir);
    syncDirectory(transactionsRoot);
    options.onPhase?.('complete-durable');
    return transactionDir;
  } catch (error) {
    if (error instanceof RepertoireMaintenanceError) throw error;
    throw recoveryRequired();
  }
}

function createAndSyncHierarchy(globalConfigDir: string, transactionsRoot: string): void {
  const maintenanceRoot = join(globalConfigDir, '.repertoire-maintenance');
  mkdirSync(maintenanceRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  syncDirectory(globalConfigDir);
  syncDirectory(maintenanceRoot);
  mkdirSync(transactionsRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  syncDirectory(maintenanceRoot);
  syncDirectory(transactionsRoot);
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

function sameEntries(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function digestTree(proof: TreeProof): string {
  return createHash('sha256').update(safeJsonStringify({
    dev: proof.dev,
    ino: proof.ino,
    mode: proof.mode,
    realpath: proof.realpath,
    contentFingerprint: proof.contentFingerprint,
    stableIdentity: proof.stableIdentity,
  })).digest('hex');
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
