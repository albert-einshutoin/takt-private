import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTemplateArtifactSingleAttempt,
  type ProjectTemplateArtifactDownloadAttemptDependencies,
  type ProjectTemplateArtifactSingleAttempt,
  type ProjectTemplateArtifactSingleAttemptFailure,
  type ProjectTemplateArtifactSingleAttemptSettlement,
} from '../../infra/github/project-template-artifact-download-attempt.js';
import type {
  DisposableProjectTemplateGhCredential,
  ProjectTemplateGithubReleaseAssetRequest,
  ProjectTemplateGithubReleaseAssetRequestHandlers,
} from '../../infra/github/project-template-gh-auth.js';
import type {
  DisposableProjectTemplateArtifactRedirectGrant,
  DisposableProjectTemplateArtifactRedirectHop,
  ProjectTemplateArtifactPinnedTransport,
  ProjectTemplateArtifactPinnedTransportHandlers,
} from '../../infra/github/project-template-artifact-redirect.js';

const INPUT = Object.freeze({
  owner: 'octo',
  repo: 'demo',
  releaseId: 1,
  assetId: 2,
  maxBytes: 1024,
});

type Outcome =
  | { readonly kind: 'chunk'; readonly value: Uint8Array }
  | { readonly kind: 'done' }
  | {
    readonly kind: 'fail';
    readonly failure: ProjectTemplateArtifactSingleAttemptFailure;
  };

interface FakeTransport {
  readonly start: ReturnType<typeof vi.fn>;
  readonly pause: ReturnType<typeof vi.fn>;
  readonly resume: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
}

function fakeTransport(
  onStart: () => void = () => undefined,
  resumes: Array<() => void> = [],
  onPause: () => void = () => undefined,
): FakeTransport {
  return Object.freeze({
    start: vi.fn(() => {
      onStart();
      return undefined;
    }),
    pause: vi.fn(() => {
      onPause();
      return undefined;
    }),
    resume: vi.fn(() => {
      resumes.shift()?.();
      return undefined;
    }),
    destroy: vi.fn(() => undefined),
    dispose: vi.fn(() => undefined),
  });
}

function invalidTransportCandidate(
  kind: 'undefined' | 'null' | 'empty' | 'proxy' | 'accessor',
): { readonly value: unknown; readonly accessor?: ReturnType<typeof vi.fn> } {
  if (kind === 'undefined') return { value: undefined };
  if (kind === 'null') return { value: null };
  if (kind === 'empty') return { value: Object.freeze({}) };
  if (kind === 'proxy') return { value: new Proxy({}, {}) };
  const accessor = vi.fn(() => vi.fn());
  const value = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperties(value, {
    start: { enumerable: true, get: accessor },
    pause: { enumerable: true, value: vi.fn() },
    resume: { enumerable: true, value: vi.fn() },
    destroy: { enumerable: true, value: vi.fn() },
    dispose: { enumerable: true, value: vi.fn() },
  });
  return { value: Object.freeze(value), accessor };
}

function invalidGrantCandidate(
  kind: 'undefined' | 'null' | 'empty' | 'proxy' | 'accessor',
): { readonly value: unknown; readonly accessor?: ReturnType<typeof vi.fn> } {
  if (kind === 'undefined') return { value: undefined };
  if (kind === 'null') return { value: null };
  if (kind === 'empty') return { value: Object.freeze({}) };
  if (kind === 'proxy') return { value: new Proxy({}, {}) };
  const accessor = vi.fn(() => {
    throw new Error('grant getter secret');
  });
  const value = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperties(value, {
    consume: { enumerable: true, get: accessor },
    dispose: { enumerable: true, value: vi.fn() },
  });
  return { value: Object.freeze(value), accessor };
}

function invalidHopCandidate(
  kind: 'undefined' | 'null' | 'empty' | 'proxy' | 'accessor',
): { readonly value: unknown; readonly accessor?: ReturnType<typeof vi.fn> } {
  if (kind === 'undefined') return { value: undefined };
  if (kind === 'null') return { value: null };
  if (kind === 'empty') return { value: Object.freeze({}) };
  if (kind === 'proxy') return { value: new Proxy({}, {}) };
  const accessor = vi.fn(() => {
    throw new Error('hop getter secret');
  });
  const value = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(value, 'dispose', {
    enumerable: true,
    get: accessor,
  });
  return { value: Object.freeze(value), accessor };
}

function credential(): DisposableProjectTemplateGhCredential {
  return Object.freeze({
    dispose: vi.fn(() => undefined),
  });
}

function settlement(outcomes: Outcome[]):
ProjectTemplateArtifactSingleAttemptSettlement {
  return Object.freeze({
    chunk(value: Uint8Array): undefined {
      outcomes.push(Object.freeze({ kind: 'chunk', value }));
      return undefined;
    },
    done(): undefined {
      outcomes.push(Object.freeze({ kind: 'done' }));
      return undefined;
    },
    fail(failure: ProjectTemplateArtifactSingleAttemptFailure): undefined {
      outcomes.push(Object.freeze({ kind: 'fail', failure }));
      return undefined;
    },
  });
}

function dependencies(
  createAuthenticatedRequest:
  ProjectTemplateArtifactDownloadAttemptDependencies[
  'createAuthenticatedRequest'
  ],
  createPinnedTransport:
  ProjectTemplateArtifactDownloadAttemptDependencies[
  'createPinnedTransport'
  ] = vi.fn(),
  scheduleHandoff?: (callback: () => void) => void,
): ProjectTemplateArtifactDownloadAttemptDependencies {
  return scheduleHandoff === undefined
    ? Object.freeze({ createAuthenticatedRequest, createPinnedTransport })
    : Object.freeze({
      createAuthenticatedRequest,
      createPinnedTransport,
      scheduleHandoff,
    });
}

function expectFailure(
  outcomes: Outcome[],
  expected: {
    readonly code: ProjectTemplateArtifactSingleAttemptFailure['code'];
    readonly retryable: boolean;
    readonly replaySafe?: boolean;
    readonly statusCode?: number;
  },
): void {
  const normalized = {
    code: expected.code,
    retryable: expected.retryable,
    replaySafe: expected.replaySafe ?? expected.retryable,
    ...(expected.statusCode === undefined
      ? {}
      : { statusCode: expected.statusCode }),
  };
  expect(outcomes).toHaveLength(1);
  const outcome = outcomes[0]!;
  expect(outcome.kind).toBe('fail');
  if (outcome.kind !== 'fail') return;
  expect(outcome.failure).toEqual(normalized);
  expect(Object.getPrototypeOf(outcome.failure)).toBeNull();
  expect(Object.isFrozen(outcome.failure)).toBe(true);
  expect(Reflect.ownKeys(outcome.failure)).toEqual(Object.keys(normalized));
}

