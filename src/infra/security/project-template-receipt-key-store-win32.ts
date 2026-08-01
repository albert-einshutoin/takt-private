import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
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
import type { Readable, Writable } from 'node:stream';
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

const REGISTRY_NAME = 'keyring.dpapi';
const LOCK_NAME = '.keyring.lock';
const DPAPI_MAX_BYTES = 64 * 1024;
const DPAPI_TIMEOUT_MS = 10_000;
const LOCK_WAIT_MS = 5;
const LOCK_ATTEMPTS = 1_000;

export interface ProjectTemplateReceiptDpapiAdapter {
  readonly scope: 'CurrentUser';
  protect(plaintext: Uint8Array): Promise<Uint8Array>;
  unprotect(ciphertext: Uint8Array): Promise<Uint8Array>;
}

export interface ProjectTemplateReceiptDpapiRunRequest {
  readonly operation: 'protect' | 'unprotect';
  readonly scope: 'CurrentUser';
  readonly input: Uint8Array;
  readonly maxOutputBytes: number;
}

export interface ProjectTemplateReceiptDpapiRunner {
  run(request: ProjectTemplateReceiptDpapiRunRequest): Promise<Uint8Array>;
}

interface DpapiChildProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: 'error', listener: () => void): this;
  once(event: 'close', listener: (code: number | null) => void): this;
  removeListener(event: 'error' | 'close', listener: (...args: never[]) => void): this;
  kill(): boolean;
}

