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
  constructor(readonly statusCode: number) {
    super();
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
  return state.resolve(302, target).consume();
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

  it('contains a synchronous HTTPS response as terminal invalid response', () => {
    const request = new FakeRequest();
    const response = new FakeResponse(200);
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
      return request;
    });
    const handlers = makeHandlers();
    const transport = createProjectTemplateArtifactPinnedTransport(
      makeHop(),
      handlers,
    );

    expect(() => transport.start()).not.toThrow();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(handlers.onInvalidResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onResponse).not.toHaveBeenCalled();
    transport.dispose();
  });
});
