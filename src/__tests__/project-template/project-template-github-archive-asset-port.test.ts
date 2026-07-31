import { describe, expect, it, vi } from 'vitest';
import type {
  GithubTemplateArchiveAssetInput,
} from '../../features/project-template/github-download-orchestrator.js';
import type {
  ProjectTemplateArtifactSingleAttempt,
  ProjectTemplateArtifactSingleAttemptSettlement,
} from '../../infra/github/project-template-artifact-download-attempt.js';
import {
  createProjectTemplateGithubArchiveAssetPort,
  type ProjectTemplateGithubArchiveAssetPortDependencies,
} from '../../infra/github/project-template-github-archive-asset-port.js';
import type {
  DisposableProjectTemplateGhCredential,
} from '../../infra/github/project-template-gh-auth.js';

const INPUT = Object.freeze({
  owner: 'octo',
  repo: 'demo',
  releaseId: 1,
  assetId: 2,
  maxBytes: 1024,
} satisfies GithubTemplateArchiveAssetInput);

describe('project-template GitHub archive asset port D5 composition', () => {
  it('remains fully cold through factory, open, and iterator creation', () => {
    const dependencies = controlledDependencies();
    const port = createProjectTemplateGithubArchiveAssetPort(
      Object.freeze({ deadlineMs: 10_000 }),
      dependencies.value,
    );
    const iterable = port.openReleaseAsset(INPUT);
    const iterator = iterable[Symbol.asyncIterator]();

    expect(iterator).toBeDefined();
    expect(dependencies.now).not.toHaveBeenCalled();
    expect(dependencies.setTimer).not.toHaveBeenCalled();
    expect(dependencies.clearTimer).not.toHaveBeenCalled();
    expect(dependencies.acquireCredential).not.toHaveBeenCalled();
    expect(dependencies.createAttempt).not.toHaveBeenCalled();
  });

  it('projects one dependency set into D1 and D4 with original receivers', async () => {
    let settlement!: ProjectTemplateArtifactSingleAttemptSettlement;
    const receivers: unknown[] = [];
    const timers: Array<{
      readonly callback: () => void;
      readonly delayMs: number;
      cleared: boolean;
    }> = [];
    const credential = Object.freeze({
      dispose: vi.fn(() => undefined),
    }) satisfies DisposableProjectTemplateGhCredential;
    const disposeAttempt = vi.fn(() => undefined);
    const attempt = Object.freeze({
      pull(value: ProjectTemplateArtifactSingleAttemptSettlement): undefined {
        settlement = value;
        return undefined;
      },
      dispose: disposeAttempt,
    }) as unknown as ProjectTemplateArtifactSingleAttempt;
    let dependencies!: ProjectTemplateGithubArchiveAssetPortDependencies;
    dependencies = Object.freeze({
      now(this: unknown): number {
        receivers.push(this);
        return 100;
      },
      setTimer(
        this: unknown,
        _callback: () => void,
        delayMs: number,
      ): unknown {
        receivers.push(this);
        const handle = {
          callback: _callback,
          delayMs,
          cleared: false,
        };
        timers.push(handle);
        return handle;
      },
      clearTimer(this: unknown, handle: unknown): undefined {
        receivers.push(this);
        (handle as (typeof timers)[number]).cleared = true;
        return undefined;
      },
      acquireCredential(this: unknown): Promise<
      DisposableProjectTemplateGhCredential
      > {
        receivers.push(this);
        return Promise.resolve(credential);
      },
      createAttempt(
        this: unknown,
        receivedCredential,
        input,
      ): ProjectTemplateArtifactSingleAttempt {
        receivers.push(this);
        expect(receivedCredential).toBe(credential);
        expect(input).toEqual(INPUT);
        expect(Object.isFrozen(input)).toBe(true);
        return attempt;
      },
    });
    const iterator = createProjectTemplateGithubArchiveAssetPort(
      Object.freeze({ deadlineMs: 200_000 }),
      dependencies,
    ).openReleaseAsset(INPUT)[Symbol.asyncIterator]();

    const pending = iterator.next();
    await Promise.resolve();
    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((receiver) => receiver === dependencies)).toBe(true);
    expect(timers.map(({ delayMs }) => delayMs)).toEqual([
      199_899,
      119_999,
    ]);
    settlement.chunk(Uint8Array.from([7]));
    await expect(pending).resolves.toEqual({
      value: Uint8Array.from([7]),
      done: false,
    });
    await iterator.return!();
    expect(timers.every(({ cleared }) => cleared)).toBe(true);
    expect(disposeAttempt).toHaveBeenCalledTimes(1);
    expect(credential.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['return', 'throw'] as const)(
    'keeps iterator.%s before first next fully cold',
    async (operation) => {
      const dependencies = controlledDependencies();
      const iterator = createProjectTemplateGithubArchiveAssetPort(
        Object.freeze({ deadlineMs: 10_000 }),
        dependencies.value,
      ).openReleaseAsset(INPUT)[Symbol.asyncIterator]();

      if (operation === 'return') {
        await expect(iterator.return!()).resolves.toEqual({
          value: undefined,
          done: true,
        });
      } else {
        await expect(iterator.throw!(new Error('SECRET_SENTINEL')))
          .rejects.toMatchObject({ code: 'CLOSED' });
      }

      expect(dependencies.now).not.toHaveBeenCalled();
      expect(dependencies.setTimer).not.toHaveBeenCalled();
      expect(dependencies.clearTimer).not.toHaveBeenCalled();
      expect(dependencies.acquireCredential).not.toHaveBeenCalled();
      expect(dependencies.createAttempt).not.toHaveBeenCalled();
    },
  );

  it('rejects non-exact dependency records without invoking accessors', () => {
    const dependencies = controlledDependencies();
    const accessor = vi.fn(() => dependencies.now);
    const withExtra = Object.freeze({
      ...dependencies.value,
      unexpected: true,
    });
    const missing = Object.freeze({
      now: dependencies.now,
      setTimer: dependencies.setTimer,
      clearTimer: dependencies.clearTimer,
      acquireCredential: dependencies.acquireCredential,
    });
    const withAccessor = Object.create(Object.prototype);
    Object.defineProperties(withAccessor, {
      now: { enumerable: true, get: accessor },
      setTimer: { enumerable: true, value: dependencies.setTimer },
      clearTimer: { enumerable: true, value: dependencies.clearTimer },
      acquireCredential: {
        enumerable: true,
        value: dependencies.acquireCredential,
      },
      createAttempt: {
        enumerable: true,
        value: dependencies.createAttempt,
      },
    });

    for (const value of [withExtra, missing, withAccessor]) {
      expect(() => createProjectTemplateGithubArchiveAssetPort(
        Object.freeze({ deadlineMs: 10_000 }),
        value as ProjectTemplateGithubArchiveAssetPortDependencies,
      )).toThrow('GitHub archive asset port input is invalid');
    }
    expect(accessor).not.toHaveBeenCalled();
  });

  it('rejects proxy dependencies, functions, and non-exact contexts', () => {
    const dependencies = controlledDependencies();
    const proxiedNow = new Proxy(dependencies.now, {
      apply: vi.fn(() => 100),
    });
    const invalidContexts = [
      Object.freeze({ deadlineMs: 10_000, unexpected: true }),
      Object.freeze({}),
      new Proxy({ deadlineMs: 10_000 }, {}),
    ];

    expect(() => createProjectTemplateGithubArchiveAssetPort(
      Object.freeze({ deadlineMs: 10_000 }),
      new Proxy(dependencies.value, {}),
    )).toThrow('GitHub archive asset port input is invalid');
    expect(() => createProjectTemplateGithubArchiveAssetPort(
      Object.freeze({ deadlineMs: 10_000 }),
      Object.freeze({ ...dependencies.value, now: proxiedNow }),
    )).toThrow('GitHub archive asset port input is invalid');
    for (const context of invalidContexts) {
      expect(() => createProjectTemplateGithubArchiveAssetPort(
        context as { readonly deadlineMs: number },
        dependencies.value,
      )).toThrow('GitHub archive asset port input is invalid');
    }
    expect(dependencies.now).not.toHaveBeenCalled();
  });

  it.each([
    ['throw', () => {
      throw new Error('SECRET_SENTINEL');
    }],
    ['reject', () => Promise.reject(new Error('SECRET_SENTINEL'))],
  ] as const)(
    'redacts credential %s failures at the public port boundary',
    async (_kind, acquireCredential) => {
      const dependencies = controlledDependencies();
      const iterator = createProjectTemplateGithubArchiveAssetPort(
        Object.freeze({ deadlineMs: 10_000 }),
        Object.freeze({
          ...dependencies.value,
          acquireCredential,
        }),
      ).openReleaseAsset(INPUT)[Symbol.asyncIterator]();

      const error = await iterator.next().catch((reason: unknown) => reason);

      expect(error).toMatchObject({ code: 'BRIDGE_FAILURE' });
      expect(String(error)).not.toContain('SECRET_SENTINEL');
      expect(dependencies.createAttempt).not.toHaveBeenCalled();
    },
  );

  it('creates the default port without activating authentication or timers', () => {
    const port = createProjectTemplateGithubArchiveAssetPort(
      Object.freeze({ deadlineMs: 10_000 }),
    );

    expect(() => port.openReleaseAsset(INPUT)).not.toThrow();
  });
});

function controlledDependencies(): {
  readonly value: ProjectTemplateGithubArchiveAssetPortDependencies;
  readonly now: ReturnType<typeof vi.fn>;
  readonly setTimer: ReturnType<typeof vi.fn>;
  readonly clearTimer: ReturnType<typeof vi.fn>;
  readonly acquireCredential: ReturnType<typeof vi.fn>;
  readonly createAttempt: ReturnType<typeof vi.fn>;
} {
  const now = vi.fn(() => 100);
  const setTimer = vi.fn(() => Object.freeze({}));
  const clearTimer = vi.fn(() => undefined);
  const acquireCredential = vi.fn(() => Promise.resolve(Object.freeze({
    dispose: () => undefined,
  })));
  const createAttempt = vi.fn(() => {
    throw new Error('not demanded');
  });
  return {
    value: Object.freeze({
      now,
      setTimer,
      clearTimer,
      acquireCredential,
      createAttempt,
    }),
    now,
    setTimer,
    clearTimer,
    acquireCredential,
    createAttempt,
  };
}