export interface WindowsDpapiProcessDependencies {
  readonly spawnProcess: (
    command: string,
    args: readonly string[],
    options: { readonly shell: false; readonly windowsHide: true; readonly stdio: ['pipe', 'pipe', 'pipe'] },
  ) => DpapiChildProcess;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface WindowsDpapiCurrentUserAdapterOptions {
  readonly run: ProjectTemplateReceiptDpapiRunner['run'];
}

export interface Win32ProjectTemplateReceiptKeyStoreIo {
  readonly afterInitialFileStat?: (path: string) => void;
  readonly beforeFinalFileStat?: (path: string) => void;
  readonly read?: typeof readSync;
  readonly close?: typeof closeSync;
  readonly fsyncDirectory?: (directory: string) => void;
}

export interface Win32ProjectTemplateReceiptKeyStoreOptions {
  readonly directory: string;
  readonly dpapi?: ProjectTemplateReceiptDpapiAdapter;
  readonly io?: Win32ProjectTemplateReceiptKeyStoreIo;
}

function failure(message: string): ProjectTemplateReceiptKeyStoreError {
  return new ProjectTemplateReceiptKeyStoreError(message);
}

const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$encoded = [Console]::In.ReadToEnd().Trim()
$inputBytes = [Convert]::FromBase64String($encoded)
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($args[0] -eq 'protect') {
  $outputBytes = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, $scope)
} elseif ($args[0] -eq 'unprotect') {
  $outputBytes = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, $scope)
} else { throw 'unsupported operation' }
[Console]::Out.Write([Convert]::ToBase64String($outputBytes))
`;

const DEFAULT_PROCESS_DEPENDENCIES: WindowsDpapiProcessDependencies = {
  spawnProcess: (command, args, options) => spawn(command, [...args], {
    ...options,
    stdio: [...options.stdio],
  }) as
    unknown as DpapiChildProcess,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export async function runWindowsDpapiCurrentUserProcess(
  request: ProjectTemplateReceiptDpapiRunRequest,
  dependencies: WindowsDpapiProcessDependencies = DEFAULT_PROCESS_DEPENDENCIES,
): Promise<Uint8Array> {
  if (request.scope !== 'CurrentUser') throw failure('DPAPI scope must be CurrentUser');
  if (
    !(request.input instanceof Uint8Array)
    || request.input.byteLength > DPAPI_MAX_BYTES
    || request.maxOutputBytes !== DPAPI_MAX_BYTES
  ) throw failure('DPAPI input exceeds bounded maximum');

  return await new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
    let child: DpapiChildProcess;
    try {
      child = dependencies.spawnProcess(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT,
          request.operation],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      rejectPromise(failure('DPAPI CurrentUser process failed'));
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timerState: { handle?: unknown } = {};

    const cleanup = () => {
      dependencies.clearTimer(timerState.handle);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('error', onError as (...args: never[]) => void);
      child.removeListener('close', onClose as (...args: never[]) => void);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      for (const chunk of stdout) chunk.fill(0);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const resolveOnce = (value: Uint8Array) => {
      if (settled) {
        value.fill(0);
        return;
      }
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const onStdout = (value: Buffer) => {
      if (settled) return;
      const chunk = Buffer.from(value);
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > request.maxOutputBytes) {
        chunk.fill(0);
        rejectOnce(failure('DPAPI output exceeds bounded maximum'));
        child.kill();
        return;
      }
      stdout.push(chunk);
    };
    const onStderr = (value: Buffer) => {
      if (settled) return;
      stderrBytes += value.byteLength;
      if (stderrBytes > DPAPI_MAX_BYTES) {
        rejectOnce(failure('DPAPI stderr exceeds bounded maximum'));
        child.kill();
      }
    };
    const onError = () => rejectOnce(failure('DPAPI CurrentUser process failed'));
    const onClose = (code: number | null) => {
      if (settled) return;
      if (code !== 0 || stderrBytes > DPAPI_MAX_BYTES || stdoutBytes === 0) {
        rejectOnce(failure('DPAPI CurrentUser process failed'));
        return;
      }
      const joined = Buffer.concat(stdout);
      try {
        const encoded = joined.toString('ascii');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
          rejectOnce(failure('DPAPI CurrentUser returned invalid output'));
          return;
        }
        const decoded = Uint8Array.from(Buffer.from(encoded, 'base64'));
        if (decoded.byteLength === 0 || decoded.byteLength > request.maxOutputBytes) {
          decoded.fill(0);
          rejectOnce(failure('DPAPI output exceeds bounded maximum'));
          return;
        }
        resolveOnce(decoded);
      } finally {
        joined.fill(0);
      }
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);
    timerState.handle = dependencies.setTimer(() => {
      if (settled) return;
      rejectOnce(failure('DPAPI CurrentUser process timed out'));
      child.kill();
    }, DPAPI_TIMEOUT_MS);
    child.stdin.end(Buffer.from(request.input).toString('base64'));
  });
}

export function createWindowsDpapiCurrentUserAdapter(
  options: WindowsDpapiCurrentUserAdapterOptions = {
    run: runWindowsDpapiCurrentUserProcess,
  },
): ProjectTemplateReceiptDpapiAdapter {
  async function invoke(operation: 'protect' | 'unprotect', input: Uint8Array) {
    if (!(input instanceof Uint8Array) || input.byteLength > DPAPI_MAX_BYTES) {
      throw failure('DPAPI input exceeds bounded maximum');
    }
    const requestInput = Uint8Array.from(input);
    try {
      const output = await Reflect.apply(options.run, options, [{
        operation,
        scope: 'CurrentUser',
        input: requestInput,
        maxOutputBytes: DPAPI_MAX_BYTES,
      }]);
      if (!(output instanceof Uint8Array) || output.byteLength > DPAPI_MAX_BYTES) {
        throw new Error();
      }
      return Uint8Array.from(output);
    } catch {
      throw failure('DPAPI CurrentUser operation failed');
    } finally {
      requestInput.fill(0);
    }
  }
  return Object.freeze({
    scope: 'CurrentUser' as const,
    protect: (plaintext: Uint8Array) => invoke('protect', plaintext),
    unprotect: (ciphertext: Uint8Array) => invoke('unprotect', ciphertext),
  });
}

function validateDirectory(directory: string): void {
  if (!isAbsolute(directory) || normalize(directory) !== directory || directory.includes('\0')) {
    throw failure('Key store directory must have canonical identity');
  }
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) throw failure('Key store directory is a reparse link');
  if (!stat.isDirectory()) throw failure('Key store path is not a directory');
  if (realpathSync(directory) !== directory) throw failure('Key store directory canonical identity mismatch');
}

function readBoundedCiphertext(
  path: string,
  io: Win32ProjectTemplateReceiptKeyStoreIo | undefined,
): Uint8Array {
  const beforePath = lstatSync(path);
  if (beforePath.isSymbolicLink()) throw failure('Key registry is a reparse link');
  if (realpathSync(path) !== path) {
    throw failure('Key registry canonical identity mismatch');
  }
  const fd = openSync(path, constants.O_RDONLY);
  let output: Uint8Array | undefined;
  let primaryFailure: unknown;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || beforePath.dev !== before.dev || beforePath.ino !== before.ino) {
      throw failure('Key registry path identity mismatch');
    }
    if (before.size >= DPAPI_MAX_BYTES) throw failure('DPAPI key registry exceeds bounded maximum');
    io?.afterInitialFileStat?.(path);
    const buffer = Buffer.alloc(before.size + 1);
    try {
      let offset = 0;
      const read = io?.read ?? readSync;
      while (offset < buffer.byteLength) {
        const count = Reflect.apply(read, io, [fd, buffer, offset,
          buffer.byteLength - offset, offset]) as number;
        if (
          !Number.isSafeInteger(count)
          || count < 0
          || count > buffer.byteLength - offset
        ) throw failure('Ciphertext partial read failed');
        if (count === 0) break;
        offset += count;
      }
      io?.beforeFinalFileStat?.(path);
      const after = fstatSync(fd);
      const afterPath = lstatSync(path);
      if (
        offset !== before.size
        || before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mode !== after.mode
        || before.nlink !== after.nlink
        || afterPath.dev !== after.dev
        || afterPath.ino !== after.ino
        || realpathSync(path) !== path
      ) throw failure('DPAPI key registry changed during bounded read');
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
  if (output === undefined) throw failure('DPAPI key registry bounded read failed');
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

function sameSnapshot(
  left: ProjectTemplateReceiptKeySnapshot,
  right: ProjectTemplateReceiptKeySnapshot,
): boolean {
  const leftBytes = serializeProjectTemplateReceiptKeySnapshot(left);
  const rightBytes = serializeProjectTemplateReceiptKeySnapshot(right);
  try {
    return leftBytes.byteLength === rightBytes.byteLength
      && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

async function readSnapshot(
  path: string,
  dpapi: ProjectTemplateReceiptDpapiAdapter,
  io: Win32ProjectTemplateReceiptKeyStoreIo | undefined,
) {
  if (!existsSync(path)) return undefined;
  const ciphertext = readBoundedCiphertext(path, io);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await dpapi.unprotect(ciphertext);
    if (plaintext.byteLength > PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES) {
      throw failure('Plaintext key registry exceeds bounded maximum');
    }
    return parseProjectTemplateReceiptKeySnapshot(plaintext);
  } finally {
    plaintext?.fill(0);
    ciphertext.fill(0);
  }
}

function fsyncDirectoryBestEffort(
  directory: string,
  io: Win32ProjectTemplateReceiptKeyStoreIo | undefined,
): void {
  if (io?.fsyncDirectory !== undefined) {
    io.fsyncDirectory(directory);
    return;
  }
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'EBADF' && code !== 'EISDIR' && code !== 'EPERM') {
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function publishSnapshot(
  directory: string,
  registryPath: string,
  snapshot: ProjectTemplateReceiptKeySnapshot,
  dpapi: ProjectTemplateReceiptDpapiAdapter,
  io: Win32ProjectTemplateReceiptKeyStoreIo | undefined,
): Promise<void> {
  const plaintext = serializeProjectTemplateReceiptKeySnapshot(snapshot);
  let ciphertext: Uint8Array | undefined;
  const temporaryPath = join(directory, `.${REGISTRY_NAME}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let published = false;
  try {
    ciphertext = await dpapi.protect(plaintext);
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > DPAPI_MAX_BYTES) {
      throw failure('DPAPI output exceeds bounded maximum');
    }
    fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, ciphertext);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, registryPath);
    published = true;
    try {
      fsyncDirectoryBestEffort(directory, io);
    } catch {
      const observed = await readSnapshot(registryPath, dpapi, io);
      try {
        if (observed === undefined || !sameSnapshot(observed, snapshot)) {
          throw failure('DPAPI key registry publication state is unknown');
        }
      } finally {
        zeroizeSnapshot(observed);
      }
    }
  } catch {
    throw failure(published
      ? 'DPAPI key registry publication state is unknown'
      : 'DPAPI CurrentUser key registry write failed');
  } finally {
    plaintext.fill(0);
    ciphertext?.fill(0);
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

async function acquireLock(path: string): Promise<number> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, `${process.pid}\n`, 'utf8');
      fsyncSync(fd);
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_WAIT_MS));
    }
  }
  throw failure('Key store exclusive lease is unavailable');
}

