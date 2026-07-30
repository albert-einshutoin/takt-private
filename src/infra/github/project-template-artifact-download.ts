import { types } from 'node:util';
import type {
  GithubTemplateArchiveAssetInput,
  GithubTemplateArchiveAssetPort,
} from '../../features/project-template/github-download-orchestrator.js';
import {
  isCanonicalGithubRepositoryCoordinates,
} from '../../features/project-template/github-repository-coordinates.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const NativePromise = Promise;
const NativeUint8Array = Uint8Array;
const NATIVE_UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
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

export type ProjectTemplateArtifactDownloadErrorCode =
  | 'INVALID_ARGUMENT'
  | 'ITERATOR_USED'
  | 'CONCURRENT_NEXT'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'CLOSED'
  | 'BRIDGE_FAILURE';

export class ProjectTemplateArtifactDownloadError extends Error {
  constructor(
    public readonly code: ProjectTemplateArtifactDownloadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectTemplateArtifactDownloadError';
  }
}

export interface ProjectTemplateArtifactDownloadContext {
  /** Absolute deadline in the monotonic time domain supplied by `now`. */
  readonly deadlineMs: number;
}

declare const projectTemplateArtifactDownloadBridgeBrand: unique symbol;

/** Opaque capability created only by the factory below. */
export interface ProjectTemplateArtifactDownloadBridge {
  readonly [projectTemplateArtifactDownloadBridgeBrand]: true;
}

export interface ProjectTemplateArtifactDownloadSettlement {
  chunk(value: unknown): undefined;
  done(): undefined;
  fail(): undefined;
}

export interface ProjectTemplateArtifactDownloadBridgeHandlers<State> {
  readonly pull: (
    state: State,
    settlement: ProjectTemplateArtifactDownloadSettlement,
  ) => undefined;
  readonly dispose: (state: State) => undefined;
}

export interface ProjectTemplateArtifactDownloadDependencies {
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => unknown;
  readonly start: (
    input: Readonly<GithubTemplateArchiveAssetInput>,
  ) => ProjectTemplateArtifactDownloadBridge;
}

interface SnapshottedDependencies {
  readonly receiver: ProjectTemplateArtifactDownloadDependencies;
  readonly now: ProjectTemplateArtifactDownloadDependencies['now'];
  readonly setTimer: ProjectTemplateArtifactDownloadDependencies['setTimer'];
  readonly clearTimer:
    ProjectTemplateArtifactDownloadDependencies['clearTimer'];
  readonly start: ProjectTemplateArtifactDownloadDependencies['start'];
}

interface DownloadPortAuthority {
  readonly deadlineMs: number;
  readonly dependencies: SnapshottedDependencies;
}

interface DownloadIterableAuthority {
  used: boolean;
  snapshot: Readonly<GithubTemplateArchiveAssetInput> | undefined;
  readonly port: DownloadPortAuthority;
}

interface PendingNext {
  readonly resolve: (result: IteratorResult<Uint8Array>) => void;
  readonly reject: (error: ProjectTemplateArtifactDownloadError) => void;
}

type SettlementEvent =
  | { readonly kind: 'chunk'; readonly value: Uint8Array }
  | { readonly kind: 'done' }
  | { readonly kind: 'fail' };

interface DownloadCallbackToken {
  active: boolean;
  dispatch?: () => void;
}

interface DownloadTimerRegistration {
  readonly token: DownloadCallbackToken;
  readonly listener: () => void;
  readonly finalArm: boolean;
}

interface DownloadSettlementToken {
  active: boolean;
  pulling: boolean;
  queued: SettlementEvent | undefined;
  dispatch?: (event: SettlementEvent) => void;
}

