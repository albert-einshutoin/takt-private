import { types } from 'node:util';
import type { GithubTemplateArchiveAssetInput } from '../../features/project-template/github-download-orchestrator.js';
import { isCanonicalGithubRepositoryCoordinates } from '../../features/project-template/github-repository-coordinates.js';
import {
  createProjectTemplateGithubReleaseAssetRequest,
  type DisposableProjectTemplateGhCredential,
  type ProjectTemplateGithubReleaseAssetRequest,
  type ProjectTemplateGithubReleaseAssetRequestHandlers,
} from './project-template-gh-auth.js';
import {
  createProjectTemplateArtifactPinnedTransport,
  type DisposableProjectTemplateArtifactRedirectGrant,
  type DisposableProjectTemplateArtifactRedirectHop,
  type ProjectTemplateArtifactPinnedTransport,
  type ProjectTemplateArtifactPinnedTransportHandlers,
} from './project-template-artifact-redirect.js';

export interface ProjectTemplateArtifactDownloadAttemptDependencies {
  readonly createAuthenticatedRequest:
    typeof createProjectTemplateGithubReleaseAssetRequest;
  readonly createPinnedTransport:
    typeof createProjectTemplateArtifactPinnedTransport;
  readonly scheduleHandoff?: (callback: () => void) => void;
}

export type ProjectTemplateArtifactSingleAttemptFailureCode =
  | 'HTTP_STATUS'
  | 'NETWORK'
  | 'DNS_REJECTED'
  | 'INVALID_RESPONSE'
  | 'OUTPUT_LIMIT'
  | 'INTERNAL';

export interface ProjectTemplateArtifactSingleAttemptFailure {
  readonly code: ProjectTemplateArtifactSingleAttemptFailureCode;
  readonly retryable: boolean;
  readonly statusCode?: number;
}

export interface ProjectTemplateArtifactSingleAttemptSettlement {
  readonly chunk: (value: Uint8Array) => undefined;
  readonly done: () => undefined;
  readonly fail: (
    failure: ProjectTemplateArtifactSingleAttemptFailure,
  ) => undefined;
}

declare const SINGLE_ATTEMPT_BRAND: unique symbol;

export interface ProjectTemplateArtifactSingleAttempt {
  readonly [SINGLE_ATTEMPT_BRAND]: true;
  pull(
    settlement: ProjectTemplateArtifactSingleAttemptSettlement,
  ): undefined;
  dispose(): undefined;
}

type AttemptTransport =
  | ProjectTemplateGithubReleaseAssetRequest
  | ProjectTemplateArtifactPinnedTransport;

type AttemptEvent =
  | { readonly kind: 'response'; readonly statusCode: number }
  | {
    readonly kind: 'redirect';
    readonly grant: DisposableProjectTemplateArtifactRedirectGrant;
  }
  | { readonly kind: 'handoff' }
  | { readonly kind: 'data'; readonly chunk: unknown }
  | { readonly kind: 'end' }
  | {
    readonly kind: 'failure';
    readonly failure: ProjectTemplateArtifactSingleAttemptFailure;
  }
  | { readonly kind: 'authenticated-request-failure' };

interface AttemptIdentity {
  readonly owner: string;
  readonly repo: string;
  readonly assetId: number;
  readonly maxBytes: number;
}

interface AttemptCallbackToken {
  active: boolean;
  dispatch?: (event: AttemptEvent) => void;
}

interface AttemptState {
  phase: 'cold' | 'starting' | 'active' | 'done' | 'failed' | 'disposed';
  credential: DisposableProjectTemplateGhCredential | undefined;
  input: AttemptIdentity | undefined;
  readonly dependencies: ProjectTemplateArtifactDownloadAttemptDependencies;
  transport: AttemptTransport | undefined;
  transportKind: 'authenticated' | 'pinned' | undefined;
  pendingGrant: DisposableProjectTemplateArtifactRedirectGrant | undefined;
  pending: ProjectTemplateArtifactSingleAttemptSettlement | undefined;
  terminalFailure: ProjectTemplateArtifactSingleAttemptFailure | undefined;
  bodyReady: boolean;
  resuming: boolean;
  receivedBytes: number;
  token: AttemptCallbackToken;
}

