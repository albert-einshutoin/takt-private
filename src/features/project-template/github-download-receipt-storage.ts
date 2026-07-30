import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { inspectTaktpack } from './archive-inspector.js';
import { DEFAULT_TAKTPACK_LIMITS } from './archive-types.js';
import {
  isProjectTemplatePrivateDirectoryMode,
  isProjectTemplatePrivateFileMode,
} from './control-root-contract.js';
import {
  calculateGithubTemplateDownloadReceiptKey,
  claimPreparedGithubTemplateDownloadReceiptForStorage,
  consumePreparedGithubTemplateDownloadReceiptStorageClaim,
  createGithubTemplateDownloadReceiptAuthenticationInput,
  MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES,
  parseGithubTemplateDownloadReceipt,
  type ClaimedPreparedGithubTemplateDownloadReceipt,
  type GithubTemplateDownloadReceiptV1,
} from './github-download-receipt.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECEIPT_TEMP_PATTERN =
  /^\.tmp\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-f0-9]{64}$/;
const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const DIRECTORY_FLAG = process.platform === 'win32' ? 0 : constants.O_DIRECTORY;

export type GithubTemplateDownloadReceiptStorageErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_AUTHORITY'
  | 'AUTHENTICATION_FAILED'
  | 'CACHE_INVALID'
  | 'RECEIPT_CONFLICT'
  | 'IO_FAILURE';

export class GithubTemplateDownloadReceiptStorageError extends Error {
  constructor(
    public readonly code: GithubTemplateDownloadReceiptStorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GithubTemplateDownloadReceiptStorageError';
  }
}

export interface GithubTemplateDownloadReceiptVerifier {
  verify(request: {
    readonly keyId: string;
    readonly input: Uint8Array;
    readonly tag: string;
  }): Promise<'valid' | 'invalid' | 'unavailable'>;
}

export type GithubTemplateDownloadReceiptStoragePhase =
  | 'before-artifact-inspect'
  | 'before-artifact-final-verify'
  | 'before-artifact-success-verify'
  | 'before-receipt-temp-fsync'
  | 'before-receipt-readback'
  | 'before-receipt-link'
  | 'before-receipt-publish-fsync'
  | 'before-receipt-temp-unlink'
  | 'before-receipt-unlink-fsync'
  | 'before-receipt-final-verify';

export interface GithubTemplateDownloadReceiptStorageIoSeam {
  onPhase?(
    phase: GithubTemplateDownloadReceiptStoragePhase,
    path: string,
  ): void;
  read?(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  write?(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  fsync?(fd: number, kind: 'file' | 'directory'): void;
  link?(temporaryPath: string, finalPath: string): void;
  unlink?(temporaryPath: string): void;
  close?(fd: number, kind: 'artifact' | 'temporary' | 'final' | 'directory'): void;
}

export interface StoreGithubTemplateDownloadReceiptOptions {
  readonly prepared: unknown;
  readonly cacheRoot: string;
  readonly verifier: GithubTemplateDownloadReceiptVerifier;
  readonly ioSeam?: GithubTemplateDownloadReceiptStorageIoSeam;
}

export interface StoredGithubTemplateDownloadReceipt {
  readonly receiptKey: string;
  readonly artifactSha256: string;
  readonly bytes: number;
  readonly status: 'stored' | 'existing';
}

interface VerifierSnapshot {
  readonly receiver: object;
  readonly verify: GithubTemplateDownloadReceiptVerifier['verify'];
}

interface IoSnapshot {
  readonly receiver: object;
  readonly onPhase?: GithubTemplateDownloadReceiptStorageIoSeam['onPhase'];
  readonly read?: GithubTemplateDownloadReceiptStorageIoSeam['read'];
  readonly write?: GithubTemplateDownloadReceiptStorageIoSeam['write'];
  readonly fsync?: GithubTemplateDownloadReceiptStorageIoSeam['fsync'];
  readonly link?: GithubTemplateDownloadReceiptStorageIoSeam['link'];
  readonly unlink?: GithubTemplateDownloadReceiptStorageIoSeam['unlink'];
  readonly close?: GithubTemplateDownloadReceiptStorageIoSeam['close'];
}

interface DirectoryAuthority {
  readonly path: string;
  readonly fd: number;
  readonly device: number;
  readonly inode: number;
}

interface FileAuthority {
  readonly path: string;
  readonly fd: number;
  readonly device: number;
  readonly inode: number;
  readonly bytes: number;
}

interface StoreContext {
  readonly directories: DirectoryAuthority[];
  artifact?: FileAuthority;
  temporary?: FileAuthority;
  final?: FileAuthority;
}

function storageError(
  code: GithubTemplateDownloadReceiptStorageErrorCode,
  message: string,
): GithubTemplateDownloadReceiptStorageError {
  return Object.freeze(
    new GithubTemplateDownloadReceiptStorageError(code, message),
  );
}

function ownDataRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || !allowed.includes(key),
    )
    || Object.values(descriptors).some(
      (descriptor) => !('value' in descriptor),
    )
  ) throw new Error();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function snapshotVerifier(value: unknown): VerifierSnapshot {
  const verifier = ownDataRecord(value, ['verify']);
  if (typeof verifier['verify'] !== 'function') throw new Error();
  return Object.freeze({
    receiver: value as object,
    verify: verifier['verify'] as GithubTemplateDownloadReceiptVerifier['verify'],
  });
}

