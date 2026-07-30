import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { crossSpawn } from '../../shared/utils/spawn.js';

const AUTH_ATTEMPT_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 1_000;
const MAX_STDOUT_BYTES = 4 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const GH_AUTH_ARGS = Object.freeze([
  'auth',
  'token',
  '--hostname',
  'github.com',
] as const);
const ALLOWED_ENV_NAMES = Object.freeze([
  'PATH',
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'DBUS_SESSION_BUS_ADDRESS',
  'GH_CONFIG_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const);

export type ProjectTemplateGhAuthErrorCode =
  | 'INVALID_ARGUMENT'
  | 'GH_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'OUTPUT_LIMIT'
  | 'INVALID_TOKEN'
  | 'PROCESS_FAILED'
  | 'CREDENTIAL_DISPOSED'
  | 'ASYNC_TOKEN_USE';

export class ProjectTemplateGhAuthError extends Error {
  constructor(
    public readonly code: ProjectTemplateGhAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectTemplateGhAuthError';
  }
}

export interface ProjectTemplateGhAuthDependencies {
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

export interface AcquireProjectTemplateGhCredentialOptions {
  readonly signal?: AbortSignal;
  /**
   * Absolute deadline in the same monotonic time domain as performance.now().
   * The future metadata/download wrapper owns this shared deadline.
   */
  readonly deadlineMs: number;
}

export interface DisposableProjectTemplateGhCredential {
  withToken<T>(callback: (token: string) => T): T;
  dispose(): void;
}

interface CredentialAuthority {
  readonly token: Buffer;
  state: 'active' | 'disposed';
}

type PendingFailureCode =
  | 'TIMEOUT'
  | 'ABORTED'
  | 'OUTPUT_LIMIT';

const CREDENTIAL_AUTHORITIES = new WeakMap<
object,
CredentialAuthority
>();

function authError(
  code: ProjectTemplateGhAuthErrorCode,
  message: string,
): ProjectTemplateGhAuthError {
  return Object.freeze(new ProjectTemplateGhAuthError(code, message));
}

function isThenableWithoutExecuting(value: unknown): boolean {
  if (
    (typeof value !== 'object' || value === null)
    && typeof value !== 'function'
  ) return false;
  let current: object | null = value as object;
  while (current !== null) {
    if (types.isProxy(current)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(current, 'then');
    if (descriptor !== undefined) {
      return !('value' in descriptor)
        || typeof descriptor.value === 'function';
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function createCredential(
  token: Buffer,
): DisposableProjectTemplateGhCredential {
  // The frozen facade carries no token state. WeakMap authority makes copied
  // methods and forged receivers fail closed while still permitting zero-fill.
  const credential: DisposableProjectTemplateGhCredential = {
    withToken<T>(callback: (tokenValue: string) => T): T {
      const authority = CREDENTIAL_AUTHORITIES.get(this);
      if (authority === undefined || authority.state !== 'active') {
        throw authError(
          'CREDENTIAL_DISPOSED',
          'GitHub credential is no longer available',
        );
      }
      if (typeof callback !== 'function' || types.isProxy(callback)) {
        throw authError(
          'INVALID_ARGUMENT',
          'GitHub credential callback is invalid',
        );
      }
      const result = callback(authority.token.toString('ascii'));
      if (isThenableWithoutExecuting(result)) {
        throw authError(
          'ASYNC_TOKEN_USE',
          'GitHub credential callback must complete synchronously',
        );
      }
      return result;
    },
    dispose(): void {
      const authority = CREDENTIAL_AUTHORITIES.get(this);
      if (authority === undefined) {
        throw authError(
          'CREDENTIAL_DISPOSED',
          'GitHub credential is no longer available',
        );
      }
      if (authority.state === 'disposed') return;
      authority.token.fill(0);
      authority.state = 'disposed';
    },
  };
  CREDENTIAL_AUTHORITIES.set(credential, {
    token,
    state: 'active',
  });
  return Object.freeze(credential);
}

const DEFAULT_DEPENDENCIES: ProjectTemplateGhAuthDependencies =
  Object.freeze({
    spawn: crossSpawn,
  });

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw authError(
      'INVALID_ARGUMENT',
      'GitHub credential bootstrap input is invalid',
    );
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some(
      (key) => typeof key !== 'string' || !keys.includes(key),
    )
  ) {
    throw authError(
      'INVALID_ARGUMENT',
      'GitHub credential bootstrap input is invalid',
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw authError(
        'INVALID_ARGUMENT',
        'GitHub credential bootstrap input is invalid',
      );
    }
  }
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key]!.value]),
  );
}

function snapshotSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== AbortSignal.prototype
  ) {
    throw authError(
      'INVALID_ARGUMENT',
      'GitHub credential abort signal is invalid',
    );
  }
  return value as AbortSignal;
}

