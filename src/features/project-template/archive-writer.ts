import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
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
  DEFAULT_TAKTPACK_LIMITS,
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
  readonly sha256: string;
}

export interface TaktpackOutputPreconditionProjection {
  readonly schemaVersion: '1.0';
  readonly pathSha256: string;
  readonly parent: TaktpackDirectorySnapshot;
  readonly stagingParent: TaktpackDirectorySnapshot;
  readonly target: { readonly state: 'absent' } | {
    readonly state: 'regular-file';
    readonly snapshot: TaktpackOutputTargetSnapshot;
  };
}

interface TaktpackDirectorySnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

interface TaktpackOutputAuthorityState {
  readonly canonicalPath: string;
  readonly directory: string;
  readonly stagingDirectory: string;
  readonly projection: TaktpackOutputPreconditionProjection;
  consumed: boolean;
}

export interface CapturedTaktpackOutputPrecondition {
  readonly authority: TaktpackOutputPreconditionAuthority;
  readonly projection: TaktpackOutputPreconditionProjection;
}

function outputTargetSnapshot(
  stat: import('node:fs').Stats,
  sha256: string,
): TaktpackOutputTargetSnapshot {
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
    sha256,
  };
}

async function digestCapturedOutputTarget(
  path: string,
  initial: import('node:fs').Stats,
): Promise<string> {
  if (initial.size > DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes) {
    throw unsafeOutputCapture();
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw unsafeOutputCapture();
  }
  try {
    const before = await handle.stat();
    if (!sameTargetIdentity(outputTargetSnapshot(initial, ''), before)) {
      throw unsafeOutputCapture();
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - position),
        position,
      );
      if (read.bytesRead <= 0) throw unsafeOutputCapture();
      digest.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await handle.stat();
    if (!areProjectTemplateFileStatsEqual(before, after)) {
      throw unsafeOutputCapture();
    }
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

function unsafeOutputTarget(
  field = 'outputPath',
  artifactState?: 'not-published' | 'published',
): TaktpackError {
  return new TaktpackError(
    'UNSAFE_OUTPUT_TARGET',
    'output precondition authority does not match the commit target',
    field,
    artifactState,
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
  let stagingDirectory: string;
  let stagingParent: Awaited<ReturnType<typeof lstat>>;
  try {
    directory = await realpath(requestedDirectory);
    parent = await lstat(directory);
    // The authorized output directory is also the staging parent. A fresh
    // private child namespace remains attached to this inode if the public
    // path is renamed, so recovery evidence is retained without trusting the
    // path that replaced it.
    stagingDirectory = directory;
    if (await realpath(stagingDirectory) !== stagingDirectory) {
      throw unsafeOutputCapture();
    }
    stagingParent = await lstat(stagingDirectory);
  } catch {
    throw unsafeOutputCapture();
  }
  if (
    !parent.isDirectory()
    || parent.isSymbolicLink()
    || !stagingParent.isDirectory()
    || stagingParent.isSymbolicLink()
  ) throw unsafeOutputCapture();
  const permissions = parent.mode & 0o7777;
  const stagingPermissions = stagingParent.mode & 0o7777;
  if ((permissions & 0o022) !== 0) {
    throw unsafeOutputCapture();
  }
  if ((stagingPermissions & 0o022) !== 0) {
    throw unsafeOutputCapture();
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (
    currentUid !== undefined
    && (parent.uid !== currentUid || stagingParent.uid !== currentUid)
  ) throw unsafeOutputCapture();
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
      snapshot: Object.freeze(outputTargetSnapshot(
        targetStat,
        await digestCapturedOutputTarget(canonicalPath, targetStat),
      )),
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
    stagingParent: Object.freeze({
      dev: stagingParent.dev,
      ino: stagingParent.ino,
      mode: stagingParent.mode,
      uid: stagingParent.uid,
      gid: stagingParent.gid,
    }),
    target,
  });
  // Why: the token contains no forgeable data. Its commit authority lives only
  // in this module's WeakMap and is consumed even when validation later fails.
  const authority = Object.freeze(Object.create(null)) as TaktpackOutputPreconditionAuthority;
  OUTPUT_AUTHORITIES.set(authority, {
    canonicalPath,
    directory,
    stagingDirectory,
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
  expected: TaktpackDirectorySnapshot,
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

function assertAuthorizedStagingParent(
  state: TaktpackOutputAuthorityState,
  directoryFd: number,
): void {
  let pathStat: import('node:fs').Stats;
  let heldStat: import('node:fs').Stats;
  try {
    pathStat = lstatSync(state.stagingDirectory);
    heldStat = fstatSync(directoryFd);
  } catch {
    throw unsafeOutputTarget();
  }
  if (
    !sameParentIdentity(state.projection.stagingParent, pathStat)
    || !sameParentIdentity(state.projection.stagingParent, heldStat)
  ) throw unsafeOutputTarget();
}

function assertAuthorizedRecoveryDirectory(
  path: string,
  expected: TaktpackDirectorySnapshot,
  directoryFd: number,
): void {
  let pathStat: import('node:fs').Stats;
  let heldStat: import('node:fs').Stats;
  try {
    pathStat = lstatSync(path);
    heldStat = fstatSync(directoryFd);
  } catch {
    throw unsafeOutputTarget();
  }
  if (
    !sameParentIdentity(expected, pathStat)
    || !sameParentIdentity(expected, heldStat)
    || (pathStat.mode & 0o777) !== 0o700
  ) throw unsafeOutputTarget();
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

function sameEvacuatedTargetIdentity(
  expected: TaktpackOutputTargetSnapshot,
  actual: import('node:fs').Stats,
  expectedLinks: number,
): boolean {
  // rename can advance ctime while preserving the file object. The remaining
  // identity and content metadata still prove which inode was evacuated.
  return actual.isFile()
    && !actual.isSymbolicLink()
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.nlink === expectedLinks
    && actual.size === expected.size
    && actual.mode === expected.mode
    && actual.uid === expected.uid
    && actual.gid === expected.gid
    && actual.mtimeMs === expected.mtimeMs;
}

function verifyEvacuatedTargetWitness(
  expected: TaktpackOutputTargetSnapshot,
  path: string,
  expectedLinks: number,
  ioSeam: TaktpackWriterIoSeam,
  closePhase:
    | 'evacuated-witness-close'
    | 'rollback-restored-witness-close'
    | 'rollback-final-witness-close',
): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  let verified = false;
  try {
    const before = fstatSync(fd);
    if (!sameEvacuatedTargetIdentity(expected, before, expectedLinks)) {
      return false;
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const bytesRead = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - position),
        position,
      );
      if (bytesRead <= 0) return false;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fstatSync(fd);
    verified = areProjectTemplateFileStatsEqual(before, after)
      && digest.digest('hex') === expected.sha256;
  } catch {
    verified = false;
  } finally {
    // Why: a close failure makes the descriptor lifecycle uncertain. It must
    // invalidate the witness without escaping past the post-rename recovery
    // branch, which is responsible for retaining the rollback evidence.
    try {
      ioSeam.onPhase?.(closePhase);
    } catch {
      verified = false;
    }
    try {
      closeSync(fd);
    } catch {
      verified = false;
    }
  }
  return verified;
}

function capturePrivateRecoveryFileWitness(
  path: string,
  expectedUid: number,
): TaktpackOutputTargetSnapshot | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  let witness: TaktpackOutputTargetSnapshot | undefined;
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1
      || before.uid !== expectedUid
      || (before.mode & 0o777) !== 0o600
    ) return undefined;
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const bytesRead = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - position),
        position,
      );
      if (bytesRead <= 0) return undefined;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fstatSync(fd);
    if (!areProjectTemplateFileStatsEqual(before, after)) return undefined;
    witness = outputTargetSnapshot(after, digest.digest('hex'));
  } catch {
    witness = undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      witness = undefined;
    }
  }
  return witness;
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
  expectedLinks: number,
): void {
  let actual: import('node:fs').Stats;
  try {
    actual = lstatSync(state.canonicalPath);
  } catch {
    throw unsafeOutputTarget();
  }
  if (
    !actual.isFile()
    || actual.isSymbolicLink()
    || actual.nlink !== expectedLinks
    || actual.dev !== publishedSnapshot.dev
    || actual.ino !== publishedSnapshot.ino
    || actual.size !== publishedSnapshot.size
  ) throw unsafeOutputTarget();
}

