import { inspect, types } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type {
  GithubTemplateArchiveAssetInput,
  GithubTemplateArchiveAssetPort,
} from '../../features/project-template/github-download-orchestrator.js';
import {
  createProjectTemplateArtifactDownloadBridge,
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

type TestBridgeNext = () => Promise<IteratorResult<Uint8Array>>;

interface TestBridgeControl {
  readonly next: TestBridgeNext;
  readonly dispose: ReturnType<typeof vi.fn>;
}

const testBridgeControls = new WeakMap<
ProjectTemplateArtifactDownloadBridge,
TestBridgeControl
>();

function makeBridge(
  next: TestBridgeNext = vi.fn(
    () => Promise.resolve({ value: undefined, done: true }),
  ),
): ProjectTemplateArtifactDownloadBridge {
  const dispose = vi.fn(() => undefined);
  const state = Object.freeze({ next });
  const bridge = createProjectTemplateArtifactDownloadBridge(
    state,
    Object.freeze({
      pull(
        owned: typeof state,
        settlement: {
          chunk(value: unknown): undefined;
          done(): undefined;
          fail(): undefined;
        },
      ): undefined {
        let pending: Promise<IteratorResult<Uint8Array>>;
        try {
          pending = owned.next();
        } catch {
          settlement.fail();
          return undefined;
        }
        Promise.prototype.then.call(
          pending,
          (result) => {
            try {
              if (result.done === true) settlement.done();
              else settlement.chunk(result.value);
            } catch {
              settlement.fail();
            }
          },
          () => settlement.fail(),
        );
        return undefined;
      },
      dispose(): undefined {
        dispose();
        return undefined;
      },
    }),
  );
  testBridgeControls.set(bridge, Object.freeze({
    next,
    dispose,
  }));
  return bridge;
}

function bridgeNext(
  bridge: ProjectTemplateArtifactDownloadBridge,
): TestBridgeNext {
  return testBridgeControls.get(bridge)!.next;
}

function bridgeDispose(
  bridge: ProjectTemplateArtifactDownloadBridge,
): ReturnType<typeof vi.fn> {
  return testBridgeControls.get(bridge)!.dispose;
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
    expect(bridgeNext(bridge)).not.toHaveBeenCalled();
    expect(aborted).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
    expect(inspect(iterable)).not.toContain('before-snapshot');
  });

  it.each([
    {},
    { ...VALID_INPUT, extra: true },
    { ...VALID_INPUT, owner: '' },
    { ...VALID_INPUT, owner: '-octo' },
    { ...VALID_INPUT, owner: 'a--b' },
    { ...VALID_INPUT, owner: 'Octo' },
    { ...VALID_INPUT, repo: '' },
    { ...VALID_INPUT, repo: '.' },
    { ...VALID_INPUT, repo: '..' },
    { ...VALID_INPUT, repo: 'demo.GIT' },
    { ...VALID_INPUT, repo: 'Demo' },
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
    expect(bridgeNext(bridge)).toHaveBeenCalledTimes(2);
    expect(bridgeDispose(bridge)).toHaveBeenCalledTimes(1);
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
        .mockReturnValueOnce(100)
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

    expect(dependencies.now).toHaveBeenCalledTimes(4);
    expect(bridgeNext(bridge)).toHaveBeenCalledTimes(1);
    expect(bridgeDispose(bridge)).toHaveBeenCalledTimes(1);
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

    expect(bridgeDispose(bridge)).toHaveBeenCalledTimes(1);
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
      const bridge = makeBridge(vi.fn(() => never));
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
      const terminalOutcome = operation === 'return'
        ? expect(terminal).resolves.toEqual({
          value: undefined,
          done: true,
        })
        : expectCode(terminal, 'CLOSED');

      expect(Object.getPrototypeOf(terminal)).toBe(Promise.prototype);
      expect(bridgeDispose(bridge)).toHaveBeenCalledTimes(1);
      expect(dependencies.clearTimer).toHaveBeenCalledTimes(1);
      expect(removeEventListener).toHaveBeenCalledTimes(1);
      await terminalOutcome;
      await pendingOutcome;
      expect(inspect(iterator)).not.toContain('private caller cause');
    },
  );

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
      expect(bridgeDispose(bridge)).toHaveBeenCalledTimes(1);
      expect(dependencies.clearTimer).toHaveBeenCalledTimes(
        terminal === 'abort' ? 1 : 0,
      );
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
    for (const [index, next] of [
      vi.fn(() => {
        throw new Error('private bridge cause');
      }),
      vi.fn(() => Promise.reject(new Error('private async bridge cause'))),
      vi.fn(() => Promise.resolve({ done: false, value: 'private value' })),
      vi.fn(() => Promise.resolve({
        done: false,
        value: new Uint8Array(),
      })),
    ].entries()) {
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
      expect(thrown, `malformed bridge case ${index}`).toEqual(
        expect.objectContaining({
        code: 'BRIDGE_FAILURE',
        }),
      );
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

  it('rejects a forged bridge without invoking its cleanup hook', async () => {
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
    expect(dispose).not.toHaveBeenCalled();
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
        expect(bridgeDispose(bridge)).toHaveBeenCalledTimes(1);
      } else {
        expect(dependencies.start).not.toHaveBeenCalled();
        expect(bridgeDispose(bridge)).not.toHaveBeenCalled();
      }
      expect(bridgeNext(bridge)).not.toHaveBeenCalled();
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
        1,
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

  it('accepts only nominal bridges created by the internal bridge factory', async () => {
    const bridge = makeBridge();
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Reflect.ownKeys(bridge)).toEqual([]);

    const dispose = vi.fn(() => undefined);
    const disposeGetter = vi.fn(() => dispose);
    class StructuralBridge {
      get dispose(): () => undefined {
        return disposeGetter();
      }
    }
    const dependencies = makeDependencies(
      new StructuralBridge() as unknown as
        ProjectTemplateArtifactDownloadBridge,
    );
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      dependencies,
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

    await expectCode(iterator.next(), 'BRIDGE_FAILURE');
    expect(disposeGetter).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each(['return', 'throw', 'abort'] as const)(
    'transactionally disposes a valid returned bridge after synchronous %s',
    async (terminal) => {
      let iterator!: AsyncIterator<Uint8Array>;
      const controller = new AbortController();
      const returnedBridge = makeBridge();
      const dependencies = makeDependencies(makeBridge(), {
        start: vi.fn(() => {
          if (terminal === 'return') void iterator.return!();
          else if (terminal === 'throw') {
            void iterator.throw!(new Error('private terminal')).catch(
              () => undefined,
            );
          } else {
            controller.abort('private abort');
          }
          return returnedBridge;
        }),
      });
      iterator = createProjectTemplateArtifactDownloadPort(
        Object.freeze({ deadlineMs: 1_000 }),
        dependencies,
      ).openReleaseAsset({
        ...VALID_INPUT,
        signal: controller.signal,
      })[Symbol.asyncIterator]();

      const pending = iterator.next();

      if (terminal === 'return') {
        await expect(pending).resolves.toEqual({
          value: undefined,
          done: true,
        });
      } else {
        await expectCode(
          pending,
          terminal === 'abort' ? 'ABORTED' : 'CLOSED',
        );
      }
      expect(bridgeDispose(returnedBridge)).toHaveBeenCalledTimes(1);
      await expect(iterator.next()).resolves.toEqual({
        value: undefined,
        done: true,
      });
    },
  );

  it('revokes an add-after-throw listener even when physical removal throws', async () => {
    const controller = new AbortController();
    const nativeAdd = EventTarget.prototype.addEventListener;
    let retained: EventListenerOrEventListenerObject | null = null;
    vi.spyOn(
      EventTarget.prototype,
      'addEventListener',
    ).mockImplementation(function addThenThrow(
      this: EventTarget,
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (this !== controller.signal) {
        return Reflect.apply(nativeAdd, this, [type, callback, options]);
      }
      retained = callback;
      Reflect.apply(nativeAdd, this, [type, callback, options]);
      throw new Error('private add after registration');
    });
    vi.spyOn(
      EventTarget.prototype,
      'removeEventListener',
    ).mockImplementation(() => {
      throw new Error('private physical removal');
    });
    const dependencies = makeDependencies();
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      dependencies,
    ).openReleaseAsset({
      ...VALID_INPUT,
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expectCode(iterator.next(), 'BRIDGE_FAILURE');
    expect(retained).not.toBeNull();
    expect(String(retained)).not.toContain('current');
    expect(String(retained)).not.toContain('closeIterator');
    controller.abort('private late abort');
    expect(dependencies.start).not.toHaveBeenCalled();
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it('revokes a retained timer callback when clearTimer throws', async () => {
    let retainedTimer!: () => void;
    const bridge = makeBridge(
      vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {})),
    );
    const dependencies = makeDependencies(bridge, {
      setTimer: vi.fn((callback: () => void) => {
        retainedTimer = callback;
        return Object.freeze({ timer: true });
      }),
      clearTimer: vi.fn(() => {
        throw new Error('private clear timer');
      }),
    });
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      dependencies,
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const pendingDone = expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });

    await iterator.return!();
    retainedTimer();

    await pendingDone;
    expect(String(retainedTimer)).not.toContain('current');
    expect(String(retainedTimer)).not.toContain('closeIterator');
    expect(bridgeDispose(bridge)).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it('does not invoke mutable Promise species or methods', async () => {
    const dispose = vi.fn(() => undefined);
    const bridge = createProjectTemplateArtifactDownloadBridge(
      undefined,
      Object.freeze({
        pull(_state, settlement): undefined {
          settlement.chunk(Uint8Array.from([1]));
          return undefined;
        },
        dispose(): undefined {
          dispose();
          return undefined;
        },
      }),
    );
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      makeDependencies(bridge),
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();
    const speciesDescriptor = Object.getOwnPropertyDescriptor(
      Promise,
      Symbol.species,
    )!;
    const thenDescriptor = Object.getOwnPropertyDescriptor(
      Promise.prototype,
      'then',
    )!;
    const species = vi.fn(() => Promise);
    const hostileThen = vi.fn(() => {
      throw new Error('private mutable then');
    });
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get: species,
    });
    Object.defineProperty(Promise.prototype, 'then', {
      configurable: true,
      value: hostileThen,
    });

    const pending = iterator.next();
    Object.defineProperty(Promise, Symbol.species, speciesDescriptor);
    Object.defineProperty(Promise.prototype, 'then', thenDescriptor);

    await expect(pending).resolves.toEqual({
      value: Uint8Array.from([1]),
      done: false,
    });
    expect(Object.getPrototypeOf(pending)).toBe(Promise.prototype);
    expect(species).not.toHaveBeenCalled();
    expect(hostileThen).not.toHaveBeenCalled();
    await iterator.return!();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('copies a chunk at settlement ingress before pull can mutate it', async () => {
    const chunk = Uint8Array.from([1, 2, 3]);
    const bridge = createProjectTemplateArtifactDownloadBridge(
      undefined,
      Object.freeze({
        pull(_state, settlement): undefined {
          settlement.chunk(chunk);
          chunk[0] = 9;
          return undefined;
        },
        dispose(): undefined {
          return undefined;
        },
      }),
    );
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      makeDependencies(bridge),
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      value: Uint8Array.from([1, 2, 3]),
      done: false,
    });
  });

  it('bounds and rearms a huge absolute deadline without immediate timeout', async () => {
    const timers: Array<{
      callback: () => void;
      delay: number;
    }> = [];
    const bridge = makeBridge(
      vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {})),
    );
    const dependencies = makeDependencies(bridge, {
      now: vi.fn()
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(2_147_483_747)
        .mockReturnValue(2_147_483_747),
      setTimer: vi.fn((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return Object.freeze({ index: timers.length });
      }),
    });
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: Number.MAX_VALUE }),
      dependencies,
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const pendingDone = expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });

    expect(timers[0]!.delay).toBe(2_147_483_647);
    timers[0]!.callback();
    expect(timers).toHaveLength(2);
    expect(timers[1]!.delay).toBe(2_147_483_647);
    expect(bridgeDispose(bridge)).not.toHaveBeenCalled();
    await iterator.return!();
    await pendingDone;
  });

  it('ignores a late callback from an earlier bounded timer generation', async () => {
    const timers: Array<() => void> = [];
    const bridge = makeBridge(
      vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {})),
    );
    const clearTimer = vi.fn();
    const dependencies = makeDependencies(bridge, {
      now: vi.fn(() => 100),
      setTimer: vi.fn((callback: () => void) => {
        timers.push(callback);
        return Object.freeze({ generation: timers.length });
      }),
      clearTimer,
    });
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: Number.MAX_VALUE }),
      dependencies,
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const pendingDone = expect(pending).resolves.toEqual({
      value: undefined,
      done: true,
    });

    timers[0]!();
    expect(timers).toHaveLength(2);
    const clearCount = clearTimer.mock.calls.length;
    timers[0]!();
    timers[0]!();
    expect(timers).toHaveLength(2);
    expect(clearTimer).toHaveBeenCalledTimes(clearCount);
    expect(bridgeDispose(bridge)).not.toHaveBeenCalled();

    await iterator.return!();
    await pendingDone;
  });

  it('rechecks the absolute deadline after start before pulling', async () => {
    const bridge = makeBridge();
    const dependencies = makeDependencies(bridge, {
      now: vi.fn()
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(1_001),
    });
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      dependencies,
    ).openReleaseAsset(VALID_INPUT)[Symbol.asyncIterator]();

    await expectCode(iterator.next(), 'TIMEOUT');

    expect(dependencies.start).toHaveBeenCalledTimes(1);
    expect(bridgeDispose(bridge)).toHaveBeenCalledTimes(1);
    expect(bridgeNext(bridge)).not.toHaveBeenCalled();
  });
});
