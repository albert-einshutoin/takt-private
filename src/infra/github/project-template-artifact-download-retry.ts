import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import type {
  GithubTemplateArchiveAssetInput,
} from '../../features/project-template/github-download-orchestrator.js';
import {
  isCanonicalGithubRepositoryCoordinates,
} from '../../features/project-template/github-repository-coordinates.js';
import type {
  ProjectTemplateArtifactDownloadBridge,
  ProjectTemplateArtifactDownloadContext,
} from './project-template-artifact-download.js';
import {
  createProjectTemplateArtifactDownloadCoordinatorBridge,
  type ProjectTemplateArtifactDownloadDecisionEvent,
  type ProjectTemplateArtifactDownloadPolicy,
} from './project-template-artifact-download-coordinator.js';
import {
  createProjectTemplateArtifactSingleAttempt,
  type ProjectTemplateArtifactSingleAttempt,
  type ProjectTemplateArtifactSingleAttemptFailure,
  type ProjectTemplateArtifactSingleAttemptSettlement,
} from './project-template-artifact-download-attempt.js';
import {
  MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES,
} from './project-template-artifact-download-contract.js';
import {
  acquireProjectTemplateGhCredential,
  type AcquireProjectTemplateGhCredentialOptions,
  type DisposableProjectTemplateGhCredential,
  type ProjectTemplateGhAuthErrorCode,
} from './project-template-gh-auth.js';

const ATTEMPT_TIMEOUT_MS = 120_000;
const MAX_TRANSACTIONAL_TIMER_ARMS = 8;
const TIMER_SETUP_MARGIN_MS = 1;
const RETRY_DELAYS_MS = Object.freeze([0, 250, 1_000] as const);
const NativePromise = Promise;
const NATIVE_PROMISE_PROTOTYPE = Promise.prototype;
const NATIVE_PROMISE_THEN = Promise.prototype.then;
const NATIVE_PROMISE_CONSTRUCTOR = Object.getOwnPropertyDescriptor(
  Promise.prototype,
  'constructor',
)?.value;
const NATIVE_PROMISE_SPECIES_GETTER = Object.getOwnPropertyDescriptor(
  Promise,
  Symbol.species,
)?.get;
const NativeAbortController = AbortController;
const NativeUint8Array = Uint8Array;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
)?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const EVENT_TARGET_ADD = EventTarget.prototype.addEventListener;
const EVENT_TARGET_REMOVE = EventTarget.prototype.removeEventListener;
const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

export interface ProjectTemplateArtifactRetryDependencies {
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => unknown;
  readonly acquireCredential: (
    options: AcquireProjectTemplateGhCredentialOptions,
  ) => Promise<DisposableProjectTemplateGhCredential>;
  readonly createAttempt: (
    credential: DisposableProjectTemplateGhCredential,
    input: Readonly<GithubTemplateArchiveAssetInput>,
  ) => ProjectTemplateArtifactSingleAttempt;
}

interface RetryDependenciesSnapshot {
  readonly receiver: ProjectTemplateArtifactRetryDependencies;
  readonly now: ProjectTemplateArtifactRetryDependencies['now'];
  readonly setTimer: ProjectTemplateArtifactRetryDependencies['setTimer'];
  readonly clearTimer: ProjectTemplateArtifactRetryDependencies['clearTimer'];
  readonly acquireCredential:
    ProjectTemplateArtifactRetryDependencies['acquireCredential'];
  readonly createAttempt:
    ProjectTemplateArtifactRetryDependencies['createAttempt'];
}

