import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import {
  parseProjectTemplateReceiptKeySnapshot,
  PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES,
  ProjectTemplateReceiptKeyStoreError,
  serializeProjectTemplateReceiptKeySnapshot,
  type ProjectTemplateReceiptKeyRegistry,
  type ProjectTemplateReceiptKeySnapshot,
  type ProjectTemplateReceiptKeyStore,
  type ProjectTemplateReceiptKeyStoreLease,
} from './project-template-receipt-key-store.js';

const REGISTRY_NAME = 'keyring.json';
const LOCK_NAME = '.keyring.lock';
const LOCK_WAIT_MS = 5;
const LOCK_ATTEMPTS = 1_000;

export interface PosixProjectTemplateReceiptKeyStoreIo {
  readonly beforeRename?: () => void;
  readonly afterInitialFileStat?: (path: string) => void;
  readonly beforeFinalFileStat?: (path: string) => void;
  readonly read?: typeof readSync;
  readonly close?: typeof closeSync;
  readonly onHashBuffer?: (buffer: Uint8Array) => void;
  readonly beforeStaleLockUnlink?: (path: string) => void;
}

export interface PosixProjectTemplateReceiptKeyStoreOptions {
  readonly directory: string;
  readonly io?: PosixProjectTemplateReceiptKeyStoreIo;
  readonly leasePolicy?: {
    readonly attempts: number;
    readonly waitMs: number;
    readonly staleAfterMs?: number;
    readonly now?: () => number;
    readonly isProcessAlive?: (pid: number) => boolean;
  };
}

function failure(message: string): ProjectTemplateReceiptKeyStoreError {
  return new ProjectTemplateReceiptKeyStoreError(message);
}

function expectedUid(): number {
  if (typeof process.getuid !== 'function') {
    throw failure('POSIX uid validation is unavailable');
  }
  return process.getuid();
}

function validateDirectoryPath(directory: string): void {
  if (
    typeof directory !== 'string'
    || directory.length === 0
    || directory.includes('\0')
    || !isAbsolute(directory)
    || normalize(directory) !== directory
  ) throw failure('Key store directory must be a canonical absolute path');
}

