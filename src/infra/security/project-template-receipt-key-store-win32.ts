import { randomUUID } from 'node:crypto';
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

const REGISTRY_NAME = 'keyring.dpapi';
const DPAPI_MAX_BYTES = 64 * 1024;
const DPAPI_TIMEOUT_MS = 10_000;

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

export interface WindowsDpapiCurrentUserAdapterOptions {
  readonly run: ProjectTemplateReceiptDpapiRunner['run'];
}

export interface Win32ProjectTemplateReceiptKeyStoreOptions {
  readonly directory: string;
  readonly dpapi?: ProjectTemplateReceiptDpapiAdapter;
}

function failure(message: string): ProjectTemplateReceiptKeyStoreError {
  return new ProjectTemplateReceiptKeyStoreError(message);
}

function boundedAppend(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maximumBytes: number,
): number {
  const next = currentBytes + chunk.byteLength;
  if (next > maximumBytes) throw failure('DPAPI output exceeds bounded maximum');
  chunks.push(chunk);
  return next;
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
} else {
  throw 'unsupported operation'
}
[Console]::Out.Write([Convert]::ToBase64String($outputBytes))
`;

export async function runWindowsDpapiCurrentUserProcess(
  request: ProjectTemplateReceiptDpapiRunRequest,
): Promise<Uint8Array> {
  if (request.scope !== 'CurrentUser') throw failure('DPAPI scope must be CurrentUser');
  if (
    !(request.input instanceof Uint8Array)
    || request.input.byteLength > DPAPI_MAX_BYTES
    || request.maxOutputBytes !== DPAPI_MAX_BYTES
  ) throw failure('DPAPI input exceeds bounded maximum');

  return await new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT,
        request.operation],
      {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    const timer = setTimeout(() => child.kill(), DPAPI_TIMEOUT_MS);

    child.stdout.on('data', (value: Buffer) => {
      try {
        stdoutBytes = boundedAppend(
          stdout,
          Buffer.from(value),
          stdoutBytes,
          request.maxOutputBytes,
        );
      } catch {
        outputExceeded = true;
        child.kill();
      }
    });
    child.stderr.on('data', (value: Buffer) => {
      // Why: consume only a bounded count. Never retain or reflect subprocess
      // diagnostics because PowerShell errors can echo secret-bearing input.
      stderrBytes = Math.min(DPAPI_MAX_BYTES + 1, stderrBytes + value.byteLength);
      if (stderrBytes > DPAPI_MAX_BYTES) child.kill();
    });
    child.once('error', () => {
      clearTimeout(timer);
      rejectPromise(failure('DPAPI CurrentUser process failed'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || outputExceeded || stderrBytes > DPAPI_MAX_BYTES) {
        rejectPromise(failure('DPAPI CurrentUser process failed'));
        return;
      }
      const encoded = Buffer.concat(stdout).toString('ascii');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        rejectPromise(failure('DPAPI CurrentUser returned invalid output'));
        return;
      }
      const result = Buffer.from(encoded, 'base64');
      if (result.byteLength > request.maxOutputBytes) {
        rejectPromise(failure('DPAPI output exceeds bounded maximum'));
        return;
      }
      resolvePromise(result);
    });
    child.stdin.end(Buffer.from(request.input).toString('base64'));
  });
}

export function createWindowsDpapiCurrentUserAdapter(
  options: WindowsDpapiCurrentUserAdapterOptions = {
    run: runWindowsDpapiCurrentUserProcess,
  },
): ProjectTemplateReceiptDpapiAdapter {
  const run = options.run;
  async function invoke(
    operation: ProjectTemplateReceiptDpapiRunRequest['operation'],
    input: Uint8Array,
  ): Promise<Uint8Array> {
    if (!(input instanceof Uint8Array) || input.byteLength > DPAPI_MAX_BYTES) {
      throw failure('DPAPI input exceeds bounded maximum');
    }
    try {
      const output = await Reflect.apply(run, options, [{
        operation,
        scope: 'CurrentUser',
        input: input.slice(),
        maxOutputBytes: DPAPI_MAX_BYTES,
      }]);
      if (!(output instanceof Uint8Array) || output.byteLength > DPAPI_MAX_BYTES) {
        throw failure('DPAPI output exceeds bounded maximum');
      }
      return output.slice();
    } catch {
      // Why: adapters and subprocesses are untrusted error sources. A stable
      // message prevents plaintext or ciphertext from escaping through errors.
      throw failure('DPAPI CurrentUser operation failed');
    }
  }
  return Object.freeze({
    scope: 'CurrentUser' as const,
    protect: async (plaintext: Uint8Array) => invoke('protect', plaintext),
    unprotect: async (ciphertext: Uint8Array) => invoke('unprotect', ciphertext),
  });
}

function validateDirectory(directory: string): void {
  if (
    !isAbsolute(directory)
    || normalize(directory) !== directory
    || directory.includes('\0')
  ) throw failure('Key store directory must have canonical identity');
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) throw failure('Key store directory is a reparse link');
  if (!stat.isDirectory()) throw failure('Key store path is not a directory');
  if (realpathSync(directory) !== directory) {
    throw failure('Key store directory canonical identity mismatch');
  }
}

function openIdentityChecked(path: string): number {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw failure('Key registry is a reparse link');
  if (!before.isFile()) throw failure('Key registry is not a regular file');
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const after = fstatSync(fd);
    if (
      !after.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || after.nlink !== 1
    ) throw failure('Key registry path identity mismatch');
    if (after.size > DPAPI_MAX_BYTES) {
      throw failure('DPAPI key registry exceeds bounded maximum');
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function createWin32ProjectTemplateReceiptKeyStore(
  options: Win32ProjectTemplateReceiptKeyStoreOptions,
): ProjectTemplateReceiptKeyStore {
  const directory = resolve(options.directory);
  if (directory !== options.directory) {
    throw failure('Key store directory must have canonical identity');
  }
  const dpapi = options.dpapi ?? createWindowsDpapiCurrentUserAdapter();
  if (dpapi.scope !== 'CurrentUser') throw failure('DPAPI scope must be CurrentUser');
  const registryPath = join(directory, REGISTRY_NAME);
  let disposed = false;

  function available(): void {
    if (disposed) throw failure('Key store is disposed');
  }

  return Object.freeze({
    async read() {
      available();
      validateDirectory(directory);
      if (!existsSync(registryPath)) return undefined;
      const fd = openIdentityChecked(registryPath);
      let ciphertext: Buffer;
      try {
        ciphertext = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
      let plaintext: Uint8Array | undefined;
      try {
        plaintext = await dpapi.unprotect(ciphertext);
        if (plaintext.byteLength > PROJECT_TEMPLATE_RECEIPT_KEY_REGISTRY_MAX_BYTES) {
          throw failure('Plaintext key registry exceeds bounded maximum');
        }
        return parseProjectTemplateReceiptKeyRegistry(plaintext);
      } finally {
        plaintext?.fill(0);
        ciphertext.fill(0);
      }
    },

    async write(registry: ProjectTemplateReceiptKeyRegistry) {
      available();
      validateDirectory(directory);
      const plaintext = serializeProjectTemplateReceiptKeyRegistry(registry);
      let ciphertext: Uint8Array | undefined;
      const temporaryPath = join(directory, `.${REGISTRY_NAME}.${randomUUID()}.tmp`);
      let fd: number | undefined;
      try {
        ciphertext = await dpapi.protect(plaintext);
        if (ciphertext.byteLength === 0 || ciphertext.byteLength > DPAPI_MAX_BYTES) {
          throw failure('DPAPI output exceeds bounded maximum');
        }
        if (existsSync(registryPath)) {
          const existingFd = openIdentityChecked(registryPath);
          closeSync(existingFd);
        }
        fd = openSync(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        writeFileSync(fd, ciphertext);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporaryPath, registryPath);
        const directoryFd = openSync(directory, constants.O_RDONLY);
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
      } catch {
        throw failure('DPAPI CurrentUser key registry write failed');
      } finally {
        plaintext.fill(0);
        ciphertext?.fill(0);
        if (fd !== undefined) closeSync(fd);
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      }
    },

    async dispose() {
      disposed = true;
    },
  });
}