interface DownloadBridgeAuthority {
  state: unknown;
  receiver: ProjectTemplateArtifactDownloadBridgeHandlers<unknown> | undefined;
  pull:
    | ProjectTemplateArtifactDownloadBridgeHandlers<unknown>['pull']
    | undefined;
  dispose:
    | ProjectTemplateArtifactDownloadBridgeHandlers<unknown>['dispose']
    | undefined;
  disposed: boolean;
  owner: DownloadIteratorAuthority | undefined;
  generation: number;
}

interface DownloadIteratorAuthority {
  phase: 'idle' | 'active' | 'closed';
  snapshot: Readonly<GithubTemplateArchiveAssetInput> | undefined;
  readonly port: DownloadPortAuthority;
  bridge: ProjectTemplateArtifactDownloadBridge | undefined;
  bridgeGeneration: number | undefined;
  pending: PendingNext | undefined;
  timer: unknown;
  hasTimer: boolean;
  abortListener: (() => void) | undefined;
  timerRegistration: DownloadTimerRegistration | undefined;
  callbackToken: DownloadCallbackToken;
  settlementToken: DownloadSettlementToken | undefined;
  armingTimer: boolean;
  timerFiredDuringArm: boolean;
  lastNow: number;
}

const portAuthorities = new WeakMap<
GithubTemplateArchiveAssetPort,
DownloadPortAuthority
>();
const iterableAuthorities = new WeakMap<
AsyncIterable<Uint8Array>,
DownloadIterableAuthority
>();
const iteratorAuthorities = new WeakMap<
AsyncIterator<Uint8Array>,
DownloadIteratorAuthority
>();
const bridgeAuthorities = new WeakMap<
ProjectTemplateArtifactDownloadBridge,
DownloadBridgeAuthority
>();

function exactResult<T>(
  value: T,
  done: boolean,
): IteratorResult<T> {
  const result = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(result, {
    value: {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    },
    done: {
      configurable: false,
      enumerable: true,
      value: done,
      writable: false,
    },
  });
  return Object.freeze(result) as unknown as IteratorResult<T>;
}

const DONE_RESULT = exactResult<Uint8Array | undefined>(
  undefined,
  true,
) as IteratorResult<Uint8Array>;

function downloadError(
  code: ProjectTemplateArtifactDownloadErrorCode,
  message: string,
): ProjectTemplateArtifactDownloadError {
  return Object.freeze(new ProjectTemplateArtifactDownloadError(code, message));
}

