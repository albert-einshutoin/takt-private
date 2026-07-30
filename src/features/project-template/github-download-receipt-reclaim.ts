import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  unlinkSync,
  type Dir,
  type Stats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { types } from 'node:util';
import {
  isProjectTemplatePrivateDirectoryMode,
  isProjectTemplatePrivateFileMode,
} from './control-root-contract.js';
import {
  deriveGithubTemplateDownloadReceiptLocatorPaths,
  parseGithubTemplateDownloadReceiptTempName,
} from './github-download-receipt-paths.js';
import {
  type GithubTemplateDownloadReceiptVerifier,
} from './github-download-receipt-storage.js';
import {
  calculateGithubTemplateDownloadReceiptKey,
  createGithubTemplateDownloadReceiptAuthenticationInput,
  MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES,
  parseGithubTemplateDownloadReceipt,
  type GithubTemplateDownloadReceiptV1,
} from './github-download-receipt.js';

const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const DIRECTORY_FLAG = process.platform === 'win32' ? 0 : constants.O_DIRECTORY;
const SCAN_LIMIT = 8_192;
const DELETE_LIMIT = 32;
const SHARDS = Object.freeze(
  Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0')),
);
const NATIVE_PROCESS_KILL = process.kill.bind(process);

export type GithubTemplateDownloadReceiptReclaimErrorCode =
  | 'INVALID_ARGUMENT'
  | 'CACHE_INVALID'
  | 'IO_FAILURE';

export class GithubTemplateDownloadReceiptReclaimError extends Error {
  constructor(
    public readonly code: GithubTemplateDownloadReceiptReclaimErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GithubTemplateDownloadReceiptReclaimError';
  }
}

export type GithubTemplateDownloadReceiptReclaimPhase =
  | 'before-reclaim-unlink'
  | 'after-reclaim-unlink'
  | 'before-reclaim-fsync';

export interface GithubTemplateDownloadReceiptReclaimIo {
  onPhase?(
    phase: GithubTemplateDownloadReceiptReclaimPhase,
    path: string,
  ): void;
  processProbe?(
    pid: number,
  ): 'alive' | 'missing' | 'inaccessible';
  read?(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  unlink?(path: string): void;
  fsync?(fd: number): void;
  close?(
    fd: number,
    kind: 'temporary' | 'final' | 'directory',
  ): void;
  closeDirectoryStream?(): void;
}

export interface ReclaimGithubTemplateDownloadReceiptTempsOptions {
  readonly cacheRoot: string;
  readonly verifier: GithubTemplateDownloadReceiptVerifier;
  readonly io?: GithubTemplateDownloadReceiptReclaimIo;
}

export interface ReclaimedGithubTemplateDownloadReceiptTemps {
  readonly scanned: number;
  readonly matched: number;
  readonly dead: number;
  readonly reclaimed: number;
  readonly skipped: number;
  readonly unsafeRetained: number;
  readonly truncated: boolean;
  readonly directoryDurability: 'synced' | 'unsupported';
  readonly status:
    | 'complete'
    | 'scan-limit'
    | 'delete-limit'
    | 'unsafe-retained'
    | 'unsupported';
}

interface VerifierSnapshot {
  readonly receiver: object;
  readonly verify: GithubTemplateDownloadReceiptVerifier['verify'];
}

interface IoSnapshot {
  readonly receiver: object;
  readonly onPhase?: GithubTemplateDownloadReceiptReclaimIo['onPhase'];
  readonly processProbe?: GithubTemplateDownloadReceiptReclaimIo['processProbe'];
  readonly read?: GithubTemplateDownloadReceiptReclaimIo['read'];
  readonly unlink?: GithubTemplateDownloadReceiptReclaimIo['unlink'];
  readonly fsync?: GithubTemplateDownloadReceiptReclaimIo['fsync'];
  readonly close?: GithubTemplateDownloadReceiptReclaimIo['close'];
  readonly closeDirectoryStream?:
    GithubTemplateDownloadReceiptReclaimIo['closeDirectoryStream'];
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
  readonly links: 1 | 2;
}

interface CandidateAuthority {
  readonly temporary: FileAuthority;
  readonly final?: FileAuthority;
  readonly receiptKey: string;
  readonly serialized?: string;
  readonly receipt?: GithubTemplateDownloadReceiptV1;
}

interface ReclaimedFinalEvidence {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly bytes: number;
  readonly receiptKey: string;
  readonly serialized: string;
}

function reclaimError(
  code: GithubTemplateDownloadReceiptReclaimErrorCode,
  message: string,
): GithubTemplateDownloadReceiptReclaimError {
  return Object.freeze(
    new GithubTemplateDownloadReceiptReclaimError(code, message),
  );
}

function ownDataRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
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

function optionalMethod<T>(
  record: Record<string, unknown>,
  key: string,
): T | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'function') throw new Error();
  return value as T;
}