interface RetryInput {
  readonly owner: string;
  readonly repo: string;
  readonly releaseId: number;
  readonly assetId: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

interface RetryClock {
  lastNow: number;
}

interface CredentialSnapshot {
  readonly receiver: DisposableProjectTemplateGhCredential;
  readonly dispose: DisposableProjectTemplateGhCredential['dispose'];
}

interface AttemptSnapshot {
  readonly receiver: ProjectTemplateArtifactSingleAttempt;
  readonly pull: ProjectTemplateArtifactSingleAttempt['pull'];
  readonly dispose: ProjectTemplateArtifactSingleAttempt['dispose'];
}

interface PendingSettlement {
  readonly receiver: ProjectTemplateArtifactSingleAttemptSettlement;
  readonly chunk: ProjectTemplateArtifactSingleAttemptSettlement['chunk'];
  readonly done: ProjectTemplateArtifactSingleAttemptSettlement['done'];
  readonly fail: ProjectTemplateArtifactSingleAttemptSettlement['fail'];
}

type GenerationEvent =
  | { readonly kind: 'chunk'; readonly value: Uint8Array }
  | { readonly kind: 'done' }
  | {
    readonly kind: 'fail';
    readonly failure: ProjectTemplateArtifactSingleAttemptFailure;
  };

interface PullToken {
  active: boolean;
  pulling: boolean;
  queued: GenerationEvent | undefined;
  overflowed: boolean;
  dispatch?: (event: GenerationEvent) => void;
}

interface CallbackToken<Event = undefined> {
  dispatch?: (event: Event) => void;
}

interface TimerRegistration {
  readonly token: CallbackToken;
  readonly dueMs: number;
  readonly armCount: number;
  handle: unknown;
  hasHandle: boolean;
  armed: boolean;
  arming: boolean;
  firedDuringArm: boolean;
}

interface GenerationState {
  phase:
    | 'idle'
    | 'backoff'
    | 'acquiring'
    | 'active'
    | 'deferred'
    | 'terminal'
    | 'disposed';
  readonly delayMs: number;
  readonly input: RetryInput;
  readonly deadlineMs: number;
  readonly dependencies: RetryDependenciesSnapshot;
  readonly clock: RetryClock;
  pending: PendingSettlement | undefined;
  terminalFailurePending:
    | ProjectTemplateArtifactSingleAttemptFailure
    | undefined;
  timer: TimerRegistration | undefined;
  controller: AbortController | undefined;
  acquireToken: CallbackToken<
    | { readonly kind: 'credential'; readonly value: unknown }
    | { readonly kind: 'failure'; readonly error: unknown }
  > | undefined;
  abortToken: CallbackToken | undefined;
  abortListener: (() => void) | undefined;
  credential: CredentialSnapshot | undefined;
  attempt: AttemptSnapshot | undefined;
  pullToken: PullToken | undefined;
  deliveredAny: boolean;
}

const claimedCredentials = new WeakSet<object>();
const disposedCredentials = new WeakSet<object>();
const claimedInnerAttempts = new WeakSet<object>();
const disposedInnerAttempts = new WeakSet<object>();

const NETWORK_RETRYABLE_FAILURE = failureRecord({
  code: 'NETWORK' as const,
  retryable: true as const,
  replaySafe: true as const,
});
const NETWORK_TERMINAL_FAILURE = failureRecord({
  code: 'NETWORK' as const,
  retryable: false as const,
  replaySafe: false as const,
});
const INTERNAL_FAILURE = failureRecord({
  code: 'INTERNAL' as const,
  retryable: false as const,
  replaySafe: false as const,
});

const DEFAULT_DEPENDENCIES =
  Object.freeze<ProjectTemplateArtifactRetryDependencies>({
    now: () => performance.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
      return undefined;
    },
    acquireCredential: acquireProjectTemplateGhCredential,
    createAttempt: createProjectTemplateArtifactSingleAttempt,
  });

function failureRecord<Value extends object>(
  value: Value,
): Readonly<Value> {
  return Object.freeze(Object.assign(Object.create(null) as object, value));
}

function invalidArgument(): TypeError {
  return new TypeError('GitHub template artifact retry input is invalid');
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length
  ) throw invalidArgument();
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

function snapshotInput(value: GithubTemplateArchiveAssetInput): RetryInput {
  const includesSignal = (
    typeof value === 'object'
    && value !== null
    && !types.isProxy(value)
    && Reflect.ownKeys(value).includes('signal')
  );
  const record = exactDataRecord(
    value,
    includesSignal
      ? ['owner', 'repo', 'releaseId', 'assetId', 'maxBytes', 'signal']
      : ['owner', 'repo', 'releaseId', 'assetId', 'maxBytes'],
  );
  const { owner, repo, releaseId, assetId, maxBytes, signal } = record;
  if (
    !isCanonicalGithubRepositoryCoordinates(owner, repo)
    || !Number.isSafeInteger(releaseId)
    || (releaseId as number) <= 0
    || !Number.isSafeInteger(assetId)
    || (assetId as number) <= 0
    || !Number.isSafeInteger(maxBytes)
    || (maxBytes as number) <= 0
    || (
      signal !== undefined
      && (
        typeof signal !== 'object'
        || signal === null
        || types.isProxy(signal)
        || Object.getPrototypeOf(signal) !== AbortSignal.prototype
      )
    )
  ) throw invalidArgument();
  return Object.freeze({
    owner,
    repo,
    releaseId,
    assetId,
    maxBytes,
    ...(signal === undefined ? {} : { signal }),
  }) as RetryInput;
}

function snapshotContext(
  value: ProjectTemplateArtifactDownloadContext,
): number {
  const record = exactDataRecord(value, ['deadlineMs']);
  const deadlineMs = record['deadlineMs'];
  if (
    typeof deadlineMs !== 'number'
    || !Number.isFinite(deadlineMs)
    || deadlineMs < 0
  ) throw invalidArgument();
  return deadlineMs;
}

function snapshotDependencies(
  value: ProjectTemplateArtifactRetryDependencies | undefined,
): RetryDependenciesSnapshot {
  const receiver = value ?? DEFAULT_DEPENDENCIES;
  const record = exactDataRecord(receiver, [
    'now',
    'setTimer',
    'clearTimer',
    'acquireCredential',
    'createAttempt',
  ]);
  for (const entry of Object.values(record)) {
    if (typeof entry !== 'function' || types.isProxy(entry)) {
      throw invalidArgument();
    }
  }
  return Object.freeze({
    receiver,
    now: record['now'] as RetryDependenciesSnapshot['now'],
    setTimer: record['setTimer'] as RetryDependenciesSnapshot['setTimer'],
    clearTimer: record['clearTimer'] as RetryDependenciesSnapshot['clearTimer'],
    acquireCredential: record['acquireCredential'] as
      RetryDependenciesSnapshot['acquireCredential'],
    createAttempt: record['createAttempt'] as
      RetryDependenciesSnapshot['createAttempt'],
  });
}