function invalidArgument(): ProjectTemplateArtifactDownloadError {
  return downloadError(
    'INVALID_ARGUMENT',
    'GitHub template artifact download input is invalid',
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
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
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

export function createProjectTemplateArtifactDownloadBridge<State>(
  state: State,
  pull: ProjectTemplateArtifactDownloadBridgeHandlers<State>['pull'],
  dispose: ProjectTemplateArtifactDownloadBridgeHandlers<State>['dispose'],
): ProjectTemplateArtifactDownloadBridge {
  if (
    typeof pull !== 'function'
    || typeof dispose !== 'function'
    || types.isProxy(pull)
    || types.isProxy(dispose)
  ) {
    throw invalidArgument();
  }
  const receiver = Object.freeze({
    pull,
    dispose,
  }) as ProjectTemplateArtifactDownloadBridgeHandlers<unknown>;
  const bridge = Object.freeze(
    {},
  ) as unknown as ProjectTemplateArtifactDownloadBridge;
  bridgeAuthorities.set(bridge, {
    state,
    receiver,
    pull: pull as ProjectTemplateArtifactDownloadBridgeHandlers<unknown>['pull'],
    dispose: dispose as
      ProjectTemplateArtifactDownloadBridgeHandlers<unknown>['dispose'],
    disposed: false,
    owner: undefined,
    generation: 0,
  });
  return bridge;
}

function resolvedResult(
  result: IteratorResult<Uint8Array>,
): Promise<IteratorResult<Uint8Array>> {
  return new NativePromise((resolve) => resolve(result));
}

function rejected(
  error: ProjectTemplateArtifactDownloadError,
): Promise<IteratorResult<Uint8Array>> {
  return new NativePromise((_resolve, reject) => reject(error));
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
  return value as AbortSignal;
}

function snapshotInput(
  value: GithubTemplateArchiveAssetInput,
): Readonly<GithubTemplateArchiveAssetInput> {
  const candidateKeys = (
    typeof value === 'object'
    && value !== null
    && !types.isProxy(value)
  )
    ? Reflect.ownKeys(value)
    : [];
  const keys = candidateKeys.includes('signal')
    ? ['owner', 'repo', 'releaseId', 'assetId', 'maxBytes', 'signal']
    : ['owner', 'repo', 'releaseId', 'assetId', 'maxBytes'];
  const candidate = exactDataRecord(value, keys);
  const owner = candidate['owner'];
  const repo = candidate['repo'];
  const releaseId = candidate['releaseId'];
  const assetId = candidate['assetId'];
  const maxBytes = candidate['maxBytes'];
  if (
    !isCanonicalGithubRepositoryCoordinates(owner, repo)
    || typeof releaseId !== 'number'
    || !Number.isSafeInteger(releaseId)
    || releaseId <= 0
    || typeof assetId !== 'number'
    || !Number.isSafeInteger(assetId)
    || assetId <= 0
    || typeof maxBytes !== 'number'
    || !Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
  ) {
    throw invalidArgument();
  }
  const signal = snapshotSignal(candidate['signal']);
  return Object.freeze({
    owner: owner as string,
    repo: repo as string,
    releaseId,
    assetId,
    maxBytes,
    ...(signal === undefined ? {} : { signal }),
  });
}

function snapshotFactory(
  contextValue: ProjectTemplateArtifactDownloadContext,
  dependenciesValue: ProjectTemplateArtifactDownloadDependencies,
): DownloadPortAuthority {
  const context = exactDataRecord(contextValue, ['deadlineMs']);
  const deadlineMs = context['deadlineMs'];
  if (
    typeof deadlineMs !== 'number'
    || !Number.isFinite(deadlineMs)
    || deadlineMs < 0
  ) {
    throw invalidArgument();
  }
  const dependencies = exactDataRecord(
    dependenciesValue,
    ['now', 'setTimer', 'clearTimer', 'start'],
  );
  if (
    typeof dependencies['now'] !== 'function'
    || typeof dependencies['setTimer'] !== 'function'
    || typeof dependencies['clearTimer'] !== 'function'
    || typeof dependencies['start'] !== 'function'
  ) {
    throw invalidArgument();
  }
  return {
    deadlineMs,
    dependencies: Object.freeze({
      receiver: dependenciesValue,
      now: dependencies['now'] as ProjectTemplateArtifactDownloadDependencies[
        'now'
      ],
      setTimer: dependencies['setTimer'] as
        ProjectTemplateArtifactDownloadDependencies['setTimer'],
      clearTimer: dependencies['clearTimer'] as
        ProjectTemplateArtifactDownloadDependencies['clearTimer'],
      start: dependencies['start'] as
        ProjectTemplateArtifactDownloadDependencies['start'],
    }),
  };
}

function signalAborted(signal: AbortSignal): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    'aborted',
  );
  if (descriptor?.get === undefined) throw invalidArgument();
  return Reflect.apply(descriptor.get, signal, []) as boolean;
}

function disposeRegisteredBridge(
  bridge: ProjectTemplateArtifactDownloadBridge,
  owner: DownloadIteratorAuthority,
): void {
  const bridgeAuthority = bridgeAuthorities.get(bridge);
  if (
    bridgeAuthority === undefined
    || bridgeAuthority.disposed
    || bridgeAuthority.owner !== owner
    || owner.bridgeGeneration !== bridgeAuthority.generation
  ) return;
  bridgeAuthority.disposed = true;
  bridgeAuthority.owner = undefined;
  const state = bridgeAuthority.state;
  const receiver = bridgeAuthority.receiver;
  const dispose = bridgeAuthority.dispose;
  bridgeAuthority.state = undefined;
  bridgeAuthority.receiver = undefined;
  bridgeAuthority.pull = undefined;
  bridgeAuthority.dispose = undefined;
  if (receiver === undefined || dispose === undefined) return;
  try {
    Reflect.apply(
      dispose,
      receiver,
      [state],
    );
  } catch {
    // Cleanup causes are private bridge details.
  }
}

