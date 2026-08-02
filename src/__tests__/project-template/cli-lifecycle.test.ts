import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTemplateCliSuccess,
} from '../../features/project-template/cli-machine-contract.js';
import {
  createProjectTemplateCliV1_1FailureFor,
  type ProjectTemplateCliV1_1Outcome,
} from '../../features/project-template/cli-machine-contract-v1-1.js';
import {
  consumeProjectTemplateCliMutationAdmission,
  ProjectTemplateCliInvalidAdmission,
  snapshotProjectTemplateCliOwnData,
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
  it('keeps schema 1.1 for interruption and disposal failures', async () => {
    const entered = deferred();
    const interrupted = startProjectTemplateCliLifecycle({
      command: 'project-template inspect', mode: 'dry-run', schemaVersion: '1.1',
      dispose: () => undefined,
      async handle({ signal }): Promise<ProjectTemplateCliV1_1Outcome> {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw new Error('unreachable');
      },
    });
    await entered.promise;
    interrupted.interrupt();
    await expect(interrupted.result).resolves.toMatchObject({
      exitCode: 130,
      envelope: { schemaVersion: '1.1', error: { code: 'INTERRUPTED' } },
    });

    const disposal = startProjectTemplateCliLifecycle({
      command: 'project-template inspect', mode: 'dry-run', schemaVersion: '1.1',
      dispose: () => Promise.reject(new Error('private cleanup detail')),
      async handle(): Promise<ProjectTemplateCliV1_1Outcome> {
        return {
          envelope: createProjectTemplateCliV1_1FailureFor({
            command: 'project-template inspect', mode: 'dry-run', code: 'INTERNAL',
          }),
          exitCode: 70,
        };
      },
    });
    await expect(disposal.result).resolves.toMatchObject({
      exitCode: 70,
      envelope: { schemaVersion: '1.1', error: { code: 'INTERNAL' } },
    });
  });

  it('rejects arbitrary and proxied mutation admission functions', () => {
    expect(() => consumeProjectTemplateCliMutationAdmission(() => undefined))
      .toThrow(ProjectTemplateCliInvalidAdmission);
    expect(() => consumeProjectTemplateCliMutationAdmission(new Proxy(
      () => undefined,
      {},
    ))).toThrow(ProjectTemplateCliInvalidAdmission);
  });

  it('snapshots own data with captured intrinsics after prototype poisoning', () => {
    const originalSome = Array.prototype.some;
    const originalIncludes = Array.prototype.includes;
    const originalReflectApply = Reflect.apply;
    let snapshot: Readonly<Record<string, unknown>> | undefined;
    let thrown: unknown;
    try {
      Array.prototype.some = (() => { throw new Error('poisoned some'); }) as typeof Array.prototype.some;
      Array.prototype.includes = (() => { throw new Error('poisoned includes'); }) as typeof Array.prototype.includes;
      Reflect.apply = (() => { throw new Error('poisoned apply'); }) as typeof Reflect.apply;
      snapshot = snapshotProjectTemplateCliOwnData({ required: 1 }, ['required'], []);
      try {
        snapshotProjectTemplateCliOwnData(Object.defineProperty({}, 'required', {
          get: () => { throw new Error('getter executed'); },
        }), ['required'], []);
      } catch (error) {
        thrown = error;
      }
    } finally {
      Array.prototype.some = originalSome;
      Array.prototype.includes = originalIncludes;
      Reflect.apply = originalReflectApply;
    }
    expect(snapshot).toEqual({ required: 1 });
    expect(thrown).toBeInstanceOf(ProjectTemplateCliInvalidAdmission);
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

  it('rejects direct use of an unconsumed capability after settlement', async () => {
    let retained: ProjectTemplateCliMutationAdmission | undefined;
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template apply', mode: 'apply', dispose: () => undefined,
      handle: async ({ admitMutation }) => {
        retained = admitMutation;
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
    expect(() => retained?.()).toThrow(ProjectTemplateCliInvalidAdmission);
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