function readNow(
  dependencies: RetryDependenciesSnapshot,
  clock: RetryClock,
): number {
  const value = Reflect.apply(
    dependencies.now,
    dependencies.receiver,
    [],
  );
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value < clock.lastNow
  ) {
    throw invalidArgument();
  }
  clock.lastNow = value;
  return value;
}

function snapshotSettlement(
  value: ProjectTemplateArtifactSingleAttemptSettlement,
): PendingSettlement {
  const record = exactDataRecord(value, ['chunk', 'done', 'fail']);
  if (
    typeof record['chunk'] !== 'function'
    || typeof record['done'] !== 'function'
    || typeof record['fail'] !== 'function'
    || types.isProxy(record['chunk'])
    || types.isProxy(record['done'])
    || types.isProxy(record['fail'])
  ) throw invalidArgument();
  return Object.freeze({
    receiver: value,
    chunk: record['chunk'] as PendingSettlement['chunk'],
    done: record['done'] as PendingSettlement['done'],
    fail: record['fail'] as PendingSettlement['fail'],
  });
}

function snapshotCredential(value: unknown): CredentialSnapshot | undefined {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || !Object.isFrozen(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return undefined;
  const record = Object.getOwnPropertyDescriptors(value);
  const descriptor = record['dispose'];
  if (
    Reflect.ownKeys(value).length !== 1
    || descriptor === undefined
    || !('value' in descriptor)
    || typeof descriptor.value !== 'function'
    || types.isProxy(descriptor.value)
  ) return undefined;
  return Object.freeze({
    receiver: value as DisposableProjectTemplateGhCredential,
    dispose: descriptor.value as DisposableProjectTemplateGhCredential['dispose'],
  });
}

function snapshotAttempt(value: unknown): AttemptSnapshot | undefined {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || !Object.isFrozen(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return undefined;
  const record = Object.getOwnPropertyDescriptors(value);
  const pull = record['pull'];
  const dispose = record['dispose'];
  if (
    Reflect.ownKeys(value).length !== 2
    || pull === undefined
    || dispose === undefined
    || !('value' in pull)
    || !('value' in dispose)
    || typeof pull.value !== 'function'
    || typeof dispose.value !== 'function'
    || types.isProxy(pull.value)
    || types.isProxy(dispose.value)
  ) return undefined;
  return Object.freeze({
    receiver: value as ProjectTemplateArtifactSingleAttempt,
    pull: pull.value as ProjectTemplateArtifactSingleAttempt['pull'],
    dispose: dispose.value as ProjectTemplateArtifactSingleAttempt['dispose'],
  });
}

function clearGenerationTimer(state: GenerationState): void {
  const registration = state.timer;
  state.timer = undefined;
  if (registration === undefined) return;
  registration.armed = false;
  registration.token.dispatch = undefined;
  if (!registration.hasHandle) return;
  registration.hasHandle = false;
  try {
    Reflect.apply(
      state.dependencies.clearTimer,
      state.dependencies.receiver,
      [registration.handle],
    );
  } catch {
    // Logical revocation is committed before untrusted cleanup.
  }
}

function detachAbort(state: GenerationState): void {
  const token = state.abortToken;
  state.abortToken = undefined;
  if (token !== undefined) token.dispatch = undefined;
  const listener = state.abortListener;
  state.abortListener = undefined;
  if (listener === undefined || state.input.signal === undefined) return;
  try {
    Reflect.apply(EVENT_TARGET_REMOVE, state.input.signal, [
      'abort',
      listener,
    ]);
  } catch {
    // The generation token remains revoked.
  }
}

function safelyDisposeAttempt(attempt: AttemptSnapshot | undefined): void {
  if (attempt === undefined || disposedInnerAttempts.has(attempt.receiver)) {
    return;
  }
  disposedInnerAttempts.add(attempt.receiver);
  try {
    Reflect.apply(attempt.dispose, attempt.receiver, []);
  } catch {
    // Ownership was revoked before crossing the cleanup boundary.
  }
}

function safelyDisposeCredential(
  credential: CredentialSnapshot | undefined,
): void {
  if (
    credential === undefined
    || disposedCredentials.has(credential.receiver)
  ) return;
  disposedCredentials.add(credential.receiver);
  try {
    Reflect.apply(credential.dispose, credential.receiver, []);
  } catch {
    // The credential remains logically disposed.
  }
}

function disposeLateCredential(value: unknown): void {
  const credential = snapshotCredential(value);
  if (
    credential === undefined
    || claimedCredentials.has(credential.receiver)
  ) return;
  claimedCredentials.add(credential.receiver);
  safelyDisposeCredential(credential);
}

function revokePullToken(token: PullToken | undefined): void {
  if (token === undefined) return;
  token.active = false;
  token.pulling = false;
  token.queued = undefined;
  token.overflowed = false;
  token.dispatch = undefined;
}

function releaseResources(state: GenerationState): void {
  clearGenerationTimer(state);
  detachAbort(state);
  const acquireToken = state.acquireToken;
  state.acquireToken = undefined;
  if (acquireToken !== undefined) acquireToken.dispatch = undefined;
  const pullToken = state.pullToken;
  state.pullToken = undefined;
  revokePullToken(pullToken);
  const controller = state.controller;
  state.controller = undefined;
  try {
    controller?.abort();
  } catch {
    // Callback authority was already revoked.
  }
  const attempt = state.attempt;
  const credential = state.credential;
  state.attempt = undefined;
  state.credential = undefined;
  safelyDisposeAttempt(attempt);
  safelyDisposeCredential(credential);
}

function invokeFailure(
  pending: PendingSettlement,
  failure: ProjectTemplateArtifactSingleAttemptFailure,
): void {
  try {
    Reflect.apply(pending.fail, pending.receiver, [failure]);
  } catch {
    // D3 owns the public failure.
  }
}

function snapshotChunk(value: unknown): Uint8Array | undefined {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || !types.isUint8Array(value)
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
    || TYPED_ARRAY_BUFFER_GETTER === undefined
  ) return undefined;
  try {
    const byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    );
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
    if (
      typeof byteLength !== 'number'
      || byteLength <= 0
      || byteLength > MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES
      || types.isSharedArrayBuffer(buffer)
    ) return undefined;
    // Capture bytes while the inner callback is on-stack. This prevents a
    // synchronous producer from mutating a retained chunk before pull returns.
    const copy = new NativeUint8Array(byteLength);
    Reflect.apply(TYPED_ARRAY_SET, copy, [value]);
    return copy;
  } catch {
    return undefined;
  }
}

