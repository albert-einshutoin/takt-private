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
import {
  createProjectTemplateArtifactRedirectState,
  type DisposableProjectTemplateArtifactRedirectGrant,
  type DisposableProjectTemplateArtifactRedirectState,
} from './project-template-artifact-redirect.js';

const AUTH_ATTEMPT_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 1_000;
const FINAL_REAP_GRACE_MS = 1_000;
const MAX_STDOUT_BYTES = 4 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_ASSET_RAW_HEADER_ENTRIES = 256;
const MAX_ASSET_RAW_HEADER_CHARACTERS = 64 * 1024;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const GITHUB_OWNER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
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

export interface ProjectTemplateGithubReleaseAssetRequestHandlers {
  readonly onResponse: (statusCode: number) => void;
  readonly onRedirect: (
    grant: DisposableProjectTemplateArtifactRedirectGrant,
  ) => void;
  readonly onInvalidResponse: () => void;
  readonly onData: (chunk: unknown) => void;
  readonly onEnd: () => void;
  readonly onResponseAborted: () => void;
  readonly onResponseError: () => void;
  readonly onResponseClose: () => void;
  readonly onRequestError: () => void;
  readonly onRequestClose: () => void;
}

export interface ProjectTemplateGithubReleaseAssetRequestPlan {
  readonly owner: string;
  readonly repo: string;
  readonly assetId: number;
  readonly handlers: ProjectTemplateGithubReleaseAssetRequestHandlers;
}

export interface ProjectTemplateGithubReleaseAssetRequest {
  start(): void;
  pause(): void;
  resume(): void;
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
  request?: ClientRequest;
  response?: IncomingMessage;
  responseDestroy?: (...args: unknown[]) => unknown;
  disposed: boolean;
  end?: (...args: unknown[]) => unknown;
  destroy?: (...args: unknown[]) => unknown;
  requestListeners: ReadonlyArray<
  readonly [event: string, listener: (...args: unknown[]) => void]
  >;
  responseListeners: ReadonlyArray<
  readonly [event: string, listener: (...args: unknown[]) => void]
  >;
  readonly release: () => void;
}

const API_REQUEST_AUTHORITIES = new WeakMap<object, ApiRequestAuthority>();

interface AssetRequestAuthority {
  request?: ClientRequest;
  response?: IncomingMessage;
  end?: (...args: unknown[]) => unknown;
  requestDestroy?: (...args: unknown[]) => unknown;
  responsePause?: (...args: unknown[]) => unknown;
  responseResume?: (...args: unknown[]) => unknown;
  responseDestroy?: (...args: unknown[]) => unknown;
  disposed: boolean;
  terminal: boolean;
  responseSeen: boolean;
  constructionComplete: boolean;
  redirectTransferPending: boolean;
  requestListeners: ReadonlyArray<
    readonly [event: string, listener: (...args: unknown[]) => void]
  >;
  responseListeners: ReadonlyArray<
    readonly [event: string, listener: (...args: unknown[]) => void]
  >;
  ownedRedirectState?: DisposableProjectTemplateArtifactRedirectState;
  ownedRedirectGrant?: DisposableProjectTemplateArtifactRedirectGrant;
  release: () => void;
}

const ASSET_REQUEST_AUTHORITIES =
  new WeakMap<object, AssetRequestAuthority>();
