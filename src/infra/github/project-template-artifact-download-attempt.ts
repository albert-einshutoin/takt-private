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

interface RetryableFailureShape {
  readonly retryable: true;
  readonly replaySafe: true;
}

interface NonRetryableFailureShape {
  readonly retryable: false;
  readonly replaySafe: false;
}

export type ProjectTemplateArtifactSingleAttemptFailure =
  | ({
    readonly code: 'HTTP_STATUS';
    readonly statusCode: number;
  } & (RetryableFailureShape | NonRetryableFailureShape))
  | ({
    readonly code: 'NETWORK';
  } & (RetryableFailureShape | NonRetryableFailureShape))
  | ({
    readonly code:
      | 'DNS_REJECTED'
      | 'INVALID_RESPONSE'
      | 'OUTPUT_LIMIT'
      | 'INTERNAL';
  } & NonRetryableFailureShape);

export type ProjectTemplateArtifactSingleAttemptFailureCode =
  ProjectTemplateArtifactSingleAttemptFailure['code'];

interface AttemptDependenciesSnapshot {
  readonly receiver: ProjectTemplateArtifactDownloadAttemptDependencies;
  readonly createAuthenticatedRequest:
    typeof createProjectTemplateGithubReleaseAssetRequest;
  readonly createPinnedTransport:
    typeof createProjectTemplateArtifactPinnedTransport;
  readonly scheduleHandoff: (callback: () => void) => void;
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

interface AttemptSettlementSnapshot {
  readonly receiver: ProjectTemplateArtifactSingleAttemptSettlement;
  readonly chunk: (value: Uint8Array) => undefined;
  readonly done: () => undefined;
  readonly fail: (
    failure: ProjectTemplateArtifactSingleAttemptFailure,
  ) => undefined;
}

interface AttemptConstructionLatch {
  readonly kind: 'authenticated' | 'pinned';
  readonly token: AttemptCallbackToken;
  event: AttemptEvent | undefined;
  rejectedGrant: DisposableProjectTemplateArtifactRedirectGrant | undefined;
  invalid: boolean;
}

interface AttemptState {
  phase:
    | 'cold'
    | 'constructing-auth'
    | 'active'
    | 'handoff-pending'
    | 'constructing-pinned'
    | 'done'
    | 'failed'
    | 'disposed';
  // Borrowed: the retry coordinator owns exact credential disposal.
  credential: DisposableProjectTemplateGhCredential | undefined;
  input: AttemptIdentity | undefined;
  dependencies: AttemptDependenciesSnapshot | undefined;
  transport: AttemptTransport | undefined;
  transportKind: 'authenticated' | 'pinned' | undefined;
  pendingGrant: DisposableProjectTemplateArtifactRedirectGrant | undefined;
  pending: AttemptSettlementSnapshot | undefined;
  terminalFailure: ProjectTemplateArtifactSingleAttemptFailure | undefined;
  construction: AttemptConstructionLatch | undefined;
  bodyReady: boolean;
  resuming: boolean;
  resumeRequested: boolean;
  receivedBytes: number;
  deliveredAny: boolean;
  deliveryGeneration: number;
  deliveryClaim: number | undefined;
  token: AttemptCallbackToken;
  facade: ProjectTemplateArtifactSingleAttempt | undefined;
}

const attemptAuthorities = new WeakMap<
ProjectTemplateArtifactSingleAttempt,
AttemptState
>();
const disposedAttempts = new WeakSet<ProjectTemplateArtifactSingleAttempt>();
const terminalAttempts = new WeakMap<
ProjectTemplateArtifactSingleAttempt,
  | { readonly kind: 'done' }
  | {
  readonly kind: 'failed';
  readonly failure: ProjectTemplateArtifactSingleAttemptFailure;
}
>();
// Claim cleanup before invoking untrusted disposers. A disposer may reenter
// through transport callbacks, so object identity is the only stable way to
// keep the capability's physical cleanup exactly-once across ownership layers.
const disposedGrantCapabilities = new WeakSet<object>();
const disposedHopCapabilities = new WeakSet<object>();

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

type TerminalFailure = Extract<
ProjectTemplateArtifactSingleAttemptFailure,
{ readonly retryable: false; readonly code:
  | 'DNS_REJECTED'
  | 'INVALID_RESPONSE'
  | 'OUTPUT_LIMIT'
  | 'INTERNAL' }
>;
type NetworkFailure = Extract<
ProjectTemplateArtifactSingleAttemptFailure,
{ readonly code: 'NETWORK' }
>;
type HttpFailure = Extract<
ProjectTemplateArtifactSingleAttemptFailure,
{ readonly code: 'HTTP_STATUS' }
>;

function terminalFailure(code: TerminalFailure['code']): TerminalFailure {
  const value: TerminalFailure = Object.assign(
    Object.create(null) as object,
    { code, retryable: false as const, replaySafe: false as const },
  );
  return Object.freeze(value);
}

function networkFailure(replaySafe: boolean): NetworkFailure {
  if (replaySafe) {
    const value: Extract<NetworkFailure, { readonly retryable: true }> =
      Object.assign(Object.create(null) as object, {
        code: 'NETWORK' as const,
        retryable: true as const,
        replaySafe: true as const,
      });
    return Object.freeze(value);
  }
  const value: Extract<NetworkFailure, { readonly retryable: false }> =
    Object.assign(Object.create(null) as object, {
      code: 'NETWORK' as const,
      retryable: false as const,
      replaySafe: false as const,
    });
  return Object.freeze(value);
}

function httpFailure(
  statusCode: number,
  replaySafe: boolean,
): HttpFailure {
  if (replaySafe) {
    const value: Extract<HttpFailure, { readonly retryable: true }> =
      Object.assign(Object.create(null) as object, {
        code: 'HTTP_STATUS' as const,
        retryable: true as const,
        replaySafe: true as const,
        statusCode,
      });
    return Object.freeze(value);
  }
  const value: Extract<HttpFailure, { readonly retryable: false }> =
    Object.assign(Object.create(null) as object, {
      code: 'HTTP_STATUS' as const,
      retryable: false as const,
      replaySafe: false as const,
      statusCode,
    });
  return Object.freeze(value);
}

const INTERNAL_FAILURE = terminalFailure('INTERNAL');
const NETWORK_FAILURE = networkFailure(true);
const DNS_FAILURE = terminalFailure('DNS_REJECTED');
const INVALID_RESPONSE_FAILURE = terminalFailure('INVALID_RESPONSE');
const OUTPUT_LIMIT_FAILURE = terminalFailure('OUTPUT_LIMIT');

function statusFailure(statusCode: number): HttpFailure {
  return httpFailure(
    statusCode,
    statusCode === 408
      || statusCode === 429
      || statusCode === 500
      || statusCode === 502
      || statusCode === 503
      || statusCode === 504,
  );
}

function invalidArgument(): TypeError {
  return new TypeError('GitHub template artifact attempt input is invalid');
}

function snapshotDependencies(
  value: ProjectTemplateArtifactDownloadAttemptDependencies,
): AttemptDependenciesSnapshot {
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
    receiver: value,
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
): AttemptSettlementSnapshot {
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
    receiver: value,
    chunk: descriptors['chunk']!.value as (value: Uint8Array) => undefined,
    done: descriptors['done']!.value as () => undefined,
    fail: descriptors['fail']!.value as
      (failure: ProjectTemplateArtifactSingleAttemptFailure) => undefined,
  });
}

