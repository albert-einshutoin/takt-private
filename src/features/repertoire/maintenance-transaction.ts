import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  captureDirectoryTreeProof,
  sameTreeProof,
  type TreeProof,
} from './filesystem-proof.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeBufferToStringMethod = Buffer.prototype.toString;

export class RepertoireMaintenanceError extends Error {
  readonly code = 'RECOVERY_REQUIRED' as const;

  constructor() {
    super('Repertoire package recovery is required');
    this.name = 'RepertoireMaintenanceError';
  }
}

export type MaintenancePayloadKind = 'payload' | 'partial';

export interface DetachToMaintenanceOptions {
  globalConfigDir: string;
  sourceDir: string;
  containmentRoot: string;
  expected: TreeProof;
  kind: MaintenancePayloadKind;
}

/**
 * Atomically removes a package from the active namespace without deleting it.
 * Retaining bytes is intentional: Node cannot recursively unlink a tree with a
 * directory-fd-relative CAS, so physical cleanup is a separate maintenance act.
 */
export function detachToMaintenance(options: DetachToMaintenanceOptions): string {
  try {
    const transactionsRoot = join(
      options.globalConfigDir,
      '.repertoire-maintenance',
      'transactions',
    );
    mkdirSync(transactionsRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const nonce = safeReflectApply(
      safeBufferToStringMethod,
      randomBytes(32),
      ['hex'],
    ) as string;
    const transactionDir = join(transactionsRoot, nonce);
    mkdirSync(transactionDir, { mode: PRIVATE_DIRECTORY_MODE });
    const destination = join(transactionDir, options.kind);

    if (!sameTreeProof(
      options.expected,
      captureDirectoryTreeProof(options.sourceDir, options.containmentRoot),
    )) throw recoveryRequired();

    renameSync(options.sourceDir, destination);
    if (!sameTreeProof(
      options.expected,
      captureDirectoryTreeProof(destination, options.globalConfigDir),
      true,
    )) throw recoveryRequired();

    // The witness is deliberately last: its presence means payload publication
    // and the complete post-rename proof both finished successfully.
    writeFileSync(join(transactionDir, 'complete'), `${options.kind}\n`, {
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    syncFile(join(transactionDir, 'complete'));
    syncDirectory(transactionDir);
    syncDirectory(transactionsRoot);
    return transactionDir;
  } catch (error) {
    if (error instanceof RepertoireMaintenanceError) throw error;
    throw recoveryRequired();
  }
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

function recoveryRequired(): RepertoireMaintenanceError {
  return new RepertoireMaintenanceError();
}