function terminalize(
  state: GenerationState,
  failure: ProjectTemplateArtifactSingleAttemptFailure,
): void {
  if (
    state.phase === 'deferred'
    || state.phase === 'terminal'
    || state.phase === 'disposed'
  ) return;
  state.phase = 'terminal';
  const pending = state.pending;
  state.pending = undefined;
  const token = state.pullToken;
  state.pullToken = undefined;
  revokePullToken(token);
  releaseResources(state);
  if (pending === undefined) {
    state.terminalFailurePending = failure;
  } else {
    invokeFailure(pending, failure);
  }
}

function deferToSharedDeadline(state: GenerationState): void {
  if (
    state.phase === 'deferred'
    || state.phase === 'disposed'
    || state.phase === 'terminal'
  ) return;
  // Preserve the D3 settlement so D1 alone publishes the shared TIMEOUT.
  state.phase = 'deferred';
  releaseResources(state);
}

function armTimer(
  state: GenerationState,
  delayMs: number,
  dueMs: number,
  callback: () => void,
  armCount = 0,
): boolean {
  if (armCount >= MAX_TRANSACTIONAL_TIMER_ARMS) {
    terminalize(state, INTERNAL_FAILURE);
    return false;
  }
  const token: CallbackToken = {};
  const physicalDelayMs = Math.max(0, delayMs - TIMER_SETUP_MARGIN_MS);
  const registration: TimerRegistration = {
    token,
    dueMs,
    armCount,
    handle: undefined,
    hasHandle: false,
    armed: true,
    arming: true,
    firedDuringArm: false,
  };
  state.timer = registration;
  const listener = (): void => {
    token.dispatch?.(undefined);
  };
  token.dispatch = (): void => {
    if (
      !registration.armed
      || state.timer !== registration
      || state.phase === 'disposed'
    ) return;
    if (registration.arming) {
      registration.firedDuringArm = true;
      return;
    }
    handleTimer(state, registration, callback);
  };
  let handle: unknown;
  try {
    handle = Reflect.apply(
      state.dependencies.setTimer,
      state.dependencies.receiver,
      [listener, physicalDelayMs],
    );
  } catch {
    registration.arming = false;
    if (state.timer === registration) {
      registration.armed = false;
      state.timer = undefined;
      token.dispatch = undefined;
      if (!isGenerationStopped(state)) terminalize(state, INTERNAL_FAILURE);
    }
    return false;
  }
  registration.arming = false;
  if (
    registration.firedDuringArm
    || state.timer !== registration
    || isGenerationStopped(state)
  ) {
    registration.armed = false;
    token.dispatch = undefined;
    if (state.timer === registration) state.timer = undefined;
    try {
      Reflect.apply(
        state.dependencies.clearTimer,
        state.dependencies.receiver,
        [handle],
      );
    } catch {
      // Logical callback revocation remains authoritative.
    }
    if (
      registration.firedDuringArm
      && !isGenerationStopped(state)
    ) terminalize(state, INTERNAL_FAILURE);
    return false;
  }
  registration.handle = handle;
  registration.hasHandle = true;
  let afterArm: number;
  try {
    afterArm = readNow(state.dependencies, state.clock);
  } catch {
    clearGenerationTimer(state);
    if (!isGenerationStopped(state)) terminalize(state, INTERNAL_FAILURE);
    return false;
  }
  if (
    state.timer !== registration
    || isGenerationStopped(state)
  ) {
    // A reentrant clock hook may already have released the registration.
    if (registration.hasHandle) {
      registration.armed = false;
      registration.hasHandle = false;
      registration.token.dispatch = undefined;
      try {
        Reflect.apply(
          state.dependencies.clearTimer,
          state.dependencies.receiver,
          [handle],
        );
      } catch {
        // Logical authority is already revoked.
      }
    }
    return false;
  }
  if (afterArm >= state.deadlineMs) {
    clearGenerationTimer(state);
    if (!isGenerationStopped(state)) deferToSharedDeadline(state);
    return false;
  }
  if (afterArm >= dueMs) {
    clearGenerationTimer(state);
    reconcileAfterTimerClear(state, dueMs, callback, armCount);
    return false;
  }
  const freshRemaining = dueMs - afterArm;
  if (freshRemaining < physicalDelayMs) {
    clearGenerationTimer(state);
    reconcileAfterTimerClear(state, dueMs, callback, armCount);
    return false;
  }
  return true;
}

