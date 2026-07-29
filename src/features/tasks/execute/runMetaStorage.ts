import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type RunMetaStorageOperation =
  | 'lstat'
  | 'mkdir'
  | 'open-temp'
  | 'write'
  | 'file-fsync'
  | 'close'
  | 'rename'
  | 'directory-fsync'
  | 'unlink';

export interface RunMetaStorageFaultHooks {
  before?: (operation: RunMetaStorageOperation, path: string) => void;
}

export interface RunMetaStorageIo {
  lstat(path: string): Stats | undefined;
  mkdir(path: string, mode: number): void;
  openExclusive(path: string, mode: number): number;
  write(fd: number, path: string, content: string): void;
  fsyncFile(fd: number, path: string): void;
  close(fd: number, path: string): void;
  rename(source: string, destination: string): void;
  fsyncDirectory(path: string): void;
  unlink(path: string): void;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

export function createRunMetaStorageIo(
  hooks: RunMetaStorageFaultHooks = {},
  platform: NodeJS.Platform = process.platform,
): RunMetaStorageIo {
  const before = (operation: RunMetaStorageOperation, path: string): void => {
    hooks.before?.(operation, path);
  };
  return {
    lstat(path) {
      before('lstat', path);
      try {
        return lstatSync(path);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
    },
    mkdir(path, mode) {
      before('mkdir', path);
      mkdirSync(path, { mode });
    },
    openExclusive(path, mode) {
      before('open-temp', path);
      return openSync(
        path,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        mode,
      );
    },
    write(fd, path, content) {
      before('write', path);
      writeFileSync(fd, content, { encoding: 'utf8' });
    },
    fsyncFile(fd, path) {
      before('file-fsync', path);
      fsyncSync(fd);
    },
    close(fd, path) {
      before('close', path);
      closeSync(fd);
    },
    rename(source, destination) {
      before('rename', destination);
      renameSync(source, destination);
    },
    fsyncDirectory(path) {
      // Windows cannot portably open and fsync a directory. File contents are
      // still durable before rename, so only directory-entry durability is
      // explicitly best-effort there.
      if (platform === 'win32') return;
      before('directory-fsync', path);
      const fd = openSync(path, constants.O_RDONLY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    unlink(path) {
      before('unlink', path);
      unlinkSync(path);
    },
  };
}

function assertDirectory(path: string, entry: Stats): void {
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('run metadata directory chain is unsafe');
  }
}

function ensurePrivateDirectoryChain(
  directory: string,
  io: RunMetaStorageIo,
): void {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    const entry = io.lstat(current);
    if (entry !== undefined) {
      assertDirectory(current, entry);
      break;
    }
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) {
      throw new Error('run metadata directory chain has no existing ancestor');
    }
    current = parent;
  }

  for (const path of missing.reverse()) {
    let created = false;
    try {
      io.mkdir(path, PRIVATE_DIRECTORY_MODE);
      created = true;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const entry = io.lstat(path);
    if (entry === undefined) {
      throw new Error('run metadata directory disappeared during creation');
    }
    assertDirectory(path, entry);
    if (created) {
      // A later fsync inside the run directory cannot persist this directory's
      // own name. Publish each new ancestor before proceeding to its child.
      io.fsyncDirectory(dirname(path));
    }
  }
}

export function writeRunMetaFileDurably(
  path: string,
  content: string,
  io: RunMetaStorageIo = createRunMetaStorageIo(),
): void {
  const parent = dirname(path);
  ensurePrivateDirectoryChain(parent, io);
  const tempPath = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = io.openExclusive(tempPath, PRIVATE_FILE_MODE);
    io.write(fd, tempPath, content);
    io.fsyncFile(fd, tempPath);
    const completedFd = fd;
    fd = undefined;
    io.close(completedFd, tempPath);
    io.rename(tempPath, path);
    renamed = true;
    // Rename durability is a separate crash boundary from file durability.
    // Throwing here prevents callers from handing off on an unproven name.
    io.fsyncDirectory(parent);
  } catch (error) {
    if (fd !== undefined) {
      try {
        io.close(fd, tempPath);
      } catch {
        // Preserve the primary failure; cleanup remains bounded to this temp.
      }
    }
    if (!renamed) {
      try {
        io.unlink(tempPath);
      } catch {
        // Never unlink the destination as a fallback. A unique temp left by a
        // failed pre-rename phase is safer than deleting published evidence.
      }
    }
    throw error;
  }
}
