import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export type BoundedFileReadResult =
  | { status: 'complete'; content: Buffer }
  | { status: 'overflow'; reasonCode: 'FILE_READ_OVERFLOW' };

export function areProjectTemplateFileStatsEqual(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mode === after.mode
    && before.nlink === after.nlink
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

/**
 * Reads at most the inspected size plus one byte. The sentinel byte detects
 * growth without allowing a concurrent writer to make memory usage unbounded.
 */
export async function readBoundedProjectTemplateFile(
  handle: Pick<FileHandle, 'read'>,
  inspectedBytes: number,
): Promise<BoundedFileReadResult> {
  const buffer = Buffer.alloc(inspectedBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > inspectedBytes) {
    return { status: 'overflow', reasonCode: 'FILE_READ_OVERFLOW' };
  }
  return { status: 'complete', content: buffer.subarray(0, offset) };
}