function optionalMethod<T>(
  record: Record<string, unknown>,
  key: string,
): T | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'function') throw new Error();
  return value as T;
}

function snapshotIo(value: unknown): IoSnapshot | undefined {
  if (value === undefined) return undefined;
  const io = ownDataRecord(value, [
    'onPhase',
    'read',
    'write',
    'fsync',
    'link',
    'unlink',
    'close',
  ]);
  return Object.freeze({
    receiver: value as object,
    onPhase: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptStorageIoSeam['onPhase']>
    >(io, 'onPhase'),
    read: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptStorageIoSeam['read']>
    >(io, 'read'),
    write: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptStorageIoSeam['write']>
    >(io, 'write'),
    fsync: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptStorageIoSeam['fsync']>
    >(io, 'fsync'),
    link: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptStorageIoSeam['link']>
    >(io, 'link'),
    unlink: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptStorageIoSeam['unlink']>
    >(io, 'unlink'),
    close: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptStorageIoSeam['close']>
    >(io, 'close'),
  });
}

function snapshotOptions(value: unknown): {
  readonly prepared: unknown;
  readonly cacheRoot: string;
  readonly verifier: VerifierSnapshot;
  readonly io?: IoSnapshot;
} {
  try {
    const options = ownDataRecord(
      value,
      ['prepared', 'cacheRoot', 'verifier', 'ioSeam'],
    );
    if (
      typeof options['cacheRoot'] !== 'string'
      || options['cacheRoot'].length === 0
    ) throw new Error();
    return Object.freeze({
      prepared: options['prepared'],
      cacheRoot: options['cacheRoot'],
      verifier: snapshotVerifier(options['verifier']),
      io: snapshotIo(options['ioSeam']),
    });
  } catch {
    throw storageError(
      'INVALID_ARGUMENT',
      'GitHub template receipt storage options are invalid',
    );
  }
}

function runPhase(
  io: IoSnapshot | undefined,
  phase: GithubTemplateDownloadReceiptStoragePhase,
  path: string,
): void {
  try {
    if (io?.onPhase !== undefined) {
      Reflect.apply(io.onPhase, io.receiver, [phase, path]);
    }
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template receipt storage phase failed',
    );
  }
}

function requireDirectoryStat(
  stat: Stats,
  expectedDevice?: number,
): void {
  if (
    !stat.isDirectory()
    || !isProjectTemplatePrivateDirectoryMode(stat.mode)
    || (expectedDevice !== undefined && stat.dev !== expectedDevice)
  ) throw new Error();
}

function openDirectory(
  path: string,
  expectedDevice?: number,
): DirectoryAuthority {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(path) !== path
    ) throw new Error();
    requireDirectoryStat(pathStat, expectedDevice);
    fd = openSync(path, constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW);
    const opened = fstatSync(fd);
    requireDirectoryStat(opened, expectedDevice);
    if (
      opened.dev !== pathStat.dev
      || opened.ino !== pathStat.ino
    ) throw new Error();
    const authority = {
      path,
      fd,
      device: opened.dev,
      inode: opened.ino,
    };
    fd = undefined;
    return authority;
  } catch {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template receipt directory is unsafe',
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The directory was already rejected.
      }
    }
  }
}

