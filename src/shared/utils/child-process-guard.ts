import type { ChildProcess } from 'node:child_process';

export type ChildProcessStreamSource = 'process' | 'stdin' | 'stdout' | 'stderr';

type RegisteredListener = {
  emitter: NodeJS.EventEmitter;
  handler: (error: Error) => void;
};

export function guardChildProcessStreams(
  child: ChildProcess,
  onError: (error: Error, source: ChildProcessStreamSource) => void,
): () => void {
  let tornDown = false;
  const listeners: RegisteredListener[] = [];
  const register = (
    emitter: NodeJS.EventEmitter | null | undefined,
    source: ChildProcessStreamSource,
  ): void => {
    if (emitter === null || emitter === undefined) return;
    const handler = (error: Error): void => onError(error, source);
    emitter.on('error', handler);
    listeners.push({ emitter, handler });
  };

  register(child, 'process');
  register(child.stdin, 'stdin');
  register(child.stdout, 'stdout');
  register(child.stderr, 'stderr');

  return (): void => {
    if (tornDown) return;
    tornDown = true;
    for (const { emitter, handler } of listeners) {
      emitter.removeListener('error', handler);
    }
    listeners.length = 0;
  };
}
