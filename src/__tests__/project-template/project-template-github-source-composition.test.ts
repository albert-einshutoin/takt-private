import { describe, expect, it, vi } from 'vitest';
import {
  claimResolvedGithubTemplateSourceForDownload,
  discardResolvedGithubTemplateSourceDownloadClaim,
} from '../../features/project-template/github-update-check.js';
import * as githubUpdateCheck from '../../features/project-template/github-update-check.js';
import {
  serializeProjectTemplateSourceDescriptor,
} from '../../features/project-template/source-descriptor.js';
import type {
  ProjectTemplateArtifactSingleAttempt,
  ProjectTemplateArtifactSingleAttemptSettlement,
} from '../../infra/github/project-template-artifact-download-attempt.js';
import type {
  RequestProjectTemplateGithubApiMetadataOptions,
} from '../../infra/github/project-template-api-transport.js';
import {
  createProjectTemplateGithubSourceComposition,
  type ProjectTemplateGithubSourceCompositionDependencies,
} from '../../infra/github/project-template-github-source-composition.js';
import type {
  DisposableProjectTemplateGhCredential,
} from '../../infra/github/project-template-gh-auth.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SHA256 = 'a'.repeat(64);
const ASSET_NAME = 'template.taktpack';
const CHECKSUM_NAME = `${ASSET_NAME}.sha256`;
const CHECKSUM = `${SHA256}  ${ASSET_NAME}\n`;
const DESCRIPTOR = serializeProjectTemplateSourceDescriptor({
  schemaVersion: '1.0',
  pack: {
    version: '1.2.3',
    releaseTag: 'v1.2.3',
    assetName: ASSET_NAME,
    checksumAssetName: CHECKSUM_NAME,
    sha256: SHA256,
  },
  repertoireDependencies: [],
});

