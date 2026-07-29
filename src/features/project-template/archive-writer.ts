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
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
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
import {
  getProjectTemplateExportSourceState,
  validateProjectTemplateExportPlanSeal,
} from './export-plan.js';
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
const TAR_BLOCK_BYTES = 512;

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

function writeCanonicalOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

/**
 * tar-stream owns framing, while this pass owns the byte-level v1 header
 * contract. Pinning every numeric and identity field prevents dependency or
 * platform defaults from changing otherwise identical pack bytes.
 */
function canonicalizeWrittenUstarHeaders(path: string): void {
  const fd = openSync(path, constants.O_RDWR);
  try {
    const header = Buffer.alloc(TAR_BLOCK_BYTES);
    let position = 0;
    while (true) {
      if (readSync(fd, header, 0, TAR_BLOCK_BYTES, position) !== TAR_BLOCK_BYTES) {
        throw new TaktpackError('TRUNCATED_ARCHIVE', 'writer produced a truncated USTAR header');
      }
      if (header.equals(Buffer.alloc(TAR_BLOCK_BYTES))) break;
      const size = Number.parseInt(header.subarray(124, 136).toString('ascii'), 8);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new TaktpackError('INVALID_PACK', 'writer produced an invalid USTAR size');
      }
      writeCanonicalOctal(header, 100, 8, ARCHIVE_MODE);
      writeCanonicalOctal(header, 108, 8, 0);
      writeCanonicalOctal(header, 116, 8, 0);
      writeCanonicalOctal(header, 124, 12, size);
      writeCanonicalOctal(header, 136, 12, 0);
      header.fill(0, 157, 257);
      header.fill(0, 265, 329);
      writeCanonicalOctal(header, 329, 8, 0);
      writeCanonicalOctal(header, 337, 8, 0);
      header.fill(0, 345, 512);
      header.fill(0x20, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
      writeSync(fd, header, 0, TAR_BLOCK_BYTES, position);
      position += TAR_BLOCK_BYTES + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    }
  } finally {
    closeSync(fd);
  }
}

function addBufferEntry(archive: Pack, name: string, content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    archive.entry(regularHeader(name, content.byteLength), content, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function assertSnapshot(
  file: ProjectTemplateExportFile,
  stat: import('node:fs').Stats,
  field: string,
): void {
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
    throw new TaktpackError('SOURCE_CHANGED', 'source identity changed after planning', field);
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
  field: string,
): Promise<void> {
  const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertSnapshot(file, before, field);
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
      throw new TaktpackError('SOURCE_CHANGED', 'source changed while it was archived', field);
    }
    if (digest.digest('hex') !== file.sha256) {
      throw new TaktpackError('SOURCE_CHANGED', 'source content no longer matches its planned hash', field);
    }
  } finally {
    await handle.close();
  }
}

