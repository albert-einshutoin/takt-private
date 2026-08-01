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
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import {
  parseProjectTemplateReceiptKeyRegistry,
  PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES,
  ProjectTemplateReceiptKeyStoreError,
  serializeProjectTemplateReceiptKeyRegistry,
  type ProjectTemplateReceiptKeyRegistry,
  type ProjectTemplateReceiptKeyStore,
} from './project-template-receipt-key-store.js';

const REGISTRY_NAME = 'keyring.json';

export interface PosixProjectTemplateReceiptKeyStoreIo {
  readonly beforeRename?: () => void;
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
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const fd = assertDirectory(directory);
  // Why: recursive mkdir is affected by umask only toward stricter modes, but
  // an existing last component may be permissive. Never silently repair it.
  return fd;
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
  if (
    pathStat.dev !== descriptorStat.dev
    || pathStat.ino !== descriptorStat.ino
  ) throw failure('Key registry path identity mismatch');
}

function openRegistry(path: string): number {
  const pathStat = lstatSync(path);
  if (pathStat.isSymbolicLink()) throw failure('Key registry path is a symlink');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertRegularOwnedFile(path, fd);
    const size = fstatSync(fd).size;
    if (size > PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES) {
      throw failure('Key registry exceeds the bounded maximum');
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function rejectUnsafeExistingRegistry(path: string): void {
  if (!existsSync(path)) return;
  const fd = openRegistry(path);
  closeSync(fd);
}

export function createPosixProjectTemplateReceiptKeyStore(
  options: PosixProjectTemplateReceiptKeyStoreOptions,
): ProjectTemplateReceiptKeyStore {
  const directory = resolve(options.directory);
  if (directory !== options.directory) {
    throw failure('Key store directory must be a canonical absolute path');
  }
  const registryPath = join(directory, REGISTRY_NAME);
  let disposed = false;

  function available(): void {
    if (disposed) throw failure('Key store is disposed');
  }

  return Object.freeze({
    async read() {
      available();
      const directoryFd = ensureDirectory(directory);
      try {
        if (!existsSync(registryPath)) return undefined;
        const fd = openRegistry(registryPath);
        try {
          return parseProjectTemplateReceiptKeyRegistry(readFileSync(fd));
        } finally {
          closeSync(fd);
        }
      } finally {
        closeSync(directoryFd);
      }
    },

    async write(registry: ProjectTemplateReceiptKeyRegistry) {
      available();
      const bytes = serializeProjectTemplateReceiptKeyRegistry(registry);
      const directoryFd = ensureDirectory(directory);
      const temporaryPath = join(directory, `.${REGISTRY_NAME}.${randomUUID()}.tmp`);
      let temporaryFd: number | undefined;
      try {
        rejectUnsafeExistingRegistry(registryPath);
        temporaryFd = openSync(
          temporaryPath,
          constants.O_WRONLY
            | constants.O_CREAT
            | constants.O_EXCL
            | constants.O_NOFOLLOW,
          0o600,
        );
        fchmodSync(temporaryFd, 0o600);
        assertRegularOwnedFile(temporaryPath, temporaryFd);
        writeFileSync(temporaryFd, bytes);
        fsyncSync(temporaryFd);
        closeSync(temporaryFd);
        temporaryFd = undefined;
        options.io?.beforeRename?.();
        renameSync(temporaryPath, registryPath);
        // Why: file fsync protects content; directory fsync protects the
        // atomic name publication across a power loss.
        fsyncSync(directoryFd);
      } finally {
        if (temporaryFd !== undefined) closeSync(temporaryFd);
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
        closeSync(directoryFd);
      }
    },

    async dispose() {
      disposed = true;
    },
  });
}