describe('authenticated GitHub source composition F4', () => {
  it('returns one frozen cold resolver/archive pair', () => {
    const dependencies = coldDependencies();

    const composition = createProjectTemplateGithubSourceComposition(
      Object.freeze({ deadlineMs: 10_000 }),
      dependencies.value,
    );
    const resolveAdvisory = composition.resolver.resolveAdvisory;
    const resolveForDownload = composition.resolver.resolveForDownload;
    const iterable = composition.archive.openReleaseAsset(Object.freeze({
      owner: 'octo',
      repo: 'demo',
      releaseId: 1,
      assetId: 2,
      maxBytes: 1024,
    }));
    const iterator = iterable[Symbol.asyncIterator]();

    expect(Reflect.ownKeys(composition)).toEqual(['resolver', 'archive']);
    expect(Object.isFrozen(composition)).toBe(true);
    expect(Object.isFrozen(composition.resolver)).toBe(true);
    expect(resolveAdvisory).toBeTypeOf('function');
    expect(resolveForDownload).toBeTypeOf('function');
    expect(iterator).toBeDefined();
    expect(dependencies.activity).toHaveLength(0);
  });

  it('resolves advisory and fresh authority with separate credentials and no cache', async () => {
    const value = integrationHarness();
    const composition = createProjectTemplateGithubSourceComposition(
      Object.freeze({ deadlineMs: 10_000 }),
      value.dependencies,
    );
    const input = Object.freeze({ source: 'github:octo/demo@main' });

    const advisory = await composition.resolver.resolveAdvisory(input);
    const activityAtApproval = value.activity.length;
    await Promise.resolve();
    await Promise.resolve();

    expect(advisory.kind).toBe('github-template-source-advisory');
    expect(Object.isFrozen(advisory)).toBe(true);
    expect(() => claimResolvedGithubTemplateSourceForDownload(advisory))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(value.activity).toHaveLength(activityAtApproval);
    expect(value.credentials).toHaveLength(2);
    expect(value.credentials.every(({ dispose }) =>
      dispose.mock.calls.length === 1
    )).toBe(true);

    const fresh = await composition.resolver.resolveForDownload(input);
    const claim = claimResolvedGithubTemplateSourceForDownload(fresh);
    expect(() => claimResolvedGithubTemplateSourceForDownload(fresh))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    discardResolvedGithubTemplateSourceDownloadClaim(claim);

    expect(value.credentials).toHaveLength(4);
    expect(new Set(value.credentials).size).toBe(4);
    expect(value.requestMetadata).toHaveBeenCalledTimes(8);
    expect(value.createAttempt).toHaveBeenCalledTimes(2);
    expect(value.credentials.every(({ dispose }) =>
      dispose.mock.calls.length === 1
    )).toBe(true);
  });

  it('forwards one deadline, signal identity, current values, and original receiver', async () => {
    const value = integrationHarness();
    const controller = new AbortController();
    const current = Object.freeze({
      owner: 'other',
      repo: 'demo',
      repositoryUrl: 'https://github.com/other/demo' as const,
      canonicalSource: 'github:other/demo@main',
      version: '1.0.0',
      sha256: 'b'.repeat(64),
      commit: '1123456789abcdef0123456789abcdef01234567',
      descriptorSha256: 'c'.repeat(64),
    });
    const composition = createProjectTemplateGithubSourceComposition(
      Object.freeze({ deadlineMs: 12_345 }),
      value.dependencies,
    );

    const fresh = await composition.resolver.resolveForDownload(
      Object.freeze({
        source: 'github:octo/demo@main',
        current,
        signal: controller.signal,
      }),
    );
    const claim = claimResolvedGithubTemplateSourceForDownload(fresh);
    discardResolvedGithubTemplateSourceDownloadClaim(claim);

    expect(value.receivers.length).toBeGreaterThan(0);
    expect(value.receivers.every((receiver) =>
      receiver === value.dependencies
    )).toBe(true);
    expect(value.acquireCredential.mock.calls.every(([options]) =>
      options.deadlineMs === 12_345
    )).toBe(true);
    expect(value.acquireCredential.mock.calls[0]![0].signal)
      .toBe(controller.signal);
    expect(value.requestMetadata.mock.calls.every(([options]) =>
      options.deadlineMs === 12_345
      && options.signal === controller.signal
    )).toBe(true);
    expect(value.attemptInputs[0]!.signal).toBe(controller.signal);
    expect(fresh.updateState).toBe('source-changed');
  });

  it('captures dependency methods and creates fresh work per factory instance', async () => {
    const value = integrationHarness({ mutable: true });
    const first = createProjectTemplateGithubSourceComposition(
      { deadlineMs: 10_000 },
      value.dependencies,
    );
    const original = { ...value.dependencies };
    for (const key of Reflect.ownKeys(value.dependencies)) {
      (value.dependencies as unknown as Record<string, unknown>)[
        key as string
      ] = () => {
        throw new Error('REPLACED_SECRET');
      };
    }
    await expect(first.resolver.resolveAdvisory({
      source: 'github:octo/demo@main',
    })).resolves.toMatchObject({
      kind: 'github-template-source-advisory',
    });

    Object.assign(value.dependencies, original);
    const second = createProjectTemplateGithubSourceComposition(
      { deadlineMs: 20_000 },
      value.dependencies,
    );
    await second.resolver.resolveAdvisory({
      source: 'github:octo/demo@main',
    });

    expect(first.archive).not.toBe(second.archive);
    expect(value.credentials).toHaveLength(4);
    expect(value.requestMetadata.mock.calls.slice(0, 4).every(([request]) =>
      request.deadlineMs === 10_000
    )).toBe(true);
    expect(value.requestMetadata.mock.calls.slice(4).every(([request]) =>
      request.deadlineMs === 20_000
    )).toBe(true);
  });

  it('uses another D4 credential only when the returned archive is pulled', async () => {
    const value = integrationHarness();
    const composition = createProjectTemplateGithubSourceComposition(
      { deadlineMs: 10_000 },
      value.dependencies,
    );
    await composition.resolver.resolveAdvisory({
      source: 'github:octo/demo@main',
    });
    expect(value.credentials).toHaveLength(2);

    const iterator = composition.archive.openReleaseAsset({
      owner: 'octo',
      repo: 'demo',
      releaseId: 101,
      assetId: 201,
      maxBytes: 1024,
    })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return!();

    expect(value.credentials).toHaveLength(3);
    expect(value.attemptInputs.map(({ assetId }) => assetId))
      .toEqual([202, 201]);
  });

  it.each(['map', 'freeze'] as const)(
    'redacts a poisoned advisory %s copy and retires its authority',
    async (attack) => {
      const value = integrationHarness();
      const composition = createProjectTemplateGithubSourceComposition(
        { deadlineMs: 10_000 },
        value.dependencies,
      );
      const originalDemote =
        githubUpdateCheck.demoteResolvedGithubTemplateSourceToAdvisory;
      let resolved:
        Parameters<typeof originalDemote>[0] | undefined;
      let restore = () => undefined;
      const demote = vi.spyOn(
        githubUpdateCheck,
        'demoteResolvedGithubTemplateSourceToAdvisory',
      ).mockImplementation((candidate) => {
        resolved = candidate;
        if (attack === 'map') {
          const descriptor = Object.getOwnPropertyDescriptor(
            Array.prototype,
            'map',
          )!;
          Object.defineProperty(Array.prototype, 'map', {
            ...descriptor,
            value() {
              throw new Error('SECRET_ADVISORY_COPY');
            },
          });
          restore = () => {
            Object.defineProperty(Array.prototype, 'map', descriptor);
          };
        } else {
          const descriptor = Object.getOwnPropertyDescriptor(
            Object,
            'freeze',
          )!;
          Object.defineProperty(Object, 'freeze', {
            ...descriptor,
            value() {
              throw new Error('SECRET_ADVISORY_COPY');
            },
          });
          restore = () => {
            Object.defineProperty(Object, 'freeze', descriptor);
          };
        }
        return originalDemote(candidate);
      });

      let error: unknown;
      try {
        error = await composition.resolver.resolveAdvisory({
          source: 'github:octo/demo@main',
        }).catch((caught: unknown) => caught);
      } finally {
        restore();
        demote.mockRestore();
      }

      expect(error).toMatchObject({
        code: 'METADATA_PORT_FAILURE',
        field: undefined,
      });
      expect((error as Error).message)
        .toBe('GitHub template source advisory composition failed');
      expect('cause' in (error as object)).toBe(false);
      expect(String((error as Error).stack))
        .not.toContain('SECRET_ADVISORY_COPY');
      expect(resolved).toBeDefined();
      expect(() => claimResolvedGithubTemplateSourceForDownload(resolved))
        .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
      expect(value.credentials).toHaveLength(2);
      expect(value.credentials.every(({ dispose }) =>
        dispose.mock.calls.length === 1
      )).toBe(true);
    },
  );

  it('rejects hostile exact boundaries before activity and redacts resolution failures', async () => {
    const value = integrationHarness();
    const accessor = vi.fn(() => value.dependencies.now);
    const withAccessor = Object.create(Object.prototype);
    Object.defineProperties(withAccessor, {
      now: { enumerable: true, get: accessor },
      setTimer: { enumerable: true, value: value.dependencies.setTimer },
      clearTimer: { enumerable: true, value: value.dependencies.clearTimer },
      acquireCredential: {
        enumerable: true,
        value: value.dependencies.acquireCredential,
      },
      createAttempt: {
        enumerable: true,
        value: value.dependencies.createAttempt,
      },
      requestMetadata: {
        enumerable: true,
        value: value.dependencies.requestMetadata,
      },
    });
    for (const dependencies of [
      { ...value.dependencies, extra: true },
      withAccessor,
      new Proxy(value.dependencies, {}),
      {
        ...value.dependencies,
        now: new Proxy(value.dependencies.now, {}),
      },
    ]) {
      expect(() => createProjectTemplateGithubSourceComposition(
        { deadlineMs: 10_000 },
        dependencies as ProjectTemplateGithubSourceCompositionDependencies,
      )).toThrow('GitHub source composition input is invalid');
    }
    expect(accessor).not.toHaveBeenCalled();
    expect(value.activity).toHaveLength(0);

    for (const context of [
      {},
      { deadlineMs: 10_000, extra: true },
      new Proxy({ deadlineMs: 10_000 }, {}),
    ]) {
      expect(() => createProjectTemplateGithubSourceComposition(
        context as { readonly deadlineMs: number },
        value.dependencies,
      )).toThrow('GitHub source composition input is invalid');
    }
    const composition = createProjectTemplateGithubSourceComposition(
      { deadlineMs: 10_000 },
      value.dependencies,
    );
    const sourceAccessor = vi.fn(() => 'github:octo/demo@main');
    const accessorInput = Object.defineProperty({}, 'source', {
      enumerable: true,
      get: sourceAccessor,
    });
    for (const input of [
      { source: 'github:octo/demo@main', extra: true },
      accessorInput,
      new Proxy({ source: 'github:octo/demo@main' }, {}),
    ]) {
      await expect(composition.resolver.resolveForDownload(
        input as { readonly source: string },
      )).rejects.toThrow('GitHub source composition input is invalid');
    }
    expect(sourceAccessor).not.toHaveBeenCalled();
    expect(value.activity).toHaveLength(0);

    const failing = integrationHarness({ rejectCredential: true });
    const error = await createProjectTemplateGithubSourceComposition(
      { deadlineMs: 10_000 },
      failing.dependencies,
    ).resolver.resolveAdvisory({
      source: 'github:octo/demo@main',
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'METADATA_PORT_FAILURE' });
    expect(String(error)).not.toContain('CREDENTIAL_SECRET');
    expect(failing.credentials).toHaveLength(0);

    const aborted = integrationHarness();
    const controller = new AbortController();
    controller.abort('ABORT_SECRET');
    const abortError = await createProjectTemplateGithubSourceComposition(
      { deadlineMs: 10_000 },
      aborted.dependencies,
    ).resolver.resolveForDownload({
      source: 'github:octo/demo@main',
      signal: controller.signal,
    }).catch((caught: unknown) => caught);
    expect(abortError).toMatchObject({ code: 'METADATA_PORT_FAILURE' });
    expect(String(abortError)).not.toContain('ABORT_SECRET');
    expect(aborted.credentials).toHaveLength(0);
  });
});

