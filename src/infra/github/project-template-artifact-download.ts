import { types } from 'node:util';
import type {
  GithubTemplateArchiveAssetInput,
  GithubTemplateArchiveAssetPort,
} from '../../features/project-template/github-download-orchestrator.js';

const GITHUB_OWNER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength',
)?.get;

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
  /**
   * Absolute deadline in the monotonic time domain supplied by `now`.
   * Binding it at factory creation prevents retries from resetting the budget.
   */
  readonly deadlineMs: number;
}

export interface ProjectTemplateArtifactDownloadBridge {
  next(): Promise<IteratorResult<Uint8Array>>;
  /**
   * Must revoke synchronously and return exactly `undefined`.
   * Implementations own containment of any asynchronous cleanup internally.
   */
  dispose(): undefined;
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

interface DownloadIteratorAuthority {
  phase: 'idle' | 'active' | 'closed';
  snapshot: Readonly<GithubTemplateArchiveAssetInput> | undefined;
  readonly port: DownloadPortAuthority;
  bridge: ProjectTemplateArtifactDownloadBridge | undefined;
  bridgeReceiver: ProjectTemplateArtifactDownloadBridge | undefined;
  bridgeNext: ProjectTemplateArtifactDownloadBridge['next'] | undefined;
  bridgeDispose: ProjectTemplateArtifactDownloadBridge['dispose'] | undefined;
  pending: PendingNext | undefined;
  timer: unknown;
  hasTimer: boolean;
  abortListener: (() => void) | undefined;
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

const DONE_RESULT = Object.freeze<IteratorResult<Uint8Array>>({
  value: undefined,
  done: true,
});

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
    typeof owner !== 'string'
    || !GITHUB_OWNER_PATTERN.test(owner)
    || typeof repo !== 'string'
    || !GITHUB_REPOSITORY_PATTERN.test(repo)
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
    owner,
    repo,
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

function containReturnedPromiseRejection(value: unknown): void {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Reflect.ownKeys(value).length !== 0
  ) {
    return;
  }
  try {
    // The intrinsic rejects ordinary thenables before property lookup, while
    // safely attaching to native Promise subclasses and cross-realm Promises.
    // A proxy or own-property-modified Promise cannot be assimilated without
    // executing caller code; bridge implementations must contain those before
    // returning them across this internal seam.
    Promise.prototype.then.call(value, undefined, () => undefined);
  } catch {
    // Non-Promise objects and hostile species are outside the bridge contract.
  }
}

function disposeBridge(authority: DownloadIteratorAuthority): void {
  const receiver = authority.bridgeReceiver;
  const dispose = authority.bridgeDispose;
  authority.bridge = undefined;
  authority.bridgeReceiver = undefined;
  authority.bridgeNext = undefined;
  authority.bridgeDispose = undefined;
  if (receiver === undefined || dispose === undefined) return;
  try {
    // Teardown authority is revoked before this synchronous bridge contract.
    const result = Reflect.apply(dispose, receiver, []);
    // This is resilience for a contract-violating internal bridge, not
    // permission to return asynchronous cleanup from `dispose`.
    containReturnedPromiseRejection(result);
  } catch {
    // Cleanup causes are private bridge details.
  }
}

function clearDeadline(authority: DownloadIteratorAuthority): void {
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
    // Token revocation remains authoritative when timer cleanup is hostile.
  }
}