function snapshotVerifier(value: unknown): VerifierSnapshot {
  const verifier = ownDataRecord(value, ['verify']);
  if (typeof verifier['verify'] !== 'function') throw new Error();
  return Object.freeze({
    receiver: value as object,
    verify: verifier['verify'] as GithubTemplateDownloadReceiptVerifier['verify'],
  });
}

function snapshotIo(value: unknown): IoSnapshot | undefined {
  if (value === undefined) return undefined;
  const io = ownDataRecord(value, [
    'onPhase',
    'processProbe',
    'read',
    'unlink',
    'fsync',
    'close',
    'closeDirectoryStream',
  ]);
  return Object.freeze({
    receiver: value as object,
    onPhase: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptReclaimIo['onPhase']>
    >(io, 'onPhase'),
    processProbe: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptReclaimIo['processProbe']>
    >(io, 'processProbe'),
    read: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptReclaimIo['read']>
    >(io, 'read'),
    unlink: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptReclaimIo['unlink']>
    >(io, 'unlink'),
    fsync: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptReclaimIo['fsync']>
    >(io, 'fsync'),
    close: optionalMethod<
      NonNullable<GithubTemplateDownloadReceiptReclaimIo['close']>
    >(io, 'close'),
    closeDirectoryStream: optionalMethod<
      NonNullable<
        GithubTemplateDownloadReceiptReclaimIo['closeDirectoryStream']
      >
    >(io, 'closeDirectoryStream'),
  });
}

function snapshotOptions(
  value: unknown,
): {
  readonly cacheRoot: string;
  readonly verifier: VerifierSnapshot;
  readonly io?: IoSnapshot;
} {
  try {
    const options = ownDataRecord(value, ['cacheRoot', 'verifier', 'io']);
    if (
      typeof options['cacheRoot'] !== 'string'
      || options['cacheRoot'].length === 0
    ) throw new Error();
    deriveGithubTemplateDownloadReceiptLocatorPaths({
      cacheRoot: options['cacheRoot'],
      receiptKey: '0'.repeat(64),
    });
    return Object.freeze({
      cacheRoot: options['cacheRoot'],
      verifier: snapshotVerifier(options['verifier']),
      io: snapshotIo(options['io']),
    });
  } catch {
    throw reclaimError(
      'INVALID_ARGUMENT',
      'GitHub template receipt reclaim options are invalid',
    );
  }
}

function privateOwnerMatches(stat: Stats): boolean {
  return (
    process.platform === 'win32'
    || typeof process.getuid !== 'function'
    || stat.uid === process.getuid()
  );
}

function requireDirectoryStat(stat: Stats, expectedDevice?: number): void {
  if (
    !stat.isDirectory()
    || !isProjectTemplatePrivateDirectoryMode(stat.mode)
    || !privateOwnerMatches(stat)
    || (expectedDevice !== undefined && stat.dev !== expectedDevice)
  ) throw new Error();
}

function openDirectory(
  path: string,
  expectedDevice?: number,
): DirectoryAuthority | undefined {
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
    if (opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) {
      throw new Error();
    }
    const authority = Object.freeze({
      path,
      fd,
      device: opened.dev,
      inode: opened.ino,
    });
    fd = undefined;
    return authority;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw reclaimError(
      'CACHE_INVALID',
      'GitHub template receipt reclaim directory is unsafe',
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The rejected descriptor was never published.
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
    throw reclaimError(
      'CACHE_INVALID',
      'GitHub template receipt reclaim directory authority changed',
    );
  }
}

function openChildDirectory(
  parent: DirectoryAuthority,
  path: string,
  io: IoSnapshot | undefined,
): DirectoryAuthority | undefined {
  if (dirname(path) !== parent.path) {
    throw reclaimError(
      'CACHE_INVALID',
      'GitHub template receipt reclaim directory path is invalid',
    );
  }
  assertDirectory(parent);
  const child = openDirectory(path, parent.device);
  try {
    assertDirectory(parent);
  } catch (error) {
    if (child !== undefined) {
      const closeFailure = closeDescriptor(child, 'directory', io);
      if (error instanceof GithubTemplateDownloadReceiptReclaimError) {
        throw error;
      }
      if (closeFailure !== undefined) throw closeFailure;
    }
    throw error;
  }
  return child;
}