function reconcileAfterTimerClear(
  state: GenerationState,
  dueMs: number,
  callback: () => void,
  armCount: number,
): void {
  if (isGenerationStopped(state)) return;
  let now: number;
  try {
    now = readNow(state.dependencies, state.clock);
  } catch {
    terminalize(state, INTERNAL_FAILURE);
    return;
  }
  if (isGenerationStopped(state)) return;
  if (now >= state.deadlineMs) {
    deferToSharedDeadline(state);
  } else if (now >= dueMs) {
    callback();
  } else {
    armTimer(
      state,
      dueMs - now,
      dueMs,
      callback,
      armCount + 1,
    );
  }
}

function handleTimer(
  state: GenerationState,
  registration: TimerRegistration,
  callback: () => void,
): void {
  if (
    !registration.armed
    || state.timer !== registration
    || isGenerationStopped(state)
  ) return;
  registration.armed = false;
  registration.hasHandle = false;
  registration.token.dispatch = undefined;
  state.timer = undefined;
  let now: number;
  try {
    now = readNow(state.dependencies, state.clock);
  } catch {
    terminalize(state, INTERNAL_FAILURE);
    return;
  }
  if (isGenerationStopped(state)) return;
  if (now >= state.deadlineMs) {
    deferToSharedDeadline(state);
    return;
  }
  if (now < registration.dueMs) {
    armTimer(
      state,
      registration.dueMs - now,
      registration.dueMs,
      callback,
      registration.armCount + 1,
    );
    return;
  }
  callback();
}

function timeoutFailure(state: GenerationState):
ProjectTemplateArtifactSingleAttemptFailure {
  return state.deliveredAny
    ? NETWORK_TERMINAL_FAILURE
    : NETWORK_RETRYABLE_FAILURE;
}

function isGenerationStopped(state: GenerationState): boolean {
  return (
    state.phase === 'deferred'
    || state.phase === 'terminal'
    || state.phase === 'disposed'
  );
}

function isSignalAborted(signal: AbortSignal): boolean {
  if (ABORT_SIGNAL_ABORTED_GETTER === undefined) throw invalidArgument();
  return Reflect.apply(ABORT_SIGNAL_ABORTED_GETTER, signal, []) as boolean;
}

function isExactNativePromise(value: unknown): value is Promise<unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || !types.isPromise(value)
    || Object.getPrototypeOf(value) !== NATIVE_PROMISE_PROTOTYPE
    || Reflect.ownKeys(value).length !== 0
    || NATIVE_PROMISE_CONSTRUCTOR !== NativePromise
    || NATIVE_PROMISE_SPECIES_GETTER === undefined
  ) return false;
  const constructorDescriptor = Object.getOwnPropertyDescriptor(
    NATIVE_PROMISE_PROTOTYPE,
    'constructor',
  );
  const speciesDescriptor = Object.getOwnPropertyDescriptor(
    NativePromise,
    Symbol.species,
  );
  return (
    constructorDescriptor !== undefined
    && 'value' in constructorDescriptor
    && constructorDescriptor.value === NativePromise
    && speciesDescriptor !== undefined
    && 'get' in speciesDescriptor
    && speciesDescriptor.get === NATIVE_PROMISE_SPECIES_GETTER
  );
}

function observeLateCredentialPromise(promise: Promise<unknown>): void {
  try {
    Reflect.apply(NATIVE_PROMISE_THEN, promise, [
      (credentialValue: unknown) => {
        disposeLateCredential(credentialValue);
      },
      () => undefined,
    ]);
  } catch {
    // The generation is already revoked, so no state authority is retained.
  }
}