interface ChunkIngress {
  readonly value: Uint8Array;
  readonly byteLength: number;
}

function inspectChunk(value: unknown): ChunkIngress {
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
  return { value: value as Uint8Array, byteLength };
}

function copyChunk(ingress: ChunkIngress): Uint8Array {
  const copy = new NativeUint8Array(ingress.byteLength);
  Reflect.apply(TYPED_ARRAY_SET, copy, [ingress.value]);
  return copy;
}

function isTransportCapability(value: unknown): value is AttemptTransport {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const methodNames = ['start', 'pause', 'resume', 'destroy', 'dispose'];
  return (
    Reflect.ownKeys(value).length === methodNames.length
    && methodNames.every((name) => {
      const descriptor = descriptors[name];
      return (
        descriptor !== undefined
        && 'value' in descriptor
        && typeof descriptor.value === 'function'
        && !types.isProxy(descriptor.value)
      );
    })
  );
}

function isRedirectGrantCapability(
  value: unknown,
): value is DisposableProjectTemplateArtifactRedirectGrant {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Reflect.ownKeys(value).length === 2
    && ['consume', 'dispose'].every((name) => {
      const descriptor = descriptors[name];
      return (
        descriptor !== undefined
        && 'value' in descriptor
        && typeof descriptor.value === 'function'
        && !types.isProxy(descriptor.value)
      );
    })
  );
}

