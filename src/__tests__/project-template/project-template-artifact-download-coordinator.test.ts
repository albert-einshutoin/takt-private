import { describe, expect, it, vi } from 'vitest';
import type {
  GithubTemplateArchiveAssetInput,
} from '../../features/project-template/github-download-orchestrator.js';
import {
  createProjectTemplateArtifactDownloadPort,
  type ProjectTemplateArtifactDownloadError,
} from '../../infra/github/project-template-artifact-download.js';
import {
  createProjectTemplateArtifactDownloadCoordinatorBridge,
  type ProjectTemplateArtifactDownloadDecisionEvent,
  type ProjectTemplateArtifactDownloadPolicy,
} from '../../infra/github/project-template-artifact-download-coordinator.js';
import type {
  ProjectTemplateArtifactSingleAttempt,
  ProjectTemplateArtifactSingleAttemptFailure,
  ProjectTemplateArtifactSingleAttemptSettlement,
} from '../../infra/github/project-template-artifact-download-attempt.js';
import {
  MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES,
} from '../../infra/github/project-template-artifact-download-contract.js';

const INPUT = Object.freeze({
  owner: 'octo',
  repo: 'demo',
  releaseId: 1,
  assetId: 2,
  maxBytes: MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES * 2,
} satisfies GithubTemplateArchiveAssetInput);

interface AttemptControl {
  readonly attempt: ProjectTemplateArtifactSingleAttempt;
  readonly pull: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  settlement?: ProjectTemplateArtifactSingleAttemptSettlement;
}

function controlledAttempt(
  onDispose: () => void = () => undefined,
): AttemptControl {
  const control = {} as AttemptControl;
  const pull = vi.fn((
    settlement: ProjectTemplateArtifactSingleAttemptSettlement,
  ) => {
    control.settlement = settlement;
    return undefined;
  });
  const dispose = vi.fn(() => {
    onDispose();
    return undefined;
  });
  Object.assign(control, {
    attempt: Object.freeze({ pull, dispose }) as unknown as
      ProjectTemplateArtifactSingleAttempt,
    pull,
    dispose,
  });
  return control;
}

function policy(
  decide: (event: ProjectTemplateArtifactDownloadDecisionEvent) => unknown,
): ProjectTemplateArtifactDownloadPolicy {
  return Object.freeze({
    decide: vi.fn(decide),
  }) as ProjectTemplateArtifactDownloadPolicy;
}

function iteratorFor(
  attempt: ProjectTemplateArtifactSingleAttempt,
  decisionPolicy: ProjectTemplateArtifactDownloadPolicy,
  signal?: AbortSignal,
): AsyncIterator<Uint8Array> {
  const bridge = createProjectTemplateArtifactDownloadCoordinatorBridge(
    attempt,
    decisionPolicy,
  );
  return iteratorForBridge(bridge, signal);
}

function iteratorForBridge(
  bridge: ReturnType<
  typeof createProjectTemplateArtifactDownloadCoordinatorBridge
  >,
  signal?: AbortSignal,
): AsyncIterator<Uint8Array> {
  return createProjectTemplateArtifactDownloadPort(
    Object.freeze({ deadlineMs: 1_000 }),
    Object.freeze({
      now: vi.fn(() => 100),
      setTimer: vi.fn(() => Object.freeze({ timer: true })),
      clearTimer: vi.fn(),
      start: vi.fn(() => bridge),
    }),
  ).openReleaseAsset({
    ...INPUT,
    ...(signal === undefined ? {} : { signal }),
  })[Symbol.asyncIterator]();
}

function failure(
  code: 'NETWORK' | 'INTERNAL' = 'NETWORK',
): ProjectTemplateArtifactSingleAttemptFailure {
  if (code === 'NETWORK') {
    return exactFailure({
      code,
      retryable: true,
      replaySafe: true,
    });
  }
  return exactFailure({
    code,
    retryable: false,
    replaySafe: false,
  });
}

function exactFailure<Value extends object>(value: Value): Readonly<Value> {
  return Object.freeze(Object.assign(Object.create(null) as object, value));
}

async function expectCode(
  pending: PromiseLike<unknown>,
  code: ProjectTemplateArtifactDownloadError['code'],
): Promise<void> {
  await expect(pending).rejects.toEqual(expect.objectContaining({ code }));
}