function disposeBridge(authority: DownloadIteratorAuthority): void {
  const bridge = authority.bridge;
  authority.bridge = undefined;
  if (bridge !== undefined) disposeRegisteredBridge(bridge, authority);
  authority.bridgeGeneration = undefined;
}

function snapshotBridge(
  value: ProjectTemplateArtifactDownloadBridge,
  authority: DownloadIteratorAuthority,
): void {
  const bridgeAuthority = (
    typeof value === 'object'
    && value !== null
    && !types.isProxy(value)
  )
    ? bridgeAuthorities.get(value)
    : undefined;
  if (bridgeAuthority === undefined || bridgeAuthority.disposed) {
    throw invalidArgument();
  }
  if (bridgeAuthority.owner !== undefined) throw invalidArgument();
  bridgeAuthority.generation += 1;
  bridgeAuthority.owner = authority;
  authority.bridge = value;
  authority.bridgeGeneration = bridgeAuthority.generation;
}

function revokeSettlement(authority: DownloadIteratorAuthority): void {
  const token = authority.settlementToken;
  authority.settlementToken = undefined;
  if (token === undefined) return;
  token.active = false;
  token.dispatch = undefined;
  token.queued = undefined;
}

function clearDeadline(authority: DownloadIteratorAuthority): void {
  const registration = authority.timerRegistration;
  authority.timerRegistration = undefined;
  if (registration !== undefined) {
    registration.token.active = false;
    registration.token.dispatch = undefined;
  }
  if (!authority.hasTimer) return;
  const timer = authority.timer;
  authority.timer = undefined;
  authority.hasTimer = false;
  try {
    Reflect.apply(
      authority.port.dependencies.clearTimer,
      authority.port.dependencies.receiver,
      [timer],
    );
  } catch {
    // The callback token was revoked before physical cleanup.
  }
}

function removeAbortListener(authority: DownloadIteratorAuthority): void {
  const listener = authority.abortListener;
  const signal = authority.snapshot?.signal;
  authority.abortListener = undefined;
  if (listener === undefined || signal === undefined) return;
  try {
    EventTarget.prototype.removeEventListener.call(signal, 'abort', listener);
  } catch {
    // The callback token was revoked before physical cleanup.
  }
}

function closeIterator(
  authority: DownloadIteratorAuthority,
  outcome:
    | { readonly kind: 'done' }
    | {
      readonly kind: 'error';
      readonly error: ProjectTemplateArtifactDownloadError;
    },
): void {
  if (authority.phase === 'closed') return;
  authority.phase = 'closed';
  const pending = authority.pending;
  authority.pending = undefined;

  // Logical authority is always revoked before caller-controlled cleanup hooks.
  authority.callbackToken.active = false;
  authority.callbackToken.dispatch = undefined;
  revokeSettlement(authority);
  removeAbortListener(authority);
  clearDeadline(authority);
  disposeBridge(authority);
  authority.snapshot = undefined;
  if (pending === undefined) return;
  if (outcome.kind === 'done') pending.resolve(DONE_RESULT);
  else pending.reject(outcome.error);
}

function bridgeFailure(authority: DownloadIteratorAuthority): void {
  closeIterator(authority, {
    kind: 'error',
    error: downloadError(
      'BRIDGE_FAILURE',
      'GitHub template artifact bridge failed',
    ),
  });
}