function assertDirectory(directory: string): number {
  const pathStat = lstatSync(directory);
  if (pathStat.isSymbolicLink()) throw failure('Key store directory is a symlink');
  if (!pathStat.isDirectory()) throw failure('Key store path is not a directory');
  if ((pathStat.mode & 0o777) !== 0o700) throw failure('Key store directory mode must be 0700');
  if (pathStat.uid !== expectedUid()) throw failure('Key store directory uid mismatch');
  if (realpathSync(directory) !== directory) {
    throw failure('Key store directory canonical identity mismatch');
  }
  const fd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const descriptorStat = fstatSync(fd);
    if (
      descriptorStat.dev !== pathStat.dev
      || descriptorStat.ino !== pathStat.ino
      || !descriptorStat.isDirectory()
    ) throw failure('Key store directory path identity mismatch');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function ensureDirectory(directory: string): number {
  validateDirectoryPath(directory);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return assertDirectory(directory);
}

function assertRegularOwnedFile(path: string, fd: number): void {
  const pathStat = lstatSync(path);
  const descriptorStat = fstatSync(fd);
  if (pathStat.isSymbolicLink()) throw failure('Key registry path is a symlink');
  if (!pathStat.isFile() || !descriptorStat.isFile()) {
    throw failure('Key registry is not a regular file');
  }
  if ((descriptorStat.mode & 0o777) !== 0o600) {
    throw failure('Key registry file mode must be 0600');
  }
  if (descriptorStat.uid !== expectedUid()) throw failure('Key registry uid mismatch');
  if (descriptorStat.nlink !== 1) throw failure('Key registry nlink must be one');
  if (pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
    throw failure('Key registry path identity mismatch');
  }
}

function sameFileState(
  before: BigIntStats,
  after: BigIntStats,
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mode === after.mode
    && before.uid === after.uid
    && before.nlink === after.nlink
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
    && before.birthtimeNs === after.birthtimeNs;
}

function readBoundedRegistryFile(
  path: string,
  io: PosixProjectTemplateReceiptKeyStoreIo | undefined,
): Uint8Array {
  const initialPathStat = lstatSync(path);
  if (initialPathStat.isSymbolicLink()) throw failure('Key registry path is a symlink');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: Uint8Array | undefined;
  let primaryFailure: unknown;
  try {
    assertRegularOwnedFile(path, fd);
    const initial = fstatSync(fd, { bigint: true });
    if (initial.size >= BigInt(PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES)) {
      throw failure('Key registry exceeds the bounded maximum');
    }
    io?.afterInitialFileStat?.(path);
    // Why: size+1 detects growth without allocating in proportion to a raced
    // file. The configured cap remains 64 KiB plus the single sentinel byte.
    const buffer = Buffer.alloc(Number(initial.size) + 1);
    try {
      let offset = 0;
      const read = io?.read ?? readSync;
      while (offset < buffer.byteLength) {
        const count = Reflect.apply(read, io, [
          fd,
          buffer,
          offset,
          buffer.byteLength - offset,
          offset,
        ]) as number;
        if (
          !Number.isSafeInteger(count)
          || count < 0
          || count > buffer.byteLength - offset
        ) {
          throw failure('Key registry partial read failed');
        }
        if (count === 0) break;
        offset += count;
      }
      if (BigInt(offset) !== initial.size) {
        throw failure('Key registry changed during bounded read');
      }
      const firstHash = createHash('sha256').update(buffer.subarray(0, offset)).digest();
      let rereadOffset = 0;
      let contentStable = false;
      let secondHash: Buffer | undefined;
      try {
        io?.onHashBuffer?.(firstHash);
        buffer.fill(0);
        while (rereadOffset < buffer.byteLength) {
          const count = Reflect.apply(read, io, [
            fd,
            buffer,
            rereadOffset,
            buffer.byteLength - rereadOffset,
            rereadOffset,
          ]) as number;
          if (
            !Number.isSafeInteger(count)
            || count < 0
            || count > buffer.byteLength - rereadOffset
          ) throw failure('Key registry partial read failed');
          if (count === 0) break;
          rereadOffset += count;
        }
        secondHash = createHash('sha256')
          .update(buffer.subarray(0, rereadOffset))
          .digest();
        io?.onHashBuffer?.(secondHash);
        contentStable = rereadOffset === offset
          && timingSafeEqual(firstHash, secondHash);
      } finally {
        firstHash.fill(0);
        secondHash?.fill(0);
      }
      io?.beforeFinalFileStat?.(path);
      const finalDescriptorStat = fstatSync(fd, { bigint: true });
      const finalPathStat = lstatSync(path, { bigint: true });
      if (
        BigInt(rereadOffset) !== initial.size
        || !contentStable
        || !sameFileState(initial, finalDescriptorStat)
        || finalPathStat.dev !== finalDescriptorStat.dev
        || finalPathStat.ino !== finalDescriptorStat.ino
        || finalPathStat.mode !== finalDescriptorStat.mode
        || finalPathStat.nlink !== 1n
      ) throw failure('Key registry changed during bounded read');
      output = Uint8Array.from(buffer.subarray(0, rereadOffset));
    } finally {
      buffer.fill(0);
    }
  } catch (error) {
    primaryFailure = error;
    output?.fill(0);
  }
  let closeFailure: unknown;
  try {
    Reflect.apply(io?.close ?? closeSync, io, [fd]);
  } catch (error) {
    closeFailure = error;
    output?.fill(0);
  }
  if (primaryFailure !== undefined && closeFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, closeFailure],
      'Key registry read and close both failed',
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (closeFailure !== undefined) throw closeFailure;
  if (output === undefined) throw failure('Key registry bounded read failed');
  return output;
}

function cloneRegistry(registry: ProjectTemplateReceiptKeyRegistry) {
  return {
    schemaVersion: 1 as const,
    keys: registry.keys.map((entry) => ({
      keyId: entry.keyId,
      state: entry.state,
      ...(entry.secret === undefined ? {} : { secret: Uint8Array.from(entry.secret) }),
    })),
  };
}

function zeroizeSnapshot(snapshot: ProjectTemplateReceiptKeySnapshot | undefined): void {
  for (const key of snapshot?.registry.keys ?? []) key.secret?.fill(0);
}

function readSnapshot(
  registryPath: string,
  io: PosixProjectTemplateReceiptKeyStoreIo | undefined,
): ProjectTemplateReceiptKeySnapshot | undefined {
  if (!existsSync(registryPath)) return undefined;
  const bytes = readBoundedRegistryFile(registryPath, io);
  try {
    return parseProjectTemplateReceiptKeySnapshot(bytes);
  } finally {
    bytes.fill(0);
  }
}

function publishSnapshot(
  directoryFd: number,
  directory: string,
  registryPath: string,
  snapshot: ProjectTemplateReceiptKeySnapshot,
  io: PosixProjectTemplateReceiptKeyStoreIo | undefined,
): void {
  const bytes = serializeProjectTemplateReceiptKeySnapshot(snapshot);
  const temporaryPath = join(directory, `.${REGISTRY_NAME}.${randomUUID()}.tmp`);
  let temporaryFd: number | undefined;
  try {
    if (existsSync(registryPath)) {
      const existing = readBoundedRegistryFile(registryPath, io);
      existing.fill(0);
    }
    temporaryFd = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(temporaryFd, 0o600);
    assertRegularOwnedFile(temporaryPath, temporaryFd);
    writeFileSync(temporaryFd, bytes);
    fsyncSync(temporaryFd);
    closeSync(temporaryFd);
    temporaryFd = undefined;
    io?.beforeRename?.();
    renameSync(temporaryPath, registryPath);
    fsyncSync(directoryFd);
  } finally {
    bytes.fill(0);
    if (temporaryFd !== undefined) closeSync(temporaryFd);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

interface OwnedLock {
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
  readonly token: string;
}

interface PosixLockPolicy {
  readonly attempts: number;
  readonly waitMs: number;
  readonly staleAfterMs: number;
  readonly now: () => number;
  readonly isProcessAlive: (pid: number) => boolean;
}

interface PosixLockOwnerRecord {
  readonly pid: number;
  readonly createdAtMs: number;
  readonly token: string;
}

interface PosixLockObservation {
  readonly record: PosixLockOwnerRecord;
  readonly stat: BigIntStats;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function parseCanonicalLockOwner(bytes: Uint8Array): PosixLockOwnerRecord | undefined {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(parsed);
  if (
    Reflect.ownKeys(parsed).length !== 3
    || !('value' in (descriptors['pid'] ?? {}))
    || !('value' in (descriptors['createdAtMs'] ?? {}))
    || !('value' in (descriptors['token'] ?? {}))
  ) return undefined;
  const pid = descriptors['pid']!.value as unknown;
  const createdAtMs = descriptors['createdAtMs']!.value as unknown;
  const token = descriptors['token']!.value as unknown;
  if (
    !Number.isSafeInteger(pid)
    || (pid as number) < 1
    || typeof createdAtMs !== 'number'
    || !Number.isFinite(createdAtMs)
    || createdAtMs < 0
    || typeof token !== 'string'
    || !/^[a-f0-9]{32}$/.test(token)
  ) return undefined;
  const record = { pid: pid as number, createdAtMs, token };
  return text === JSON.stringify(record) ? record : undefined;
}

function observeStaleLock(
  fd: number,
  path: string,
  policy: PosixLockPolicy,
  expected?: PosixLockObservation,
  afterRename = false,
): PosixLockObservation | undefined {
  const initial = fstatSync(fd, { bigint: true });
  if (
    !initial.isFile()
    || initial.nlink !== 1n
    || initial.uid !== BigInt(expectedUid())
    || (initial.mode & 0o777n) !== 0o600n
    || initial.size < 1n
    || initial.size > 512n
  ) return undefined;
  const first = Buffer.alloc(Number(initial.size) + 1);
  const second = Buffer.alloc(Number(initial.size) + 1);
  try {
    const readExact = (buffer: Buffer): number => {
      let offset = 0;
      while (offset < buffer.byteLength) {
        const count = readSync(fd, buffer, offset, buffer.byteLength - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      return offset;
    };
    const firstLength = readExact(first);
    const secondLength = readExact(second);
    const finalDescriptor = fstatSync(fd, { bigint: true });
    const finalPath = lstatSync(path, { bigint: true });
    if (
      BigInt(firstLength) !== initial.size
      || firstLength !== secondLength
      || !timingSafeEqual(
        first.subarray(0, firstLength),
        second.subarray(0, secondLength),
      )
      || !sameFileState(initial, finalDescriptor)
      || finalPath.dev !== finalDescriptor.dev
      || finalPath.ino !== finalDescriptor.ino
      || finalPath.mode !== finalDescriptor.mode
      || finalPath.uid !== finalDescriptor.uid
      || finalPath.nlink !== 1n
      || (expected !== undefined && (
        expected.stat.dev !== finalDescriptor.dev
        || expected.stat.ino !== finalDescriptor.ino
        || expected.stat.size !== finalDescriptor.size
        || expected.stat.mode !== finalDescriptor.mode
        || expected.stat.uid !== finalDescriptor.uid
        || expected.stat.nlink !== finalDescriptor.nlink
        || expected.stat.mtimeNs !== finalDescriptor.mtimeNs
        || expected.stat.birthtimeNs !== finalDescriptor.birthtimeNs
        || (!afterRename && expected.stat.ctimeNs !== finalDescriptor.ctimeNs)
      ))
    ) return undefined;
    const record = parseCanonicalLockOwner(second.subarray(0, secondLength));
    const now = policy.now();
    if (
      record === undefined
      || !Number.isFinite(now)
      || now < 0
      || record.createdAtMs > now
      || now - record.createdAtMs < policy.staleAfterMs
    ) return undefined;
    if (
      expected !== undefined
      && (
        record.pid !== expected.record.pid
        || record.createdAtMs !== expected.record.createdAtMs
        || record.token !== expected.record.token
      )
    ) return undefined;
    let alive: boolean;
    try {
      alive = policy.isProcessAlive(record.pid);
    } catch {
      return undefined;
    }
    if (typeof alive !== 'boolean' || alive) return undefined;
    return { record, stat: finalDescriptor };
  } finally {
    first.fill(0);
    second.fill(0);
  }
}

function restoreQuarantinedLock(quarantinePath: string, lockPath: string): boolean {
  try {
    // link(2) is the available POSIX no-clobber primitive in Node. It restores
    // the moved inode only when no newer lock already owns the canonical path.
    linkSync(quarantinePath, lockPath);
    unlinkSync(quarantinePath);
    return true;
  } catch {
    return false;
  }
}

function quarantineAndRemoveStaleLock(
  lockPath: string,
  fd: number,
  observation: PosixLockObservation,
  policy: PosixLockPolicy,
): boolean {
  const quarantineDirectory = mkdtempSync(join(
    dirname(lockPath),
    `.keyring.lock.stale-${observation.record.token}-`,
  ));
  const quarantinePath = join(quarantineDirectory, 'owner');
  let moved = false;
  try {
    // Node does not expose renameat2(RENAME_NOREPLACE). Renaming into a freshly
    // created private empty directory gives an atomic same-filesystem move with
    // a destination that cannot already exist, eliminating close-then-unlink.
    renameSync(lockPath, quarantinePath);
    moved = true;
    const quarantined = observeStaleLock(fd, quarantinePath, policy, observation, true);
    if (quarantined === undefined) {
      if (restoreQuarantinedLock(quarantinePath, lockPath)) moved = false;
      return false;
    }
    unlinkSync(quarantinePath);
    moved = false;
    return true;
  } finally {
    if (!moved) rmdirSync(quarantineDirectory);
  }
}

function recoverStaleLock(
  lockPath: string,
  policy: PosixLockPolicy,
  io: PosixProjectTemplateReceiptKeyStoreIo | undefined,
): boolean {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(lockPath);
    if (
      pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || pathStat.nlink !== 1
      || pathStat.uid !== expectedUid()
      || (pathStat.mode & 0o777) !== 0o600
    ) return false;
    fd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorStat = fstatSync(fd);
    if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) return false;
    const observation = observeStaleLock(fd, lockPath, policy);
    if (observation === undefined) return false;
    io?.beforeStaleLockUnlink?.(lockPath);
    const revalidated = observeStaleLock(fd, lockPath, policy, observation);
    if (revalidated === undefined) return false;
    return quarantineAndRemoveStaleLock(lockPath, fd, revalidated, policy);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function acquireLock(
  lockPath: string,
  policy: PosixLockPolicy,
  io: PosixProjectTemplateReceiptKeyStoreIo | undefined,
): Promise<OwnedLock> {
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    let fd: number | undefined;
    let openedOwnership: OwnedLock | undefined;
    try {
      fd = openSync(
        lockPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const token = randomUUID().replaceAll('-', '');
      const opened = fstatSync(fd);
      openedOwnership = { fd, dev: opened.dev, ino: opened.ino, token };
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        createdAtMs: policy.now(),
        token,
      }), 'utf8');
      fsyncSync(fd);
      assertRegularOwnedFile(lockPath, fd);
      const stat = fstatSync(fd);
      return { fd, dev: stat.dev, ino: stat.ino, token };
    } catch (error) {
      if (openedOwnership !== undefined) {
        releaseOwnedLock(lockPath, openedOwnership, false);
      }
      else if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!recoverStaleLock(lockPath, policy, io)) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, policy.waitMs));
      }
    }
  }
  throw failure('Key store exclusive lease is unavailable');
}