const attemptAuthorities = new WeakMap<
ProjectTemplateArtifactSingleAttempt,
AttemptState
>();

const DEFAULT_DEPENDENCIES =
  Object.freeze<ProjectTemplateArtifactDownloadAttemptDependencies>({
    createAuthenticatedRequest:
      createProjectTemplateGithubReleaseAssetRequest,
    createPinnedTransport: createProjectTemplateArtifactPinnedTransport,
    scheduleHandoff: queueMicrotask,
  });

const NativeUint8Array = Uint8Array;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;

function failure(
  code: ProjectTemplateArtifactSingleAttemptFailureCode,
  retryable: boolean,
  statusCode?: number,
): ProjectTemplateArtifactSingleAttemptFailure {
  const value = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(value, {
    code: { enumerable: true, value: code },
    retryable: { enumerable: true, value: retryable },
    ...(statusCode === undefined
      ? {}
      : { statusCode: { enumerable: true, value: statusCode } }),
  });
  return Object.freeze(value) as
    unknown as ProjectTemplateArtifactSingleAttemptFailure;
}

const INTERNAL_FAILURE = failure('INTERNAL', false);
const NETWORK_FAILURE = failure('NETWORK', true);
const DNS_FAILURE = failure('DNS_REJECTED', false);
const INVALID_RESPONSE_FAILURE = failure('INVALID_RESPONSE', false);
const OUTPUT_LIMIT_FAILURE = failure('OUTPUT_LIMIT', false);

function statusFailure(
  statusCode: number,
): ProjectTemplateArtifactSingleAttemptFailure {
  const retryable = (
    statusCode === 408
    || statusCode === 429
    || statusCode === 500
    || statusCode === 502
    || statusCode === 503
    || statusCode === 504
  );
  return failure('HTTP_STATUS', retryable, statusCode);
}

function invalidArgument(): TypeError {
  return new TypeError('GitHub template artifact attempt input is invalid');
}

function snapshotDependencies(
  value: ProjectTemplateArtifactDownloadAttemptDependencies,
): ProjectTemplateArtifactDownloadAttemptDependencies {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw invalidArgument();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    (keys.length !== 2 && keys.length !== 3)
    || !keys.includes('createAuthenticatedRequest')
    || !keys.includes('createPinnedTransport')
    || keys.some(
      (key) => (
        key !== 'createAuthenticatedRequest'
        && key !== 'createPinnedTransport'
        && key !== 'scheduleHandoff'
      ),
    )
  ) throw invalidArgument();
  const authenticated = descriptors['createAuthenticatedRequest'];
  const pinned = descriptors['createPinnedTransport'];
  const schedule = descriptors['scheduleHandoff'];
  if (
    authenticated === undefined
    || !('value' in authenticated)
    || typeof authenticated.value !== 'function'
    || types.isProxy(authenticated.value)
    || pinned === undefined
    || !('value' in pinned)
    || typeof pinned.value !== 'function'
    || types.isProxy(pinned.value)
    || (
      schedule !== undefined
      && (
        !('value' in schedule)
        || typeof schedule.value !== 'function'
        || types.isProxy(schedule.value)
      )
    )
  ) throw invalidArgument();
  return Object.freeze({
    createAuthenticatedRequest: authenticated.value as
      typeof createProjectTemplateGithubReleaseAssetRequest,
    createPinnedTransport: pinned.value as
      typeof createProjectTemplateArtifactPinnedTransport,
    scheduleHandoff: schedule === undefined
      ? queueMicrotask
      : schedule.value as (callback: () => void) => void,
  });
}

