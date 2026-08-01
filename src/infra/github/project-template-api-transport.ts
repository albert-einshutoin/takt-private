import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import {
  createProjectTemplateGithubApiRequest,
  type DisposableProjectTemplateGhCredential,
  type ProjectTemplateGithubApiRequest,
  type ProjectTemplateGithubApiRequestHandlers,
} from './project-template-gh-auth.js';

const MAX_METADATA_BYTES = 1024 * 1024;
const ATTEMPT_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = Object.freeze([250, 1_000] as const);
const RETRYABLE_STATUS_CODES = new Set([
  408,
  429,
  500,
  502,
  503,
  504,
]);

export type ProjectTemplateGithubApiTransportErrorCode =
  | 'INVALID_ARGUMENT'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'REDIRECT'
  | 'RESPONSE_TOO_LARGE'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR';

export class ProjectTemplateGithubApiTransportError extends Error {
  constructor(
    public readonly code: ProjectTemplateGithubApiTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectTemplateGithubApiTransportError';
  }
}

export interface RequestProjectTemplateGithubApiMetadataOptions {
  readonly credential: DisposableProjectTemplateGhCredential;
  readonly path: string;
  readonly accept:
    | 'application/vnd.github+json'
    | 'application/vnd.github.raw+json';
  readonly maxBytes: number;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

export interface ProjectTemplateGithubApiTransportDependencies {
  readonly now: () => number;
}

interface SnapshottedDependencies {
  readonly receiver: ProjectTemplateGithubApiTransportDependencies;
  readonly now: ProjectTemplateGithubApiTransportDependencies['now'];
}

interface ClockState {
  last: number;
}

interface AttemptSuccess {
  readonly ok: true;
  readonly body: Buffer;
}

interface AttemptFailure {
  readonly ok: false;
  readonly error: ProjectTemplateGithubApiTransportError;
  readonly retryable: boolean;
}

type AttemptResult = AttemptSuccess | AttemptFailure;

const DEFAULT_DEPENDENCIES: ProjectTemplateGithubApiTransportDependencies =
  Object.freeze({
    now: () => performance.now(),
  });

function transportError(
  code: ProjectTemplateGithubApiTransportErrorCode,
  message: string,
): ProjectTemplateGithubApiTransportError {
  return Object.freeze(
    new ProjectTemplateGithubApiTransportError(code, message),
  );
}

function invalidArgument(): ProjectTemplateGithubApiTransportError {
  return transportError(
    'INVALID_ARGUMENT',
    'GitHub metadata request input is invalid',
  );
}

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
    throw invalidArgument();
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some(
      (key) => typeof key !== 'string' || !keys.includes(key),
    )
  ) {
    throw invalidArgument();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw invalidArgument();
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== AbortSignal.prototype
  ) {
    throw invalidArgument();
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      'aborted',
    );
    if (typeof descriptor?.get?.call(value) !== 'boolean') {
      throw new Error();
    }
  } catch {
    throw invalidArgument();
  }
  return value as AbortSignal;
}

function snapshotOptions(
  value: RequestProjectTemplateGithubApiMetadataOptions,
): Readonly<RequestProjectTemplateGithubApiMetadataOptions> {
  const candidateKeys = (
    typeof value === 'object'
    && value !== null
    && !types.isProxy(value)
  )
    ? Reflect.ownKeys(value)
    : [];
  const keys = candidateKeys.includes('signal')
    ? ['credential', 'path', 'accept', 'maxBytes', 'deadlineMs', 'signal']
    : ['credential', 'path', 'accept', 'maxBytes', 'deadlineMs'];
  const candidate = exactDataRecord(value, keys);
  const credential = candidate['credential'];
  const path = candidate['path'];
  const accept = candidate['accept'];
  const maxBytes = candidate['maxBytes'];
  const deadlineMs = candidate['deadlineMs'];
  if (
    typeof credential !== 'object'
    || credential === null
    || types.isProxy(credential)
    || typeof path !== 'string'
    || (
      accept !== 'application/vnd.github+json'
      && accept !== 'application/vnd.github.raw+json'
    )
    || typeof maxBytes !== 'number'
    || !Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
    || maxBytes > MAX_METADATA_BYTES
    || typeof deadlineMs !== 'number'
    || !Number.isFinite(deadlineMs)
    || deadlineMs < 0
  ) {
    throw invalidArgument();
  }
  const signal = snapshotSignal(candidate['signal']);
  return Object.freeze({
    credential: credential as DisposableProjectTemplateGhCredential,
    path,
    accept,
    maxBytes,
    deadlineMs,
    ...(signal === undefined ? {} : { signal }),
  });
}