function isRedirectHopCapability(
  value: unknown,
): value is DisposableProjectTemplateArtifactRedirectHop {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const dispose = descriptors['dispose'];
  return (
    Reflect.ownKeys(value).length === 1
    && dispose !== undefined
    && 'value' in dispose
    && typeof dispose.value === 'function'
    && !types.isProxy(dispose.value)
  );
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
  safelyDisposeGrant(grant);
}

function safelyDisposeGrant(
  grant: unknown,
): void {
  try {
    if (!isRedirectGrantCapability(grant)) return;
    if (disposedGrantCapabilities.has(grant)) return;
    // Claim before invoking external code because dispose may synchronously
    // reenter this attempt through a retained transport callback.
    disposedGrantCapabilities.add(grant);
    const descriptor = Object.getOwnPropertyDescriptor(grant, 'dispose');
    if (descriptor === undefined || !('value' in descriptor)) return;
    Reflect.apply(descriptor.value, grant, []);
  } catch {
    // Logical callback revocation remains authoritative.
  }
}

function safelyDisposeHop(
  hop: unknown,
): void {
  try {
    if (!isRedirectHopCapability(hop)) return;
    if (disposedHopCapabilities.has(hop)) return;
    // Keep validation, identity claim, and untrusted cleanup within this
    // resource's boundary so malformed input cannot skip sibling cleanup.
    disposedHopCapabilities.add(hop);
    const descriptor = Object.getOwnPropertyDescriptor(hop, 'dispose');
    if (descriptor === undefined || !('value' in descriptor)) return;
    Reflect.apply(descriptor.value, hop, []);
  } catch {
    // Logical callback revocation remains authoritative.
  }
}

function revokeConstructionLatch(
  latch: AttemptConstructionLatch | undefined,
): void {
  if (latch === undefined) return;
  latch.token.active = false;
  latch.token.dispatch = undefined;
}

function isAttemptStopped(state: AttemptState): boolean {
  return (
    state.phase === 'disposed'
    || state.phase === 'failed'
    || state.phase === 'done'
  );
}

function failureAfterDelivery(
  state: AttemptState,
  reason: ProjectTemplateArtifactSingleAttemptFailure,
): ProjectTemplateArtifactSingleAttemptFailure {
  if (!state.deliveredAny || !reason.retryable) return reason;
  return reason.code === 'HTTP_STATUS'
    ? httpFailure(reason.statusCode, false)
    : networkFailure(false);
}

function invokeTerminalSettlement(
  settlement: AttemptSettlementSnapshot,
  method: 'done' | 'fail',
  failureValue?: ProjectTemplateArtifactSingleAttemptFailure,
): void {
  try {
    const result = method === 'done'
      ? Reflect.apply(settlement.done, settlement.receiver, [])
      : Reflect.apply(settlement.fail, settlement.receiver, [failureValue!]);
    if (result !== undefined) throw invalidArgument();
  } catch {
    // Terminal state was committed before crossing the untrusted callback.
  }
}