function validCandidateStat(
  stat: Stats,
  expectedDevice: number,
): stat is Stats & { nlink: 1 | 2 } {
  return (
    stat.isFile()
    && stat.dev === expectedDevice
    && (stat.nlink === 1 || stat.nlink === 2)
    && isProjectTemplatePrivateFileMode(stat.mode)
    && privateOwnerMatches(stat)
  );
}

function openCandidateFile(
  path: string,
  expectedDevice: number,
): FileAuthority | undefined {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (
      pathStat.isSymbolicLink()
      || realpathSync.native(path) !== path
      || !validCandidateStat(pathStat, expectedDevice)
    ) return undefined;
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (
      !validCandidateStat(opened, expectedDevice)
      || opened.dev !== pathStat.dev
      || opened.ino !== pathStat.ino
      || opened.nlink !== pathStat.nlink
      || opened.size !== pathStat.size
    ) return undefined;
    const authority = Object.freeze({
      path,
      fd,
      device: opened.dev,
      inode: opened.ino,
      bytes: opened.size,
      links: opened.nlink,
    }) as FileAuthority;
    fd = undefined;
    return authority;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Unsafe candidates are retained.
      }
    }
  }
}

function assertFile(
  authority: FileAuthority,
  expectedLinks: 0 | 1 | 2,
): void {
  try {
    const opened = fstatSync(authority.fd);
    if (
      !opened.isFile()
      || opened.dev !== authority.device
      || opened.ino !== authority.inode
      || opened.size !== authority.bytes
      || opened.nlink !== expectedLinks
      || !isProjectTemplatePrivateFileMode(opened.mode)
      || !privateOwnerMatches(opened)
    ) throw new Error();
    if (expectedLinks !== 0) {
      const pathStat = lstatSync(authority.path);
      if (
        pathStat.isSymbolicLink()
        || realpathSync.native(authority.path) !== authority.path
        || pathStat.dev !== authority.device
        || pathStat.ino !== authority.inode
        || pathStat.size !== authority.bytes
        || pathStat.nlink !== expectedLinks
        || !isProjectTemplatePrivateFileMode(pathStat.mode)
        || !privateOwnerMatches(pathStat)
      ) throw new Error();
    }
  } catch {
    throw reclaimError(
      'CACHE_INVALID',
      'GitHub template receipt reclaim file authority changed',
    );
  }
}

function assertOpenedFile(
  authority: FileAuthority,
  expectedLinks: 0 | 1,
): void {
  try {
    const opened = fstatSync(authority.fd);
    if (
      !opened.isFile()
      || opened.dev !== authority.device
      || opened.ino !== authority.inode
      || opened.size !== authority.bytes
      || opened.nlink !== expectedLinks
      || !isProjectTemplatePrivateFileMode(opened.mode)
      || !privateOwnerMatches(opened)
    ) throw new Error();
  } catch {
    throw reclaimError(
      'CACHE_INVALID',
      'GitHub template receipt reclaim opened file changed',
    );
  }
}

function readExact(
  authority: FileAuthority,
  io: IoSnapshot | undefined,
): Buffer {
  const result = Buffer.allocUnsafe(authority.bytes);
  let position = 0;
  while (position < authority.bytes) {
    let count: unknown;
    try {
      count = io?.read === undefined
        ? readSync(
          authority.fd,
          result,
          position,
          authority.bytes - position,
          position,
        )
        : Reflect.apply(io.read, io.receiver, [
          authority.fd,
          result,
          position,
          authority.bytes - position,
          position,
        ]);
    } catch {
      throw reclaimError(
        'IO_FAILURE',
        'GitHub template receipt reclaim read failed',
      );
    }
    if (
      !Number.isSafeInteger(count)
      || (count as number) <= 0
      || (count as number) > authority.bytes - position
    ) {
      throw reclaimError(
        'IO_FAILURE',
        'GitHub template receipt reclaim read made invalid progress',
      );
    }
    position += count as number;
  }
  let eof: unknown;
  try {
    const extra = Buffer.allocUnsafe(1);
    eof = io?.read === undefined
      ? readSync(authority.fd, extra, 0, 1, authority.bytes)
      : Reflect.apply(io.read, io.receiver, [
        authority.fd,
        extra,
        0,
        1,
        authority.bytes,
      ]);
  } catch {
    throw reclaimError(
      'IO_FAILURE',
      'GitHub template receipt reclaim EOF check failed',
    );
  }
  if (eof !== 0) {
    throw reclaimError(
      'IO_FAILURE',
      'GitHub template receipt reclaim EOF check failed',
    );
  }
  return result;
}

