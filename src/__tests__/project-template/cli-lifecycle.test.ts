import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTemplateCliSuccess,
} from '../../features/project-template/cli-machine-contract.js';
import {
  consumeProjectTemplateCliMutationAdmission,
  ProjectTemplateCliInvalidAdmission,
  startProjectTemplateCliLifecycle,
  type ProjectTemplateCliMutationAdmission,
} from '../../features/project-template/cli-lifecycle.js';

const PLAN_ID = 'a'.repeat(64);

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
  it('rejects arbitrary and proxied mutation admission functions', () => {
    expect(() => consumeProjectTemplateCliMutationAdmission(() => undefined))
      .toThrow(ProjectTemplateCliInvalidAdmission);
    expect(() => consumeProjectTemplateCliMutationAdmission(new Proxy(
      () => undefined,
      {},
    ))).toThrow(ProjectTemplateCliInvalidAdmission);
  });

  it('consumes lifecycle admission exactly once and invalidates it after settle', async () => {
    let retained: ProjectTemplateCliMutationAdmission | undefined;
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template apply', mode: 'apply', dispose: () => undefined,
      handle: async ({ admitMutation }) => {
        retained = admitMutation;
        consumeProjectTemplateCliMutationAdmission(admitMutation);
        expect(() => consumeProjectTemplateCliMutationAdmission(admitMutation))
          .toThrow(ProjectTemplateCliInvalidAdmission);
        return {
          envelope: createProjectTemplateCliSuccess({
            command: 'project-template apply', mode: 'apply',
            result: { planId: PLAN_ID, applied: true, backupId: 'backup-1', recoveryState: 'clean' },
          }),
          exitCode: 0,
        };
      },
    });
    await expect(execution.result).resolves.toMatchObject({ exitCode: 0 });
    expect(() => consumeProjectTemplateCliMutationAdmission(retained))
      .toThrow(ProjectTemplateCliInvalidAdmission);
  });
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
    const onAbort = vi.fn();
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template apply',
      mode: 'apply',
      dispose,
      handle: async ({ admitMutation, signal }) => {
        signal.addEventListener('abort', onAbort);
        admitMutation();
        admitted.resolve();
        await settle.promise;
        return {
          envelope: createProjectTemplateCliSuccess({
            command: 'project-template apply',
            mode: 'apply',
            result: {
              planId: PLAN_ID,
              applied: true,
              backupId: 'backup-1',
              recoveryState: 'clean',
            },
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
    expect(onAbort).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    execution.interrupt();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('redacts unexpected failures into the internal category and disposes once', async () => {
    const dispose = vi.fn(() => undefined);
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template inspect',
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

  it('maps synchronous handler throws and disposal rejection to internal', async () => {
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template inspect',
      mode: 'dry-run',
      dispose: () => Promise.reject(new Error('dispose failed')),
      handle: (() => {
        throw new Error('sync failure');
      }) as never,
    });

    await expect(execution.result).resolves.toMatchObject({
      exitCode: 70,
      envelope: { status: 'error', error: { code: 'INTERNAL' } },
    });
  });

  it('treats duplicate mutation admission as an internal protocol failure', async () => {
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template apply',
      mode: 'apply',
      dispose: () => undefined,
      handle: async ({ admitMutation }) => {
        admitMutation();
        admitMutation();
        return {
          envelope: createProjectTemplateCliSuccess({
            command: 'project-template apply',
            mode: 'apply',
            result: {
              planId: PLAN_ID,
              applied: true,
              backupId: 'backup-1',
              recoveryState: 'clean',
            },
          }),
          exitCode: 0,
        };
      },
    });

    await expect(execution.result).resolves.toMatchObject({
      exitCode: 25,
      envelope: { status: 'error', error: { code: 'RESULT_INDETERMINATE' } },
    });
  });

  it('reports an exception after admission as indeterminate', async () => {
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template apply',
      mode: 'apply',
      dispose: () => undefined,
      handle: async ({ admitMutation }) => {
        admitMutation();
        throw new Error('commit status unknown');
      },
    });

    await expect(execution.result).resolves.toMatchObject({
      exitCode: 25,
      envelope: { status: 'error', error: { code: 'RESULT_INDETERMINATE' } },
    });
  });

  it('reports disposal failure after admission as recovery-required', async () => {
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template apply',
      mode: 'apply',
      dispose: () => {
        throw new Error('lease cleanup failed');
      },
      handle: async ({ admitMutation }) => {
        admitMutation();
        return {
          envelope: createProjectTemplateCliSuccess({
            command: 'project-template apply',
            mode: 'apply',
            result: {
              planId: PLAN_ID,
              applied: true,
              backupId: 'backup-1',
              recoveryState: 'clean',
            },
          }),
          exitCode: 0,
        };
      },
    });

    await expect(execution.result).resolves.toMatchObject({
      exitCode: 25,
      envelope: { status: 'error', error: { code: 'RECOVERY_REQUIRED' } },
    });
  });
});