function startAttempt(state: GenerationState): void {
  if (
    state.phase === 'disposed'
    || state.phase === 'terminal'
    || state.pending === undefined
  ) return;
  let now: number;
  try {
    now = readNow(state.dependencies, state.clock);
  } catch {
    terminalize(state, INTERNAL_FAILURE);
    return;
  }
  if (isGenerationStopped(state) || state.pending === undefined) return;
  const sharedRemaining = state.deadlineMs - now;
  if (sharedRemaining <= 0) {
    // D1 owns the shared deadline and its public TIMEOUT outcome.
    return;
  }
  const attemptDeadline = Math.min(
    state.deadlineMs,
    now + ATTEMPT_TIMEOUT_MS,
  );
  if (sharedRemaining > ATTEMPT_TIMEOUT_MS) {
    armTimer(
      state,
      ATTEMPT_TIMEOUT_MS,
      attemptDeadline,
      () => {
        terminalize(state, timeoutFailure(state));
      },
    );
    if (isGenerationStopped(state)) return;
  }

  state.phase = 'acquiring';
  const controller = new NativeAbortController();
  state.controller = controller;
  if (state.input.signal !== undefined) {
    const abortToken: CallbackToken = {};
    const listener = (): void => {
      abortToken.dispatch?.(undefined);
    };
    abortToken.dispatch = (): void => {
      if (state.phase === 'disposed' || state.phase === 'terminal') return;
      // D1 registered first and owns the externally visible abort result.
      state.phase = 'disposed';
      state.pending = undefined;
      releaseResources(state);
    };
    state.abortToken = abortToken;
    state.abortListener = listener;
    try {
      Reflect.apply(EVENT_TARGET_ADD, state.input.signal, [
        'abort',
        listener,
        { once: true },
      ]);
    } catch {
      terminalize(state, INTERNAL_FAILURE);
      return;
    }
  }

  let promise: unknown;
  try {
    promise = Reflect.apply(
      state.dependencies.acquireCredential,
      state.dependencies.receiver,
      [Object.freeze({
        signal: controller.signal,
        deadlineMs: attemptDeadline,
      })],
    );
  } catch (error) {
    handleAcquireFailure(state, error);
    return;
  }
  if (!isExactNativePromise(promise)) {
    handleAcquireFailure(state, undefined);
    return;
  }
  if (state.phase !== 'acquiring' || state.pending === undefined) {
    observeLateCredentialPromise(promise);
    return;
  }
  const acquireToken: NonNullable<GenerationState['acquireToken']> = {};
  state.acquireToken = acquireToken;
  acquireToken.dispatch = (event): void => {
    if (state.acquireToken !== acquireToken) return;
    state.acquireToken = undefined;
    acquireToken.dispatch = undefined;
    if (event.kind === 'credential') {
      handleCredential(state, event.value);
    } else {
      handleAcquireFailure(state, event.error);
    }
  };
  try {
    Reflect.apply(NATIVE_PROMISE_THEN, promise, [
      (credentialValue: unknown) => {
        const dispatch = acquireToken.dispatch;
        if (dispatch === undefined) {
          disposeLateCredential(credentialValue);
        } else {
          dispatch({ kind: 'credential', value: credentialValue });
        }
      },
      (error: unknown) => {
        acquireToken.dispatch?.({ kind: 'failure', error });
      },
    ]);
  } catch {
    if (state.acquireToken === acquireToken) {
      state.acquireToken = undefined;
      acquireToken.dispatch = undefined;
      terminalize(state, INTERNAL_FAILURE);
    }
  }
}

function readAuthErrorCode(error: unknown):
ProjectTemplateGhAuthErrorCode | undefined {
  if (
    typeof error !== 'object'
    || error === null
    || types.isProxy(error)
  ) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    const code = descriptor !== undefined && 'value' in descriptor
      ? descriptor.value
      : undefined;
    return [
      'INVALID_ARGUMENT',
      'GH_UNAVAILABLE',
      'AUTH_REQUIRED',
      'TIMEOUT',
      'ABORTED',
      'OUTPUT_LIMIT',
      'INVALID_TOKEN',
      'PROCESS_FAILED',
      'CREDENTIAL_DISPOSED',
    ].includes(code as string)
      ? code as ProjectTemplateGhAuthErrorCode
      : undefined;
  } catch {
    return undefined;
  }
}

function handleAcquireFailure(state: GenerationState, error: unknown): void {
  if (state.phase === 'disposed' || state.phase === 'terminal') return;
  const code = readAuthErrorCode(error);
  if (code === 'ABORTED') {
    try {
      if (
        (
          state.input.signal !== undefined
          && isSignalAborted(state.input.signal)
        )
        || (
          state.controller !== undefined
          && isSignalAborted(state.controller.signal)
        )
      ) {
        // A caller abort or shared owner cleanup is surfaced only by D1.
        return;
      }
    } catch {
      terminalize(state, INTERNAL_FAILURE);
      return;
    }
  }
  if (code === 'TIMEOUT') {
    let now: number;
    try {
      now = readNow(state.dependencies, state.clock);
    } catch {
      terminalize(state, INTERNAL_FAILURE);
      return;
    }
    if (now >= state.deadlineMs) {
      // Keep D1's pull pending: its shared timer is the only authority allowed
      // to publish the externally visible TIMEOUT result.
      deferToSharedDeadline(state);
      return;
    }
  }
  const failure = (
    !state.deliveredAny
    && (code === 'TIMEOUT' || code === 'PROCESS_FAILED')
  )
    ? NETWORK_RETRYABLE_FAILURE
    : INTERNAL_FAILURE;
  terminalize(state, failure);
}