function releaseOwnedLock(
  lockPath: string,
  ownership: OwnedLock,
  requireToken = true,
): void {
  const descriptorStat = fstatSync(ownership.fd);
  let tokenMatches = !requireToken;
  if (requireToken && descriptorStat.size > 0 && descriptorStat.size <= 512) {
    const bytes = Buffer.alloc(descriptorStat.size);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = readSync(
          ownership.fd,
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (count === 0) break;
        offset += count;
      }
      if (offset === descriptorStat.size) {
        const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const descriptors = Object.getOwnPropertyDescriptors(parsed);
          tokenMatches = Reflect.ownKeys(parsed).length === 3
            && 'value' in (descriptors['token'] ?? {})
            && descriptors['token']!.value === ownership.token;
        }
      }
    } catch {
      tokenMatches = false;
    } finally {
      bytes.fill(0);
    }
  }
  let pathStat: ReturnType<typeof lstatSync> | undefined;
  try {
    pathStat = lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  closeSync(ownership.fd);
  if (
    descriptorStat.dev === ownership.dev
    && descriptorStat.ino === ownership.ino
    && pathStat?.dev === ownership.dev
    && pathStat.ino === ownership.ino
    && pathStat.nlink === 1
    && tokenMatches
  ) unlinkSync(lockPath);
}