function assertDirectory(authority: DirectoryAuthority): void {
  try {
    const pathStat = lstatSync(authority.path);
    const opened = fstatSync(authority.fd);
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(authority.path) !== authority.path
    ) throw new Error();
    requireDirectoryStat(pathStat, authority.device);
    requireDirectoryStat(opened, authority.device);
    if (
      pathStat.ino !== authority.inode
      || opened.ino !== authority.inode
    ) throw new Error();
  } catch {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template receipt directory authority changed',
    );
  }
}

function ensureDirectory(
  parent: DirectoryAuthority,
  name: string,
  io: IoSnapshot | undefined,
): DirectoryAuthority {
  assertDirectory(parent);
  const path = join(parent.path, name);
  if (dirname(path) !== parent.path || basename(path) !== name) {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template receipt directory path is invalid',
    );
  }
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw storageError(
        'IO_FAILURE',
        'GitHub template receipt directory creation failed',
      );
    }
  }
  const authority = openDirectory(path, parent.device);
  assertDirectory(parent);
  try {
    if (created) syncDescriptor(parent.fd, 'directory', io);
  } catch (error) {
    try {
      closeSync(authority.fd);
    } catch {
      // The directory creation path has already failed closed.
    }
    throw error;
  }
  return authority;
}

function requireFileStat(
  stat: Stats,
  expectedDevice: number,
  expectedBytes: number,
  expectedLinks: 1 | 2,
): void {
  if (
    !stat.isFile()
    || stat.dev !== expectedDevice
    || stat.nlink !== expectedLinks
    || stat.size !== expectedBytes
    || !isProjectTemplatePrivateFileMode(stat.mode)
  ) throw new Error();
}

function openFile(
  path: string,
  expectedDevice: number,
  expectedBytes: number,
): FileAuthority {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(path) !== path
    ) throw new Error();
    requireFileStat(pathStat, expectedDevice, expectedBytes, 1);
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    requireFileStat(opened, expectedDevice, expectedBytes, 1);
    if (
      opened.dev !== pathStat.dev
      || opened.ino !== pathStat.ino
    ) throw new Error();
    const authority = {
      path,
      fd,
      device: opened.dev,
      inode: opened.ino,
      bytes: expectedBytes,
    };
    fd = undefined;
    return authority;
  } catch {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template receipt artifact is unsafe',
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The file was already rejected.
      }
    }
  }
}

function assertFile(
  authority: FileAuthority,
  expectedLinks: 1 | 2,
): void {
  try {
    const pathStat = lstatSync(authority.path);
    const opened = fstatSync(authority.fd);
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(authority.path) !== authority.path
    ) throw new Error();
    requireFileStat(
      pathStat,
      authority.device,
      authority.bytes,
      expectedLinks,
    );
    requireFileStat(
      opened,
      authority.device,
      authority.bytes,
      expectedLinks,
    );
    if (
      pathStat.ino !== authority.inode
      || opened.ino !== authority.inode
    ) throw new Error();
  } catch {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template receipt file authority changed',
    );
  }
}

function readChunk(
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
  io: IoSnapshot | undefined,
): number {
  let bytesRead: unknown;
  try {
    bytesRead = io?.read === undefined
      ? readSync(fd, buffer, offset, length, position)
      : Reflect.apply(io.read, io.receiver, [
        fd,
        buffer,
        offset,
        length,
        position,
      ]);
  } catch {
    throw storageError('IO_FAILURE', 'GitHub template receipt read failed');
  }
  if (
    !Number.isSafeInteger(bytesRead)
    || (bytesRead as number) <= 0
    || (bytesRead as number) > length
  ) {
    throw storageError(
      'IO_FAILURE',
      'GitHub template receipt read made invalid progress',
    );
  }
  return bytesRead as number;
}

function readExact(
  fd: number,
  bytes: number,
  io: IoSnapshot | undefined,
): Buffer {
  const result = Buffer.allocUnsafe(bytes);
  let position = 0;
  while (position < bytes) {
    position += readChunk(
      fd,
      result,
      position,
      bytes - position,
      position,
      io,
    );
  }
  try {
    const extra = Buffer.allocUnsafe(1);
    const count = io?.read === undefined
      ? readSync(fd, extra, 0, 1, bytes)
      : Reflect.apply(io.read, io.receiver, [fd, extra, 0, 1, bytes]);
    if (count !== 0) throw new Error();
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template receipt size verification failed',
    );
  }
  return result;
}

function hashFile(
  authority: FileAuthority,
  io: IoSnapshot | undefined,
): string {
  return createHash('sha256')
    .update(readExact(authority.fd, authority.bytes, io))
    .digest('hex');
}

