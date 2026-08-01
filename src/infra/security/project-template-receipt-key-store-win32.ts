import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
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
  readonly onHashBuffer?: (buffer: Uint8Array) => void;
  readonly beforeStaleLockQuarantine?: (path: string) => void;
  readonly openStaleLock?: (path: string) => number;
  readonly renameStaleLock?: typeof renameSync;
  readonly linkStaleLock?: typeof linkSync;
}

export interface Win32ProjectTemplateReceiptKeyStoreOptions {
  readonly directory: string;
  readonly dpapi?: ProjectTemplateReceiptDpapiAdapter;
  readonly io?: Win32ProjectTemplateReceiptKeyStoreIo;
  readonly leasePolicy?: {
    readonly attempts: number;
    readonly waitMs: number;
    readonly staleAfterMs: number;
    readonly now: () => number;
    readonly isProcessAlive: (pid: number) => boolean;
  };
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
    let transferredOutput: Uint8Array | undefined;
    try {
      transferredOutput = await Reflect.apply(options.run, options, [{
        operation,
        scope: 'CurrentUser',
        input: requestInput,
        maxOutputBytes: DPAPI_MAX_BYTES,
      }]);
      if (
        !(transferredOutput instanceof Uint8Array)
        || transferredOutput.byteLength > DPAPI_MAX_BYTES
      ) {
        throw new Error();
      }
      return Uint8Array.from(transferredOutput);
    } catch {
      throw failure('DPAPI CurrentUser operation failed');
    } finally {
      requestInput.fill(0);
      transferredOutput?.fill(0);
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
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || BigInt(beforePath.dev) !== before.dev
      || BigInt(beforePath.ino) !== before.ino
    ) {
      throw failure('Key registry path identity mismatch');
    }
    if (before.size >= BigInt(DPAPI_MAX_BYTES)) throw failure('DPAPI key registry exceeds bounded maximum');
    io?.afterInitialFileStat?.(path);
    const buffer = Buffer.alloc(Number(before.size) + 1);
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
      if (BigInt(offset) !== before.size) {
        throw failure('DPAPI key registry changed during bounded read');
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
          ) throw failure('Ciphertext partial read failed');
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
      const after = fstatSync(fd, { bigint: true });
      const afterPath = lstatSync(path, { bigint: true });
      if (
        BigInt(rereadOffset) !== before.size
        || !contentStable
        || before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mode !== after.mode
        || before.nlink !== after.nlink
        || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs
        || before.birthtimeNs !== after.birthtimeNs
        || afterPath.dev !== after.dev
        || afterPath.ino !== after.ino
        || realpathSync(path) !== path
      ) throw failure('DPAPI key registry changed during bounded read');
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

interface Win32OwnedLock {
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
  readonly token: string;
}

interface Win32LockPolicy {
  readonly attempts: number;
  readonly waitMs: number;
  readonly staleAfterMs: number;
  readonly now: () => number;
  readonly isProcessAlive: (pid: number) => boolean;
}

interface Win32LockOwnerRecord {
  readonly pid: number;
  readonly createdAtMs: number;
  readonly token: string;
}

interface Win32LockObservation {
  readonly record: Win32LockOwnerRecord;
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

function parseCanonicalWin32LockOwner(
  bytes: Uint8Array,
): Win32LockOwnerRecord | undefined {
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

function sameWin32FileState(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mode === after.mode
    && before.uid === after.uid
    && before.gid === after.gid
    && before.nlink === after.nlink
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
    && before.birthtimeNs === after.birthtimeNs;
}

function observeStaleWin32Lock(
  fd: number,
  path: string,
  policy: Win32LockPolicy,
  expected?: Win32LockObservation,
  afterRename = false,
): Win32LockObservation | undefined {
  const initial = fstatSync(fd, { bigint: true });
  if (
    !initial.isFile()
    || initial.nlink !== 1n
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
      || !sameWin32FileState(initial, finalDescriptor)
      || finalPath.dev !== finalDescriptor.dev
      || finalPath.ino !== finalDescriptor.ino
      || finalPath.size !== finalDescriptor.size
      || finalPath.mode !== finalDescriptor.mode
      || finalPath.uid !== finalDescriptor.uid
      || finalPath.gid !== finalDescriptor.gid
      || finalPath.nlink !== 1n
      || finalPath.mtimeNs !== finalDescriptor.mtimeNs
      || finalPath.ctimeNs !== finalDescriptor.ctimeNs
      || finalPath.birthtimeNs !== finalDescriptor.birthtimeNs
      || (expected !== undefined && (
        expected.stat.dev !== finalDescriptor.dev
        || expected.stat.ino !== finalDescriptor.ino
        || expected.stat.size !== finalDescriptor.size
        || expected.stat.mode !== finalDescriptor.mode
        || expected.stat.uid !== finalDescriptor.uid
        || expected.stat.gid !== finalDescriptor.gid
        || expected.stat.nlink !== finalDescriptor.nlink
        || expected.stat.mtimeNs !== finalDescriptor.mtimeNs
        || expected.stat.birthtimeNs !== finalDescriptor.birthtimeNs
        || (!afterRename && expected.stat.ctimeNs !== finalDescriptor.ctimeNs)
      ))
    ) return undefined;
    const record = parseCanonicalWin32LockOwner(second.subarray(0, secondLength));
    const now = policy.now();
    if (
      record === undefined
      || !Number.isFinite(now)
      || now < 0
      || record.createdAtMs > now
      || now - record.createdAtMs < policy.staleAfterMs
      || (expected !== undefined && (
        record.pid !== expected.record.pid
        || record.createdAtMs !== expected.record.createdAtMs
        || record.token !== expected.record.token
      ))
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

function restoreQuarantinedWin32Lock(
  quarantinePath: string,
  lockPath: string,
  io: Win32ProjectTemplateReceiptKeyStoreIo | undefined,
): boolean {
  try {
    // A hard-link create is the Node/NTFS no-clobber primitive: it restores the
    // raced owner only when no newer process already recreated the lock path.
    (io?.linkStaleLock ?? linkSync)(quarantinePath, lockPath);
    unlinkSync(quarantinePath);
    return true;
  } catch {
    return false;
  }
}

function quarantineAndRemoveStaleWin32Lock(
  lockPath: string,
  fd: number,
  observation: Win32LockObservation,
  policy: Win32LockPolicy,
  io: Win32ProjectTemplateReceiptKeyStoreIo | undefined,
): boolean {
  const quarantineDirectory = mkdtempSync(join(
    dirname(lockPath),
    `.keyring.lock.stale-${observation.record.token}-`,
  ));
  const quarantinePath = join(quarantineDirectory, 'owner');
  let moved = false;
  try {
    // Node does not expose Windows rename-with-no-replace directly. A fresh
    // same-directory private directory guarantees an absent destination while
    // retaining an atomic same-volume move. EPERM/share-delete failures remain
    // fail-closed and leave the canonical owner untouched.
    (io?.renameStaleLock ?? renameSync)(lockPath, quarantinePath);
    moved = true;
    const quarantined = observeStaleWin32Lock(
      fd,
      quarantinePath,
      policy,
      observation,
      true,
    );
    if (quarantined === undefined) {
      if (restoreQuarantinedWin32Lock(quarantinePath, lockPath, io)) moved = false;
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
  path: string,
  policy: Win32LockPolicy,
  io: Win32ProjectTemplateReceiptKeyStoreIo | undefined,
): boolean {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1) return false;
    // libuv opens Windows files with share-delete support. Keeping this seam
    // explicit lets native Windows contract tests model a filesystem/provider
    // that rejects rename while the descriptor is held.
    fd = (io?.openStaleLock ?? ((lockPath) => openSync(
      lockPath,
      constants.O_RDONLY,
    )))(path);
    const descriptorStat = fstatSync(fd);
    if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) return false;
    const observation = observeStaleWin32Lock(fd, path, policy);
    if (observation === undefined) return false;
    io?.beforeStaleLockQuarantine?.(path);
    const revalidated = observeStaleWin32Lock(fd, path, policy, observation);
    if (revalidated === undefined) return false;
    return quarantineAndRemoveStaleWin32Lock(path, fd, revalidated, policy, io);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function acquireLock(
  path: string,
  policy: Win32LockPolicy,
  io: Win32ProjectTemplateReceiptKeyStoreIo | undefined,
): Promise<Win32OwnedLock> {
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    let fd: number | undefined;
    let openedOwnership: Win32OwnedLock | undefined;
    try {
      fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
      const token = randomUUID().replaceAll('-', '');
      const opened = fstatSync(fd);
      openedOwnership = { fd, dev: opened.dev, ino: opened.ino, token };
      writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        createdAtMs: policy.now(),
        token,
      }), 'utf8');
      fsyncSync(fd);
      const descriptorStat = fstatSync(fd);
      const pathStat = lstatSync(path);
      if (
        !descriptorStat.isFile()
        || descriptorStat.nlink !== 1
        || descriptorStat.dev !== pathStat.dev
        || descriptorStat.ino !== pathStat.ino
      ) throw failure('Key store lock identity mismatch');
      return {
        fd,
        dev: descriptorStat.dev,
        ino: descriptorStat.ino,
        token,
      };
    } catch (error) {
      if (openedOwnership !== undefined) {
        releaseOwnedLock(path, openedOwnership, false);
      } else if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!recoverStaleLock(path, policy, io)) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, policy.waitMs));
      }
    }
  }
  throw failure('Key store exclusive lease is unavailable');
}