function readRemainingDeadline(
  authority: DownloadIteratorAuthority,
): number | undefined {
  if (authority.phase === 'closed') return undefined;
  let now: unknown;
  try {
    now = Reflect.apply(
      authority.port.dependencies.now,
      authority.port.dependencies.receiver,
      [],
    );
  } catch {
    bridgeFailure(authority);
    return undefined;
  }
  if (
    typeof now !== 'number'
    || !Number.isFinite(now)
    || now < 0
    || now < authority.lastNow
  ) {
    bridgeFailure(authority);
    return undefined;
  }
  authority.lastNow = now;
  const remaining = authority.port.deadlineMs - now;
  if (remaining <= 0) {
    closeIterator(authority, {
      kind: 'error',
      error: downloadError('TIMEOUT', 'Artifact download timed out'),
    });
    return undefined;
  }
  return remaining;
}

function armDeadline(
  authority: DownloadIteratorAuthority,
  remaining: number,
): boolean {
  if (authority.phase === 'closed') return false;
  const previous = authority.timerRegistration;
  if (previous !== undefined) {
    previous.token.active = false;
    previous.token.dispatch = undefined;
  }
  const token: DownloadCallbackToken = { active: true };
  const listener = createPhysicalCallback(token);
  const registration: DownloadTimerRegistration = {
    token,
    listener,
    finalArm: remaining <= MAX_TIMER_DELAY_MS,
  };
  token.dispatch = (): void => {
    if (
      token.active
      && authority.timerRegistration === registration
      && authority.phase !== 'closed'
    ) {
      handleTimer(authority, registration);
    }
  };
  authority.timerRegistration = registration;
  authority.armingTimer = true;
  authority.timerFiredDuringArm = false;
  let timer: unknown;
  try {
    timer = Reflect.apply(
      authority.port.dependencies.setTimer,
      authority.port.dependencies.receiver,
      [listener, Math.min(remaining, MAX_TIMER_DELAY_MS)],
    );
  } catch {
    authority.armingTimer = false;
    token.active = false;
    token.dispatch = undefined;
    if (authority.timerRegistration === registration) {
      authority.timerRegistration = undefined;
    }
    bridgeFailure(authority);
    return false;
  }
  authority.armingTimer = false;
  if (authority.timerFiredDuringArm || isClosed(authority)) {
    token.active = false;
    token.dispatch = undefined;
    if (authority.timerRegistration === registration) {
      authority.timerRegistration = undefined;
    }
    try {
      Reflect.apply(
        authority.port.dependencies.clearTimer,
        authority.port.dependencies.receiver,
        [timer],
      );
    } catch {
      // The callback token is already revoked or the sync fire is contained.
    }
    if (!isClosed(authority)) {
      if (registration.finalArm) {
        closeIterator(authority, {
          kind: 'error',
          error: downloadError('TIMEOUT', 'Artifact download timed out'),
        });
      } else {
        bridgeFailure(authority);
      }
    }
    return false;
  }
  authority.timer = timer;
  authority.hasTimer = true;
  return true;
}

function handleTimer(
  authority: DownloadIteratorAuthority,
  registration: DownloadTimerRegistration,
): void {
  if (authority.timerRegistration !== registration) return;
  if (authority.armingTimer) {
    authority.timerFiredDuringArm = true;
    return;
  }
  registration.token.active = false;
  registration.token.dispatch = undefined;
  authority.timerRegistration = undefined;
  authority.timer = undefined;
  authority.hasTimer = false;
  if (registration.finalArm) {
    closeIterator(authority, {
      kind: 'error',
      error: downloadError('TIMEOUT', 'Artifact download timed out'),
    });
    return;
  }
  const remaining = readRemainingDeadline(authority);
  if (remaining !== undefined) armDeadline(authority, remaining);
}

function createPhysicalCallback(
  token: DownloadCallbackToken,
): () => void {
  // Physical hooks retain only a revocable token, never iterator authority.
  return (): void => {
    if (token.active) token.dispatch?.();
  };
}