function minimizeTerminalAuthority(
  state: AttemptState,
  terminal:
    | { readonly kind: 'done' }
    | {
      readonly kind: 'failed';
      readonly failure: ProjectTemplateArtifactSingleAttemptFailure;
    },
): void {
  const facade = state.facade;
  state.facade = undefined;
  state.credential = undefined;
  state.input = undefined;
  state.dependencies = undefined;
  state.transport = undefined;
  state.transportKind = undefined;
  state.pendingGrant = undefined;
  state.pending = undefined;
  state.terminalFailure = terminal.kind === 'failed'
    ? terminal.failure
    : undefined;
  state.construction = undefined;
  state.token.dispatch = undefined;
  if (facade === undefined) return;
  attemptAuthorities.delete(facade);
  if (!disposedAttempts.has(facade)) {
    terminalAttempts.set(facade, Object.freeze(terminal));
  }
}

function failAttempt(
  state: AttemptState,
  reason: ProjectTemplateArtifactSingleAttemptFailure = INTERNAL_FAILURE,
  cleanupEventResource?: () => void,
): void {
  if (
    state.phase === 'failed'
    || state.phase === 'done'
    || state.phase === 'disposed'
  ) {
    try {
      cleanupEventResource?.();
    } catch {
      // Resource cleanup cannot replace an already committed outcome.
    }
    return;
  }
  const finalReason = failureAfterDelivery(state, reason);
  state.phase = 'failed';
  state.terminalFailure = finalReason;
  state.credential = undefined;
  state.input = undefined;
  const construction = state.construction;
  state.construction = undefined;
  revokeConstructionLatch(construction);
  state.deliveryClaim = undefined;
  state.resumeRequested = false;
  state.token.active = false;
  state.token.dispatch = undefined;
  const pending = state.pending;
  state.pending = undefined;
  try {
    cleanupEventResource?.();
  } catch {
    // The committed redacted failure remains primary.
  }
  disposeConstructionGrants(construction);
  disposePendingGrant(state);
  safelyStop(takeTransport(state));
  if (pending !== undefined) {
    invokeTerminalSettlement(pending, 'fail', finalReason);
  }
  minimizeTerminalAuthority(state, {
    kind: 'failed',
    failure: finalReason,
  });
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
  const construction = state.construction;
  state.construction = undefined;
  revokeConstructionLatch(construction);
  state.deliveryClaim = undefined;
  state.resumeRequested = false;
  state.token.active = false;
  state.token.dispatch = undefined;
  const pending = state.pending;
  state.pending = undefined;
  disposeConstructionGrants(construction);
  disposePendingGrant(state);
  // Clean EOF relinquishes authority without synthesizing a transport error.
  safelyDispose(takeTransport(state));
  if (pending !== undefined) {
    invokeTerminalSettlement(pending, 'done');
  }
  minimizeTerminalAuthority(state, { kind: 'done' });
}

function resumeDemand(state: AttemptState): void {
  if (
    state.phase !== 'active'
    || !state.bodyReady
    || state.pending === undefined
    || state.transport === undefined
  ) return;
  if (state.resuming || state.deliveryClaim !== undefined) {
    // A single bit is sufficient: demand is singular and each successful
    // chunk clears its settlement before another pull can be registered.
    state.resumeRequested = true;
    return;
  }
  state.resuming = true;
  try {
    do {
      state.resumeRequested = false;
      if (
        state.phase !== 'active'
        || !state.bodyReady
        || state.pending === undefined
        || state.transport === undefined
        || state.deliveryClaim !== undefined
      ) break;
      try {
        state.transport.resume();
      } catch {
        failAttempt(state, NETWORK_FAILURE);
      }
      // Repeat only when a reentrant pull explicitly latched fresh demand.
      // An empty resume therefore cannot create a busy loop.
    } while (state.resumeRequested);
  } finally {
    state.resuming = false;
  }
}