function removeAbortListener(authority: DownloadIteratorAuthority): void {
  const listener = authority.abortListener;
  const signal = authority.snapshot?.signal;
  authority.abortListener = undefined;
  if (listener === undefined || signal === undefined) return;
  try {
    EventTarget.prototype.removeEventListener.call(
      signal,
      'abort',
      listener,
    );
  } catch {
    // The listener only captures a cleared authority after revocation.
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
  removeAbortListener(authority);
  clearDeadline(authority);
  disposeBridge(authority);
  authority.snapshot = undefined;
  if (pending === undefined) return;
  if (outcome.kind === 'done') pending.resolve(DONE_RESULT);
  else pending.reject(outcome.error);
}

function snapshotBridge(
  value: ProjectTemplateArtifactDownloadBridge,
  authority: DownloadIteratorAuthority,
): void {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidArgument();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const disposeDescriptor = descriptors['dispose'];
  // Retain a safely snapshotted cleanup capability before validating the
  // remaining bridge shape. A malformed bridge returned by `start` may
  // already own resources and must still be disposed fail-closed.
  if (
    disposeDescriptor !== undefined
    && 'value' in disposeDescriptor
    && typeof disposeDescriptor.value === 'function'
  ) {
    authority.bridgeReceiver = value;
    authority.bridgeDispose = disposeDescriptor.value as
      ProjectTemplateArtifactDownloadBridge['dispose'];
  }
  const keys = Reflect.ownKeys(value);
  const nextDescriptor = descriptors['next'];
  if (
    keys.length !== 2
    || !keys.includes('next')
    || !keys.includes('dispose')
    || nextDescriptor === undefined
    || !('value' in nextDescriptor)
    || typeof nextDescriptor.value !== 'function'
    || authority.bridgeDispose === undefined
  ) {
    throw invalidArgument();
  }
  authority.bridge = value;
  authority.bridgeNext =
    nextDescriptor.value as ProjectTemplateArtifactDownloadBridge['next'];
}

function snapshotBridgeResult(value: unknown): IteratorResult<Uint8Array> {
  let candidate: Record<string, unknown>;
  try {
    candidate = exactDataRecord(value, ['value', 'done']);
  } catch {
    throw downloadError(
      'BRIDGE_FAILURE',
      'GitHub template artifact bridge returned an invalid result',
    );
  }
  if (candidate['done'] === true && candidate['value'] === undefined) {
    return DONE_RESULT;
  }
  const chunk = candidate['value'];
  if (
    candidate['done'] !== false
    || typeof chunk !== 'object'
    || chunk === null
    || types.isProxy(chunk)
    || !(chunk instanceof Uint8Array)
    || Object.getPrototypeOf(chunk) !== Uint8Array.prototype
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) {
    throw downloadError(
      'BRIDGE_FAILURE',
      'GitHub template artifact bridge returned an invalid result',
    );
  }
  let byteLength: number;
  try {
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, chunk, []);
  } catch {
    throw downloadError(
      'BRIDGE_FAILURE',
      'GitHub template artifact bridge returned an invalid result',
    );
  }
  if (byteLength === 0) {
    throw downloadError(
      'BRIDGE_FAILURE',
      'GitHub template artifact bridge returned an invalid result',
    );
  }
  return Object.freeze({
    value: new Uint8Array(chunk),
    done: false,
  });
}

function rejected(
  error: ProjectTemplateArtifactDownloadError,
): Promise<IteratorResult<Uint8Array>> {
  return Promise.reject(error);
}

