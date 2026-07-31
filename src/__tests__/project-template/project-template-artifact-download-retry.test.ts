import { AsyncLocalStorage } from 'node:async_hooks';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type {
  GithubTemplateArchiveAssetInput,
} from '../../features/project-template/github-download-orchestrator.js';
import {
  createProjectTemplateArtifactDownloadPort,
  type ProjectTemplateArtifactDownloadError,
} from '../../infra/github/project-template-artifact-download.js';
import type {
  ProjectTemplateArtifactSingleAttempt,
  ProjectTemplateArtifactSingleAttemptFailure,
  ProjectTemplateArtifactSingleAttemptSettlement,
} from '../../infra/github/project-template-artifact-download-attempt.js';
import {
  MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES,
} from '../../infra/github/project-template-artifact-download-contract.js';
import {
  createProjectTemplateArtifactRetryBridge,
  type ProjectTemplateArtifactRetryDependencies,
} from '../../infra/github/project-template-artifact-download-retry.js';
import type {
  DisposableProjectTemplateGhCredential,
} from '../../infra/github/project-template-gh-auth.js';

const INPUT = Object.freeze({
  owner: 'octo',
  repo: 'demo',
  releaseId: 1,
  assetId: 2,
  maxBytes: MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES * 2,
} satisfies GithubTemplateArchiveAssetInput);
const ATTEMPT_TIMER_DELAY_MS = 119_999;
const FIRST_RETRY_TIMER_DELAY_MS = 249;
const SECOND_RETRY_TIMER_DELAY_MS = 999;

interface AttemptControl {
  readonly attempt: ProjectTemplateArtifactSingleAttempt;
  readonly dispose: ReturnType<typeof vi.fn>;
  settlement?: ProjectTemplateArtifactSingleAttemptSettlement;
}

interface CredentialControl {
  readonly credential: DisposableProjectTemplateGhCredential;
  readonly dispose: ReturnType<typeof vi.fn>;
}

interface TimerControl {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
}

function exactFailure(
  code: 'NETWORK' | 'INTERNAL' = 'NETWORK',
): ProjectTemplateArtifactSingleAttemptFailure {
  return Object.freeze(Object.assign(Object.create(null) as object, {
    code,
    retryable: code === 'NETWORK',
    replaySafe: code === 'NETWORK',
  })) as ProjectTemplateArtifactSingleAttemptFailure;
}

function controlledAttempt(): AttemptControl {
  const control = {} as AttemptControl;
  const dispose = vi.fn(() => undefined);
  const pull = vi.fn((
    settlement: ProjectTemplateArtifactSingleAttemptSettlement,
  ) => {
    control.settlement = settlement;
    return undefined;
  });
  Object.assign(control, {
    attempt: Object.freeze({ pull, dispose }) as unknown as
      ProjectTemplateArtifactSingleAttempt,
    dispose,
  });
  return control;
}

function controlledCredential(): CredentialControl {
  const dispose = vi.fn(() => undefined);
  return {
    credential: Object.freeze({ dispose }),
    dispose,
  };
}