function isClosed(authority: DownloadIteratorAuthority): boolean {
  return authority.phase === 'closed';
}

function snapshotChunk(value: unknown): Uint8Array {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || !types.isUint8Array(value)
    || Object.getPrototypeOf(value) !== NATIVE_UINT8_ARRAY_PROTOTYPE
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
    || TYPED_ARRAY_BUFFER_GETTER === undefined
  ) {
    throw new Error();
  }
  let byteLength: number;
  let buffer: unknown;
  try {
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
    buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
  } catch {
    throw new Error();
  }
  if (byteLength === 0 || types.isSharedArrayBuffer(buffer)) throw new Error();
  const copy = new NativeUint8Array(byteLength);
  Reflect.apply(TYPED_ARRAY_SET, copy, [value]);
  return copy;
}

function ownsLiveBridge(authority: DownloadIteratorAuthority): boolean {
  const bridge = authority.bridge;
  if (bridge === undefined || authority.bridgeGeneration === undefined) {
    return false;
  }
  const bridgeAuthority = bridgeAuthorities.get(bridge);
  return (
    bridgeAuthority !== undefined
    && !bridgeAuthority.disposed
    && bridgeAuthority.owner === authority
    && bridgeAuthority.generation === authority.bridgeGeneration
  );
}

function processSettlement(
  authority: DownloadIteratorAuthority,
  pending: PendingNext,
  event: SettlementEvent,
): void {
  if (
    authority.phase === 'closed'
    || authority.pending !== pending
    || !ownsLiveBridge(authority)
  ) return;
  authority.settlementToken = undefined;
  if (event.kind === 'done') {
    closeIterator(authority, { kind: 'done' });
    return;
  }
  if (event.kind === 'fail') {
    bridgeFailure(authority);
    return;
  }
  authority.pending = undefined;
  pending.resolve(exactResult(event.value, false));
}

function createSettlement(
  authority: DownloadIteratorAuthority,
  pending: PendingNext,
): ProjectTemplateArtifactDownloadSettlement {
  const token: DownloadSettlementToken = {
    active: true,
    pulling: true,
    queued: undefined,
  };
  token.dispatch = (event): void => {
    if (!token.active) return;
    token.active = false;
    token.dispatch = undefined;
    if (token.pulling) {
      token.queued = event;
      return;
    }
    processSettlement(authority, pending, event);
  };
  const chunk = Object.freeze((value: unknown): undefined => {
    if (!token.active) return undefined;
    try {
      token.dispatch?.({ kind: 'chunk', value: snapshotChunk(value) });
    } catch {
      token.dispatch?.({ kind: 'fail' });
    }
    return undefined;
  });
  const done = Object.freeze((): undefined => {
    token.dispatch?.({ kind: 'done' });
    return undefined;
  });
  const fail = Object.freeze((): undefined => {
    token.dispatch?.({ kind: 'fail' });
    return undefined;
  });
  const settlement = Object.freeze<ProjectTemplateArtifactDownloadSettlement>({
    chunk,
    done,
    fail,
  });
  authority.settlementToken = token;
  return settlement;
}

function pullBridge(
  authority: DownloadIteratorAuthority,
  pending: PendingNext,
): void {
  const bridge = authority.bridge;
  const bridgeAuthority = bridge === undefined
    ? undefined
    : bridgeAuthorities.get(bridge);
  if (
    bridgeAuthority === undefined
    || bridgeAuthority.disposed
    || bridgeAuthority.owner !== authority
    || bridgeAuthority.generation !== authority.bridgeGeneration
    || bridgeAuthority.receiver === undefined
    || bridgeAuthority.pull === undefined
  ) {
    bridgeFailure(authority);
    return;
  }
  const settlement = createSettlement(authority, pending);
  const token = authority.settlementToken;
  if (token === undefined) {
    bridgeFailure(authority);
    return;
  }
  let returned: unknown;
  try {
    returned = Reflect.apply(
      bridgeAuthority.pull,
      bridgeAuthority.receiver,
      [bridgeAuthority.state, settlement],
    );
  } catch {
    token.pulling = false;
    bridgeFailure(authority);
    return;
  }
  token.pulling = false;
  if (returned !== undefined) {
    bridgeFailure(authority);
    return;
  }
  const queued = token.queued;
  token.queued = undefined;
  if (queued !== undefined) processSettlement(authority, pending, queued);
}