function assertStagingFileIdentity(
  path: string,
  expected: Pick<import('node:fs').Stats,
    'dev' | 'ino' | 'size' | 'mode' | 'uid' | 'gid'>,
  expectedLinks: number,
): void {
  let actual: import('node:fs').Stats;
  try {
    actual = lstatSync(path);
  } catch {
    throw unsafeOutputTarget();
  }
  if (
    !actual.isFile()
    || actual.isSymbolicLink()
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.size !== expected.size
    || actual.mode !== expected.mode
    || actual.uid !== expected.uid
    || actual.gid !== expected.gid
    || actual.nlink !== expectedLinks
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

function syncHeldTaktpackOutputDirectory(
  directoryFd: number,
  platform: NodeJS.Platform = process.platform,
): 'synced' | 'unsupported' {
  if (platform === 'win32') return 'unsupported';
  fsyncSync(directoryFd);
  return 'synced';
}

function unlinkAuthorizedStagingEntry(
  path: string,
  phases: Readonly<{
    unlink: Extract<TaktpackWriterIoPhase,
      'rollback-unlink' | 'staging-temp-unlink' | 'staging-rollback-unlink'>;
    directoryFsync: Extract<TaktpackWriterIoPhase,
      | 'rollback-staging-directory-fsync'
      | 'staging-temp-directory-fsync'
      | 'staging-rollback-directory-fsync'>;
    parentWitness: Extract<TaktpackWriterIoPhase,
      | 'rollback-staging-parent-witness'
      | 'staging-temp-parent-witness'
      | 'staging-rollback-parent-witness'>;
  }>,
  state: TaktpackOutputAuthorityState,
  stagingDirectoryFd: number,
  recoveryDirectory: string,
  recoveryDirectorySnapshot: TaktpackDirectorySnapshot,
  recoveryDirectoryFd: number,
  ioSeam: TaktpackWriterIoSeam,
  assertEntry: () => void,
): void {
  assertAuthorizedStagingParent(state, stagingDirectoryFd);
  assertAuthorizedRecoveryDirectory(
    recoveryDirectory,
    recoveryDirectorySnapshot,
    recoveryDirectoryFd,
  );
  assertEntry();
  ioSeam.onPhase?.(phases.unlink);
  // A seam may model a parent exchange immediately before the destructive
  // syscall, so path and held descriptor authority are checked again here.
  assertAuthorizedStagingParent(state, stagingDirectoryFd);
  assertAuthorizedRecoveryDirectory(
    recoveryDirectory,
    recoveryDirectorySnapshot,
    recoveryDirectoryFd,
  );
  assertEntry();
  unlinkSync(path);
  ioSeam.onPhase?.(phases.directoryFsync);
  syncHeldTaktpackOutputDirectory(recoveryDirectoryFd);
  ioSeam.onPhase?.(phases.parentWitness);
  assertAuthorizedStagingParent(state, stagingDirectoryFd);
  assertAuthorizedRecoveryDirectory(
    recoveryDirectory,
    recoveryDirectorySnapshot,
    recoveryDirectoryFd,
  );
}

export type TaktpackWriterIoPhase =
  | 'pipeline'
  | 'archive-read'
  | 'file-fsync'
  | 'force-cas'
  | 'evacuated-witness-close'
  | 'authority-link'
  | 'rollback-restored-directory-fsync'
  | 'rollback-restored-witness'
  | 'rollback-restored-witness-close'
  | 'rollback-unlink'
  | 'rollback-staging-directory-fsync'
  | 'rollback-staging-parent-witness'
  | 'rollback-final-directory-fsync'
  | 'rollback-final-witness'
  | 'rollback-final-witness-close'
  | 'staging-temp-unlink'
  | 'staging-temp-directory-fsync'
  | 'staging-temp-parent-witness'
  | 'staging-rollback-unlink'
  | 'staging-rollback-directory-fsync'
  | 'staging-rollback-parent-witness'
  | 'recovery-quarantine'
  | 'recovery-directory-close'
  | 'quarantine-directory-close'
  | 'output-directory-close'
  | 'staging-directory-close'
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
  const stagingDirectory = authorityState === undefined
    ? outputDirectory
    : authorityState.stagingDirectory;
  let tempPath = join(
    stagingDirectory,
    authorityState === undefined
      ? `.${basename(outputDirectory)}.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`
      : '.uninitialized-taktpack-recovery',
  );
  let archiveHash = createHash('sha256');
  let bytes = 0;
  let primaryError: Error | undefined;
  let cleanupFailure: unknown;
  let published = false;
  let result: WriteTaktpackResult | undefined;
  let directoryFd: number | undefined;
  let stagingDirectoryFd: number | undefined;
  let recoveryDirectory: string | undefined;
  let recoveryDirectoryFd: number | undefined;
  let recoveryDirectorySnapshot: TaktpackDirectorySnapshot | undefined;
  let rollbackPath: string | undefined;
  let authorityPublishedSnapshot: import('node:fs').Stats | undefined;
  let retainRecoveryArtifacts = false;
  let restorationPending = false;

  const failAuthorityPublication = (error: unknown): never => {
    if (
      authorityState === undefined
      || directoryFd === undefined
      || authorityPublishedSnapshot === undefined
    ) throw error;
    // Even when the visible path still appears exact, another actor may race
    // the rollback syscall. Retaining both opaque artifacts is safer than a
    // path-only unlink/rename that could destroy a foreign replacement.
    void error;
    retainRecoveryArtifacts = true;
    throw unsafeOutputTarget('outputPath', 'published');
  };
  const failAuthorityCleanup = (): never => {
    throw unsafeOutputTarget('outputPath', 'published');
  };
  try {
    if (authorityState !== undefined) {
      try {
        directoryFd = openSync(
          authorityState.directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        stagingDirectoryFd = openSync(
          authorityState.stagingDirectory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch {
        throw unsafeOutputTarget();
      }
      assertAuthorizedParent(authorityState, directoryFd);
      assertAuthorizedStagingParent(authorityState, stagingDirectoryFd);
      assertAuthorizedTarget(authorityState);
      try {
        recoveryDirectory = mkdtempSync(join(
          authorityState.stagingDirectory,
          '.taktpack-recovery-',
        ));
        chmodSync(recoveryDirectory, 0o700);
        recoveryDirectoryFd = openSync(
          recoveryDirectory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const recoveryStat = fstatSync(recoveryDirectoryFd);
        if (
          recoveryStat.dev !== authorityState.projection.stagingParent.dev
          || recoveryStat.uid !== authorityState.projection.stagingParent.uid
        ) throw unsafeOutputTarget();
        recoveryDirectorySnapshot = Object.freeze({
          dev: recoveryStat.dev,
          ino: recoveryStat.ino,
          mode: recoveryStat.mode,
          uid: recoveryStat.uid,
          gid: recoveryStat.gid,
        });
        assertAuthorizedRecoveryDirectory(
          recoveryDirectory,
          recoveryDirectorySnapshot,
          recoveryDirectoryFd,
        );
        syncHeldTaktpackOutputDirectory(stagingDirectoryFd);
        assertAuthorizedStagingParent(authorityState, stagingDirectoryFd);
        assertAuthorizedRecoveryDirectory(
          recoveryDirectory,
          recoveryDirectorySnapshot,
          recoveryDirectoryFd,
        );
        tempPath = join(recoveryDirectory, 'archive.tmp');
      } catch {
        retainRecoveryArtifacts = true;
        throw unsafeOutputTarget();
      }
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
      if (stagingDirectoryFd === undefined) throw unsafeOutputTarget();
      assertAuthorizedStagingParent(authorityState, stagingDirectoryFd);
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
      if (authorityState !== undefined) {
        assertAuthorizedParent(authorityState, directoryFd);
        if (stagingDirectoryFd === undefined) throw unsafeOutputTarget();
        assertAuthorizedStagingParent(authorityState, stagingDirectoryFd);
        assertAuthorizedTarget(authorityState);
        if (force && authorityState.projection.target.state === 'regular-file') {
          if (
            recoveryDirectory === undefined
            || recoveryDirectoryFd === undefined
            || recoveryDirectorySnapshot === undefined
          ) throw unsafeOutputTarget();
          assertAuthorizedStagingParent(authorityState, stagingDirectoryFd!);
          assertAuthorizedRecoveryDirectory(
            recoveryDirectory,
            recoveryDirectorySnapshot,
            recoveryDirectoryFd,
          );
          rollbackPath = join(recoveryDirectory, 'rollback');
          ioSeam.onPhase?.('force-cas');
          renameSync(outputPath, rollbackPath);
          assertAuthorizedStagingParent(authorityState, stagingDirectoryFd!);
          assertAuthorizedRecoveryDirectory(
            recoveryDirectory,
            recoveryDirectorySnapshot,
            recoveryDirectoryFd,
          );
          if (!verifyEvacuatedTargetWitness(
            authorityState.projection.target.snapshot,
            rollbackPath,
            1,
            ioSeam,
            'evacuated-witness-close',
          )) {
            retainRecoveryArtifacts = true;
            try {
              // Restore visibility without replacing a newer foreign winner.
              // The evacuated object remains retained as evidence either way.
              linkSync(rollbackPath, outputPath);
            } catch {
              // EEXIST means a foreign winner is already visible; preserve it.
            }
            throw unsafeOutputTarget('outputPath', 'published');
          }
          assertAuthorizedStagingParent(authorityState, stagingDirectoryFd!);
          assertAuthorizedRecoveryDirectory(
            recoveryDirectory,
            recoveryDirectorySnapshot,
            recoveryDirectoryFd,
          );
        }
        if (
          recoveryDirectory === undefined
          || recoveryDirectoryFd === undefined
          || recoveryDirectorySnapshot === undefined
          || stagingDirectoryFd === undefined
        ) throw unsafeOutputTarget();
        assertAuthorizedStagingParent(authorityState, stagingDirectoryFd);
        assertAuthorizedRecoveryDirectory(
          recoveryDirectory,
          recoveryDirectorySnapshot,
          recoveryDirectoryFd,
        );
        authorityPublishedSnapshot = lstatSync(tempPath);
        try {
          // Same-device hard-link creation is atomic no-replace on POSIX and
          // Windows: a foreign insertion wins with EEXIST and is preserved.
          ioSeam.onPhase?.('authority-link');
          linkSync(tempPath, outputPath);
          published = true;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            if (rollbackPath !== undefined) retainRecoveryArtifacts = true;
            throw unsafeOutputTarget(
              'outputPath',
              rollbackPath === undefined ? 'not-published' : 'published',
            );
          }
          if (rollbackPath !== undefined) {
            const target = authorityState.projection.target;
            const heldDirectoryFd = directoryFd;
            if (
              target.state !== 'regular-file'
              || heldDirectoryFd === undefined
            ) {
              retainRecoveryArtifacts = true;
              throw unsafeOutputTarget('outputPath', 'published');
            }
            try {
              assertAuthorizedStagingParent(authorityState, stagingDirectoryFd!);
              assertAuthorizedRecoveryDirectory(
                recoveryDirectory!,
                recoveryDirectorySnapshot!,
                recoveryDirectoryFd!,
              );
              linkSync(rollbackPath, outputPath);

              // Why: restoration is not safely reportable as not-published
              // until both directory transitions and the exact old content
              // are durable. The two-link witness protects the rollback unlink;
              // the final one-link witness proves the restored public name.
              ioSeam.onPhase?.('rollback-restored-directory-fsync');
              syncHeldTaktpackOutputDirectory(heldDirectoryFd);
              ioSeam.onPhase?.('rollback-restored-witness');
              if (!verifyEvacuatedTargetWitness(
                target.snapshot,
                outputPath,
                2,
                ioSeam,
                'rollback-restored-witness-close',
              )) throw unsafeOutputTarget('outputPath', 'published');
              assertAuthorizedStagingParent(authorityState, stagingDirectoryFd!);
              assertAuthorizedRecoveryDirectory(
                recoveryDirectory!,
                recoveryDirectorySnapshot!,
                recoveryDirectoryFd!,
              );

              restorationPending = true;
            } catch {
              retainRecoveryArtifacts = true;
              throw unsafeOutputTarget('outputPath', 'published');
            }
          }
          throw error;
        }
        try {
          ioSeam.onPhase?.('post-publish');
          assertAuthorizedParent(authorityState, directoryFd);
          assertAuthorizedStagingParent(authorityState, stagingDirectoryFd);
          assertAuthorizedRecoveryDirectory(
            recoveryDirectory,
            recoveryDirectorySnapshot,
            recoveryDirectoryFd,
          );
          assertPublishedTarget(authorityState, authorityPublishedSnapshot, 2);
        } catch (error) {
          failAuthorityPublication(error);
        }
      } else {
        publishTempFile(
          tempPath,
          outputPath,
          force,
          expectedTarget,
          () => {
            published = true;
          },
          () => ioSeam.onPhase?.('post-link-unlink'),
        );
      }
    } catch (error) {
      if (retainRecoveryArtifacts) {
        throw unsafeOutputTarget('outputPath', 'published');
      }
      throw normalizeWriterIoError(
        error,
        published ? 'CLEANUP_FAILED' : 'ARCHIVE_WRITE_FAILED',
        published ? 'temporaryArchive' : 'publish',
        published ? 'published' : 'not-published',
      );
    }
    try {
      ioSeam.onPhase?.('directory-fsync');
      if (authorityState === undefined || directoryFd === undefined) {
        syncTaktpackOutputDirectory(outputDirectory);
      } else {
        syncHeldTaktpackOutputDirectory(directoryFd);
        try {
          assertAuthorizedParent(authorityState, directoryFd);
          assertPublishedTarget(authorityState, authorityPublishedSnapshot!, 2);
        } catch (error) {
          failAuthorityPublication(error);
        }
        if (
          stagingDirectoryFd === undefined
          || recoveryDirectoryFd === undefined
          || recoveryDirectory === undefined
          || recoveryDirectorySnapshot === undefined
        ) failAuthorityPublication(unsafeOutputTarget());
      }
    } catch (error) {
      if (authorityState !== undefined && published) {
        retainRecoveryArtifacts = true;
        throw unsafeOutputTarget('outputPath', 'published');
      }
      throw normalizeWriterIoError(error, 'DURABILITY_FAILED', 'outputDirectory', 'published');
    }
    result = {
      outputPath,
      archiveSha256: archiveHash.digest('hex'),
      bytes,
    };
  } catch (error) {
    primaryError = retainRecoveryArtifacts
      ? unsafeOutputTarget('outputPath', 'published')
      : normalizeWriterIoError(
        error,
        'ARCHIVE_WRITE_FAILED',
        'archive',
        published ? 'published' : 'not-published',
      );
  } finally {
    try {
      ioSeam.onPhase?.('cleanup');
      if (!retainRecoveryArtifacts && authorityState !== undefined) {
        if (
          directoryFd === undefined
          || stagingDirectoryFd === undefined
          || recoveryDirectoryFd === undefined
          || recoveryDirectory === undefined
          || recoveryDirectorySnapshot === undefined
        ) failAuthorityCleanup();
        const heldOutputDirectoryFd = directoryFd!;
        const heldStagingDirectoryFd = stagingDirectoryFd!;
        const heldRecoveryDirectoryFd = recoveryDirectoryFd!;
        const heldRecoveryDirectory = recoveryDirectory!;
        const heldRecoveryDirectorySnapshot = recoveryDirectorySnapshot!;
        const heldPublishedSnapshot = authorityPublishedSnapshot;
        let heldTempWitness:
          | import('node:fs').Stats
          | TaktpackOutputTargetSnapshot
          | undefined = heldPublishedSnapshot;
        assertAuthorizedParent(authorityState, heldOutputDirectoryFd);
        assertAuthorizedStagingParent(authorityState, heldStagingDirectoryFd);
        assertAuthorizedRecoveryDirectory(
          heldRecoveryDirectory,
          heldRecoveryDirectorySnapshot,
          heldRecoveryDirectoryFd,
        );

        // Why: Node has no unlinkat/renameat2 authority API. As in the stale
        // lock recovery boundary, moving the whole private 0700 namespace into
        // a fresh private quarantine makes fixed child names safe to inspect
        // and remove. Same-UID arbitrary malicious filesystem actors remain
        // outside this boundary; parent ownership and write bits are sealed.
        const quarantineRoot = mkdtempSync(join(
          authorityState.stagingDirectory,
          '.taktpack-cleanup-',
        ));
        chmodSync(quarantineRoot, 0o700);
        const quarantineFd = openSync(
          quarantineRoot,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        let quarantineClosed = false;
        try {
          const quarantineStat = fstatSync(quarantineFd);
          const quarantineSnapshot: TaktpackDirectorySnapshot = Object.freeze({
            dev: quarantineStat.dev,
            ino: quarantineStat.ino,
            mode: quarantineStat.mode,
            uid: quarantineStat.uid,
            gid: quarantineStat.gid,
          });
          if (
            quarantineStat.dev !== authorityState.projection.stagingParent.dev
            || quarantineStat.uid !== authorityState.projection.stagingParent.uid
          ) failAuthorityCleanup();
          assertAuthorizedRecoveryDirectory(
            quarantineRoot,
            quarantineSnapshot,
            quarantineFd,
          );
          const quarantinedRecovery = join(quarantineRoot, 'owned');
          ioSeam.onPhase?.('recovery-quarantine');
          assertAuthorizedStagingParent(authorityState, heldStagingDirectoryFd);
          assertAuthorizedRecoveryDirectory(
            heldRecoveryDirectory,
            heldRecoveryDirectorySnapshot,
            heldRecoveryDirectoryFd,
          );
          renameSync(heldRecoveryDirectory, quarantinedRecovery);
          recoveryDirectory = quarantinedRecovery;
          tempPath = join(quarantinedRecovery, 'archive.tmp');
          if (rollbackPath !== undefined) rollbackPath = join(
            quarantinedRecovery,
            'rollback',
          );
          syncHeldTaktpackOutputDirectory(heldStagingDirectoryFd);
          syncHeldTaktpackOutputDirectory(quarantineFd);
          assertAuthorizedStagingParent(authorityState, heldStagingDirectoryFd);
          assertAuthorizedRecoveryDirectory(
            quarantinedRecovery,
            heldRecoveryDirectorySnapshot,
            heldRecoveryDirectoryFd,
          );
          const allowed = new Set(['archive.tmp', 'rollback']);
          const recoveryEntries = readdirSync(quarantinedRecovery);
          if (recoveryEntries.some((name) => !allowed.has(name))) {
            failAuthorityCleanup();
          }

          const tempPresent = recoveryEntries.includes('archive.tmp');
          if (tempPresent && heldTempWitness === undefined) {
            const freshWitness = capturePrivateRecoveryFileWitness(
              tempPath,
              authorityState.projection.stagingParent.uid,
            );
            if (freshWitness === undefined) failAuthorityCleanup();
            heldTempWitness = freshWitness;
          }
          if (tempPresent && heldTempWitness === undefined) {
            failAuthorityCleanup();
          }

          const unlinkTemp = (): void => unlinkAuthorizedStagingEntry(
            tempPath,
            {
              unlink: 'staging-temp-unlink',
              directoryFsync: 'staging-temp-directory-fsync',
              parentWitness: 'staging-temp-parent-witness',
            },
            authorityState,
            heldStagingDirectoryFd,
            quarantinedRecovery,
            heldRecoveryDirectorySnapshot,
            heldRecoveryDirectoryFd,
            ioSeam,
            () => assertStagingFileIdentity(
              tempPath,
              heldTempWitness!,
              published ? 2 : 1,
            ),
          );
          const unlinkRollback = (): void => {
            const target = authorityState.projection.target;
            if (rollbackPath === undefined || target.state !== 'regular-file') {
              throw unsafeOutputTarget('outputPath', 'published');
            }
            unlinkAuthorizedStagingEntry(
              rollbackPath,
              {
                unlink: restorationPending
                  ? 'rollback-unlink'
                  : 'staging-rollback-unlink',
                directoryFsync: restorationPending
                  ? 'rollback-staging-directory-fsync'
                  : 'staging-rollback-directory-fsync',
                parentWitness: restorationPending
                  ? 'rollback-staging-parent-witness'
                  : 'staging-rollback-parent-witness',
              },
              authorityState,
              heldStagingDirectoryFd,
              quarantinedRecovery,
              heldRecoveryDirectorySnapshot,
              heldRecoveryDirectoryFd,
              ioSeam,
              () => {
                if (!verifyEvacuatedTargetWitness(
                  target.snapshot,
                  rollbackPath!,
                  restorationPending ? 2 : 1,
                  ioSeam,
                  'rollback-final-witness-close',
                )) throw unsafeOutputTarget('outputPath', 'published');
              },
            );
            rollbackPath = undefined;
          };

          if (restorationPending) unlinkRollback();
          else if (tempPresent) unlinkTemp();
          if (restorationPending) {
            ioSeam.onPhase?.('rollback-final-directory-fsync');
            syncHeldTaktpackOutputDirectory(heldOutputDirectoryFd);
            ioSeam.onPhase?.('rollback-final-witness');
            const target = authorityState.projection.target;
            if (
              target.state !== 'regular-file'
              || !verifyEvacuatedTargetWitness(
                target.snapshot,
                outputPath,
                1,
                ioSeam,
                'rollback-final-witness-close',
              )
            ) failAuthorityCleanup();
            if (tempPresent) unlinkTemp();
          } else if (rollbackPath !== undefined) {
            unlinkRollback();
          }
          if (published) {
            syncHeldTaktpackOutputDirectory(heldOutputDirectoryFd);
            assertAuthorizedParent(authorityState, heldOutputDirectoryFd);
            assertPublishedTarget(authorityState, heldPublishedSnapshot!, 1);
          }

          ioSeam.onPhase?.('recovery-directory-close');
          closeSync(heldRecoveryDirectoryFd);
          recoveryDirectoryFd = undefined;
          rmdirSync(quarantinedRecovery);
          syncHeldTaktpackOutputDirectory(quarantineFd);
          assertAuthorizedRecoveryDirectory(
            quarantineRoot,
            quarantineSnapshot,
            quarantineFd,
          );
          ioSeam.onPhase?.('quarantine-directory-close');
          closeSync(quarantineFd);
          quarantineClosed = true;
          rmdirSync(quarantineRoot);
          syncHeldTaktpackOutputDirectory(heldStagingDirectoryFd);
          assertAuthorizedStagingParent(authorityState, heldStagingDirectoryFd);
          recoveryDirectory = undefined;
          recoveryDirectorySnapshot = undefined;
        } finally {
          if (!quarantineClosed) {
            try { closeSync(quarantineFd); } catch { /* retained uncertainty */ }
          }
        }
      } else if (!retainRecoveryArtifacts && authorityState === undefined) {
        if (existsSync(tempPath)) unlinkSync(tempPath);
        if (rollbackPath !== undefined && existsSync(rollbackPath)) {
          unlinkSync(rollbackPath);
        }
      }
    } catch (caughtCleanupError) {
      // Cleanup must never replace the primary failure: callers need the
      // operation that caused the archive to fail, without a raw temp path.
      if (authorityState !== undefined) {
        retainRecoveryArtifacts = true;
        primaryError = unsafeOutputTarget('outputPath', 'published');
      } else if (primaryError === undefined) {
        cleanupFailure = caughtCleanupError;
      }
    }
    const heldDirectories = [
      { fd: recoveryDirectoryFd, phase: 'recovery-directory-close' as const },
      { fd: directoryFd, phase: 'output-directory-close' as const },
      { fd: stagingDirectoryFd, phase: 'staging-directory-close' as const },
    ];
    for (const { fd, phase } of heldDirectories) {
      if (fd === undefined) continue;
      let closeFailed = false;
      try {
        ioSeam.onPhase?.(phase);
      } catch {
        closeFailed = true;
      }
      try {
        closeSync(fd);
      } catch {
        closeFailed = true;
      }
      if (closeFailed && authorityState !== undefined) {
        retainRecoveryArtifacts = true;
        primaryError = unsafeOutputTarget('outputPath', 'published');
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