function handleCredential(
  state: GenerationState,
  credentialValue: unknown,
): void {
  const credential = snapshotCredential(credentialValue);
  if (credential === undefined) {
    // Malformed capabilities are never invoked.
    terminalize(state, INTERNAL_FAILURE);
    return;
  }
  if (claimedCredentials.has(credential.receiver)) {
    // Another generation owns this capability; never dispose it here.
    terminalize(state, INTERNAL_FAILURE);
    return;
  }
  claimedCredentials.add(credential.receiver);
  if (state.phase !== 'acquiring') {
    safelyDisposeCredential(credential);
    return;
  }
  state.credential = credential;

  let attemptValue: unknown;
  try {
    attemptValue = Reflect.apply(
      state.dependencies.createAttempt,
      state.dependencies.receiver,
      [credential.receiver, state.input],
    );
  } catch {
    terminalize(state, INTERNAL_FAILURE);
    return;
  }
  const attempt = snapshotAttempt(attemptValue);
  if (attempt === undefined || claimedInnerAttempts.has(attempt.receiver)) {
    // A reused capability remains with its existing owner.
    terminalize(state, INTERNAL_FAILURE);
    return;
  }
  claimedInnerAttempts.add(attempt.receiver);
  if (state.phase !== 'acquiring') {
    safelyDisposeAttempt(attempt);
    return;
  }
  state.attempt = attempt;
  state.phase = 'active';
  pullInner(state);
}

function dispatchInnerEvent(
  state: GenerationState,
  token: PullToken,
  event: GenerationEvent,
): void {
  if (
    !token.active
    || state.pullToken !== token
    || state.phase !== 'active'
  ) return;
  if (token.pulling) {
    if (token.queued === undefined) token.queued = event;
    else token.overflowed = true;
    return;
  }
  revokePullToken(token);
  state.pullToken = undefined;
  const pending = state.pending;
  state.pending = undefined;
  if (pending === undefined) return;
  if (event.kind === 'chunk') {
    state.deliveredAny = true;
    try {
      Reflect.apply(pending.chunk, pending.receiver, [event.value]);
    } catch {
      terminalize(state, INTERNAL_FAILURE);
    }
    return;
  }
  state.phase = 'terminal';
  clearGenerationTimer(state);
  detachAbort(state);
  if (event.kind === 'done') {
    try {
      Reflect.apply(pending.done, pending.receiver, []);
    } catch {
      // D3 owns its terminal state.
    }
  } else {
    invokeFailure(pending, event.failure);
  }
}

function canAcceptInnerCallback(token: PullToken): boolean {
  if (!token.active || token.dispatch === undefined) return false;
  if (
    token.pulling
    && (token.queued !== undefined || token.overflowed)
  ) {
    // A second synchronous callback invalidates the pull. Release the first
    // bounded payload now and reject further callbacks before copying input.
    token.queued = undefined;
    token.overflowed = true;
    return false;
  }
  return true;
}

function pullInner(state: GenerationState): void {
  const attempt = state.attempt;
  if (
    attempt === undefined
    || state.phase !== 'active'
    || state.pending === undefined
  ) return;
  const token: PullToken = {
    active: true,
    pulling: true,
    queued: undefined,
    overflowed: false,
    dispatch: undefined,
  };
  state.pullToken = token;
  token.dispatch = (event): void => {
    dispatchInnerEvent(state, token, event);
  };
  const settlement = Object.freeze({
    chunk: (value: Uint8Array): undefined => {
      if (!canAcceptInnerCallback(token)) return undefined;
      const snapshot = snapshotChunk(value);
      token.dispatch?.(
        snapshot === undefined
          ? { kind: 'fail', failure: INTERNAL_FAILURE }
          : { kind: 'chunk', value: snapshot },
      );
      return undefined;
    },
    done: (): undefined => {
      if (!canAcceptInnerCallback(token)) return undefined;
      token.dispatch?.({ kind: 'done' });
      return undefined;
    },
    fail: (
      failure: ProjectTemplateArtifactSingleAttemptFailure,
    ): undefined => {
      if (!canAcceptInnerCallback(token)) return undefined;
      token.dispatch?.({ kind: 'fail', failure });
      return undefined;
    },
  });
  let returned: unknown;
  try {
    returned = Reflect.apply(attempt.pull, attempt.receiver, [settlement]);
  } catch {
    returned = false;
  }
  token.pulling = false;
  if (!token.active) return;
  if (returned !== undefined || token.overflowed) {
    token.queued = undefined;
    token.dispatch = undefined;
    terminalize(state, INTERNAL_FAILURE);
    return;
  }
  const queued = token.queued;
  token.queued = undefined;
  if (queued !== undefined) dispatchInnerEvent(state, token, queued);
}