async function authenticatedLinkedCandidate(
  temporary: FileAuthority,
  final: FileAuthority,
  receiptKey: string,
  verifier: VerifierSnapshot,
  io: IoSnapshot | undefined,
): Promise<Pick<CandidateAuthority, 'serialized' | 'receipt'> | undefined> {
  if (
    temporary.bytes === 0
    || temporary.bytes > MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES
    || final.inode !== temporary.inode
    || final.device !== temporary.device
    || final.bytes !== temporary.bytes
  ) return undefined;
  try {
    const temporaryBytes = readExact(temporary, io);
    const finalBytes = readExact(final, io);
    if (!temporaryBytes.equals(finalBytes)) return undefined;
    const serialized = temporaryBytes.toString('utf8');
    const receipt = parseGithubTemplateDownloadReceipt(temporaryBytes);
    if (
      calculateGithubTemplateDownloadReceiptKey(serialized) !== receiptKey
    ) return undefined;
    const request = Object.freeze({
      keyId: receipt.authentication.keyId,
      input: createGithubTemplateDownloadReceiptAuthenticationInput(receipt),
      tag: receipt.authentication.tag,
    });
    let result: unknown;
    try {
      result = await Reflect.apply(
        verifier.verify,
        verifier.receiver,
        [request],
      );
    } catch {
      return undefined;
    }
    if (result !== 'valid') return undefined;
    return Object.freeze({ serialized, receipt });
  } catch (error) {
    if (error instanceof GithubTemplateDownloadReceiptReclaimError) {
      throw error;
    }
    return undefined;
  }
}

