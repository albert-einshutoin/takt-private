import { inspect, types } from 'node:util';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type {
  GithubTemplateArchiveAssetInput,
  GithubTemplateArchiveAssetPort,
} from '../../features/project-template/github-download-orchestrator.js';
import {
  createProjectTemplateArtifactDownloadPort,
  type ProjectTemplateArtifactDownloadBridge,
  type ProjectTemplateArtifactDownloadDependencies,
  type ProjectTemplateArtifactDownloadError,
} from '../../infra/github/project-template-artifact-download.js';

const VALID_INPUT = Object.freeze({
  owner: 'octo',
  repo: 'demo',
  releaseId: 12,
  assetId: 34,
  maxBytes: 1024,
} satisfies GithubTemplateArchiveAssetInput);

function makeBridge(
  next: ProjectTemplateArtifactDownloadBridge['next'] = vi.fn(
    () => Promise.resolve({ value: undefined, done: true }),
  ),
): ProjectTemplateArtifactDownloadBridge {
  return Object.freeze({
    next,
    dispose: vi.fn(() => undefined),
  });
}

function makeDependencies(
  bridge: ProjectTemplateArtifactDownloadBridge = makeBridge(),
  overrides: Partial<ProjectTemplateArtifactDownloadDependencies> = {},
): ProjectTemplateArtifactDownloadDependencies {
  return Object.freeze({
    now: vi.fn(() => 100),
    setTimer: vi.fn(() => Object.freeze({ timer: true })),
    clearTimer: vi.fn(),
    start: vi.fn(() => bridge),
    ...overrides,
  });
}

function expectCode(
  value: PromiseLike<unknown> | (() => unknown),
  code: ProjectTemplateArtifactDownloadError['code'],
): Promise<void> | void {
  if (typeof value === 'function') {
    expect(value).toThrow(expect.objectContaining({ code }));
    return;
  }
  return expect(value).rejects.toEqual(expect.objectContaining({ code }));
}