function snapshotInput(
  input: Readonly<GithubTemplateArchiveAssetInput>,
): AttemptIdentity {
  if (
    typeof input !== 'object'
    || input === null
    || types.isProxy(input)
  ) throw invalidArgument();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const owner = descriptors['owner'];
  const repo = descriptors['repo'];
  const releaseId = descriptors['releaseId'];
  const assetId = descriptors['assetId'];
  const maxBytes = descriptors['maxBytes'];
  const expectedKeys = descriptors['signal'] === undefined
    ? ['owner', 'repo', 'releaseId', 'assetId', 'maxBytes']
    : ['owner', 'repo', 'releaseId', 'assetId', 'maxBytes', 'signal'];
  if (
    Reflect.ownKeys(input).length !== expectedKeys.length
    || !expectedKeys.every((key) => Object.hasOwn(descriptors, key))
    || owner === undefined
    || !('value' in owner)
    || repo === undefined
    || !('value' in repo)
    || releaseId === undefined
    || !('value' in releaseId)
    || assetId === undefined
    || !('value' in assetId)
    || maxBytes === undefined
    || !('value' in maxBytes)
    || !isCanonicalGithubRepositoryCoordinates(owner.value, repo.value)
    || typeof releaseId.value !== 'number'
    || !Number.isSafeInteger(releaseId.value)
    || releaseId.value <= 0
    || typeof assetId.value !== 'number'
    || !Number.isSafeInteger(assetId.value)
    || assetId.value <= 0
    || typeof maxBytes.value !== 'number'
    || !Number.isSafeInteger(maxBytes.value)
    || maxBytes.value <= 0
  ) throw invalidArgument();
  // releaseId and signal belong to the outer orchestration identity. Keeping a
  // purpose-built snapshot prevents this transport capability from retaining
  // authorities it never consumes.
  return Object.freeze({
    owner: owner.value as string,
    repo: repo.value as string,
    assetId: assetId.value,
    maxBytes: maxBytes.value,
  });
}

function snapshotSettlement(
  value: ProjectTemplateArtifactSingleAttemptSettlement,
): ProjectTemplateArtifactSingleAttemptSettlement {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw invalidArgument();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== 3
    || !['chunk', 'done', 'fail'].every((key) => {
      const descriptor = descriptors[key];
      return (
        descriptor !== undefined
        && 'value' in descriptor
        && typeof descriptor.value === 'function'
        && !types.isProxy(descriptor.value)
      );
    })
  ) throw invalidArgument();
  return Object.freeze({
    chunk: descriptors['chunk']!.value as (value: Uint8Array) => undefined,
    done: descriptors['done']!.value as () => undefined,
    fail: descriptors['fail']!.value as
      (failure: ProjectTemplateArtifactSingleAttemptFailure) => undefined,
  });
}

function snapshotChunk(value: unknown): Uint8Array {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || !types.isUint8Array(value)
    || TYPED_ARRAY_BUFFER_GETTER === undefined
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) throw invalidArgument();
  const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
  const byteLength = Reflect.apply(
    TYPED_ARRAY_BYTE_LENGTH_GETTER,
    value,
    [],
  ) as number;
  if (byteLength === 0 || types.isSharedArrayBuffer(buffer)) {
    throw invalidArgument();
  }
  const copy = new NativeUint8Array(byteLength);
  Reflect.apply(TYPED_ARRAY_SET, copy, [value]);
  return copy;
}

function safelyStop(transport: AttemptTransport | undefined): void {
  if (transport === undefined) return;
  try {
    transport.destroy();
  } catch {
    // The underlying authority may already have selected a terminal outcome.
  }
  try {
    transport.dispose();
  } catch {
    // Logical callback revocation remains authoritative.
  }
}

function safelyDispose(transport: AttemptTransport | undefined): void {
  if (transport === undefined) return;
  try {
    transport.dispose();
  } catch {
    // The detached generation has already lost callback authority.
  }
}

function takeTransport(state: AttemptState): AttemptTransport | undefined {
  const transport = state.transport;
  state.transport = undefined;
  state.transportKind = undefined;
  state.bodyReady = false;
  return transport;
}

function disposePendingGrant(state: AttemptState): void {
  const grant = state.pendingGrant;
  state.pendingGrant = undefined;
  if (grant === undefined) return;
  try {
    grant.dispose();
  } catch {
    // The stable attempt outcome remains private and authoritative.
  }
}

function isAttemptStopped(state: AttemptState): boolean {
  return (
    state.phase === 'disposed'
    || state.phase === 'failed'
    || state.phase === 'done'
  );
}

function failAttempt(
  state: AttemptState,
  reason: ProjectTemplateArtifactSingleAttemptFailure = INTERNAL_FAILURE,
): void {
  if (
    state.phase === 'failed'
    || state.phase === 'done'
    || state.phase === 'disposed'
  ) return;
  state.phase = 'failed';
  state.terminalFailure = reason;
  state.credential = undefined;
  state.input = undefined;
  state.token.active = false;
  state.token.dispatch = undefined;
  const pending = state.pending;
  state.pending = undefined;
  disposePendingGrant(state);
  safelyStop(takeTransport(state));
  pending?.fail(reason);
}

