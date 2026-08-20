import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { guardChildProcessStreams } from '../shared/utils/child-process-guard.js';

function makeFakeChild(): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  return proc as ChildProcess;
}

describe('guardChildProcessStreams', () => {
  it.each(['process', 'stdin', 'stdout', 'stderr'] as const)(
    'forwards %s errors with their source',
    (source) => {
      const child = makeFakeChild();
      const onError = vi.fn();
      const teardown = guardChildProcessStreams(child, onError);
      const error = new Error(`${source} failed`);
      const emitter = source === 'process' ? child : child[source]!;

      emitter.emit('error', error);

      expect(onError).toHaveBeenCalledWith(error, source);
      teardown();
    },
  );

  it('tears down every listener idempotently', () => {
    const child = makeFakeChild();
    const onError = vi.fn();
    const teardown = guardChildProcessStreams(child, onError);
    const emitters = [child, child.stdin!, child.stdout!, child.stderr!];
    for (const emitter of emitters) emitter.on('error', () => undefined);

    teardown();
    teardown();
    for (const emitter of emitters) emitter.emit('error', new Error('after teardown'));

    expect(onError).not.toHaveBeenCalled();
  });
});