function writeAll(
  fd: number,
  content: Uint8Array,
  io: IoSnapshot | undefined,
): void {
  let position = 0;
  while (position < content.byteLength) {
    let written: unknown;
    try {
      written = io?.write === undefined
        ? writeSync(
          fd,
          content,
          position,
          content.byteLength - position,
          position,
        )
        : Reflect.apply(io.write, io.receiver, [
          fd,
          content,
          position,
          content.byteLength - position,
          position,
        ]);
    } catch {
      throw storageError('IO_FAILURE', 'GitHub template receipt write failed');
    }
    if (
      !Number.isSafeInteger(written)
      || (written as number) <= 0
      || (written as number) > content.byteLength - position
    ) {
      throw storageError(
        'IO_FAILURE',
        'GitHub template receipt write made invalid progress',
      );
    }
    position += written as number;
  }
}

function syncDescriptor(
  fd: number,
  kind: 'file' | 'directory',
  io: IoSnapshot | undefined,
): void {
  if (kind === 'directory' && process.platform === 'win32') return;
  try {
    if (io?.fsync === undefined) fsyncSync(fd);
    else Reflect.apply(io.fsync, io.receiver, [fd, kind]);
  } catch {
    throw storageError('IO_FAILURE', 'GitHub template receipt sync failed');
  }
}

function closeDescriptor(
  fd: number,
  kind: 'artifact' | 'temporary' | 'final' | 'directory',
  io: IoSnapshot | undefined,
): GithubTemplateDownloadReceiptStorageError | undefined {
  let failed = false;
  try {
    if (io?.close !== undefined) {
      Reflect.apply(io.close, io.receiver, [fd, kind]);
    }
  } catch {
    failed = true;
  }
  try {
    closeSync(fd);
  } catch {
    failed = true;
  }
  return failed
    ? storageError('IO_FAILURE', 'GitHub template receipt close failed')
    : undefined;
}

async function verifyAuthentication(
  receipt: GithubTemplateDownloadReceiptV1,
  verifier: VerifierSnapshot,
): Promise<'valid' | 'invalid' | 'unavailable'> {
  try {
    const request = Object.freeze({
      keyId: receipt.authentication.keyId,
      input: createGithubTemplateDownloadReceiptAuthenticationInput(receipt),
      tag: receipt.authentication.tag,
    });
    const result = await Reflect.apply(
      verifier.verify,
      verifier.receiver,
      [request],
    );
    if (
      result !== 'valid'
      && result !== 'invalid'
      && result !== 'unavailable'
    ) throw new Error();
    return result;
  } catch {
    throw storageError(
      'AUTHENTICATION_FAILED',
      'GitHub template receipt authentication failed',
    );
  }
}

function requireArtifactBinding(
  receipt: GithubTemplateDownloadReceiptV1,
  inspection: Awaited<ReturnType<typeof inspectTaktpack>>,
): void {
  const archive = receipt.payload.archive;
  const source = receipt.payload.source;
  if (
    inspection.archiveSha256 !== archive.sha256
    || inspection.manifestSha256 !== archive.manifestSha256
    || inspection.manifest.packVersion !== archive.version
    || inspection.manifest.source.kind !== 'github'
    || inspection.manifest.source.uri !== source.repositoryUrl
    || inspection.manifest.source.commit !== source.commit
    || inspection.manifest.source.ref !== source.releaseTag
    || inspection.manifest.takt.minVersion !== archive.takt.minVersion
    || inspection.manifest.takt.maxVersion !== archive.takt.maxVersion
  ) {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template receipt artifact binding is invalid',
    );
  }
}

