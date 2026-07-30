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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

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

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

function resolveDirectoryChain(
  trustedRoot: string,
  directory: string,
): string[] {
  const root = resolve(trustedRoot);
  const target = resolve(directory);
  const relativeTarget = relative(root, target);
  if (
    relativeTarget === '..'
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget)
  ) {
    throw new Error('run metadata path is outside trusted project root');
  }
  return relativeTarget === ''
    ? [root]
    : [
        root,
        ...relativeTarget.split(sep).reduce<string[]>((paths, segment) => {
          paths.push(join(paths.at(-1) ?? root, segment));
          return paths;
        }, []),
      ];
}

function validateDirectoryChain(
  trustedRoot: string,
  directory: string,
  io: RunMetaStorageIo,
): DirectoryIdentity[] {
  const chain = resolveDirectoryChain(trustedRoot, directory);
  return chain.map((path) => {
    const entry = io.lstat(path);
    if (entry === undefined) {
      throw new Error('run metadata directory disappeared during validation');
    }
    assertDirectory(path, entry);
    return { path, dev: entry.dev, ino: entry.ino };
  });
}

function assertDirectoryChainIdentity(
  expected: readonly DirectoryIdentity[],
  trustedRoot: string,
  directory: string,
  io: RunMetaStorageIo,
): void {
  const actual = validateDirectoryChain(trustedRoot, directory, io);
  if (
    actual.length !== expected.length
    || actual.some((entry, index) => (
      entry.path !== expected[index]?.path
      || entry.dev !== expected[index]?.dev
      || entry.ino !== expected[index]?.ino
    ))
  ) {
    throw new Error('run metadata directory chain identity changed');
  }
}

function ensurePrivateDirectoryChain(
  trustedRoot: string,
  directory: string,
  io: RunMetaStorageIo,
): void {
  const chain = resolveDirectoryChain(trustedRoot, directory);
  const trustedEntry = io.lstat(chain[0]!);
  if (trustedEntry === undefined) {
    throw new Error('run metadata trusted project root does not exist');
  }
  assertDirectory(chain[0]!, trustedEntry);

  for (const path of chain.slice(1)) {
    const parent = dirname(path);
    if (io.lstat(path) === undefined) {
      try {
        io.mkdir(path, PRIVATE_DIRECTORY_MODE);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
    }
    const entry = io.lstat(path);
    if (entry === undefined) {
      throw new Error('run metadata directory disappeared during creation');
    }
    assertDirectory(path, entry);
    // Re-sync every dependency, including an EEXIST race or a retry after a
    // prior fsync failure. Existence alone does not prove durable publication.
    io.fsyncDirectory(parent);
  }
}

export function writeRunMetaFileDurably(
  path: string,
  content: string,
  trustedRoot: string,
  io: RunMetaStorageIo = createRunMetaStorageIo(),
): void {
  const parent = dirname(path);
  ensurePrivateDirectoryChain(trustedRoot, parent, io);
  // Revalidate the complete trusted-root-relative chain immediately before
  // opening through pathnames to narrow directory replacement races.
  const directoryIdentity = validateDirectoryChain(trustedRoot, parent, io);
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
    // The chain may have changed while the temp file was written. Never rename
    // through a component that is now a symlink or outside the trusted root.
    assertDirectoryChainIdentity(
      directoryIdentity,
      trustedRoot,
      parent,
      io,
    );
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
        // Cleanup is safe only while the original parent chain still validates;
        // otherwise pathname cleanup could unlink an attacker-controlled file.
        assertDirectoryChainIdentity(
          directoryIdentity,
          trustedRoot,
          parent,
          io,
        );
        io.unlink(tempPath);
      } catch {
        // Never unlink the destination as a fallback. A unique temp left by a
        // failed pre-rename phase is safer than deleting published evidence.
      }
    }
    throw error;
  }
}