function finishAttempt(state: AttemptState): void {
  if (
    state.phase === 'failed'
    || state.phase === 'done'
    || state.phase === 'disposed'
  ) return;
  state.phase = 'done';
  state.credential = undefined;
  state.input = undefined;
  state.token.active = false;
  state.token.dispatch = undefined;
  const pending = state.pending;
  state.pending = undefined;
  disposePendingGrant(state);
  // Clean EOF relinquishes authority without synthesizing a transport error.
  safelyDispose(takeTransport(state));
  pending?.done();
}

function resumeDemand(state: AttemptState): void {
  if (
    state.phase !== 'active'
    || !state.bodyReady
    || state.pending === undefined
    || state.transport === undefined
    || state.resuming
  ) return;
  state.resuming = true;
  try {
    state.transport.resume();
  } catch {
    failAttempt(state, NETWORK_FAILURE);
  } finally {
    state.resuming = false;
  }
}

function onData(state: AttemptState, chunk: unknown): void {
  if (
    state.phase !== 'active'
    || !state.bodyReady
    || state.transport === undefined
  ) return;
  const pending = state.pending;
  if (pending === undefined) {
    failAttempt(state);
    return;
  }
  if (state.transportKind === 'authenticated') {
    try {
      state.transport.pause();
    } catch {
      failAttempt(state, NETWORK_FAILURE);
      return;
    }
    // pause() is an untrusted synchronous boundary. A callback may have
    // disposed or failed the attempt, so data must not cross that revocation.
    if (
      state.phase !== 'active'
      || state.transportKind !== 'authenticated'
      || state.pending !== pending
    ) return;
  }
  let copied: Uint8Array;
  try {
    copied = snapshotChunk(chunk);
  } catch {
    failAttempt(state, INVALID_RESPONSE_FAILURE);
    return;
  }
  const maxBytes = state.input?.maxBytes;
  if (
    maxBytes === undefined
    || copied.byteLength > maxBytes - state.receivedBytes
  ) {
    failAttempt(state, OUTPUT_LIMIT_FAILURE);
    return;
  }
  // Subtraction above proves this addition remains a safe integer even when
  // maxBytes is Number.MAX_SAFE_INTEGER.
  state.receivedBytes += copied.byteLength;
  state.pending = undefined;
  pending.chunk(copied);
}

function createPhysicalHandlers(
  token: AttemptCallbackToken,
): {
  readonly authenticated: ProjectTemplateGithubReleaseAssetRequestHandlers;
  readonly pinned: ProjectTemplateArtifactPinnedTransportHandlers;
} {
  const dispatch = (event: AttemptEvent): void => {
    if (token.active) token.dispatch?.(event);
  };
  const onResponse = (statusCode: number): void => {
    dispatch({ kind: 'response', statusCode });
  };
  const onData = (chunk: unknown): void => {
    dispatch({ kind: 'data', chunk });
  };
  const onEnd = (): void => dispatch({ kind: 'end' });
  const onNetworkFailure = (): void => dispatch({
    kind: 'failure',
    failure: NETWORK_FAILURE,
  });
  const onAuthenticatedRequestFailure = (): void => dispatch({
    kind: 'authenticated-request-failure',
  });
  const onInvalidResponse = (): void => dispatch({
    kind: 'failure',
    failure: INVALID_RESPONSE_FAILURE,
  });
  const onDnsRejected = (): void => dispatch({
    kind: 'failure',
    failure: DNS_FAILURE,
  });
  return Object.freeze({
    authenticated: Object.freeze({
      onResponse,
      onRedirect: (
        grant: DisposableProjectTemplateArtifactRedirectGrant,
      ): void => dispatch({ kind: 'redirect', grant }),
      onInvalidResponse,
      onData,
      onEnd,
      onResponseAborted: onNetworkFailure,
      onResponseError: onNetworkFailure,
      onResponseClose: onNetworkFailure,
      onRequestError: onAuthenticatedRequestFailure,
      onRequestClose: onAuthenticatedRequestFailure,
    }),
    pinned: Object.freeze({
      onDnsRejected,
      onResponse,
      onInvalidResponse,
      onData,
      onEnd,
      onResponseAborted: onNetworkFailure,
      onResponseError: onNetworkFailure,
      onResponseClose: onNetworkFailure,
      onRequestError: onNetworkFailure,
      onRequestClose: onNetworkFailure,
    }),
  });
}