async function openAndVerifyArtifact(
  cacheRoot: DirectoryAuthority,
  receipt: GithubTemplateDownloadReceiptV1,
  io: IoSnapshot | undefined,
  context: StoreContext,
): Promise<FileAuthority> {
  const archive = receipt.payload.archive;
  const shaRootPath = join(cacheRoot.path, 'sha256');
  const shaRoot = openDirectory(shaRootPath, cacheRoot.device);
  context.directories.push(shaRoot);
  let artifact: FileAuthority | undefined;
  try {
    const artifactPath = join(shaRoot.path, `${archive.sha256}.taktpack`);
    if (
      dirname(artifactPath) !== shaRoot.path
      || !SHA256_PATTERN.test(archive.sha256)
    ) throw new Error();
    artifact = openFile(artifactPath, cacheRoot.device, archive.bytes);
    context.artifact = artifact;
    if (hashFile(artifact, io) !== archive.sha256) {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template receipt artifact digest is invalid',
      );
    }
    runPhase(io, 'before-artifact-inspect', artifactPath);
    let inspection: Awaited<ReturnType<typeof inspectTaktpack>>;
    try {
      inspection = await inspectTaktpack(artifactPath, {
        limits: {
          maxArchiveBytes: DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes,
        },
      });
    } catch {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template receipt artifact inspection failed',
      );
    }
    requireArtifactBinding(receipt, inspection);
    assertDirectory(cacheRoot);
    assertDirectory(shaRoot);
    assertFile(artifact, 1);
    if (hashFile(artifact, io) !== archive.sha256) {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template receipt artifact changed',
      );
    }
    return artifact;
  } catch (error) {
    if (error instanceof GithubTemplateDownloadReceiptStorageError) {
      throw error;
    }
    throw storageError(
      'CACHE_INVALID',
      'GitHub template receipt artifact verification failed',
    );
  }
}

function createReceiptDirectories(
  cacheRoot: DirectoryAuthority,
  receiptKey: string,
  io: IoSnapshot | undefined,
  context: StoreContext,
): DirectoryAuthority {
  let current = cacheRoot;
  for (const name of ['receipts', 'v1', 'sha256', receiptKey.slice(0, 2)]) {
    current = ensureDirectory(current, name, io);
    context.directories.push(current);
  }
  return current;
}

function createTemporaryReceipt(
  parent: DirectoryAuthority,
  receiptKey: string,
  content: Uint8Array,
  io: IoSnapshot | undefined,
): FileAuthority {
  const path = join(
    parent.path,
    `.tmp.${process.pid}.${randomUUID()}.${receiptKey}`,
  );
  if (
    dirname(path) !== parent.path
    || !RECEIPT_TEMP_PATTERN.test(basename(path))
  ) {
    throw storageError(
      'IO_FAILURE',
      'GitHub template receipt temporary path is invalid',
    );
  }
  let fd: number | undefined;
  try {
    assertDirectory(parent);
    fd = openSync(
      path,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | NO_FOLLOW,
      0o600,
    );
    const created = fstatSync(fd);
    requireFileStat(created, parent.device, 0, 1);
    writeAll(fd, content, io);
    const authority = {
      path,
      fd,
      device: created.dev,
      inode: created.ino,
      bytes: content.byteLength,
    };
    assertFile(authority, 1);
    fd = undefined;
    return authority;
  } catch (error) {
    if (error instanceof GithubTemplateDownloadReceiptStorageError) {
      throw error;
    }
    throw storageError(
      'IO_FAILURE',
      'GitHub template receipt temporary creation failed',
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Temporary creation has already failed closed.
      }
    }
  }
}

async function verifyReceiptBytes(
  bytes: Uint8Array,
  expectedSerialized: string,
  expectedKey: string,
  verifier: VerifierSnapshot,
  conflict: boolean,
): Promise<GithubTemplateDownloadReceiptV1> {
  try {
    const serialized = Buffer.from(bytes).toString('utf8');
    const parsed = parseGithubTemplateDownloadReceipt(bytes);
    if (
      serialized !== expectedSerialized
      || calculateGithubTemplateDownloadReceiptKey(serialized) !== expectedKey
      || await verifyAuthentication(parsed, verifier) !== 'valid'
    ) throw new Error();
    return parsed;
  } catch {
    throw storageError(
      conflict ? 'RECEIPT_CONFLICT' : 'IO_FAILURE',
      conflict
        ? 'GitHub template receipt conflicts with the retained winner'
        : 'GitHub template receipt readback verification failed',
    );
  }
}

function unlinkOwnedTemporary(
  temporary: FileAuthority,
  expectedLinks: 1 | 2,
  io: IoSnapshot | undefined,
): void {
  assertFile(temporary, expectedLinks);
  try {
    if (io?.unlink !== undefined) {
      Reflect.apply(io.unlink, io.receiver, [temporary.path]);
    }
    unlinkSync(temporary.path);
  } catch {
    throw storageError(
      'IO_FAILURE',
      'GitHub template receipt temporary cleanup failed',
    );
  }
}

