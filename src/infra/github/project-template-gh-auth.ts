import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import {
  request as httpsRequest,
} from 'node:https';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { types } from 'node:util';
import { crossSpawn } from '../../shared/utils/spawn.js';

const AUTH_ATTEMPT_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 1_000;
const FINAL_REAP_GRACE_MS = 1_000;
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
  | 'CREDENTIAL_DISPOSED';

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
  readonly now: () => number;
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
  dispose(): void;
}

export interface ProjectTemplateGithubApiRequestHandlers {
  readonly onResponse: (statusCode: number | undefined) => void;
  readonly onData: (chunk: unknown) => void;
  readonly onEnd: () => void;
  readonly onResponseAborted: () => void;
  readonly onResponseError: () => void;
  readonly onResponseClose: () => void;
  readonly onRequestError: () => void;
  readonly onRequestClose: () => void;
}

export interface ProjectTemplateGithubApiRequestPlan {
  readonly path: string;
  readonly accept:
    | 'application/vnd.github+json'
    | 'application/vnd.github.raw+json';
  readonly handlers: ProjectTemplateGithubApiRequestHandlers;
}

export interface ProjectTemplateGithubApiRequest {
  start(): void;
  destroy(): void;
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
interface ApiRequestAuthority {
  readonly request: ClientRequest;
  response?: IncomingMessage;
  disposed: boolean;
  readonly requestListeners: ReadonlyArray<
  readonly [event: string, listener: (...args: unknown[]) => void]
  >;
  responseListeners: ReadonlyArray<
  readonly [event: string, listener: (...args: unknown[]) => void]
  >;
}

const API_REQUEST_AUTHORITIES = new WeakMap<object, ApiRequestAuthority>();

function authError(
  code: ProjectTemplateGhAuthErrorCode,
  message: string,
): ProjectTemplateGhAuthError {
  return Object.freeze(new ProjectTemplateGhAuthError(code, message));
}

function createCredential(
  token: Buffer,
): DisposableProjectTemplateGhCredential {
  // The frozen facade carries no token state. WeakMap authority makes copied
  // methods and forged receivers fail closed while still permitting zero-fill.
  const credential: DisposableProjectTemplateGhCredential = {
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

function isSafeGithubApiPath(path: string): boolean {
  const hasUnsafeRawCharacter = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 0x20 || code >= 0x7f || code === 0x5c) return true;
    }
    return false;
  };
  const hasUnsafeDecodedCharacter = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
    }
    return value.includes('/');
  };
  if (
    path.length === 0
    || path.length > 8_192
    || !path.startsWith('/')
    || path.startsWith('//')
    || path.includes('#')
    || /%(?![0-9A-F]{2})/.test(path)
    || hasUnsafeRawCharacter(path)
  ) {
    return false;
  }
  const [pathname, query, ...rest] = path.split('?');
  if (rest.length > 0 || pathname === undefined) return false;
  const encoded = /^(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+$/;
  const segments = pathname.slice(1).split('/');
  if (
    segments.some((segment) => {
      if (!encoded.test(segment)) return true;
      try {
        const decoded = decodeURIComponent(segment);
        return (
          decoded === '.'
          || decoded === '..'
          || hasUnsafeDecodedCharacter(decoded)
        );
      } catch {
        return true;
      }
    })
  ) {
    return false;
  }
  if (query === undefined) return true;
  if (query.length === 0) return false;
  return query.split('&').every((pair) => {
    const parts = pair.split('=');
    if (
      parts.length !== 2
      || parts[0] === undefined
      || parts[1] === undefined
      || !encoded.test(parts[0])
      || !encoded.test(parts[1])
    ) {
      return false;
    }
    try {
      decodeURIComponent(parts[0]);
      decodeURIComponent(parts[1]);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Internal sealed boundary for fixed GitHub API requests.
 *
 * The facade deliberately exposes neither ClientRequest nor IncomingMessage:
 * both can lead back to the Authorization header. Keep this out of barrels.
 */
export function createProjectTemplateGithubApiRequest(
  credential: DisposableProjectTemplateGhCredential,
  planValue: ProjectTemplateGithubApiRequestPlan,
): ProjectTemplateGithubApiRequest {
  const credentialAuthority = (
    typeof credential === 'object'
    && credential !== null
    && !types.isProxy(credential)
  )
    ? CREDENTIAL_AUTHORITIES.get(credential)
    : undefined;
  if (
    credentialAuthority === undefined
    || credentialAuthority.state !== 'active'
  ) {
    throw authError(
      'CREDENTIAL_DISPOSED',
      'GitHub credential is no longer available',
    );
  }
  const plan = exactDataRecord(planValue, ['path', 'accept', 'handlers']);
  const path = plan['path'];
  const accept = plan['accept'];
  const handlersRecord = exactDataRecord(
    plan['handlers'],
    [
      'onResponse',
      'onData',
      'onEnd',
      'onResponseAborted',
      'onResponseError',
      'onResponseClose',
      'onRequestError',
      'onRequestClose',
    ],
  );
  const handlerNames = Object.keys(handlersRecord);
  if (
    typeof path !== 'string'
    || !isSafeGithubApiPath(path)
    || (
      accept !== 'application/vnd.github+json'
      && accept !== 'application/vnd.github.raw+json'
    )
    || handlerNames.some(
      (name) => (
        typeof handlersRecord[name] !== 'function'
        || types.isProxy(handlersRecord[name])
      ),
    )
  ) {
    throw authError(
      'INVALID_ARGUMENT',
      'GitHub API request plan is invalid',
    );
  }
  const handlers = handlersRecord as unknown as
    ProjectTemplateGithubApiRequestHandlers;
  const authorityHolder: { current?: ApiRequestAuthority } = {};
  const responseCallback = (response: IncomingMessage): void => {
    const current = authorityHolder.current;
    if (
      current === undefined
      || current.disposed
      || !isReadableStream(response)
    ) {
      handlers.onResponseError();
      return;
    }
    current.response = response;
    const listeners: ApiRequestAuthority['responseListeners'] = [
      ['data', (chunk: unknown) => handlers.onData(chunk)],
      ['end', () => handlers.onEnd()],
      ['aborted', () => handlers.onResponseAborted()],
      ['error', () => handlers.onResponseError()],
      ['close', () => handlers.onResponseClose()],
    ];
    current.responseListeners = listeners;
    const statusCode = ownDataValue(response, 'statusCode');
    handlers.onResponse(
      typeof statusCode === 'number' ? statusCode : undefined,
    );
    for (const [event, listener] of listeners) {
      EventEmitter.prototype.on.call(response, event, listener);
    }
  };
  const request = httpsRequest({
    protocol: 'https:',
    hostname: 'api.github.com',
    port: 443,
    method: 'GET',
    path,
    headers: {
      Accept: accept as string,
      Authorization: `Bearer ${credentialAuthority.token.toString('utf8')}`,
      'User-Agent': 'takt-project-template',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, responseCallback);
  const requestListeners: ApiRequestAuthority['requestListeners'] = [
    ['error', () => handlers.onRequestError()],
    ['close', () => handlers.onRequestClose()],
  ];
  const authority: ApiRequestAuthority = {
    request,
    disposed: false,
    requestListeners,
    responseListeners: [],
  };
  authorityHolder.current = authority;
  for (const [event, listener] of requestListeners) {
    EventEmitter.prototype.on.call(request, event, listener);
  }
  const facade: ProjectTemplateGithubApiRequest = {
    start(): void {
      const current = API_REQUEST_AUTHORITIES.get(this);
      if (current === undefined || current.disposed) {
        throw authError(
          'PROCESS_FAILED',
          'GitHub API request is no longer available',
        );
      }
      current.request.end();
    },
    destroy(): void {
      const current = API_REQUEST_AUTHORITIES.get(this);
      if (current === undefined || current.disposed) return;
      current.response?.destroy();
      current.request.destroy();
    },
    dispose(): void {
      const current = API_REQUEST_AUTHORITIES.get(this);
      if (current === undefined || current.disposed) return;
      current.disposed = true;
      for (const [event, listener] of current.requestListeners) {
        EventEmitter.prototype.removeListener.call(
          current.request,
          event,
          listener,
        );
      }
      if (current.response !== undefined) {
        for (const [event, listener] of current.responseListeners) {
          EventEmitter.prototype.removeListener.call(
            current.response,
            event,
            listener,
          );
        }
      }
      current.responseListeners = [];
    },
  };
  API_REQUEST_AUTHORITIES.set(facade, authority);
  return Object.freeze(facade);
}

const DEFAULT_DEPENDENCIES: ProjectTemplateGhAuthDependencies =
  Object.freeze({
    spawn: crossSpawn,
    now: () => performance.now(),
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
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      'aborted',
    );
    const aborted = descriptor?.get?.call(value) as unknown;
    if (typeof aborted !== 'boolean') {
      throw new Error();
    }
  } catch {
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
): {
  readonly receiver: ProjectTemplateGhAuthDependencies;
  readonly spawn: ProjectTemplateGhAuthDependencies['spawn'];
  readonly now: ProjectTemplateGhAuthDependencies['now'];
} {
  const receiver = value ?? DEFAULT_DEPENDENCIES;
  const dependencies = exactDataRecord(receiver, ['spawn', 'now']);
  if (
    typeof dependencies['spawn'] !== 'function'
    || types.isProxy(dependencies['spawn'])
    || typeof dependencies['now'] !== 'function'
    || types.isProxy(dependencies['now'])
  ) {
    throw authError(
      'INVALID_ARGUMENT',
      'GitHub credential bootstrap dependency is invalid',
    );
  }
  return Object.freeze({
    receiver,
    spawn: dependencies['spawn'] as
      ProjectTemplateGhAuthDependencies['spawn'],
    now: dependencies['now'] as
      ProjectTemplateGhAuthDependencies['now'],
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
  let code: unknown;
  if (
    typeof error === 'object'
    && error !== null
    && !types.isProxy(error)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor !== undefined && 'value' in descriptor) {
      code = descriptor.value;
    }
  }
  if (code === 'ENOENT') {
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

interface SnapshottedAuthDependencies {
  readonly receiver: ProjectTemplateGhAuthDependencies;
  readonly spawn: ProjectTemplateGhAuthDependencies['spawn'];
  readonly now: ProjectTemplateGhAuthDependencies['now'];
}

function readMonotonicNow(
  dependencies: SnapshottedAuthDependencies,
): number {
  const value = Reflect.apply(
    dependencies.now,
    dependencies.receiver,
    [],
  ) as unknown;
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
  ) {
    throw authError(
      'PROCESS_FAILED',
      'GitHub credential bootstrap failed',
    );
  }
  return value;
}

function findDataFunction(
  value: object,
  key: string,
): ((...args: unknown[]) => unknown) | undefined {
  let current: object | null = value;
  while (current !== null) {
    if (types.isProxy(current)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      return 'value' in descriptor
        && typeof descriptor.value === 'function'
        && !types.isProxy(descriptor.value)
        ? descriptor.value as (...args: unknown[]) => unknown
        : undefined;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function ownDataValue(value: object, key: string): unknown {
  if (types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;
}

function isReadableStream(value: unknown): value is Readable {
  if (
    typeof value !== 'object'
    || value === null
  ) {
    return false;
  }
  let current: object | null = value;
  try {
    while (current !== null) {
      // Check every link before prototype access: instanceof would execute a
      // Proxy trap hidden anywhere in the chain.
      if (types.isProxy(current)) return false;
      if (current === Readable.prototype) return true;
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return false;
  }
  return false;
}

export async function acquireProjectTemplateGhCredential(
  optionsValue: AcquireProjectTemplateGhCredentialOptions,
  dependenciesValue?: ProjectTemplateGhAuthDependencies,
): Promise<DisposableProjectTemplateGhCredential> {
  let options: ReturnType<typeof snapshotOptions>;
  let dependencies: SnapshottedAuthDependencies;
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

  let attemptStart: number;
  try {
    attemptStart = readMonotonicNow(dependencies);
  } catch {
    throw authError(
      'PROCESS_FAILED',
      'GitHub credential bootstrap failed',
    );
  }
  if (options.deadlineMs - attemptStart <= 0) {
    throw authError(
      'TIMEOUT',
      'GitHub credential bootstrap timed out',
    );
  }

  return new Promise<DisposableProjectTemplateGhCredential>(
    (resolve, reject) => {
      let child: ChildProcess;
      try {
        child = Reflect.apply(
          dependencies.spawn,
          dependencies.receiver,
          ['gh', GH_AUTH_ARGS, {
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: buildGhEnvironment(),
          }],
        ) as ChildProcess;
      } catch (error) {
        reject(mapProcessError(error));
        return;
      }
      if (
        typeof child !== 'object'
        || child === null
        || types.isProxy(child)
      ) {
        reject(authError(
          'PROCESS_FAILED',
          'GitHub credential bootstrap failed',
        ));
        return;
      }

      const kill = findDataFunction(child, 'kill');
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let pendingError: ProjectTemplateGhAuthError | undefined;
      const streams: {
        stdout?: Readable;
        stderr?: Readable;
      } = {};
      let stdoutListening = false;
      let stderrListening = false;
      let childErrorListening = false;
      let childCloseListening = false;
      const timers: {
        timeout?: ReturnType<typeof setTimeout>;
        forceKill?: ReturnType<typeof setTimeout>;
        reap?: ReturnType<typeof setTimeout>;
      } = {};

      const safeKill = (signal: NodeJS.Signals): void => {
        if (kill === undefined) return;
        try {
          Reflect.apply(kill, child, [signal]);
        } catch {
          // Reap timers remain authoritative even if the platform kill fails.
        }
      };

      const stdoutDataHandler = (chunk: unknown): void => {
        append('stdout', chunk);
      };
      const stderrDataHandler = (chunk: unknown): void => {
        append('stderr', chunk);
      };
      const childErrorHandler = (error: unknown): void => {
        terminate(mapProcessError(error));
      };
      const childCloseHandler = (exitCode: number | null): void => {
        if (settled) return;
        if (pendingError !== undefined) {
          rejectOnce(pendingError);
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
        resolveCredential();
      };
      const abortHandler = (): void => {
        terminate(authError(
          'ABORTED',
          'GitHub credential bootstrap was cancelled',
        ));
      };

      const cleanup = (): void => {
        if (timers.timeout !== undefined) clearTimeout(timers.timeout);
        if (timers.forceKill !== undefined) clearTimeout(timers.forceKill);
        if (timers.reap !== undefined) clearTimeout(timers.reap);
        if (options.signal !== undefined) {
          try {
            removeAbortListener(options.signal, abortHandler);
          } catch {
            // Cleanup remains best-effort after the validated signal changed.
          }
        }
        if (stdoutListening && streams.stdout !== undefined) {
          try {
            EventEmitter.prototype.removeListener.call(
              streams.stdout,
              'data',
              stdoutDataHandler,
            );
          } catch {
            // Never let a malformed injected stream suppress terminal cleanup.
          }
          stdoutListening = false;
        }
        if (stderrListening && streams.stderr !== undefined) {
          try {
            EventEmitter.prototype.removeListener.call(
              streams.stderr,
              'data',
              stderrDataHandler,
            );
          } catch {
            // Never let a malformed injected stream suppress terminal cleanup.
          }
          stderrListening = false;
        }
        if (childErrorListening) {
          try {
            EventEmitter.prototype.removeListener.call(
              child,
              'error',
              childErrorHandler,
            );
          } catch {
            // The bounded reap result is still authoritative.
          }
          childErrorListening = false;
        }
        if (childCloseListening) {
          try {
            EventEmitter.prototype.removeListener.call(
              child,
              'close',
              childCloseHandler,
            );
          } catch {
            // The bounded reap result is still authoritative.
          }
          childCloseListening = false;
        }
      };

      const wipeRetainedOutput = (): void => {
        wipeBuffers(stdoutChunks);
        wipeBuffers(stderrChunks);
        stdoutChunks.length = 0;
        stderrChunks.length = 0;
        stdoutBytes = 0;
        stderrBytes = 0;
      };

      const rejectOnce = (error: ProjectTemplateGhAuthError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        wipeRetainedOutput();
        reject(error);
      };

      const terminate = (error: ProjectTemplateGhAuthError): void => {
        if (settled || pendingError !== undefined) return;
        pendingError = error;
        // Output may contain a credential or CLI diagnostics. Once failure is
        // authoritative, retain neither while waiting for the child to reap.
        wipeRetainedOutput();
        safeKill('SIGTERM');
        if (settled) return;
        // Rejection is deliberately deferred to "close": callers must never
        // continue while a credential-producing child may still be alive.
        timers.forceKill = setTimeout(() => {
          if (settled) return;
          safeKill('SIGKILL');
          if (settled) return;
          timers.reap = setTimeout(() => {
            rejectOnce(authError(
              'PROCESS_FAILED',
              'GitHub credential process could not be reaped',
            ));
          }, FINAL_REAP_GRACE_MS);
          timers.reap.unref?.();
        }, FORCE_KILL_DELAY_MS);
        timers.forceKill.unref?.();
      };

      const append = (
        target: 'stdout' | 'stderr',
        chunk: unknown,
      ): void => {
        if (settled || pendingError !== undefined) return;
        if (types.isProxy(chunk)) {
          terminate(authError(
            'PROCESS_FAILED',
            'GitHub credential bootstrap failed',
          ));
          return;
        }
        let byteLength: number;
        try {
          if (typeof chunk === 'string') {
            byteLength = Buffer.byteLength(chunk, 'utf8');
          } else if (Buffer.isBuffer(chunk)) {
            byteLength = chunk.length;
          } else {
            terminate(authError(
              'PROCESS_FAILED',
              'GitHub credential bootstrap failed',
            ));
            return;
          }
        } catch {
          terminate(authError(
            'PROCESS_FAILED',
            'GitHub credential bootstrap failed',
          ));
          return;
        }
        const limit = target === 'stdout'
          ? MAX_STDOUT_BYTES
          : MAX_STDERR_BYTES;
        const retainedBytes = target === 'stdout'
          ? stdoutBytes
          : stderrBytes;
        // Check before copying so even one hostile chunk cannot create an
        // oversized credential copy before the failure path can wipe it.
        if (retainedBytes + byteLength > limit) {
          terminate(pendingFailureError('OUTPUT_LIMIT'));
          return;
        }
        let copy: Buffer;
        try {
          copy = Buffer.from(chunk);
        } catch {
          terminate(authError(
            'PROCESS_FAILED',
            'GitHub credential bootstrap failed',
          ));
          return;
        }
        if (target === 'stdout') {
          stdoutChunks.push(copy);
          stdoutBytes += byteLength;
          return;
        }
        stderrChunks.push(copy);
        stderrBytes += byteLength;
      };

      const resolveCredential = (): void => {
        let combined: Buffer | undefined;
        let token: Buffer | undefined;
        try {
          combined = Buffer.concat(stdoutChunks, stdoutBytes);
          token = parseToken(combined);
          const credential = createCredential(token);
          token = undefined;
          settled = true;
          cleanup();
          wipeRetainedOutput();
          combined.fill(0);
          resolve(credential);
        } catch {
          if (token !== undefined) token.fill(0);
          if (combined !== undefined) combined.fill(0);
          rejectOnce(authError(
            'INVALID_TOKEN',
            'GitHub CLI returned an invalid credential',
          ));
        }
      };

      try {
        EventEmitter.prototype.on.call(
          child,
          'close',
          childCloseHandler,
        );
        childCloseListening = true;
        if (settled || pendingError !== undefined) {
          cleanup();
          return;
        }
        EventEmitter.prototype.on.call(
          child,
          'error',
          childErrorHandler,
        );
        childErrorListening = true;
        if (settled || pendingError !== undefined) {
          cleanup();
          return;
        }
      } catch {
        terminate(authError(
          'PROCESS_FAILED',
          'GitHub credential bootstrap failed',
        ));
        return;
      }

      let afterSpawn: number;
      try {
        afterSpawn = readMonotonicNow(dependencies);
      } catch {
        terminate(authError(
          'PROCESS_FAILED',
          'GitHub credential bootstrap failed',
        ));
        return;
      }
      if (settled || pendingError !== undefined) {
        cleanup();
        return;
      }
      if (afterSpawn < attemptStart) {
        terminate(authError(
          'PROCESS_FAILED',
          'GitHub credential bootstrap failed',
        ));
        return;
      }
      const effectiveTimeoutMs = Math.min(
        options.deadlineMs - afterSpawn,
        AUTH_ATTEMPT_TIMEOUT_MS - (afterSpawn - attemptStart),
      );
      if (effectiveTimeoutMs <= 0) {
        terminate(pendingFailureError('TIMEOUT'));
        return;
      }

      if (options.signal !== undefined) {
        addAbortListener(options.signal, abortHandler);
        if (settled || pendingError !== undefined) {
          cleanup();
          return;
        }
        if (isSignalAborted(options.signal)) {
          abortHandler();
          return;
        }
        if (settled || pendingError !== undefined) {
          cleanup();
          return;
        }
      }

      const stdoutValue = ownDataValue(child, 'stdout');
      const stderrValue = ownDataValue(child, 'stderr');
      if (
        !isReadableStream(stdoutValue)
        || !isReadableStream(stderrValue)
      ) {
        terminate(authError(
          'PROCESS_FAILED',
          'GitHub credential bootstrap failed',
        ));
        return;
      }
      streams.stdout = stdoutValue;
      streams.stderr = stderrValue;
      try {
        Readable.prototype.on.call(
          streams.stdout,
          'data',
          stdoutDataHandler,
        );
        stdoutListening = true;
        if (settled || pendingError !== undefined) {
          cleanup();
          return;
        }
        Readable.prototype.on.call(
          streams.stderr,
          'data',
          stderrDataHandler,
        );
        stderrListening = true;
        if (settled || pendingError !== undefined) {
          cleanup();
          return;
        }
      } catch {
        terminate(authError(
          'PROCESS_FAILED',
          'GitHub credential bootstrap failed',
        ));
        return;
      }

      if (settled || pendingError !== undefined) {
        cleanup();
        return;
      }
      timers.timeout = setTimeout(() => {
        terminate(pendingFailureError('TIMEOUT'));
      }, effectiveTimeoutMs);
      if (settled || pendingError !== undefined) {
        cleanup();
        return;
      }
      timers.timeout.unref?.();
    },
  );
}
