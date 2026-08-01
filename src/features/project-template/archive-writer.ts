import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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

const OUTPUT_AUTHORITIES = new WeakMap<object, TaktpackOutputAuthorityState>();

declare const OUTPUT_AUTHORITY_BRAND: unique symbol;

export interface TaktpackOutputPreconditionAuthority {
  readonly [OUTPUT_AUTHORITY_BRAND]: never;
}

interface TaktpackOutputTargetSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
  readonly size: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface TaktpackOutputPreconditionProjection {
  readonly schemaVersion: '1.0';
  readonly pathSha256: string;
  readonly parent: {
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly uid: number;
    readonly gid: number;
  };
  readonly target: { readonly state: 'absent' } | {
    readonly state: 'regular-file';
    readonly snapshot: TaktpackOutputTargetSnapshot;
  };
}

interface TaktpackOutputAuthorityState {
  readonly canonicalPath: string;
  readonly directory: string;
  readonly projection: TaktpackOutputPreconditionProjection;
  consumed: boolean;
}

export interface CapturedTaktpackOutputPrecondition {
  readonly authority: TaktpackOutputPreconditionAuthority;
  readonly projection: TaktpackOutputPreconditionProjection;
}

function outputTargetSnapshot(stat: import('node:fs').Stats): TaktpackOutputTargetSnapshot {
  return {
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function unsafeOutputTarget(field = 'outputPath'): TaktpackError {
  return new TaktpackError(
    'UNSAFE_OUTPUT_TARGET',
    'output precondition authority does not match the commit target',
    field,
  );
}

function unsafeOutputCapture(): TaktpackError {
  return unsafeOutputTarget('outputCapture');
}

export async function captureTaktpackOutputPrecondition(
  outputPath: string,
  options: { readonly forbiddenRoot?: string } = {},
): Promise<CapturedTaktpackOutputPrecondition> {
  if (!isAbsolute(outputPath)) throw unsafeOutputCapture();
  const requestedDirectory = dirname(resolve(outputPath));
  let directory: string;
  let parent: Awaited<ReturnType<typeof lstat>>;
  try {
    directory = await realpath(requestedDirectory);
    parent = await lstat(directory);
  } catch {
    throw unsafeOutputCapture();
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw unsafeOutputCapture();
  const permissions = parent.mode & 0o7777;
  if ((permissions & 0o002) !== 0 && (permissions & 0o1000) === 0) {
    throw unsafeOutputCapture();
  }
  const canonicalPath = join(directory, basename(outputPath));
  if (options.forbiddenRoot !== undefined) {
    let forbiddenRoot: string;
    try {
      forbiddenRoot = await realpath(options.forbiddenRoot);
    } catch {
      throw unsafeOutputCapture();
    }
    if (isInside(forbiddenRoot, canonicalPath)) throw unsafeOutputCapture();
  }
  let target: TaktpackOutputPreconditionProjection['target'];
  try {
    const targetStat = await lstat(canonicalPath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) {
      throw unsafeOutputCapture();
    }
    target = Object.freeze({
      state: 'regular-file' as const,
      snapshot: Object.freeze(outputTargetSnapshot(targetStat)),
    });
  } catch (error) {
    if (error instanceof TaktpackError) throw error;
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw unsafeOutputCapture();
    }
    target = Object.freeze({ state: 'absent' as const });
  }
  const projection = Object.freeze({
    schemaVersion: '1.0' as const,
    pathSha256: createHash('sha256').update(canonicalPath).digest('hex'),
    parent: Object.freeze({
      dev: parent.dev,
      ino: parent.ino,
      mode: parent.mode,
      uid: parent.uid,
      gid: parent.gid,
    }),
    target,
  });
  // Why: the token contains no forgeable data. Its commit authority lives only
  // in this module's WeakMap and is consumed even when validation later fails.
  const authority = Object.freeze(Object.create(null)) as TaktpackOutputPreconditionAuthority;
  OUTPUT_AUTHORITIES.set(authority, {
    canonicalPath,
    directory,
    projection,
    consumed: false,
  });
  return Object.freeze({ authority, projection });
}

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

function sameParentIdentity(
  expected: TaktpackOutputPreconditionProjection['parent'],
  actual: import('node:fs').Stats,
): boolean {
  return actual.isDirectory()
    && !actual.isSymbolicLink()
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.mode === expected.mode
    && actual.uid === expected.uid
    && actual.gid === expected.gid;
}

function sameTargetIdentity(
  expected: TaktpackOutputTargetSnapshot,
  actual: import('node:fs').Stats,
): boolean {
  return actual.isFile()
    && !actual.isSymbolicLink()
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.nlink === expected.nlink
    && actual.size === expected.size
    && actual.mode === expected.mode
    && actual.uid === expected.uid
    && actual.gid === expected.gid
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs;
}

function resolveAuthorizedOutputPath(outputPath: string): string {
  if (!isAbsolute(outputPath)) throw unsafeOutputTarget();
  let directory: string;
  try {
    directory = realpathSync(dirname(resolve(outputPath)));
  } catch {
    throw unsafeOutputTarget();
  }
  return join(directory, basename(outputPath));
}

function consumeOutputAuthority(
  outputPath: string,
  authority: TaktpackOutputPreconditionAuthority,
): TaktpackOutputAuthorityState {
  const state = OUTPUT_AUTHORITIES.get(authority);
  if (state === undefined || state.consumed) throw unsafeOutputTarget();
  state.consumed = true;
  if (resolveAuthorizedOutputPath(outputPath) !== state.canonicalPath) {
    throw unsafeOutputTarget();
  }
  return state;
}

function assertAuthorizedParent(
  state: TaktpackOutputAuthorityState,
  directoryFd?: number,
): void {
  if (resolveAuthorizedOutputPath(state.canonicalPath) !== state.canonicalPath) {
    throw unsafeOutputTarget();
  }
  let pathStat: import('node:fs').Stats;
  try {
    pathStat = lstatSync(state.directory);
  } catch {
    throw unsafeOutputTarget();
  }
  if (!sameParentIdentity(state.projection.parent, pathStat)) throw unsafeOutputTarget();
  if (directoryFd !== undefined) {
    let heldStat: import('node:fs').Stats;
    try {
      heldStat = fstatSync(directoryFd);
    } catch {
      throw unsafeOutputTarget();
    }
    if (!sameParentIdentity(state.projection.parent, heldStat)) throw unsafeOutputTarget();
  }
}

function assertAuthorizedTarget(state: TaktpackOutputAuthorityState): void {
  const expected = state.projection.target;
  try {
    const actual = lstatSync(state.canonicalPath);
    if (expected.state === 'absent' || !sameTargetIdentity(expected.snapshot, actual)) {
      throw unsafeOutputTarget();
    }
  } catch (error) {
    if (error instanceof TaktpackError) throw error;
    if (expected.state !== 'absent'
      || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw unsafeOutputTarget();
    }
  }
}

function assertPublishedTarget(
  state: TaktpackOutputAuthorityState,
  publishedSnapshot: import('node:fs').Stats,
): void {
  assertAuthorizedParent(state);
  let actual: import('node:fs').Stats;
  try {
    actual = lstatSync(state.canonicalPath);
  } catch {
    throw unsafeOutputTarget();
  }
  if (
    !actual.isFile()
    || actual.isSymbolicLink()
    || actual.nlink !== 1
    || actual.dev !== publishedSnapshot.dev
    || actual.ino !== publishedSnapshot.ino
    || actual.size !== publishedSnapshot.size
  ) throw unsafeOutputTarget();
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

export type TaktpackWriterIoPhase =
  | 'pipeline'
  | 'archive-read'
  | 'file-fsync'
  | 'publish'
  | 'post-publish'
  | 'post-link-unlink'
  | 'directory-fsync'
  | 'cleanup';

export interface TaktpackWriterIoSeam {
  onPhase?(phase: TaktpackWriterIoPhase): void;
}

function normalizeWriterIoError(
  error: unknown,
  code: 'ARCHIVE_WRITE_FAILED' | 'DURABILITY_FAILED' | 'CLEANUP_FAILED',
  field: string,
  artifactState: 'not-published' | 'published',
): Error {
  if (error instanceof TaktpackError || (error instanceof Error && error.name === 'AbortError')) {
    return error;
  }
  const message = code === 'DURABILITY_FAILED'
    ? 'archive durability operation failed'
    : code === 'CLEANUP_FAILED'
      ? 'archive temporary-file cleanup failed'
      : 'archive write operation failed';
  return new TaktpackError(code, message, field, artifactState);
}

function publishTempFile(
  tempPath: string,
  outputPath: string,
  force: boolean,
  expectedTarget: import('node:fs').Stats | undefined,
  onPublished: () => void,
  beforeNoForceTempUnlink: () => void,
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
    onPublished();
    return;
  }
  try {
    // A hard-link publish is the portable no-clobber primitive: unlike a
    // preflight exists check it remains safe if another writer wins the race.
    linkSync(tempPath, outputPath);
    onPublished();
    beforeNoForceTempUnlink();
    unlinkSync(tempPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new TaktpackError('OUTPUT_EXISTS', 'output already exists', 'outputPath');
    }
    throw error;
  }
}

export async function writeTaktpackWithIoSeam(
  outputPath: string,
  plan: ProjectTemplateExportPlan,
  options: WriteTaktpackOptions = {},
  ioSeam: TaktpackWriterIoSeam = {},
  outputAuthority?: TaktpackOutputPreconditionAuthority,
): Promise<WriteTaktpackResult> {
  const force = options.force === true;
  const limits = resolveTaktpackLimits(options.limits);
  const authorityState = outputAuthority === undefined
    ? undefined
    : consumeOutputAuthority(outputPath, outputAuthority);
  if (authorityState !== undefined) {
    assertAuthorizedParent(authorityState);
    assertAuthorizedTarget(authorityState);
  }
  const sourceState = getProjectTemplateExportSourceState(plan);
  if (sourceState === undefined || !validateProjectTemplateExportPlanSeal(plan, sourceState)) {
    throw new TaktpackError('INVALID_EXPORT_PLAN', 'export plan seal is missing or invalid', 'plan');
  }
  const sealedPlan = sourceState.sealedPlan;
  try {
    validateManifestLockPair(sealedPlan.manifest, sealedPlan.lock);
  } catch {
    throw new TaktpackError('INVALID_EXPORT_PLAN', 'sealed export plan is invalid', 'plan');
  }
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
  const blobFiles = [...blobs.values()].map((files) => files[0]!);
  const totalPayloadBytes = controlEntries.reduce((sum, [, content]) => sum + content.byteLength, 0)
    + blobFiles.reduce((sum, file) => sum + file.bytes, 0);
  const expectedArchiveBytes = 2 * TAR_BLOCK_BYTES
    + [...controlEntries.map(([, content]) => content.byteLength), ...blobFiles.map((file) => file.bytes)]
      .reduce(
        (sum, size) => sum + TAR_BLOCK_BYTES + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES,
        0,
      );
  if (
    controlEntries.length + blobs.size > limits.maxEntries
    || totalPayloadBytes > limits.maxTotalBytes
    || expectedArchiveBytes > limits.maxArchiveBytes
  ) {
    throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive envelope exceeds safety limits');
  }
  let expectedTarget: import('node:fs').Stats | undefined;
  try {
    if (existsSync(outputPath)) {
      expectedTarget = lstatSync(outputPath);
    }
  } catch (error) {
    throw normalizeWriterIoError(error, 'ARCHIVE_WRITE_FAILED', 'output', 'not-published');
  }
  if (!force && existsSync(outputPath)) {
    throw new TaktpackError('OUTPUT_EXISTS', 'output already exists', 'outputPath');
  }
  if (force && expectedTarget !== undefined && (!expectedTarget.isFile() || expectedTarget.nlink !== 1)) {
    throw new TaktpackError('UNSAFE_OUTPUT_TARGET', 'output target must be a regular single-link file', 'outputPath');
  }
  options.signal?.throwIfAborted();
  let rootStat: Awaited<ReturnType<typeof lstat>>;
  try {
    rootStat = await lstat(sourceState.rootRealPath);
  } catch (error) {
    throw normalizeWriterIoError(error, 'ARCHIVE_WRITE_FAILED', 'sourceRoot', 'not-published');
  }
  const expectedRoot = sourceState.rootSnapshot;
  if (
    !rootStat.isDirectory()
    || rootStat.dev !== expectedRoot.dev
    || rootStat.ino !== expectedRoot.ino
  ) {
    throw new TaktpackError('SOURCE_CHANGED', 'project template root changed after planning', 'projectRoot');
  }
  const outputDirectory = dirname(outputPath);
  // Why: staging one level above the authorized directory keeps cleanup
  // reachable when that directory is renamed during a failed pre-commit race,
  // while remaining on the same filesystem for atomic link/rename publish.
  const stagingDirectory = authorityState === undefined
    ? outputDirectory
    : dirname(outputDirectory);
  const tempPath = join(
    stagingDirectory,
    `.${basename(outputDirectory)}.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let archiveHash = createHash('sha256');
  let bytes = 0;
  let primaryError: Error | undefined;
  let cleanupFailure: unknown;
  let published = false;
  let result: WriteTaktpackResult | undefined;
  let directoryFd: number | undefined;
  let rollbackPath: string | undefined;
  try {
    if (authorityState !== undefined) {
      try {
        directoryFd = openSync(
          authorityState.directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch {
        throw unsafeOutputTarget();
      }
      assertAuthorizedParent(authorityState, directoryFd);
      assertAuthorizedTarget(authorityState);
    }
    for (const [sourceIndex, file] of sourceState.files.entries()) {
      const field = `sourceFiles[${sourceIndex}]`;
      try {
        const resolvedPath = await realpath(file.absolutePath);
        if (!isInside(sourceState.rootRealPath, resolvedPath)) {
          throw new TaktpackError('SOURCE_CHANGED', 'source escaped the project template root', field);
        }
        await verifySourceFile(file, options.signal, field);
      } catch (error) {
        if (error instanceof TaktpackError || (error instanceof Error && error.name === 'AbortError')) {
          throw error;
        }
        throw new TaktpackError('SOURCE_CHANGED', 'source could not be reopened safely', field);
      }
    }

    if (authorityState !== undefined) {
      assertAuthorizedParent(authorityState, directoryFd);
      assertAuthorizedTarget(authorityState);
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
    const rawOutputPromise = pipeline(
      archive,
      hashStream,
      output,
      ...(options.signal === undefined ? [] : [{ signal: options.signal }]),
    );
    // Attach the rejection handler in the same turn as pipeline creation.
    // Delaying it until archive.entry awaits can trigger unhandledRejection.
    const outputOutcome = rawOutputPromise.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({
        ok: false as const,
        error: normalizeWriterIoError(
          error,
          'ARCHIVE_WRITE_FAILED',
          'output',
          'not-published',
        ),
      }),
    );
    try {
      ioSeam.onPhase?.('pipeline');
      await addBufferEntry(archive, 'pack.json', packContent);
      await addBufferEntry(archive, 'manifest.json', manifestContent);
      await addBufferEntry(archive, 'export-report.json', reportContent);
      for (const hash of [...blobs.keys()].sort((left, right) => left.localeCompare(right, 'en-US'))) {
        const file = blobs.get(hash)![0]!;
        await addBlobEntry(archive, file, options.signal, 'blob');
      }
      archive.finalize();
      const outcome = await outputOutcome;
      if (!outcome.ok) throw outcome.error;
    } catch (error) {
      archive.destroy(error instanceof Error ? error : new Error(String(error)));
      const outcome = await outputOutcome;
      if (!outcome.ok) throw outcome.error;
      throw error;
    }
    options.signal?.throwIfAborted();
    canonicalizeWrittenUstarHeaders(tempPath);
    options.signal?.throwIfAborted();
    archiveHash = createHash('sha256');
    bytes = 0;
    ioSeam.onPhase?.('archive-read');
    options.signal?.throwIfAborted();
    const completedArchive = createReadStream(tempPath, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    for await (const chunk of completedArchive) {
      options.signal?.throwIfAborted();
      const buffer = chunk as Buffer;
      bytes += buffer.byteLength;
      if (bytes > limits.maxArchiveBytes) {
        throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive exceeds size limit');
      }
      archiveHash.update(buffer);
    }
    options.signal?.throwIfAborted();
    try {
      ioSeam.onPhase?.('file-fsync');
      options.signal?.throwIfAborted();
      const completedFd = openSync(tempPath, constants.O_RDONLY);
      try {
        fsyncSync(completedFd);
      } finally {
        closeSync(completedFd);
      }
    } catch (error) {
      throw normalizeWriterIoError(error, 'DURABILITY_FAILED', 'archive', 'not-published');
    }
    try {
      ioSeam.onPhase?.('publish');
      // Publication is the cancellation commit boundary. Once link/rename
      // begins, complete directory durability and report the published result
      // instead of turning a visible artifact into an ambiguous abort.
      options.signal?.throwIfAborted();
      let publicationExpectedTarget = expectedTarget;
      if (authorityState !== undefined) {
        assertAuthorizedParent(authorityState, directoryFd);
        assertAuthorizedTarget(authorityState);
        if (force && authorityState.projection.target.state === 'regular-file') {
          rollbackPath = join(
            stagingDirectory,
            `.${basename(outputDirectory)}.${basename(outputPath)}.${process.pid}.${randomUUID()}.rollback`,
          );
          linkSync(outputPath, rollbackPath);
          publicationExpectedTarget = lstatSync(outputPath);
        }
      }
      const publishedSnapshot = lstatSync(tempPath);
      publishTempFile(
        tempPath,
        outputPath,
        force,
        publicationExpectedTarget,
        () => {
          // link/rename is the externally visible commit point. Record it
          // before any later temp cleanup or directory durability operation.
          published = true;
        },
        () => ioSeam.onPhase?.('post-link-unlink'),
      );
      if (authorityState !== undefined) {
        try {
          ioSeam.onPhase?.('post-publish');
          assertAuthorizedParent(authorityState, directoryFd);
          assertPublishedTarget(authorityState, publishedSnapshot);
          if (rollbackPath !== undefined) {
            unlinkSync(rollbackPath);
            rollbackPath = undefined;
          }
          assertAuthorizedParent(authorityState, directoryFd);
          assertPublishedTarget(authorityState, publishedSnapshot);
        } catch (error) {
          let rolledBack = false;
          try {
            if (rollbackPath !== undefined && existsSync(rollbackPath)) {
              renameSync(rollbackPath, outputPath);
              rollbackPath = undefined;
              rolledBack = true;
            } else {
              const current = lstatSync(outputPath);
              if (current.dev === publishedSnapshot.dev && current.ino === publishedSnapshot.ino) {
                unlinkSync(outputPath);
                rolledBack = true;
              }
            }
          } catch {
            // The original validation error remains primary. published=true
            // truthfully reports that rollback could not be proven complete.
          }
          if (rolledBack) published = false;
          throw error;
        }
      }
    } catch (error) {
      throw normalizeWriterIoError(
        error,
        published ? 'CLEANUP_FAILED' : 'ARCHIVE_WRITE_FAILED',
        published ? 'temporaryArchive' : 'publish',
        published ? 'published' : 'not-published',
      );
    }
    try {
      ioSeam.onPhase?.('directory-fsync');
      syncTaktpackOutputDirectory(outputDirectory);
    } catch (error) {
      throw normalizeWriterIoError(error, 'DURABILITY_FAILED', 'outputDirectory', 'published');
    }
    result = {
      outputPath,
      archiveSha256: archiveHash.digest('hex'),
      bytes,
    };
  } catch (error) {
    primaryError = normalizeWriterIoError(
      error,
      'ARCHIVE_WRITE_FAILED',
      'archive',
      published ? 'published' : 'not-published',
    );
  } finally {
    if (directoryFd !== undefined) {
      try {
        closeSync(directoryFd);
      } catch {
        // A close failure cannot change the already determined artifact state.
      }
    }
    try {
      ioSeam.onPhase?.('cleanup');
      if (existsSync(tempPath)) unlinkSync(tempPath);
      if (rollbackPath !== undefined && existsSync(rollbackPath)) unlinkSync(rollbackPath);
    } catch (caughtCleanupError) {
      // Cleanup must never replace the primary failure: callers need the
      // operation that caused the archive to fail, without a raw temp path.
      if (primaryError === undefined) {
        cleanupFailure = caughtCleanupError;
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupFailure !== undefined) {
    throw normalizeWriterIoError(
      cleanupFailure,
      'CLEANUP_FAILED',
      'temporaryArchive',
      published ? 'published' : 'not-published',
    );
  }
  return result!;
}

export function writeTaktpack(
  outputPath: string,
  plan: ProjectTemplateExportPlan,
  options: WriteTaktpackOptions = {},
): Promise<WriteTaktpackResult> {
  return writeTaktpackWithIoSeam(outputPath, plan, options);
}

export function writeTaktpackWithOutputPrecondition(
  outputPath: string,
  plan: ProjectTemplateExportPlan,
  authority: TaktpackOutputPreconditionAuthority,
  options: WriteTaktpackOptions = {},
  ioSeam: TaktpackWriterIoSeam = {},
): Promise<WriteTaktpackResult> {
  return writeTaktpackWithIoSeam(outputPath, plan, options, ioSeam, authority);
}
