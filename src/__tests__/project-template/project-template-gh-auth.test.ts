import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  acquireProjectTemplateGhCredential,
  ProjectTemplateGhAuthError,
  type ProjectTemplateGhAuthDependencies,
} from '../../infra/github/project-template-gh-auth.js';

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }
}

function finish(
  child: FakeChildProcess,
  options: {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    exitCode?: number;
    signal?: NodeJS.Signals | null;
  } = {},
): void {
  if (options.stdout !== undefined) child.stdout.end(options.stdout);
  else child.stdout.end();
  if (options.stderr !== undefined) child.stderr.end(options.stderr);
  else child.stderr.end();
  const exitCode = options.exitCode ?? 0;
  const signal = options.signal ?? null;
  child.emit('exit', exitCode, signal);
  child.emit('close', exitCode, signal);
}

function makeDependencies(child: FakeChildProcess): {
  dependencies: ProjectTemplateGhAuthDependencies;
  spawn: ReturnType<typeof vi.fn>;
} {
  const spawn = vi.fn(() => child as unknown as ChildProcess);
  return {
    dependencies: Object.freeze({ spawn }),
    spawn,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('project-template gh credential bootstrap F1', () => {
  it('runs one fixed non-shell auth command with a prompt-free allowlisted env', async () => {
    vi.stubEnv('PATH', '/safe/bin');
    vi.stubEnv('HOME', '/safe/home');
    vi.stubEnv('GH_TOKEN', 'token-from-env');
    vi.stubEnv('GH_DEBUG', 'api');
    vi.stubEnv('RANDOM_SECRET', 'must-not-cross');
    const child = new FakeChildProcess();
    const { dependencies, spawn } = makeDependencies(child);
    const pending = acquireProjectTemplateGhCredential(
      { deadlineMs: performance.now() + 10_000 },
      dependencies,
    );
    finish(child, { stdout: 'ghp_private_token\n' });
    const credential = await pending;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe('gh');
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      'auth',
      'token',
      '--hostname',
      'github.com',
    ]);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/safe/bin',
        HOME: '/safe/home',
        GH_TOKEN: 'token-from-env',
        GH_PROMPT_DISABLED: '1',
        GH_PAGER: 'cat',
        PAGER: 'cat',
        NO_COLOR: '1',
        TERM: 'dumb',
      },
    });
    const env = spawn.mock.calls[0]?.[2]?.env;
    expect(env).not.toHaveProperty('GH_DEBUG');
    expect(env).not.toHaveProperty('RANDOM_SECRET');
    expect(credential.withToken((token) => token)).toBe('ghp_private_token');
    credential.dispose();
  });

  it('zero-fills credential storage and rejects every use after disposal', async () => {
    const child = new FakeChildProcess();
    const { dependencies } = makeDependencies(child);
    const fill = vi.spyOn(Buffer.prototype, 'fill');
    const pending = acquireProjectTemplateGhCredential(
      { deadlineMs: performance.now() + 10_000 },
      dependencies,
    );
    finish(child, { stdout: 'secret-token\n' });
    const credential = await pending;
    expect(Object.isFrozen(credential)).toBe(true);
    expect(Reflect.ownKeys(credential)).toEqual(['withToken', 'dispose']);
    expect(() => Reflect.apply(
      credential.withToken,
      Object.freeze({}),
      [() => 'unused'],
    )).toThrow(expect.objectContaining({ code: 'CREDENTIAL_DISPOSED' }));
    credential.dispose();
    credential.dispose();

    const credentialWipes = fill.mock.instances.filter(
      (instance) => (instance as Buffer).length === 'secret-token'.length,
    ) as Buffer[];
    expect(credentialWipes).toHaveLength(1);
    const wiped = credentialWipes[0]!;
    expect([...wiped]).toEqual(new Array(wiped.length).fill(0));
    expect(() => credential.withToken(() => 'unused')).toThrow(
      expect.objectContaining({ code: 'CREDENTIAL_DISPOSED' }),
    );
  });

  it('rejects Promise and thenable callback results', async () => {
    const child = new FakeChildProcess();
    const { dependencies } = makeDependencies(child);
    const pending = acquireProjectTemplateGhCredential(
      { deadlineMs: performance.now() + 10_000 },
      dependencies,
    );
    finish(child, { stdout: 'secret-token\n' });
    const credential = await pending;

    expect(() => credential.withToken(async () => 'escaped')).toThrow(
      expect.objectContaining({ code: 'ASYNC_TOKEN_USE' }),
    );
    expect(() => credential.withToken(() => ({ then() {} }))).toThrow(
      expect.objectContaining({ code: 'ASYNC_TOKEN_USE' }),
    );
    credential.dispose();
  });

  it.each([
    [{ deadlineMs: 1, extra: true }, undefined],
    [Object.defineProperty({}, 'deadlineMs', { get: () => 1 }), undefined],
    [new Proxy({ deadlineMs: 1 }, { ownKeys: () => { throw new Error('trap'); } }), undefined],
    [{ deadlineMs: Number.NaN }, undefined],
    [{ deadlineMs: -1 }, undefined],
    [{
      deadlineMs: 1,
      signal: new Proxy(
        new AbortController().signal,
        { get: () => { throw new Error('trap'); } },
      ),
    }, undefined],
    [{ deadlineMs: 1 }, { spawn: () => undefined, extra: true }],
    [{ deadlineMs: 1 }, Object.defineProperty({}, 'spawn', { get: () => () => undefined })],
    [{ deadlineMs: 1 }, new Proxy({ spawn: () => undefined }, { get: () => { throw new Error('trap'); } })],
  ])('rejects hostile or non-exact options/seams before spawning', async (options, rawDependencies) => {
    const spawn = vi.fn();
    await expect(acquireProjectTemplateGhCredential(
      options as never,
      (rawDependencies ?? { spawn }) as never,
    )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses the smaller of 30 seconds and the shared monotonic deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValue(1_025);
    const child = new FakeChildProcess();
    const { dependencies } = makeDependencies(child);
    let settled = false;
    const pending = acquireProjectTemplateGhCredential(
      { deadlineMs: 1_050 },
      dependencies,
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(child.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(settled).toBe(false);
    finish(child, { exitCode: 1, signal: 'SIGKILL' });
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('does not spawn when the deadline is already exhausted', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const child = new FakeChildProcess();
    const { dependencies, spawn } = makeDependencies(child);
    await expect(acquireProjectTemplateGhCredential(
      { deadlineMs: 100 },
      dependencies,
    )).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('caps one authentication attempt at 30 seconds', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const child = new FakeChildProcess();
    const { dependencies } = makeDependencies(child);
    const pending = acquireProjectTemplateGhCredential(
      { deadlineMs: 100_000 },
      dependencies,
    );
    const observed = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(child.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(['SIGTERM']);
    finish(child, { exitCode: 1, signal: 'SIGTERM' });
    await expect(observed).resolves.toMatchObject({ code: 'TIMEOUT' });
  });

  it('aborts before spawn and terminates an in-flight process before rejecting', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const firstChild = new FakeChildProcess();
    const first = makeDependencies(firstChild);
    await expect(acquireProjectTemplateGhCredential(
      { signal: preAborted.signal, deadlineMs: performance.now() + 10_000 },
      first.dependencies,
    )).rejects.toMatchObject({ code: 'ABORTED' });
    expect(first.spawn).not.toHaveBeenCalled();

    const controller = new AbortController();
    const secondChild = new FakeChildProcess();
    const second = makeDependencies(secondChild);
    let settled = false;
    const pending = acquireProjectTemplateGhCredential(
      { signal: controller.signal, deadlineMs: performance.now() + 10_000 },
      second.dependencies,
    ).finally(() => {
      settled = true;
    });
    controller.abort();
    await Promise.resolve();
    expect(secondChild.signals).toEqual(['SIGTERM']);
    expect(settled).toBe(false);
    finish(secondChild, { exitCode: 2, signal: 'SIGTERM' });
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it.each([
    { channel: 'stdout', stdout: Buffer.alloc(4_097, 0x61), stderr: '' },
    { channel: 'stderr', stdout: '', stderr: Buffer.alloc(16_385, 0x61) },
  ])('bounds $channel bytes and redacts process output', async ({
    stdout,
    stderr,
  }) => {
    const child = new FakeChildProcess();
    const { dependencies } = makeDependencies(child);
    const pending = acquireProjectTemplateGhCredential(
      { deadlineMs: performance.now() + 10_000 },
      dependencies,
    );
    child.stdout.write(stdout);
    child.stderr.write(stderr);
    await Promise.resolve();
    expect(child.signals).toEqual(['SIGTERM']);
    finish(child, { exitCode: 1, stderr: 'GH_TOKEN=ghp_leaked_secret' });
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(String(error)).not.toContain('ghp_leaked_secret');
  });

  it.each([
    ['', 'INVALID_TOKEN'],
    [' leading\n', 'INVALID_TOKEN'],
    ['trailing \n', 'INVALID_TOKEN'],
    ['two words\n', 'INVALID_TOKEN'],
    ['token\r\n', 'INVALID_TOKEN'],
    ['token\u0000value\n', 'INVALID_TOKEN'],
    ['first\nsecond\n', 'INVALID_TOKEN'],
  ])('rejects a non-canonical token without leaking it: %j', async (stdout, code) => {
    const child = new FakeChildProcess();
    const { dependencies } = makeDependencies(child);
    const pending = acquireProjectTemplateGhCredential(
      { deadlineMs: performance.now() + 10_000 },
      dependencies,
    );
    finish(child, { stdout });
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code });
    if (stdout.trim() !== '') {
      expect(String(error)).not.toContain(stdout.trim());
    }
  });

  it('maps missing gh, authentication failure, and generic exit to finite errors', async () => {
    const missingChild = new FakeChildProcess();
    const missing = makeDependencies(missingChild);
    const missingPending = acquireProjectTemplateGhCredential(
      { deadlineMs: performance.now() + 10_000 },
      missing.dependencies,
    );
    missingChild.emit('error', Object.assign(new Error('spawn gh ENOENT'), {
      code: 'ENOENT',
    }));
    await expect(missingPending).rejects.toMatchObject({
      code: 'GH_UNAVAILABLE',
    });

    const authChild = new FakeChildProcess();
    const auth = makeDependencies(authChild);
    const authPending = acquireProjectTemplateGhCredential(
      { deadlineMs: performance.now() + 10_000 },
      auth.dependencies,
    );
    finish(authChild, {
      exitCode: 4,
      stderr: 'GH_TOKEN=ghp_leaked_secret',
    });
    await expect(authPending).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });

    const failedChild = new FakeChildProcess();
    const failed = makeDependencies(failedChild);
    const failedPending = acquireProjectTemplateGhCredential(
      { deadlineMs: performance.now() + 10_000 },
      failed.dependencies,
    );
    finish(failedChild, { exitCode: 1, stderr: 'random-private-canary' });
    const error = await failedPending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'PROCESS_FAILED' });
    expect(String(error)).not.toContain('random-private-canary');
  });

  it('settles once across error, exit, close, timeout, and abort races', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const child = new FakeChildProcess();
    const { dependencies } = makeDependencies(child);
    let settlements = 0;
    const pending = acquireProjectTemplateGhCredential(
      { signal: controller.signal, deadlineMs: performance.now() + 10 },
      dependencies,
    ).then(
      () => { settlements += 1; },
      (error: unknown) => {
        settlements += 1;
        throw error;
      },
    );
    const observed = pending.catch((error: unknown) => error);
    controller.abort();
    child.emit('error', Object.assign(new Error('late error'), { code: 'EIO' }));
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    await vi.advanceTimersByTimeAsync(20);

    await expect(observed).resolves.toBeInstanceOf(ProjectTemplateGhAuthError);
    expect(settlements).toBe(1);
  });
});