async function verifySourceFile(
  file: ProjectTemplateExportFile,
  signal: AbortSignal | undefined,
  field: string,
): Promise<void> {
  const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertSnapshot(file, before, field);
    const digest = createHash('sha256');
    const stream = createReadStream(file.absolutePath, {
      fd: handle.fd,
      autoClose: false,
      ...(signal === undefined ? {} : { signal }),
    });
    for await (const chunk of stream) digest.update(chunk as Buffer);
    const after = await handle.stat();
    if (!areProjectTemplateFileStatsEqual(before, after)
      || digest.digest('hex') !== file.sha256) {
      throw new TaktpackError('SOURCE_CHANGED', 'source changed during export verification', field);
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

export function syncTaktpackOutputDirectory(
  path: string,
  platform: NodeJS.Platform = process.platform,
  sync: (directory: string) => void = fsyncDirectory,
): 'synced' | 'unsupported' {
  // Windows does not offer portable directory fsync semantics. The completed
  // file itself was already fsynced before publish, so a platform limitation
  // must not turn a successfully published artifact into a reported failure.
  if (platform === 'win32') return 'unsupported';
  sync(path);
  return 'synced';
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
  const sourceState = getProjectTemplateExportSourceState(plan);
  if (sourceState === undefined || !validateProjectTemplateExportPlanSeal(plan, sourceState)) {
    throw new TaktpackError('INVALID_EXPORT_PLAN', 'export plan seal is missing or invalid', 'plan');
  }
  const sealedPlan = sourceState.sealedPlan;
  validateManifestLockPair(sealedPlan.manifest, sealedPlan.lock);
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
  let archiveHash = createHash('sha256');
  let bytes = 0;
  try {
    const manifestContent = Buffer.from(canonicalizeTaktpackJson(sealedPlan.manifest));
    const reportContent = Buffer.from(canonicalizeTaktpackJson(sealedPlan.report));
    const blobs = new Map<string, ProjectTemplateExportFile[]>();
    for (const file of sourceState.files) {
      const sources = blobs.get(file.sha256) ?? [];
      sources.push(file);
      blobs.set(file.sha256, sources);
    }
    const lockSeed = {
        kind: 'project-template-lock-seed' as const,
        schemaVersion: sealedPlan.lock.schemaVersion,
        packVersion: sealedPlan.lock.packVersion,
        source: sealedPlan.lock.source,
        capabilities: sealedPlan.lock.capabilities,
        entries: sealedPlan.lock.entries,
      };
    const packContent = Buffer.from(canonicalizeTaktpackJson({
        ...sealedPlan.descriptor,
        manifestSha256: calculateProjectTemplateManifestSha256(sealedPlan.manifest),
        exportReportSha256: createHash('sha256').update(reportContent).digest('hex'),
        lockSeed,
        blobs: [...blobs.entries()]
          .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
          .map(([sha256, files]) => ({ sha256, bytes: files[0]!.bytes })),
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
      + [...blobs.values()].reduce((sum, files) => sum + files[0]!.bytes, 0);
    if (controlEntries.length + blobs.size > limits.maxEntries
      || totalPayloadBytes > limits.maxTotalBytes) {
      throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive envelope exceeds safety limits');
    }

    for (const [sourceIndex, file] of sourceState.files.entries()) {
      const resolvedPath = await realpath(file.absolutePath);
      if (!isInside(sourceState.rootRealPath, resolvedPath)) {
        throw new TaktpackError(
          'SOURCE_CHANGED',
          'source escaped the project template root',
          `sourceFiles[${sourceIndex}]`,
        );
      }
      await verifySourceFile(file, options.signal, `sourceFiles[${sourceIndex}]`);
    }

    const output = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    const hashStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        if (bytes > limits.maxArchiveBytes) {
          callback(new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive exceeds size limit'));
          return;
        }
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
        const file = blobs.get(hash)![0]!;
        await addBlobEntry(archive, file, options.signal, 'blob');
      }
      archive.finalize();
      await outputPromise;
    } catch (error) {
      archive.destroy(error instanceof Error ? error : new Error(String(error)));
      await outputPromise.catch(() => undefined);
      throw error;
    }
    canonicalizeWrittenUstarHeaders(tempPath);
    archiveHash = createHash('sha256');
    bytes = 0;
    for await (const chunk of createReadStream(tempPath)) {
      const buffer = chunk as Buffer;
      bytes += buffer.byteLength;
      if (bytes > limits.maxArchiveBytes) {
        throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive exceeds size limit');
      }
      archiveHash.update(buffer);
    }
    const completedFd = openSync(tempPath, constants.O_RDONLY);
    try {
      fsyncSync(completedFd);
    } finally {
      closeSync(completedFd);
    }
    publishTempFile(tempPath, outputPath, force, expectedTarget);
    syncTaktpackOutputDirectory(outputDirectory);
    return {
      outputPath,
      archiveSha256: archiveHash.digest('hex'),
      bytes,
    };
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}