const ASSET_REQUEST_FACADES = new WeakSet<object>();

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
  const handlersReceiver = plan['handlers'] as
    ProjectTemplateGithubApiRequestHandlers;
  const invokeHandler = (
    name: keyof ProjectTemplateGithubApiRequestHandlers,
    args: readonly unknown[] = [],
  ): void => {
    Reflect.apply(
      handlersRecord[name] as (...values: unknown[]) => unknown,
      handlersReceiver,
      args,
    );
  };
  const authorityHolder: { current?: ApiRequestAuthority } = {};
  const destroyPreAuthorityResponse = (
    response: IncomingMessage,
  ): void => {
    if (!isReadableStream(response)) return;
    const destroy = findDataFunction(response, 'destroy');
    if (destroy === undefined) return;
    try {
      Reflect.apply(destroy, response, []);
    } catch {
      // The finite request failure remains authoritative.
    }
  };
  const responseCallback = (response: IncomingMessage): void => {
    const current = authorityHolder.current;
    if (current === undefined) {
      destroyPreAuthorityResponse(response);
      invokeHandler('onResponseError');
      return;
    }
    if (
      current.disposed
      || !isReadableStream(response)
    ) {
      invokeHandler('onResponseError');
      return;
    }
    current.response = response;
    current.responseDestroy = findDataFunction(response, 'destroy');
    const listeners: ApiRequestAuthority['responseListeners'] = [
      ['data', (chunk: unknown) => invokeHandler('onData', [chunk])],
      ['end', () => invokeHandler('onEnd')],
      ['aborted', () => invokeHandler('onResponseAborted')],
      ['error', () => invokeHandler('onResponseError')],
      ['close', () => invokeHandler('onResponseClose')],
    ];
    current.responseListeners = listeners;
    const statusCode = ownDataValue(response, 'statusCode');
    try {
      invokeHandler('onResponse', [
        typeof statusCode === 'number' ? statusCode : undefined,
      ]);
      if (current.disposed) return;
      for (const [event, listener] of listeners) {
        if (event === 'data') {
          Readable.prototype.on.call(response, event, listener);
        } else {
          EventEmitter.prototype.on.call(response, event, listener);
        }
        if (current.disposed) {
          try {
            EventEmitter.prototype.removeListener.call(
              response,
              event,
              listener,
            );
          } catch {
            // Secure disposal already selected the terminal result.
          }
          return;
        }
      }
    } catch {
      try {
        invokeHandler('onResponseError');
      } finally {
        // Registration can fail after an event-capable boundary reenters.
        // Remove every candidate, including the listener being registered.
        for (const [event, listener] of listeners) {
          try {
            EventEmitter.prototype.removeListener.call(
              response,
              event,
              listener,
            );
          } catch {
            // The response failure remains authoritative.
          }
        }
      }
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
  if (
    typeof request !== 'object'
    || request === null
    || types.isProxy(request)
  ) {
    throw authError(
      'PROCESS_FAILED',
      'GitHub API request could not be created',
    );
  }
  const end = findDataFunction(request, 'end');
  const destroy = findDataFunction(request, 'destroy');
  if (end === undefined || destroy === undefined) {
    throw authError(
      'PROCESS_FAILED',
      'GitHub API request could not be created',
    );
  }
  const requestListeners: ApiRequestAuthority['requestListeners'] = [
    ['error', () => invokeHandler('onRequestError')],
    ['close', () => invokeHandler('onRequestClose')],
  ];
  const authority: ApiRequestAuthority = {
    request,
    disposed: false,
    end,
    destroy,
    requestListeners,
    responseListeners: [],
    release: () => {
      authorityHolder.current = undefined;
    },
  };
  authorityHolder.current = authority;
  try {
    for (const [event, listener] of requestListeners) {
      EventEmitter.prototype.on.call(request, event, listener);
    }
  } catch {
    try {
      Reflect.apply(destroy, request, []);
    } catch {
      // The fixed creation error remains authoritative.
    }
    throw authError(
      'PROCESS_FAILED',
      'GitHub API request could not be created',
    );
  }
  const facade: ProjectTemplateGithubApiRequest = {
    start(): void {
      const current = API_REQUEST_AUTHORITIES.get(this);
      if (
        current === undefined
        || current.disposed
        || current.request === undefined
        || current.end === undefined
      ) {
        throw authError(
          'PROCESS_FAILED',
          'GitHub API request is no longer available',
        );
      }
      Reflect.apply(current.end, current.request, []);
    },
    destroy(): void {
      const current = API_REQUEST_AUTHORITIES.get(this);
      if (
        current === undefined
        || current.disposed
        || current.request === undefined
      ) {
        return;
      }
      if (
        current.response !== undefined
        && current.responseDestroy !== undefined
      ) {
        try {
          Reflect.apply(
            current.responseDestroy,
            current.response,
            [],
          );
        } catch {
          // Request destruction remains authoritative.
        }
      }
      if (current.destroy !== undefined) {
        try {
          Reflect.apply(current.destroy, current.request, []);
        } catch {
          // destroy() is best-effort; terminal state is authoritative.
        }
      }
    },
    dispose(): void {
      const current = API_REQUEST_AUTHORITIES.get(this);
      if (current === undefined || current.disposed) return;
      current.disposed = true;
      const request = current.request;
      const response = current.response;
      for (const [event, listener] of current.requestListeners) {
        try {
          EventEmitter.prototype.removeListener.call(
            request,
            event,
            listener,
          );
        } catch {
          // Listener cleanup remains best-effort on a failed request.
        }
      }
      if (response !== undefined) {
        for (const [event, listener] of current.responseListeners) {
          try {
            EventEmitter.prototype.removeListener.call(
              response,
              event,
              listener,
            );
          } catch {
            // Listener cleanup remains best-effort on a failed response.
          }
        }
      }
      current.requestListeners = [];
      current.responseListeners = [];
      current.response = undefined;
      current.responseDestroy = undefined;
      current.request = undefined;
      current.end = undefined;
      current.destroy = undefined;
      current.release();
      API_REQUEST_AUTHORITIES.delete(this);
    },
  };
  API_REQUEST_AUTHORITIES.set(facade, authority);
  return Object.freeze(facade);
}

function snapshotAssetRedirectLocation(
  response: IncomingMessage,
): string | undefined {
  const rawHeaders = ownDataValue(response, 'rawHeaders');
  if (
    !Array.isArray(rawHeaders)
    || types.isProxy(rawHeaders)
    || Object.getPrototypeOf(rawHeaders) !== Array.prototype
    || rawHeaders.length === 0
    || rawHeaders.length > MAX_ASSET_RAW_HEADER_ENTRIES
    || rawHeaders.length % 2 !== 0
  ) {
    return undefined;
  }
  const keys = Reflect.ownKeys(rawHeaders);
  if (
    keys.length !== rawHeaders.length + 1
    || keys[keys.length - 1] !== 'length'
  ) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(rawHeaders);
  let location: string | undefined;
  let characters = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const nameDescriptor = descriptors[String(index)];
    const valueDescriptor = descriptors[String(index + 1)];
    if (
      nameDescriptor === undefined
      || valueDescriptor === undefined
      || !('value' in nameDescriptor)
      || !('value' in valueDescriptor)
      || typeof nameDescriptor.value !== 'string'
      || typeof valueDescriptor.value !== 'string'
    ) {
      return undefined;
    }
    const name = nameDescriptor.value;
    const value = valueDescriptor.value;
    characters += name.length + value.length;
    if (characters > MAX_ASSET_RAW_HEADER_CHARACTERS) return undefined;
    if (name.toLowerCase() !== 'location') continue;
    if (
      location !== undefined
      || value.length < 1
      || value.length > 8_192
    ) {
      return undefined;
    }
    // Copy only the one security-relevant header. No other raw header can
    // cross this boundary or remain in request authority.
    location = value;
  }
  return location;
}