describe('project-template artifact single attempt', () => {
  it('stays cold until the first pull and exposes no credential state', () => {
    const createAuthenticatedRequest = vi.fn();
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(createAuthenticatedRequest),
    );

    expect(createAuthenticatedRequest).not.toHaveBeenCalled();
    expect(inspect(attempt)).not.toContain('credential');
  });

  it('delivers a direct 200 response one demanded copied chunk at a time', () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const source = Buffer.from([1]);
    const transport = fakeTransport(
      () => handlers.onResponse(200),
      [
        () => handlers.onData(source),
        () => {
          handlers.onData(Uint8Array.from([2]));
          handlers.onEnd();
        },
      ],
    );
    const createRequest = vi.fn((_credential, plan) => {
      handlers = plan.handlers;
      return transport as ProjectTemplateGithubReleaseAssetRequest;
    });
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(createRequest),
    );

    expect(attempt.pull(settlement(outcomes))).toBeUndefined();
    source[0] = 9;
    expect(outcomes[0]).toMatchObject({
      kind: 'chunk',
      value: Uint8Array.from([1]),
    });
    if (outcomes[0]?.kind === 'chunk') {
      expect(Object.getPrototypeOf(outcomes[0].value))
        .toBe(Uint8Array.prototype);
    }
    expect(attempt.pull(settlement(outcomes))).toBeUndefined();
    expect(attempt.pull(settlement(outcomes))).toBeUndefined();

    expect(outcomes).toEqual([
      { kind: 'chunk', value: Uint8Array.from([1]) },
      { kind: 'chunk', value: Uint8Array.from([2]) },
      { kind: 'done' },
    ]);
    expect(transport.pause).toHaveBeenCalledTimes(2);
    expect(transport.destroy).not.toHaveBeenCalled();
    expect(transport.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([1, 3])(
    'defers redirect ownership and streams pinned hop scenario %i',
    async () => {
      let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      let pinnedHandlers!: ProjectTemplateArtifactPinnedTransportHandlers;
      const hop = Object.freeze({
        dispose: vi.fn(() => undefined),
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const grant = Object.freeze({
        consume: vi.fn(() => hop),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(
        () => authHandlers.onRedirect(grant),
      );
      const pinned = fakeTransport(
        () => pinnedHandlers.onResponse(200),
        [
          () => pinnedHandlers.onData(Uint8Array.from([3])),
          () => {
            pinnedHandlers.onData(Uint8Array.from([4]));
            pinnedHandlers.onEnd();
          },
        ],
      );
      const createPinned = vi.fn((_hop, handlers) => {
        pinnedHandlers = handlers;
        return pinned as ProjectTemplateArtifactPinnedTransport;
      });
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            authHandlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          createPinned,
        ),
      );
      const outcomes: Outcome[] = [];

      attempt.pull(settlement(outcomes));
      expect(grant.consume).not.toHaveBeenCalled();
      expect(createPinned).not.toHaveBeenCalled();
      await Promise.resolve();
      attempt.pull(settlement(outcomes));
      attempt.pull(settlement(outcomes));

      expect(outcomes).toEqual([
        { kind: 'chunk', value: Uint8Array.from([3]) },
        { kind: 'chunk', value: Uint8Array.from([4]) },
        { kind: 'done' },
      ]);
      expect(grant.consume).toHaveBeenCalledTimes(1);
      expect(authenticated.destroy).not.toHaveBeenCalled();
      expect(authenticated.dispose).toHaveBeenCalledTimes(1);
      expect(pinned.pause).not.toHaveBeenCalled();
      expect(pinned.destroy).not.toHaveBeenCalled();
      expect(pinned.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [401, false],
    [403, false],
    [404, false],
    [408, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [418, false],
  ] as const)('classifies HTTP %i retryable=%s', (statusCode, retryable) => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const transport = fakeTransport(() => handlers.onResponse(statusCode));
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );
    const outcomes: Outcome[] = [];

    attempt.pull(settlement(outcomes));

    expectFailure(outcomes, { code: 'HTTP_STATUS', retryable, statusCode });
    expect(inspect(attempt)).not.toContain(String(statusCode));
    expect(transport.destroy).toHaveBeenCalledTimes(1);
    expect(transport.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, 99, 600])(
    'rejects invalid HTTP status %s without reflecting it',
    (statusCode) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const transport = fakeTransport(() => handlers.onResponse(statusCode));
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));

      expectFailure(outcomes, {
        code: 'INVALID_RESPONSE',
        retryable: false,
      });
    },
  );

  it.each([
    ['onResponseAborted', 'NETWORK', true],
    ['onResponseError', 'NETWORK', true],
    ['onResponseClose', 'NETWORK', true],
    ['onRequestError', 'NETWORK', true],
    ['onRequestClose', 'NETWORK', true],
    ['onInvalidResponse', 'INVALID_RESPONSE', false],
  ] as const)(
    'classifies authenticated %s as %s',
    (event, code, retryable) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const transport = fakeTransport(() => handlers[event]());
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));

      expectFailure(outcomes, { code, retryable });
    },
  );

  it.each(['onRequestError', 'onRequestClose'] as const)(
    'ignores authenticated %s after direct body authority is established',
    (event) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const transport = fakeTransport(
        () => {
          handlers.onResponse(200);
          handlers[event]();
        },
        [() => handlers.onData(Uint8Array.from([1]))],
      );
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));

      expect(outcomes).toEqual([
        { kind: 'chunk', value: Uint8Array.from([1]) },
      ]);
      expect(transport.destroy).not.toHaveBeenCalled();
    },
  );

  it('classifies pinned DNS rejection as terminal', async () => {
    let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    let pinnedHandlers!: ProjectTemplateArtifactPinnedTransportHandlers;
    const hop = Object.freeze({
      dispose: vi.fn(() => undefined),
    }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
    const grant = Object.freeze({
      consume: vi.fn(() => hop),
      dispose: vi.fn(() => undefined),
    }) as DisposableProjectTemplateArtifactRedirectGrant;
    const authenticated = fakeTransport(
      () => authHandlers.onRedirect(grant),
    );
    const pinned = fakeTransport(() => pinnedHandlers.onDnsRejected());
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(
        vi.fn((_credential, plan) => {
          authHandlers = plan.handlers;
          return authenticated as ProjectTemplateGithubReleaseAssetRequest;
        }),
        vi.fn((_hop, handlers) => {
          pinnedHandlers = handlers;
          return pinned as ProjectTemplateArtifactPinnedTransport;
        }),
      ),
    );

    attempt.pull(settlement(outcomes));
    await Promise.resolve();

    expectFailure(outcomes, { code: 'DNS_REJECTED', retryable: false });
  });

  it('enforces exact cumulative maxBytes and fails on maxBytes + 1', () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const transport = fakeTransport(
      () => handlers.onResponse(200),
      [
        () => handlers.onData(Uint8Array.from([1])),
        () => handlers.onData(Uint8Array.from([2])),
        () => handlers.onData(Uint8Array.from([3])),
      ],
    );
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      Object.freeze({ ...INPUT, maxBytes: 2 }),
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(settlement(outcomes));
    attempt.pull(settlement(outcomes));
    attempt.pull(settlement(outcomes));

    expect(outcomes.slice(0, 2)).toEqual([
      { kind: 'chunk', value: Uint8Array.from([1]) },
      { kind: 'chunk', value: Uint8Array.from([2]) },
    ]);
    expectFailure(outcomes.slice(2), {
      code: 'OUTPUT_LIMIT',
      retryable: false,
    });
  });

  it('enforces the same cumulative maxBytes boundary after pinned handoff', async () => {
    let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    let pinnedHandlers!: ProjectTemplateArtifactPinnedTransportHandlers;
    const hop = Object.freeze({
      dispose: vi.fn(() => undefined),
    }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
    const grant = Object.freeze({
      consume: vi.fn(() => hop),
      dispose: vi.fn(() => undefined),
    }) as DisposableProjectTemplateArtifactRedirectGrant;
    const authenticated = fakeTransport(
      () => authHandlers.onRedirect(grant),
    );
    const pinned = fakeTransport(
      () => pinnedHandlers.onResponse(200),
      [
        () => pinnedHandlers.onData(Uint8Array.from([1])),
        () => pinnedHandlers.onData(Uint8Array.from([2])),
        () => pinnedHandlers.onData(Uint8Array.from([3])),
      ],
    );
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      Object.freeze({ ...INPUT, maxBytes: 2 }),
      dependencies(
        vi.fn((_credential, plan) => {
          authHandlers = plan.handlers;
          return authenticated as ProjectTemplateGithubReleaseAssetRequest;
        }),
        vi.fn((_hop, handlers) => {
          pinnedHandlers = handlers;
          return pinned as ProjectTemplateArtifactPinnedTransport;
        }),
      ),
    );

    attempt.pull(settlement(outcomes));
    await Promise.resolve();
    attempt.pull(settlement(outcomes));
    attempt.pull(settlement(outcomes));

    expect(outcomes.slice(0, 2)).toEqual([
      { kind: 'chunk', value: Uint8Array.from([1]) },
      { kind: 'chunk', value: Uint8Array.from([2]) },
    ]);
    expectFailure(outcomes.slice(2), {
      code: 'OUTPUT_LIMIT',
      retryable: false,
    });
    expect(pinned.pause).not.toHaveBeenCalled();
  });

  it('accepts Number.MAX_SAFE_INTEGER without unsafe cumulative addition', () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const transport = fakeTransport(
      () => handlers.onResponse(200),
      [() => handlers.onData(Uint8Array.from([1]))],
    );
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      Object.freeze({ ...INPUT, maxBytes: Number.MAX_SAFE_INTEGER }),
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(settlement(outcomes));

    expect(outcomes).toEqual([
      { kind: 'chunk', value: Uint8Array.from([1]) },
    ]);
  });

  it.each(['before', 'after', 'synchronous'] as const)(
    'fails closed when the handoff scheduler violates %s scheduling',
    async (fault) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const hop = Object.freeze({
        dispose: vi.fn(() => undefined),
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const grant = Object.freeze({
        consume: vi.fn(() => hop),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(() => handlers.onRedirect(grant));
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            handlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          vi.fn(),
          (callback) => {
            if (fault === 'before') throw new Error('scheduler secret');
            if (fault === 'synchronous') callback();
            else {
              queueMicrotask(callback);
              throw new Error('scheduler secret');
            }
          },
        ),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      expectFailure(outcomes, { code: 'INTERNAL', retryable: false });
      expect(grant.consume).not.toHaveBeenCalled();
      expect(grant.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('revokes a queued handoff across reentrant dispose', async () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    let attempt!: ReturnType<
      typeof createProjectTemplateArtifactSingleAttempt
    >;
    const hop = Object.freeze({
      dispose: vi.fn(() => undefined),
    }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
    const grant = Object.freeze({
      consume: vi.fn(() => hop),
      dispose: vi.fn(() => undefined),
    }) as DisposableProjectTemplateArtifactRedirectGrant;
    const authenticated = fakeTransport(() => handlers.onRedirect(grant));
    const outcomes: Outcome[] = [];
    attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(
        vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return authenticated as ProjectTemplateGithubReleaseAssetRequest;
        }),
        vi.fn(),
        (callback) => {
          attempt.dispose();
          queueMicrotask(callback);
        },
      ),
    );

    attempt.pull(settlement(outcomes));
    await Promise.resolve();

    expect(outcomes).toEqual([]);
    expect(grant.consume).not.toHaveBeenCalled();
    expect(grant.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['consume', 'factory', 'start'] as const)(
    'contains redirect %s throws',
    async (fault) => {
      let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      let pinnedHandlers!: ProjectTemplateArtifactPinnedTransportHandlers;
      const hop = Object.freeze({
        dispose: vi.fn(() => undefined),
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const grant = Object.freeze({
        consume: vi.fn(() => {
          if (fault === 'consume') throw new Error('location secret');
          return hop;
        }),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(
        () => authHandlers.onRedirect(grant),
      );
      const pinned = fakeTransport(() => {
        if (fault === 'start') throw new Error('address secret');
      });
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            authHandlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          vi.fn((_hop, handlers) => {
            pinnedHandlers = handlers;
            if (fault === 'factory') throw new Error('token secret');
            return pinned as ProjectTemplateArtifactPinnedTransport;
          }),
        ),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      expectFailure(outcomes, {
        code: fault === 'start' ? 'NETWORK' : 'INTERNAL',
        retryable: fault === 'start',
      });
      expect(inspect(attempt)).not.toMatch(/secret|token|location|address/);
      expect(pinnedHandlers === undefined || typeof pinnedHandlers).toBeTruthy();
    },
  );

  it.each(['factory', 'start'] as const)(
    'contains authenticated request %s throws',
    (fault) => {
      const transport = fakeTransport(() => {
        if (fault === 'start') throw new Error('signed secret');
      });
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn(() => {
          if (fault === 'factory') throw new Error('token secret');
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));

      expectFailure(outcomes, {
        code: fault === 'start' ? 'NETWORK' : 'INTERNAL',
        retryable: fault === 'start',
      });
      expect(inspect(attempt)).not.toContain('secret');
    },
  );

  it('rechecks authority after authenticated pause reentrantly disposes', () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    let attempt!: ReturnType<
      typeof createProjectTemplateArtifactSingleAttempt
    >;
    const outcomes: Outcome[] = [];
    const transport = fakeTransport(
      () => handlers.onResponse(200),
      [() => handlers.onData(Uint8Array.from([1]))],
      () => attempt.dispose(),
    );
    attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(settlement(outcomes));

    expect(outcomes).toEqual([]);
    expect(transport.destroy).toHaveBeenCalledTimes(1);
    expect(transport.dispose).toHaveBeenCalledTimes(1);
  });

  it('revokes retained callbacks before destructive dispose cleanup', () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const transport = fakeTransport(() => handlers.onResponse(200));
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(settlement(outcomes));
    expect(attempt.dispose()).toBeUndefined();
    handlers.onData(Uint8Array.from([9]));
    handlers.onEnd();
    handlers.onResponseError();

    expect(outcomes).toEqual([]);
    expect(transport.destroy).toHaveBeenCalledTimes(1);
    expect(transport.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('project-template artifact single attempt adversarial ordering', () => {
  it('drains an authenticated 200 emitted synchronously by the factory', () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const transport = fakeTransport(
      () => undefined,
      [() => handlers.onData(Uint8Array.from([1]))],
    );
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        handlers.onResponse(200);
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(settlement(outcomes));

    expect(outcomes).toEqual([
      { kind: 'chunk', value: Uint8Array.from([1]) },
    ]);
  });

  it.each(['onData', 'onEnd'] as const)(
    'rejects construction-time authenticated %s',
    (event) => {
      const transport = fakeTransport();
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          if (event === 'onData') {
            plan.handlers.onData(Uint8Array.from([1]));
          } else {
            plan.handlers.onEnd();
          }
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));

      expectFailure(outcomes, {
        code: 'INVALID_RESPONSE',
        retryable: false,
        replaySafe: false,
      });
    },
  );

  it('discards a latched response when the authenticated factory throws', () => {
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        plan.handlers.onResponse(200);
        throw new Error('after effect');
      })),
    );

    attempt.pull(settlement(outcomes));

    expectFailure(outcomes, {
      code: 'INTERNAL',
      retryable: false,
      replaySafe: false,
    });
  });

  it('disposes a latched redirect when the authenticated factory throws', () => {
    const grant = Object.freeze({
      consume: vi.fn(),
      dispose: vi.fn(() => undefined),
    }) as DisposableProjectTemplateArtifactRedirectGrant;
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        plan.handlers.onRedirect(grant);
        throw new Error('after redirect effect');
      })),
    );

    attempt.pull(settlement(outcomes));

    expectFailure(outcomes, {
      code: 'INTERNAL',
      retryable: false,
    });
    expect(grant.consume).not.toHaveBeenCalled();
    expect(grant.dispose).toHaveBeenCalledTimes(1);
  });

  it('bounds construction callback storage to one control event', () => {
    const transport = fakeTransport();
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        plan.handlers.onResponse(200);
        plan.handlers.onResponse(200);
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(settlement(outcomes));

    expectFailure(outcomes, {
      code: 'INVALID_RESPONSE',
      retryable: false,
      replaySafe: false,
    });
  });

  it('commits invalid construction before disposing its latched grant', () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const transport = fakeTransport(
      () => undefined,
      [() => handlers.onData(Uint8Array.from([9]))],
    );
    const grant = Object.freeze({
      consume: vi.fn(),
      dispose: vi.fn(() => {
        handlers.onResponse(200);
        return undefined;
      }),
    }) as DisposableProjectTemplateArtifactRedirectGrant;
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        handlers.onRedirect(grant);
        handlers.onResponse(200);
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(settlement(outcomes));

    expectFailure(outcomes, {
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
    expect(grant.dispose).toHaveBeenCalledTimes(1);
    expect(transport.resume).not.toHaveBeenCalled();
    expect(transport.destroy).toHaveBeenCalledTimes(1);
    expect(transport.dispose).toHaveBeenCalledTimes(1);
  });

  it('copies ingress before authenticated pause can mutate its source', () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const source = Uint8Array.from([1]);
    const transport = fakeTransport(
      () => handlers.onResponse(200),
      [() => handlers.onData(source)],
      () => {
        source[0] = 9;
      },
    );
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(settlement(outcomes));

    expect(outcomes).toEqual([
      { kind: 'chunk', value: Uint8Array.from([1]) },
    ]);
  });

  it.each(['data', 'end'] as const)(
    'fails closed when authenticated pause emits recursive %s',
    (event) => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const transport = fakeTransport(
      () => handlers.onResponse(200),
      [() => handlers.onData(Uint8Array.from([1]))],
      () => {
        if (event === 'data') handlers.onData(Uint8Array.from([2]));
        else handlers.onEnd();
      },
    );
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(settlement(outcomes));

    expectFailure(outcomes, {
      code: 'INVALID_RESPONSE',
      retryable: false,
      replaySafe: false,
    });
    },
  );

  it.each(['response', 'data'] as const)(
    'rejects redirect after direct %s authority is established',
    (stage) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const grant = Object.freeze({
        consume: vi.fn(),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const transport = fakeTransport(
        () => handlers.onResponse(200),
        stage === 'data'
          ? [() => handlers.onData(Uint8Array.from([1]))]
          : [() => undefined],
      );
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));
      if (stage === 'data') attempt.pull(settlement(outcomes));
      handlers.onRedirect(grant);

      const failureOutcomes = stage === 'data'
        ? outcomes.slice(1)
        : outcomes;
      expectFailure(failureOutcomes, {
        code: 'INVALID_RESPONSE',
        retryable: false,
        replaySafe: false,
      });
      expect(grant.consume).not.toHaveBeenCalled();
      expect(grant.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'data',
    'end',
    'redirect',
    'pull',
    'dispose',
    'throw',
  ] as const)(
    'commits redirect rejection before grant cleanup reenters with %s',
    (reentry) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      let attempt!: ProjectTemplateArtifactSingleAttempt;
      const outcomes: Outcome[] = [];
      const reentrantOutcomes: Outcome[] = [];
      const nestedGrant = Object.freeze({
        consume: vi.fn(),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const grant = Object.freeze({
        consume: vi.fn(),
        dispose: vi.fn(() => {
          if (reentry === 'data') handlers.onData(Uint8Array.from([9]));
          else if (reentry === 'end') handlers.onEnd();
          else if (reentry === 'redirect') {
            handlers.onRedirect(nestedGrant);
          } else if (reentry === 'pull') {
            attempt.pull(settlement(reentrantOutcomes));
          } else if (reentry === 'dispose') {
            attempt.dispose();
          } else {
            throw new Error('grant cleanup secret');
          }
          return undefined;
        }),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const transport = fakeTransport(
        () => handlers.onResponse(200),
        [() => undefined],
      );
      attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));
      handlers.onRedirect(grant);

      expectFailure(outcomes, {
        code: 'INVALID_RESPONSE',
        retryable: false,
      });
      if (reentry === 'pull') {
        expectFailure(reentrantOutcomes, {
          code: 'INVALID_RESPONSE',
          retryable: false,
        });
      } else {
        expect(reentrantOutcomes).toEqual([]);
      }
      expect(grant.consume).not.toHaveBeenCalled();
      expect(grant.dispose).toHaveBeenCalledTimes(1);
      expect(nestedGrant.consume).not.toHaveBeenCalled();
      expect(nestedGrant.dispose).toHaveBeenCalledTimes(
        reentry === 'redirect' ? 1 : 0,
      );
      expect(transport.destroy).toHaveBeenCalledTimes(1);
      expect(transport.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an oversized ingress before pausing or copying it', () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const transport = fakeTransport(
      () => handlers.onResponse(200),
      [() => handlers.onData(new Uint8Array(4_096))],
    );
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      Object.freeze({ ...INPUT, maxBytes: 1 }),
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(settlement(outcomes));

    expectFailure(outcomes, {
      code: 'OUTPUT_LIMIT',
      retryable: false,
      replaySafe: false,
    });
    expect(transport.pause).not.toHaveBeenCalled();
  });

  it.each(['data', 'end'] as const)(
    'rejects %s before an accepted response status',
    (event) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const transport = fakeTransport(() => {
        if (event === 'data') handlers.onData(Uint8Array.from([1]));
        else handlers.onEnd();
      });
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));

      expectFailure(outcomes, {
        code: 'INVALID_RESPONSE',
        retryable: false,
        replaySafe: false,
      });
    },
  );

  it.each(['network', 'status'] as const)(
    'marks a %s failure after delivered output as non-replay-safe',
    (failureKind) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const transport = fakeTransport(
        () => handlers.onResponse(200),
        [() => handlers.onData(Uint8Array.from([1]))],
      );
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));
      attempt.pull(settlement(outcomes));
      if (failureKind === 'network') handlers.onResponseError();
      else handlers.onResponse(503);

      expect(outcomes[0]).toEqual({
        kind: 'chunk',
        value: Uint8Array.from([1]),
      });
      expectFailure(outcomes.slice(1), {
        code: failureKind === 'network' ? 'NETWORK' : 'HTTP_STATUS',
        retryable: false,
        replaySafe: false,
        ...(failureKind === 'status' ? { statusCode: 503 } : {}),
      });
    },
  );

  it.each(['throw', 'return'] as const)(
    'does not resume reentrant demand after chunk callback %s',
    (fault) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const transport = fakeTransport(
        () => handlers.onResponse(200),
        [
          () => undefined,
          () => handlers.onData(Uint8Array.from([2])),
        ],
      );
      const secondOutcomes: Outcome[] = [];
      let attempt!: ProjectTemplateArtifactSingleAttempt;
      const firstSettlement = Object.freeze({
        chunk(): unknown {
          attempt.pull(settlement(secondOutcomes));
          if (fault === 'throw') throw new Error('consumer secret');
          return 'not undefined';
        },
        done: vi.fn(() => undefined),
        fail: vi.fn(() => undefined),
      }) as unknown as ProjectTemplateArtifactSingleAttemptSettlement;
      attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(firstSettlement);
      expect(() => handlers.onData(Uint8Array.from([1]))).not.toThrow();

      expect(transport.resume).toHaveBeenCalledTimes(1);
      expectFailure(secondOutcomes, {
        code: 'INTERNAL',
        retryable: false,
      });
      expect(transport.destroy).toHaveBeenCalledTimes(1);
      expect(transport.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('pumps reentrant valid demand once after the active resume unwinds', () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const transport = fakeTransport(
      () => handlers.onResponse(200),
      [
        () => handlers.onData(Uint8Array.from([1])),
        () => handlers.onData(Uint8Array.from([2])),
      ],
    );
    const secondOutcomes: Outcome[] = [];
    let attempt!: ProjectTemplateArtifactSingleAttempt;
    const firstSettlement = Object.freeze({
      chunk(): undefined {
        attempt.pull(settlement(secondOutcomes));
        return undefined;
      },
      done: vi.fn(() => undefined),
      fail: vi.fn(() => undefined),
    });
    attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(firstSettlement);

    expect(transport.resume).toHaveBeenCalledTimes(2);
    expect(secondOutcomes).toEqual([
      { kind: 'chunk', value: Uint8Array.from([2]) },
    ]);
  });

  it.each(['dispose', 'failure'] as const)(
    'does not pump reentrant demand after callback %s',
    (terminal) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const transport = fakeTransport(
        () => handlers.onResponse(200),
        [
          () => handlers.onData(Uint8Array.from([1])),
          () => handlers.onData(Uint8Array.from([2])),
        ],
      );
      const secondOutcomes: Outcome[] = [];
      let attempt!: ProjectTemplateArtifactSingleAttempt;
      const firstSettlement = Object.freeze({
        chunk(): undefined {
          attempt.pull(settlement(secondOutcomes));
          if (terminal === 'dispose') attempt.dispose();
          else handlers.onResponseError();
          return undefined;
        },
        done: vi.fn(() => undefined),
        fail: vi.fn(() => undefined),
      });
      attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(firstSettlement);

      expect(transport.resume).toHaveBeenCalledTimes(1);
      if (terminal === 'dispose') {
        expect(secondOutcomes).toEqual([]);
      } else {
        expectFailure(secondOutcomes, {
          code: 'NETWORK',
          retryable: false,
          replaySafe: false,
        });
      }
      expect(transport.destroy).toHaveBeenCalledTimes(1);
      expect(transport.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the original settlement receiver for every callback', () => {
    let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const transport = fakeTransport(
      () => handlers.onResponse(200),
      [
        () => handlers.onData(Uint8Array.from([1])),
        () => handlers.onEnd(),
      ],
    );
    const receivers: unknown[] = [];
    const original = {
      chunk(this: unknown, _value: Uint8Array): undefined {
        receivers.push(this);
        return undefined;
      },
      done(this: unknown): undefined {
        receivers.push(this);
        return undefined;
      },
      fail(this: unknown, _failure: ProjectTemplateArtifactSingleAttemptFailure):
      undefined {
        receivers.push(this);
        return undefined;
      },
    };
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        handlers = plan.handlers;
        return transport as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );

    attempt.pull(original);
    attempt.pull(original);
    let failureHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const failedAttempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn((_credential, plan) => {
        failureHandlers = plan.handlers;
        return fakeTransport(
          () => failureHandlers.onResponseError(),
        ) as ProjectTemplateGithubReleaseAssetRequest;
      })),
    );
    failedAttempt.pull(original);

    expect(receivers).toEqual([original, original, original]);
  });
});