async function publishReceipt(
  parent: DirectoryAuthority,
  temporary: FileAuthority,
  serialized: string,
  receiptKey: string,
  verifier: VerifierSnapshot,
  io: IoSnapshot | undefined,
  context: StoreContext,
): Promise<'stored' | 'existing'> {
  const finalPath = join(parent.path, `${receiptKey}.json`);
  if (
    dirname(finalPath) !== parent.path
    || basename(finalPath) !== `${receiptKey}.json`
  ) throw storageError('IO_FAILURE', 'GitHub template receipt final path is invalid');
  let linked = false;
  let publishedInode: number | undefined;
  runPhase(io, 'before-receipt-link', temporary.path);
  assertDirectory(parent);
  assertFile(temporary, 1);
  if (io?.link !== undefined) {
    try {
      Reflect.apply(io.link, io.receiver, [temporary.path, finalPath]);
    } catch {
      throw storageError(
        'IO_FAILURE',
        'GitHub template receipt link hook failed',
      );
    }
  }
  try {
    linkSync(temporary.path, finalPath);
    linked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw storageError(
        'IO_FAILURE',
        'GitHub template receipt publication failed',
      );
    }
  }
  if (linked) {
    assertFile(temporary, 2);
    const finalStat = lstatSync(finalPath);
    if (
      finalStat.dev !== temporary.device
      || finalStat.ino !== temporary.inode
      || finalStat.nlink !== 2
    ) {
      throw storageError(
        'IO_FAILURE',
        'GitHub template receipt hard-link publication changed',
      );
    }
    publishedInode = temporary.inode;
    runPhase(io, 'before-receipt-publish-fsync', parent.path);
    assertDirectory(parent);
    syncDescriptor(parent.fd, 'directory', io);
  }
  runPhase(io, 'before-receipt-temp-unlink', temporary.path);
  unlinkOwnedTemporary(temporary, linked ? 2 : 1, io);
  runPhase(io, 'before-receipt-unlink-fsync', parent.path);
  assertDirectory(parent);
  syncDescriptor(parent.fd, 'directory', io);
  const closeFailure = closeDescriptor(
    temporary.fd,
    'temporary',
    io,
  );
  context.temporary = undefined;
  if (closeFailure !== undefined) throw closeFailure;

  runPhase(io, 'before-receipt-final-verify', finalPath);
  let final: FileAuthority;
  try {
    final = openFile(
      finalPath,
      parent.device,
      Buffer.byteLength(serialized, 'utf8'),
    );
  } catch {
    throw storageError(
      'RECEIPT_CONFLICT',
      'GitHub template receipt winner is invalid',
    );
  }
  context.final = final;
  if (publishedInode !== undefined && final.inode !== publishedInode) {
    throw storageError(
      'RECEIPT_CONFLICT',
      'GitHub template receipt published inode changed',
    );
  }
  const finalBytes = readExact(final.fd, final.bytes, io);
  await verifyReceiptBytes(
    finalBytes,
    serialized,
    receiptKey,
    verifier,
    true,
  );
  assertFile(final, 1);
  return linked ? 'stored' : 'existing';
}

function normalizeFailure(
  error: unknown,
): GithubTemplateDownloadReceiptStorageError {
  if (error instanceof GithubTemplateDownloadReceiptStorageError) return error;
  return storageError(
    'IO_FAILURE',
    'GitHub template receipt durable storage failed',
  );
}

function closeContext(
  context: StoreContext,
  io: IoSnapshot | undefined,
): GithubTemplateDownloadReceiptStorageError | undefined {
  let failure: GithubTemplateDownloadReceiptStorageError | undefined;
  for (const [authority, kind] of [
    [context.final, 'final'],
    [context.temporary, 'temporary'],
    [context.artifact, 'artifact'],
  ] as const) {
    if (authority === undefined) continue;
    const closeFailure = closeDescriptor(authority.fd, kind, io);
    if (failure === undefined) failure = closeFailure;
  }
  for (const directory of [...context.directories].reverse()) {
    const closeFailure = closeDescriptor(directory.fd, 'directory', io);
    if (failure === undefined) failure = closeFailure;
  }
  return failure;
}

/**
 * Durably stores one already-prepared authenticated receipt without accepting
 * caller-controlled artifact or receipt paths. D2b owns offline reads and
 * abandoned receipt-temp reclamation.
 */
