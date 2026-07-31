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
import { dirname, isAbsolute, join, relative } from 'node:path';
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
}

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
    entries.sort();
    const result: MaintenanceClassification = { complete: [], incomplete: [] };
    for (let index = 0; index < entries.length; index += 1) {
      const transaction = join(transactionsRoot, entries[index]!);
      const stat = lstatSync(transaction);
      if (!isDirectory(stat) || isSymbolicLink(stat)) throw recoveryRequired();
      let complete = false;
      try {
        const intent = readApprovedRegularFile(join(transaction, 'intent.json'), transaction);
        const outcome = readApprovedRegularFile(join(transaction, 'complete'), transaction);
        const parsedIntent = parseRecord(intent.bytes);
        const parsedOutcome = parseRecord(outcome.bytes);
        complete = parsedIntent.version === 1
          && parsedOutcome.version === 1
          && parsedOutcome.phase === 'complete'
          && parsedOutcome.intentDigest === digestBytes(intent.bytes)
          && typeof parsedOutcome.actualProofDigest === 'string';
      } catch {
        complete = false;
      }
      (complete ? result.complete : result.incomplete).push(transaction);
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
    const destination = join(transactionDir, options.kind);
    const source = relative(options.globalConfigDir, options.sourceDir);
    if (source === '' || isAbsolute(source) || source === '..' || source.startsWith('../')) {
      throw recoveryRequired();
    }
    const intent = Buffer.from(JSON.stringify({
      version: 1,
      kind: options.kind,
      source,
      expectedTreeDigest: digestTree(options.expected),
      nonce,
    }));
    writeDurableExclusive(join(transactionDir, 'intent.json'), intent);
    syncDirectory(transactionDir);

    if (!sameTreeProof(
      options.expected,
      captureDirectoryTreeProof(options.sourceDir, options.containmentRoot),
    )) throw recoveryRequired();

    renameSync(options.sourceDir, destination);
    syncDirectory(dirname(options.sourceDir));
    syncDirectory(transactionDir);
    syncDirectory(transactionsRoot);
    const actual = captureDirectoryTreeProof(destination, options.globalConfigDir);
    if (!sameTreeProof(options.expected, actual, true)) throw recoveryRequired();

    const outcome = Buffer.from(JSON.stringify({
      version: 1,
      phase: 'complete',
      intentDigest: digestBytes(intent),
      actualProofDigest: digestTree(actual),
    }));
    writeDurableExclusive(join(transactionDir, 'complete'), outcome);
    syncDirectory(transactionDir);
    syncDirectory(transactionsRoot);
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

function writeDurableExclusive(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes, { flag: 'wx', mode: PRIVATE_FILE_MODE });
  syncFile(path);
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

function digestTree(proof: TreeProof): string {
  return createHash('sha256').update(JSON.stringify({
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
  const value: unknown = JSON.parse(safeReflectApply(
    safeBufferToStringMethod,
    bytes,
    ['utf8'],
  ) as string);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw recoveryRequired();
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