describe('project-template artifact download D3 coordinator', () => {
  it('stays cold until D1 pulls and disposes an untouched attempt exactly once', async () => {
    const first = controlledAttempt();
    const iterator = iteratorFor(first.attempt, policy(() => undefined));

    expect(first.pull).not.toHaveBeenCalled();
    const pending = iterator.next();
    expect(first.pull).toHaveBeenCalledTimes(1);

    await iterator.return!();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(first.dispose).toHaveBeenCalledTimes(1);
    await iterator.return!();
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps D1 pending until policy selects retry and resolves the same next', async () => {
    const first = controlledAttempt();
    const second = controlledAttempt();
    const reason = failure();
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    const decide = vi.fn((value) => {
      event = value;
      return undefined;
    });
    const pending = iteratorFor(first.attempt, policy(decide)).next();
    first.settlement!.fail(reason);

    expect(decide).toHaveBeenCalledTimes(1);
    expect(event.failure).toBe(reason);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    let settled = false;
    void Promise.resolve(pending).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    if (event.kind !== 'retryable') throw new Error('expected retryable');
    expect(event.control.retry(second.attempt)).toBeUndefined();
    expect(second.pull).toHaveBeenCalledTimes(1);
    second.settlement!.chunk(Uint8Array.from([7]));
    await expect(pending).resolves.toEqual({
      value: Uint8Array.from([7]),
      done: false,
    });
  });

  it('reports terminal reason identity before fail selects BRIDGE_FAILURE', async () => {
    const first = controlledAttempt();
    const reason = failure('INTERNAL');
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    const pending = iteratorFor(first.attempt, policy((value) => {
      event = value;
      return undefined;
    })).next();

    first.settlement!.fail(reason);
    expect(event.kind).toBe('terminal');
    expect(event.failure).toBe(reason);
    expect(() => Reflect.apply(event.control.fail, {}, [])).toThrow();
    event.control.fail();
    await expectCode(pending, 'BRIDGE_FAILURE');
  });

  it('forces a retryable failure terminal after any delivered chunk', async () => {
    const first = controlledAttempt();
    const events: ProjectTemplateArtifactDownloadDecisionEvent[] = [];
    const iterator = iteratorFor(first.attempt, policy((event) => {
      events.push(event);
      return undefined;
    }));
    const chunk = iterator.next();
    first.settlement!.chunk(Uint8Array.from([1]));
    await expect(chunk).resolves.toEqual({
      value: Uint8Array.from([1]),
      done: false,
    });

    const terminal = iterator.next();
    first.settlement!.fail(failure());
    expect(events[0]?.kind).toBe('terminal');
    expect(events[0]?.failure).toEqual({
      code: 'INTERNAL',
      retryable: false,
      replaySafe: false,
    });
    events[0]!.control.fail();
    await expectCode(terminal, 'BRIDGE_FAILURE');
  });

  it('preserves a post-delivery HTTP 503 non-retryable reason identity', async () => {
    const first = controlledAttempt();
    const reason = Object.freeze(Object.assign(Object.create(null) as object, {
      code: 'HTTP_STATUS' as const,
      statusCode: 503,
      retryable: false as const,
      replaySafe: false as const,
    }));
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    const iterator = iteratorFor(first.attempt, policy((value) => {
      event = value;
      return undefined;
    }));
    const chunk = iterator.next();
    first.settlement!.chunk(Uint8Array.from([1]));
    await expect(chunk).resolves.toEqual({
      value: Uint8Array.from([1]),
      done: false,
    });

    const terminal = iterator.next();
    first.settlement!.fail(reason);
    expect(event.kind).toBe('terminal');
    expect(event.failure).toBe(reason);
    event.control.fail();
    await expectCode(terminal, 'BRIDGE_FAILURE');
  });

  it.each([
    ['before', 'HTTP_STATUS', 200, false],
    ['before', 'NETWORK', undefined, false],
    ['before', 'HTTP_STATUS', 503, false],
    ['before', 'HTTP_STATUS', 401, true],
    ['after', 'HTTP_STATUS', 503, true],
    ['after', 'NETWORK', undefined, true],
    ['after', 'HTTP_STATUS', 200, false],
  ] as const)(
    'normalizes %s-delivery %s %s identity=%s',
    async (delivery, code, statusCode, preservesIdentity) => {
      const first = controlledAttempt();
      const reason = exactFailure({
        code,
        ...(statusCode === undefined ? {} : { statusCode }),
        retryable: false as const,
        replaySafe: false as const,
      }) as ProjectTemplateArtifactSingleAttemptFailure;
      let event!: ProjectTemplateArtifactDownloadDecisionEvent;
      const iterator = iteratorFor(first.attempt, policy((value) => {
        event = value;
        return undefined;
      }));
      if (delivery === 'after') {
        const chunk = iterator.next();
        first.settlement!.chunk(Uint8Array.from([1]));
        await expect(chunk).resolves.toEqual({
          value: Uint8Array.from([1]),
          done: false,
        });
      }
      const terminal = iterator.next();
      first.settlement!.fail(reason);

      expect(event.kind).toBe('terminal');
      if (preservesIdentity) {
        expect(event.failure).toBe(reason);
      } else {
        expect(event.failure).toEqual({
          code: 'INTERNAL',
          retryable: false,
          replaySafe: false,
        });
        expect(event.failure).not.toBe(reason);
      }
      event.control.fail();
      await expectCode(terminal, 'BRIDGE_FAILURE');
    },
  );

  it.each([
    {
      code: 'HTTP_STATUS',
      statusCode: 401,
      retryable: true,
      replaySafe: true,
    },
    {
      code: 'HTTP_STATUS',
      statusCode: 503,
      retryable: false,
      replaySafe: false,
    },
    {
      code: 'NETWORK',
      retryable: true,
    },
  ])('maps a contract-breaking failure %# to INTERNAL', async (invalid) => {
    const first = controlledAttempt();
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    const pending = iteratorFor(first.attempt, policy((value) => {
      event = value;
      return undefined;
    })).next();

    first.settlement!.fail(
      invalid as unknown as ProjectTemplateArtifactSingleAttemptFailure,
    );
    expect(event.kind).toBe('terminal');
    expect(event.failure).toEqual({
      code: 'INTERNAL',
      retryable: false,
      replaySafe: false,
    });
    event.control.fail();
    await expectCode(pending, 'BRIDGE_FAILURE');
  });

  it.each([
    Object.freeze({
      code: 'NETWORK',
      retryable: true,
      replaySafe: true,
    }),
    Object.freeze(Object.defineProperties(Object.create(null), {
      code: { enumerable: false, value: 'NETWORK' },
      retryable: { enumerable: true, value: true },
      replaySafe: { enumerable: true, value: true },
    })),
    Object.freeze(Object.assign(
      Object.create({ toJSON: () => 'private failure' }) as object,
      { code: 'NETWORK', retryable: true, replaySafe: true },
    )),
  ])('rejects a non-D2 failure surface %# as INTERNAL', async (invalid) => {
    const first = controlledAttempt();
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    const pending = iteratorFor(first.attempt, policy((value) => {
      event = value;
      return undefined;
    })).next();

    first.settlement!.fail(
      invalid as unknown as ProjectTemplateArtifactSingleAttemptFailure,
    );
    expect(event.kind).toBe('terminal');
    expect(event.failure).toEqual({
      code: 'INTERNAL',
      retryable: false,
      replaySafe: false,
    });
    event.control.fail();
    await expectCode(pending, 'BRIDGE_FAILURE');
  });

  it.each([
    MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES - 1,
    MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES,
  ])('forwards a bounded %i byte chunk', async (size) => {
    const first = controlledAttempt();
    const pending = iteratorFor(first.attempt, policy(() => undefined)).next();
    first.settlement!.chunk(new Uint8Array(size));
    await expect(pending).resolves.toEqual({
      value: new Uint8Array(size),
      done: false,
    });
  });

  it('rejects a 65537-byte chunk without splitting or buffering it', async () => {
    const first = controlledAttempt();
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    const pending = iteratorFor(first.attempt, policy((value) => {
      event = value;
      return undefined;
    })).next();
    first.settlement!.chunk(
      new Uint8Array(MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES + 1),
    );

    expect(event.kind).toBe('terminal');
    expect(event.failure).toEqual({
      code: 'OUTPUT_LIMIT',
      retryable: false,
      replaySafe: false,
    });
    event.control.fail();
    await expectCode(pending, 'BRIDGE_FAILURE');
  });

  it.each(['throw', 'return'] as const)(
    'fails when policy %s violates its callback contract',
    async (fault) => {
      const first = controlledAttempt();
      const pending = iteratorFor(first.attempt, policy(() => {
        if (fault === 'throw') throw new Error('private policy cause');
        return 1;
      })).next();
      first.settlement!.fail(failure());
      await expectCode(pending, 'BRIDGE_FAILURE');
    },
  );

  it('disposes a policy-selected next attempt when policy later violates', async () => {
    const first = controlledAttempt();
    const selected = controlledAttempt();
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    const pending = iteratorFor(first.attempt, policy((value) => {
      event = value;
      if (value.kind !== 'retryable') throw new Error('expected retryable');
      value.control.retry(selected.attempt);
      return 1;
    })).next();

    first.settlement!.fail(failure());
    await expectCode(pending, 'BRIDGE_FAILURE');
    expect(selected.pull).not.toHaveBeenCalled();
    expect(selected.dispose).toHaveBeenCalledTimes(1);
    expect(() => event.control.fail()).toThrow();
    expect(selected.dispose).toHaveBeenCalledTimes(1);
  });

  it('uses shared control methods without retaining per-decision closures', async () => {
    const firstAttempt = controlledAttempt();
    const secondAttempt = controlledAttempt();
    let firstEvent!: ProjectTemplateArtifactDownloadDecisionEvent;
    let secondEvent!: ProjectTemplateArtifactDownloadDecisionEvent;
    const firstPending = iteratorFor(firstAttempt.attempt, policy((value) => {
      firstEvent = value;
      return undefined;
    })).next();
    const secondPending = iteratorFor(
      secondAttempt.attempt,
      policy((value) => {
        secondEvent = value;
        return undefined;
      }),
    ).next();
    firstAttempt.settlement!.fail(failure('INTERNAL'));
    secondAttempt.settlement!.fail(failure('INTERNAL'));

    expect(firstEvent.control.fail).toBe(secondEvent.control.fail);
    expect(Reflect.ownKeys(firstEvent.control)).toEqual(['fail']);
    firstEvent.control.fail();
    secondEvent.control.fail();
    await Promise.all([
      expectCode(firstPending, 'BRIDGE_FAILURE'),
      expectCode(secondPending, 'BRIDGE_FAILURE'),
    ]);
  });

  it('revokes old callbacks and disposes a next attempt passed to a late control', async () => {
    const first = controlledAttempt();
    const late = controlledAttempt();
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    const iterator = iteratorFor(first.attempt, policy((value) => {
      event = value;
      return undefined;
    }));
    const pending = iterator.next();
    first.settlement!.fail(failure());
    await iterator.return!();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    if (event.kind !== 'retryable') throw new Error('expected retryable');

    expect(() => event.control.retry(late.attempt)).toThrow();
    expect(late.dispose).toHaveBeenCalledTimes(1);
    first.settlement!.chunk(Uint8Array.from([9]));
    expect(late.pull).not.toHaveBeenCalled();
  });

  it('does not dispose the live retry generation on a duplicate control call', async () => {
    const first = controlledAttempt();
    const second = controlledAttempt();
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    const pending = iteratorFor(first.attempt, policy((value) => {
      event = value;
      return undefined;
    })).next();
    first.settlement!.fail(failure());
    if (event.kind !== 'retryable') throw new Error('expected retryable');

    event.control.retry(second.attempt);
    expect(() => event.control.retry(second.attempt)).toThrow();
    expect(second.dispose).not.toHaveBeenCalled();
    second.settlement!.chunk(Uint8Array.from([3]));
    await expect(pending).resolves.toEqual({
      value: Uint8Array.from([3]),
      done: false,
    });
  });

  it('claims a retry attempt before returning to reentrant policy code', async () => {
    const first = controlledAttempt();
    const next = controlledAttempt();
    let duplicateError: unknown;
    const pending = iteratorFor(first.attempt, policy((event) => {
      if (event.kind !== 'retryable') throw new Error('expected retryable');
      event.control.retry(next.attempt);
      try {
        createProjectTemplateArtifactDownloadCoordinatorBridge(
          next.attempt,
          policy(() => undefined),
        );
      } catch (error) {
        duplicateError = error;
      }
      return undefined;
    })).next();
    first.settlement!.fail(failure());

    expect(duplicateError).toBeInstanceOf(TypeError);
    expect(next.pull).toHaveBeenCalledTimes(1);
    next.settlement!.chunk(Uint8Array.from([5]));
    await expect(pending).resolves.toEqual({
      value: Uint8Array.from([5]),
      done: false,
    });
  });

  it('rejects the same initial attempt in two coordinators atomically', async () => {
    const first = controlledAttempt();
    const bridge = createProjectTemplateArtifactDownloadCoordinatorBridge(
      first.attempt,
      policy(() => undefined),
    );

    expect(() => createProjectTemplateArtifactDownloadCoordinatorBridge(
      first.attempt,
      policy(() => undefined),
    )).toThrow(TypeError);
    const iterator = iteratorForBridge(bridge);
    const pending = iterator.next();
    await iterator.return!();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it('revokes and cleans the active attempt on abort and concurrent next', async () => {
    const abortedAttempt = controlledAttempt();
    const controller = new AbortController();
    const abortedIterator = iteratorFor(
      abortedAttempt.attempt,
      policy(() => undefined),
      controller.signal,
    );
    const aborted = abortedIterator.next();
    controller.abort('private reason');
    await expectCode(aborted, 'ABORTED');
    expect(abortedAttempt.dispose).toHaveBeenCalledTimes(1);

    const concurrentAttempt = controlledAttempt();
    const concurrentIterator = iteratorFor(
      concurrentAttempt.attempt,
      policy(() => undefined),
    );
    const first = concurrentIterator.next();
    const second = concurrentIterator.next();
    await Promise.all([
      expectCode(first, 'CONCURRENT_NEXT'),
      expectCode(second, 'CONCURRENT_NEXT'),
    ]);
    expect(concurrentAttempt.dispose).toHaveBeenCalledTimes(1);
  });

  it('revokes a policy decision when the D1 deadline expires', async () => {
    const first = controlledAttempt();
    const late = controlledAttempt();
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    let timerCallback!: () => void;
    let now = 100;
    const bridge = createProjectTemplateArtifactDownloadCoordinatorBridge(
      first.attempt,
      policy((value) => {
        event = value;
        return undefined;
      }),
    );
    const iterator = createProjectTemplateArtifactDownloadPort(
      Object.freeze({ deadlineMs: 1_000 }),
      Object.freeze({
        now: vi.fn(() => now),
        setTimer: vi.fn((callback: () => void) => {
          timerCallback = callback;
          return Object.freeze({ timer: true });
        }),
        clearTimer: vi.fn(),
        start: vi.fn(() => bridge),
      }),
    ).openReleaseAsset(INPUT)[Symbol.asyncIterator]();
    const pending = iterator.next();
    first.settlement!.fail(failure());
    now = 1_001;
    timerCallback();

    await expectCode(pending, 'TIMEOUT');
    if (event.kind !== 'retryable') throw new Error('expected retryable');
    expect(() => event.control.retry(late.attempt)).toThrow();
    expect(late.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['throw', 'return'] as const)(
    'fails attempt pull %s without consulting retry policy',
    async (fault) => {
      const dispose = vi.fn(() => undefined);
      const attempt = Object.freeze({
        pull: vi.fn(() => {
          if (fault === 'throw') throw new Error('private attempt cause');
          return 1;
        }),
        dispose,
      }) as unknown as ProjectTemplateArtifactSingleAttempt;
      const decide = vi.fn();
      const pending = iteratorFor(attempt, policy((value) => {
        decide(value);
        return undefined;
      })).next();

      await expectCode(pending, 'BRIDGE_FAILURE');
      expect(decide).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['chunk', 'throw'],
    ['done', 'throw'],
    ['fail', 'throw'],
    ['chunk', 'return'],
    ['done', 'return'],
    ['fail', 'return'],
  ] as const)(
    'discards synchronous %s when attempt pull later %s',
    async (event, outcome) => {
      const dispose = vi.fn(() => undefined);
      const decide = vi.fn();
      const next = controlledAttempt();
      const attempt = Object.freeze({
        pull(
          settlement: ProjectTemplateArtifactSingleAttemptSettlement,
        ): undefined {
          if (event === 'chunk') settlement.chunk(Uint8Array.from([7]));
          else if (event === 'done') settlement.done();
          else settlement.fail(failure());
          if (outcome === 'throw') throw new Error('late pull secret');
          return 1 as never;
        },
        dispose,
      }) as unknown as ProjectTemplateArtifactSingleAttempt;
      const pending = iteratorFor(attempt, policy((value) => {
        decide(value);
        if (value.kind === 'retryable') value.control.retry(next.attempt);
        else value.control.fail();
        return undefined;
      })).next();

      await expectCode(pending, 'BRIDGE_FAILURE');
      expect(decide).not.toHaveBeenCalled();
      expect(next.pull).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('fails a pull that emits more than one synchronous event', async () => {
    const dispose = vi.fn(() => undefined);
    const decide = vi.fn();
    const attempt = Object.freeze({
      pull(
        settlement: ProjectTemplateArtifactSingleAttemptSettlement,
      ): undefined {
        settlement.chunk(Uint8Array.from([1]));
        settlement.chunk(
          new Uint8Array(MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES),
        );
        return undefined;
      },
      dispose,
    }) as unknown as ProjectTemplateArtifactSingleAttempt;
    const pending = iteratorFor(attempt, policy((value) => {
      decide(value);
      return undefined;
    })).next();

    await expectCode(pending, 'BRIDGE_FAILURE');
    expect(decide).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('snapshots a synchronous chunk before attempt pull mutates its source', async () => {
    const source = Uint8Array.from([7]);
    const attempt = Object.freeze({
      pull(
        settlement: ProjectTemplateArtifactSingleAttemptSettlement,
      ): undefined {
        settlement.chunk(source);
        source[0] = 9;
        return undefined;
      },
      dispose: vi.fn(() => undefined),
    }) as unknown as ProjectTemplateArtifactSingleAttempt;
    const pending = iteratorFor(attempt, policy(() => undefined)).next();

    await expect(pending).resolves.toEqual({
      value: Uint8Array.from([7]),
      done: false,
    });
  });

  it.each(['return', 'throw'] as const)(
    'contains synchronous iterator.%s reentry during attempt pull',
    async (operation) => {
      let iterator!: AsyncIterator<Uint8Array>;
      let terminal!: PromiseLike<unknown>;
      let retained!: ProjectTemplateArtifactSingleAttemptSettlement;
      const dispose = vi.fn(() => undefined);
      const attempt = Object.freeze({
        pull(
          settlement: ProjectTemplateArtifactSingleAttemptSettlement,
        ): undefined {
          retained = settlement;
          terminal = operation === 'return'
            ? iterator.return!()
            : iterator.throw!(new Error('private caller cause'));
          settlement.chunk(Uint8Array.from([7]));
          return undefined;
        },
        dispose,
      }) as unknown as ProjectTemplateArtifactSingleAttempt;
      iterator = iteratorFor(attempt, policy(() => undefined));
      const pending = iterator.next();

      if (operation === 'return') {
        await expect(terminal).resolves.toEqual({
          value: undefined,
          done: true,
        });
        await expect(pending).resolves.toEqual({
          value: undefined,
          done: true,
        });
      } else {
        await expectCode(terminal, 'CLOSED');
        await expectCode(pending, 'CLOSED');
      }
      retained.chunk(Uint8Array.from([9]));
      expect(dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('invokes policy and attempt methods with their original receivers', async () => {
    const receivers: unknown[] = [];
    let attemptSettlement!: ProjectTemplateArtifactSingleAttemptSettlement;
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    const attempt = Object.freeze({
      pull(
        this: unknown,
        settlement: ProjectTemplateArtifactSingleAttemptSettlement,
      ): undefined {
        receivers.push(this);
        attemptSettlement = settlement;
        return undefined;
      },
      dispose(this: unknown): undefined {
        receivers.push(this);
        return undefined;
      },
    }) as unknown as ProjectTemplateArtifactSingleAttempt;
    const decisionPolicy = Object.freeze({
      decide(
        this: unknown,
        value: ProjectTemplateArtifactDownloadDecisionEvent,
      ): undefined {
        receivers.push(this);
        event = value;
        return undefined;
      },
    });
    const pending = iteratorFor(attempt, decisionPolicy).next();
    attemptSettlement.fail(failure('INTERNAL'));
    event.control.fail();
    await expectCode(pending, 'BRIDGE_FAILURE');

    expect(receivers).toEqual([attempt, attempt, decisionPolicy]);
  });

  it('contains cleanup reentry and keeps first terminal decision authoritative', async () => {
    let event!: ProjectTemplateArtifactDownloadDecisionEvent;
    let first!: AttemptControl;
    first = controlledAttempt(() => {
      first.settlement?.fail(failure());
    });
    const pending = iteratorFor(first.attempt, policy((value) => {
      event = value;
      return undefined;
    })).next();
    first.settlement!.fail(failure('INTERNAL'));

    event.control.fail();
    await expectCode(pending, 'BRIDGE_FAILURE');
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(() => event.control.fail()).toThrow();
  });
});