function snapshotOptions(
  value: AcquireProjectTemplateGhCredentialOptions,
): {
  readonly signal?: AbortSignal;
  readonly deadlineMs: number;
} {
  const candidateKeys = (
    typeof value === 'object'
    && value !== null
    && !types.isProxy(value)
  )
    ? Reflect.ownKeys(value)
    : [];
  const keys = candidateKeys.includes('signal')
    ? ['signal', 'deadlineMs']
    : ['deadlineMs'];
  const options = exactDataRecord(value, keys);
  const deadlineMs = options['deadlineMs'];
  if (
    typeof deadlineMs !== 'number'
    || !Number.isFinite(deadlineMs)
    || deadlineMs < 0
  ) {
    throw authError(
      'INVALID_ARGUMENT',
      'GitHub credential deadline is invalid',
    );
  }
  const signal = snapshotSignal(options['signal']);
  return Object.freeze({
    deadlineMs,
    ...(signal === undefined ? {} : { signal }),
  });
}

function snapshotDependencies(
  value: ProjectTemplateGhAuthDependencies | undefined,
): ProjectTemplateGhAuthDependencies {
  if (value === undefined) return DEFAULT_DEPENDENCIES;
  const dependencies = exactDataRecord(value, ['spawn']);
  if (
    typeof dependencies['spawn'] !== 'function'
    || types.isProxy(dependencies['spawn'])
  ) {
    throw authError(
      'INVALID_ARGUMENT',
      'GitHub credential bootstrap dependency is invalid',
    );
  }
  return Object.freeze({
    spawn: dependencies['spawn'] as
      ProjectTemplateGhAuthDependencies['spawn'],
  });
}

function isSignalAborted(signal: AbortSignal): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    'aborted',
  );
  return descriptor?.get?.call(signal) === true;
}

function addAbortListener(
  signal: AbortSignal,
  listener: () => void,
): void {
  EventTarget.prototype.addEventListener.call(
    signal,
    'abort',
    listener,
    { once: true },
  );
}

function removeAbortListener(
  signal: AbortSignal,
  listener: () => void,
): void {
  EventTarget.prototype.removeEventListener.call(
    signal,
    'abort',
    listener,
  );
}

function buildGhEnvironment(): NodeJS.ProcessEnv {
  // In particular, never inherit GH_DEBUG/GH_FORCE_TTY or arbitrary caller
  // variables: gh must neither echo credentials nor open an interactive path.
  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const name of ALLOWED_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env['GH_PROMPT_DISABLED'] = '1';
  env['GH_PAGER'] = 'cat';
  env['PAGER'] = 'cat';
  env['NO_COLOR'] = '1';
  env['TERM'] = 'dumb';
  env['CLICOLOR'] = '0';
  env['CLICOLOR_FORCE'] = '0';
  return env;
}

function wipeBuffers(buffers: readonly Buffer[]): void {
  for (const buffer of buffers) buffer.fill(0);
}

function parseToken(stdout: Buffer): Buffer {
  const payloadLength = (
    stdout.length > 0
    && stdout[stdout.length - 1] === 0x0a
  )
    ? stdout.length - 1
    : stdout.length;
  if (payloadLength === 0) {
    throw authError(
      'INVALID_TOKEN',
      'GitHub CLI returned an invalid credential',
    );
  }
  for (let index = 0; index < payloadLength; index += 1) {
    const byte = stdout[index]!;
    if (byte < 0x21 || byte > 0x7e) {
      throw authError(
        'INVALID_TOKEN',
        'GitHub CLI returned an invalid credential',
      );
    }
  }
  if (
    payloadLength !== stdout.length
    && stdout.subarray(0, payloadLength).includes(0x0a)
  ) {
    throw authError(
      'INVALID_TOKEN',
      'GitHub CLI returned an invalid credential',
    );
  }
  return Buffer.from(stdout.subarray(0, payloadLength));
}

function mapProcessError(error: unknown): ProjectTemplateGhAuthError {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT'
  ) {
    return authError(
      'GH_UNAVAILABLE',
      'GitHub CLI is unavailable',
    );
  }
  return authError(
    'PROCESS_FAILED',
    'GitHub credential bootstrap failed',
  );
}

function pendingFailureError(
  code: PendingFailureCode,
): ProjectTemplateGhAuthError {
  if (code === 'TIMEOUT') {
    return authError(
      code,
      'GitHub credential bootstrap timed out',
    );
  }
  if (code === 'ABORTED') {
    return authError(
      code,
      'GitHub credential bootstrap was cancelled',
    );
  }
  return authError(
    code,
    'GitHub credential bootstrap output exceeded its limit',
  );
}