function snapshotDependencies(
  value: ProjectTemplateGithubApiTransportDependencies | undefined,
): SnapshottedDependencies {
  const receiver = value ?? DEFAULT_DEPENDENCIES;
  const candidate = exactDataRecord(receiver, ['now']);
  if (
    typeof candidate['now'] !== 'function'
    || types.isProxy(candidate['now'])
  ) {
    throw invalidArgument();
  }
  return Object.freeze({
    receiver,
    now: candidate['now'] as
      ProjectTemplateGithubApiTransportDependencies['now'],
  });
}

function readNow(dependencies: SnapshottedDependencies): number {
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
    throw transportError(
      'NETWORK_ERROR',
      'GitHub metadata request failed',
    );
  }
  return value;
}

function readForwardNow(
  dependencies: SnapshottedDependencies,
  state: ClockState,
): number {
  const value = readNow(dependencies);
  if (value < state.last) {
    throw transportError(
      'NETWORK_ERROR',
      'GitHub metadata request failed',
    );
  }
  state.last = value;
  return value;
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

function wipeBuffers(buffers: readonly Buffer[]): void {
  for (const buffer of buffers) buffer.fill(0);
}

function mapStatus(statusCode: number): AttemptFailure | undefined {
  if (statusCode >= 200 && statusCode <= 299) return undefined;
  if (statusCode >= 300 && statusCode <= 399) {
    return {
      ok: false,
      retryable: false,
      error: transportError(
        'REDIRECT',
        'GitHub metadata redirects are not permitted',
      ),
    };
  }
  if (statusCode === 401) {
    return {
      ok: false,
      retryable: false,
      error: transportError(
        'AUTH_REQUIRED',
        'GitHub authentication is required',
      ),
    };
  }
  if (statusCode === 403) {
    return {
      ok: false,
      retryable: false,
      error: transportError(
        'FORBIDDEN',
        'GitHub metadata access is forbidden',
      ),
    };
  }
  if (statusCode === 404) {
    return {
      ok: false,
      retryable: false,
      error: transportError(
        'NOT_FOUND',
        'GitHub metadata was not found',
      ),
    };
  }
  return {
    ok: false,
    retryable: RETRYABLE_STATUS_CODES.has(statusCode),
    error: transportError(
      'HTTP_ERROR',
      'GitHub metadata request returned an error',
    ),
  };
}

function safeErrorCode(error: unknown): unknown {
  if (
    typeof error !== 'object'
    || error === null
    || types.isProxy(error)
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor !== undefined && 'value' in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function requestAttempt(
  options: Readonly<RequestProjectTemplateGithubApiMetadataOptions>,
  timeoutMs: number,
  attemptStart: number,
  expiresAt: number,
  dependencies: SnapshottedDependencies,
  clockState: ClockState,
): Promise<AttemptResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let settled = false;
    let responseAccepted = false;
    let request: ProjectTemplateGithubApiRequest | undefined;
    const timeoutHolder: {
      value?: ReturnType<typeof setTimeout>;
    } = {};

    const wipeRetained = (): void => {
      wipeBuffers(chunks);
      chunks.length = 0;
      retainedBytes = 0;
    };
    const cleanup = (): void => {
      if (timeoutHolder.value !== undefined) {
        clearTimeout(timeoutHolder.value);
      }
      if (options.signal !== undefined) {
        try {
          removeAbortListener(options.signal, abortHandler);
        } catch {
          // The terminal result remains authoritative.
        }
      }
      try {
        request?.dispose();
      } catch {
        // The finite transport result remains authoritative.
      }
    };
    const finishFailure = (
      error: ProjectTemplateGithubApiTransportError,
      retryable: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      try {
        request?.destroy();
      } catch {
        // Hostile request cleanup cannot replace the finite transport error.
      }
      cleanup();
      wipeRetained();
      resolve({ ok: false, error, retryable });
    };
    const finishSuccess = (): void => {
      if (settled || !responseAccepted) return;
      let body: Buffer;
      try {
        body = Buffer.concat(chunks, retainedBytes);
      } catch {
        finishFailure(transportError(
          'INVALID_RESPONSE',
          'GitHub metadata response is invalid',
        ), false);
        return;
      }
      settled = true;
      cleanup();
      wipeRetained();
      resolve({ ok: true, body });
    };
    const abortHandler = (): void => {
      finishFailure(transportError(
        'ABORTED',
        'GitHub metadata request was cancelled',
      ), false);
    };
    const networkFailure = (): void => {
      finishFailure(transportError(
        'NETWORK_ERROR',
        'GitHub metadata request failed',
      ), true);
    };
    const handlers: ProjectTemplateGithubApiRequestHandlers = Object.freeze({
      onResponse(statusCode: number | undefined): void {
        if (settled) return;
        if (
          typeof statusCode !== 'number'
          || !Number.isSafeInteger(statusCode)
          || statusCode < 100
          || statusCode > 599
        ) {
          finishFailure(transportError(
            'INVALID_RESPONSE',
            'GitHub metadata response is invalid',
          ), false);
          return;
        }
        const statusFailure = mapStatus(statusCode);
        if (statusFailure !== undefined) {
          finishFailure(statusFailure.error, statusFailure.retryable);
          return;
        }
        responseAccepted = true;
      },
      onData(chunk: unknown): void {
        if (settled || !responseAccepted) return;
        if (types.isProxy(chunk)) {
          finishFailure(transportError(
            'INVALID_RESPONSE',
            'GitHub metadata response is invalid',
          ), false);
          return;
        }
        let byteLength: number;
        try {
          if (typeof chunk === 'string') {
            byteLength = Buffer.byteLength(chunk, 'utf8');
          } else if (Buffer.isBuffer(chunk)) {
            byteLength = chunk.length;
          } else {
            finishFailure(transportError(
              'INVALID_RESPONSE',
              'GitHub metadata response is invalid',
            ), false);
            return;
          }
        } catch {
          finishFailure(transportError(
            'INVALID_RESPONSE',
            'GitHub metadata response is invalid',
          ), false);
          return;
        }
        if (retainedBytes + byteLength > options.maxBytes) {
          finishFailure(transportError(
            'RESPONSE_TOO_LARGE',
            'GitHub metadata response exceeds the allowed size',
          ), false);
          return;
        }
        try {
          chunks.push(Buffer.from(chunk));
          retainedBytes += byteLength;
        } catch {
          finishFailure(transportError(
            'INVALID_RESPONSE',
            'GitHub metadata response is invalid',
          ), false);
        }
      },
      onEnd: finishSuccess,
      onResponseAborted: networkFailure,
      onResponseError: networkFailure,
      onResponseClose(): void {
        if (!settled) networkFailure();
      },
      onRequestError: networkFailure,
      onRequestClose(): void {
        // A request may close after its response has started streaming.
      },
    });

    if (options.signal !== undefined) {
      addAbortListener(options.signal, abortHandler);
      if (isSignalAborted(options.signal)) {
        abortHandler();
        return;
      }
    }
    timeoutHolder.value = setTimeout(() => {
      finishFailure(transportError(
        'TIMEOUT',
        'GitHub metadata request timed out',
      ), false);
    }, timeoutMs);
    timeoutHolder.value.unref?.();
    try {
      request = createProjectTemplateGithubApiRequest(
        options.credential,
        Object.freeze({
          path: options.path,
          accept: options.accept,
          handlers,
        }),
      );
      if (settled) {
        try {
          request.destroy();
        } catch {
          // The callback-selected result remains authoritative.
        }
        try {
          request.dispose();
        } catch {
          // The callback-selected result remains authoritative.
        }
        return;
      }
      const afterCreation = readForwardNow(dependencies, clockState);
      if (settled) return;
      if (
        afterCreation < attemptStart
        || afterCreation >= expiresAt
      ) {
        finishFailure(transportError(
          afterCreation >= expiresAt ? 'TIMEOUT' : 'NETWORK_ERROR',
          afterCreation >= expiresAt
            ? 'GitHub metadata request timed out'
            : 'GitHub metadata request failed',
        ), false);
        return;
      }
      request.start();
      if (settled) return;
      const afterStart = readForwardNow(dependencies, clockState);
      if (afterStart < afterCreation || afterStart >= expiresAt) {
        finishFailure(transportError(
          afterStart >= expiresAt ? 'TIMEOUT' : 'NETWORK_ERROR',
          afterStart >= expiresAt
            ? 'GitHub metadata request timed out'
            : 'GitHub metadata request failed',
        ), false);
      }
    } catch (error) {
      const code = safeErrorCode(error);
      if (code === 'INVALID_ARGUMENT') {
        finishFailure(invalidArgument(), false);
        return;
      }
      if (code === 'CREDENTIAL_DISPOSED') {
        finishFailure(transportError(
          'AUTH_REQUIRED',
          'GitHub authentication is required',
        ), false);
        return;
      }
      finishFailure(transportError(
        'NETWORK_ERROR',
        'GitHub metadata request failed',
      ), true);
    }
  });
}

function waitForRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<'ready' | 'aborted'> {
  return new Promise((resolve) => {
    let settled = false;
    const timerHolder: {
      value?: ReturnType<typeof setTimeout>;
    } = {};
    const cleanup = (): void => {
      if (timerHolder.value !== undefined) {
        clearTimeout(timerHolder.value);
      }
      if (signal !== undefined) {
        try {
          removeAbortListener(signal, abortHandler);
        } catch {
          // The fixed retry result remains authoritative.
        }
      }
    };
    const finish = (result: 'ready' | 'aborted'): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const abortHandler = (): void => finish('aborted');
    if (signal !== undefined) {
      addAbortListener(signal, abortHandler);
      if (isSignalAborted(signal)) {
        finish('aborted');
        return;
      }
    }
    timerHolder.value = setTimeout(() => finish('ready'), delayMs);
    timerHolder.value.unref?.();
  });
}

export async function requestProjectTemplateGithubApiMetadata(
  optionsValue: RequestProjectTemplateGithubApiMetadataOptions,
  dependenciesValue?: ProjectTemplateGithubApiTransportDependencies,
): Promise<Buffer> {
  let options: Readonly<RequestProjectTemplateGithubApiMetadataOptions>;
  let dependencies: SnapshottedDependencies;
  try {
    options = snapshotOptions(optionsValue);
    dependencies = snapshotDependencies(dependenciesValue);
  } catch {
    throw invalidArgument();
  }
  if (
    options.signal !== undefined
    && isSignalAborted(options.signal)
  ) {
    throw transportError(
      'ABORTED',
      'GitHub metadata request was cancelled',
    );
  }
  const clockState: ClockState = { last: 0 };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let now: number;
    try {
      now = readForwardNow(dependencies, clockState);
    } catch {
      throw transportError(
        'NETWORK_ERROR',
        'GitHub metadata request failed',
      );
    }
    const remainingMs = options.deadlineMs - now;
    if (remainingMs <= 0) {
      throw transportError(
        'TIMEOUT',
        'GitHub metadata request timed out',
      );
    }
    const expiresAt = Math.min(
      options.deadlineMs,
      now + ATTEMPT_TIMEOUT_MS,
    );
    const result = await requestAttempt(
      options,
      expiresAt - now,
      now,
      expiresAt,
      dependencies,
      clockState,
    );
    if (result.ok) return result.body;
    if (!result.retryable || attempt === 2) throw result.error;
    const delayMs = RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) throw result.error;
    let afterAttempt: number;
    try {
      afterAttempt = readForwardNow(dependencies, clockState);
    } catch {
      throw transportError(
        'NETWORK_ERROR',
        'GitHub metadata request failed',
      );
    }
    if (options.deadlineMs - afterAttempt <= delayMs) {
      throw transportError(
        'TIMEOUT',
        'GitHub metadata request timed out',
      );
    }
    const retry = await waitForRetry(delayMs, options.signal);
    if (retry === 'aborted') {
      throw transportError(
        'ABORTED',
        'GitHub metadata request was cancelled',
      );
    }
  }
  throw transportError(
    'NETWORK_ERROR',
    'GitHub metadata request failed',
  );
}