function createIterator(
  iterableAuthority: DownloadIterableAuthority,
): AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array> {
  const authority: DownloadIteratorAuthority = {
    phase: 'idle',
    snapshot: iterableAuthority.snapshot,
    port: iterableAuthority.port,
    bridge: undefined,
    bridgeReceiver: undefined,
    bridgeNext: undefined,
    bridgeDispose: undefined,
    pending: undefined,
    timer: undefined,
    hasTimer: false,
    abortListener: undefined,
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
      if (current.phase === 'closed') return Promise.resolve(DONE_RESULT);
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
      const pendingPromise = new Promise<IteratorResult<Uint8Array>>(
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
        const now = Reflect.apply(
          current.port.dependencies.now,
          current.port.dependencies.receiver,
          [],
        );
        if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
          throw new Error();
        }
        if (current.pending !== pending) {
          return pendingPromise;
        }
        const remainingMs = current.port.deadlineMs - now;
        if (remainingMs <= 0) {
          closeIterator(current, {
            kind: 'error',
            error: downloadError('TIMEOUT', 'Artifact download timed out'),
          });
          return pendingPromise;
        }
        if (current.phase === 'idle') {
          if (snapshot.signal !== undefined) {
            const abortListener = (): void => {
              closeIterator(current, {
                kind: 'error',
                error: downloadError(
                  'ABORTED',
                  'Artifact download was aborted',
                ),
              });
            };
            current.abortListener = abortListener;
            EventTarget.prototype.addEventListener.call(
              snapshot.signal,
              'abort',
              abortListener,
              { once: true },
            );
            if (signalAborted(snapshot.signal)) {
              abortListener();
              return pendingPromise;
            }
            if (current.pending !== pending) {
              try {
                EventTarget.prototype.removeEventListener.call(
                  snapshot.signal,
                  'abort',
                  abortListener,
                );
              } catch {
                // The listener only captures the already revoked authority.
              }
              return pendingPromise;
            }
          }
          const timeout = (): void => {
            closeIterator(current, {
              kind: 'error',
              error: downloadError('TIMEOUT', 'Artifact download timed out'),
            });
          };
          const timer = Reflect.apply(
            current.port.dependencies.setTimer,
            current.port.dependencies.receiver,
            [timeout, remainingMs],
          );
          if (current.pending !== pending) {
            try {
              Reflect.apply(
                current.port.dependencies.clearTimer,
                current.port.dependencies.receiver,
                [timer],
              );
            } catch {
              // The token was revoked before the timer handle was returned.
            }
            return pendingPromise;
          }
          current.timer = timer;
          current.hasTimer = true;
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
          current.phase = 'active';
        }
        const receiver = current.bridgeReceiver;
        const bridgeNext = current.bridgeNext;
        if (receiver === undefined || bridgeNext === undefined) {
          throw new Error();
        }
        let bridgePending: Promise<IteratorResult<Uint8Array>>;
        try {
          bridgePending = Reflect.apply(bridgeNext, receiver, []);
        } catch {
          throw new Error();
        }
        if (
          typeof bridgePending !== 'object'
          || bridgePending === null
          || types.isProxy(bridgePending)
          || Object.getPrototypeOf(bridgePending) !== Promise.prototype
          || Reflect.ownKeys(bridgePending).length !== 0
        ) {
          containReturnedPromiseRejection(bridgePending);
          throw new Error();
        }
        // Call the intrinsic directly after exact native-Promise validation;
        // no caller-controlled thenable lookup crosses this boundary.
        Promise.prototype.then.call(
          bridgePending,
          (value) => {
            if (
              current.phase === 'closed'
              || current.pending !== pending
            ) {
              return;
            }
            let result: IteratorResult<Uint8Array>;
            try {
              result = snapshotBridgeResult(value);
            } catch {
              closeIterator(current, {
                kind: 'error',
                error: downloadError(
                  'BRIDGE_FAILURE',
                  'GitHub template artifact bridge failed',
                ),
              });
              return;
            }
            if (result.done === true) {
              closeIterator(current, { kind: 'done' });
              return;
            }
            current.pending = undefined;
            pending.resolve(result);
          },
          () => {
            if (
              current.phase !== 'closed'
              && current.pending === pending
            ) {
              closeIterator(current, {
                kind: 'error',
                error: downloadError(
                  'BRIDGE_FAILURE',
                  'GitHub template artifact bridge failed',
                ),
              });
            }
          },
        );
      } catch {
        closeIterator(current, {
          kind: 'error',
          error: downloadError(
            'BRIDGE_FAILURE',
            'GitHub template artifact bridge failed',
          ),
        });
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
      return Promise.resolve(DONE_RESULT);
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
 * timers, signal listeners, and the bridge all remain untouched until the
 * consumer proves demand with its first `next()`.
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