function installDispatch(
  state: AttemptState,
  token: AttemptCallbackToken,
): void {
  token.dispatch = (event): void => {
    try {
      if (event.kind === 'failure') {
        failAttempt(state, event.failure);
      } else if (event.kind === 'authenticated-request-failure') {
        // Once the direct response body owns delivery, the authenticated
        // request's lifecycle can close independently without invalidating it.
        if (
          state.transportKind === 'authenticated'
          && !state.bodyReady
        ) failAttempt(state, NETWORK_FAILURE);
      } else if (event.kind === 'end') {
        finishAttempt(state);
      } else if (event.kind === 'data') {
        onData(state, event.chunk);
      } else if (event.kind === 'redirect') {
        scheduleRedirectHandoff(state, token, event.grant);
      } else if (event.kind === 'handoff') {
        handoffRedirect(state);
      } else if (
        !Number.isSafeInteger(event.statusCode)
        || event.statusCode < 100
        || event.statusCode > 599
      ) {
        failAttempt(state, INVALID_RESPONSE_FAILURE);
      } else if (event.statusCode !== 200) {
        failAttempt(state, statusFailure(event.statusCode));
      } else if (
        state.phase === 'active'
        && state.transport !== undefined
      ) {
        state.bodyReady = true;
        resumeDemand(state);
      }
    } catch {
      failAttempt(state);
    }
  };
}

function handoffRedirect(
  state: AttemptState,
): void {
  const grant = state.pendingGrant;
  state.pendingGrant = undefined;
  if (grant === undefined) return;
  if (
    state.phase !== 'active'
    || state.transportKind !== 'authenticated'
  ) {
    try {
      grant.dispose();
    } catch {
      // A late grant owns no active attempt authority.
    }
    return;
  }
  let hop: DisposableProjectTemplateArtifactRedirectHop | undefined;
  let pinned: ProjectTemplateArtifactPinnedTransport | undefined;
  const nextToken: AttemptCallbackToken = { active: true };
  const pinnedHandlers = createPhysicalHandlers(nextToken).pinned;
  try {
    hop = grant.consume();
    pinned = state.dependencies.createPinnedTransport(hop, pinnedHandlers);
    hop = undefined;
  } catch {
    nextToken.active = false;
    nextToken.dispatch = undefined;
    try {
      hop?.dispose();
    } catch {
      // The stable attempt failure remains primary.
    }
    try {
      grant.dispose();
    } catch {
      // The stable attempt failure remains primary.
    }
    failAttempt(state);
    return;
  }
  const oldToken = state.token;
  oldToken.active = false;
  oldToken.dispatch = undefined;
  state.token = nextToken;
  installDispatch(state, nextToken);
  safelyDispose(takeTransport(state));
  if (state.phase !== 'active') {
    nextToken.active = false;
    nextToken.dispatch = undefined;
    safelyStop(pinned);
    return;
  }
  state.transport = pinned;
  state.transportKind = 'pinned';
  try {
    pinned.start();
  } catch {
    failAttempt(state, NETWORK_FAILURE);
  }
}

function scheduleRedirectHandoff(
  state: AttemptState,
  token: AttemptCallbackToken,
  grant: DisposableProjectTemplateArtifactRedirectGrant,
): void {
  if (
    state.phase !== 'active'
    || state.transportKind !== 'authenticated'
    || state.pendingGrant !== undefined
  ) {
    try {
      grant.dispose();
    } catch {
      // A duplicate or late grant receives no attempt authority.
    }
    failAttempt(state);
    return;
  }
  state.pendingGrant = grant;
  let scheduling = true;
  let firedSynchronously = false;
  const callback = (): void => {
    if (scheduling) {
      firedSynchronously = true;
      return;
    }
    if (token.active) token.dispatch?.({ kind: 'handoff' });
  };
  try {
    state.dependencies.scheduleHandoff!(callback);
    scheduling = false;
    if (firedSynchronously) {
      // Grant consumption inside onRedirect would race the authenticated
      // request's post-callback ownership transfer. Fail closed without
      // consuming when an injected scheduler violates the deferred contract.
      disposePendingGrant(state);
      failAttempt(state);
    }
  } catch {
    scheduling = false;
    disposePendingGrant(state);
    failAttempt(state);
  }
}

