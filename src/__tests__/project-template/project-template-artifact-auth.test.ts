import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
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
  createProjectTemplateGithubReleaseAssetRequest,
  type DisposableProjectTemplateGhCredential,
  type ProjectTemplateGithubReleaseAssetRequestHandlers,
} from '../../infra/github/project-template-gh-auth.js';
import type {
  DisposableProjectTemplateArtifactRedirectGrant,
  DisposableProjectTemplateArtifactRedirectHop,
} from '../../infra/github/project-template-artifact-redirect.js';

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
  constructor(
    readonly statusCode: number,
    rawHeaders: unknown = [],
  ) {
    super();
    Object.defineProperty(this, 'rawHeaders', {
      configurable: true,
      enumerable: true,
      value: rawHeaders,
      writable: true,
    });
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
  child.stdout.end('artifact-auth-secret\n');
  child.stderr.end();
  child.emit('close', 0, null);
  return pending;
}

function makeHandlers(
  overrides: Partial<ProjectTemplateGithubReleaseAssetRequestHandlers> = {},
): ProjectTemplateGithubReleaseAssetRequestHandlers {
  return Object.freeze({
    onResponse: vi.fn(),
    onRedirect: vi.fn(),
    onInvalidResponse: vi.fn(),
    onData: vi.fn(),
    onEnd: vi.fn(),
    onResponseAborted: vi.fn(),
    onResponseError: vi.fn(),
    onResponseClose: vi.fn(),
    onRequestError: vi.fn(),
    onRequestClose: vi.fn(),
    ...overrides,
  });
}

function captureRequest(): {
  request: FakeRequest;
  options: () => RequestOptions;
  respond: (response: FakeResponse) => void;
} {
  const request = new FakeRequest();
  let capturedOptions: RequestOptions | undefined;
  let callback: ((response: FakeResponse) => void) | undefined;
  https.request.mockImplementation((
    options: RequestOptions,
    responseCallback: (response: FakeResponse) => void,
  ) => {
    capturedOptions = options;
    callback = responseCallback;
    return request;
  });
  return {
    request,
    options: () => capturedOptions!,
    respond: (response) => callback!(response),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  https.request.mockReset();
});