function ownerState(
  pid: number,
  io: IoSnapshot | undefined,
): 'alive' | 'missing' | 'inaccessible' {
  if (pid === process.pid) return 'alive';
  if (io?.processProbe !== undefined) {
    try {
      const result = Reflect.apply(io.processProbe, io.receiver, [pid]);
      return (
        result === 'alive'
        || result === 'missing'
        || result === 'inaccessible'
      )
        ? result
        : 'inaccessible';
    } catch {
      return 'inaccessible';
    }
  }
  try {
    NATIVE_PROCESS_KILL(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
      ? 'missing'
      : 'inaccessible';
  }
}

function runPhase(
  io: IoSnapshot | undefined,
  phase: GithubTemplateDownloadReceiptReclaimPhase,
  path: string,
): void {
  try {
    if (io?.onPhase !== undefined) {
      Reflect.apply(io.onPhase, io.receiver, [phase, path]);
    }
  } catch {
    throw reclaimError(
      'IO_FAILURE',
      'GitHub template receipt reclaim phase failed',
    );
  }
}

function closeDescriptor(
  authority: { readonly fd: number },
  kind: 'temporary' | 'final' | 'directory',
  io: IoSnapshot | undefined,
): GithubTemplateDownloadReceiptReclaimError | undefined {
  const hookFailure = runDescriptorCloseHook(authority, kind, io);
  const nativeFailure = closeNativeDescriptor(authority);
  return hookFailure ?? nativeFailure;
}

function runDescriptorCloseHook(
  authority: { readonly fd: number },
  kind: 'temporary' | 'final' | 'directory',
  io: IoSnapshot | undefined,
): GithubTemplateDownloadReceiptReclaimError | undefined {
  try {
    if (io?.close !== undefined) {
      Reflect.apply(io.close, io.receiver, [authority.fd, kind]);
    }
  } catch {
    return reclaimError(
      'IO_FAILURE',
      'GitHub template receipt reclaim descriptor close failed',
    );
  }
  return undefined;
}

function closeNativeDescriptor(
  authority: { readonly fd: number },
): GithubTemplateDownloadReceiptReclaimError | undefined {
  try {
    closeSync(authority.fd);
  } catch {
    return reclaimError(
      'IO_FAILURE',
      'GitHub template receipt reclaim descriptor close failed',
    );
  }
  return undefined;
}

function runStreamCloseHook(
  io: IoSnapshot | undefined,
): GithubTemplateDownloadReceiptReclaimError | undefined {
  try {
    if (io?.closeDirectoryStream !== undefined) {
      Reflect.apply(io.closeDirectoryStream, io.receiver, []);
    }
  } catch {
    return reclaimError(
      'IO_FAILURE',
      'GitHub template receipt reclaim stream close failed',
    );
  }
  return undefined;
}

function closeNativeStream(
  directory: Dir,
): GithubTemplateDownloadReceiptReclaimError | undefined {
  try {
    directory.closeSync();
  } catch {
    return reclaimError(
      'IO_FAILURE',
      'GitHub template receipt reclaim stream close failed',
    );
  }
  return undefined;
}

function emptyResult(
  platform: NodeJS.Platform = process.platform,
): ReclaimedGithubTemplateDownloadReceiptTemps {
  return Object.freeze({
    scanned: 0,
    matched: 0,
    dead: 0,
    reclaimed: 0,
    skipped: 0,
    unsafeRetained: 0,
    truncated: false,
    directoryDurability: platform === 'win32' ? 'unsupported' : 'synced',
    status: platform === 'win32' ? 'unsupported' : 'complete',
  });
}

function openLinkedCandidate(
  shard: DirectoryAuthority,
  temporaryPath: string,
  receiptKey: string,
  finalPath: string,
  io: IoSnapshot | undefined,
): CandidateAuthority | undefined {
  const temporary = openCandidateFile(temporaryPath, shard.device);
  if (temporary === undefined) return undefined;
  if (temporary.links === 1) return { temporary, receiptKey };
  const final = openCandidateFile(finalPath, shard.device);
  if (
    final === undefined
    || final.links !== 2
    || final.inode !== temporary.inode
    || final.device !== temporary.device
  ) {
    let closeFailure: GithubTemplateDownloadReceiptReclaimError | undefined;
    if (final !== undefined) {
      closeFailure = closeDescriptor(final, 'final', io);
    }
    const temporaryClose = closeDescriptor(temporary, 'temporary', io);
    closeFailure ??= temporaryClose;
    if (closeFailure !== undefined) throw closeFailure;
    return undefined;
  }
  return { temporary, final, receiptKey };
}

function assertAllDirectories(
  root: DirectoryAuthority,
  ancestors: readonly DirectoryAuthority[],
  shard: DirectoryAuthority,
): void {
  assertDirectory(root);
  for (const ancestor of ancestors) assertDirectory(ancestor);
  assertDirectory(shard);
}

function assertAuthenticatedLinkedAuthority(
  candidate: CandidateAuthority,
  serialized: string,
  afterUnlink: boolean,
): void {
  if (candidate.final === undefined) {
    throw reclaimError(
      'CACHE_INVALID',
      'GitHub template receipt reclaim linked authority is incomplete',
    );
  }
  if (afterUnlink) assertOpenedFile(candidate.temporary, 1);
  else assertFile(candidate.temporary, 2);
  assertFile(candidate.final, afterUnlink ? 1 : 2);
  const temporaryBytes = readExact(candidate.temporary, undefined);
  const finalBytes = readExact(candidate.final, undefined);
  if (
    !temporaryBytes.equals(finalBytes)
    || finalBytes.toString('utf8') !== serialized
    || calculateGithubTemplateDownloadReceiptKey(serialized)
      !== candidate.receiptKey
  ) {
    throw reclaimError(
      'CACHE_INVALID',
      'GitHub template receipt reclaim linked bytes changed',
    );
  }
}

function validateReclaimedFinalEvidence(
  evidence: ReclaimedFinalEvidence,
): void {
  const final = openCandidateFile(evidence.path, evidence.device);
  if (final === undefined) {
    throw reclaimError(
      'CACHE_INVALID',
      'GitHub template receipt reclaimed final is unsafe',
    );
  }
  let failure: GithubTemplateDownloadReceiptReclaimError | undefined;
  try {
    if (
      final.links !== 1
      || final.inode !== evidence.inode
      || final.bytes !== evidence.bytes
    ) throw new Error();
    assertFile(final, 1);
    const bytes = readExact(final, undefined);
    if (
      bytes.toString('utf8') !== evidence.serialized
      || calculateGithubTemplateDownloadReceiptKey(evidence.serialized)
        !== evidence.receiptKey
    ) throw new Error();
  } catch {
    failure = reclaimError(
      'CACHE_INVALID',
      'GitHub template receipt reclaimed final changed',
    );
  }
  const closeFailure = closeNativeDescriptor(final);
  failure ??= closeFailure;
  if (failure !== undefined) throw failure;
}

function assertReclaimedPathAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw reclaimError(
      'CACHE_INVALID',
      'GitHub template receipt reclaimed path absence is uncertain',
    );
  }
  throw reclaimError(
    'CACHE_INVALID',
    'GitHub template receipt reclaimed path was recreated',
  );
}

function candidateStableBeforeUnlink(
  candidate: CandidateAuthority,
  serialized: string | undefined,
): boolean {
  try {
    if (candidate.final !== undefined) {
      if (serialized === undefined) return false;
      assertAuthenticatedLinkedAuthority(candidate, serialized, false);
    } else {
      assertFile(candidate.temporary, 1);
    }
    return true;
  } catch (error) {
    if (
      error instanceof GithubTemplateDownloadReceiptReclaimError
      && error.code === 'CACHE_INVALID'
    ) return false;
    throw error;
  }
}