function startAttempt(state: AttemptState): void {
  const credential = state.credential;
  const input = state.input;
  if (credential === undefined || input === undefined) {
    failAttempt(state);
    return;
  }
  state.phase = 'starting';
  const handlers = createPhysicalHandlers(state.token);
  installDispatch(state, state.token);
  let request: ProjectTemplateGithubReleaseAssetRequest;
  try {
    request = state.dependencies.createAuthenticatedRequest(
      credential,
      Object.freeze({
        owner: input.owner,
        repo: input.repo,
        assetId: input.assetId,
        handlers: handlers.authenticated,
      }),
    );
  } catch {
    failAttempt(state);
    return;
  }
  state.credential = undefined;
  if (isAttemptStopped(state)) {
    safelyStop(request);
    return;
  }
  state.transport = request;
  state.transportKind = 'authenticated';
  state.phase = 'active';
  try {
    request.start();
  } catch {
    failAttempt(state, NETWORK_FAILURE);
  }
}

function pullAttempt(
  state: AttemptState,
  settlementValue: ProjectTemplateArtifactSingleAttemptSettlement,
): undefined {
  const settlement = snapshotSettlement(settlementValue);
  if (state.phase === 'done') {
    settlement.done();
    return undefined;
  }
  if (state.phase === 'failed' || state.phase === 'disposed') {
    settlement.fail(state.terminalFailure ?? INTERNAL_FAILURE);
    return undefined;
  }
  if (state.pending !== undefined) {
    failAttempt(state);
    settlement.fail(INTERNAL_FAILURE);
    return undefined;
  }
  state.pending = settlement;
  if (state.phase === 'cold') startAttempt(state);
  else resumeDemand(state);
  return undefined;
}

function disposeAttempt(state: AttemptState): undefined {
  if (state.phase === 'disposed') return undefined;
  state.phase = 'disposed';
  state.token.active = false;
  state.token.dispatch = undefined;
  state.credential = undefined;
  state.input = undefined;
  state.pending = undefined;
  disposePendingGrant(state);
  safelyStop(takeTransport(state));
  return undefined;
}

export function createProjectTemplateArtifactSingleAttempt(
  credential: DisposableProjectTemplateGhCredential,
  input: Readonly<GithubTemplateArchiveAssetInput>,
  dependenciesValue: ProjectTemplateArtifactDownloadAttemptDependencies =
    DEFAULT_DEPENDENCIES,
): ProjectTemplateArtifactSingleAttempt {
  if (
    typeof credential !== 'object'
    || credential === null
    || types.isProxy(credential)
  ) throw invalidArgument();
  const dependencies = snapshotDependencies(dependenciesValue);
  const token: AttemptCallbackToken = { active: true };
  const state: AttemptState = {
    phase: 'cold',
    credential,
    input: snapshotInput(input),
    dependencies,
    transport: undefined,
    transportKind: undefined,
    pendingGrant: undefined,
    pending: undefined,
    terminalFailure: undefined,
    bodyReady: false,
    resuming: false,
    receivedBytes: 0,
    token,
  };
  const attempt = Object.freeze({
    pull(
      this: ProjectTemplateArtifactSingleAttempt,
      settlement: ProjectTemplateArtifactSingleAttemptSettlement,
    ): undefined {
      const current = attemptAuthorities.get(this);
      if (current === undefined || types.isProxy(this)) {
        throw invalidArgument();
      }
      return pullAttempt(current, settlement);
    },
    dispose(this: ProjectTemplateArtifactSingleAttempt): undefined {
      const current = attemptAuthorities.get(this);
      if (current === undefined || types.isProxy(this)) {
        throw invalidArgument();
      }
      return disposeAttempt(current);
    },
  }) as unknown as ProjectTemplateArtifactSingleAttempt;
  attemptAuthorities.set(attempt, state);
  return attempt;
}