describe('project-template artifact single attempt capability boundaries', () => {
  it.each([
    ['return', 'reenter'],
    ['return', 'throw'],
    ['throw', 'reenter'],
    ['throw', 'throw'],
  ] as const)(
    'cleans auth construction grant once across dispose, factory %s, cleanup %s',
    (factoryOutcome, cleanupOutcome) => {
      let attempt!: ProjectTemplateArtifactSingleAttempt;
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const transport = fakeTransport();
      const grant = Object.freeze({
        consume: vi.fn(),
        dispose: vi.fn(() => {
          if (cleanupOutcome === 'throw') {
            throw new Error('grant cleanup secret');
          }
          handlers.onResponse(200);
          return undefined;
        }),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const outcomes: Outcome[] = [];
      attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          handlers.onRedirect(grant);
          attempt.dispose();
          if (factoryOutcome === 'throw') {
            throw new Error('factory secret');
          }
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      expect(() => attempt.pull(settlement(outcomes))).not.toThrow();

      expect(outcomes).toEqual([]);
      expect(grant.consume).not.toHaveBeenCalled();
      expect(grant.dispose).toHaveBeenCalledTimes(1);
      expect(transport.destroy).toHaveBeenCalledTimes(
        factoryOutcome === 'return' ? 1 : 0,
      );
      expect(transport.dispose).toHaveBeenCalledTimes(
        factoryOutcome === 'return' ? 1 : 0,
      );
    },
  );

  it('drains synchronous authenticated redirect and pinned response latches', async () => {
    let pinnedHandlers!: ProjectTemplateArtifactPinnedTransportHandlers;
    const hop = Object.freeze({
      dispose: vi.fn(() => undefined),
    }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
    const grant = Object.freeze({
      consume: vi.fn(() => hop),
      dispose: vi.fn(() => undefined),
    }) as DisposableProjectTemplateArtifactRedirectGrant;
    const authenticated = fakeTransport();
    const pinned = fakeTransport(
      () => undefined,
      [() => pinnedHandlers.onData(Uint8Array.from([7]))],
    );
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(
        vi.fn((_credential, plan) => {
          plan.handlers.onRedirect(grant);
          return authenticated as ProjectTemplateGithubReleaseAssetRequest;
        }),
        vi.fn((_hop, handlers) => {
          pinnedHandlers = handlers;
          handlers.onResponse(200);
          return pinned as ProjectTemplateArtifactPinnedTransport;
        }),
      ),
    );

    attempt.pull(settlement(outcomes));
    expect(grant.consume).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(outcomes).toEqual([
      { kind: 'chunk', value: Uint8Array.from([7]) },
    ]);
    expect(authenticated.start).not.toHaveBeenCalled();
    expect(pinned.start).not.toHaveBeenCalled();
  });

  it.each(['throw-after-effect', 'overflow'] as const)(
    'contains pinned construction latch %s',
    async (fault) => {
      let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const hopDispose = vi.fn(() => undefined);
      const hop = Object.freeze({
        dispose: hopDispose,
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const grant = Object.freeze({
        consume: vi.fn(() => hop),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(
        () => authHandlers.onRedirect(grant),
      );
      const pinned = fakeTransport();
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            authHandlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          vi.fn((_hop, handlers) => {
            handlers.onResponse(200);
            if (fault === 'throw-after-effect') {
              throw new Error('after pinned effect');
            }
            handlers.onResponse(200);
            return pinned as ProjectTemplateArtifactPinnedTransport;
          }),
        ),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      expectFailure(outcomes, {
        code: fault === 'overflow' ? 'INVALID_RESPONSE' : 'INTERNAL',
        retryable: false,
      });
      if (fault === 'throw-after-effect') {
        expect(hopDispose).toHaveBeenCalledTimes(1);
      } else {
        expect(pinned.destroy).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([
    'undefined',
    'null',
    'empty',
    'proxy',
    'accessor',
  ] as const)(
    'rejects invalid authenticated %s facade after synchronous response',
    (kind) => {
      const candidate = invalidTransportCandidate(kind);
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          plan.handlers.onResponse(200);
          return candidate.value as never;
        })),
      );

      attempt.pull(settlement(outcomes));

      expectFailure(outcomes, {
        code: 'INTERNAL',
        retryable: false,
      });
      if (candidate.accessor !== undefined) {
        expect(candidate.accessor).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['undefined', 'throw'] as const)(
    'cleans tentative pinned ownership after reentrant dispose and %s',
    async (factoryOutcome) => {
      let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      let attempt!: ProjectTemplateArtifactSingleAttempt;
      const hopDispose = vi.fn(() => undefined);
      const hop = Object.freeze({
        dispose: hopDispose,
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const grant = Object.freeze({
        consume: vi.fn(() => hop),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(
        () => authHandlers.onRedirect(grant),
      );
      const outcomes: Outcome[] = [];
      attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            authHandlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          vi.fn(() => {
            attempt.dispose();
            if (factoryOutcome === 'throw') {
              throw new Error('pinned factory secret');
            }
            return undefined as never;
          }),
        ),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      expect(outcomes).toEqual([]);
      expect(hopDispose).toHaveBeenCalledTimes(1);
      expect(grant.dispose).toHaveBeenCalledTimes(1);
      expect(authenticated.destroy).toHaveBeenCalledTimes(1);
      expect(authenticated.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'failure',
    'data',
    'redirect',
    'dispose',
  ] as const)(
    'cleans pinned local owners after old auth %s and factory throw',
    async (oldEvent) => {
      let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      let attempt!: ProjectTemplateArtifactSingleAttempt;
      const hopDispose = vi.fn(() => undefined);
      const hop = Object.freeze({
        dispose: hopDispose,
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const grant = Object.freeze({
        consume: vi.fn(() => hop),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const extraGrant = Object.freeze({
        consume: vi.fn(),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(
        () => authHandlers.onRedirect(grant),
      );
      const outcomes: Outcome[] = [];
      attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            authHandlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          vi.fn(() => {
            if (oldEvent === 'failure') authHandlers.onResponseError();
            else if (oldEvent === 'data') {
              authHandlers.onData(Uint8Array.from([9]));
            } else if (oldEvent === 'redirect') {
              authHandlers.onRedirect(extraGrant);
            } else {
              attempt.dispose();
            }
            throw new Error('pinned factory secret');
          }),
        ),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      if (oldEvent === 'dispose') {
        expect(outcomes).toEqual([]);
      } else {
        expectFailure(outcomes, {
          code: 'INVALID_RESPONSE',
          retryable: false,
        });
      }
      expect(hopDispose).toHaveBeenCalledTimes(1);
      expect(grant.dispose).toHaveBeenCalledTimes(1);
      expect(extraGrant.dispose).toHaveBeenCalledTimes(
        oldEvent === 'redirect' ? 1 : 0,
      );
    },
  );

  it.each(['same', 'different'] as const)(
    'disposes %s duplicate redirect grants by identity exactly once',
    async (identity) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const firstGrant = Object.freeze({
        consume: vi.fn(),
        dispose: vi.fn(() => {
          handlers.onData(Uint8Array.from([9]));
          return undefined;
        }),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const secondGrant = identity === 'same'
        ? firstGrant
        : Object.freeze({
          consume: vi.fn(),
          dispose: vi.fn(() => undefined),
        }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(() => {
        handlers.onRedirect(firstGrant);
        handlers.onRedirect(secondGrant);
      });
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return authenticated as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      expectFailure(outcomes, {
        code: 'INVALID_RESPONSE',
        retryable: false,
      });
      expect(firstGrant.dispose).toHaveBeenCalledTimes(1);
      expect(secondGrant.dispose).toHaveBeenCalledTimes(1);
      expect(firstGrant.consume).not.toHaveBeenCalled();
      expect(secondGrant.consume).not.toHaveBeenCalled();
    },
  );

  it.each([
    'undefined',
    'null',
    'empty',
    'proxy',
    'accessor',
  ] as const)(
    'rejects malformed %s redirect grant during construction',
    (kind) => {
      const candidate = invalidGrantCandidate(kind);
      const transport = fakeTransport();
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          plan.handlers.onRedirect(candidate.value as never);
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));

      expectFailure(outcomes, {
        code: 'INVALID_RESPONSE',
        retryable: false,
      });
      if (candidate.accessor !== undefined) {
        expect(candidate.accessor).not.toHaveBeenCalled();
      }
      expect(transport.destroy).toHaveBeenCalledTimes(1);
      expect(transport.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'undefined',
    'null',
    'empty',
    'proxy',
    'accessor',
  ] as const)(
    'rejects malformed redirect %s hop before pinned construction',
    async (kind) => {
      let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const candidate = invalidHopCandidate(kind);
      const grant = Object.freeze({
        consume: vi.fn(() => candidate.value as never),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(
        () => authHandlers.onRedirect(grant),
      );
      const createPinned = vi.fn();
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            authHandlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          createPinned,
        ),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      expectFailure(outcomes, {
        code: 'INTERNAL',
        retryable: false,
      });
      expect(createPinned).not.toHaveBeenCalled();
      expect(grant.dispose).toHaveBeenCalledTimes(1);
      expect(authenticated.destroy).toHaveBeenCalledTimes(1);
      expect(authenticated.dispose).toHaveBeenCalledTimes(1);
      if (candidate.accessor !== undefined) {
        expect(candidate.accessor).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ['throw', 'return'],
    ['reenter', 'return'],
    ['throw', 'throw'],
    ['reenter', 'reenter'],
  ] as const)(
    'continues pinned cleanup after hop %s and grant %s disposers',
    async (hopCleanup, grantCleanup) => {
      let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const outcomes: Outcome[] = [];
      const hopDispose = vi.fn(() => {
        if (hopCleanup === 'throw') {
          throw new Error('hop cleanup secret');
        }
        authHandlers.onResponseError();
        return undefined;
      });
      const hop = Object.freeze({
        dispose: hopDispose,
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const grantDispose = vi.fn(() => {
        if (grantCleanup === 'throw') {
          throw new Error('grant cleanup secret');
        }
        if (grantCleanup === 'reenter') authHandlers.onResponseError();
        return undefined;
      });
      const grant = Object.freeze({
        consume: vi.fn(() => hop),
        dispose: grantDispose,
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(
        () => authHandlers.onRedirect(grant),
      );
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            authHandlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          vi.fn(() => {
            throw new Error('pinned factory secret');
          }),
        ),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      expectFailure(outcomes, {
        code: 'INTERNAL',
        retryable: false,
      });
      expect(hopDispose).toHaveBeenCalledTimes(1);
      expect(grantDispose).toHaveBeenCalledTimes(1);
      expect(authenticated.destroy).toHaveBeenCalledTimes(1);
      expect(authenticated.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'undefined',
    'null',
    'empty',
    'proxy',
    'accessor',
  ] as const)(
    'rejects malformed %s redirect grant after start',
    (kind) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const candidate = invalidGrantCandidate(kind);
      const transport = fakeTransport(
        () => handlers.onRedirect(candidate.value as never),
      );
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));

      expectFailure(outcomes, {
        code: 'INVALID_RESPONSE',
        retryable: false,
      });
      if (candidate.accessor !== undefined) {
        expect(candidate.accessor).not.toHaveBeenCalled();
      }
      expect(transport.destroy).toHaveBeenCalledTimes(1);
      expect(transport.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'undefined',
    'null',
    'empty',
    'proxy',
    'accessor',
  ] as const)(
    'rejects invalid authenticated %s facade after synchronous redirect',
    (kind) => {
      const candidate = invalidTransportCandidate(kind);
      const grant = Object.freeze({
        consume: vi.fn(),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          plan.handlers.onRedirect(grant);
          return candidate.value as never;
        })),
      );

      attempt.pull(settlement(outcomes));

      expectFailure(outcomes, {
        code: 'INTERNAL',
        retryable: false,
      });
      expect(grant.consume).not.toHaveBeenCalled();
      expect(grant.dispose).toHaveBeenCalledTimes(1);
      if (candidate.accessor !== undefined) {
        expect(candidate.accessor).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    'undefined',
    'null',
    'empty',
    'proxy',
    'accessor',
  ] as const)(
    'rejects invalid pinned %s facade after synchronous response',
    async (kind) => {
      let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const candidate = invalidTransportCandidate(kind);
      const hopDispose = vi.fn(() => undefined);
      const hop = Object.freeze({
        dispose: hopDispose,
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const grant = Object.freeze({
        consume: vi.fn(() => hop),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(
        () => authHandlers.onRedirect(grant),
      );
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            authHandlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          vi.fn((_hop, handlers) => {
            handlers.onResponse(200);
            return candidate.value as never;
          }),
        ),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      expectFailure(outcomes, {
        code: 'INTERNAL',
        retryable: false,
      });
      expect(hopDispose).toHaveBeenCalledTimes(1);
      if (candidate.accessor !== undefined) {
        expect(candidate.accessor).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ['response', (handlers: ProjectTemplateGithubReleaseAssetRequestHandlers) =>
      handlers.onResponse(200)],
    ['invalid', (handlers: ProjectTemplateGithubReleaseAssetRequestHandlers) =>
      handlers.onInvalidResponse()],
    ['data', (handlers: ProjectTemplateGithubReleaseAssetRequestHandlers) =>
      handlers.onData(Uint8Array.from([1]))],
    ['end', (handlers: ProjectTemplateGithubReleaseAssetRequestHandlers) =>
      handlers.onEnd()],
    ['aborted', (handlers: ProjectTemplateGithubReleaseAssetRequestHandlers) =>
      handlers.onResponseAborted()],
    ['response-error', (
      handlers: ProjectTemplateGithubReleaseAssetRequestHandlers,
    ) => handlers.onResponseError()],
    ['response-close', (
      handlers: ProjectTemplateGithubReleaseAssetRequestHandlers,
    ) => handlers.onResponseClose()],
  ] as const)(
    'rejects old authenticated %s during the handoff-pending window',
    async (_label, emit) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const hop = Object.freeze({
        dispose: vi.fn(() => undefined),
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const grant = Object.freeze({
        consume: vi.fn(() => hop),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(() => {
        handlers.onRedirect(grant);
        emit(handlers);
      });
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return authenticated as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      expectFailure(outcomes, {
        code: 'INVALID_RESPONSE',
        retryable: false,
      });
      expect(grant.consume).not.toHaveBeenCalled();
      expect(grant.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['dns', (handlers: ProjectTemplateArtifactPinnedTransportHandlers) =>
      handlers.onDnsRejected()],
    ['invalid', (handlers: ProjectTemplateArtifactPinnedTransportHandlers) =>
      handlers.onInvalidResponse()],
    ['data', (handlers: ProjectTemplateArtifactPinnedTransportHandlers) =>
      handlers.onData(Uint8Array.from([1]))],
    ['end', (handlers: ProjectTemplateArtifactPinnedTransportHandlers) =>
      handlers.onEnd()],
    ['aborted', (handlers: ProjectTemplateArtifactPinnedTransportHandlers) =>
      handlers.onResponseAborted()],
    ['response-error', (
      handlers: ProjectTemplateArtifactPinnedTransportHandlers,
    ) => handlers.onResponseError()],
    ['request-error', (
      handlers: ProjectTemplateArtifactPinnedTransportHandlers,
    ) => handlers.onRequestError()],
    ['request-close', (
      handlers: ProjectTemplateArtifactPinnedTransportHandlers,
    ) => handlers.onRequestClose()],
  ] as const)(
    'rejects pinned construction-time %s without mixing generations',
    async (_label, emit) => {
      let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const hop = Object.freeze({
        dispose: vi.fn(() => undefined),
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const grant = Object.freeze({
        consume: vi.fn(() => hop),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(
        () => authHandlers.onRedirect(grant),
      );
      const pinned = fakeTransport();
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            authHandlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          vi.fn((_hop, handlers) => {
            emit(handlers);
            return pinned as ProjectTemplateArtifactPinnedTransport;
          }),
        ),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      expectFailure(outcomes, {
        code: 'INVALID_RESPONSE',
        retryable: false,
      });
      expect(pinned.destroy).toHaveBeenCalledTimes(1);
      expect(pinned.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an old authenticated event mixed into pinned construction', async () => {
    let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const hop = Object.freeze({
      dispose: vi.fn(() => undefined),
    }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
    const grant = Object.freeze({
      consume: vi.fn(() => hop),
      dispose: vi.fn(() => undefined),
    }) as DisposableProjectTemplateArtifactRedirectGrant;
    const authenticated = fakeTransport(
      () => authHandlers.onRedirect(grant),
    );
    const pinned = fakeTransport();
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(
        vi.fn((_credential, plan) => {
          authHandlers = plan.handlers;
          return authenticated as ProjectTemplateGithubReleaseAssetRequest;
        }),
        vi.fn((_hop, handlers) => {
          authHandlers.onResponseError();
          handlers.onResponse(200);
          return pinned as ProjectTemplateArtifactPinnedTransport;
        }),
      ),
    );

    attempt.pull(settlement(outcomes));
    await Promise.resolve();

    expectFailure(outcomes, {
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
    expect(pinned.destroy).toHaveBeenCalledTimes(1);
  });

  it('revalidates authority after redirect consume reentrancy', async () => {
    let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const hopDispose = vi.fn(() => undefined);
    const hop = Object.freeze({
      dispose: hopDispose,
    }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
    const grant = Object.freeze({
      consume: vi.fn(() => {
        authHandlers.onResponseError();
        return hop;
      }),
      dispose: vi.fn(() => undefined),
    }) as DisposableProjectTemplateArtifactRedirectGrant;
    const authenticated = fakeTransport(
      () => authHandlers.onRedirect(grant),
    );
    const createPinned = vi.fn();
    const outcomes: Outcome[] = [];
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(
        vi.fn((_credential, plan) => {
          authHandlers = plan.handlers;
          return authenticated as ProjectTemplateGithubReleaseAssetRequest;
        }),
        createPinned,
      ),
    );

    attempt.pull(settlement(outcomes));
    await Promise.resolve();

    expectFailure(outcomes, {
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
    expect(createPinned).not.toHaveBeenCalled();
    expect(hopDispose).toHaveBeenCalledTimes(1);
  });

  it.each(['dispose', 'handoff', 'failure'] as const)(
    'disposes a late redirect grant after old auth %s',
    async (terminal) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const firstHop = Object.freeze({
        dispose: vi.fn(() => undefined),
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const firstGrant = Object.freeze({
        consume: vi.fn(() => firstHop),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const lateGrant = Object.freeze({
        consume: vi.fn(),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(() => {
        if (terminal === 'handoff') handlers.onRedirect(firstGrant);
        else if (terminal === 'failure') handlers.onResponseError();
        else handlers.onResponse(200);
      });
      const pinned = fakeTransport();
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            handlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          vi.fn(() => pinned as ProjectTemplateArtifactPinnedTransport),
        ),
      );

      attempt.pull(settlement([]));
      if (terminal === 'dispose') attempt.dispose();
      await Promise.resolve();
      handlers.onRedirect(lateGrant);

      expect(lateGrant.consume).not.toHaveBeenCalled();
      expect(lateGrant.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('invokes injected dependencies with their original receiver', async () => {
    let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
    const seen: unknown[] = [];
    const hop = Object.freeze({
      dispose: vi.fn(() => undefined),
    }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
    const grant = Object.freeze({
      consume: vi.fn(() => hop),
      dispose: vi.fn(() => undefined),
    }) as DisposableProjectTemplateArtifactRedirectGrant;
    const authenticated = fakeTransport(
      () => authHandlers.onRedirect(grant),
    );
    const pinned = fakeTransport();
    const original = Object.freeze({
      createAuthenticatedRequest(
        this: unknown,
        _credential: DisposableProjectTemplateGhCredential,
        plan: { handlers: ProjectTemplateGithubReleaseAssetRequestHandlers },
      ) {
        seen.push(this);
        authHandlers = plan.handlers;
        return authenticated as ProjectTemplateGithubReleaseAssetRequest;
      },
      createPinnedTransport(
        this: unknown,
        _hop: DisposableProjectTemplateArtifactRedirectHop,
        _handlers: ProjectTemplateArtifactPinnedTransportHandlers,
      ) {
        seen.push(this);
        return pinned as ProjectTemplateArtifactPinnedTransport;
      },
      scheduleHandoff(this: unknown, callback: () => void) {
        seen.push(this);
        queueMicrotask(callback);
      },
    });
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      original,
    );

    attempt.pull(settlement([]));
    await Promise.resolve();

    expect(seen).toEqual([original, original, original]);
  });

  it.each(['throw', 'return'] as const)(
    'contains active chunk callback %s and fixes later failure to INTERNAL',
    (fault) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const transport = fakeTransport(
        () => handlers.onResponse(200),
        [() => handlers.onData(Uint8Array.from([1]))],
      );
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );
      const hostile = Object.freeze({
        chunk(): unknown {
          if (fault === 'throw') throw new Error('consumer secret');
          return 'not undefined';
        },
        done: vi.fn(() => undefined),
        fail: vi.fn(() => undefined),
      }) as unknown as ProjectTemplateArtifactSingleAttemptSettlement;

      expect(() => attempt.pull(hostile)).not.toThrow();
      const outcomes: Outcome[] = [];
      attempt.pull(settlement(outcomes));

      expectFailure(outcomes, {
        code: 'INTERNAL',
        retryable: false,
      });
    },
  );

  it.each(['done-throw', 'done-return', 'fail-throw', 'fail-return'] as const)(
    'contains terminal settlement callback %s without changing outcome',
    (fault) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const transport = fakeTransport(() => {
        if (fault.startsWith('done')) {
          handlers.onResponse(200);
          handlers.onEnd();
        } else {
          handlers.onResponseError();
        }
      });
      const hostile = Object.freeze({
        chunk: vi.fn(() => undefined),
        done(): unknown {
          if (fault === 'done-throw') throw new Error('done secret');
          return fault === 'done-return' ? true : undefined;
        },
        fail(): unknown {
          if (fault === 'fail-throw') throw new Error('fail secret');
          return fault === 'fail-return' ? true : undefined;
        },
      }) as unknown as ProjectTemplateArtifactSingleAttemptSettlement;
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      expect(() => attempt.pull(hostile)).not.toThrow();
      expect(() => attempt.pull(hostile)).not.toThrow();
      const outcomes: Outcome[] = [];
      attempt.pull(settlement(outcomes));
      if (fault.startsWith('done')) {
        expect(outcomes).toEqual([{ kind: 'done' }]);
      } else {
        expectFailure(outcomes, {
          code: 'NETWORK',
          retryable: true,
        });
      }
    },
  );

  it('keeps dispose idempotent while tombstoning later pull', () => {
    const attempt = createProjectTemplateArtifactSingleAttempt(
      credential(),
      INPUT,
      dependencies(vi.fn()),
    );
    const outcomes: Outcome[] = [];

    expect(attempt.dispose()).toBeUndefined();
    expect(attempt.dispose()).toBeUndefined();
    expect(attempt.pull(settlement(outcomes))).toBeUndefined();

    expectFailure(outcomes, {
      code: 'INTERNAL',
      retryable: false,
    });
  });

  it.each(['done', 'failure', 'dispose'] as const)(
    'borrows rather than disposes the coordinator-owned credential on %s',
    (terminal) => {
      let handlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      const borrowed = credential();
      const transport = fakeTransport(() => {
        if (terminal === 'done') {
          handlers.onResponse(200);
          handlers.onEnd();
        } else if (terminal === 'failure') {
          handlers.onResponseError();
        } else {
          handlers.onResponse(200);
        }
      });
      const attempt = createProjectTemplateArtifactSingleAttempt(
        borrowed,
        INPUT,
        dependencies(vi.fn((_credential, plan) => {
          handlers = plan.handlers;
          return transport as ProjectTemplateGithubReleaseAssetRequest;
        })),
      );

      attempt.pull(settlement([]));
      if (terminal === 'dispose') attempt.dispose();

      expect(borrowed.dispose).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['status', (handlers: ProjectTemplateArtifactPinnedTransportHandlers) =>
      handlers.onResponse(503), 'HTTP_STATUS'],
    ['network', (handlers: ProjectTemplateArtifactPinnedTransportHandlers) =>
      handlers.onResponseError(), 'NETWORK'],
  ] as const)(
    'keeps pinned %s failure classification parity',
    async (_label, emit, code) => {
      let authHandlers!: ProjectTemplateGithubReleaseAssetRequestHandlers;
      let pinnedHandlers!: ProjectTemplateArtifactPinnedTransportHandlers;
      const hop = Object.freeze({
        dispose: vi.fn(() => undefined),
      }) as unknown as DisposableProjectTemplateArtifactRedirectHop;
      const grant = Object.freeze({
        consume: vi.fn(() => hop),
        dispose: vi.fn(() => undefined),
      }) as DisposableProjectTemplateArtifactRedirectGrant;
      const authenticated = fakeTransport(
        () => authHandlers.onRedirect(grant),
      );
      const pinned = fakeTransport(() => emit(pinnedHandlers));
      const outcomes: Outcome[] = [];
      const attempt = createProjectTemplateArtifactSingleAttempt(
        credential(),
        INPUT,
        dependencies(
          vi.fn((_credential, plan) => {
            authHandlers = plan.handlers;
            return authenticated as ProjectTemplateGithubReleaseAssetRequest;
          }),
          vi.fn((_hop, handlers) => {
            pinnedHandlers = handlers;
            return pinned as ProjectTemplateArtifactPinnedTransport;
          }),
        ),
      );

      attempt.pull(settlement(outcomes));
      await Promise.resolve();

      expectFailure(outcomes, {
        code,
        retryable: true,
        ...(code === 'HTTP_STATUS' ? { statusCode: 503 } : {}),
      });
    },
  );
});