async function reclaimCandidate(
  candidate: CandidateAuthority,
  pid: number,
  root: DirectoryAuthority,
  ancestors: readonly DirectoryAuthority[],
  shard: DirectoryAuthority,
  verifier: VerifierSnapshot,
  io: IoSnapshot | undefined,
): Promise<{
  readonly outcome: 'reclaimed' | 'skipped' | 'unsafe';
  readonly reclaimedPath?: string;
  readonly sealedSerialized?: string;
  readonly finalEvidence?: ReclaimedFinalEvidence;
}> {
  let authenticated = candidate;
  if (candidate.final !== undefined) {
    const evidence = await authenticatedLinkedCandidate(
      candidate.temporary,
      candidate.final,
      candidate.receiptKey,
      verifier,
      io,
    );
    if (evidence === undefined) return { outcome: 'unsafe' };
    authenticated = { ...candidate, ...evidence };
  }
  runPhase(io, 'before-reclaim-unlink', candidate.temporary.path);
  if (ownerState(pid, io) !== 'missing') return { outcome: 'skipped' };
  try {
    assertAllDirectories(root, ancestors, shard);
    if (!candidateStableBeforeUnlink(
      candidate,
      authenticated.serialized,
    )) return { outcome: 'unsafe' };
    if (io?.unlink !== undefined) {
      Reflect.apply(io.unlink, io.receiver, [candidate.temporary.path]);
    }
    // The unlink seam is a notification/fault hook, never path authority.
    assertAllDirectories(root, ancestors, shard);
    if (!candidateStableBeforeUnlink(
      candidate,
      authenticated.serialized,
    )) return { outcome: 'unsafe' };
    unlinkSync(candidate.temporary.path);
    assertAllDirectories(root, ancestors, shard);
    if (candidate.final !== undefined) {
      assertAuthenticatedLinkedAuthority(
        candidate,
        authenticated.serialized!,
        true,
      );
    } else assertOpenedFile(candidate.temporary, 0);
    runPhase(io, 'after-reclaim-unlink', candidate.temporary.path);
    assertAllDirectories(root, ancestors, shard);
    if (candidate.final !== undefined) {
      assertAuthenticatedLinkedAuthority(
        candidate,
        authenticated.serialized!,
        true,
      );
    } else assertOpenedFile(candidate.temporary, 0);
    if (process.platform !== 'win32') {
      runPhase(io, 'before-reclaim-fsync', shard.path);
      assertAllDirectories(root, ancestors, shard);
      if (candidate.final !== undefined) {
        assertAuthenticatedLinkedAuthority(
          candidate,
          authenticated.serialized!,
          true,
        );
      } else assertOpenedFile(candidate.temporary, 0);
      if (io?.fsync === undefined) fsyncSync(shard.fd);
      else Reflect.apply(io.fsync, io.receiver, [shard.fd]);
    }
    assertAllDirectories(root, ancestors, shard);
    if (candidate.final !== undefined) {
      assertAuthenticatedLinkedAuthority(
        candidate,
        authenticated.serialized!,
        true,
      );
    } else assertOpenedFile(candidate.temporary, 0);
    return {
      outcome: 'reclaimed',
      reclaimedPath: candidate.temporary.path,
      ...(candidate.final === undefined
        ? {}
        : {
          sealedSerialized: authenticated.serialized,
          finalEvidence: Object.freeze({
            path: candidate.final.path,
            device: candidate.final.device,
            inode: candidate.final.inode,
            bytes: candidate.final.bytes,
            receiptKey: candidate.receiptKey,
            serialized: authenticated.serialized!,
          }),
        }),
    };
  } catch (error) {
    if (error instanceof GithubTemplateDownloadReceiptReclaimError) {
      throw error;
    }
    throw reclaimError(
      'IO_FAILURE',
      'GitHub template receipt reclaim mutation failed',
    );
  }
}