describe('project-template authenticated release asset boundary F2b-B', () => {
  it('creates one fixed authenticated octet-stream request and opaque facade', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      Object.freeze({
        owner: 'octo',
        repo: 'demo',
        assetId: 123,
        handlers,
      }),
    );

    expect(attempt.options()).toEqual({
      protocol: 'https:',
      hostname: 'api.github.com',
      port: 443,
      method: 'GET',
      path: '/repos/octo/demo/releases/assets/123',
      headers: {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        Authorization: 'Bearer artifact-auth-secret',
        'User-Agent': 'takt-project-template',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Reflect.ownKeys(facade)).toEqual([
      'start',
      'pause',
      'resume',
      'destroy',
      'dispose',
    ]);
    expect(JSON.stringify(facade)).toBe('{}');
    expect(inspect(facade)).not.toContain('artifact-auth-secret');
    expect(Object.values(facade).join(' ')).not.toContain(
      'artifact-auth-secret',
    );
    facade.start();
    expect(attempt.request.end).toHaveBeenCalledTimes(1);
    facade.dispose();
    credential.dispose();
  });

  it('pauses 200 before transactional listeners and onResponse', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const response = new FakeResponse(200);
    const pause = vi.spyOn(response, 'pause');
    const resume = vi.spyOn(response, 'resume');
    const order: string[] = [];
    pause.mockImplementation(() => {
      order.push('pause');
      return response;
    });
    const handlers = makeHandlers({
      onResponse(status): void {
        order.push('response');
        expect(status).toBe(200);
        expect(response.listenerCount('data')).toBe(1);
        expect(response.listenerCount('end')).toBe(1);
        expect(response.listenerCount('error')).toBe(1);
        expect(response.listenerCount('close')).toBe(1);
      },
    });
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    attempt.respond(response);

    expect(order).toEqual(['pause', 'response']);
    facade.resume();
    facade.pause();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(2);
    response.emit('data', Buffer.from('raw-chunk'));
    response.emit('end');
    expect(handlers.onData).toHaveBeenCalledTimes(1);
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);

    facade.dispose();
    expect(response.listenerCount('data')).toBe(0);
    expect(response.listenerCount('end')).toBe(0);
    expect(response.listenerCount('error')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    credential.dispose();
  });

  it('transfers a redirect grant only after onRedirect returns normally', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    let handedOff:
      DisposableProjectTemplateArtifactRedirectGrant | undefined;
    const handlers = makeHandlers({
      onRedirect(grant): void {
        handedOff = grant;
      },
    });
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(302, [
      'Date',
      'private-date',
      'location',
      'https://objects.githubusercontent.com/private/file?token=secret',
    ]);
    const destroy = vi.spyOn(response, 'destroy');
    attempt.respond(response);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(handedOff).toBeDefined();
    expect(Reflect.ownKeys(handedOff!)).toEqual(['consume', 'dispose']);
    expect(inspect(handedOff)).not.toContain('token=secret');
    facade.dispose();
    const hop = handedOff!.consume();
    expect(Reflect.ownKeys(hop)).toEqual(['dispose']);
    hop.dispose();
    credential.dispose();
  });

  it('reclaims a synchronously consumed hop when onRedirect throws', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    let hop: DisposableProjectTemplateArtifactRedirectHop | undefined;
    const deletes = vi.spyOn(WeakMap.prototype, 'delete');
    const handlers = makeHandlers({
      onRedirect(grant): void {
        hop = grant.consume();
        throw new Error('redirect handler secret');
      },
    });
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    attempt.respond(new FakeResponse(307, [
      'Location',
      'https://objects.githubusercontent.com/private/file',
    ]));

    expect(handlers.onResponseError).toHaveBeenCalledTimes(1);
    expect(deletes).toHaveBeenCalledWith(hop);
    hop!.dispose();
    facade.dispose();
    credential.dispose();
  });

  it('does not transfer ownership when onRedirect reenters dispose', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    let facade!: ReturnType<
    typeof createProjectTemplateGithubReleaseAssetRequest
    >;
    let grant:
      DisposableProjectTemplateArtifactRedirectGrant | undefined;
    const handlers = makeHandlers({
      onRedirect(value): void {
        grant = value;
        facade.dispose();
      },
    });
    facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    attempt.respond(new FakeResponse(308, [
      'Location',
      'https://objects.githubusercontent.com/private/file',
    ]));

    expect(() => grant!.consume()).toThrow(expect.objectContaining({
      code: 'INVALID_ARGUMENT',
    }));
    facade.dispose();
    credential.dispose();
  });

  it.each([
    [],
    ['X-Test', 'value'],
    ['Location', 'https://objects.githubusercontent.com/a', 'location',
      'https://objects.githubusercontent.com/b'],
    ['Location', 123],
    Object.assign(['Location', 'https://objects.githubusercontent.com/a'], {
      extra: true,
    }),
    (() => {
      const headers = [
        'Location',
        'https://objects.githubusercontent.com/a',
      ];
      Object.defineProperty(headers, Symbol('private'), { value: true });
      return headers;
    })(),
    (() => {
      const sparse = new Array(2);
      sparse[0] = 'Location';
      return sparse;
    })(),
    new Proxy(['Location', 'https://objects.githubusercontent.com/a'], {
      ownKeys(): never {
        throw new Error('raw header secret');
      },
    }),
    new Array(258).fill('x'),
  ])('rejects hostile/missing/duplicate rawHeaders %#', async (rawHeaders) => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(302, rawHeaders);
    const destroy = vi.spyOn(response, 'destroy');
    attempt.respond(response);

    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onRedirect).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(handlers.onInvalidResponse).toHaveBeenCalledWith();
    facade.dispose();
    credential.dispose();
  });

  it('rejects an accessor rawHeaders without invoking it', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(302);
    const getter = vi.fn(() => {
      throw new Error('raw header getter secret');
    });
    Object.defineProperty(response, 'rawHeaders', {
      configurable: true,
      get: getter,
    });
    attempt.respond(response);

    expect(getter).not.toHaveBeenCalled();
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    facade.dispose();
    credential.dispose();
  });

  it('discards nonredirect bodies and reports only their status', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(404);
    const destroy = vi.spyOn(response, 'destroy');
    attempt.respond(response);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(handlers.onResponse).toHaveBeenCalledWith(404);
    expect(response.listenerCount('data')).toBe(0);
    facade.dispose();
    credential.dispose();
  });

  it('handles an https response callback before request() returns', async () => {
    const request = new FakeRequest();
    const response = new FakeResponse(200);
    const pause = vi.spyOn(response, 'pause');
    https.request.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return request;
    });
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );

    expect(pause).toHaveBeenCalledTimes(1);
    expect(handlers.onResponse).toHaveBeenCalledWith(200);
    facade.start();
    expect(request.end).toHaveBeenCalledTimes(1);
    facade.dispose();
    credential.dispose();
  });

  it.each(['data', 'end', 'error', 'close'])(
    'rolls back listeners when newListener(%s) reenters dispose',
    async (targetEvent) => {
      const attempt = captureRequest();
      const credential = await acquireCredential();
      const handlers = makeHandlers();
      const facade = createProjectTemplateGithubReleaseAssetRequest(
        credential,
        { owner: 'octo', repo: 'demo', assetId: 123, handlers },
      );
      const response = new FakeResponse(200);
      const reenter = (event: string): void => {
        if (event !== targetEvent) return;
        response.removeListener('newListener', reenter);
        facade.dispose();
      };
      response.on('newListener', reenter);
      attempt.respond(response);

      expect(handlers.onResponse).not.toHaveBeenCalled();
      expect(response.listenerCount('data')).toBe(0);
      expect(response.listenerCount('end')).toBe(0);
      expect(response.listenerCount('error')).toBe(0);
      expect(response.listenerCount('close')).toBe(0);
      credential.dispose();
    },
  );

  it.each(['end', 'error', 'close'])(
    'terminates listener installation when newListener(%s) triggers a data handler failure',
    async (targetEvent) => {
      const attempt = captureRequest();
      const credential = await acquireCredential();
      const handlers = makeHandlers({
        onData(): void {
          throw new Error('private response body');
        },
      });
      const facade = createProjectTemplateGithubReleaseAssetRequest(
        credential,
        { owner: 'octo', repo: 'demo', assetId: 123, handlers },
      );
      const response = new FakeResponse(200);
      const reenter = (event: string): void => {
        if (event !== targetEvent) return;
        response.removeListener('newListener', reenter);
        response.emit('data', Buffer.from('private response body'));
      };
      response.on('newListener', reenter);
      attempt.respond(response);

      expect(handlers.onResponse).not.toHaveBeenCalled();
      expect(handlers.onResponseError).toHaveBeenCalledTimes(1);
      for (const event of [
        'data',
        'end',
        'aborted',
        'error',
        'close',
      ]) {
        expect(response.listenerCount(event)).toBe(0);
      }
      expect(attempt.request.listenerCount('error')).toBe(0);
      expect(attempt.request.listenerCount('close')).toBe(0);
      expect(() => facade.start()).toThrow(expect.objectContaining({
        code: 'PROCESS_FAILED',
      }));
      facade.dispose();
      credential.dispose();
    },
  );

  it('detaches response resources before removeListener reenters dispose', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers({
      onData(): void {
        throw new Error('private response body');
      },
    });
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(200);
    const responseDestroy = vi.spyOn(response, 'destroy');
    const originalRemove = EventEmitter.prototype.removeListener;
    let reentered = false;
    vi.spyOn(EventEmitter.prototype, 'removeListener')
      .mockImplementation(function removeWithReentry(
        event: string | symbol,
        listener: (...args: unknown[]) => void,
      ): EventEmitter {
        const result = originalRemove.call(this, event, listener);
        if (this === response && !reentered) {
          reentered = true;
          facade.dispose();
        }
        return result;
      });
    attempt.respond(response);

    expect(() => response.emit(
      'data',
      Buffer.from('private response body'),
    )).not.toThrow();
    expect(responseDestroy).toHaveBeenCalledTimes(1);
    expect(attempt.request.destroy).toHaveBeenCalledTimes(1);
    expect(reentered).toBe(true);
    expect(handlers.onResponseError).not.toHaveBeenCalled();
    for (const event of ['data', 'end', 'aborted', 'error', 'close']) {
      expect(response.listenerCount(event)).toBe(0);
    }
    expect(attempt.request.listenerCount('error')).toBe(0);
    expect(attempt.request.listenerCount('close')).toBe(0);
    facade.dispose();
    credential.dispose();
  });

  it('detaches request resources before removeListener reenters dispose', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers({
      onRequestError(): void {
        throw new Error('private request cause');
      },
    });
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const reenter = (): void => {
      attempt.request.removeListener('removeListener', reenter);
      facade.dispose();
    };
    attempt.request.on('removeListener', reenter);

    expect(() => attempt.request.emit(
      'error',
      new Error('private request event'),
    )).not.toThrow();
    expect(attempt.request.destroy).toHaveBeenCalledTimes(1);
    expect(handlers.onResponseError).not.toHaveBeenCalled();
    expect(attempt.request.listenerCount('error')).toBe(0);
    expect(attempt.request.listenerCount('close')).toBe(0);
    facade.dispose();
    credential.dispose();
  });

  it('detaches redirect authority before hop disposal reenters dispose', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    let facade!: ReturnType<
      typeof createProjectTemplateGithubReleaseAssetRequest
    >;
    let hop: DisposableProjectTemplateArtifactRedirectHop | undefined;
    const handlers = makeHandlers({
      onRedirect(grant): void {
        hop = grant.consume();
        throw new Error('private redirect handler');
      },
    });
    facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const originalDelete = WeakMap.prototype.delete;
    let reentered = false;
    const deletes = vi.spyOn(WeakMap.prototype, 'delete')
      .mockImplementation(function deleteWithReentry(key: object): boolean {
        if (key === hop && !reentered) {
          reentered = true;
          facade.dispose();
        }
        return originalDelete.call(this, key);
      });

    expect(() => attempt.respond(new FakeResponse(302, [
      'Location',
      'https://objects.githubusercontent.com/private/file',
    ]))).not.toThrow();
    expect(reentered).toBe(true);
    expect(deletes.mock.calls.filter(([key]) => key === hop)).toHaveLength(1);
    expect(attempt.request.destroy).toHaveBeenCalledTimes(1);
    expect(handlers.onResponseError).not.toHaveBeenCalled();
    expect(attempt.request.listenerCount('error')).toBe(0);
    expect(attempt.request.listenerCount('close')).toBe(0);
    hop!.dispose();
    expect(deletes.mock.calls.filter(([key]) => key === hop)).toHaveLength(1);
    facade.dispose();
    credential.dispose();
  });

  it('terminally contains malformed redirect cleanup and callback failures', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const onInvalidResponse = vi.fn(() => {
      throw new Error('private malformed location');
    });
    const onResponseError = vi.fn(() => {
      throw new Error('private secondary failure');
    });
    const handlers = makeHandlers({
      onInvalidResponse,
      onResponseError,
    });
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(302, ['X-Private', 'secret']);
    vi.spyOn(response, 'destroy').mockImplementation(() => {
      throw new Error('private response destroy');
    });

    expect(() => attempt.respond(response)).not.toThrow();
    expect(onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(onResponseError).toHaveBeenCalledTimes(1);
    expect(attempt.request.destroy).toHaveBeenCalled();
    expect(attempt.request.listenerCount('error')).toBe(0);
    expect(attempt.request.listenerCount('close')).toBe(0);
    facade.dispose();
    credential.dispose();
  });

  it.each([false, true])(
    'cancels a redirect when response destroy reenters a second response (dispose=%s)',
    async (disposeFromInvalid) => {
      const attempt = captureRequest();
      const credential = await acquireCredential();
      let facade!: ReturnType<
        typeof createProjectTemplateGithubReleaseAssetRequest
      >;
      const onInvalidResponse = vi.fn(() => {
        if (disposeFromInvalid) facade.dispose();
      });
      const handlers = makeHandlers({ onInvalidResponse });
      facade = createProjectTemplateGithubReleaseAssetRequest(
        credential,
        { owner: 'octo', repo: 'demo', assetId: 123, handlers },
      );
      const second = new FakeResponse(500);
      const response = new FakeResponse(302, [
        'Location',
        'https://objects.githubusercontent.com/private/file',
      ]);
      const deletes = vi.spyOn(WeakMap.prototype, 'delete');
      vi.spyOn(response, 'destroy').mockImplementation(() => {
        attempt.respond(second);
        return response;
      });

      expect(() => attempt.respond(response)).not.toThrow();
      expect(handlers.onRedirect).not.toHaveBeenCalled();
      expect(onInvalidResponse).toHaveBeenCalledTimes(1);
      expect(handlers.onResponseError).not.toHaveBeenCalled();
      expect(deletes).toHaveBeenCalled();
      expect(attempt.request.destroy).toHaveBeenCalledTimes(1);
      expect(attempt.request.listenerCount('error')).toBe(0);
      expect(attempt.request.listenerCount('close')).toBe(0);
      facade.dispose();
      credential.dispose();
    },
  );

  it('cancels a nonredirect response when destroy reenters a second response', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(404);
    vi.spyOn(response, 'destroy').mockImplementation(() => {
      attempt.respond(new FakeResponse(500));
      return response;
    });

    expect(() => attempt.respond(response)).not.toThrow();
    expect(handlers.onResponse).not.toHaveBeenCalled();
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onResponseError).not.toHaveBeenCalled();
    expect(attempt.request.destroy).toHaveBeenCalledTimes(1);
    facade.dispose();
    credential.dispose();
  });

  it('latches invalid response ownership before destroy reentry', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(302, ['X-Private', 'secret']);
    vi.spyOn(response, 'destroy').mockImplementation(() => {
      attempt.respond(new FakeResponse(500));
      return response;
    });

    expect(() => attempt.respond(response)).not.toThrow();
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onResponseError).not.toHaveBeenCalled();
    expect(handlers.onRedirect).not.toHaveBeenCalled();
    expect(handlers.onResponse).not.toHaveBeenCalled();
    expect(attempt.request.destroy).toHaveBeenCalledTimes(1);
    facade.dispose();
    credential.dispose();
  });

  it('contains same and distinct late responses from terminal request destroy', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const lateSecond = new FakeResponse(500);
    const lateFirst = new FakeResponse(500);
    const originalLateDestroy = lateFirst.destroy;
    const lateDestroy = vi.spyOn(lateFirst, 'destroy')
      .mockImplementation((error) => {
        attempt.respond(lateFirst);
        attempt.respond(lateSecond);
        return Reflect.apply(originalLateDestroy, lateFirst, [error]);
      });
    attempt.request.destroy.mockImplementation(() => {
      attempt.respond(lateFirst);
      attempt.respond(Object.freeze({}) as FakeResponse);
    });

    expect(() => attempt.respond(new FakeResponse(
      302,
      ['X-Private', 'secret'],
    ))).not.toThrow();
    expect(lateDestroy).toHaveBeenCalledTimes(1);
    expect(lateFirst.destroyed).toBe(true);
    expect(lateSecond.destroyed).toBe(true);
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onResponseError).not.toHaveBeenCalled();
    expect(handlers.onResponse).not.toHaveBeenCalled();
    expect(handlers.onRedirect).not.toHaveBeenCalled();
    expect(lateFirst.listenerCount('data')).toBe(0);
    expect(lateSecond.listenerCount('data')).toBe(0);
    facade.dispose();
    credential.dispose();
  });

  it.each([40, 1_024])(
    'destroys every response in a finite late burst of %i',
    async (burstSize) => {
      const attempt = captureRequest();
      const credential = await acquireCredential();
      const handlers = makeHandlers();
      const facade = createProjectTemplateGithubReleaseAssetRequest(
        credential,
        { owner: 'octo', repo: 'demo', assetId: 123, handlers },
      );
      const burst = Array.from(
        { length: burstSize },
        () => new FakeResponse(500),
      );
      const burstDestroys = burst.map(
        (response) => vi.spyOn(response, 'destroy'),
      );
      const root = new FakeResponse(500);
      const originalRootDestroy = root.destroy;
      const rootDestroy = vi.spyOn(root, 'destroy')
        .mockImplementation((error) => {
          for (const response of burst) attempt.respond(response);
          return Reflect.apply(originalRootDestroy, root, [error]);
        });
      attempt.request.destroy.mockImplementation(() => {
        attempt.respond(root);
      });

      expect(() => attempt.respond(new FakeResponse(
        302,
        ['X-Private', 'secret'],
      ))).not.toThrow();
      expect(rootDestroy).toHaveBeenCalledTimes(1);
      expect(root.destroyed).toBe(true);
      for (let index = 0; index < burst.length; index += 1) {
        const response = burst[index]!;
        expect(response.destroyed).toBe(true);
        expect(response.readable).toBe(false);
        expect(burstDestroys[index]).toHaveBeenCalledTimes(1);
      }
      expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
      expect(handlers.onResponseError).not.toHaveBeenCalled();
      expect(handlers.onResponse).not.toHaveBeenCalled();
      expect(handlers.onRedirect).not.toHaveBeenCalled();
      facade.dispose();
      credential.dispose();
    },
  );

  it('destroys the same late response exactly once', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const duplicate = new FakeResponse(500);
    const duplicateDestroy = vi.spyOn(duplicate, 'destroy');
    const root = new FakeResponse(500);
    const originalRootDestroy = root.destroy;
    vi.spyOn(root, 'destroy').mockImplementation((error) => {
      for (let index = 0; index < 100; index += 1) {
        attempt.respond(duplicate);
      }
      return Reflect.apply(originalRootDestroy, root, [error]);
    });
    attempt.request.destroy.mockImplementation(() => {
      attempt.respond(root);
    });

    expect(() => attempt.respond(new FakeResponse(
      302,
      ['X-Private', 'secret'],
    ))).not.toThrow();
    expect(duplicateDestroy).toHaveBeenCalledTimes(1);
    expect(duplicate.destroyed).toBe(true);
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    facade.dispose();
    credential.dispose();
  });

  it('continues draining late responses after a destroy throws', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const burst = Array.from(
      { length: 40 },
      () => new FakeResponse(500),
    );
    const root = new FakeResponse(500);
    vi.spyOn(root, 'destroy').mockImplementation(() => {
      for (const response of burst) attempt.respond(response);
      throw new Error('private late destroy cause');
    });
    attempt.request.destroy.mockImplementation(() => {
      attempt.respond(root);
    });

    expect(() => attempt.respond(new FakeResponse(
      302,
      ['X-Private', 'secret'],
    ))).not.toThrow();
    expect(burst.every((response) => response.destroyed)).toBe(true);
    const afterDrain = new FakeResponse(500);
    attempt.respond(afterDrain);
    expect(afterDrain.destroyed).toBe(true);
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onResponseError).not.toHaveBeenCalled();
    facade.dispose();
    credential.dispose();
  });

  it('drains distinct late responses added by a nested burst', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const nested = Array.from(
      { length: 40 },
      () => new FakeResponse(500),
    );
    const first = new FakeResponse(500);
    const originalFirstDestroy = first.destroy;
    vi.spyOn(first, 'destroy').mockImplementation((error) => {
      for (const response of nested) attempt.respond(response);
      return Reflect.apply(originalFirstDestroy, first, [error]);
    });
    const root = new FakeResponse(500);
    const originalRootDestroy = root.destroy;
    vi.spyOn(root, 'destroy').mockImplementation((error) => {
      attempt.respond(first);
      return Reflect.apply(originalRootDestroy, root, [error]);
    });
    attempt.request.destroy.mockImplementation(() => {
      attempt.respond(root);
    });

    expect(() => attempt.respond(new FakeResponse(
      302,
      ['X-Private', 'secret'],
    ))).not.toThrow();
    expect(first.destroyed).toBe(true);
    expect(nested.every((response) => response.destroyed)).toBe(true);
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    facade.dispose();
    credential.dispose();
  });

  it('contains a late response from dispose destroy without callbacks', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(200);
    const late = new FakeResponse(500);
    const originalDestroy = response.destroy;
    vi.spyOn(response, 'destroy').mockImplementation((error) => {
      attempt.respond(late);
      return Reflect.apply(originalDestroy, response, [error]);
    });
    attempt.respond(response);

    expect(() => facade.dispose()).not.toThrow();
    expect(late.destroyed).toBe(true);
    expect(late.listenerCount('data')).toBe(0);
    expect(handlers.onResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onInvalidResponse).not.toHaveBeenCalled();
    expect(handlers.onResponseError).not.toHaveBeenCalled();
    facade.dispose();
    credential.dispose();
  });

  it('contains late destroy throws and non-readable callbacks without causes', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const late = new FakeResponse(500);
    const lateDestroy = vi.spyOn(late, 'destroy')
      .mockImplementation(() => {
        attempt.respond(Object.freeze({}) as FakeResponse);
        throw new Error('private late destroy cause');
      });
    attempt.request.destroy.mockImplementation(() => {
      attempt.respond(late);
    });

    expect(() => attempt.respond(new FakeResponse(
      302,
      ['X-Private', 'secret'],
    ))).not.toThrow();
    expect(lateDestroy).toHaveBeenCalledTimes(1);
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onResponseError).not.toHaveBeenCalled();
    expect(handlers.onResponse).not.toHaveBeenCalled();
    expect(handlers.onRedirect).not.toHaveBeenCalled();
    facade.dispose();
    credential.dispose();
  });

  it('marks secondary notification before its handler reenters dispose', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    let facade!: ReturnType<
      typeof createProjectTemplateGithubReleaseAssetRequest
    >;
    const onResponseError = vi.fn(() => {
      facade.dispose();
    });
    const handlers = makeHandlers({
      onData(): void {
        throw new Error('private response body');
      },
      onResponseError,
    });
    facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(200);
    const responseDestroy = vi.spyOn(response, 'destroy');
    attempt.respond(response);

    expect(() => response.emit(
      'data',
      Buffer.from('private response body'),
    )).not.toThrow();
    expect(onResponseError).toHaveBeenCalledTimes(1);
    expect(responseDestroy).toHaveBeenCalledTimes(1);
    expect(attempt.request.destroy).toHaveBeenCalledTimes(1);
    facade.dispose();
    credential.dispose();
  });

  it('cancels 200 listener installation when pause reenters a second response', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(200);
    vi.spyOn(response, 'pause').mockImplementation(() => {
      attempt.respond(new FakeResponse(500));
      return response;
    });

    expect(() => attempt.respond(response)).not.toThrow();
    expect(handlers.onResponse).not.toHaveBeenCalled();
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onResponseError).not.toHaveBeenCalled();
    for (const event of ['data', 'end', 'aborted', 'error', 'close']) {
      expect(response.listenerCount(event)).toBe(0);
    }
    expect(attempt.request.destroy).toHaveBeenCalledTimes(1);
    facade.dispose();
    credential.dispose();
  });

  it.each(['error', 'close'])(
    'terminally contains a throwing request %s handler',
    async (event) => {
      const attempt = captureRequest();
      const credential = await acquireCredential();
      const handlers = makeHandlers({
        [event === 'error' ? 'onRequestError' : 'onRequestClose'](): void {
          throw new Error('private request cause');
        },
      });
      const facade = createProjectTemplateGithubReleaseAssetRequest(
        credential,
        { owner: 'octo', repo: 'demo', assetId: 123, handlers },
      );

      expect(() => attempt.request.emit(
        event,
        new Error('private request event'),
      )).not.toThrow();
      expect(handlers.onResponseError).toHaveBeenCalledTimes(1);
      expect(attempt.request.destroy).toHaveBeenCalledTimes(1);
      expect(attempt.request.listenerCount('error')).toBe(0);
      expect(attempt.request.listenerCount('close')).toBe(0);
      facade.dispose();
      credential.dispose();
    },
  );

  it('rolls back request listeners when newListener throws', async () => {
    const request = new FakeRequest();
    const reenter = (event: string): void => {
      if (event === 'close') throw new Error('private newListener cause');
    };
    request.on('newListener', reenter);
    https.request.mockReturnValue(request);
    const credential = await acquireCredential();
    const handlers = makeHandlers();

    let caught: unknown;
    try {
      createProjectTemplateGithubReleaseAssetRequest(
        credential,
        { owner: 'octo', repo: 'demo', assetId: 123, handlers },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'PROCESS_FAILED' });
    expect(String(caught)).not.toContain('private');
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(request.listenerCount('error')).toBe(0);
    expect(request.listenerCount('close')).toBe(0);
    credential.dispose();
  });

  it('reclaims a sync redirect when request listener installation fails', async () => {
    const request = new FakeRequest();
    const response = new FakeResponse(302, [
      'Location',
      'https://objects.githubusercontent.com/private/file',
    ]);
    const responseDestroy = vi.spyOn(response, 'destroy');
    const reenter = (event: string): void => {
      if (event === 'close') throw new Error('private newListener cause');
    };
    request.on('newListener', reenter);
    https.request.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return request;
    });
    const credential = await acquireCredential();
    let grant:
      DisposableProjectTemplateArtifactRedirectGrant | undefined;
    const handlers = makeHandlers({
      onRedirect(value): void {
        grant = value;
      },
    });

    expect(() => createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    )).toThrow(expect.objectContaining({ code: 'PROCESS_FAILED' }));
    expect(responseDestroy).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(request.listenerCount('error')).toBe(0);
    expect(request.listenerCount('close')).toBe(0);
    expect(() => grant!.consume()).toThrow(expect.objectContaining({
      code: 'INVALID_ARGUMENT',
    }));
    credential.dispose();
  });

  it('rolls back the current request listener after synchronous terminal reentry', async () => {
    const request = new FakeRequest();
    const reenter = (event: string): void => {
      if (event !== 'close') return;
      request.removeListener('newListener', reenter);
      request.emit('error', new Error('private request event'));
    };
    request.on('newListener', reenter);
    https.request.mockReturnValue(request);
    const credential = await acquireCredential();
    const handlers = makeHandlers({
      onRequestError(): void {
        throw new Error('private request handler');
      },
    });

    expect(() => createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    )).toThrow(expect.objectContaining({ code: 'PROCESS_FAILED' }));
    expect(handlers.onResponseError).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(request.listenerCount('error')).toBe(0);
    expect(request.listenerCount('close')).toBe(0);
    credential.dispose();
  });

  it('reclaims a sync redirect if request creation later fails', async () => {
    const response = new FakeResponse(302, [
      'Location',
      'https://objects.githubusercontent.com/private/file',
    ]);
    let grant:
      DisposableProjectTemplateArtifactRedirectGrant | undefined;
    https.request.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return Object.freeze({});
    });
    const credential = await acquireCredential();
    const handlers = makeHandlers({
      onRedirect(value): void {
        grant = value;
      },
    });

    expect(() => createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    )).toThrow(expect.objectContaining({ code: 'PROCESS_FAILED' }));
    expect(() => grant!.consume()).toThrow(expect.objectContaining({
      code: 'INVALID_ARGUMENT',
    }));
    credential.dispose();
  });

  it('reclaims redirect authority when response destroy throws', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(302, [
      'Location',
      'https://objects.githubusercontent.com/private/file',
    ]);
    vi.spyOn(response, 'destroy').mockImplementation(() => {
      throw new Error('response destroy secret');
    });
    attempt.respond(response);

    expect(handlers.onRedirect).not.toHaveBeenCalled();
    expect(handlers.onResponseError).toHaveBeenCalledWith();
    facade.dispose();
    credential.dispose();
  });

  it('rejects a second response and destroys it without exposure', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    attempt.respond(new FakeResponse(200));
    const second = new FakeResponse(200);
    const destroy = vi.spyOn(second, 'destroy');
    attempt.respond(second);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    facade.dispose();
    credential.dispose();
  });

  it('redacts start, pause, resume, and destroy method failures', async () => {
    const attempt = captureRequest();
    attempt.request.end.mockImplementation(() => {
      throw new Error('end secret');
    });
    attempt.request.destroy.mockImplementation(() => {
      throw new Error('request destroy secret');
    });
    const credential = await acquireCredential();
    const handlers = makeHandlers();
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(200);
    const pause = vi.spyOn(response, 'pause');
    const resume = vi.spyOn(response, 'resume');
    attempt.respond(response);

    pause.mockImplementation(() => {
      throw new Error('pause secret');
    });
    resume.mockImplementation(() => {
      throw new Error('resume secret');
    });
    for (const operation of [
      () => facade.start(),
      () => facade.pause(),
      () => facade.resume(),
      () => facade.destroy(),
    ]) {
      let caught: unknown;
      try {
        operation();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'PROCESS_FAILED' });
      expect(String(caught)).not.toContain('secret');
    }
    facade.dispose();
    credential.dispose();
  });

  it('contains handler and raw chunk failures without exposing causes', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const handlers = makeHandlers({
      onData(): void {
        throw new Error('chunk handler secret');
      },
    });
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    const response = new FakeResponse(200);
    const destroy = vi.spyOn(response, 'destroy');
    attempt.respond(response);
    expect(() => response.emit(
      'data',
      Buffer.from('raw private body'),
    )).not.toThrow();

    expect(handlers.onResponseError).toHaveBeenCalledTimes(1);
    expect(handlers.onResponseError).toHaveBeenCalledWith();
    expect(destroy).toHaveBeenCalled();
    facade.dispose();
    credential.dispose();
  });

  it.each([
    { owner: 'owner--name' },
    { owner: 'owner-' },
    { repo: '..' },
    { repo: 'demo.git' },
    { assetId: 0 },
    { assetId: Number.MAX_SAFE_INTEGER + 1 },
    { assetId: 1.5 },
    { extra: true },
  ])('rejects noncanonical or non-exact plan %#', async (override) => {
    const credential = await acquireCredential();
    expect(() => createProjectTemplateGithubReleaseAssetRequest(
      credential,
      {
        owner: 'octo',
        repo: 'demo',
        assetId: 123,
        handlers: makeHandlers(),
        ...override,
      } as never,
    )).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(https.request).not.toHaveBeenCalled();
    credential.dispose();
  });

  it('uses strict receivers and does not expose request error causes', async () => {
    const attempt = captureRequest();
    const credential = await acquireCredential();
    const receivers: unknown[] = [];
    const handlers = makeHandlers({
      onRequestError(this: unknown): void {
        receivers.push(this);
      },
      onRequestClose(this: unknown): void {
        receivers.push(this);
      },
    });
    const facade = createProjectTemplateGithubReleaseAssetRequest(
      credential,
      { owner: 'octo', repo: 'demo', assetId: 123, handlers },
    );
    attempt.request.emit('error', new Error('request cause secret'));
    attempt.request.emit('close');

    expect(receivers).toEqual([handlers, handlers]);
    facade.dispose();
    expect(() => Reflect.apply(facade.start, {}, [])).toThrow(
      expect.objectContaining({ code: 'PROCESS_FAILED' }),
    );
    credential.dispose();
  });
});