function onData(state: AttemptState, chunk: unknown): void {
  if (
    state.phase !== 'active'
    || !state.bodyReady
    || state.transport === undefined
  ) {
    failAttempt(state, INVALID_RESPONSE_FAILURE);
    return;
  }
  const pending = state.pending;
  if (pending === undefined || state.deliveryClaim !== undefined) {
    failAttempt(state, INVALID_RESPONSE_FAILURE);
    return;
  }
  let ingress: ChunkIngress;
  try {
    ingress = inspectChunk(chunk);
  } catch {
    failAttempt(state, INVALID_RESPONSE_FAILURE);
    return;
  }
  const maxBytes = state.input?.maxBytes;
  if (
    maxBytes === undefined
    || ingress.byteLength > maxBytes - state.receivedBytes
  ) {
    failAttempt(state, OUTPUT_LIMIT_FAILURE);
    return;
  }
  // The limit comparison intentionally precedes allocation. A hostile large
  // chunk must not turn a one-byte policy rejection into proportional memory.
  let copied: Uint8Array;
  try {
    copied = copyChunk(ingress);
  } catch {
    failAttempt(state, INVALID_RESPONSE_FAILURE);
    return;
  }
  const transport = state.transport;
  const transportKind = state.transportKind;
  const claim = state.deliveryGeneration + 1;
  state.deliveryGeneration = claim;
  state.deliveryClaim = claim;
  if (transportKind === 'authenticated') {
    try {
      transport.pause();
    } catch {
      failAttempt(state, NETWORK_FAILURE);
      return;
    }
    // pause() is an untrusted synchronous boundary. The generation claim
    // prevents recursive data from overtaking the copied wire-order chunk.
    if (
      state.phase !== 'active'
      || state.transport !== transport
      || state.transportKind !== 'authenticated'
      || state.pending !== pending
      || state.deliveryClaim !== claim
    ) return;
  }
  // Subtraction above proves this addition remains a safe integer even when
  // maxBytes is Number.MAX_SAFE_INTEGER.
  state.receivedBytes += copied.byteLength;
  state.deliveredAny = true;
  state.pending = undefined;
  let callbackSucceeded = false;
  try {
    const result = Reflect.apply(pending.chunk, pending.receiver, [copied]);
    if (result !== undefined) throw invalidArgument();
    callbackSucceeded = true;
  } finally {
    // Reentrant demand is released only after the callback contract commits.
    // Keeping the claim on throw/non-undefined lets the outer dispatcher fail
    // the attempt before any newly registered demand can resume the wire.
    if (callbackSucceeded && state.deliveryClaim === claim) {
      state.deliveryClaim = undefined;
      resumeDemand(state);
    }
  }
}