function createIterator(
  iterableAuthority: DownloadIterableAuthority,
): AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array> {
  const callbackToken: DownloadCallbackToken = { active: true };
  const authority: DownloadIteratorAuthority = {
    phase: 'idle',
    snapshot: iterableAuthority.snapshot,
    port: iterableAuthority.port,
    bridge: undefined,
    bridgeGeneration: undefined,
    pending: undefined,
    timer: undefined,
    hasTimer: false,
    abortListener: undefined,
    timerRegistration: undefined,
    callbackToken,
    settlementToken: undefined,
    armingTimer: false,
    timerFiredDuringArm: false,
    lastNow: -1,
  };
  callbackToken.dispatch = (): void => {
    if (!callbackToken.active || authority.phase === 'closed') return;
    closeIterator(authority, {
      kind: 'error',
      error: downloadError('ABORTED', 'Artifact download was aborted'),
    });
  };
  iterableAuthority.snapshot = undefined;

  const iterator = Object.freeze<
  AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array>
  >({
    next(this: AsyncIterator<Uint8Array>): Promise<IteratorResult<Uint8Array>> {
      const current = iteratorAuthorities.get(this);
      if (current === undefined || types.isProxy(this)) {
        return rejected(invalidArgument());
      }
      if (current.phase === 'closed') return resolvedResult(DONE_RESULT);
      if (current.pending !== undefined) {
        const error = downloadError(
          'CONCURRENT_NEXT',
          'Concurrent GitHub template artifact reads are not allowed',
        );
        closeIterator(current, { kind: 'error', error });
        return rejected(error);
      }
      let resolvePending!: (result: IteratorResult<Uint8Array>) => void;
      let rejectPending!: (
        error: ProjectTemplateArtifactDownloadError,
      ) => void;
      const pendingPromise = new NativePromise<IteratorResult<Uint8Array>>(
        (resolve, reject) => {
          resolvePending = resolve;
          rejectPending = reject;
        },
      );
      const pending: PendingNext = {
        resolve: resolvePending,
        reject: rejectPending,
      };
      current.pending = pending;
      const snapshot = current.snapshot;
      if (snapshot === undefined) {
        closeIterator(current, {
          kind: 'error',
          error: downloadError('CLOSED', 'Artifact iterator is closed'),
        });
        return pendingPromise;
      }

      try {
        if (snapshot.signal !== undefined && signalAborted(snapshot.signal)) {
          closeIterator(current, {
            kind: 'error',
            error: downloadError('ABORTED', 'Artifact download was aborted'),
          });
          return pendingPromise;
        }
        let remaining = readRemainingDeadline(current);
        if (remaining === undefined || current.pending !== pending) {
          return pendingPromise;
        }
        if (current.phase === 'idle') {
          if (snapshot.signal !== undefined) {
            const abortListener = createPhysicalCallback(
              current.callbackToken,
            );
            current.abortListener = abortListener;
            EventTarget.prototype.addEventListener.call(
              snapshot.signal,
              'abort',
              abortListener,
              { once: true },
            );
            if (signalAborted(snapshot.signal)) {
              current.callbackToken.dispatch?.();
              return pendingPromise;
            }
            if (current.pending !== pending) {
              // A reentrant close may have removed before the hostile add hook
              // performed its native registration, so retry physical cleanup.
              try {
                EventTarget.prototype.removeEventListener.call(
                  snapshot.signal,
                  'abort',
                  abortListener,
                );
              } catch {
                // Logical token revocation remains authoritative.
              }
              return pendingPromise;
            }
          }
          // Listener installation is external and can consume time.
          remaining = readRemainingDeadline(current);
          if (remaining === undefined || current.pending !== pending) {
            return pendingPromise;
          }
          const bridge = Reflect.apply(
            current.port.dependencies.start,
            current.port.dependencies.receiver,
            [snapshot],
          );
          snapshotBridge(bridge, current);
          if (current.pending !== pending) {
            disposeBridge(current);
            return pendingPromise;
          }

          // Start is also external; an expired bridge is disposed before pull.
          remaining = readRemainingDeadline(current);
          if (remaining === undefined || current.pending !== pending) {
            disposeBridge(current);
            return pendingPromise;
          }
          if (!armDeadline(current, remaining)) {
            disposeBridge(current);
            return pendingPromise;
          }
          current.phase = 'active';
        }
        pullBridge(current, pending);
      } catch {
        bridgeFailure(current);
      }
      return pendingPromise;
    },
    return(
      this: AsyncIterator<Uint8Array>,
    ): Promise<IteratorResult<Uint8Array>> {
      const current = iteratorAuthorities.get(this);
      if (current === undefined || types.isProxy(this)) {
        return rejected(invalidArgument());
      }
      closeIterator(current, { kind: 'done' });
      return resolvedResult(DONE_RESULT);
    },
    throw(
      this: AsyncIterator<Uint8Array>,
      _cause?: unknown,
    ): Promise<IteratorResult<Uint8Array>> {
      const current = iteratorAuthorities.get(this);
      if (current === undefined || types.isProxy(this)) {
        return rejected(invalidArgument());
      }
      const error = downloadError('CLOSED', 'Artifact iterator is closed');
      closeIterator(current, { kind: 'error', error });
      return rejected(error);
    },
    [Symbol.asyncIterator](
      this: AsyncIterator<Uint8Array>,
    ): AsyncIterator<Uint8Array> {
      if (!iteratorAuthorities.has(this) || types.isProxy(this)) {
        throw invalidArgument();
      }
      return this;
    },
  });
  iteratorAuthorities.set(iterator, authority);
  return iterator;
}