function assetRequestUnavailable(): ProjectTemplateGhAuthError {
  return authError(
    'PROCESS_FAILED',
    'GitHub release asset request is no longer available',
  );
}

/**
 * Internal authenticated entry hop for one GitHub release asset.
 *
 * The redirect grant is transferred only after onRedirect returns normally.
 * Until then this request owns the redirect state, allowing a consumed hop to
 * be reclaimed when a handler throws or synchronously disposes the request.
 */
export function createProjectTemplateGithubReleaseAssetRequest(
  credential: DisposableProjectTemplateGhCredential,
  planValue: ProjectTemplateGithubReleaseAssetRequestPlan,
): ProjectTemplateGithubReleaseAssetRequest {
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

  const plan = exactDataRecord(
    planValue,
    ['owner', 'repo', 'assetId', 'handlers'],
  );
  const owner = plan['owner'];
  const repo = plan['repo'];
  const assetId = plan['assetId'];
  const handlerNames = [
    'onResponse',
    'onRedirect',
    'onInvalidResponse',
    'onData',
    'onEnd',
    'onResponseAborted',
    'onResponseError',
    'onResponseClose',
    'onRequestError',
    'onRequestClose',
  ] as const;
  const handlersRecord = exactDataRecord(plan['handlers'], handlerNames);
  if (
    typeof owner !== 'string'
    || !GITHUB_OWNER_PATTERN.test(owner)
    || owner.includes('--')
    || typeof repo !== 'string'
    || !GITHUB_REPOSITORY_PATTERN.test(repo)
    || repo === '.'
    || repo === '..'
    || repo.toLowerCase().endsWith('.git')
    || typeof assetId !== 'number'
    || !Number.isSafeInteger(assetId)
    || assetId <= 0
    || handlerNames.some(
      (name) => (
        typeof handlersRecord[name] !== 'function'
        || types.isProxy(handlersRecord[name])
      ),
    )
  ) {
    throw authError(
      'INVALID_ARGUMENT',
      'GitHub release asset request plan is invalid',
    );
  }
  const handlersReceiver = plan['handlers'] as
    ProjectTemplateGithubReleaseAssetRequestHandlers;
  const path = `/repos/${owner}/${repo}/releases/assets/${assetId}`;
  const baseUrl = `https://api.github.com${path}`;
  const holder: { current?: AssetRequestAuthority } = {};

  const invoke = (
    name: keyof ProjectTemplateGithubReleaseAssetRequestHandlers,
    args: readonly unknown[] = [],
  ): boolean => {
    try {
      Reflect.apply(
        handlersRecord[name] as (...values: unknown[]) => unknown,
        handlersReceiver,
        args,
      );
      return true;
    } catch {
      return false;
    }
  };
  const cleanupResponseListeners = (
    authority: AssetRequestAuthority,
  ): void => {
    const response = authority.response;
    if (response !== undefined) {
      for (const [event, listener] of authority.responseListeners) {
        try {
          EventEmitter.prototype.removeListener.call(
            response,
            event,
            listener,
          );
        } catch {
          // Terminal cleanup remains authoritative.
        }
      }
    }
    authority.responseListeners = [];
  };
  const cleanupRequestListeners = (
    authority: AssetRequestAuthority,
  ): void => {
    const request = authority.request;
    if (request !== undefined) {
      for (const [event, listener] of authority.requestListeners) {
        try {
          EventEmitter.prototype.removeListener.call(
            request,
            event,
            listener,
          );
        } catch {
          // Terminal cleanup remains authoritative.
        }
      }
    }
    authority.requestListeners = [];
  };
  const destroyResponse = (
    response: IncomingMessage,
    destroy?: (...args: unknown[]) => unknown,
  ): boolean => {
    const selected = destroy ?? findDataFunction(response, 'destroy');
    if (selected === undefined) return false;
    try {
      Reflect.apply(selected, response, []);
      return true;
    } catch {
      return false;
    }
  };
  const releaseRedirectAuthority = (
    authority: AssetRequestAuthority,
  ): void => {
    const grant = authority.ownedRedirectGrant;
    const state = authority.ownedRedirectState;
    authority.ownedRedirectGrant = undefined;
    authority.ownedRedirectState = undefined;
    authority.redirectTransferPending = false;
    try {
      grant?.dispose();
    } catch {
      // The state remains capable of reclaiming a consumed hop.
    }
    try {
      state?.dispose();
    } catch {
      // All public errors remain fixed and terminal.
    }
  };
  const terminateWithResponseError = (
    authority: AssetRequestAuthority,
    detachedResponse?: IncomingMessage,
    detachedResponseDestroyAttempted = false,
    notify = true,
  ): void => {
    if (authority.terminal || authority.disposed) return;
    // `terminal` stops transport callbacks after an internal failure, while
    // `disposed` records explicit caller revocation of the sealed facade.
    // Setting terminal first makes cleanup and fallback notification finite
    // even when EventEmitter or a consumer handler synchronously reenters.
    authority.terminal = true;
    const request = authority.request;
    const response = authority.response;
    const requestDestroy = authority.requestDestroy;
    const responseDestroy = authority.responseDestroy;
    cleanupResponseListeners(authority);
    cleanupRequestListeners(authority);
    if (response !== undefined && responseDestroy !== undefined) {
      destroyResponse(response, responseDestroy);
    }
    if (
      detachedResponse !== undefined
      && detachedResponse !== response
      && !detachedResponseDestroyAttempted
    ) {
      destroyResponse(detachedResponse);
    }
    if (request !== undefined && requestDestroy !== undefined) {
      try {
        Reflect.apply(requestDestroy, request, []);
      } catch {
        // The fixed secondary notification remains authoritative.
      }
    }
    releaseRedirectAuthority(authority);
    authority.request = undefined;
    authority.response = undefined;
    authority.end = undefined;
    authority.requestDestroy = undefined;
    authority.responsePause = undefined;
    authority.responseResume = undefined;
    authority.responseDestroy = undefined;
    authority.release();
    if (notify && !authority.disposed) invoke('onResponseError');
  };
  const failActiveResponse = (
    authority: AssetRequestAuthority,
  ): void => {
    terminateWithResponseError(authority);
  };
  const invalidResponse = (
    authority: AssetRequestAuthority,
    response: IncomingMessage,
  ): void => {
    const destroyed = destroyResponse(response);
    if (authority.disposed) return;
    const notified = invoke('onInvalidResponse');
    if ((!destroyed || !notified) && !authority.disposed) {
      terminateWithResponseError(authority, response, true);
    }
  };
  const responseCallback = (response: IncomingMessage): void => {
    const authority = holder.current;
    if (authority === undefined || authority.disposed || authority.terminal) {
      if (isReadableStream(response)) destroyResponse(response);
      return;
    }
    if (!isReadableStream(response)) {
      invalidResponse(authority, response);
      return;
    }
    if (authority.responseSeen) {
      invalidResponse(authority, response);
      return;
    }
    authority.responseSeen = true;
    const rawStatus = ownDataValue(response, 'statusCode');
    if (
      typeof rawStatus !== 'number'
      || !Number.isSafeInteger(rawStatus)
      || rawStatus < 100
      || rawStatus > 599
    ) {
      invalidResponse(authority, response);
      return;
    }

    if (REDIRECT_STATUS_CODES.has(rawStatus)) {
      const location = snapshotAssetRedirectLocation(response);
      if (location === undefined) {
        invalidResponse(authority, response);
        return;
      }
      let state: DisposableProjectTemplateArtifactRedirectState | undefined;
      let grant: DisposableProjectTemplateArtifactRedirectGrant | undefined;
      try {
        state = createProjectTemplateArtifactRedirectState(baseUrl);
        grant = state.resolve(rawStatus, location);
      } catch {
        try {
          grant?.dispose();
        } catch {
          // The state cleanup below remains authoritative.
        }
        try {
          state?.dispose();
        } catch {
          // The invalid response result remains authoritative.
        }
        invalidResponse(authority, response);
        return;
      }
      authority.ownedRedirectState = state;
      authority.ownedRedirectGrant = grant;
      if (!destroyResponse(response)) {
        terminateWithResponseError(authority, response, true);
        return;
      }
      const returnedNormally = invoke('onRedirect', [grant]);
      if (!returnedNormally) {
        terminateWithResponseError(authority, response, true);
        return;
      }
      if (authority.disposed || authority.terminal) return;
      // Normal return is the sole ownership-transfer point. A consumed grant
      // has created a hop whose private authority keeps the redirect state
      // alive; F2b-C can continue within that same module without exposing URL.
      if (authority.constructionComplete) {
        authority.ownedRedirectGrant = undefined;
        authority.ownedRedirectState = undefined;
      } else {
        authority.redirectTransferPending = true;
      }
      return;
    }

    if (rawStatus !== 200) {
      if (!destroyResponse(response)) {
        terminateWithResponseError(authority, response, true);
        return;
      }
      if (!invoke('onResponse', [rawStatus])) {
        terminateWithResponseError(authority, response, true);
      }
      return;
    }

    const pause = findDataFunction(response, 'pause');
    const resume = findDataFunction(response, 'resume');
    const destroy = findDataFunction(response, 'destroy');
    if (pause === undefined || resume === undefined || destroy === undefined) {
      invalidResponse(authority, response);
      return;
    }
    authority.response = response;
    authority.responsePause = pause;
    authority.responseResume = resume;
    authority.responseDestroy = destroy;
    try {
      Reflect.apply(pause, response, []);
    } catch {
      failActiveResponse(authority);
      return;
    }
    const eventHandler = (
      name: keyof ProjectTemplateGithubReleaseAssetRequestHandlers,
      args: readonly unknown[] = [],
    ): void => {
      if (authority.disposed || authority.terminal) return;
      if (!invoke(name, args)) {
        terminateWithResponseError(
          authority,
          undefined,
          false,
          name !== 'onResponseError',
        );
      }
    };
    const listeners: AssetRequestAuthority['responseListeners'] = [
      ['data', (chunk: unknown) => eventHandler('onData', [chunk])],
      ['end', () => eventHandler('onEnd')],
      ['aborted', () => eventHandler('onResponseAborted')],
      ['error', () => eventHandler('onResponseError')],
      ['close', () => eventHandler('onResponseClose')],
    ];
    authority.responseListeners = listeners;
    try {
      for (const [event, listener] of listeners) {
        // EventEmitter registration preserves the explicit paused state.
        // Readable.on('data') would implicitly resume before the consumer
        // receives the sealed facade and opts in via resume().
        EventEmitter.prototype.on.call(response, event, listener);
        if (authority.disposed || authority.terminal) {
          try {
            EventEmitter.prototype.removeListener.call(
              response,
              event,
              listener,
            );
          } catch {
            // The candidate rollback below remains authoritative.
          }
          cleanupResponseListeners(authority);
          return;
        }
      }
    } catch {
      if (!authority.disposed && !authority.terminal) {
        failActiveResponse(authority);
      } else {
        cleanupResponseListeners(authority);
      }
      return;
    }
    if (authority.disposed || authority.terminal) return;
    if (!invoke('onResponse', [200])) {
      failActiveResponse(authority);
      return;
    }
    if (authority.disposed) cleanupResponseListeners(authority);
  };

  const authority: AssetRequestAuthority = {
    disposed: false,
    terminal: false,
    responseSeen: false,
    constructionComplete: false,
    redirectTransferPending: false,
    requestListeners: [],
    responseListeners: [],
    release: () => {
      holder.current = undefined;
    },
  };
  holder.current = authority;

  let request: ClientRequest;
  try {
    request = httpsRequest({
      protocol: 'https:',
      hostname: 'api.github.com',
      port: 443,
      method: 'GET',
      path,
      headers: {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        Authorization: `Bearer ${credentialAuthority.token.toString('utf8')}`,
        'User-Agent': 'takt-project-template',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, responseCallback);
  } catch {
    if (authority.response !== undefined) {
      destroyResponse(authority.response, authority.responseDestroy);
    }
    cleanupResponseListeners(authority);
    releaseRedirectAuthority(authority);
    authority.release();
    throw authError(
      'PROCESS_FAILED',
      'GitHub release asset request could not be created',
    );
  }
  if (
    typeof request !== 'object'
    || request === null
    || types.isProxy(request)
  ) {
    cleanupResponseListeners(authority);
    if (authority.response !== undefined) {
      destroyResponse(authority.response, authority.responseDestroy);
    }
    releaseRedirectAuthority(authority);
    authority.release();
    throw authError(
      'PROCESS_FAILED',
      'GitHub release asset request could not be created',
    );
  }
  const end = findDataFunction(request, 'end');
  const requestDestroy = findDataFunction(request, 'destroy');
  if (end === undefined || requestDestroy === undefined) {
    cleanupResponseListeners(authority);
    if (authority.response !== undefined) {
      destroyResponse(authority.response, authority.responseDestroy);
    }
    releaseRedirectAuthority(authority);
    authority.release();
    throw authError(
      'PROCESS_FAILED',
      'GitHub release asset request could not be created',
    );
  }
  authority.request = request;
  authority.end = end;
  authority.requestDestroy = requestDestroy;
  if (authority.terminal || authority.disposed) {
    try {
      Reflect.apply(requestDestroy, request, []);
    } catch {
      // The fixed creation failure remains authoritative.
    }
    authority.request = undefined;
    authority.end = undefined;
    authority.requestDestroy = undefined;
    authority.release();
    throw authError(
      'PROCESS_FAILED',
      'GitHub release asset request could not be created',
    );
  }
  const requestEventHandler = (
    name: 'onRequestError' | 'onRequestClose',
  ): void => {
    if (authority.disposed || authority.terminal) return;
    if (!invoke(name)) terminateWithResponseError(authority);
  };
  const requestListeners: AssetRequestAuthority['requestListeners'] = [
    ['error', () => {
      requestEventHandler('onRequestError');
    }],
    ['close', () => {
      requestEventHandler('onRequestClose');
    }],
  ];
  authority.requestListeners = requestListeners;
  try {
    for (const [event, listener] of requestListeners) {
      EventEmitter.prototype.on.call(request, event, listener);
      if (authority.disposed || authority.terminal) {
        try {
          EventEmitter.prototype.removeListener.call(
            request,
            event,
            listener,
          );
        } catch {
          // The candidate rollback below remains authoritative.
        }
        cleanupRequestListeners(authority);
        throw assetRequestUnavailable();
      }
    }
  } catch {
    const activeResponse = authority.response;
    const activeResponseDestroy = authority.responseDestroy;
    cleanupRequestListeners(authority);
    cleanupResponseListeners(authority);
    if (!authority.terminal && !authority.disposed) {
      authority.terminal = true;
      if (
        activeResponse !== undefined
        && activeResponseDestroy !== undefined
      ) {
        destroyResponse(activeResponse, activeResponseDestroy);
      }
      try {
        Reflect.apply(requestDestroy, request, []);
      } catch {
        // Fixed creation failure remains authoritative.
      }
    }
    releaseRedirectAuthority(authority);
    authority.request = undefined;
    authority.response = undefined;
    authority.end = undefined;
    authority.requestDestroy = undefined;
    authority.responsePause = undefined;
    authority.responseResume = undefined;
    authority.responseDestroy = undefined;
    authority.release();
    throw authError(
      'PROCESS_FAILED',
      'GitHub release asset request could not be created',
    );
  }

  const facade = Object.freeze<ProjectTemplateGithubReleaseAssetRequest>({
    start(this: ProjectTemplateGithubReleaseAssetRequest): void {
      const current = ASSET_REQUEST_AUTHORITIES.get(this);
      if (
        current === undefined
        || current.disposed
        || current.terminal
        || current.request === undefined
        || current.end === undefined
      ) {
        throw assetRequestUnavailable();
      }
      try {
        Reflect.apply(current.end, current.request, []);
      } catch {
        throw assetRequestUnavailable();
      }
    },
    pause(this: ProjectTemplateGithubReleaseAssetRequest): void {
      const current = ASSET_REQUEST_AUTHORITIES.get(this);
      if (
        current === undefined
        || current.disposed
        || current.terminal
        || current.response === undefined
        || current.responsePause === undefined
      ) {
        throw assetRequestUnavailable();
      }
      try {
        Reflect.apply(current.responsePause, current.response, []);
      } catch {
        throw assetRequestUnavailable();
      }
    },
    resume(this: ProjectTemplateGithubReleaseAssetRequest): void {
      const current = ASSET_REQUEST_AUTHORITIES.get(this);
      if (
        current === undefined
        || current.disposed
        || current.terminal
        || current.response === undefined
        || current.responseResume === undefined
      ) {
        throw assetRequestUnavailable();
      }
      try {
        Reflect.apply(current.responseResume, current.response, []);
      } catch {
        throw assetRequestUnavailable();
      }
    },
    destroy(this: ProjectTemplateGithubReleaseAssetRequest): void {
      const current = ASSET_REQUEST_AUTHORITIES.get(this);
      if (
        current === undefined
        || current.disposed
        || current.terminal
        || current.request === undefined
      ) {
        throw assetRequestUnavailable();
      }
      let failed = false;
      if (
        current.response !== undefined
        && current.responseDestroy !== undefined
      ) {
        failed = !destroyResponse(
          current.response,
          current.responseDestroy,
        );
      }
      if (current.requestDestroy !== undefined) {
        try {
          Reflect.apply(current.requestDestroy, current.request, []);
        } catch {
          failed = true;
        }
      }
      if (failed) throw assetRequestUnavailable();
    },
    dispose(this: ProjectTemplateGithubReleaseAssetRequest): void {
      if (!ASSET_REQUEST_FACADES.has(this)) {
        throw assetRequestUnavailable();
      }
      const current = ASSET_REQUEST_AUTHORITIES.get(this);
      if (current === undefined || current.disposed) return;
      current.disposed = true;
      cleanupResponseListeners(current);
      for (const [event, listener] of current.requestListeners) {
        try {
          EventEmitter.prototype.removeListener.call(
            current.request,
            event,
            listener,
          );
        } catch {
          // Authority deletion remains terminal.
        }
      }
      if (
        current.response !== undefined
        && current.responseDestroy !== undefined
      ) {
        destroyResponse(current.response, current.responseDestroy);
      }
      if (
        current.request !== undefined
        && current.requestDestroy !== undefined
      ) {
        try {
          Reflect.apply(
            current.requestDestroy,
            current.request,
            [],
          );
        } catch {
          // Authority deletion remains terminal.
        }
      }
      releaseRedirectAuthority(current);
      current.requestListeners = [];
      current.responseListeners = [];
      current.request = undefined;
      current.response = undefined;
      current.end = undefined;
      current.requestDestroy = undefined;
      current.responsePause = undefined;
      current.responseResume = undefined;
      current.responseDestroy = undefined;
      current.release();
      ASSET_REQUEST_AUTHORITIES.delete(this);
    },
  });
  ASSET_REQUEST_FACADES.add(facade);
  ASSET_REQUEST_AUTHORITIES.set(facade, authority);
  authority.constructionComplete = true;
  if (
    authority.redirectTransferPending
    && !authority.disposed
    && !authority.terminal
  ) {
    authority.redirectTransferPending = false;
    authority.ownedRedirectGrant = undefined;
    authority.ownedRedirectState = undefined;
  }
  return facade;
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
