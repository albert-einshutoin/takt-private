import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTemplateCliSuccess,
} from '../../features/project-template/cli-machine-contract.js';
import {
  startProjectTemplateCliLifecycle,
} from '../../features/project-template/cli-lifecycle.js';

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('project template CLI lifecycle', () => {
  it('aborts before mutation admission with exit 130 and disposes once', async () => {
    const entered = deferred();
    const dispose = vi.fn(() => undefined);
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template apply',
      mode: 'apply',
      dispose,
      handle: async ({ signal }) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw new Error('unreachable');
      },
    });
    await entered.promise;

    execution.interrupt();
    execution.interrupt();
    const outcome = await execution.result;

    expect(outcome.exitCode).toBe(130);
    expect(outcome.envelope).toMatchObject({
      status: 'error',
      error: { code: 'INTERRUPTED' },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not admit a mutation after a pre-admission interrupt race', async () => {
    const entered = deferred();
    const continueToAdmission = deferred();
    const mutate = vi.fn();
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template apply',
      mode: 'apply',
      dispose: () => undefined,
      handle: async ({ admitMutation }) => {
        entered.resolve();
        await continueToAdmission.promise;
        admitMutation();
        mutate();
        throw new Error('unreachable');
      },
    });
    await entered.promise;

    execution.interrupt();
    continueToAdmission.resolve();
    const outcome = await execution.result;

    expect(outcome.exitCode).toBe(130);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('drains an admitted mutation to its settled outcome before disposal', async () => {
    const admitted = deferred();
    const settle = deferred();
    const dispose = vi.fn(() => undefined);
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template apply',
      mode: 'apply',
      dispose,
      handle: async ({ admitMutation }) => {
        admitMutation();
        admitted.resolve();
        await settle.promise;
        return {
          envelope: createProjectTemplateCliSuccess({
            command: 'project-template apply',
            mode: 'apply',
            result: { applied: true },
          }),
          exitCode: 0,
        };
      },
    });
    await admitted.promise;

    execution.interrupt();
    expect(dispose).not.toHaveBeenCalled();
    settle.resolve();
    const outcome = await execution.result;

    expect(outcome.exitCode).toBe(0);
    expect(outcome.envelope.status).toBe('success');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('redacts unexpected failures into the internal category and disposes once', async () => {
    const dispose = vi.fn(() => undefined);
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template preview',
      mode: 'dry-run',
      dispose,
      handle: () => Promise.reject(new Error('/Users/alice/.takt/credential leaked')),
    });

    const outcome = await execution.result;

    expect(outcome.exitCode).toBe(70);
    expect(outcome.envelope).toMatchObject({
      status: 'error',
      error: { code: 'INTERNAL' },
    });
    expect(JSON.stringify(outcome.envelope)).not.toContain('/Users/alice');
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