/**
 * Creates the internal cold archive port skeleton.
 *
 * `openReleaseAsset` only validates and snapshots. Authentication, HTTP, DNS,
 * timers, signal listeners, and the bridge all remain untouched until demand.
 */
export function createProjectTemplateArtifactDownloadPort(
  context: ProjectTemplateArtifactDownloadContext,
  dependencies: ProjectTemplateArtifactDownloadDependencies,
): GithubTemplateArchiveAssetPort {
  const authority = snapshotFactory(context, dependencies);
  const port = Object.freeze<GithubTemplateArchiveAssetPort>({
    openReleaseAsset(
      this: GithubTemplateArchiveAssetPort,
      input: GithubTemplateArchiveAssetInput,
    ): AsyncIterable<Uint8Array> {
      const current = portAuthorities.get(this);
      if (current === undefined || types.isProxy(this)) throw invalidArgument();
      const iterableAuthority: DownloadIterableAuthority = {
        used: false,
        snapshot: snapshotInput(input),
        port: current,
      };
      const iterable = Object.freeze<AsyncIterable<Uint8Array>>({
        [Symbol.asyncIterator](
          this: AsyncIterable<Uint8Array>,
        ): AsyncIterator<Uint8Array> {
          const owned = iterableAuthorities.get(this);
          if (owned === undefined || types.isProxy(this)) {
            throw invalidArgument();
          }
          if (owned.used) {
            throw downloadError(
              'ITERATOR_USED',
              'Artifact iterable can only be consumed once',
            );
          }
          owned.used = true;
          return createIterator(owned);
        },
      });
      iterableAuthorities.set(iterable, iterableAuthority);
      return iterable;
    },
  });
  portAuthorities.set(port, authority);
  return port;
}