function releaseOwnedLock(
  path: string,
  ownership: Win32OwnedLock,
  requireToken = true,
): void {
  const descriptorStat = fstatSync(ownership.fd);
  let tokenMatches = !requireToken;
  if (requireToken && descriptorStat.size > 0 && descriptorStat.size <= 512) {
    const bytes = Buffer.alloc(descriptorStat.size);
    const tokenBytes = Buffer.from(ownership.token, 'ascii');
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
        try {
          const parsed = JSON.parse(
            bytes.subarray(0, offset).toString('utf8'),
          ) as unknown;
          if (
            typeof parsed === 'object'
            && parsed !== null
            && !Array.isArray(parsed)
          ) {
            const descriptors = Object.getOwnPropertyDescriptors(parsed);
            tokenMatches = Reflect.ownKeys(parsed).length === 3
              && 'value' in (descriptors['token'] ?? {})
              && descriptors['token']!.value === ownership.token;
          }
        } catch {
          tokenMatches = false;
        }
      }
    } finally {
      bytes.fill(0);
      tokenBytes.fill(0);
    }
  }
  let pathStat: ReturnType<typeof lstatSync> | undefined;
  try {
    pathStat = lstatSync(path);
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
  ) unlinkSync(path);
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
  const leasePolicy: Win32LockPolicy = options.leasePolicy ?? {
    attempts: LOCK_ATTEMPTS,
    waitMs: LOCK_WAIT_MS,
    staleAfterMs: 30_000,
    now: Date.now,
    isProcessAlive: defaultProcessAlive,
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

  async function withExclusiveLease<T>(
    operation: (
      lease: ProjectTemplateReceiptKeyStoreLease,
    ) => Promise<T> | T,
  ): Promise<T> {
    if (disposed) throw failure('Key store is disposed');
    validateDirectory(directory);
    const ownedLock = await acquireLock(lockPath, leasePolicy, options.io);
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
      releaseOwnedLock(lockPath, ownedLock);
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