export function createPosixProjectTemplateReceiptKeyStore(
  options: PosixProjectTemplateReceiptKeyStoreOptions,
): ProjectTemplateReceiptKeyStore {
  const directory = resolve(options.directory);
  if (directory !== options.directory) {
    throw failure('Key store directory must be a canonical absolute path');
  }
  const registryPath = join(directory, REGISTRY_NAME);
  const lockPath = join(directory, LOCK_NAME);
  const leasePolicy: PosixLockPolicy = {
    attempts: options.leasePolicy?.attempts ?? LOCK_ATTEMPTS,
    waitMs: options.leasePolicy?.waitMs ?? LOCK_WAIT_MS,
    staleAfterMs: options.leasePolicy?.staleAfterMs ?? 30_000,
    now: options.leasePolicy?.now ?? Date.now,
    isProcessAlive: options.leasePolicy?.isProcessAlive ?? defaultProcessAlive,
  };
  if (
    !Number.isSafeInteger(leasePolicy.attempts)
    || leasePolicy.attempts < 1
    || !Number.isSafeInteger(leasePolicy.waitMs)
    || leasePolicy.waitMs < 0
    || !Number.isFinite(leasePolicy.staleAfterMs)
    || leasePolicy.staleAfterMs < 1
    || typeof leasePolicy.now !== 'function'
    || typeof leasePolicy.isProcessAlive !== 'function'
  ) throw failure('Key store lease policy is invalid');
  let disposed = false;

  function available(): void {
    if (disposed) throw failure('Key store is disposed');
  }

  async function withExclusiveLease<T>(
    operation: (
      lease: ProjectTemplateReceiptKeyStoreLease,
    ) => Promise<T> | T,
  ): Promise<T> {
    available();
    const directoryFd = ensureDirectory(directory);
    let ownedLock: OwnedLock | undefined;
    let snapshot: ProjectTemplateReceiptKeySnapshot | undefined;
    try {
      ownedLock = await acquireLock(lockPath, leasePolicy, options.io);
      snapshot = readSnapshot(registryPath, options.io);
      let committed = false;
      const result = await operation(Object.freeze({
        snapshot,
        async compareAndSwap(
          expectedGeneration: number | undefined,
          registry: ProjectTemplateReceiptKeyRegistry,
        ) {
          if (committed) throw failure('Key store lease already committed');
          const currentGeneration = snapshot?.generation;
          if (expectedGeneration !== currentGeneration) return undefined;
          const next = {
            generation: (currentGeneration ?? -1) + 1,
            registry: cloneRegistry(registry),
          };
          try {
            publishSnapshot(directoryFd, directory, registryPath, next, options.io);
            committed = true;
            zeroizeSnapshot(snapshot);
            snapshot = next;
            return {
              generation: next.generation,
              registry: cloneRegistry(next.registry),
            };
          } catch (error) {
            zeroizeSnapshot(next);
            throw error;
          }
        },
      }));
      return result;
    } finally {
      zeroizeSnapshot(snapshot);
      if (ownedLock !== undefined) releaseOwnedLock(lockPath, ownedLock);
      fsyncSync(directoryFd);
      closeSync(directoryFd);
    }
  }

  return Object.freeze({
    async read() {
      return await withExclusiveLease((lease) => lease.snapshot === undefined
        ? undefined
        : cloneRegistry(lease.snapshot.registry));
    },
    async write(registry: ProjectTemplateReceiptKeyRegistry) {
      await withExclusiveLease(async (lease) => {
        const written = await lease.compareAndSwap(
          lease.snapshot?.generation,
          registry,
        );
        if (written === undefined) throw failure('Key registry generation conflict');
        zeroizeSnapshot(written);
      });
    },
    withExclusiveLease,
    async dispose() {
      disposed = true;
    },
  });
}
