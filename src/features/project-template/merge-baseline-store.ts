import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  ProjectTemplateApplyStorageError,
  type ProjectTemplateApplyStorage,
} from './apply-storage.js';

export const MAX_PROJECT_TEMPLATE_MERGE_BASELINE_BYTES = 256 * 1024;

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

async function readAndVerifyBaseline(options: {
  storage: ProjectTemplateApplyStorage;
  expectedSha256: string;
  maxBytes: number;
}): Promise<Buffer> {
  const path = baselinePath(options.storage, options.expectedSha256);
  const content = await options.storage.io.readPrivateFile(
    path,
    options.maxBytes,
    options.storage.device,
  );
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
  try {
    await options.storage.io.writeExclusive(path, content, 0o600);
  } catch (error) {
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
  await options.storage.io.chmod(path, 0o600);
  await options.storage.io.fsyncFile(path);
  await options.storage.io.fsyncDirectory(options.storage.baselinesRoot);
  return 'stored';
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
