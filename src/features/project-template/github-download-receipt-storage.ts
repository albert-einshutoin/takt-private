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
  createGithubTemplateDownloadReceiptTempName,
  deriveGithubTemplateDownloadArtifactPaths,
  deriveGithubTemplateDownloadReceiptLocatorPaths,
  type GithubTemplateDownloadArtifactPaths,
  type GithubTemplateDownloadReceiptLocatorPaths,
} from './github-download-receipt-paths.js';
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

const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const DIRECTORY_FLAG = process.platform === 'win32' ? 0 : constants.O_DIRECTORY;
const STORED_RECEIPT_CLAIM_BRAND: unique symbol =
  Symbol('stored-github-template-download-receipt-claim');

export type GithubTemplateDownloadReceiptState =
  | 'none'
  | 'temporary-only'
  | 'receipt-present'
  | 'receipt-published';

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
    public readonly receiptState: GithubTemplateDownloadReceiptState = 'none',
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
  readonly directoryDurability: 'synced' | 'unsupported';
}

export interface ClaimedStoredGithubTemplateDownloadReceipt {
  readonly stored: StoredGithubTemplateDownloadReceipt;
  readonly [STORED_RECEIPT_CLAIM_BRAND]: true;
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
  readonly artifacts: {
    temporaryPath?: string;
    finalPath?: string;
    publicationSynced: boolean;
  };
  artifact?: FileAuthority;
  temporary?: FileAuthority;
  final?: FileAuthority;
  receiptParent?: DirectoryAuthority;
}

const STORED_RECEIPT_AUTHORITIES = new WeakMap<
  object,
  { state: 'active' | 'consuming' | 'consumed' }
>();
const STORED_RECEIPT_CLAIMS = new WeakMap<
  object,
  {
    readonly stored: StoredGithubTemplateDownloadReceipt;
    readonly authority: { state: 'active' | 'consuming' | 'consumed' };
  }
>();