export async function acquireProjectTemplateGhCredential(
  optionsValue: AcquireProjectTemplateGhCredentialOptions,
  dependenciesValue?: ProjectTemplateGhAuthDependencies,
): Promise<DisposableProjectTemplateGhCredential> {
  let options: ReturnType<typeof snapshotOptions>;
  let dependencies: ProjectTemplateGhAuthDependencies;
  try {
    options = snapshotOptions(optionsValue);
    dependencies = snapshotDependencies(dependenciesValue);
  } catch {
    throw authError(
      'INVALID_ARGUMENT',
      'GitHub credential bootstrap input is invalid',
    );
  }
  if (options.signal !== undefined && isSignalAborted(options.signal)) {
    throw authError(
      'ABORTED',
      'GitHub credential bootstrap was cancelled',
    );
  }
  const remainingMs = options.deadlineMs - performance.now();
  if (remainingMs <= 0) {
    throw authError(
      'TIMEOUT',
      'GitHub credential bootstrap timed out',
    );
  }
  const effectiveTimeoutMs = Math.min(
    AUTH_ATTEMPT_TIMEOUT_MS,
    remainingMs,
  );

  return new Promise<DisposableProjectTemplateGhCredential>(
    (resolve, reject) => {
      let child: ChildProcess;
      try {
        child = dependencies.spawn('gh', GH_AUTH_ARGS, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildGhEnvironment(),
        });
      } catch (error) {
        reject(mapProcessError(error));
        return;
      }
      if (child.stdout === null || child.stderr === null) {
        reject(authError(
          'PROCESS_FAILED',
          'GitHub credential bootstrap failed',
        ));
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let pendingFailure: PendingFailureCode | undefined;
      const timers: {
        timeout?: ReturnType<typeof setTimeout>;
        forceKill?: ReturnType<typeof setTimeout>;
      } = {};

      const abortHandler = (): void => {
        terminate('ABORTED');
      };

      const cleanup = (): void => {
        if (timers.timeout !== undefined) clearTimeout(timers.timeout);
        if (timers.forceKill !== undefined) {
          clearTimeout(timers.forceKill);
        }
        if (options.signal !== undefined) {
          removeAbortListener(options.signal, abortHandler);
        }
      };

      const rejectOnce = (error: ProjectTemplateGhAuthError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        wipeBuffers(stdoutChunks);
        wipeBuffers(stderrChunks);
        reject(error);
      };

      const terminate = (code: PendingFailureCode): void => {
        if (settled || pendingFailure !== undefined) return;
        pendingFailure = code;
        child.kill('SIGTERM');
        // Rejection is deliberately deferred to "close": callers must never
        // continue while a credential-producing child may still be alive.
        timers.forceKill = setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, FORCE_KILL_DELAY_MS);
        timers.forceKill.unref?.();
      };

      const append = (
        target: 'stdout' | 'stderr',
        chunk: Buffer | string,
      ): void => {
        if (settled || pendingFailure !== undefined) return;
        const byteLength = Buffer.isBuffer(chunk)
          ? chunk.length
          : Buffer.byteLength(chunk, 'utf8');
        if (target === 'stdout') {
          // Check before copying so even one hostile chunk cannot make our
          // retained credential buffer exceed the documented bound.
          if (stdoutBytes + byteLength > MAX_STDOUT_BYTES) {
            terminate('OUTPUT_LIMIT');
            return;
          }
          const buffer = Buffer.from(chunk);
          stdoutChunks.push(buffer);
          stdoutBytes += byteLength;
          return;
        }
        if (stderrBytes + byteLength > MAX_STDERR_BYTES) {
          terminate('OUTPUT_LIMIT');
          return;
        }
        const buffer = Buffer.from(chunk);
        stderrChunks.push(buffer);
        stderrBytes += byteLength;
      };

      child.stdout.on('data', (chunk: Buffer | string) => {
        append('stdout', chunk);
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        append('stderr', chunk);
      });
      child.on('error', (error: unknown) => {
        if (pendingFailure !== undefined) return;
        rejectOnce(mapProcessError(error));
      });
      child.on('close', (exitCode: number | null) => {
        if (settled) return;
        if (pendingFailure !== undefined) {
          rejectOnce(pendingFailureError(pendingFailure));
          return;
        }
        if (exitCode === 4) {
          rejectOnce(authError(
            'AUTH_REQUIRED',
            'GitHub CLI authentication is required',
          ));
          return;
        }
        if (exitCode !== 0) {
          rejectOnce(authError(
            'PROCESS_FAILED',
            'GitHub credential bootstrap failed',
          ));
          return;
        }
        let stdout: Buffer | undefined;
        let token: Buffer | undefined;
        try {
          stdout = Buffer.concat(stdoutChunks, stdoutBytes);
          token = parseToken(stdout);
          const credential = createCredential(token);
          token = undefined;
          settled = true;
          cleanup();
          wipeBuffers(stdoutChunks);
          wipeBuffers(stderrChunks);
          stdout.fill(0);
          resolve(credential);
        } catch {
          if (token !== undefined) token.fill(0);
          if (stdout !== undefined) stdout.fill(0);
          rejectOnce(authError(
            'INVALID_TOKEN',
            'GitHub CLI returned an invalid credential',
          ));
        }
      });

      if (options.signal !== undefined) {
        addAbortListener(options.signal, abortHandler);
        if (isSignalAborted(options.signal)) abortHandler();
      }
      timers.timeout = setTimeout(() => {
        terminate('TIMEOUT');
      }, effectiveTimeoutMs);
      timers.timeout.unref?.();
    },
  );
}
