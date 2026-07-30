import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const https = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('node:https', () => ({
  request: https.request,
}));

import {
  acquireProjectTemplateGhCredential,
  createProjectTemplateGithubApiRequest,
  type DisposableProjectTemplateGhCredential,
  type ProjectTemplateGithubApiRequestHandlers,
} from '../../infra/github/project-template-gh-auth.js';
import {
  requestProjectTemplateGithubApiMetadata,
} from '../../infra/github/project-template-api-transport.js';

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): boolean {
    return true;
  }
}

class FakeRequest extends EventEmitter {
  readonly end = vi.fn();
  readonly destroy = vi.fn();
}

class FakeResponse extends PassThrough {
  constructor(readonly statusCode: number) {
    super();
  }
}

async function acquireCredential(): Promise<
DisposableProjectTemplateGhCredential
> {
  const child = new FakeChildProcess();
  const pending = acquireProjectTemplateGhCredential(
    { deadlineMs: 10_100 },
    Object.freeze({
      spawn: () => child as unknown as ChildProcess,
      now: () => 100,
    }),
  );
  child.stdout.end('api-boundary-secret\n');
  child.stderr.end();
  child.emit('close', 0, null);
  return pending;
}

function makeHandlers(): ProjectTemplateGithubApiRequestHandlers {
  return Object.freeze({
    onResponse: vi.fn(),
    onData: vi.fn(),
    onEnd: vi.fn(),
    onResponseAborted: vi.fn(),
    onResponseError: vi.fn(),
    onResponseClose: vi.fn(),
    onRequestError: vi.fn(),
    onRequestClose: vi.fn(),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  https.request.mockReset();
});

describe('project-template GitHub metadata transport F2a', () => {
  function captureRequests() {
    const attempts: Array<{
      request: FakeRequest;
      respond: (response: FakeResponse) => void;
    }> = [];
    https.request.mockImplementation((
      _options: RequestOptions,
      callback: (response: FakeResponse) => void,
    ) => {
      const request = new FakeRequest();
      attempts.push({ request, respond: callback });
      return request;
    });
    return attempts;
  }

  it('returns one bounded metadata body from the fixed authenticated API', async () => {
    const attempts = captureRequests();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
    }, Object.freeze({ now: () => 100 }));
    expect(attempts).toHaveLength(1);
    const response = new FakeResponse(200);
    attempts[0]!.respond(response);
    response.end(Buffer.from('{"sha":"abc"}'));

    await expect(pending).resolves.toEqual(Buffer.from('{"sha":"abc"}'));
    expect(attempts[0]!.request.end).toHaveBeenCalledTimes(1);
    expect(attempts[0]!.request.listenerCount('error')).toBe(0);
    expect(response.listenerCount('data')).toBe(0);
    credential.dispose();
  });

  it.each([
    [301, 'REDIRECT'],
    [401, 'AUTH_REQUIRED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [422, 'HTTP_ERROR'],
  ] as const)('does not retry terminal metadata status %i', async (
    status,
    code,
  ) => {
    const attempts = captureRequests();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
    }, Object.freeze({ now: () => 100 }));
    const response = new FakeResponse(status);
    attempts[0]!.respond(response);

    await expect(pending).rejects.toMatchObject({ code });
    expect(attempts).toHaveLength(1);
    expect(response.listenerCount('data')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    credential.dispose();
  });

  it('retries 503 and 429 with fixed 250ms/1000ms backoff', async () => {
    vi.useFakeTimers();
    let now = 100;
    const attempts = captureRequests();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
    }, Object.freeze({ now: () => now }));

    attempts[0]!.respond(new FakeResponse(503));
    now += 250;
    await vi.advanceTimersByTimeAsync(250);
    expect(attempts).toHaveLength(2);
    attempts[1]!.respond(new FakeResponse(429));
    now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toHaveLength(3);
    const response = new FakeResponse(200);
    attempts[2]!.respond(response);
    response.end('ok');

    await expect(pending).resolves.toEqual(Buffer.from('ok'));
    credential.dispose();
  });

  it('retries request network failure at most twice', async () => {
    vi.useFakeTimers();
    let now = 100;
    const attempts = captureRequests();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
    }, Object.freeze({ now: () => now }));

    attempts[0]!.request.emit('error', new Error('network secret 1'));
    now += 250;
    await vi.advanceTimersByTimeAsync(250);
    attempts[1]!.request.emit('error', new Error('network secret 2'));
    now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    attempts[2]!.request.emit('error', new Error('network secret 3'));

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(error)).not.toContain('secret');
    expect(attempts).toHaveLength(3);
    credential.dispose();
  });

  it('retries synchronous request creation network failures', async () => {
    vi.useFakeTimers();
    let now = 100;
    https.request.mockImplementation(() => {
      throw new Error('synchronous network secret');
    });
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
    }, Object.freeze({ now: () => now }));
    const observed = pending.catch((error: unknown) => error);
    now += 250;
    await vi.advanceTimersByTimeAsync(250);
    now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);

    const error = await observed;
    expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(error)).not.toContain('secret');
    expect(https.request).toHaveBeenCalledTimes(3);
    credential.dispose();
  });

  it('checks the byte limit before copying and wipes retained chunks', async () => {
    const attempts = captureRequests();
    const credential = await acquireCredential();
    const fill = vi.spyOn(Buffer.prototype, 'fill');
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/contents/file',
      accept: 'application/vnd.github.raw+json',
      maxBytes: 4,
      deadlineMs: 10_100,
    }, Object.freeze({ now: () => 100 }));
    const response = new FakeResponse(200);
    attempts[0]!.respond(response);
    response.emit('data', Buffer.from('abc'));
    expect(() => response.emit('data', Buffer.from('de'))).not.toThrow();

    await expect(pending).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
    expect(fill.mock.instances.some(
      (instance) => (
        (instance as Buffer).length === 3
        && [...instance as Buffer].every((byte) => byte === 0)
      ),
    )).toBe(true);
    expect(response.destroyed).toBe(true);
    credential.dispose();
  });

  it.each([
    { label: 'plain object', chunk: Object.freeze({ body: 'secret' }) },
    {
      label: 'proxy',
      chunk: new Proxy({}, {
        get() {
          throw new Error('chunk secret');
        },
      }),
    },
  ])('fails closed for a hostile $label response chunk', async ({ chunk }) => {
    const attempts = captureRequests();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
    }, Object.freeze({ now: () => 100 }));
    const response = new FakeResponse(200);
    attempts[0]!.respond(response);
    expect(() => response.emit('data', chunk)).not.toThrow();

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(String(error)).not.toContain('secret');
    credential.dispose();
  });

  it.each([
    {
      eventName: 'data',
      trigger(
        response: FakeResponse,
        controller: AbortController,
      ): void {
        controller.abort();
      },
      expectedCode: 'ABORTED',
    },
    {
      eventName: 'end',
      trigger(response: FakeResponse): void {
        response.emit('data', Object.freeze({
          secret: 'end listener secret',
        }));
      },
      expectedCode: 'INVALID_RESPONSE',
    },
    {
      eventName: 'error',
      trigger(response: FakeResponse): void {
        response.emit('data', Object.freeze({
          secret: 'error listener secret',
        }));
      },
      expectedCode: 'INVALID_RESPONSE',
    },
  ] as const)(
    'removes auth listeners when $eventName registration settles',
    async ({ eventName, trigger, expectedCode }) => {
    vi.useFakeTimers();
    const attempts = captureRequests();
    const controller = new AbortController();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
      signal: controller.signal,
    }, Object.freeze({ now: () => 100 }));
    const response = new FakeResponse(200);
    const attack = (registering: string | symbol): void => {
      if (registering !== eventName) return;
      response.removeListener('newListener', attack);
      trigger(response, controller);
    };
    response.on('newListener', attack);
    attempts[0]!.respond(response);

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: expectedCode });
    expect(String(error)).not.toContain('secret');
    expect(response.listenerCount('data')).toBe(0);
    expect(response.listenerCount('end')).toBe(0);
    expect(response.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('error')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(attempts[0]!.request.listenerCount('error')).toBe(0);
    expect(attempts[0]!.request.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    credential.dispose();
  });

  it('destroys a response delivered before https.request returns authority', async () => {
    const response = new FakeResponse(200);
    const request = new FakeRequest();
    https.request.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return request;
    });
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 300,
    }, Object.freeze({ now: () => 100 }));

    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(response.destroyed).toBe(true);
    expect(response.listenerCount('data')).toBe(0);
    expect(response.listenerCount('end')).toBe(0);
    expect(response.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('error')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(request.listenerCount('error')).toBe(0);
    expect(request.listenerCount('close')).toBe(0);
    credential.dispose();
  });

  it('aborts and destroys both request and response without retrying', async () => {
    const attempts = captureRequests();
    const controller = new AbortController();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
      signal: controller.signal,
    }, Object.freeze({ now: () => 100 }));
    const response = new FakeResponse(200);
    attempts[0]!.respond(response);
    controller.abort('abort secret');

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ABORTED' });
    expect(String(error)).not.toContain('secret');
    expect(attempts[0]!.request.destroy).toHaveBeenCalledTimes(1);
    expect(response.destroyed).toBe(true);
    expect(attempts).toHaveLength(1);
    credential.dispose();
  });

  it('contains request destroy failures during abort cleanup', async () => {
    const attempts = captureRequests();
    const controller = new AbortController();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
      signal: controller.signal,
    }, Object.freeze({ now: () => 100 }));
    const observed = pending.catch((error: unknown) => error);
    attempts[0]!.request.destroy.mockImplementation(() => {
      throw new Error('destroy secret');
    });
    expect(() => controller.abort()).not.toThrow();

    await expect(observed).resolves.toMatchObject({ code: 'ABORTED' });
    expect(attempts[0]!.request.listenerCount('error')).toBe(0);
    credential.dispose();
  });

  it('fails immediately when a response closes before its body ends', async () => {
    const attempts = captureRequests();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 300,
    }, Object.freeze({ now: () => 100 }));
    const observed = pending.catch((error: unknown) => error);
    const response = new FakeResponse(200);
    attempts[0]!.respond(response);
    response.emit('close');

    await expect(observed).resolves.toMatchObject({ code: 'TIMEOUT' });
    expect(attempts[0]!.request.destroy).toHaveBeenCalledTimes(1);
    credential.dispose();
  });

  it('charges synchronous request creation against the shared deadline', async () => {
    let now = 100;
    const request = new FakeRequest();
    https.request.mockImplementation(() => {
      now = 600;
      return request;
    });
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 600,
    }, Object.freeze({ now: () => now }));

    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(request.end).not.toHaveBeenCalled();
    expect(request.destroy).toHaveBeenCalledTimes(1);
    credential.dispose();
  });

  it('does not start a request after the post-creation clock aborts it', async () => {
    const attempts = captureRequests();
    const controller = new AbortController();
    const credential = await acquireCredential();
    const now = vi.fn()
      .mockReturnValueOnce(100)
      .mockImplementationOnce(() => {
        controller.abort();
        return 100;
      });
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
      signal: controller.signal,
    }, Object.freeze({ now }));

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(attempts[0]!.request.end).not.toHaveBeenCalled();
    expect(attempts[0]!.request.destroy).toHaveBeenCalledTimes(1);
    expect(attempts[0]!.request.listenerCount('error')).toBe(0);
    credential.dispose();
  });

  it('rejects a non-finite response status without retrying', async () => {
    const attempts = captureRequests();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
    }, Object.freeze({ now: () => 100 }));
    attempts[0]!.respond(new FakeResponse(Number.NaN));

    await expect(pending).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(attempts).toHaveLength(1);
    credential.dispose();
  });

  it('preserves the snapshotted clock receiver', async () => {
    const attempts = captureRequests();
    const credential = await acquireCredential();
    const receivers: unknown[] = [];
    const dependencies = Object.freeze({
      now(this: unknown) {
        receivers.push(this);
        return 100;
      },
    });
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
    }, dependencies);
    const response = new FakeResponse(200);
    attempts[0]!.respond(response);
    response.end('ok');

    await expect(pending).resolves.toEqual(Buffer.from('ok'));
    expect(receivers.length).toBeGreaterThanOrEqual(3);
    expect(receivers.every((receiver) => receiver === dependencies)).toBe(
      true,
    );
    credential.dispose();
  });

  it.each([
    { deadlineMs: 30_100, expectedMs: 30_000 },
    { deadlineMs: 600, expectedMs: 500 },
  ])('bounds an attempt timeout to $expectedMs ms', async ({
    deadlineMs,
    expectedMs,
  }) => {
    vi.useFakeTimers();
    const attempts = captureRequests();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs,
    }, Object.freeze({ now: () => 100 }));
    const observed = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(expectedMs);

    await expect(observed).resolves.toMatchObject({ code: 'TIMEOUT' });
    expect(attempts[0]!.request.destroy).toHaveBeenCalledTimes(1);
    credential.dispose();
  });

  it('charges retry sleep against the absolute deadline', async () => {
    vi.useFakeTimers();
    let now = 100;
    const attempts = captureRequests();
    const credential = await acquireCredential();
    const pending = requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 300,
    }, Object.freeze({ now: () => now }));
    const observed = pending.catch((error: unknown) => error);
    attempts[0]!.respond(new FakeResponse(503));
    now = 300;
    await vi.advanceTimersByTimeAsync(200);

    await expect(observed).resolves.toMatchObject({ code: 'TIMEOUT' });
    expect(attempts).toHaveLength(1);
    credential.dispose();
  });

  it.each([
    {
      label: 'oversized maxBytes',
      options: { maxBytes: (1024 * 1024) + 1 },
    },
    {
      label: 'unknown option',
      options: { extra: true },
    },
    {
      label: 'unsafe path',
      options: { path: 'https://evil.example/steal' },
    },
  ])('rejects $label before creating a request', async ({ options }) => {
    const credential = await acquireCredential();
    await expect(requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
      ...options,
    } as never, Object.freeze({ now: () => 100 }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(https.request).not.toHaveBeenCalled();
    credential.dispose();
  });

  it.each([
    Object.freeze({ now: () => 100, extra: true }),
    Object.freeze({ now: new Proxy(() => 100, {}) }),
  ])('rejects hostile or non-exact dependencies', async (dependencies) => {
    const credential = await acquireCredential();
    await expect(requestProjectTemplateGithubApiMetadata({
      credential,
      path: '/repos/octo/demo/commits/main',
      accept: 'application/vnd.github+json',
      maxBytes: 64,
      deadlineMs: 10_100,
    }, dependencies as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(https.request).not.toHaveBeenCalled();
    credential.dispose();
  });
});

describe('project-template authenticated GitHub API boundary F2a', () => {
  it('preserves the strict handler receiver for every sealed callback', async () => {
    const request = new FakeRequest();
    let responseCallback: ((response: FakeResponse) => void) | undefined;
    https.request.mockImplementation((
      _options: RequestOptions,
      callback: (response: FakeResponse) => void,
    ) => {
      responseCallback = callback;
      return request;
    });
    const credential = await acquireCredential();
    const receivers: unknown[] = [];
    const recordReceiver = function (this: unknown): void {
      receivers.push(this);
    };
    const handlers = Object.freeze({
      onResponse(this: unknown): void {
        receivers.push(this);
      },
      onData: recordReceiver,
      onEnd: recordReceiver,
      onResponseAborted: recordReceiver,
      onResponseError: recordReceiver,
      onResponseClose: recordReceiver,
      onRequestError: recordReceiver,
      onRequestClose: recordReceiver,
    });
    const facade = createProjectTemplateGithubApiRequest(
      credential,
      Object.freeze({
        path: '/repos/octo/demo/commits/main',
        accept: 'application/vnd.github+json' as const,
        handlers,
      }),
    );
    const response = new FakeResponse(200);
    responseCallback?.(response);
    response.emit('data', Buffer.from('body'));
    response.emit('end');
    response.emit('aborted');
    response.emit('error', new Error('contained'));
    response.emit('close');
    request.emit('error', new Error('contained'));
    request.emit('close');

    expect(receivers).toHaveLength(8);
    expect(receivers.every((receiver) => receiver === handlers)).toBe(true);
    facade.destroy();
    facade.dispose();
    credential.dispose();
  });

  it('applies auth only inside one fixed API request and returns an opaque facade', async () => {
    const request = new FakeRequest();
    let responseCallback: ((response: FakeResponse) => void) | undefined;
    https.request.mockImplementation((
      _options: RequestOptions,
      callback: (response: FakeResponse) => void,
    ) => {
      responseCallback = callback;
      return request;
    });
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubApiRequest(
      credential,
      Object.freeze({
        path: '/repos/octo/demo/commits/main?per_page=1',
        accept: 'application/vnd.github+json' as const,
        handlers,
      }),
    );

    expect(https.request).toHaveBeenCalledTimes(1);
    expect(https.request.mock.calls[0]?.[0]).toEqual({
      protocol: 'https:',
      hostname: 'api.github.com',
      port: 443,
      method: 'GET',
      path: '/repos/octo/demo/commits/main?per_page=1',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer api-boundary-secret',
        'User-Agent': 'takt-project-template',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Reflect.ownKeys(facade)).toEqual([
      'start',
      'destroy',
      'dispose',
    ]);
    expect(JSON.stringify(facade)).toBe('{}');
    expect(Object.values(facade).join(' ')).not.toContain(
      'api-boundary-secret',
    );

    facade.start();
    expect(request.end).toHaveBeenCalledTimes(1);
    const response = new FakeResponse(200);
    responseCallback?.(response);
    response.emit('data', Buffer.from('metadata'));
    response.emit('end');
    expect(handlers.onResponse).toHaveBeenCalledWith(200);
    expect(handlers.onData).toHaveBeenCalledTimes(1);
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);

    facade.destroy();
    expect(response.destroyed).toBe(true);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    const authorityDelete = vi.spyOn(WeakMap.prototype, 'delete');
    facade.dispose();
    expect(authorityDelete).toHaveBeenCalledWith(facade);
    expect(request.listenerCount('error')).toBe(0);
    expect(request.listenerCount('close')).toBe(0);
    expect(response.listenerCount('data')).toBe(0);
    expect(response.listenerCount('end')).toBe(0);
    expect(() => facade.start()).toThrow(expect.objectContaining({
      code: 'PROCESS_FAILED',
    }));
    credential.dispose();
  });

  it.each([
    'https://evil.example/repos/octo/demo',
    '//evil.example/repos/octo/demo',
    '/repos/octo/../demo',
    '/repos/octo/%2fadmin',
    '/repos/octo/demo?ref=%zz',
    '/repos/octo/demo?ref=main#fragment',
    '/repos/octo/demo?ref',
  ])('rejects unsafe API path without creating a request: %s', async (path) => {
    const credential = await acquireCredential();
    expect(() => createProjectTemplateGithubApiRequest(
      credential,
      {
        path,
        accept: 'application/vnd.github+json',
        handlers: makeHandlers(),
      },
    )).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(https.request).not.toHaveBeenCalled();
    credential.dispose();
  });
});