function pullGeneration(
  state: GenerationState,
  settlementValue: ProjectTemplateArtifactSingleAttemptSettlement,
): undefined {
  if (
    state.phase === 'disposed'
    || state.pending !== undefined
  ) return undefined;
  let settlement: PendingSettlement;
  try {
    settlement = snapshotSettlement(settlementValue);
  } catch {
    return undefined;
  }
  if (state.terminalFailurePending !== undefined) {
    const failure = state.terminalFailurePending;
    state.terminalFailurePending = undefined;
    invokeFailure(settlement, failure);
    return undefined;
  }
  if (state.phase === 'deferred') {
    state.pending = settlement;
    return undefined;
  }
  if (state.phase === 'terminal') {
    invokeFailure(settlement, INTERNAL_FAILURE);
    return undefined;
  }
  state.pending = settlement;
  if (state.phase === 'active') {
    pullInner(state);
    return undefined;
  }
  if (state.phase !== 'idle') return undefined;
  if (state.delayMs > 0) {
    let backoffStart: number;
    try {
      backoffStart = readNow(
        state.dependencies,
        state.clock,
      );
    } catch {
      terminalize(state, INTERNAL_FAILURE);
      return undefined;
    }
    if (state.phase !== 'idle' || state.pending !== settlement) {
      return undefined;
    }
    const remaining = state.deadlineMs - backoffStart;
    if (remaining <= state.delayMs) {
      terminalize(state, INTERNAL_FAILURE);
      return undefined;
    }
    state.phase = 'backoff';
    armTimer(
      state,
      state.delayMs,
      backoffStart + state.delayMs,
      () => {
        if (state.phase !== 'backoff') return;
        startAttempt(state);
      },
    );
    if (isGenerationStopped(state)) return undefined;
    return undefined;
  }
  startAttempt(state);
  return undefined;
}

function disposeGeneration(state: GenerationState): undefined {
  if (state.phase === 'disposed') return undefined;
  state.phase = 'disposed';
  state.pending = undefined;
  state.terminalFailurePending = undefined;
  const token = state.pullToken;
  state.pullToken = undefined;
  revokePullToken(token);
  releaseResources(state);
  return undefined;
}

function createGeneration(
  ordinal: number,
  input: RetryInput,
  deadlineMs: number,
  dependencies: RetryDependenciesSnapshot,
  clock: RetryClock,
): ProjectTemplateArtifactSingleAttempt {
  const state: GenerationState = {
    phase: 'idle',
    delayMs: RETRY_DELAYS_MS[ordinal - 1]!,
    input,
    deadlineMs,
    dependencies,
    clock,
    pending: undefined,
    terminalFailurePending: undefined,
    timer: undefined,
    controller: undefined,
    acquireToken: undefined,
    abortToken: undefined,
    abortListener: undefined,
    credential: undefined,
    attempt: undefined,
    pullToken: undefined,
    deliveredAny: false,
  };
  return Object.freeze({
    pull(
      settlement: ProjectTemplateArtifactSingleAttemptSettlement,
    ): undefined {
      return pullGeneration(state, settlement);
    },
    dispose(): undefined {
      return disposeGeneration(state);
    },
  }) as unknown as ProjectTemplateArtifactSingleAttempt;
}

export function createProjectTemplateArtifactRetryBridge(
  inputValue: Readonly<GithubTemplateArchiveAssetInput>,
  contextValue: ProjectTemplateArtifactDownloadContext,
  dependenciesValue?: ProjectTemplateArtifactRetryDependencies,
): ProjectTemplateArtifactDownloadBridge {
  const input = snapshotInput(inputValue);
  const deadlineMs = snapshotContext(contextValue);
  const dependencies = snapshotDependencies(dependenciesValue);
  const clock: RetryClock = { lastNow: 0 };
  let currentOrdinal = 1;
  const policy = Object.freeze({
    decide(event: ProjectTemplateArtifactDownloadDecisionEvent): undefined {
      let remaining: number;
      try {
        remaining = deadlineMs - readNow(dependencies, clock);
      } catch {
        event.control.fail();
        return undefined;
      }
      if (remaining <= 0) {
        // D1's shared timer owns TIMEOUT. Leaving the decision unselected
        // keeps its pending settlement alive until D1 disposes the bridge.
        return undefined;
      }
      if (event.kind !== 'retryable' || currentOrdinal >= 3) {
        event.control.fail();
        return undefined;
      }
      const nextOrdinal = currentOrdinal + 1;
      const delayMs = RETRY_DELAYS_MS[nextOrdinal - 1]!;
      if (remaining <= delayMs) {
        event.control.fail();
        return undefined;
      }
      currentOrdinal = nextOrdinal;
      event.control.retry(createGeneration(
        nextOrdinal,
        input,
        deadlineMs,
        dependencies,
        clock,
      ));
      return undefined;
    },
  }) satisfies ProjectTemplateArtifactDownloadPolicy;
  return createProjectTemplateArtifactDownloadCoordinatorBridge(
    createGeneration(1, input, deadlineMs, dependencies, clock),
    policy,
  );
}
