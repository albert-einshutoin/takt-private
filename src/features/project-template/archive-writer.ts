import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pack as createTarPack, type Headers, type Pack } from 'tar-stream';
import { canonicalizeTaktpackJson } from './canonical-json.js';
import { TaktpackError } from './errors.js';
import {
  calculateProjectTemplateManifestSha256,
  validateManifestLockPair,
} from './binding.js';
import { getProjectTemplateExportSourceState } from './export-plan.js';
import {
  TAKTPACK_BLOB_PREFIX,
  type ProjectTemplateExportFile,
  type ProjectTemplateExportPlan,
  type WriteTaktpackOptions,
  type WriteTaktpackResult,
} from './archive-types.js';
import { areProjectTemplateFileStatsEqual } from './bounded-file-read.js';
import {
  maxBytesForTaktpackEntry,
  resolveTaktpackLimits,
} from './archive-limits.js';

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

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
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

function publishTempFile(
  tempPath: string,
  outputPath: string,
  force: boolean,
  expectedTarget: import('node:fs').Stats | undefined,
): void {
  if (force) {
    if (expectedTarget !== undefined) {
      let current: import('node:fs').Stats;
      try {
        current = lstatSync(outputPath);
      } catch {
        throw new TaktpackError('UNSAFE_OUTPUT_TARGET', 'output target changed before publish', 'outputPath');
      }
      if (!areProjectTemplateFileStatsEqual(expectedTarget, current)) {
        throw new TaktpackError('UNSAFE_OUTPUT_TARGET', 'output target changed before publish', 'outputPath');
      }
    } else if (existsSync(outputPath)) {
      throw new TaktpackError('UNSAFE_OUTPUT_TARGET', 'output target appeared before publish', 'outputPath');
    }
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
      throw new TaktpackError('OUTPUT_EXISTS', 'output already exists', 'outputPath');
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
  const limits = resolveTaktpackLimits(options.limits);
  validateManifestLockPair(plan.manifest, plan.lock);
  let expectedTarget: import('node:fs').Stats | undefined;
  if (existsSync(outputPath)) {
    expectedTarget = lstatSync(outputPath);
  }
  if (!force && existsSync(outputPath)) {
    throw new TaktpackError('OUTPUT_EXISTS', 'output already exists', 'outputPath');
  }
  if (force && expectedTarget !== undefined && (!expectedTarget.isFile() || expectedTarget.nlink !== 1)) {
    throw new TaktpackError('UNSAFE_OUTPUT_TARGET', 'output target must be a regular single-link file', 'outputPath');
  }
  options.signal?.throwIfAborted();
  const sourceState = getProjectTemplateExportSourceState(plan);
  if (sourceState === undefined) {
    throw new TaktpackError('INVALID_EXPORT_PLAN', 'export plan has no bound source state', 'plan');
  }
  const rootStat = await lstat(sourceState.rootRealPath);
  const expectedRoot = sourceState.rootSnapshot;
  if (
    !rootStat.isDirectory()
    || rootStat.dev !== expectedRoot.dev
    || rootStat.ino !== expectedRoot.ino
  ) {
    throw new TaktpackError('SOURCE_CHANGED', 'project template root changed after planning', 'projectRoot');
  }
  const outputDirectory = dirname(outputPath);
  const tempPath = join(
    outputDirectory,
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const archiveHash = createHash('sha256');
  let bytes = 0;
  try {
    const manifestContent = Buffer.from(canonicalizeTaktpackJson(plan.manifest));
    const reportContent = Buffer.from(canonicalizeTaktpackJson(plan.report));
    const blobs = new Map(sourceState.files.map((file) => [file.sha256, file]));
    const lockSeed = {
        schemaVersion: plan.lock.schemaVersion,
        packVersion: plan.lock.packVersion,
        source: plan.lock.source,
        capabilities: plan.lock.capabilities,
        entries: plan.lock.entries,
      };
    const packContent = Buffer.from(canonicalizeTaktpackJson({
        ...plan.descriptor,
        manifestSha256: calculateProjectTemplateManifestSha256(plan.manifest),
        exportReportSha256: createHash('sha256').update(reportContent).digest('hex'),
        lockSeed,
        blobs: [...blobs.entries()]
          .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
          .map(([sha256, file]) => ({ sha256, bytes: file.bytes })),
      }));
    const controlEntries = [
      ['pack', packContent],
      ['manifest', manifestContent],
      ['report', reportContent],
    ] as const;
    for (const [kind, content] of controlEntries) {
      if (content.byteLength > maxBytesForTaktpackEntry(kind, limits)) {
        throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', `${kind} entry exceeds size limit`, kind);
      }
    }
    if (sourceState.files.some((file) => file.bytes > limits.maxBlobBytes)) {
      throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'blob entry exceeds size limit', 'blob');
    }
    const totalPayloadBytes = controlEntries.reduce((sum, [, content]) => sum + content.byteLength, 0)
      + [...blobs.values()].reduce((sum, file) => sum + file.bytes, 0);
    if (controlEntries.length + blobs.size > limits.maxEntries
      || totalPayloadBytes > limits.maxTotalBytes) {
      throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive envelope exceeds safety limits');
    }

    const output = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    const hashStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        if (bytes > limits.maxArchiveBytes) {
          callback(new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive exceeds size limit'));
          return;
        }
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
      await addBufferEntry(archive, 'pack.json', packContent);
      await addBufferEntry(archive, 'manifest.json', manifestContent);
      await addBufferEntry(archive, 'export-report.json', reportContent);
      for (const hash of [...blobs.keys()].sort((left, right) => left.localeCompare(right, 'en-US'))) {
        const file = blobs.get(hash)!;
        const resolvedPath = await realpath(file.absolutePath);
        if (!isInside(sourceState.rootRealPath, resolvedPath)) {
          throw new TaktpackError('SOURCE_CHANGED', 'source escaped the project template root', file.path);
        }
        await addBlobEntry(archive, file, options.signal);
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
    publishTempFile(tempPath, outputPath, force, expectedTarget);
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