function storageError(
  code: GithubTemplateDownloadReceiptStorageErrorCode,
  message: string,
  receiptState: GithubTemplateDownloadReceiptState = 'none',
): GithubTemplateDownloadReceiptStorageError {
  return Object.freeze(
    new GithubTemplateDownloadReceiptStorageError(
      code,
      message,
      receiptState,
    ),
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
    || (
      process.platform !== 'win32'
      && typeof process.getuid === 'function'
      && stat.uid !== process.getuid()
    )
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
  try {
    mkdirSync(path, { mode: 0o700 });
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
    // EEXIST is not durability evidence. Sync the retained parent after the
    // child has been opened and identity-checked on both creation paths.
    syncDescriptor(parent.fd, 'directory', io);
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
    || (
      process.platform !== 'win32'
      && typeof process.getuid === 'function'
      && stat.uid !== process.getuid()
    )
  ) throw new Error();
}

function openFile(
  path: string,
  expectedDevice: number,
  expectedBytes: number,
  writable = false,
): FileAuthority {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(path) !== path
    ) throw new Error();
    requireFileStat(pathStat, expectedDevice, expectedBytes, 1);
    // Artifact authorities remain read-only. An EEXIST receipt winner needs a
    // writable descriptor because FlushFileBuffers on a Windows read-only
    // handle fails with access denied.
    fd = openSync(
      path,
      (writable ? constants.O_RDWR : constants.O_RDONLY) | NO_FOLLOW,
    );
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

function readExactNative(fd: number, bytes: number): Buffer {
  return readExact(fd, bytes, undefined);
}

function hashFileNative(authority: FileAuthority): string {
  return createHash('sha256')
    .update(readExactNative(authority.fd, authority.bytes))
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

/** @internal Makes the Windows directory-fsync limitation explicit to D2b. */
export function githubTemplateReceiptDirectoryDurability(
  platform: NodeJS.Platform = process.platform,
): 'synced' | 'unsupported' {
  return platform === 'win32' ? 'unsupported' : 'synced';
}

function syncDescriptor(
  fd: number,
  kind: 'file' | 'directory',
  io: IoSnapshot | undefined,
): 'synced' | 'unsupported' {
  if (
    kind === 'directory'
    && githubTemplateReceiptDirectoryDurability() === 'unsupported'
  ) return 'unsupported';
  try {
    if (io?.fsync === undefined) fsyncSync(fd);
    else Reflect.apply(io.fsync, io.receiver, [fd, kind]);
  } catch {
    throw storageError('IO_FAILURE', 'GitHub template receipt sync failed');
  }
  return 'synced';
}

function runCloseHook(
  fd: number,
  kind: 'artifact' | 'temporary' | 'final' | 'directory',
  io: IoSnapshot | undefined,
): GithubTemplateDownloadReceiptStorageError | undefined {
  try {
    if (io?.close !== undefined) {
      Reflect.apply(io.close, io.receiver, [fd, kind]);
    }
  } catch {
    return storageError('IO_FAILURE', 'GitHub template receipt close failed');
  }
  return undefined;
}

function closeDescriptor(
  fd: number,
): GithubTemplateDownloadReceiptStorageError | undefined {
  try {
    closeSync(fd);
  } catch {
    return storageError('IO_FAILURE', 'GitHub template receipt close failed');
  }
  return undefined;
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
  paths: GithubTemplateDownloadArtifactPaths,
  io: IoSnapshot | undefined,
  context: StoreContext,
): Promise<FileAuthority> {
  const archive = receipt.payload.archive;
  const shaRoot = openDirectory(paths.artifactDirectory, cacheRoot.device);
  context.directories.push(shaRoot);
  let artifact: FileAuthority | undefined;
  try {
    const artifactPath = paths.artifactPath;
    if (dirname(artifactPath) !== shaRoot.path) throw new Error();
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
  paths: GithubTemplateDownloadReceiptLocatorPaths,
  io: IoSnapshot | undefined,
  context: StoreContext,
): DirectoryAuthority {
  let current = cacheRoot;
  for (const path of paths.receiptAncestors) {
    if (dirname(path) !== current.path) {
      throw storageError(
        'CACHE_INVALID',
        'GitHub template receipt ancestor path is invalid',
      );
    }
    const name = basename(path);
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
  context: StoreContext,
): FileAuthority {
  const name = createGithubTemplateDownloadReceiptTempName({
    pid: process.pid,
    uuid: randomUUID(),
    receiptKey,
  });
  const path = join(parent.path, name);
  if (
    dirname(path) !== parent.path
    || basename(path) !== name
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
    context.artifacts.temporaryPath = path;
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
  finalPath: string,
  serialized: string,
  receiptKey: string,
  verifier: VerifierSnapshot,
  io: IoSnapshot | undefined,
  context: StoreContext,
): Promise<'stored' | 'existing'> {
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
    context.artifacts.finalPath = finalPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw storageError(
        'IO_FAILURE',
        'GitHub template receipt publication failed',
      );
    }
    context.artifacts.finalPath = finalPath;
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
    context.artifacts.publicationSynced = true;
  }
  runPhase(io, 'before-receipt-temp-unlink', temporary.path);
  unlinkOwnedTemporary(temporary, linked ? 2 : 1, io);
  runPhase(io, 'before-receipt-unlink-fsync', parent.path);
  assertDirectory(parent);
  syncDescriptor(parent.fd, 'directory', io);

  runPhase(io, 'before-receipt-final-verify', finalPath);
  assertDirectory(parent);
  let final: FileAuthority;
  try {
    final = openFile(
      finalPath,
      parent.device,
      Buffer.byteLength(serialized, 'utf8'),
      !linked,
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
  if (linked) {
    // The newly-linked inode is the already-fsynced writable temporary
    // authority. Do not reopen or flush the read-only final handle on Windows.
    requireFileStat(
      fstatSync(temporary.fd),
      temporary.device,
      temporary.bytes,
      1,
    );
  } else {
    syncDescriptor(final.fd, 'file', io);
    assertFile(final, 1);
  }
  assertDirectory(parent);
  syncDescriptor(parent.fd, 'directory', io);
  context.artifacts.publicationSynced = true;
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

function receiptPathExists(path: string | undefined): boolean {
  if (path === undefined) return false;
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    // Any result other than authoritative ENOENT is an uncertain retained
    // receipt and must not be reported as absent.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function classifyReceiptState(
  context: StoreContext,
): GithubTemplateDownloadReceiptState {
  if (context.artifacts.publicationSynced) return 'receipt-published';
  if (receiptPathExists(context.artifacts.finalPath)) {
    return 'receipt-present';
  }
  if (receiptPathExists(context.artifacts.temporaryPath)) {
    return 'temporary-only';
  }
  return 'none';
}

function withReceiptState(
  error: GithubTemplateDownloadReceiptStorageError,
  context: StoreContext,
): GithubTemplateDownloadReceiptStorageError {
  return storageError(
    error.code,
    error.message,
    classifyReceiptState(context),
  );
}

function contextDescriptors(
  context: StoreContext,
): ReadonlyArray<readonly [
  number,
  'artifact' | 'temporary' | 'final' | 'directory',
]> {
  const descriptors: Array<readonly [
    number,
    'artifact' | 'temporary' | 'final' | 'directory',
  ]> = [];
  for (const [authority, kind] of [
    [context.final, 'final'],
    [context.temporary, 'temporary'],
    [context.artifact, 'artifact'],
  ] as const) {
    if (authority !== undefined) descriptors.push([authority.fd, kind]);
  }
  for (const directory of [...context.directories].reverse()) {
    descriptors.push([directory.fd, 'directory']);
  }
  return descriptors;
}

function runContextCloseHooks(
  context: StoreContext,
  io: IoSnapshot | undefined,
): GithubTemplateDownloadReceiptStorageError | undefined {
  let failure: GithubTemplateDownloadReceiptStorageError | undefined;
  for (const [fd, kind] of contextDescriptors(context)) {
    const closeFailure = runCloseHook(fd, kind, io);
    if (failure === undefined) failure = closeFailure;
  }
  return failure;
}

function closeContextDescriptors(
  context: StoreContext,
): GithubTemplateDownloadReceiptStorageError | undefined {
  let failure: GithubTemplateDownloadReceiptStorageError | undefined;
  for (const [fd] of contextDescriptors(context)) {
    const closeFailure = closeDescriptor(fd);
    if (failure === undefined) failure = closeFailure;
  }
  return failure;
}

async function verifyJointAsyncPreflight(
  context: StoreContext,
  receipt: GithubTemplateDownloadReceiptV1,
  serialized: string,
  receiptKey: string,
  verifier: VerifierSnapshot,
  io: IoSnapshot | undefined,
): Promise<void> {
  try {
    if (
      context.artifact === undefined
      || context.final === undefined
      || context.receiptParent === undefined
    ) throw new Error();
    for (const directory of context.directories) assertDirectory(directory);
    assertFile(context.artifact, 1);
    assertFile(context.final, 1);
    if (
      hashFile(context.artifact, io) !== receipt.payload.archive.sha256
    ) throw new Error();
    const bytes = readExact(context.final.fd, context.final.bytes, io);
    await verifyReceiptBytes(
      bytes,
      serialized,
      receiptKey,
      verifier,
      false,
    );
  } catch {
    throw storageError(
      'CACHE_INVALID',
      'GitHub template receipt joint preflight failed',
    );
  }
}

function verifyJointAndCloseSynchronously(
  context: StoreContext,
  receipt: GithubTemplateDownloadReceiptV1,
  serialized: string,
  receiptKey: string,
): GithubTemplateDownloadReceiptStorageError | undefined {
  let failure: GithubTemplateDownloadReceiptStorageError | undefined;
  try {
    if (
      context.artifact === undefined
      || context.final === undefined
      || context.receiptParent === undefined
    ) throw new Error();
    const finalArtifactSha256 = hashFileNative(context.artifact);
    const finalReceiptBytes = readExactNative(
      context.final.fd,
      context.final.bytes,
    );
    const finalSerialized = finalReceiptBytes.toString('utf8');
    if (
      finalArtifactSha256 !== receipt.payload.archive.sha256
      || finalSerialized !== serialized
      || calculateGithubTemplateDownloadReceiptKey(finalSerialized)
        !== receiptKey
    ) throw new Error();
    // The final native reads and path↔FD assertions share one synchronous call
    // stack with every native close attempt. No callback, Promise resolution,
    // or await boundary can run between this assertion and descriptor close.
    for (const directory of context.directories) assertDirectory(directory);
    assertFile(context.artifact, 1);
    assertFile(context.final, 1);
  } catch {
    failure = storageError(
      'CACHE_INVALID',
      'GitHub template receipt joint authority changed before close',
    );
  }
  const closeFailure = closeContextDescriptors(context);
  return failure ?? closeFailure;
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
  const context: StoreContext = {
    directories: [],
    artifacts: { publicationSynced: false },
  };
  let result: StoredGithubTemplateDownloadReceipt | undefined;
  let jointReceipt: GithubTemplateDownloadReceiptV1 | undefined;
  let jointSerialized: string | undefined;
  let jointReceiptKey: string | undefined;
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
    const receiptPaths = deriveGithubTemplateDownloadReceiptLocatorPaths({
      cacheRoot: requestedRoot,
      receiptKey: prepared.receiptKey,
    });
    // Why: artifact authority is derived only after D2a authenticates the
    // receipt above; receipt-key lookup must not grant artifact authority.
    const artifactPaths = deriveGithubTemplateDownloadArtifactPaths({
      cacheRoot: requestedRoot,
      archiveSha256: parsed.payload.archive.sha256,
    });
    context.artifact = await openAndVerifyArtifact(
      cacheRoot,
      parsed,
      artifactPaths,
      options.io,
      context,
    );
    const receiptParent = createReceiptDirectories(
      cacheRoot,
      receiptPaths,
      options.io,
      context,
    );
    context.receiptParent = receiptParent;
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
      context,
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
      receiptPaths.receiptPath,
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
      directoryDurability:
        githubTemplateReceiptDirectoryDurability(),
    });
    jointReceipt = parsed;
    jointSerialized = prepared.serialized;
    jointReceiptKey = prepared.receiptKey;
  } catch (error) {
    failure = normalizeFailure(error);
  }
  const closeHookFailure = runContextCloseHooks(context, options.io);
  if (failure === undefined) failure = closeHookFailure;
  let closedSynchronously = false;
  if (
    failure === undefined
    && jointReceipt !== undefined
    && jointSerialized !== undefined
    && jointReceiptKey !== undefined
  ) {
    try {
      await verifyJointAsyncPreflight(
        context,
        jointReceipt,
        jointSerialized,
        jointReceiptKey,
        options.verifier,
        options.io,
      );
    } catch (error) {
      failure = normalizeFailure(error);
    }
    if (failure === undefined) {
      failure = verifyJointAndCloseSynchronously(
        context,
        jointReceipt,
        jointSerialized,
        jointReceiptKey,
      );
      closedSynchronously = true;
    }
  }
  if (!closedSynchronously) {
    const closeFailure = closeContextDescriptors(context);
    if (failure === undefined) failure = closeFailure;
  }
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
  if (failure !== undefined) throw withReceiptState(failure, context);
  STORED_RECEIPT_AUTHORITIES.set(result!, { state: 'active' });
  return result!;
}

/**
 * Claims only the process-local handoff into D2b. The seal is not offline
 * trust: D2b must reopen and revalidate disk paths, artifact identity, exact
 * canonical bytes, receipt key, and HMAC before using persisted provenance.
 */
export function claimStoredGithubTemplateDownloadReceiptForOfflineRead(
  value: unknown,
): ClaimedStoredGithubTemplateDownloadReceipt {
  const authority = (
    typeof value === 'object' && value !== null
      ? STORED_RECEIPT_AUTHORITIES.get(value)
      : undefined
  );
  if (authority === undefined || authority.state !== 'active') {
    throw storageError(
      'INVALID_AUTHORITY',
      'stored GitHub template receipt authority is invalid',
    );
  }
  authority.state = 'consuming';
  const stored = value as StoredGithubTemplateDownloadReceipt;
  const claim = Object.freeze({
    stored,
    [STORED_RECEIPT_CLAIM_BRAND]: true as const,
  });
  STORED_RECEIPT_CLAIMS.set(claim, { stored, authority });
  return claim;
}

export function consumeStoredGithubTemplateDownloadReceiptOfflineReadClaim(
  value: ClaimedStoredGithubTemplateDownloadReceipt,
): void {
  const claim = (
    typeof value === 'object' && value !== null
      ? STORED_RECEIPT_CLAIMS.get(value)
      : undefined
  );
  if (
    claim === undefined
    || claim.authority.state !== 'consuming'
    || value.stored !== claim.stored
  ) {
    throw storageError(
      'INVALID_AUTHORITY',
      'stored GitHub template receipt claim is invalid',
    );
  }
  STORED_RECEIPT_CLAIMS.delete(value);
  claim.authority.state = 'consumed';
}