function harness(
  deadlineMs = 1_000_000,
  options: {
    readonly signal?: AbortSignal;
    readonly unmockedAcquire?: boolean;
    readonly acquireCredential?: (
      credentials: CredentialControl[],
    ) => Promise<DisposableProjectTemplateGhCredential>;
    readonly createAttempt?: (
      attempts: AttemptControl[],
    ) => ProjectTemplateArtifactSingleAttempt;
    readonly setTimer?: (
      callback: () => void,
      delayMs: number,
      timers: TimerControl[],
    ) => unknown;
    readonly clearTimer?: (
      handle: unknown,
      timers: TimerControl[],
    ) => unknown;
    readonly now?: () => number;
  } = {},
): {
  readonly iterator: AsyncIterator<Uint8Array>;
  readonly acquireCredential: ReturnType<typeof vi.fn>;
  readonly createAttempt: ReturnType<typeof vi.fn>;
  readonly attempts: AttemptControl[];
  readonly credentials: CredentialControl[];
  readonly timers: TimerControl[];
  setNow(value: number): void;
} {
  let now = 100;
  const timers: TimerControl[] = [];
  const credentials: CredentialControl[] = [];
  const attempts: AttemptControl[] = [];
  const acquireImplementation = () => {
    if (options.acquireCredential !== undefined) {
      return options.acquireCredential(credentials);
    }
    const control = controlledCredential();
    credentials.push(control);
    return Promise.resolve(control.credential);
  };
  // Vitest observes returned Promises via `then`, so hostile Promise tests use
  // a plain function to ensure only the production boundary can inspect it.
  const acquireCredential = (
    options.unmockedAcquire === true
      ? acquireImplementation
      : vi.fn(acquireImplementation)
  ) as ReturnType<typeof vi.fn>;
  const createAttempt = vi.fn(() => {
    if (options.createAttempt !== undefined) {
      return options.createAttempt(attempts);
    }
    const control = controlledAttempt();
    attempts.push(control);
    return control.attempt;
  });
  const setTimer = vi.fn((callback: () => void, delayMs: number) => {
    if (options.setTimer !== undefined) {
      return options.setTimer(callback, delayMs, timers);
    }
    const timer = { callback, delayMs, cleared: false };
    timers.push(timer);
    return timer;
  });
  const clearTimer = vi.fn((handle: unknown) => {
    if (options.clearTimer !== undefined) {
      return options.clearTimer(handle, timers);
    }
    (handle as TimerControl).cleared = true;
    return undefined;
  });
  const dependencies = Object.freeze({
    now: vi.fn(() => options.now?.() ?? now),
    setTimer,
    clearTimer,
    acquireCredential,
    createAttempt,
  }) satisfies ProjectTemplateArtifactRetryDependencies;
  const input = Object.freeze({
    ...INPUT,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const bridge = createProjectTemplateArtifactRetryBridge(
    input,
    Object.freeze({ deadlineMs }),
    dependencies,
  );
  const iterator = createProjectTemplateArtifactDownloadPort(
    Object.freeze({ deadlineMs }),
    Object.freeze({
      now: dependencies.now,
      setTimer,
      clearTimer,
      start: vi.fn(() => bridge),
    }),
  ).openReleaseAsset(input)[Symbol.asyncIterator]();
  return {
    iterator,
    acquireCredential,
    createAttempt,
    attempts,
    credentials,
    timers,
    setNow(value: number) {
      now = value;
    },
  };
}

async function expectCode(
  pending: PromiseLike<unknown>,
  code: ProjectTemplateArtifactDownloadError['code'],
): Promise<void> {
  await expect(pending).rejects.toEqual(expect.objectContaining({ code }));
}

describe('project-template artifact download D4 retry bridge', () => {
  it('is fully cold and starts a fresh credential and attempt on first demand', async () => {
    const value = harness();
    expect(value.acquireCredential).not.toHaveBeenCalled();
    expect(value.createAttempt).not.toHaveBeenCalled();

    const pending = value.iterator.next();
    expect(value.acquireCredential).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(value.createAttempt).toHaveBeenCalledTimes(1);

    value.attempts[0]!.settlement!.chunk(Uint8Array.from([7]));
    await expect(pending).resolves.toEqual({
      value: Uint8Array.from([7]),
      done: false,
    });
  });

  it('retries the same pending pull after 250ms and 1000ms, at most three times', async () => {
    const value = harness();
    const pending = value.iterator.next();
    await Promise.resolve();

    value.attempts[0]!.settlement!.fail(exactFailure());
    expect(value.attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
    const firstBackoff = value.timers.find((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS);
    expect(firstBackoff).toBeDefined();
    expect(value.acquireCredential).toHaveBeenCalledTimes(1);

    value.setNow(350);
    firstBackoff!.callback();
    await Promise.resolve();
    expect(value.acquireCredential).toHaveBeenCalledTimes(2);
    value.attempts[1]!.settlement!.fail(exactFailure());
    expect(value.attempts[1]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[1]!.dispose).toHaveBeenCalledTimes(1);
    const secondBackoff = value.timers.find((timer) => timer.delayMs === SECOND_RETRY_TIMER_DELAY_MS);
    expect(secondBackoff).toBeDefined();

    value.setNow(1_350);
    secondBackoff!.callback();
    await Promise.resolve();
    value.attempts[2]!.settlement!.fail(exactFailure());
    await expectCode(pending, 'BRIDGE_FAILURE');
    expect(value.acquireCredential).toHaveBeenCalledTimes(3);
    expect(value.createAttempt).toHaveBeenCalledTimes(3);
  });

  it('does not retry terminal failures', async () => {
    const value = harness();
    const pending = value.iterator.next();
    await Promise.resolve();
    value.attempts[0]!.settlement!.fail(exactFailure('INTERNAL'));

    await expectCode(pending, 'BRIDGE_FAILURE');
    expect(value.acquireCredential).toHaveBeenCalledTimes(1);
    expect(value.timers.some((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS)).toBe(false);
  });

  it('cleans up delay, attempt, and credential exactly once on return', async () => {
    const duringBackoff = harness();
    const backoffPending = duringBackoff.iterator.next();
    await Promise.resolve();
    duringBackoff.attempts[0]!.settlement!.fail(exactFailure());
    const backoff = duringBackoff.timers.find(
      (timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS,
    )!;
    await duringBackoff.iterator.return!();
    await expect(backoffPending).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(backoff.cleared).toBe(true);
    backoff.callback();
    expect(duringBackoff.acquireCredential).toHaveBeenCalledTimes(1);

    const active = harness();
    const activePending = active.iterator.next();
    await Promise.resolve();
    await active.iterator.return!();
    await expect(activePending).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(active.attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(active.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
    await active.iterator.return!();
    expect(active.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not arm a D4 timer when the shared deadline is shorter than 120s', () => {
    const value = harness(10_000);
    void value.iterator.next();
    expect(value.timers).toHaveLength(1);
    expect(value.timers[0]!.delayMs).toBeLessThanOrEqual(9_900);
    expect(value.timers.some((timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS)).toBe(false);
  });

  it('retries an attempt timeout before delivery without resetting its timer', async () => {
    const value = harness();
    void value.iterator.next();
    await Promise.resolve();
    const attemptTimer = value.timers.find(
      (timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS,
    )!;
    expect(attemptTimer).toBeDefined();

    value.setNow(120_100);
    attemptTimer.callback();
    expect(value.attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.timers.some((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS)).toBe(true);
  });

  it('keeps a post-delivery timeout marker until the next pull and never retries', async () => {
    const value = harness();
    const first = value.iterator.next();
    await Promise.resolve();
    const attemptTimer = value.timers.find(
      (timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS,
    )!;
    value.attempts[0]!.settlement!.chunk(Uint8Array.from([1]));
    await expect(first).resolves.toEqual({
      value: Uint8Array.from([1]),
      done: false,
    });

    value.setNow(120_100);
    attemptTimer.callback();
    expect(value.attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.timers.filter((timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS))
      .toHaveLength(1);
    const terminal = value.iterator.next();
    await expectCode(terminal, 'BRIDGE_FAILURE');
    expect(value.acquireCredential).toHaveBeenCalledTimes(1);
  });

  it('re-arms an early attempt timer without committing timeout', async () => {
    const value = harness();
    void value.iterator.next();
    await Promise.resolve();
    const firstTimer = value.timers.find(
      (timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS,
    )!;

    firstTimer.callback();
    expect(value.acquireCredential).toHaveBeenCalledTimes(1);
    expect(value.attempts[0]!.dispose).not.toHaveBeenCalled();
    const attemptTimers = value.timers.filter(
      (timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS,
    );
    expect(attemptTimers).toHaveLength(2);

    value.setNow(120_100);
    attemptTimers[1]!.callback();
    expect(value.attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.timers.some((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS)).toBe(true);
  });

  it('commits due timeout when a re-arm setup consumes the remaining budget', async () => {
    let now = 100;
    let attemptArms = 0;
    const value = harness(1_000_000, {
      now: () => now,
      setTimer: (callback, delayMs, timers) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        if (delayMs === ATTEMPT_TIMER_DELAY_MS) {
          attemptArms += 1;
          if (attemptArms === 2) now = 120_101;
        }
        return timer;
      },
    });
    void value.iterator.next();
    await Promise.resolve();
    value.timers.find(
      (timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS,
    )!.callback();

    expect(value.attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.timers.some(
      (timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS,
    )).toBe(true);
  });

  it('transactionally shortens a timer when setup partially consumes budget', () => {
    let now = 100;
    let attemptArms = 0;
    const value = harness(1_000_000, {
      now: () => now,
      setTimer: (callback, delayMs, timers) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        if (delayMs === ATTEMPT_TIMER_DELAY_MS) {
          attemptArms += 1;
          if (attemptArms === 1) now = 102;
        }
        return timer;
      },
    });
    void value.iterator.next();

    const attemptTimers = value.timers.filter(
      (timer) => timer.delayMs <= ATTEMPT_TIMER_DELAY_MS,
    );
    expect(attemptTimers).toHaveLength(2);
    expect(attemptTimers[0]!.cleared).toBe(true);
    expect(attemptTimers[1]!.delayMs).toBe(119_997);
  });

  it('commits due effect when partial-arm clear consumes the remainder', async () => {
    let now = 100;
    const value = harness(1_000_000, {
      now: () => now,
      setTimer: (callback, delayMs, timers) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        if (delayMs === ATTEMPT_TIMER_DELAY_MS) now = 102;
        return timer;
      },
      clearTimer: (handle) => {
        const timer = handle as TimerControl;
        timer.cleared = true;
        if (timer.delayMs === ATTEMPT_TIMER_DELAY_MS) now = 120_100;
        return undefined;
      },
    });
    void value.iterator.next();
    await Promise.resolve();

    expect(value.timers.filter(
      (timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS,
    )).toHaveLength(1);
    expect(value.acquireCredential).not.toHaveBeenCalled();
    expect(value.createAttempt).not.toHaveBeenCalled();
    expect(value.timers.some(
      (timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS,
    )).toBe(true);
  });

  it('defers when partial-arm clear consumes the shared deadline', async () => {
    let now = 100;
    const value = harness(200_000, {
      now: () => now,
      setTimer: (callback, delayMs, timers) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        if (delayMs === ATTEMPT_TIMER_DELAY_MS) now = 102;
        return timer;
      },
      clearTimer: (handle) => {
        const timer = handle as TimerControl;
        timer.cleared = true;
        if (timer.delayMs === ATTEMPT_TIMER_DELAY_MS) now = 200_000;
        return undefined;
      },
    });
    const pending = value.iterator.next();
    const sharedTimer = value.timers.find(
      (timer) => timer.delayMs > ATTEMPT_TIMER_DELAY_MS,
    )!;

    expect(value.timers.filter(
      (timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS,
    )).toHaveLength(1);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    sharedTimer.callback();
    await expectCode(pending, 'TIMEOUT');
  });

  it('defers when re-arm setup consumes the shared deadline', async () => {
    let now = 100;
    let attemptArms = 0;
    const value = harness(200_000, {
      now: () => now,
      setTimer: (callback, delayMs, timers) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        if (delayMs === ATTEMPT_TIMER_DELAY_MS) {
          attemptArms += 1;
          if (attemptArms === 2) now = 200_000;
        }
        return timer;
      },
    });
    const pending = value.iterator.next();
    await Promise.resolve();
    const sharedTimer = value.timers.find(
      (timer) => timer.delayMs > ATTEMPT_TIMER_DELAY_MS,
    )!;
    value.timers.find(
      (timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS,
    )!.callback();

    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    sharedTimer.callback();
    await expectCode(pending, 'TIMEOUT');
  });

  it('defers when post-arm clear consumes the shared deadline', async () => {
    let now = 100;
    const value = harness(200_000, {
      now: () => now,
      setTimer: (callback, delayMs, timers) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        if (delayMs === ATTEMPT_TIMER_DELAY_MS) now = 120_100;
        return timer;
      },
      clearTimer: (handle) => {
        const timer = handle as TimerControl;
        timer.cleared = true;
        if (timer.delayMs === ATTEMPT_TIMER_DELAY_MS) now = 200_000;
        return undefined;
      },
    });
    const pending = value.iterator.next();
    await Promise.resolve();
    const sharedTimer = value.timers.find(
      (timer) => timer.delayMs > ATTEMPT_TIMER_DELAY_MS,
    )!;

    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    sharedTimer.callback();
    await expectCode(pending, 'TIMEOUT');
  });

  it('fails closed after bounded repeated early timer callbacks', async () => {
    const value = harness();
    const pending = value.iterator.next();
    await Promise.resolve();

    for (let index = 0; index < 8; index += 1) {
      const current = value.timers.filter(
        (timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS,
      ).at(-1)!;
      current.callback();
    }

    await expectCode(pending, 'BRIDGE_FAILURE');
    expect(value.attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('re-arms an early backoff without overlapping credential acquisition', async () => {
    const value = harness();
    void value.iterator.next();
    await Promise.resolve();
    value.attempts[0]!.settlement!.fail(exactFailure());
    const firstBackoff = value.timers.find(
      (timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS,
    )!;

    firstBackoff.callback();
    expect(value.acquireCredential).toHaveBeenCalledTimes(1);
    const backoffs = value.timers.filter((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS);
    expect(backoffs).toHaveLength(2);

    value.setNow(350);
    backoffs[1]!.callback();
    await Promise.resolve();
    expect(value.acquireCredential).toHaveBeenCalledTimes(2);
  });

  it('defers an attempt timer firing at the shared deadline to D1', async () => {
    const value = harness(200_000);
    const pending = value.iterator.next();
    await Promise.resolve();
    const attemptTimer = value.timers.find(
      (timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS,
    )!;
    const sharedTimer = value.timers.find(
      (timer) => timer.delayMs > ATTEMPT_TIMER_DELAY_MS,
    )!;
    value.attempts[0]!.settlement!.chunk(Uint8Array.from([1]));
    await expect(pending).resolves.toEqual({
      value: Uint8Array.from([1]),
      done: false,
    });
    value.setNow(200_000);

    attemptTimer.callback();
    // D1 and D4 independently reject clock rollback. This one-millisecond
    // test skew exercises a reentrant ordering where D4 observes the boundary
    // before D1's next deadline read.
    value.setNow(199_999);
    const second = value.iterator.next();
    let settled = false;
    void second.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    value.setNow(200_000);
    sharedTimer.callback();
    await expectCode(second, 'TIMEOUT');
  });

  it('disposes a credential that resolves after the owner returns', async () => {
    let resolveCredential!: (
      credential: DisposableProjectTemplateGhCredential,
    ) => void;
    const late = controlledCredential();
    const value = harness(1_000_000, {
      acquireCredential: () => new Promise((resolve) => {
        resolveCredential = resolve;
      }),
    });
    const pending = value.iterator.next();
    await value.iterator.return!();
    await expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });

    resolveCredential(late.credential);
    await Promise.resolve();
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(value.createAttempt).not.toHaveBeenCalled();
  });

  it('maps retryable bootstrap rejection without exposing its message', async () => {
    const value = harness(1_000_000, {
      acquireCredential: () => Promise.reject(Object.freeze(
        Object.assign(new Error('secret-token'), {
          code: 'PROCESS_FAILED',
        }),
      )),
    });
    const pending = value.iterator.next();
    await Promise.resolve();
    await Promise.resolve();
    expect(value.timers.some((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS)).toBe(true);
    await value.iterator.return!();
    await expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it('rejects a non-native thenable and does not invoke its trap', async () => {
    const then = vi.fn();
    const value = harness(1_000_000, {
      acquireCredential: () => Object.freeze({ then }) as never,
    });
    const pending = value.iterator.next();

    await expectCode(pending, 'BRIDGE_FAILURE');
    expect(then).not.toHaveBeenCalled();
    expect(value.createAttempt).not.toHaveBeenCalled();
  });

  it('rejects a Promise subclass without invoking hostile species', async () => {
    const species = vi.fn(() => Promise);
    class HostilePromise<T> extends Promise<T> {
      static override get [Symbol.species](): PromiseConstructor {
        return species();
      }
    }
    const credential = controlledCredential();
    const subclass = new HostilePromise<DisposableProjectTemplateGhCredential>(
      (resolve) => resolve(credential.credential),
    );
    const value = harness(1_000_000, {
      unmockedAcquire: true,
      acquireCredential: () => subclass,
    });

    await expectCode(value.iterator.next(), 'BRIDGE_FAILURE');
    expect(species).not.toHaveBeenCalled();
    expect(credential.dispose).not.toHaveBeenCalled();
    expect(value.createAttempt).not.toHaveBeenCalled();
  });

  it('accepts a native credential Promise created in another realm', async () => {
    const credential = controlledCredential();
    const promise = runInNewContext(
      'Promise.resolve(credential)',
      { credential: credential.credential },
    ) as Promise<DisposableProjectTemplateGhCredential>;
    const value = harness(1_000_000, {
      unmockedAcquire: true,
      acquireCredential: () => promise,
    });

    const pending = value.iterator.next();
    await Promise.resolve();
    value.attempts[0]!.settlement!.chunk(Uint8Array.from([7]));

    await expect(pending).resolves.toEqual({
      value: Uint8Array.from([7]),
      done: false,
    });
    await value.iterator.return!();
    expect(credential.dispose).toHaveBeenCalledTimes(1);
  });

  it('accepts Node AsyncLocalStorage promise instrumentation', async () => {
    const credential = controlledCredential();
    const storage = new AsyncLocalStorage<{ readonly trace: string }>();
    const promise = storage.run(
      { trace: 'test' },
      () => runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>,
    );
    expect(Reflect.ownKeys(promise).filter(
      (key) => typeof key === 'symbol',
    ).map((key) => key.description)).toEqual([
      'async_id_symbol',
      'trigger_async_id_symbol',
      'kResourceStore',
    ]);
    const value = harness(1_000_000, {
      unmockedAcquire: true,
      acquireCredential: () => promise,
    });

    const pending = value.iterator.next();
    await Promise.resolve();
    value.attempts[0]!.settlement!.chunk(Uint8Array.from([8]));

    await expect(pending).resolves.toEqual({
      value: Uint8Array.from([8]),
      done: false,
    });
    await value.iterator.return!();
    expect(credential.dispose).toHaveBeenCalledTimes(1);
    storage.disable();
  });

  it('does not inspect the AsyncLocalStorage resource store during settlement', async () => {
    const credential = controlledCredential();
    const storage = new AsyncLocalStorage<object>();
    const promise = storage.run(
      Object.freeze({ trace: 'test' }),
      () => Promise.resolve(credential.credential),
    );
    const resourceStore = Reflect.ownKeys(promise).find(
      (key): key is symbol => (
        typeof key === 'symbol' && key.description === 'kResourceStore'
      ),
    )!;
    const storeTrap = vi.fn(() => {
      throw new Error('SECRET resource store');
    });
    Object.defineProperty(promise, resourceStore, {
      ...Object.getOwnPropertyDescriptor(promise, resourceStore),
      value: new Proxy(Object.freeze({}), { get: storeTrap }),
    });
    const value = harness(1_000_000, {
      unmockedAcquire: true,
      acquireCredential: () => promise,
    });

    const pending = value.iterator.next();
    await Promise.resolve();
    value.attempts[0]!.settlement!.chunk(Uint8Array.from([8]));
    await expect(pending).resolves.toMatchObject({ done: false });
    await value.iterator.return!();
    expect(storeTrap).not.toHaveBeenCalled();
    storage.disable();
  });

  it.each([
    ['async_id_symbol', 'proxy'],
    ['async_id_symbol', 'nan'],
    ['async_id_symbol', 'infinity'],
    ['async_id_symbol', 'out-of-range'],
    ['trigger_async_id_symbol', 'proxy'],
    ['trigger_async_id_symbol', 'negative'],
    ['trigger_async_id_symbol', 'nan'],
    ['trigger_async_id_symbol', 'infinity'],
  ] as const)(
    'rejects an invalid Node %s %s value before attaching a reaction',
    async (description, invalidKind) => {
      const credential = controlledCredential();
      const storage = new AsyncLocalStorage<object>();
      const promise = storage.run(
        Object.freeze({ trace: 'test' }),
        () => Promise.resolve(credential.credential),
      );
      const symbol = Reflect.ownKeys(promise).find(
        (key): key is symbol => (
          typeof key === 'symbol' && key.description === description
        ),
      )!;
      const valueTrap = vi.fn(() => {
        throw new Error('SECRET async instrumentation value');
      });
      const invalidValue = invalidKind === 'proxy'
        ? new Proxy(Object.freeze({}), { get: valueTrap })
        : invalidKind === 'nan'
          ? Number.NaN
          : invalidKind === 'infinity'
            ? Number.POSITIVE_INFINITY
            : invalidKind === 'negative'
              ? -1
              : Number.MAX_SAFE_INTEGER + 1;
      Object.defineProperty(promise, symbol, {
        ...Object.getOwnPropertyDescriptor(promise, symbol),
        value: invalidValue,
      });
      const value = harness(1_000_000, {
        unmockedAcquire: true,
        acquireCredential: () => promise,
      });

      await expectCode(value.iterator.next(), 'BRIDGE_FAILURE');
      expect(value.createAttempt).not.toHaveBeenCalled();
      expect(valueTrap).not.toHaveBeenCalled();
      storage.disable();
    },
  );

  it.each([false, true])(
    'rejects an enumerable=%s instrumentation symbol accessor without invoking it',
    async (enumerable) => {
      const credential = controlledCredential();
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const trap = vi.fn(() => credential.credential);
      Object.defineProperty(promise, Symbol('hostile'), {
        configurable: true,
        enumerable,
        get: trap,
      });
      const value = harness(1_000_000, {
        unmockedAcquire: true,
        acquireCredential: () => promise,
      });

      await expectCode(value.iterator.next(), 'BRIDGE_FAILURE');
      expect(trap).not.toHaveBeenCalled();
      expect(value.createAttempt).not.toHaveBeenCalled();
    },
  );

  it.each([
    Symbol('unknown'),
    Symbol('async_id_symbol'),
    Symbol('trigger_async_id_symbol'),
    Symbol('kResourceStore'),
  ])(
    'rejects an unknown instrumentation symbol identity',
    async (symbol) => {
      const credential = controlledCredential();
      const promise = Promise.resolve(credential.credential);
      Object.defineProperty(promise, symbol, {
        configurable: true,
        value: 1,
      });
      const value = harness(1_000_000, {
        unmockedAcquire: true,
        acquireCredential: () => promise,
      });

      await expectCode(value.iterator.next(), 'BRIDGE_FAILURE');
      expect(value.createAttempt).not.toHaveBeenCalled();
      expect(credential.dispose).not.toHaveBeenCalled();
    },
  );

  it('rejects a duplicate instrumentation symbol description', async () => {
    const credential = controlledCredential();
    const storage = new AsyncLocalStorage<object>();
    const promise = storage.run(
      Object.freeze({ trace: 'test' }),
      () => Promise.resolve(credential.credential),
    );
    Object.defineProperty(promise, Symbol('kResourceStore'), {
      configurable: true,
      value: Object.freeze({}),
    });
    const value = harness(1_000_000, {
      unmockedAcquire: true,
      acquireCredential: () => promise,
    });

    await expectCode(value.iterator.next(), 'BRIDGE_FAILURE');
    expect(value.createAttempt).not.toHaveBeenCalled();
    storage.disable();
  });

  it('rejects hostile Promise descriptors without invoking their traps', async () => {
    const credential = controlledCredential();
    const candidates: Array<{
      readonly promise: Promise<DisposableProjectTemplateGhCredential>;
      readonly trap: ReturnType<typeof vi.fn>;
    }> = [];
    {
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const trap = vi.fn(() => {
        throw new Error('SECRET species');
      });
      Object.defineProperty(
        Object.getPrototypeOf(promise).constructor,
        Symbol.species,
        { configurable: true, get: trap },
      );
      candidates.push({ promise, trap });
    }
    {
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(promise).constructor,
        Symbol.species,
      )!;
      const trap = vi.fn();
      Object.defineProperty(
        Object.getPrototypeOf(promise).constructor,
        Symbol.species,
        { ...descriptor, set: trap },
      );
      candidates.push({ promise, trap });
    }
    {
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const trap = vi.fn();
      Object.defineProperty(
        Object.getPrototypeOf(promise).constructor,
        Symbol.species,
        { configurable: true, value: Promise },
      );
      candidates.push({ promise, trap });
    }
    {
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(promise).constructor,
        Symbol.species,
      )!;
      const trap = vi.fn();
      Object.defineProperty(
        Object.getPrototypeOf(promise).constructor,
        Symbol.species,
        {
          ...descriptor,
          get: new Proxy(descriptor.get!, { apply: trap }),
        },
      );
      candidates.push({ promise, trap });
    }
    {
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const trap = vi.fn(() => 'function get [Symbol.species]() { [native code] }');
      const getter = () => Promise;
      Object.defineProperty(getter, 'toString', { value: trap });
      Object.defineProperty(
        Object.getPrototypeOf(promise).constructor,
        Symbol.species,
        { configurable: true, get: getter },
      );
      candidates.push({ promise, trap });
    }
    {
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(promise).constructor,
        Symbol.species,
      )!;
      const trap = vi.fn();
      Object.defineProperty(
        Object.getPrototypeOf(promise).constructor,
        Symbol.species,
        { ...descriptor, enumerable: true },
      );
      candidates.push({ promise, trap });
    }
    {
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const trap = vi.fn(() => Promise);
      Object.defineProperty(Object.getPrototypeOf(promise), 'constructor', {
        configurable: true,
        get: trap,
      });
      candidates.push({ promise, trap });
    }
    {
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const constructor = Object.getPrototypeOf(promise).constructor;
      const trap = vi.fn();
      Object.defineProperty(Object.getPrototypeOf(promise), 'constructor', {
        configurable: true,
        enumerable: false,
        value: constructor,
        writable: false,
      });
      candidates.push({ promise, trap });
    }
    {
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const trap = vi.fn(() => Promise);
      Object.defineProperty(promise, Symbol('hostile'), {
        configurable: true,
        get: trap,
      });
      candidates.push({ promise, trap });
    }
    {
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const trap = vi.fn();
      Object.defineProperty(promise, 'then', {
        configurable: true,
        value: trap,
      });
      candidates.push({ promise, trap });
    }
    {
      const promise = runInNewContext(
        'Promise.resolve(credential)',
        { credential: credential.credential },
      ) as Promise<DisposableProjectTemplateGhCredential>;
      const trap = vi.fn(() => 'Promise');
      Object.defineProperty(
        Object.getPrototypeOf(promise),
        Symbol.toStringTag,
        { configurable: true, get: trap },
      );
      candidates.push({ promise, trap });
    }

    for (const { promise, trap } of candidates) {
      const value = harness(1_000_000, {
        unmockedAcquire: true,
        acquireCredential: () => promise,
      });

      await expectCode(value.iterator.next(), 'BRIDGE_FAILURE');
      expect(trap).not.toHaveBeenCalled();
      expect(value.createAttempt).not.toHaveBeenCalled();
    }
    expect(credential.dispose).not.toHaveBeenCalled();
  });

  it('disposes a late cross-realm credential after owner return', async () => {
    const credential = controlledCredential();
    const context = {} as {
      promise: Promise<DisposableProjectTemplateGhCredential>;
      resolveCredential: (
        credential: DisposableProjectTemplateGhCredential,
      ) => void;
    };
    runInNewContext(`
      globalThis.promise = new Promise((resolve) => {
        globalThis.resolveCredential = resolve;
      });
    `, context);
    const value = harness(1_000_000, {
      unmockedAcquire: true,
      acquireCredential: () => context.promise,
    });
    const pending = value.iterator.next();

    await value.iterator.return!();
    await expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });
    context.resolveCredential(credential.credential);
    await Promise.resolve();
    await Promise.resolve();

    expect(credential.dispose).toHaveBeenCalledTimes(1);
    expect(value.createAttempt).not.toHaveBeenCalled();
  });

  it('rejects a native Promise with an own constructor without reading it', async () => {
    const constructorGetter = vi.fn(() => Promise);
    const credential = controlledCredential();
    const promise = Promise.resolve(credential.credential);
    Object.defineProperty(promise, 'constructor', {
      configurable: true,
      get: constructorGetter,
    });
    const value = harness(1_000_000, {
      unmockedAcquire: true,
      acquireCredential: () => promise,
    });

    await expectCode(value.iterator.next(), 'BRIDGE_FAILURE');
    expect(constructorGetter).not.toHaveBeenCalled();
    expect(credential.dispose).not.toHaveBeenCalled();
    expect(value.createAttempt).not.toHaveBeenCalled();
  });

  it('snapshots a synchronous chunk before the producer mutates it', async () => {
    const source = Uint8Array.from([3, 4]);
    const value = harness(1_000_000, {
      createAttempt: () => Object.freeze({
        pull(
          settlement: ProjectTemplateArtifactSingleAttemptSettlement,
        ): undefined {
          settlement.chunk(source);
          source.fill(9);
          return undefined;
        },
        dispose: () => undefined,
      }) as unknown as ProjectTemplateArtifactSingleAttempt,
    });

    await expect(value.iterator.next()).resolves.toEqual({
      value: Uint8Array.from([3, 4]),
      done: false,
    });
  });

  it('leaves a shorter shared deadline authoritative', async () => {
    const value = harness(10_000);
    const pending = value.iterator.next();
    expect(value.timers).toHaveLength(1);

    value.setNow(10_000);
    value.timers[0]!.callback();
    await expectCode(pending, 'TIMEOUT');
    expect(value.credentials).toHaveLength(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('lets D1 own abort while acquiring and disposes the late credential', async () => {
    const controller = new AbortController();
    let resolveCredential!: (
      credential: DisposableProjectTemplateGhCredential,
    ) => void;
    const late = controlledCredential();
    const value = harness(1_000_000, {
      signal: controller.signal,
      acquireCredential: () => new Promise((resolve) => {
        resolveCredential = resolve;
      }),
    });
    const pending = value.iterator.next();

    controller.abort();
    await expectCode(pending, 'ABORTED');
    resolveCredential(late.credential);
    await Promise.resolve();
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(value.createAttempt).not.toHaveBeenCalled();
  });

  it('cancels a retry backoff on abort without starting another credential', async () => {
    const controller = new AbortController();
    const value = harness(1_000_000, { signal: controller.signal });
    const pending = value.iterator.next();
    await Promise.resolve();
    value.attempts[0]!.settlement!.fail(exactFailure());
    const backoff = value.timers.find((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS)!;

    controller.abort();
    await expectCode(pending, 'ABORTED');
    expect(backoff.cleared).toBe(true);
    backoff.callback();
    expect(value.acquireCredential).toHaveBeenCalledTimes(1);
  });

  it('keeps a shared-deadline auth timeout pending for D1 TIMEOUT', async () => {
    let rejectCredential!: (error: unknown) => void;
    const value = harness(10_000, {
      acquireCredential: () => new Promise((_resolve, reject) => {
        rejectCredential = reject;
      }),
    });
    const pending = value.iterator.next();
    value.setNow(10_000);
    rejectCredential(Object.freeze(Object.assign(new Error('private'), {
      code: 'TIMEOUT',
    })));
    await Promise.resolve();
    await Promise.resolve();

    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(value.timers).toHaveLength(1);

    value.timers[0]!.callback();
    await expectCode(pending, 'TIMEOUT');
    expect(value.acquireCredential).toHaveBeenCalledTimes(1);
  });

  it.each(['terminal', 'retryable'] as const)(
    'does not let a %s policy decision overtake shared TIMEOUT',
    async (kind) => {
      const value = harness(10_000);
      const pending = value.iterator.next();
      await Promise.resolve();
      const sharedTimer = value.timers[0]!;
      value.setNow(10_000);
      value.attempts[0]!.settlement!.fail(
        kind === 'terminal' ? exactFailure('INTERNAL') : exactFailure(),
      );
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      sharedTimer.callback();
      await expectCode(pending, 'TIMEOUT');
    },
  );

  it('does not let the third-attempt limit overtake shared TIMEOUT', async () => {
    const value = harness(5_000);
    const pending = value.iterator.next();
    await Promise.resolve();
    const sharedTimer = value.timers[0]!;
    value.attempts[0]!.settlement!.fail(exactFailure());
    value.setNow(350);
    value.timers.find((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS)!.callback();
    await Promise.resolve();
    value.attempts[1]!.settlement!.fail(exactFailure());
    value.setNow(1_350);
    value.timers.find((timer) => timer.delayMs === SECOND_RETRY_TIMER_DELAY_MS)!.callback();
    await Promise.resolve();
    value.setNow(5_000);
    value.attempts[2]!.settlement!.fail(exactFailure());

    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    sharedTimer.callback();
    await expectCode(pending, 'TIMEOUT');
  });

  it('uses AbortSignal intrinsics instead of hostile own properties', async () => {
    const controller = new AbortController();
    const ownAdd = vi.fn();
    const ownRemove = vi.fn();
    const ownAborted = vi.fn(() => false);
    Object.defineProperties(controller.signal, {
      addEventListener: { configurable: true, value: ownAdd },
      removeEventListener: { configurable: true, value: ownRemove },
      aborted: { configurable: true, get: ownAborted },
    });
    const value = harness(1_000_000, { signal: controller.signal });
    const pending = value.iterator.next();
    await Promise.resolve();

    await value.iterator.return!();
    await expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(ownAdd).not.toHaveBeenCalled();
    expect(ownRemove).not.toHaveBeenCalled();
    expect(ownAborted).not.toHaveBeenCalled();
  });

  it('revokes a retained inner settlement when its generation is disposed', async () => {
    let retained!: ProjectTemplateArtifactSingleAttemptSettlement;
    const innerDispose = vi.fn(() => undefined);
    const value = harness(1_000_000, {
      createAttempt: () => Object.freeze({
        pull(
          settlement: ProjectTemplateArtifactSingleAttemptSettlement,
        ): undefined {
          retained = settlement;
          return undefined;
        },
        dispose: innerDispose,
      }) as unknown as ProjectTemplateArtifactSingleAttempt,
    });
    const pending = value.iterator.next();
    await Promise.resolve();
    await value.iterator.return!();
    await expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });

    expect(retained.chunk(Uint8Array.from([9]))).toBeUndefined();
    expect(retained.done()).toBeUndefined();
    expect(retained.fail(exactFailure())).toBeUndefined();
    expect(innerDispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('releases terminal done resources before returning from the callback', async () => {
    const value = harness();
    const pending = value.iterator.next();
    await Promise.resolve();

    value.attempts[0]!.settlement!.done();
    expect(value.attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it('revokes a synchronously queued chunk on reentrant return', async () => {
    let iterator!: AsyncIterator<Uint8Array>;
    let retained!: ProjectTemplateArtifactSingleAttemptSettlement;
    const source = Uint8Array.from([6]);
    const value = harness(1_000_000, {
      createAttempt: () => Object.freeze({
        pull(
          settlement: ProjectTemplateArtifactSingleAttemptSettlement,
        ): undefined {
          retained = settlement;
          settlement.chunk(source);
          void iterator.return!();
          source[0] = 9;
          return undefined;
        },
        dispose: () => undefined,
      }) as unknown as ProjectTemplateArtifactSingleAttempt,
    });
    iterator = value.iterator;

    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(retained.chunk(Uint8Array.from([8]))).toBeUndefined();
    expect(retained.fail(exactFailure())).toBeUndefined();
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused credential without disposing another owner twice', async () => {
    const shared = controlledCredential();
    const value = harness(1_000_000, {
      acquireCredential: () => Promise.resolve(shared.credential),
    });
    const pending = value.iterator.next();
    await Promise.resolve();
    value.attempts[0]!.settlement!.fail(exactFailure());
    const backoff = value.timers.find((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS)!;
    value.setNow(350);
    backoff.callback();
    await Promise.resolve();

    await expectCode(pending, 'BRIDGE_FAILURE');
    expect(shared.dispose).toHaveBeenCalledTimes(1);
    expect(value.createAttempt).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused inner attempt and cleans only its fresh credential', async () => {
    let settlement!: ProjectTemplateArtifactSingleAttemptSettlement;
    const disposeAttempt = vi.fn(() => undefined);
    const sharedAttempt = Object.freeze({
      pull(value: ProjectTemplateArtifactSingleAttemptSettlement): undefined {
        settlement = value;
        return undefined;
      },
      dispose: disposeAttempt,
    }) as unknown as ProjectTemplateArtifactSingleAttempt;
    const value = harness(1_000_000, {
      createAttempt: () => sharedAttempt,
    });
    const pending = value.iterator.next();
    await Promise.resolve();
    settlement.fail(exactFailure());
    value.setNow(350);
    value.timers.find((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS)!.callback();
    await Promise.resolve();

    await expectCode(pending, 'BRIDGE_FAILURE');
    expect(disposeAttempt).toHaveBeenCalledTimes(1);
    expect(value.credentials).toHaveLength(2);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[1]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('fails without creating a retry when backoff cannot fit the budget', async () => {
    const value = harness(300);
    const pending = value.iterator.next();
    await Promise.resolve();
    value.attempts[0]!.settlement!.fail(exactFailure());

    await expectCode(pending, 'BRIDGE_FAILURE');
    expect(value.acquireCredential).toHaveBeenCalledTimes(1);
    expect(value.timers.some((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS)).toBe(false);
  });

  it.each(['sync-fire', 'fire-then-throw'] as const)(
    'contains an attempt timer that performs %s during registration',
    async (mode) => {
      const value = harness(1_000_000, {
        setTimer: (callback, delayMs, timers) => {
          const timer = { callback, delayMs, cleared: false };
          timers.push(timer);
          if (delayMs === ATTEMPT_TIMER_DELAY_MS) {
            callback();
            if (mode === 'fire-then-throw') throw new Error('private');
          }
          return timer;
        },
      });
      const pending = value.iterator.next();

      expect(value.acquireCredential).not.toHaveBeenCalled();
      await expectCode(pending, 'BRIDGE_FAILURE');
      expect(value.timers.some((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS)).toBe(false);
    },
  );

  it('fails closed when an attempt timer throws before firing', async () => {
    const value = harness(1_000_000, {
      setTimer: (callback, delayMs, timers) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        if (delayMs === ATTEMPT_TIMER_DELAY_MS) throw new Error('private');
        return timer;
      },
    });

    await expectCode(value.iterator.next(), 'BRIDGE_FAILURE');
    expect(value.acquireCredential).not.toHaveBeenCalled();
    expect(value.createAttempt).not.toHaveBeenCalled();
  });

  it('clears the actual timer returned after setTimer reentrant dispose', async () => {
    let iterator!: AsyncIterator<Uint8Array>;
    const value = harness(1_000_000, {
      setTimer: (callback, delayMs, timers) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        if (delayMs === ATTEMPT_TIMER_DELAY_MS) void iterator.return!();
        return timer;
      },
    });
    iterator = value.iterator;

    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    const attemptTimer = value.timers.find(
      (timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS,
    )!;
    expect(attemptTimer.cleared).toBe(true);
    expect(value.acquireCredential).not.toHaveBeenCalled();
  });

  it('continues exact cleanup when clearTimer reenters and throws', async () => {
    const value = harness(1_000_000, {
      clearTimer: (handle) => {
        (handle as TimerControl).callback();
        throw new Error('private');
      },
    });
    const pending = value.iterator.next();
    await Promise.resolve();

    await value.iterator.return!();
    await expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(value.attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['throw', 'return-value', 'duplicate'] as const)(
    'turns an inner synchronous %s contract violation into INTERNAL',
    async (mode) => {
      const value = harness(1_000_000, {
        createAttempt: () => Object.freeze({
          pull(
            settlement: ProjectTemplateArtifactSingleAttemptSettlement,
          ): undefined {
            settlement.chunk(Uint8Array.from([1]));
            if (mode === 'duplicate') {
              settlement.chunk(Uint8Array.from([2]));
              for (let index = 0; index < 100; index += 1) {
                settlement.chunk(Uint8Array.from([3]));
              }
              return undefined;
            }
            if (mode === 'throw') throw new Error('private');
            return 1 as never;
          },
          dispose: () => undefined,
        }) as unknown as ProjectTemplateArtifactSingleAttempt,
      });

      await expectCode(value.iterator.next(), 'BRIDGE_FAILURE');
      expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('lets D1 own abort during an active attempt', async () => {
    const controller = new AbortController();
    const value = harness(1_000_000, { signal: controller.signal });
    const pending = value.iterator.next();
    await Promise.resolve();

    controller.abort();
    await expectCode(pending, 'ABORTED');
    expect(value.attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('snapshots its public factory boundary without activating dependencies', () => {
    const credential = controlledCredential();
    const attempt = controlledAttempt();
    const dependencies = Object.freeze({
      now: vi.fn(() => 100),
      setTimer: vi.fn(() => Object.freeze({})),
      clearTimer: vi.fn(() => undefined),
      acquireCredential: vi.fn(() => Promise.resolve(credential.credential)),
      createAttempt: vi.fn(() => attempt.attempt),
    }) satisfies ProjectTemplateArtifactRetryDependencies;

    expect(() => createProjectTemplateArtifactRetryBridge(
      INPUT,
      Object.freeze({ deadlineMs: 1_000 }),
      dependencies,
    )).not.toThrow();
    expect(dependencies.now).not.toHaveBeenCalled();
    expect(dependencies.setTimer).not.toHaveBeenCalled();
    expect(dependencies.clearTimer).not.toHaveBeenCalled();
    expect(dependencies.acquireCredential).not.toHaveBeenCalled();
    expect(dependencies.createAttempt).not.toHaveBeenCalled();
  });

  it('rejects extra keys, accessors, proxies, and invalid deadlines fail-closed', () => {
    const getter = vi.fn(() => 'octo');
    const hostileApply = vi.fn();
    const validDependencies = Object.freeze({
      now: () => 100,
      setTimer: () => Object.freeze({}),
      clearTimer: () => undefined,
      acquireCredential: () => Promise.resolve(
        controlledCredential().credential,
      ),
      createAttempt: () => controlledAttempt().attempt,
    }) satisfies ProjectTemplateArtifactRetryDependencies;
    const accessorInput = Object.create(Object.prototype) as Record<
    string,
    unknown
    >;
    Object.defineProperties(accessorInput, {
      owner: { enumerable: true, get: getter },
      repo: { enumerable: true, value: 'demo' },
      releaseId: { enumerable: true, value: 1 },
      assetId: { enumerable: true, value: 2 },
      maxBytes: { enumerable: true, value: 10 },
    });
    const hostileNow = new Proxy(() => 100, {
      apply: hostileApply,
    });

    expect(() => createProjectTemplateArtifactRetryBridge(
      { ...INPUT, extra: true } as never,
      Object.freeze({ deadlineMs: 1_000 }),
      validDependencies,
    )).toThrow(TypeError);
    expect(() => createProjectTemplateArtifactRetryBridge(
      accessorInput as never,
      Object.freeze({ deadlineMs: 1_000 }),
      validDependencies,
    )).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect(() => createProjectTemplateArtifactRetryBridge(
      INPUT,
      new Proxy({ deadlineMs: 1_000 }, {}) as never,
      validDependencies,
    )).toThrow(TypeError);
    expect(() => createProjectTemplateArtifactRetryBridge(
      INPUT,
      Object.freeze({ deadlineMs: 1_000, extra: true }) as never,
      validDependencies,
    )).toThrow(TypeError);
    expect(() => createProjectTemplateArtifactRetryBridge(
      INPUT,
      Object.freeze({ deadlineMs: Number.NaN }),
      validDependencies,
    )).toThrow(TypeError);
    expect(() => createProjectTemplateArtifactRetryBridge(
      INPUT,
      Object.freeze({ deadlineMs: 1_000 }),
      Object.freeze({
        ...validDependencies,
        now: hostileNow,
      }),
    )).toThrow(TypeError);
    expect(() => createProjectTemplateArtifactRetryBridge(
      INPUT,
      Object.freeze({ deadlineMs: 1_000 }),
      Object.freeze({
        ...validDependencies,
        extra: true,
      }) as never,
    )).toThrow(TypeError);
    expect(hostileApply).not.toHaveBeenCalled();
  });

  it('stores no state dispatch when reentrant acquire returns a pending Promise', async () => {
    let iterator!: AsyncIterator<Uint8Array>;
    const pendingForever =
      new Promise<DisposableProjectTemplateGhCredential>(() => undefined);
    const value = harness(1_000_000, {
      unmockedAcquire: true,
      acquireCredential: () => {
        void iterator.return!();
        return pendingForever;
      },
    });
    iterator = value.iterator;

    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(value.createAttempt).not.toHaveBeenCalled();
  });

  it('disposes a fresh attempt returned after createAttempt reentrant close', async () => {
    let iterator!: AsyncIterator<Uint8Array>;
    const lateAttempt = controlledAttempt();
    const value = harness(1_000_000, {
      createAttempt: () => {
        void iterator.return!();
        return lateAttempt.attempt;
      },
    });
    iterator = value.iterator;

    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(lateAttempt.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not add resources when D4 now reentrantly closes the owner', async () => {
    let iterator!: AsyncIterator<Uint8Array>;
    let reads = 0;
    const value = harness(1_000_000, {
      now: () => {
        reads += 1;
        if (reads === 5) void iterator.return!();
        return 100;
      },
    });
    iterator = value.iterator;

    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(value.acquireCredential).not.toHaveBeenCalled();
    expect(value.timers.some((timer) => timer.delayMs === ATTEMPT_TIMER_DELAY_MS)).toBe(false);
  });

  it('does not arm backoff when its budget read reentrantly closes D1', async () => {
    let iterator!: AsyncIterator<Uint8Array>;
    let reads = 0;
    const value = harness(1_000_000, {
      now: () => {
        reads += 1;
        if (reads === 8) void iterator.return!();
        return 100;
      },
    });
    iterator = value.iterator;
    const pending = iterator.next();
    await Promise.resolve();
    value.attempts[0]!.settlement!.fail(exactFailure());

    await expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(value.timers.some((timer) => timer.delayMs === FIRST_RETRY_TIMER_DELAY_MS)).toBe(false);
    expect(value.attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(value.credentials[0]!.dispose).toHaveBeenCalledTimes(1);
  });
});