function createPhysicalHandlers(
  token: AttemptCallbackToken,
): {
  readonly authenticated: ProjectTemplateGithubReleaseAssetRequestHandlers;
  readonly pinned: ProjectTemplateArtifactPinnedTransportHandlers;
} {
  const dispatch = (event: AttemptEvent): boolean => {
    const receiver = token.dispatch;
    if (!token.active || receiver === undefined) return false;
    receiver(event);
    return true;
  };
  const onResponse = (statusCode: number): void => {
    dispatch({ kind: 'response', statusCode });
  };
  const onData = (chunk: unknown): void => {
    dispatch({ kind: 'data', chunk });
  };
  const onEnd = (): void => {
    dispatch({ kind: 'end' });
  };
  const onNetworkFailure = (): void => {
    dispatch({ kind: 'failure', failure: NETWORK_FAILURE });
  };
  const onAuthenticatedRequestFailure = (): void => {
    dispatch({ kind: 'authenticated-request-failure' });
  };
  const onInvalidResponse = (): void => {
    dispatch({ kind: 'failure', failure: INVALID_RESPONSE_FAILURE });
  };
  const onDnsRejected = (): void => {
    dispatch({ kind: 'failure', failure: DNS_FAILURE });
  };
  return Object.freeze({
    authenticated: Object.freeze({
      onResponse,
      onRedirect: (
        grant: DisposableProjectTemplateArtifactRedirectGrant,
      ): void => {
        if (!isRedirectGrantCapability(grant)) {
          dispatch({ kind: 'failure', failure: INVALID_RESPONSE_FAILURE });
          return;
        }
        if (dispatch({ kind: 'redirect', grant })) return;
        // A revoked callback can transfer no authority, but must still
        // release a late grant without exposing its target.
        safelyDisposeGrant(grant);
      },
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

function installConstructionCapture(
  state: AttemptState,
  token: AttemptCallbackToken,
  kind: AttemptConstructionLatch['kind'],
): AttemptConstructionLatch {
  const latch: AttemptConstructionLatch = {
    kind,
    token,
    event: undefined,
    rejectedGrant: undefined,
    invalid: false,
  };
  state.construction = latch;
  token.dispatch = (event): void => {
    const allowed = kind === 'authenticated'
      ? event.kind === 'response' || event.kind === 'redirect'
      : event.kind === 'response';
    if (!allowed || latch.event !== undefined) {
      if (event.kind === 'redirect') {
        if (latch.rejectedGrant === undefined) {
          latch.rejectedGrant = event.grant;
        } else if (latch.rejectedGrant !== event.grant) {
          safelyDisposeGrant(event.grant);
        }
      }
      latch.invalid = true;
      return;
    }
    latch.event = event;
  };
  return latch;
}

function drainConstructionLatch(
  state: AttemptState,
  token: AttemptCallbackToken,
  latch: AttemptConstructionLatch,
): boolean {
  state.construction = undefined;
  installDispatch(state, token);
  if (latch.invalid) {
    failAttempt(
      state,
      INVALID_RESPONSE_FAILURE,
      () => disposeConstructionGrants(latch),
    );
    return false;
  }
  const event = latch.event;
  if (event !== undefined) token.dispatch?.(event);
  return event !== undefined;
}

function disposeConstructionGrants(
  latch: AttemptConstructionLatch | undefined,
): void {
  if (latch === undefined) return;
  const accepted = latch.event?.kind === 'redirect'
    ? latch.event.grant
    : undefined;
  safelyDisposeGrant(accepted);
  if (latch.rejectedGrant !== accepted) {
    safelyDisposeGrant(latch.rejectedGrant);
  }
}

function installDispatch(
  state: AttemptState,
  token: AttemptCallbackToken,
): void {
  token.dispatch = (event): void => {
    try {
      if (
        (
          state.phase === 'handoff-pending'
          && event.kind !== 'handoff'
        )
        || state.phase === 'constructing-pinned'
        || (
          state.deliveryClaim !== undefined
          && (
            event.kind === 'response'
            || event.kind === 'redirect'
            || event.kind === 'data'
            || event.kind === 'end'
          )
        )
      ) {
        failAttempt(
          state,
          INVALID_RESPONSE_FAILURE,
          event.kind === 'redirect'
            ? () => safelyDisposeGrant(event.grant)
            : undefined,
        );
      } else if (event.kind === 'failure') {
        failAttempt(state, event.failure);
      } else if (event.kind === 'authenticated-request-failure') {
        // Once the direct response body owns delivery, the authenticated
        // request's lifecycle can close independently without invalidating it.
        if (
          state.transportKind === 'authenticated'
          && !state.bodyReady
        ) failAttempt(state, NETWORK_FAILURE);
      } else if (event.kind === 'end') {
        if (state.phase !== 'active' || !state.bodyReady) {
          failAttempt(state, INVALID_RESPONSE_FAILURE);
        } else {
          finishAttempt(state);
        }
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
      } else if (state.bodyReady) {
        failAttempt(state, INVALID_RESPONSE_FAILURE);
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
    state.phase !== 'handoff-pending'
    || state.transportKind !== 'authenticated'
  ) {
    if (isAttemptStopped(state)) safelyDisposeGrant(grant);
    else {
      failAttempt(
        state,
        INVALID_RESPONSE_FAILURE,
        () => safelyDisposeGrant(grant),
      );
    }
    return;
  }
  let hop: unknown;
  let pinned: ProjectTemplateArtifactPinnedTransport | undefined;
  const dependencies = state.dependencies;
  if (dependencies === undefined) {
    failAttempt(
      state,
      INTERNAL_FAILURE,
      () => safelyDisposeGrant(grant),
    );
    return;
  }
  const nextToken: AttemptCallbackToken = { active: true };
  const pinnedHandlers = createPhysicalHandlers(nextToken).pinned;
  state.phase = 'constructing-pinned';
  const latch = installConstructionCapture(state, nextToken, 'pinned');
  try {
    hop = grant.consume();
    if (!isRedirectHopCapability(hop)) throw invalidArgument();
    if (state.phase !== 'constructing-pinned') {
      nextToken.active = false;
      nextToken.dispatch = undefined;
      safelyDisposeHop(hop);
      return;
    }
    const candidate: unknown = Reflect.apply(
      dependencies.createPinnedTransport,
      dependencies.receiver,
      [hop, pinnedHandlers],
    );
    if (!isTransportCapability(candidate)) throw invalidArgument();
    pinned = candidate;
    hop = undefined;
  } catch {
    nextToken.active = false;
    nextToken.dispatch = undefined;
    failAttempt(state, INTERNAL_FAILURE, () => {
      safelyDisposeHop(hop);
      safelyDisposeGrant(grant);
    });
    return;
  }
  if (state.phase !== 'constructing-pinned') {
    nextToken.active = false;
    nextToken.dispatch = undefined;
    safelyStop(pinned);
    return;
  }
  const oldToken = state.token;
  oldToken.active = false;
  oldToken.dispatch = undefined;
  const authenticated = takeTransport(state);
  state.token = nextToken;
  state.transport = pinned;
  state.transportKind = 'pinned';
  state.phase = 'active';
  safelyDispose(authenticated);
  if (isAttemptStopped(state)) return;
  const eventWasLatched = drainConstructionLatch(state, nextToken, latch);
  if (isAttemptStopped(state) || eventWasLatched) return;
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
  const grantIsValid = isRedirectGrantCapability(grant);
  if (
    !grantIsValid
    || state.phase !== 'active'
    || state.transportKind !== 'authenticated'
    || state.pendingGrant !== undefined
    || state.bodyReady
    || state.deliveredAny
  ) {
    failAttempt(
      state,
      INVALID_RESPONSE_FAILURE,
      grantIsValid ? () => safelyDisposeGrant(grant) : undefined,
    );
    return;
  }
  state.pendingGrant = grant;
  state.phase = 'handoff-pending';
  const dependencies = state.dependencies;
  if (dependencies === undefined) {
    failAttempt(state);
    return;
  }
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
    Reflect.apply(
      dependencies.scheduleHandoff,
      dependencies.receiver,
      [callback],
    );
    scheduling = false;
    if (firedSynchronously) {
      // Grant consumption inside onRedirect would race the authenticated
      // request's post-callback ownership transfer. Fail closed without
      // consuming when an injected scheduler violates the deferred contract.
      failAttempt(state);
    }
  } catch {
    scheduling = false;
    failAttempt(state);
  }
}

function startAttempt(state: AttemptState): void {
  const credential = state.credential;
  const input = state.input;
  const dependencies = state.dependencies;
  if (
    credential === undefined
    || input === undefined
    || dependencies === undefined
  ) {
    failAttempt(state);
    return;
  }
  state.phase = 'constructing-auth';
  const handlers = createPhysicalHandlers(state.token);
  const latch = installConstructionCapture(
    state,
    state.token,
    'authenticated',
  );
  let request: ProjectTemplateGithubReleaseAssetRequest;
  try {
    const candidate: unknown = Reflect.apply(
      dependencies.createAuthenticatedRequest,
      dependencies.receiver,
      [credential, Object.freeze({
        owner: input.owner,
        repo: input.repo,
        assetId: input.assetId,
        handlers: handlers.authenticated,
      })],
    );
    if (!isTransportCapability(candidate)) throw invalidArgument();
    request = candidate;
  } catch {
    state.construction = undefined;
    failAttempt(
      state,
      INTERNAL_FAILURE,
      () => disposeConstructionGrants(latch),
    );
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
  const eventWasLatched = drainConstructionLatch(state, state.token, latch);
  if (isAttemptStopped(state) || eventWasLatched) return;
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
    invokeTerminalSettlement(settlement, 'done');
    return undefined;
  }
  if (state.phase === 'failed' || state.phase === 'disposed') {
    invokeTerminalSettlement(
      settlement,
      'fail',
      state.terminalFailure ?? INTERNAL_FAILURE,
    );
    return undefined;
  }
  if (state.pending !== undefined) {
    failAttempt(state);
    invokeTerminalSettlement(settlement, 'fail', INTERNAL_FAILURE);
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
  const construction = state.construction;
  state.construction = undefined;
  revokeConstructionLatch(construction);
  state.deliveryClaim = undefined;
  state.resumeRequested = false;
  state.pending = undefined;
  disposeConstructionGrants(construction);
  disposePendingGrant(state);
  safelyStop(takeTransport(state));
  return undefined;
}

/**
 * Creates one download attempt while borrowing `credential`.
 *
 * Credential disposal belongs to the retry coordinator so multiple attempts
 * can share one redacted auth authority and release it exactly once.
 */
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
    construction: undefined,
    bodyReady: false,
    resuming: false,
    resumeRequested: false,
    receivedBytes: 0,
    deliveredAny: false,
    deliveryGeneration: 0,
    deliveryClaim: undefined,
    token,
    facade: undefined,
  };
  const attempt = Object.freeze({
    pull(
      this: ProjectTemplateArtifactSingleAttempt,
      settlement: ProjectTemplateArtifactSingleAttemptSettlement,
    ): undefined {
      const current = attemptAuthorities.get(this);
      if (current === undefined || types.isProxy(this)) {
        if (disposedAttempts.has(this)) {
          const snapshot = snapshotSettlement(settlement);
          invokeTerminalSettlement(snapshot, 'fail', INTERNAL_FAILURE);
          return undefined;
        }
        const terminal = terminalAttempts.get(this);
        if (terminal !== undefined) {
          const snapshot = snapshotSettlement(settlement);
          if (terminal.kind === 'done') {
            invokeTerminalSettlement(snapshot, 'done');
          } else {
            invokeTerminalSettlement(snapshot, 'fail', terminal.failure);
          }
          return undefined;
        }
        throw invalidArgument();
      }
      return pullAttempt(current, settlement);
    },
    dispose(this: ProjectTemplateArtifactSingleAttempt): undefined {
      const current = attemptAuthorities.get(this);
      if (current === undefined || types.isProxy(this)) {
        if (disposedAttempts.has(this)) return undefined;
        if (terminalAttempts.has(this)) {
          terminalAttempts.delete(this);
          disposedAttempts.add(this);
          return undefined;
        }
        throw invalidArgument();
      }
      const result = disposeAttempt(current);
      attemptAuthorities.delete(this);
      disposedAttempts.add(this);
      return result;
    },
  }) as unknown as ProjectTemplateArtifactSingleAttempt;
  state.facade = attempt;
  attemptAuthorities.set(attempt, state);
  return attempt;
}
