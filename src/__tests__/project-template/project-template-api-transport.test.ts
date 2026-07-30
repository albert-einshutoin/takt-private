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
  type ProjectTemplateGithubApiRequestHandlers,
} from '../../infra/github/project-template-gh-auth.js';

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

async function acquireCredential() {
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

describe('project-template authenticated GitHub API boundary F2a', () => {
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
    facade.dispose();
    expect(request.listenerCount('error')).toBe(0);
    expect(request.listenerCount('close')).toBe(0);
    expect(response.listenerCount('data')).toBe(0);
    expect(response.listenerCount('end')).toBe(0);
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