export async function storeGithubTemplateDownloadReceipt(
  value: StoreGithubTemplateDownloadReceiptOptions,
): Promise<StoredGithubTemplateDownloadReceipt> {
  const options = snapshotOptions(value);
  let claim: ClaimedPreparedGithubTemplateDownloadReceipt;
  try {
    // Claim before the first await so parallel callers cannot share authority.
    claim = claimPreparedGithubTemplateDownloadReceiptForStorage(
      options.prepared,
    );
  } catch {
    throw storageError(
      'INVALID_AUTHORITY',
      'prepared GitHub template receipt authority is invalid',
    );
  }
  const context: StoreContext = { directories: [] };
  let result: StoredGithubTemplateDownloadReceipt | undefined;
  let failure: GithubTemplateDownloadReceiptStorageError | undefined;
  try {
    const prepared = claim.prepared;
    const parsed = parseGithubTemplateDownloadReceipt(prepared.serialized);
    if (
      calculateGithubTemplateDownloadReceiptKey(prepared.serialized)
        !== prepared.receiptKey
      || parsed.authentication.tag !== prepared.receipt.authentication.tag
    ) {
      throw storageError(
        'INVALID_AUTHORITY',
        'prepared GitHub template receipt is inconsistent',
      );
    }
    if (
      await verifyAuthentication(parsed, options.verifier) !== 'valid'
    ) {
      throw storageError(
        'AUTHENTICATION_FAILED',
        'GitHub template receipt authentication was not valid',
      );
    }
    const requestedRoot = resolve(options.cacheRoot);
    if (
      requestedRoot !== options.cacheRoot
      || realpathSync.native(requestedRoot) !== requestedRoot
    ) {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template receipt cache root is not canonical',
      );
    }
    const cacheRoot = openDirectory(requestedRoot);
    context.directories.push(cacheRoot);
    context.artifact = await openAndVerifyArtifact(
      cacheRoot,
      parsed,
      options.io,
      context,
    );
    const receiptParent = createReceiptDirectories(
      cacheRoot,
      prepared.receiptKey,
      options.io,
      context,
    );
    const serializedBytes = Buffer.from(prepared.serialized, 'utf8');
    if (
      serializedBytes.byteLength === 0
      || serializedBytes.byteLength
        > MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES
    ) {
      throw storageError(
        'INVALID_AUTHORITY',
        'prepared GitHub template receipt size is invalid',
      );
    }
    context.temporary = createTemporaryReceipt(
      receiptParent,
      prepared.receiptKey,
      serializedBytes,
      options.io,
    );
    runPhase(
      options.io,
      'before-receipt-temp-fsync',
      context.temporary.path,
    );
    syncDescriptor(context.temporary.fd, 'file', options.io);
    assertFile(context.temporary, 1);
    runPhase(
      options.io,
      'before-receipt-readback',
      context.temporary.path,
    );
    await verifyReceiptBytes(
      readExact(
        context.temporary.fd,
        context.temporary.bytes,
        options.io,
      ),
      prepared.serialized,
      prepared.receiptKey,
      options.verifier,
      false,
    );
    runPhase(
      options.io,
      'before-artifact-final-verify',
      context.artifact.path,
    );
    assertFile(context.artifact, 1);
    if (
      hashFile(context.artifact, options.io)
        !== parsed.payload.archive.sha256
    ) {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template receipt artifact authority changed',
      );
    }
    const status = await publishReceipt(
      receiptParent,
      context.temporary,
      prepared.serialized,
      prepared.receiptKey,
      options.verifier,
      options.io,
      context,
    );
    runPhase(
      options.io,
      'before-artifact-success-verify',
      context.artifact.path,
    );
    assertFile(context.artifact, 1);
    if (
      hashFile(context.artifact, options.io)
        !== parsed.payload.archive.sha256
    ) {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template receipt artifact changed before completion',
      );
    }
    result = Object.freeze({
      receiptKey: prepared.receiptKey,
      artifactSha256: parsed.payload.archive.sha256,
      bytes: serializedBytes.byteLength,
      status,
    });
  } catch (error) {
    failure = normalizeFailure(error);
  }
  const closeFailure = closeContext(context, options.io);
  if (failure === undefined) failure = closeFailure;
  try {
    consumePreparedGithubTemplateDownloadReceiptStorageClaim(claim);
  } catch {
    if (failure === undefined) {
      failure = storageError(
        'INVALID_AUTHORITY',
        'prepared GitHub template receipt claim consumption failed',
      );
    }
  }
  if (failure !== undefined) throw failure;
  return result!;
}
