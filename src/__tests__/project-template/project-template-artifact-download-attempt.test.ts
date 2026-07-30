import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTemplateArtifactSingleAttempt,
  type ProjectTemplateArtifactDownloadAttemptDependencies,
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
    readonly statusCode?: number;
  },
): void {
  expect(outcomes).toHaveLength(1);
  const outcome = outcomes[0]!;
  expect(outcome.kind).toBe('fail');
  if (outcome.kind !== 'fail') return;
  expect(outcome.failure).toEqual(expected);
  expect(Object.getPrototypeOf(outcome.failure)).toBeNull();
  expect(Object.isFrozen(outcome.failure)).toBe(true);
  expect(Reflect.ownKeys(outcome.failure)).toEqual(Object.keys(expected));
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