export async function reclaimGithubTemplateDownloadReceiptTemps(
  value: ReclaimGithubTemplateDownloadReceiptTempsOptions,
): Promise<ReclaimedGithubTemplateDownloadReceiptTemps> {
  const options = snapshotOptions(value);
  const directoryDurability = process.platform === 'win32'
    ? 'unsupported' as const
    : 'synced' as const;
  if (directoryDurability === 'unsupported') return emptyResult('win32');
  const requestedRoot = resolve(options.cacheRoot);
  if (requestedRoot !== options.cacheRoot) {
    throw reclaimError(
      'INVALID_ARGUMENT',
      'GitHub template receipt reclaim cache root is invalid',
    );
  }
  const root = openDirectory(requestedRoot);
  if (root === undefined) return emptyResult();
  const openedAncestors: DirectoryAuthority[] = [];
  let primary: GithubTemplateDownloadReceiptReclaimError | undefined;
  let scanned = 0;
  let matched = 0;
  let dead = 0;
  let reclaimed = 0;
  let skipped = 0;
  let unsafeRetained = 0;
  let truncated = false;
  let status: ReclaimedGithubTemplateDownloadReceiptTemps['status'] =
    'complete';
  const reclaimedPaths: string[] = [];
  const reclaimedFinals: ReclaimedFinalEvidence[] = [];
  try {
    let parent = root;
    let hierarchyMissing = false;
    for (const name of ['receipts', 'v1', 'sha256']) {
      const child = openChildDirectory(
        parent,
        join(parent.path, name),
        options.io,
      );
      if (child === undefined) {
        hierarchyMissing = true;
        break;
      }
      openedAncestors.push(child);
      parent = child;
    }
    const algorithm = parent;
    outer: for (const shardName of hierarchyMissing ? [] : SHARDS) {
      if (scanned >= SCAN_LIMIT || reclaimed >= DELETE_LIMIT) break;
      const shard = openChildDirectory(
        algorithm,
        join(algorithm.path, shardName),
        options.io,
      );
      if (shard === undefined) continue;
      let directory: Dir | undefined;
      let shardFailure: GithubTemplateDownloadReceiptReclaimError | undefined;
      try {
        directory = opendirSync(shard.path);
        while (scanned < SCAN_LIMIT && reclaimed < DELETE_LIMIT) {
          const entry = directory.readSync();
          if (entry === null) break;
          scanned += 1;
          let parsed: ReturnType<
            typeof parseGithubTemplateDownloadReceiptTempName
          >;
          try {
            parsed = parseGithubTemplateDownloadReceiptTempName(entry.name);
          } catch {
            continue;
          }
          matched += 1;
          const firstState = ownerState(parsed.pid, options.io);
          if (firstState !== 'missing') {
            skipped += 1;
            continue;
          }
          dead += 1;
          assertAllDirectories(root, openedAncestors, shard);
          const temporaryPath = join(shard.path, entry.name);
          if (dirname(temporaryPath) !== shard.path) throw new Error();
          const locator = deriveGithubTemplateDownloadReceiptLocatorPaths({
            cacheRoot: root.path,
            receiptKey: parsed.receiptKey,
          });
          if (
            locator.receiptDirectory !== shard.path
            || dirname(locator.receiptPath) !== shard.path
          ) {
            skipped += 1;
            unsafeRetained += 1;
            continue;
          }
          const candidate = openLinkedCandidate(
            shard,
            temporaryPath,
            parsed.receiptKey,
            locator.receiptPath,
            options.io,
          );
          if (candidate === undefined) {
            skipped += 1;
            unsafeRetained += 1;
            continue;
          }
          let candidateResult: Awaited<ReturnType<
            typeof reclaimCandidate
          >> | undefined;
          let candidateFailure:
            GithubTemplateDownloadReceiptReclaimError | undefined;
          try {
            candidateResult = await reclaimCandidate(
              candidate,
              parsed.pid,
              root,
              openedAncestors,
              shard,
              options.verifier,
              options.io,
            );
          } catch (error) {
            candidateFailure = (
              error instanceof GithubTemplateDownloadReceiptReclaimError
                ? error
                : reclaimError(
                  'IO_FAILURE',
                  'GitHub template receipt reclaim candidate failed',
                )
            );
          } finally {
            let closeHookFailure:
              GithubTemplateDownloadReceiptReclaimError | undefined;
            if (candidate.final !== undefined) {
              closeHookFailure = runDescriptorCloseHook(
                candidate.final,
                'final',
                options.io,
              );
            }
            const temporaryHook = runDescriptorCloseHook(
              candidate.temporary,
              'temporary',
              options.io,
            );
            closeHookFailure ??= temporaryHook;
            candidateFailure ??= closeHookFailure;
            if (
              candidateResult?.outcome === 'reclaimed'
              && candidateFailure === undefined
            ) {
              try {
                assertAllDirectories(
                  root,
                  openedAncestors,
                  shard,
                );
                if (candidate.final !== undefined) {
                  assertAuthenticatedLinkedAuthority(
                    candidate,
                    candidateResult.sealedSerialized!,
                    true,
                  );
                } else {
                  assertOpenedFile(candidate.temporary, 0);
                }
              } catch (error) {
                candidateFailure = (
                  error instanceof GithubTemplateDownloadReceiptReclaimError
                    ? error
                    : reclaimError(
                      'CACHE_INVALID',
                      'GitHub template receipt reclaim post-state changed',
                    )
                );
              }
            }
            let nativeCloseFailure:
              GithubTemplateDownloadReceiptReclaimError | undefined;
            if (candidate.final !== undefined) {
              nativeCloseFailure = closeNativeDescriptor(candidate.final);
            }
            const temporaryClose = closeNativeDescriptor(
              candidate.temporary,
            );
            nativeCloseFailure ??= temporaryClose;
            candidateFailure ??= nativeCloseFailure;
          }
          if (candidateFailure !== undefined) throw candidateFailure;
          if (candidateResult?.outcome === 'reclaimed') {
            reclaimed += 1;
            reclaimedPaths.push(candidateResult.reclaimedPath!);
            if (candidateResult.finalEvidence !== undefined) {
              reclaimedFinals.push(candidateResult.finalEvidence);
            }
          }
          else {
            skipped += 1;
            if (candidateResult?.outcome === 'unsafe') unsafeRetained += 1;
          }
        }
      } catch (error) {
        shardFailure = (
          error instanceof GithubTemplateDownloadReceiptReclaimError
            ? error
            : reclaimError(
              'IO_FAILURE',
              'GitHub template receipt reclaim scan failed',
            )
        );
      } finally {
        if (directory !== undefined) {
          const streamHookFailure = runStreamCloseHook(options.io);
          shardFailure ??= streamHookFailure;
          const streamCloseFailure = closeNativeStream(directory);
          shardFailure ??= streamCloseFailure;
          try {
            assertAllDirectories(root, openedAncestors, shard);
          } catch (error) {
            shardFailure ??= (
              error instanceof GithubTemplateDownloadReceiptReclaimError
                ? error
                : reclaimError(
                  'CACHE_INVALID',
                  'GitHub template receipt reclaim post-scan changed',
                )
            );
          }
        }
        const shardHookFailure = runDescriptorCloseHook(
          shard,
          'directory',
          options.io,
        );
        shardFailure ??= shardHookFailure;
        try {
          assertAllDirectories(root, openedAncestors, shard);
        } catch (error) {
          shardFailure ??= (
            error instanceof GithubTemplateDownloadReceiptReclaimError
              ? error
              : reclaimError(
                'CACHE_INVALID',
                'GitHub template receipt reclaim shard changed before close',
              )
          );
        }
        const shardCloseFailure = closeNativeDescriptor(shard);
        shardFailure ??= shardCloseFailure;
      }
      if (shardFailure !== undefined) throw shardFailure;
      if (scanned >= SCAN_LIMIT || reclaimed >= DELETE_LIMIT) break outer;
    }
    if (reclaimed >= DELETE_LIMIT) {
      truncated = true;
      status = 'delete-limit';
    } else if (scanned >= SCAN_LIMIT) {
      truncated = true;
      status = 'scan-limit';
    } else if (unsafeRetained > 0) {
      status = 'unsafe-retained';
    }
  } catch (error) {
    primary = (
      error instanceof GithubTemplateDownloadReceiptReclaimError
        ? error
        : reclaimError(
          'CACHE_INVALID',
          'GitHub template receipt reclaim failed',
        )
    );
  }
  const finalDirectories = [...openedAncestors].reverse();
  for (const authority of finalDirectories) {
    const hookFailure = runDescriptorCloseHook(
      authority,
      'directory',
      options.io,
    );
    primary ??= hookFailure;
  }
  const rootHookFailure = runDescriptorCloseHook(
    root,
    'directory',
    options.io,
  );
  primary ??= rootHookFailure;
  try {
    assertDirectory(root);
    for (const authority of openedAncestors) assertDirectory(authority);
    // An unlinked descriptor only proves the old inode stayed detached. The
    // pathname itself must remain absent after every mutation-capable callback.
    for (const path of reclaimedPaths) assertReclaimedPathAbsent(path);
    for (const evidence of reclaimedFinals) {
      validateReclaimedFinalEvidence(evidence);
    }
  } catch (error) {
    primary ??= (
      error instanceof GithubTemplateDownloadReceiptReclaimError
        ? error
        : reclaimError(
          'CACHE_INVALID',
          'GitHub template receipt reclaim hierarchy changed before close',
        )
    );
  }
  for (const authority of finalDirectories) {
    const closeFailure = closeNativeDescriptor(authority);
    primary ??= closeFailure;
  }
  const rootCloseFailure = closeNativeDescriptor(root);
  primary ??= rootCloseFailure;
  if (primary !== undefined) throw primary;
  return Object.freeze({
    scanned,
    matched,
    dead,
    reclaimed,
    skipped,
    unsafeRetained,
    truncated,
    directoryDurability,
    status,
  });
}
