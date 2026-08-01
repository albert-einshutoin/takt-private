import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  isProjectTemplatePrivateDirectoryMode,
} from './control-root-contract.js';
import {
  ProjectTemplateApplyStorageError,
  type ProjectTemplateApplyStorage,
} from './apply-storage.js';
import {
  MAX_PROJECT_TEMPLATE_MERGE_BASELINE_BYTES,
} from './transaction-limits.js';

// Every semantic-config blob accepted by archive inspection and apply planning
// must fit in the immutable baseline store. Sharing the canonical blob limit
// prevents a plan from succeeding for content that execution can never retain.
export { MAX_PROJECT_TEMPLATE_MERGE_BASELINE_BYTES } from './transaction-limits.js';
const MAX_BASELINE_DIRECTORY_ENTRIES = 8_192;

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertBaselineHash(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new ProjectTemplateApplyStorageError(
      'HASH_MISMATCH',
      'project template merge baseline digest is invalid',
    );
  }
  return value;
}

function assertBaselineSize(content: Uint8Array, maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes < 0
    || content.byteLength > maxBytes
  ) {
    throw new ProjectTemplateApplyStorageError(
      'LIMIT_EXCEEDED',
      'project template merge baseline exceeds the size limit',
    );
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function baselinePath(
  storage: ProjectTemplateApplyStorage,
  expectedSha256: string,
): string {
  return join(storage.baselinesRoot, assertBaselineHash(expectedSha256));
}

async function assertBaselineRootIdentity(
  storage: ProjectTemplateApplyStorage,
): Promise<void> {
  const [resolved, entry] = await Promise.all([
    storage.io.realpath(storage.baselinesRoot),
    storage.io.lstat(storage.baselinesRoot),
  ]);
  if (
    resolved !== storage.baselinesRoot
    || entry.isSymbolicLink()
    || !entry.isDirectory()
    || entry.dev !== storage.baselinesDevice
    || entry.ino !== storage.baselinesInode
    || !isProjectTemplatePrivateDirectoryMode(entry.mode, storage.platform)
  ) {
    throw new ProjectTemplateApplyStorageError(
      'UNSAFE_CONTROL_ROOT',
      'project template merge baseline root changed identity',
    );
  }
}

function baselineTempNamePattern(expectedSha256: string): RegExp {
  return new RegExp(
    `^\\.${expectedSha256}\\.[0-9]+\\.[0-9a-f-]{36}\\.tmp$`,
  );
}

async function removeIfPresent(
  storage: ProjectTemplateApplyStorage,
  path: string,
): Promise<void> {
  try {
    await storage.io.unlink(path);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

async function cleanupPreparedBaselines(
  storage: ProjectTemplateApplyStorage,
  expectedSha256: string,
): Promise<void> {
  await assertBaselineRootIdentity(storage);
  const pattern = baselineTempNamePattern(expectedSha256);
  const entries = await storage.io.readdir(
    storage.baselinesRoot,
    MAX_BASELINE_DIRECTORY_ENTRIES,
  );
  for (const entry of entries) {
    if (!pattern.test(entry.name)) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new ProjectTemplateApplyStorageError(
        'UNSAFE_CONTROL_ROOT',
        'project template prepared merge baseline is unsafe',
      );
    }
    // Names are generated from a validated digest plus fixed-format process and
    // UUID components, so cleanup cannot escape the baseline directory.
    await removeIfPresent(storage, join(storage.baselinesRoot, entry.name));
  }
  await assertBaselineRootIdentity(storage);
}

async function readAndVerifyBaseline(options: {
  storage: ProjectTemplateApplyStorage;
  expectedSha256: string;
  maxBytes: number;
}): Promise<Buffer> {
  await assertBaselineRootIdentity(options.storage);
  const path = baselinePath(options.storage, options.expectedSha256);
  const content = await options.storage.io.readPrivateFile(
    path,
    options.maxBytes,
    options.storage.baselinesDevice,
  );
  await assertBaselineRootIdentity(options.storage);
  if (sha256(content) !== options.expectedSha256) {
    throw new ProjectTemplateApplyStorageError(
      'HASH_MISMATCH',
      'project template merge baseline content changed',
    );
  }
  return content;
}

export async function writeProjectTemplateMergeBaseline(options: {
  storage: ProjectTemplateApplyStorage;
  expectedSha256: string;
  content: Uint8Array;
  maxBytes?: number;
}): Promise<'stored' | 'reused'> {
  const maxBytes = options.maxBytes
    ?? MAX_PROJECT_TEMPLATE_MERGE_BASELINE_BYTES;
  const content = Buffer.from(options.content);
  assertBaselineSize(content, maxBytes);
  if (sha256(content) !== assertBaselineHash(options.expectedSha256)) {
    throw new ProjectTemplateApplyStorageError(
      'HASH_MISMATCH',
      'project template merge baseline does not match the expected digest',
    );
  }
  const path = baselinePath(options.storage, options.expectedSha256);
  await cleanupPreparedBaselines(options.storage, options.expectedSha256);
  try {
    const existing = await readAndVerifyBaseline({
      storage: options.storage,
      expectedSha256: options.expectedSha256,
      maxBytes,
    });
    if (!existing.equals(content)) {
      throw new ProjectTemplateApplyStorageError(
        'HASH_MISMATCH',
        'project template merge baseline is not immutable',
      );
    }
    await options.storage.io.fsyncFile(path);
    await options.storage.io.fsyncDirectory(options.storage.baselinesRoot);
    return 'reused';
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }

  const tempPath = join(
    options.storage.baselinesRoot,
    `.${options.expectedSha256}.${process.pid}.${randomUUID()}.tmp`,
  );
  let prepared = false;
  try {
    await options.storage.io.writePreparedExclusive(
      tempPath,
      content,
      0o600,
      options.storage.baselinesDevice,
    );
    prepared = true;
    await assertBaselineRootIdentity(options.storage);
    // Hard-link publication is an atomic no-overwrite operation: a competing
    // writer can win, but an existing immutable baseline is never replaced.
    await options.storage.io.link(tempPath, path);
  } catch (error) {
    await removeIfPresent(options.storage, tempPath);
    if (!hasCode(error, 'EEXIST')) throw error;
    const existing = await readAndVerifyBaseline({
      storage: options.storage,
      expectedSha256: options.expectedSha256,
      maxBytes,
    });
    if (!existing.equals(content)) {
      throw new ProjectTemplateApplyStorageError(
        'HASH_MISMATCH',
        'project template merge baseline is not immutable',
      );
    }
    // Re-syncing repairs the durability boundary if a previous writer stopped
    // after publishing the immutable file but before syncing either boundary.
    await options.storage.io.fsyncFile(path);
    await options.storage.io.fsyncDirectory(options.storage.baselinesRoot);
    return 'reused';
  }
  try {
    await assertBaselineRootIdentity(options.storage);
    await removeIfPresent(options.storage, tempPath);
    prepared = false;
    await options.storage.io.fsyncDirectory(options.storage.baselinesRoot);
    return 'stored';
  } catch (error) {
    if (prepared) {
      try {
        await removeIfPresent(options.storage, tempPath);
      } catch {
        // The published immutable inode remains recoverable. A later retry
        // performs bounded cleanup and re-establishes directory durability.
      }
    }
    throw error;
  }
}

export async function readProjectTemplateMergeBaseline(options: {
  storage: ProjectTemplateApplyStorage;
  expectedSha256: string;
  maxBytes?: number;
}): Promise<Buffer> {
  return await readAndVerifyBaseline({
    storage: options.storage,
    expectedSha256: assertBaselineHash(options.expectedSha256),
    maxBytes: options.maxBytes ?? MAX_PROJECT_TEMPLATE_MERGE_BASELINE_BYTES,
  });
}