function coldDependencies(): {
  readonly value: ProjectTemplateGithubSourceCompositionDependencies;
  readonly activity: string[];
} {
  const activity: string[] = [];
  const called = (name: string) => () => {
    activity.push(name);
    throw new Error('not demanded');
  };
  return {
    value: Object.freeze({
      now: called('now') as () => number,
      setTimer: called('setTimer') as (
        callback: () => void,
        delayMs: number,
      ) => unknown,
      clearTimer: called('clearTimer'),
      acquireCredential: called('acquireCredential') as
        ProjectTemplateGithubSourceCompositionDependencies[
          'acquireCredential'
        ],
      createAttempt: called('createAttempt') as
        ProjectTemplateGithubSourceCompositionDependencies['createAttempt'],
      requestMetadata: called('requestMetadata') as
        ProjectTemplateGithubSourceCompositionDependencies['requestMetadata'],
    }),
    activity,
  };
}

function integrationHarness(options: {
  readonly mutable?: boolean;
  readonly rejectCredential?: boolean;
} = {}): {
  readonly dependencies: ProjectTemplateGithubSourceCompositionDependencies;
  readonly activity: string[];
  readonly receivers: unknown[];
  readonly credentials: Array<{
    readonly dispose: ReturnType<typeof vi.fn>;
  }>;
  readonly attemptInputs: Array<{
    readonly assetId: number;
    readonly signal?: AbortSignal;
  }>;
  readonly acquireCredential: ReturnType<typeof vi.fn>;
  readonly requestMetadata: ReturnType<typeof vi.fn>;
  readonly createAttempt: ReturnType<typeof vi.fn>;
} {
  const activity: string[] = [];
  const receivers: unknown[] = [];
  const credentials: Array<{
    readonly dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const attemptInputs: Array<{
    readonly assetId: number;
    readonly signal?: AbortSignal;
  }> = [];
  let dependencies!: ProjectTemplateGithubSourceCompositionDependencies;
  const now = vi.fn(function (this: unknown): number {
    activity.push('now');
    receivers.push(this);
    return 100;
  });
  const setTimer = vi.fn(function (
    this: unknown,
    _callback: () => void,
    _delayMs: number,
  ): unknown {
    activity.push('setTimer');
    receivers.push(this);
    return Object.freeze({});
  });
  const clearTimer = vi.fn(function (this: unknown): undefined {
    activity.push('clearTimer');
    receivers.push(this);
    return undefined;
  });
  const acquireCredential = vi.fn(function (
    this: unknown,
  ): Promise<DisposableProjectTemplateGhCredential> {
    activity.push('acquireCredential');
    receivers.push(this);
    if (options.rejectCredential === true) {
      return Promise.reject(new Error('CREDENTIAL_SECRET'));
    }
    const credential = Object.freeze({
      dispose: vi.fn(() => {
        activity.push('disposeCredential');
        return undefined;
      }),
    });
    credentials.push(credential);
    return Promise.resolve(credential);
  });
  const requestMetadata = vi.fn(async function (
    this: unknown,
    request: RequestProjectTemplateGithubApiMetadataOptions,
  ): Promise<Buffer> {
    activity.push('requestMetadata');
    receivers.push(this);
    if (request.path.includes('/contents/')) {
      return Buffer.from(DESCRIPTOR);
    }
    if (request.path.includes('/releases/tags/')) {
      return Buffer.from(JSON.stringify({
        id: 101,
        tag_name: 'v1.2.3',
        assets: [
          { id: 201, name: ASSET_NAME, size: 1024 },
          {
            id: 202,
            name: CHECKSUM_NAME,
            size: Buffer.byteLength(CHECKSUM),
          },
        ],
      }));
    }
    return Buffer.from(JSON.stringify({ sha: COMMIT }));
  });
  const createAttempt = vi.fn(function (
    this: unknown,
    _credential: DisposableProjectTemplateGhCredential,
    input: {
      readonly assetId: number;
      readonly signal?: AbortSignal;
    },
  ): ProjectTemplateArtifactSingleAttempt {
    activity.push('createAttempt');
    receivers.push(this);
    attemptInputs.push(input);
    let pullCount = 0;
    const bytes = input.assetId === 202
      ? new TextEncoder().encode(CHECKSUM)
      : Uint8Array.from([1, 2, 3]);
    return Object.freeze({
      pull(settlement: ProjectTemplateArtifactSingleAttemptSettlement) {
        activity.push('pull');
        if (pullCount === 0) {
          pullCount += 1;
          return settlement.chunk(bytes);
        }
        return settlement.done();
      },
      dispose() {
        activity.push('disposeAttempt');
        return undefined;
      },
    }) as unknown as ProjectTemplateArtifactSingleAttempt;
  });
  const value = {
    now,
    setTimer,
    clearTimer,
    acquireCredential,
    createAttempt,
    requestMetadata,
  };
  dependencies = options.mutable === true
    ? value
    : Object.freeze(value);
  return {
    dependencies,
    activity,
    receivers,
    credentials,
    attemptInputs,
    acquireCredential,
    requestMetadata,
    createAttempt,
  };
}