describe('project-template artifact download D1 cold iterator', () => {
  it('implements the existing archive asset port as a cold sealed facade', () => {
    const signal = new AbortController().signal;
    const aborted = vi.spyOn(AbortSignal.prototype, 'aborted', 'get');
    const addEventListener = vi.spyOn(
      EventTarget.prototype,
      'addEventListener',
    );
    const bridge = makeBridge();
    const dependencies = makeDependencies(bridge);
    const port: GithubTemplateArchiveAssetPort =
      createProjectTemplateArtifactDownloadPort(
        Object.freeze({ deadlineMs: 1_000 }),
        dependencies,
      );
    const input = {
      ...VALID_INPUT,
      owner: 'before-snapshot',
      signal,
    };

    const iterable = port.openReleaseAsset(input);
    input.owner = 'after-snapshot';

    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.isFrozen(iterable)).toBe(true);
    expect(Reflect.ownKeys(port)).toEqual(['openReleaseAsset']);
    expect(Reflect.ownKeys(iterable)).toEqual([Symbol.asyncIterator]);
    expect(dependencies.now).not.toHaveBeenCalled();
    expect(dependencies.setTimer).not.toHaveBeenCalled();
    expect(dependencies.start).not.toHaveBeenCalled();
    expect(bridge.next).not.toHaveBeenCalled();
    expect(aborted).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
    expect(inspect(iterable)).not.toContain('before-snapshot');
  });

  it.each([
    {},
    { ...VALID_INPUT, extra: true },
    { ...VALID_INPUT, owner: '' },
    { ...VALID_INPUT, owner: '-octo' },
    { ...VALID_INPUT, repo: '' },
    { ...VALID_INPUT, releaseId: 0 },
    { ...VALID_INPUT, assetId: Number.MAX_SAFE_INTEGER + 1 },
    { ...VALID_INPUT, maxBytes: 0 },
    new Proxy({ ...VALID_INPUT }, {}),
    Object.defineProperty({ ...VALID_INPUT }, 'owner', {
      enumerable: true,
      get: () => 'octo',
    }),
  ])('rejects non-exact open input %# without starting work', (input) => {
    const dependencies = makeDependencies();
    const port = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      dependencies,
    );

    expectCode(
      () => port.openReleaseAsset(
        input as GithubTemplateArchiveAssetInput,
      ),
      'INVALID_ARGUMENT',
    );
    expect(dependencies.now).not.toHaveBeenCalled();
    expect(dependencies.setTimer).not.toHaveBeenCalled();
    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it('rejects accessor dependencies without invoking them', () => {
    const startGetter = vi.fn(() => vi.fn());
    const dependencies = Object.defineProperty({
      now: vi.fn(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    }, 'start', {
      enumerable: true,
      get: startGetter,
    });

    expectCode(
      () => createProjectTemplateArtifactDownloadPort(
        Object.freeze({ deadlineMs: 1_000 }),
        dependencies as ProjectTemplateArtifactDownloadDependencies,
      ),
      'INVALID_ARGUMENT',
    );
    expect(startGetter).not.toHaveBeenCalled();
  });

  it.each([
    { deadlineMs: -1 },
    { deadlineMs: Number.NaN },
    { deadlineMs: 1_000, extra: true },
    new Proxy({ deadlineMs: 1_000 }, {}),
    Object.defineProperty({}, 'deadlineMs', {
      enumerable: true,
      get: () => 1_000,
    }),
  ])('rejects invalid absolute deadline context %#', (context) => {
    const dependencies = makeDependencies();

    expectCode(
      () => createProjectTemplateArtifactDownloadPort(
        context as { readonly deadlineMs: number },
        dependencies,
      ),
      'INVALID_ARGUMENT',
    );
    expect(dependencies.now).not.toHaveBeenCalled();
    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it('allows one iterator acquisition and rejects borrowed or proxied facades', () => {
    const port = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      makeDependencies(),
    );
    const iterable = port.openReleaseAsset(VALID_INPUT);
    const iterator = iterable[Symbol.asyncIterator]();

    expect(Object.isFrozen(iterator)).toBe(true);
    expect(Reflect.ownKeys(iterator)).toEqual([
      'next',
      'return',
      'throw',
      Symbol.asyncIterator,
    ]);
    expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
    expectCode(() => iterable[Symbol.asyncIterator](), 'ITERATOR_USED');
    expectCode(
      () => Reflect.apply(port.openReleaseAsset, {}, [VALID_INPUT]),
      'INVALID_ARGUMENT',
    );
    expectCode(
      () => Reflect.apply(iterable[Symbol.asyncIterator], {}, []),
      'INVALID_ARGUMENT',
    );
    expectCode(
      () => Reflect.apply(
        iterator[Symbol.asyncIterator],
        new Proxy(iterator, {}),
        [],
      ),
      'INVALID_ARGUMENT',
    );
  });

  it('starts once on first next and returns copied exact native results', async () => {
    const first = Uint8Array.from([1, 2, 3]);
    const bridge = makeBridge(vi.fn()
      .mockResolvedValueOnce({ value: first, done: false })
      .mockResolvedValueOnce({ value: undefined, done: true }));
    const dependencies = makeDependencies(bridge);
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      dependencies,
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

    const firstPending = iterator.next();

    expect(Object.getPrototypeOf(firstPending)).toBe(Promise.prototype);
    expect(dependencies.start).toHaveBeenCalledTimes(1);
    expect(dependencies.start).toHaveBeenCalledWith(
      expect.objectContaining(VALID_INPUT),
    );
    expect(Object.isFrozen(dependencies.start.mock.calls[0]![0])).toBe(true);
    const firstResult = await firstPending;
    first[0] = 9;
    expect(firstResult).toEqual({
      value: Uint8Array.from([1, 2, 3]),
      done: false,
    });
    expect(Reflect.ownKeys(firstResult)).toEqual(['value', 'done']);
    expect(Object.isFrozen(firstResult)).toBe(true);

    const done = await iterator.next();

    expect(done).toEqual({ value: undefined, done: true });
    expect(Reflect.ownKeys(done)).toEqual(['value', 'done']);
    expect(Object.isFrozen(done)).toBe(true);
    expect(dependencies.start).toHaveBeenCalledTimes(1);
    expect(bridge.next).toHaveBeenCalledTimes(2);
    expect(bridge.dispose).toHaveBeenCalledTimes(1);
    expect(dependencies.clearTimer).toHaveBeenCalledTimes(1);
  });

  it('fails pre-aborted and expired iterators before the start hook', async () => {
    const aborted = new AbortController();
    aborted.abort('private abort reason');
    const abortedDependencies = makeDependencies();
    const abortedIterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      abortedDependencies,
    ).openReleaseAsset({
      ...VALID_INPUT,
      signal: aborted.signal,
    })[Symbol.asyncIterator]();

    await expectCode(abortedIterator.next(), 'ABORTED');
    expect(abortedDependencies.start).not.toHaveBeenCalled();
    expect(abortedDependencies.setTimer).not.toHaveBeenCalled();

    const expiredDependencies = makeDependencies(
      makeBridge(),
      { now: vi.fn(() => 1_001) },
    );
    const expiredIterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      expiredDependencies,
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

    await expectCode(expiredIterator.next(), 'TIMEOUT');
    expect(expiredDependencies.start).not.toHaveBeenCalled();
    expect(expiredDependencies.setTimer).not.toHaveBeenCalled();
  });

  it('rechecks the monotonic deadline before every bridge pull', async () => {
    const bridge = makeBridge(vi.fn(() => Promise.resolve({
      value: Uint8Array.from([1]),
      done: false,
    })));
    const dependencies = makeDependencies(bridge, {
      now: vi.fn()
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(1_001),
    });
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      dependencies,
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      value: Uint8Array.from([1]),
      done: false,
    });
    await expectCode(iterator.next(), 'TIMEOUT');

    expect(dependencies.now).toHaveBeenCalledTimes(2);
    expect(bridge.next).toHaveBeenCalledTimes(1);
    expect(bridge.dispose).toHaveBeenCalledTimes(1);
  });

  it('fails closed when next is concurrent and ignores the late bridge result', async () => {
    let resolveBridge!: (value: IteratorResult<Uint8Array>) => void;
    const bridgePending = new Promise<IteratorResult<Uint8Array>>((resolve) => {
      resolveBridge = resolve;
    });
    const bridge = makeBridge(vi.fn(() => bridgePending));
    const dependencies = makeDependencies(bridge);
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      dependencies,
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

    const first = iterator.next();
    const second = iterator.next();
    const firstOutcome = expectCode(first, 'CONCURRENT_NEXT');
    const secondOutcome = expectCode(second, 'CONCURRENT_NEXT');

    expect(bridge.dispose).toHaveBeenCalledTimes(1);
    expect(dependencies.clearTimer).toHaveBeenCalledTimes(1);
    resolveBridge({ value: Uint8Array.from([7]), done: false });
    await Promise.all([firstOutcome, secondOutcome]);
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it.each(['return', 'throw'] as const)(
    'revokes pending work synchronously through iterator.%s',
    async (operation) => {
      const never = new Promise<IteratorResult<Uint8Array>>(() => {});
      const bridge = Object.freeze({
        next: vi.fn(() => never),
        dispose: vi.fn(() => new Promise<void>(() => {})),
      }) as unknown as ProjectTemplateArtifactDownloadBridge;
      const dependencies = makeDependencies(bridge);
      const controller = new AbortController();
      const removeEventListener = vi.spyOn(
        EventTarget.prototype,
        'removeEventListener',
      );
      const iterator = createProjectTemplateArtifactDownloadPort(
        Object.freeze({ deadlineMs: 1_000 }),
        dependencies,
      ).openReleaseAsset({
        ...VALID_INPUT,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      const pending = iterator.next();
      const pendingOutcome = operation === 'return'
        ? expect(pending).resolves.toEqual({ value: undefined, done: true })
        : expectCode(pending, 'CLOSED');

      const terminal = operation === 'return'
        ? iterator.return!()
        : iterator.throw!(new Error('private caller cause'));

      expect(Object.getPrototypeOf(terminal)).toBe(Promise.prototype);
      expect(bridge.dispose).toHaveBeenCalledTimes(1);
      expect(dependencies.clearTimer).toHaveBeenCalledTimes(1);
      expect(removeEventListener).toHaveBeenCalledTimes(1);
      if (operation === 'return') {
        await expect(terminal).resolves.toEqual({
          value: undefined,
          done: true,
        });
      } else {
        await expectCode(terminal, 'CLOSED');
      }
      await pendingOutcome;
      expect(inspect(iterator)).not.toContain('private caller cause');
    },
  );

  it('contains a rejected native cleanup Promise without awaiting it', async () => {
    const bridge = Object.freeze({
      next: vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {})),
      dispose: vi.fn(() => Promise.reject(
        new Error('private cleanup rejection'),
      )),
    }) as unknown as ProjectTemplateArtifactDownloadBridge;
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      makeDependencies(bridge),
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const pendingDone = expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });

    const returned = iterator.return!();

    expect(bridge.dispose).toHaveBeenCalledTimes(1);
    await expect(returned).resolves.toEqual({
      value: undefined,
      done: true,
    });
    await pendingDone;
    await Promise.resolve();
    await Promise.resolve();
    expect(inspect(iterator)).not.toContain('private cleanup rejection');
  });

  it('does not inspect or assimilate a non-exact cleanup Promise', async () => {
    const constructorGetter = vi.fn(() => Promise);
    const foreignCleanup = new Promise<void>(() => {});
    Object.defineProperty(foreignCleanup, 'constructor', {
      configurable: true,
      get: constructorGetter,
    });
    const bridge = Object.freeze({
      next: vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {})),
      dispose: () => foreignCleanup,
    }) as unknown as ProjectTemplateArtifactDownloadBridge;
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      makeDependencies(bridge),
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const pendingDone = expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });

    await iterator.return!();

    await pendingDone;
    expect(constructorGetter).not.toHaveBeenCalled();
  });

  it('contains rejected subclass and cross-realm cleanup Promises', async () => {
    class PromiseSubclass<T> extends Promise<T> {}
    const cleanupFactories: Array<() => Promise<void>> = [
      () => new PromiseSubclass<void>(
        (_resolve, reject) => reject(new Error('private subclass cleanup')),
      ),
      () => runInNewContext(
        'Promise.reject(new Error("private cross-realm cleanup"))',
      ) as Promise<void>,
    ];
    for (const createCleanup of cleanupFactories) {
      const bridge = Object.freeze({
        next: vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {})),
        dispose: vi.fn(() => createCleanup()),
      }) as unknown as ProjectTemplateArtifactDownloadBridge;
      const iterator = createProjectTemplateArtifactDownloadPort(
        Object.freeze({ deadlineMs: 1_000 }),
        makeDependencies(bridge),
      ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();
      const pending = iterator.next();
      const pendingDone = expect(pending).resolves.toEqual({
        value: undefined,
        done: true,
      });

      await iterator.return!();

      await pendingDone;
      await Promise.resolve();
      await Promise.resolve();
    }
  });

  it('revokes listener, timer, waiter, and bridge on abort or deadline', async () => {
    for (const terminal of ['abort', 'deadline'] as const) {
      const callbacks: Array<() => void> = [];
      const never = new Promise<IteratorResult<Uint8Array>>(() => {});
      const bridge = makeBridge(vi.fn(() => never));
      const dependencies = makeDependencies(bridge, {
        setTimer: vi.fn((callback: () => void) => {
          callbacks.push(callback);
          return Object.freeze({ timer: terminal });
        }),
      });
      const controller = new AbortController();
      const iterator = createProjectTemplateArtifactDownloadPort(
        Object.freeze({ deadlineMs: 1_000 }),
        dependencies,
      ).openReleaseAsset({
        ...VALID_INPUT,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      const pending = iterator.next();
      const outcome = expectCode(
        pending,
        terminal === 'abort' ? 'ABORTED' : 'TIMEOUT',
      );

      if (terminal === 'abort') controller.abort('private abort reason');
      else callbacks[0]!();

      await outcome;
      expect(bridge.dispose).toHaveBeenCalledTimes(1);
      expect(dependencies.clearTimer).toHaveBeenCalledTimes(1);
      expect(dependencies.start).toHaveBeenCalledTimes(1);
    }
  });

  it('uses a fixed done-state table and rejects foreign iterator methods', async () => {
    const bridge = makeBridge();
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      makeDependencies(bridge),
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();
    await iterator.next();

    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    await expect(iterator.return!()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    await expectCode(iterator.throw!(new Error('private')), 'CLOSED');
    for (const method of ['next', 'return', 'throw'] as const) {
      const result = Reflect.apply(iterator[method]!, {}, []);
      await expectCode(result, 'INVALID_ARGUMENT');
      const proxyResult = Reflect.apply(
        iterator[method]!,
        new Proxy(iterator, {}),
        [],
      );
      await expectCode(proxyResult, 'INVALID_ARGUMENT');
    }
    expect(types.isProxy(iterator)).toBe(false);
  });

  it('redacts bridge failures and rejects malformed bridge results', async () => {
    for (const next of [
      vi.fn(() => {
        throw new Error('private bridge cause');
      }),
      vi.fn(() => Promise.reject(new Error('private async bridge cause'))),
      vi.fn(() => Promise.resolve({ done: false, value: 'private value' })),
      vi.fn(() => Promise.resolve({
        done: false,
        value: new Uint8Array(),
      })),
      vi.fn(() => Promise.resolve(new Proxy({
        done: true,
        value: undefined,
      }, {}))),
    ]) {
      const iterator = createProjectTemplateArtifactDownloadPort(
        Object.freeze({ deadlineMs: 1_000 }),
        makeDependencies(makeBridge(next)),
      ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

      let thrown: unknown;
      try {
        await iterator.next();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toEqual(expect.objectContaining({
        code: 'BRIDGE_FAILURE',
      }));
      expect(String(thrown)).not.toContain('private');
    }
  });

  it('rejects typed-array subclasses without invoking overridden accessors', async () => {
    const byteLengthGetter = vi.fn(() => {
      throw new Error('private typed-array accessor');
    });
    class HostileUint8Array extends Uint8Array {
      override get byteLength(): number {
        return byteLengthGetter();
      }
    }
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      makeDependencies(makeBridge(vi.fn(() => Promise.resolve({
        value: new HostileUint8Array([1]),
        done: false,
      })))),
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

    await expectCode(iterator.next(), 'BRIDGE_FAILURE');
    expect(byteLengthGetter).not.toHaveBeenCalled();
  });

  it('rejects typed-array proxies before invoking prototype traps', async () => {
    const getPrototypeOf = vi.fn(() => {
      throw new Error('private typed-array prototype trap');
    });
    const chunk = new Proxy(Uint8Array.from([1]), { getPrototypeOf });
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      makeDependencies(makeBridge(vi.fn(() => Promise.resolve({
        value: chunk,
        done: false,
      })))),
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

    await expectCode(iterator.next(), 'BRIDGE_FAILURE');
    expect(getPrototypeOf).not.toHaveBeenCalled();
  });

  it('rejects non-exact bridge Promises without reading own then', async () => {
    class PromiseSubclass<T> extends Promise<T> {}
    const nativeWithOwnThen = Promise.resolve({
      value: Uint8Array.from([1]),
      done: false as const,
    });
    const ownThen = vi.fn();
    Object.defineProperty(nativeWithOwnThen, 'then', {
      configurable: true,
      get: ownThen,
    });
    const foreignPromiseFactories: Array<() => unknown> = [
      () => ({ then: vi.fn() }),
      () => ({ value: undefined, done: true }),
      () => new PromiseSubclass<IteratorResult<Uint8Array>>(
        (_resolve, reject) => reject(new Error('private subclass rejection')),
      ),
      () => runInNewContext(
        'Promise.reject(new Error("private cross-realm rejection"))',
      ),
      () => new Proxy(Promise.resolve<IteratorResult<Uint8Array>>({
        value: undefined,
        done: true,
      }), {}),
      () => nativeWithOwnThen,
    ];
    for (const createCandidate of foreignPromiseFactories) {
      const candidate = createCandidate();
      const dispose = vi.fn();
      const bridge = Object.freeze({
        next: () => candidate,
        dispose,
      }) as unknown as ProjectTemplateArtifactDownloadBridge;
      const iterator = createProjectTemplateArtifactDownloadPort(
        Object.freeze({ deadlineMs: 1_000 }),
        makeDependencies(bridge),
      ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

      await expectCode(iterator.next(), 'BRIDGE_FAILURE');
      expect(dispose).toHaveBeenCalledTimes(1);
    }
    expect(ownThen).not.toHaveBeenCalled();
  });

  it('disposes a started bridge when its remaining shape is malformed', async () => {
    const dispose = vi.fn();
    const malformed = Object.freeze({
      next: vi.fn(() => Promise.resolve({
        value: undefined,
        done: true,
      })),
      dispose,
      extra: true,
    });
    const dependencies = makeDependencies(
      malformed as unknown as ProjectTemplateArtifactDownloadBridge,
    );
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      dependencies,
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

    await expectCode(iterator.next(), 'BRIDGE_FAILURE');
    expect(dependencies.start).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dependencies.clearTimer).toHaveBeenCalledTimes(1);
  });

  it('does not revive across synchronous setup-hook termination', async () => {
    for (const boundary of ['now', 'timer', 'start'] as const) {
      let iterator!: AsyncIterator<Uint8Array>;
      const bridge = makeBridge();
      const clearTimer = vi.fn();
      const dependencies = makeDependencies(bridge, {
        clearTimer,
        now: vi.fn(() => {
          if (boundary === 'now') void iterator.return!();
          return 100;
        }),
        setTimer: vi.fn((callback: () => void) => {
          if (boundary === 'timer') callback();
          return Object.freeze({ timer: boundary });
        }),
        start: vi.fn(() => {
          if (boundary === 'start') void iterator.return!();
          return bridge;
        }),
      });
      iterator = createProjectTemplateArtifactDownloadPort(
        Object.freeze({ deadlineMs: 1_000 }),
        dependencies,
      ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

      const pending = iterator.next();

      if (boundary === 'timer') {
        await expectCode(pending, 'TIMEOUT');
      } else {
        await expect(pending).resolves.toEqual({
          value: undefined,
          done: true,
        });
      }
      if (boundary === 'start') {
        expect(dependencies.start).toHaveBeenCalledTimes(1);
        expect(bridge.dispose).toHaveBeenCalledTimes(1);
      } else {
        expect(dependencies.start).not.toHaveBeenCalled();
        expect(bridge.dispose).not.toHaveBeenCalled();
      }
      expect(bridge.next).not.toHaveBeenCalled();
      expect(clearTimer).toHaveBeenCalledTimes(boundary === 'now' ? 0 : 1);
      await expect(iterator.next()).resolves.toEqual({
        value: undefined,
        done: true,
      });
    }
  });

  it.each(['reenter', 'throw-before-add', 'throw-after-add'] as const)(
    'revokes signal setup when addEventListener exits through %s',
    async (fault) => {
      let iterator!: AsyncIterator<Uint8Array>;
      const controller = new AbortController();
      const nativeAdd = EventTarget.prototype.addEventListener;
      const removeEventListener = vi.spyOn(
        EventTarget.prototype,
        'removeEventListener',
      );
      vi.spyOn(
        EventTarget.prototype,
        'addEventListener',
      ).mockImplementation(function addWithFault(
        this: EventTarget,
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (this !== controller.signal) {
          return Reflect.apply(nativeAdd, this, [type, callback, options]);
        }
        if (fault === 'throw-before-add') {
          throw new Error('private before add');
        }
        if (fault === 'reenter') {
          void iterator.return!();
          Reflect.apply(nativeAdd, this, [type, callback, options]);
          return;
        }
        Reflect.apply(nativeAdd, this, [type, callback, options]);
        if (fault === 'throw-after-add') {
          throw new Error('private after add');
        }
      });
      const dependencies = makeDependencies();
      iterator = createProjectTemplateArtifactDownloadPort(
        Object.freeze({ deadlineMs: 1_000 }),
        dependencies,
      ).openReleaseAsset({
        ...VALID_INPUT,
        signal: controller.signal,
      })[Symbol.asyncIterator]();

      const pending = iterator.next();

      if (fault === 'reenter') {
        await expect(pending).resolves.toEqual({
          value: undefined,
          done: true,
        });
      } else {
        await expectCode(pending, 'BRIDGE_FAILURE');
      }
      expect(removeEventListener).toHaveBeenCalledTimes(
        fault === 'reenter' ? 2 : 1,
      );
      expect(dependencies.setTimer).not.toHaveBeenCalled();
      expect(dependencies.start).not.toHaveBeenCalled();
      controller.abort('private late abort');
      await expect(iterator.next()).resolves.toEqual({
        value: undefined,
        done: true,
      });
    },
  );
});