export function createWin32ProjectTemplateReceiptKeyStore(
  options: Win32ProjectTemplateReceiptKeyStoreOptions,
): ProjectTemplateReceiptKeyStore {
  const directory = resolve(options.directory);
  if (directory !== options.directory) throw failure('Key store directory must have canonical identity');
  const dpapi = options.dpapi ?? createWindowsDpapiCurrentUserAdapter();
  if (dpapi.scope !== 'CurrentUser') throw failure('DPAPI scope must be CurrentUser');
  const registryPath = join(directory, REGISTRY_NAME);
  const lockPath = join(directory, LOCK_NAME);
  let disposed = false;

  async function withExclusiveLease<T>(
    operation: (
      lease: ProjectTemplateReceiptKeyStoreLease,
    ) => Promise<T> | T,
  ): Promise<T> {
    if (disposed) throw failure('Key store is disposed');
    validateDirectory(directory);
    const lockFd = await acquireLock(lockPath);
    let snapshot: ProjectTemplateReceiptKeySnapshot | undefined;
    try {
      snapshot = await readSnapshot(registryPath, dpapi, options.io);
      let committed = false;
      const result = await operation(Object.freeze({
        snapshot,
        async compareAndSwap(
          expectedGeneration: number | undefined,
          registry: ProjectTemplateReceiptKeyRegistry,
        ) {
          if (committed) throw failure('Key store lease already committed');
          if (expectedGeneration !== snapshot?.generation) return undefined;
          const next = {
            generation: (snapshot?.generation ?? -1) + 1,
            registry: cloneRegistry(registry),
          };
          try {
            await publishSnapshot(directory, registryPath, next, dpapi, options.io);
            committed = true;
            zeroizeSnapshot(snapshot);
            snapshot = next;
            return { generation: next.generation, registry: cloneRegistry(next.registry) };
          } catch (error) {
            zeroizeSnapshot(next);
            throw error;
          }
        },
      }));
      return result;
    } finally {
      zeroizeSnapshot(snapshot);
      closeSync(lockFd);
      if (existsSync(lockPath)) unlinkSync(lockPath);
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
        const written = await lease.compareAndSwap(lease.snapshot?.generation, registry);
        if (written === undefined) throw failure('Key registry generation conflict');
        zeroizeSnapshot(written);
      });
    },
    withExclusiveLease,
    async dispose() { disposed = true; },
  });
}
