import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pack as createTarPack, type Headers, type Pack } from 'tar-stream';
import { canonicalizeTaktpackJson } from './canonical-json.js';
import { TaktpackError } from './errors.js';
import {
  TAKTPACK_BLOB_PREFIX,
  type ProjectTemplateExportFile,
  type ProjectTemplateExportPlan,
  type WriteTaktpackOptions,
  type WriteTaktpackResult,
} from './archive-types.js';
import { areProjectTemplateFileStatsEqual } from './bounded-file-read.js';

const ARCHIVE_MODE = 0o644;
const ARCHIVE_EPOCH = new Date(0);

function regularHeader(name: string, size: number): Headers {
  return {
    name,
    size,
    type: 'file',
    mode: ARCHIVE_MODE,
    uid: 0,
    gid: 0,
    mtime: ARCHIVE_EPOCH,
  };
}

function addBufferEntry(archive: Pack, name: string, content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    archive.entry(regularHeader(name, content.byteLength), content, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function assertSnapshot(file: ProjectTemplateExportFile, stat: Awaited<ReturnType<typeof open>> extends never ? never : import('node:fs').Stats): void {
  const expected = file.snapshot;
  if (
    !stat.isFile()
    || stat.nlink !== 1
    || stat.dev !== expected.dev
    || stat.ino !== expected.ino
    || stat.size !== expected.size
    || stat.mode !== expected.mode
    || stat.mtimeMs !== expected.mtimeMs
    || stat.ctimeMs !== expected.ctimeMs
  ) {
    throw new TaktpackError('SOURCE_CHANGED', 'source identity changed after planning', file.path);
  }
}

async function addBlobEntry(
  archive: Pack,
  file: ProjectTemplateExportFile,
  signal: AbortSignal | undefined,
): Promise<void> {
  const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertSnapshot(file, before);
    const digest = createHash('sha256');
    const hashStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    const entry = archive.entry(regularHeader(`${TAKTPACK_BLOB_PREFIX}${file.sha256}`, file.bytes));
    await pipeline(
      createReadStream(file.absolutePath, { fd: handle.fd, autoClose: false }),
      hashStream,
      entry,
      ...(signal === undefined ? [] : [{ signal }]),
    );
    const after = await handle.stat();
    if (!areProjectTemplateFileStatsEqual(before, after)) {
      throw new TaktpackError('SOURCE_CHANGED', 'source changed while it was archived', file.path);
    }
    if (digest.digest('hex') !== file.sha256) {
      throw new TaktpackError('SOURCE_CHANGED', 'source content no longer matches its planned hash', file.path);
    }
  } finally {
    await handle.close();
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publishTempFile(tempPath: string, outputPath: string, force: boolean): void {
  if (force) {
    renameSync(tempPath, outputPath);
    return;
  }
  try {
    // A hard-link publish is the portable no-clobber primitive: unlike a
    // preflight exists check it remains safe if another writer wins the race.
    linkSync(tempPath, outputPath);
    unlinkSync(tempPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new TaktpackError('OUTPUT_EXISTS', `output already exists: ${outputPath}`, 'outputPath');
    }
    throw error;
  }
}

export async function writeTaktpack(
  outputPath: string,
  plan: ProjectTemplateExportPlan,
  options: WriteTaktpackOptions = {},
): Promise<WriteTaktpackResult> {
  const force = options.force === true;
  if (!force && existsSync(outputPath)) {
    throw new TaktpackError('OUTPUT_EXISTS', `output already exists: ${outputPath}`, 'outputPath');
  }
  options.signal?.throwIfAborted();
  const outputDirectory = dirname(outputPath);
  const tempPath = join(
    outputDirectory,
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const archiveHash = createHash('sha256');
  let bytes = 0;
  try {
    const output = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    const hashStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        archiveHash.update(chunk);
        callback(null, chunk);
      },
    });
    const archive = createTarPack();
    const outputPromise = pipeline(
      archive,
      hashStream,
      output,
      ...(options.signal === undefined ? [] : [{ signal: options.signal }]),
    );
    try {
      const packJson = canonicalizeTaktpackJson({ ...plan.descriptor, lock: plan.lock });
      await addBufferEntry(archive, 'pack.json', Buffer.from(packJson));
      await addBufferEntry(
        archive,
        'manifest.json',
        Buffer.from(canonicalizeTaktpackJson(plan.manifest)),
      );
      await addBufferEntry(
        archive,
        'export-report.json',
        Buffer.from(canonicalizeTaktpackJson(plan.report)),
      );
      const blobs = new Map(plan.files.map((file) => [file.sha256, file]));
      for (const hash of [...blobs.keys()].sort((left, right) => left.localeCompare(right, 'en-US'))) {
        await addBlobEntry(archive, blobs.get(hash)!, options.signal);
      }
      archive.finalize();
      await outputPromise;
    } catch (error) {
      archive.destroy(error instanceof Error ? error : new Error(String(error)));
      await outputPromise.catch(() => undefined);
      throw error;
    }
    const completedFd = openSync(tempPath, constants.O_RDONLY);
    try {
      fsyncSync(completedFd);
    } finally {
      closeSync(completedFd);
    }
    publishTempFile(tempPath, outputPath, force);
    fsyncDirectory(outputDirectory);
    return {
      outputPath,
      archiveSha256: archiveHash.digest('hex'),
      bytes,
    };
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}
