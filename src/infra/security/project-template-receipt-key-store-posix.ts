import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
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
}

export interface PosixProjectTemplateReceiptKeyStoreOptions {
  readonly directory: string;
  readonly io?: PosixProjectTemplateReceiptKeyStoreIo;
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
  before: ReturnType<typeof fstatSync>,
  after: ReturnType<typeof fstatSync>,
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mode === after.mode
    && before.uid === after.uid
    && before.nlink === after.nlink;
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
    const initial = fstatSync(fd);
    if (initial.size > PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES) {
      throw failure('Key registry exceeds the bounded maximum');
    }
    io?.afterInitialFileStat?.(path);
    // Why: size+1 detects growth without allocating in proportion to a raced
    // file. The configured cap remains 64 KiB plus the single sentinel byte.
    const buffer = Buffer.alloc(initial.size + 1);
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
        if (!Number.isSafeInteger(count) || count < 0) {
          throw failure('Key registry partial read failed');
        }
        if (count === 0) break;
        offset += count;
      }
      io?.beforeFinalFileStat?.(path);
      const finalDescriptorStat = fstatSync(fd);
      const finalPathStat = lstatSync(path);
      if (
        offset !== initial.size
        || !sameFileState(initial, finalDescriptorStat)
        || finalPathStat.dev !== finalDescriptorStat.dev
        || finalPathStat.ino !== finalDescriptorStat.ino
        || finalPathStat.mode !== finalDescriptorStat.mode
        || finalPathStat.nlink !== 1
      ) throw failure('Key registry changed during bounded read');
      output = Uint8Array.from(buffer.subarray(0, offset));
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

async function acquireLock(lockPath: string): Promise<number> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${process.pid}\n`, 'utf8');
      fsyncSync(fd);
      assertRegularOwnedFile(lockPath, fd);
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_WAIT_MS));
    }
  }
  throw failure('Key store exclusive lease is unavailable');
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
    let lockFd: number | undefined;
    let snapshot: ProjectTemplateReceiptKeySnapshot | undefined;
    try {
      lockFd = await acquireLock(lockPath);
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
      if (lockFd !== undefined) closeSync(lockFd);
      if (existsSync(lockPath)) unlinkSync(lockPath);
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
