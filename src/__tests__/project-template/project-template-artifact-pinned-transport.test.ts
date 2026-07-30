import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  httpsRequest: vi.fn(),
}));

vi.mock('node:dns', () => ({ lookup: native.dnsLookup }));
vi.mock('node:https', () => ({ request: native.httpsRequest }));

import type { DisposableProjectTemplateGhCredential } from '../../infra/github/project-template-gh-auth.js';
import {
  bootstrapProjectTemplateArtifactRedirect,
  createProjectTemplateArtifactPinnedTransport,
  createProjectTemplateArtifactRedirectState,
  type DisposableProjectTemplateArtifactRedirectHop,
  type ProjectTemplateArtifactPinnedTransportHandlers,
} from '../../infra/github/project-template-artifact-redirect.js';

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

function makeHandlers(
  overrides: Partial<ProjectTemplateArtifactPinnedTransportHandlers> = {},
): ProjectTemplateArtifactPinnedTransportHandlers {
  return Object.freeze({
    onDnsRejected: vi.fn(),
    onResponse: vi.fn(),
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

function makeHop(
  target = 'https://objects.githubusercontent.com/private/file?sig=secret',
): DisposableProjectTemplateArtifactRedirectHop {
  const state = createProjectTemplateArtifactRedirectState(
    'https://api.github.com/repos/octo/demo/releases/assets/123',
  );
  return bootstrapProjectTemplateArtifactRedirect(
    state,
    302,
    target,
  ).consume();
}

afterEach(() => {
  vi.restoreAllMocks();
  native.dnsLookup.mockReset();
  native.httpsRequest.mockReset();
});

describe('project-template pinned artifact transport F2b-C slice 1', () => {
  it('nominally accepts only an opaque hop and exposes a sealed facade', () => {
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    expect(Object.isFrozen(transport)).toBe(true);
    expect(Reflect.ownKeys(transport)).toEqual([
      'start',
      'pause',
      'resume',
      'destroy',
      'dispose',
    ]);
    expect(JSON.stringify(transport)).toBe('{}');
    expect(inspect(transport)).not.toContain('secret');

    if (false) {
      const credential = undefined as unknown as
        DisposableProjectTemplateGhCredential;
      // @ts-expect-error credentials are not artifact-hop capabilities
      createProjectTemplateArtifactPinnedTransport(credential, handlers);
    }
    transport.dispose();
  });

  it('resolves once, snapshots answers, and creates one fixed unauthenticated request', () => {
    const request = new FakeRequest();
    let options: RequestOptions | undefined;
    native.httpsRequest.mockImplementation((
      value: RequestOptions,
    ) => {
      options = value;
      return request;
    });
    const answers = [
      { address: '93.184.216.34', family: 4 as const },
      { address: '2606:4700:4700::1111', family: 6 as const },
    ];
    native.dnsLookup.mockImplementation((
      hostname: string,
      lookupOptions: unknown,
      callback: (...args: unknown[]) => void,
    ) => {
      expect(hostname).toBe('objects.githubusercontent.com');
      expect(lookupOptions).toEqual({ all: true, verbatim: true });
      callback(null, answers);
      answers[0]!.address = '127.0.0.1';
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    transport.start();

    expect(native.dnsLookup).toHaveBeenCalledTimes(1);
    expect(native.httpsRequest).toHaveBeenCalledTimes(1);
    expect(options).toEqual({
      agent: false,
      protocol: 'https:',
      hostname: 'objects.githubusercontent.com',
      servername: 'objects.githubusercontent.com',
      port: 443,
      method: 'GET',
      path: '/private/file?sig=secret',
      headers: {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        Host: 'objects.githubusercontent.com',
        'User-Agent': 'takt-project-template',
      },
      lookup: expect.any(Function),
    });
    expect(Reflect.ownKeys(options!.headers as object)).toHaveLength(4);
    expect(JSON.stringify(options)).not.toContain('Authorization');
    expect(options).not.toHaveProperty('rejectUnauthorized');
    expect(options).not.toHaveProperty('checkServerIdentity');

    const lookup = options!.lookup!;
    const allCallback = vi.fn();
    lookup(
      'objects.githubusercontent.com',
      { all: true, family: 0 },
      allCallback,
    );
    expect(allCallback).toHaveBeenCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    const ipv4Callback = vi.fn();
    lookup(
      'objects.githubusercontent.com',
      { all: false, family: 4 },
      ipv4Callback,
    );
    expect(ipv4Callback).toHaveBeenCalledWith(
      null,
      '93.184.216.34',
      4,
    );
    const ipv6Callback = vi.fn();
    lookup(
      'objects.githubusercontent.com',
      { all: false, family: 6 },
      ipv6Callback,
    );
    expect(ipv6Callback).toHaveBeenCalledWith(
      null,
      '2606:4700:4700::1111',
      6,
    );
    const mismatch = vi.fn();
    lookup('evil.example', { all: false, family: 0 }, mismatch);
    expect(mismatch.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(String(mismatch.mock.calls[0]![0])).not.toContain('evil');
    transport.start();
    expect(native.dnsLookup).toHaveBeenCalledTimes(1);
    transport.dispose();
    const afterDispose = vi.fn();
    lookup(
      'objects.githubusercontent.com',
      { all: false, family: 4 },
      afterDispose,
    );
    expect(afterDispose.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it('validates exact handlers before consuming the hop', () => {
    const hop = makeHop();
    const handlers = makeHandlers();
    for (const invalid of [
      { ...handlers, onRedirect: vi.fn() },
      new Proxy(handlers, {}),
      { ...handlers, onDnsRejected: 'not-a-function' },
    ]) {
      expect(() => createProjectTemplateArtifactPinnedTransport(
        hop,
        invalid as never,
      )).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
    const transport = createProjectTemplateArtifactPinnedTransport(
      hop,
      handlers,
    );
    expect(() => Reflect.apply(transport.start, {}, [])).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    transport.dispose();
  });

  it.each([
    [],
    [{ address: '127.0.0.1', family: 4 }],
    [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
    new Proxy([{ address: '93.184.216.34', family: 4 }], {}),
    (() => {
      const sparse = new Array(1);
      return sparse;
    })(),
    new Array(65).fill({ address: '93.184.216.34', family: 4 }),
  ])('rejects invalid DNS snapshots %# without creating HTTPS', (answers) => {
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, answers));
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    transport.start();

    expect(native.httpsRequest).not.toHaveBeenCalled();
    expect(handlers.onDnsRejected).toHaveBeenCalledTimes(1);
    expect(handlers.onDnsRejected).toHaveBeenCalledWith();
    transport.dispose();
  });

  it('atomically consumes a hop and rejects forged, proxied, disposed, and reused hops', () => {
    const handlers = makeHandlers();
    const hop = makeHop();
    const transport = createProjectTemplateArtifactPinnedTransport(
      hop,
      handlers,
    );
    expect(() => createProjectTemplateArtifactPinnedTransport(
      hop,
      handlers,
    )).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    const disposed = makeHop();
    disposed.dispose();
    for (const invalid of [
      {},
      new Proxy(makeHop(), {}),
      disposed,
    ]) {
      expect(() => createProjectTemplateArtifactPinnedTransport(
        invalid as DisposableProjectTemplateArtifactRedirectHop,
        handlers,
      )).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
    transport.dispose();
  });

  it('settles DNS once and redacts resolver errors', () => {
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => {
      callback(new Error('private resolver cause'));
      callback(null, [{ address: '93.184.216.34', family: 4 }]);
    });
    const onDnsRejected = vi.fn(() => {
      throw new Error('private handler cause');
    });
    const handlers = makeHandlers({ onDnsRejected });
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    expect(() => transport.start()).not.toThrow();
    expect(onDnsRejected).toHaveBeenCalledTimes(1);
    expect(onDnsRejected).toHaveBeenCalledWith();
    expect(native.httpsRequest).not.toHaveBeenCalled();
    transport.dispose();
  });

  it('accepts a 200 response only after pausing and revoking attempt authority', () => {
    const request = new FakeRequest();
    const response = new FakeResponse(200);
    const pause = vi.spyOn(response, 'pause');
    const destroy = vi.spyOn(response, 'destroy');
    let options: RequestOptions | undefined;
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      value: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      options = value;
      callback(response);
      return request;
    });
    let transport!: ReturnType<
      typeof createProjectTemplateArtifactPinnedTransport
    >;
    const onResponse = vi.fn((statusCode: number) => {
      expect(statusCode).toBe(200);
      expect(pause).toHaveBeenCalledTimes(1);
      expect(response.isPaused()).toBe(true);
      for (const event of ['data', 'end', 'aborted', 'error', 'close']) {
        expect(response.listenerCount(event)).toBe(1);
      }
      expect(request.listenerCount('error')).toBe(0);
      expect(request.listenerCount('close')).toBe(0);
      const revokedLookup = vi.fn();
      options!.lookup!(
        'objects.githubusercontent.com',
        { all: false, family: 4 },
        revokedLookup,
      );
      expect(revokedLookup.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(() => transport.pause()).not.toThrow();
      expect(() => transport.resume()).not.toThrow();
      expect(response.isPaused()).toBe(true);
    });
    const handlers = makeHandlers({ onResponse });
    transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    expect(() => transport.start()).not.toThrow();
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(request.destroy).not.toHaveBeenCalled();
    expect(handlers.onInvalidResponse).not.toHaveBeenCalled();
    expect(handlers.onResponseError).not.toHaveBeenCalled();
    transport.dispose();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([100, 199, 201, 204, 300, 304, 404, 599])(
    'settles valid nonredirect status %i exactly once without secondary errors',
    (statusCode) => {
      const request = new FakeRequest();
      const response = new FakeResponse(statusCode);
      const responseDestroy = vi.spyOn(response, 'destroy');
      native.dnsLookup.mockImplementation((
        _hostname: string,
        _options: unknown,
        callback: (...args: unknown[]) => void,
      ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
      native.httpsRequest.mockImplementation((
        _options: RequestOptions,
        callback: (value: FakeResponse) => void,
      ) => {
        callback(response);
        return request;
      });
      const onResponse = vi.fn(() => {
        throw new Error('private consumer cause');
      });
      const handlers = makeHandlers({ onResponse });
      const transport = createProjectTemplateArtifactPinnedTransport(
        makeHop(),
        handlers,
      );

      expect(() => transport.start()).not.toThrow();
      expect(responseDestroy).toHaveBeenCalledTimes(1);
      expect(request.destroy).toHaveBeenCalledTimes(1);
      expect(onResponse).toHaveBeenCalledTimes(1);
      expect(onResponse).toHaveBeenCalledWith(statusCode);
      expect(handlers.onInvalidResponse).not.toHaveBeenCalled();
      expect(handlers.onResponseError).not.toHaveBeenCalled();
      transport.dispose();
    },
  );

  it('rolls back a 200 response when pausing fails', () => {
    const request = new FakeRequest();
    const response = new FakeResponse(200);
    vi.spyOn(response, 'pause').mockImplementation(() => {
      throw new Error('private pause failure');
    });
    const responseDestroy = vi.spyOn(response, 'destroy');
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    expect(() => transport.start()).not.toThrow();
    expect(responseDestroy).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(handlers.onResponseError).toHaveBeenCalledTimes(1);
    expect(handlers.onResponse).not.toHaveBeenCalled();
    expect(handlers.onInvalidResponse).not.toHaveBeenCalled();
    transport.dispose();
  });

  it('rolls back body ownership when the 200 response handler throws', () => {
    const request = new FakeRequest();
    const response = new FakeResponse(200);
    const responseDestroy = vi.spyOn(response, 'destroy');
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return request;
    });
    const handlers = makeHandlers({
      onResponse: vi.fn(() => {
        throw new Error('private response handler failure');
      }),
    });
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    expect(() => transport.start()).not.toThrow();
    expect(handlers.onResponse).toHaveBeenCalledWith(200);
    expect(handlers.onResponseError).toHaveBeenCalledTimes(1);
    expect(responseDestroy).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    for (const event of ['data', 'end', 'aborted', 'error', 'close']) {
      expect(response.listenerCount(event)).toBe(0);
    }
    transport.dispose();
  });

  it('contains reentrant disposal while pausing a body candidate', () => {
    const request = new FakeRequest();
    const response = new FakeResponse(200);
    const responseDestroy = vi.spyOn(response, 'destroy');
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );
    vi.spyOn(response, 'pause').mockImplementation(() => {
      transport.dispose();
      return response;
    });

    expect(() => transport.start()).not.toThrow();
    expect(responseDestroy).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(handlers.onResponse).not.toHaveBeenCalled();
    expect(handlers.onResponseError).not.toHaveBeenCalled();
  });

  it('rolls back partial response listener registration after reentrant disposal', () => {
    const request = new FakeRequest();
    const response = new FakeResponse(200);
    const responseDestroy = vi.spyOn(response, 'destroy');
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );
    response.once('newListener', (event) => {
      if (event === 'data') transport.dispose();
    });

    expect(() => transport.start()).not.toThrow();
    for (const event of ['data', 'end', 'aborted', 'error', 'close']) {
      expect(response.listenerCount(event)).toBe(0);
    }
    expect(responseDestroy).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(handlers.onResponse).not.toHaveBeenCalled();
    expect(handlers.onResponseError).not.toHaveBeenCalled();
  });

  it('ignores a queued request close after a 200 response claims ownership', () => {
    const request = new FakeRequest();
    const response = new FakeResponse(200);
    const originalPause = response.pause;
    vi.spyOn(response, 'pause').mockImplementation(() => {
      request.emit('close');
      return Reflect.apply(originalPause, response, []);
    });
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    transport.start();

    expect(handlers.onResponse).toHaveBeenCalledWith(200);
    expect(handlers.onRequestClose).not.toHaveBeenCalled();
    expect(handlers.onRequestError).not.toHaveBeenCalled();
    transport.dispose();
  });

  it.each(['destroy', 'dispose'] as const)(
    'allows synchronous %s from the accepted-response handler',
    (action) => {
      const request = new FakeRequest();
      const response = new FakeResponse(200);
      native.dnsLookup.mockImplementation((
        _hostname: string,
        _options: unknown,
        callback: (...args: unknown[]) => void,
      ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
      native.httpsRequest.mockImplementation((
        _options: RequestOptions,
        callback: (value: FakeResponse) => void,
      ) => {
        callback(response);
        return request;
      });
      let transport!: ReturnType<
        typeof createProjectTemplateArtifactPinnedTransport
      >;
      const handlers = makeHandlers({
        onResponse: vi.fn(() => transport[action]()),
      });
      transport = createProjectTemplateArtifactPinnedTransport(
        makeHop(),
        handlers,
      );

      expect(() => transport.start()).not.toThrow();
      expect(handlers.onResponse).toHaveBeenCalledTimes(1);
      expect(response.destroyed).toBe(true);
      expect(request.destroy).toHaveBeenCalledTimes(1);
      expect(handlers.onResponseError).not.toHaveBeenCalled();
      transport.dispose();
    },
  );

  it.each(['error', 'close'])(
    'terminally detaches before a reentrant request %s handler',
    (event) => {
      const request = new FakeRequest();
      native.dnsLookup.mockImplementation((
        _hostname: string,
        _options: unknown,
        callback: (...args: unknown[]) => void,
      ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
      native.httpsRequest.mockReturnValue(request);
      let transport!: ReturnType<
        typeof createProjectTemplateArtifactPinnedTransport
      >;
      const handler = vi.fn(() => {
        const reentrantActions = [
          () => request.emit(event, new Error('private reentrant cause')),
          () => transport.start(),
          () => transport.destroy(),
          () => transport.dispose(),
        ];
        for (const action of reentrantActions) {
          try {
            action();
          } catch {
            // Each operation must be attempted even when a prior terminal
            // operation correctly rejects re-entry.
          }
        }
        throw new Error('private handler cause');
      });
      const handlers = makeHandlers({
        [event === 'error' ? 'onRequestError' : 'onRequestClose']:
          handler,
      });
      transport = createProjectTemplateArtifactPinnedTransport(
        makeHop(),
        handlers,
      );
      request.destroy.mockImplementation(() => {
        request.emit('close');
      });
      transport.start();

      expect(() => request.emit(
        event,
        new Error('private outer cause'),
      )).not.toThrow();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith();
      expect(request.destroy).toHaveBeenCalledTimes(1);
      expect(request.listenerCount('error')).toBe(0);
      expect(request.listenerCount('close')).toBe(0);
      transport.dispose();
    },
  );

  it.each([
    null,
    new Proxy({}, {
      getOwnPropertyDescriptor(): never {
        throw new Error('private request descriptor');
      },
    }),
    Object.create(null),
  ])('contains invalid HTTPS request shape %#', (requestValue) => {
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockReturnValue(requestValue);
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    expect(() => transport.start()).not.toThrow();
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onDnsRejected).not.toHaveBeenCalled();
    transport.dispose();
  });

  it('contains a request when own-property reflection throws', () => {
    const request = new FakeRequest();
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockReturnValue(request);
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );
    const original = Object.getOwnPropertyDescriptor;
    vi.spyOn(Object, 'getOwnPropertyDescriptor').mockImplementation((
      value,
      property,
    ) => {
      if (value === request) throw new Error('private descriptor failure');
      return original(value, property);
    });

    expect(() => transport.start()).not.toThrow();
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onDnsRejected).not.toHaveBeenCalled();
    transport.dispose();
  });

  it.each([
    null,
    new Proxy({}, {
      getPrototypeOf(): never {
        throw new Error('private response prototype');
      },
    }),
  ])('contains invalid HTTPS response shape %#', (responseValue) => {
    const request = new FakeRequest();
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (value: never) => void,
    ) => {
      callback(responseValue as never);
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    expect(() => transport.start()).not.toThrow();
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    transport.dispose();
  });

  it('contains a response when prototype reflection throws', () => {
    const response = {};
    const request = new FakeRequest();
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (value: never) => void,
    ) => {
      callback(response as never);
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );
    const original = Object.getPrototypeOf;
    vi.spyOn(Object, 'getPrototypeOf').mockImplementation((value) => {
      if (value === response) throw new Error('private prototype failure');
      return original(value);
    });

    expect(() => transport.start()).not.toThrow();
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    transport.dispose();
  });

  it('supports strict IPv4 and IPv6 string lookup families', () => {
    const request = new FakeRequest();
    let options: RequestOptions | undefined;
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _lookupOptions: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]));
    native.httpsRequest.mockImplementation((value: RequestOptions) => {
      options = value;
      return request;
    });
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      makeHandlers(),
    );
    transport.start();

    const ipv4 = vi.fn();
    options!.lookup!(
      'objects.githubusercontent.com',
      { all: false, family: 'IPv4' },
      ipv4,
    );
    expect(ipv4).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const ipv6All = vi.fn();
    options!.lookup!(
      'objects.githubusercontent.com',
      { all: true, family: 'IPv6' },
      ipv6All,
    );
    expect(ipv6All).toHaveBeenCalledWith(null, [
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    transport.dispose();
  });

  it('iteratively follows three synchronous redirects into a paused 200', () => {
    const responses = [
      new FakeResponse(301, [
        'Location',
        'https://release-assets.githubusercontent.com/one',
      ]),
      new FakeResponse(302, [
        'location',
        'https://github-releases.githubusercontent.com/two',
      ]),
      new FakeResponse(308, [
        'LOCATION',
        'https://objects.githubusercontent.com/three',
      ]),
      new FakeResponse(200),
    ];
    const responseDestroys = responses.map(
      (response) => vi.spyOn(response, 'destroy'),
    );
    const requests: FakeRequest[] = [];
    const options: RequestOptions[] = [];
    let externalDepth = 0;
    let maximumExternalDepth = 0;
    const enterExternal = (): void => {
      externalDepth += 1;
      maximumExternalDepth = Math.max(maximumExternalDepth, externalDepth);
    };
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => {
      enterExternal();
      callback(null, [{ address: '93.184.216.34', family: 4 }]);
      externalDepth -= 1;
    });
    native.httpsRequest.mockImplementation((
      value: RequestOptions,
      callback: (response: FakeResponse) => void,
    ) => {
      enterExternal();
      options.push(value);
      const request = new FakeRequest();
      requests.push(request);
      callback(responses[requests.length - 1]!);
      externalDepth -= 1;
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    transport.start();

    expect(maximumExternalDepth).toBe(1);
    expect(native.dnsLookup).toHaveBeenCalledTimes(4);
    expect(native.httpsRequest).toHaveBeenCalledTimes(4);
    expect(options.map((value) => value.hostname)).toEqual([
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'github-releases.githubusercontent.com',
      'objects.githubusercontent.com',
    ]);
    for (const value of options) {
      expect(value.agent).toBe(false);
      expect(value.servername).toBe(value.hostname);
      expect((value.headers as Record<string, string>)['Host']).toBe(
        value.hostname,
      );
    }
    for (const destroy of responseDestroys.slice(0, -1)) {
      expect(destroy).toHaveBeenCalledTimes(1);
    }
    expect(responseDestroys.at(-1)).not.toHaveBeenCalled();
    for (const request of requests.slice(0, -1)) {
      expect(request.destroy).toHaveBeenCalledTimes(1);
    }
    expect(requests.at(-1)!.destroy).not.toHaveBeenCalled();
    expect(handlers.onInvalidResponse).not.toHaveBeenCalled();
    expect(handlers.onResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onResponse).toHaveBeenCalledWith(200);
    expect(handlers.onData).not.toHaveBeenCalled();
    expect(handlers.onEnd).not.toHaveBeenCalled();
    transport.dispose();
    expect(responseDestroys.at(-1)).toHaveBeenCalledTimes(1);
    expect(requests.at(-1)!.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects the fourth redirect without starting another attempt', () => {
    const responses = [
      new FakeResponse(301, [
        'Location',
        'https://release-assets.githubusercontent.com/one',
      ]),
      new FakeResponse(302, [
        'Location',
        'https://github-releases.githubusercontent.com/two',
      ]),
      new FakeResponse(307, [
        'Location',
        'https://objects.githubusercontent.com/three',
      ]),
      new FakeResponse(308, [
        'Location',
        'https://release-assets.githubusercontent.com/four',
      ]),
    ];
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (response: FakeResponse) => void,
    ) => {
      const request = new FakeRequest();
      callback(responses[native.httpsRequest.mock.calls.length - 1]!);
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    transport.start();

    expect(native.dnsLookup).toHaveBeenCalledTimes(4);
    expect(native.httpsRequest).toHaveBeenCalledTimes(4);
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    transport.dispose();
  });

  it.each([
    [],
    ['Location', 'https://objects.githubusercontent.com/a', 'location',
      'https://objects.githubusercontent.com/b'],
    ['Location', 123],
    Object.assign([
      'Location',
      'https://objects.githubusercontent.com/a',
    ], { extra: true }),
    (() => {
      const sparse = new Array(2);
      sparse[0] = 'Location';
      return sparse;
    })(),
    new Proxy([
      'Location',
      'https://objects.githubusercontent.com/a',
    ], {}),
    new Array(258).fill('x'),
    ['X-Large', 'x'.repeat(64 * 1024), 'Location',
      'https://objects.githubusercontent.com/a'],
  ])('rejects strict redirect rawHeaders %# without a next attempt', (headers) => {
    const request = new FakeRequest();
    const response = new FakeResponse(302, headers);
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    expect(() => transport.start()).not.toThrow();
    expect(native.dnsLookup).toHaveBeenCalledTimes(1);
    expect(native.httpsRequest).toHaveBeenCalledTimes(1);
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onInvalidResponse).toHaveBeenCalledWith();
    expect(handlers.onResponse).not.toHaveBeenCalled();
    transport.dispose();
  });

  it.each([
    'https://objects.githubusercontent.com/private/file?sig=secret',
    'https://evil.example/private',
  ])('rejects loop or forbidden redirect %s without a next attempt', (location) => {
    const request = new FakeRequest();
    const response = new FakeResponse(302, ['Location', location]);
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    transport.start();

    expect(native.dnsLookup).toHaveBeenCalledTimes(1);
    expect(native.httpsRequest).toHaveBeenCalledTimes(1);
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    transport.dispose();
  });

  it('rejects accessor rawHeaders without invoking it', () => {
    const request = new FakeRequest();
    const response = new FakeResponse(302);
    const getter = vi.fn(() => [
      'Location',
      'https://release-assets.githubusercontent.com/private',
    ]);
    Object.defineProperty(response, 'rawHeaders', {
      configurable: true,
      get: getter,
    });
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      callback(response);
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    transport.start();

    expect(getter).not.toHaveBeenCalled();
    expect(native.dnsLookup).toHaveBeenCalledTimes(1);
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    transport.dispose();
  });

  it.each(['invalid-return', 'throw-after-callback'])(
    'keeps a synchronous redirect behind the construction barrier: %s',
    (failure) => {
      const response = new FakeResponse(302, [
        'Location',
        'https://release-assets.githubusercontent.com/next',
      ]);
      const destroy = vi.spyOn(response, 'destroy');
      native.dnsLookup.mockImplementation((
        _hostname: string,
        _options: unknown,
        callback: (...args: unknown[]) => void,
      ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
      native.httpsRequest.mockImplementation((
        _options: RequestOptions,
        callback: (value: FakeResponse) => void,
      ) => {
        callback(response);
        if (failure === 'throw-after-callback') {
          throw new Error('private request construction');
        }
        return null;
      });
      const handlers = makeHandlers();
      const transport = createProjectTemplateArtifactPinnedTransport(
        makeHop(),
        handlers,
      );

      expect(() => transport.start()).not.toThrow();
      expect(native.dnsLookup).toHaveBeenCalledTimes(1);
      expect(native.httpsRequest).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
      transport.dispose();
    },
  );

  it('keeps lookup and callbacks pinned to their immutable attempt identity', () => {
    const dnsCallbacks: Array<(...args: unknown[]) => void> = [];
    const options: RequestOptions[] = [];
    const responseCallbacks: Array<(value: FakeResponse) => void> = [];
    const requests: FakeRequest[] = [];
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => {
      dnsCallbacks.push(callback);
    });
    native.httpsRequest.mockImplementation((
      value: RequestOptions,
      callback: (response: FakeResponse) => void,
    ) => {
      options.push(value);
      responseCallbacks.push(callback);
      const request = new FakeRequest();
      requests.push(request);
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );
    transport.start();
    dnsCallbacks[0]!(null, [
      { address: '93.184.216.34', family: 4 },
    ]);
    const oldLookup = options[0]!.lookup!;
    responseCallbacks[0]!(new FakeResponse(302, [
      'Location',
      'https://release-assets.githubusercontent.com/next',
    ]));

    expect(dnsCallbacks).toHaveLength(2);
    dnsCallbacks[0]!(null, [
      { address: '8.8.8.8', family: 4 },
    ]);
    expect(native.httpsRequest).toHaveBeenCalledTimes(1);
    const staleLookup = vi.fn();
    oldLookup(
      'objects.githubusercontent.com',
      { all: false, family: 4 },
      staleLookup,
    );
    expect(staleLookup.mock.calls[0]![0]).toBeInstanceOf(Error);

    dnsCallbacks[1]!(null, [
      { address: '8.8.8.8', family: 4 },
    ]);
    expect(native.httpsRequest).toHaveBeenCalledTimes(2);
    const currentLookup = vi.fn();
    options[1]!.lookup!(
      'release-assets.githubusercontent.com',
      { all: false, family: 4 },
      currentLookup,
    );
    expect(currentLookup).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    const late = new FakeResponse(302, [
      'Location',
      'https://objects.githubusercontent.com/late',
    ]);
    const lateDestroy = vi.spyOn(late, 'destroy');
    responseCallbacks[0]!(late);
    expect(lateDestroy).toHaveBeenCalledTimes(1);
    expect(native.dnsLookup).toHaveBeenCalledTimes(2);
    expect(requests[0]!.destroy).toHaveBeenCalledTimes(1);
    transport.dispose();
  });

  it('contains a duplicate response callback without duplicating the pump', () => {
    const first = new FakeResponse(302, [
      'Location',
      'https://release-assets.githubusercontent.com/next',
    ]);
    const duplicate = new FakeResponse(302, [
      'Location',
      'https://objects.githubusercontent.com/duplicate',
    ]);
    const duplicateDestroy = vi.spyOn(duplicate, 'destroy');
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      _options: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      const request = new FakeRequest();
      if (native.httpsRequest.mock.calls.length === 1) {
        callback(first);
        callback(duplicate);
      }
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    transport.start();

    expect(duplicateDestroy).toHaveBeenCalledTimes(1);
    expect(native.dnsLookup).toHaveBeenCalledTimes(2);
    expect(native.httpsRequest).toHaveBeenCalledTimes(2);
    expect(handlers.onInvalidResponse).not.toHaveBeenCalled();
    transport.dispose();
  });

  it('does not pump after redirect cleanup throws or disposes reentrantly', () => {
    const cases = ['response-throw', 'request-throw', 'dispose'] as const;
    for (const cleanupCase of cases) {
      native.dnsLookup.mockReset();
      native.httpsRequest.mockReset();
      const request = new FakeRequest();
      const response = new FakeResponse(302, [
        'Location',
        'https://release-assets.githubusercontent.com/next',
      ]);
      native.dnsLookup.mockImplementation((
        _hostname: string,
        _options: unknown,
        callback: (...args: unknown[]) => void,
      ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
      let transport!: ReturnType<
        typeof createProjectTemplateArtifactPinnedTransport
      >;
      if (cleanupCase === 'response-throw') {
        vi.spyOn(response, 'destroy').mockImplementation(() => {
          throw new Error('private response cleanup');
        });
      } else if (cleanupCase === 'request-throw') {
        request.destroy.mockImplementation(() => {
          throw new Error('private request cleanup');
        });
      } else {
        vi.spyOn(response, 'destroy').mockImplementation(() => {
          transport.dispose();
          return response;
        });
      }
      native.httpsRequest.mockImplementation((
        _options: RequestOptions,
        callback: (value: FakeResponse) => void,
      ) => {
        callback(response);
        return request;
      });
      const handlers = makeHandlers();
      transport = createProjectTemplateArtifactPinnedTransport(
        makeHop(),
        handlers,
      );

      expect(() => transport.start()).not.toThrow();
      expect(native.dnsLookup).toHaveBeenCalledTimes(1);
      expect(native.httpsRequest).toHaveBeenCalledTimes(1);
      if (cleanupCase === 'dispose') {
        expect(handlers.onInvalidResponse).not.toHaveBeenCalled();
      } else {
        expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
      }
      transport.dispose();
    }
  });

  it('releases an unstarted initial target when disposed', () => {
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(
        'https://objects.githubusercontent.com/private/unstarted?sig=secret',
      ),
      makeHandlers(),
    );

    transport.dispose();

    expect(native.dnsLookup).not.toHaveBeenCalled();
    expect(native.httpsRequest).not.toHaveBeenCalled();
    expect(inspect(transport)).not.toContain('unstarted');
    expect(inspect(transport)).not.toContain('secret');
  });

  it('contains a retained DNS callback after pending-attempt disposal', () => {
    let dnsCallback: ((...args: unknown[]) => void) | undefined;
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => {
      dnsCallback = callback;
    });
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(
        'https://objects.githubusercontent.com/private/pending?sig=secret',
      ),
      makeHandlers(),
    );
    transport.start();

    transport.dispose();
    dnsCallback!(null, [{ address: '93.184.216.34', family: 4 }]);

    expect(native.httpsRequest).not.toHaveBeenCalled();
    expect(inspect(dnsCallback)).not.toContain('pending');
    expect(inspect(dnsCallback)).not.toContain('93.184.216.34');
  });

  it('empties retained lookup secrets after a normal invalid response', () => {
    const request = new FakeRequest();
    const response = new FakeResponse(200);
    let options: RequestOptions | undefined;
    let respond: ((value: FakeResponse) => void) | undefined;
    native.dnsLookup.mockImplementation((
      _hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    native.httpsRequest.mockImplementation((
      value: RequestOptions,
      callback: (value: FakeResponse) => void,
    ) => {
      options = value;
      respond = callback;
      return request;
    });
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(
        'https://objects.githubusercontent.com/private/request?sig=secret',
      ),
      makeHandlers(),
    );
    transport.start();
    const retainedLookup = options!.lookup!;

    respond!(response);
    const late = vi.fn();
    retainedLookup(
      'objects.githubusercontent.com',
      { all: false, family: 4 },
      late,
    );

    expect(late.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(inspect(retainedLookup)).not.toContain('93.184.216.34');
    expect(inspect(retainedLookup)).not.toContain('sig=secret');
    expect(inspect(transport)).not.toContain('sig=secret');
    transport.dispose();
  });
});
