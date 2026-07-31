import { describe, expect, it, vi } from 'vitest';
import {
  serializeProjectTemplateSourceDescriptor,
} from '../../features/project-template/source-descriptor.js';
import {
  resolveAuthenticatedGithubTemplateSource,
  type ProjectTemplateSourceResolverDependencies,
} from '../../infra/github/project-template-source-resolver.js';
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

describe('authenticated project-template source resolver F3', () => {
  it('projects all metadata, bounds checksum collection, and disposes once', async () => {
    const value = harness();

    await expect(resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    )).resolves.toMatchObject({
      commit: COMMIT,
      sha256: SHA256,
      version: '1.2.3',
      releaseId: 101,
      assetId: 201,
    });

    expect(value.acquireCredential).toHaveBeenCalledTimes(1);
    expect(value.requestMetadata).toHaveBeenCalledTimes(4);
    expect(value.openReleaseAsset).toHaveBeenCalledTimes(1);
    expect(value.openReleaseAsset).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'demo',
      releaseId: 101,
      assetId: 202,
      maxBytes: 4096,
    });
    expect(value.dispose).toHaveBeenCalledTimes(1);
    expect(value.rawBodies.every((body) =>
      body.every((byte) => byte === 0)
    )).toBe(true);
  });

  it('preserves receivers and the exact deadline/signal identity', async () => {
    const controller = new AbortController();
    const value = harness({ signal: controller.signal });

    await resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    );

    expect(value.receivers.length).toBeGreaterThan(0);
    expect(value.receivers.every((entry) =>
      entry.receiver === (
        entry.kind === 'asset'
          ? value.checksumAssets
          : value.dependencies
      )
    )).toBe(true);
    expect(value.acquireCredential.mock.calls[0]![0]).toEqual({
      deadlineMs: 10_000,
      signal: controller.signal,
    });
    for (const [request] of value.requestMetadata.mock.calls) {
      expect(request.deadlineMs).toBe(10_000);
      expect(request.signal).toBe(controller.signal);
    }
    expect(value.openReleaseAsset.mock.calls[0]![0].signal)
      .toBe(controller.signal);
  });

  it('redacts metadata failure and disposes the credential exactly once', async () => {
    const value = harness({
      requestMetadata: async () => {
        throw new Error(
          'token SECRET stdout stderr https://api.github.com/private',
        );
      },
    });

    const error = await resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'METADATA_PORT_FAILURE' });
    expect(String(error)).not.toContain('SECRET');
    expect(String(error)).not.toContain('stdout');
    expect(String(error)).not.toContain('https://');
    expect(value.dispose).toHaveBeenCalledTimes(1);
    expect(value.openReleaseAsset).not.toHaveBeenCalled();
  });

  it('keeps a successful result authoritative when credential disposal throws', async () => {
    const value = harness({ disposeThrows: true });

    await expect(resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    )).resolves.toMatchObject({ commit: COMMIT });
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not acquire for an invalid raw source', async () => {
    const value = harness();

    await expect(resolveAuthenticatedGithubTemplateSource({
      ...value.options,
      source: 'https://api.github.com/repos/private?token=SECRET',
    }, value.dependencies)).rejects.toMatchObject({
      code: 'INVALID_SOURCE_SPEC',
    });

    expect(value.acquireCredential).not.toHaveBeenCalled();
    expect(value.requestMetadata).not.toHaveBeenCalled();
    expect(value.openReleaseAsset).not.toHaveBeenCalled();
  });

  it('captures dependency and checksum methods before the first await', async () => {
    let releaseCredential!: (
      credential: DisposableProjectTemplateGhCredential,
    ) => void;
    const value = harness({
      acquireCredential: () => new Promise((resolve) => {
        releaseCredential = resolve;
      }),
      mutable: true,
    });
    const pending = resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    );
    const replacedRequest = vi.fn(() => {
      throw new Error('replaced request');
    });
    const replacedAsset = vi.fn(() => {
      throw new Error('replaced asset');
    });
    value.mutableDependencies!.requestMetadata = replacedRequest;
    value.mutableChecksumAssets!.openReleaseAsset = replacedAsset;
    releaseCredential(value.credential);

    await expect(pending).resolves.toMatchObject({ commit: COMMIT });
    expect(replacedRequest).not.toHaveBeenCalled();
    expect(replacedAsset).not.toHaveBeenCalled();
    expect(value.requestMetadata).toHaveBeenCalledTimes(4);
    expect(value.openReleaseAsset).toHaveBeenCalledTimes(1);
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });

  it('stops after a delayed aborted metadata settlement and disposes once', async () => {
    const controller = new AbortController();
    let rejectRequest!: (error: unknown) => void;
    const value = harness({
      signal: controller.signal,
      requestMetadata: () => new Promise((_resolve, reject) => {
        rejectRequest = reject;
      }),
    });
    const pending = resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    );

    await Promise.resolve();
    controller.abort('SECRET');
    rejectRequest(new Error('SECRET delayed request'));
    const error = await pending.catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'METADATA_PORT_FAILURE' });
    expect(String(error)).not.toContain('SECRET');
    expect(value.requestMetadata).toHaveBeenCalledTimes(1);
    expect(value.openReleaseAsset).not.toHaveBeenCalled();
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects a successful first response that settles after abort', async () => {
    const controller = new AbortController();
    let resolveRequest!: (body: Buffer) => void;
    let announceRequest!: () => void;
    const requestCalled = new Promise<void>((resolve) => {
      announceRequest = resolve;
    });
    const body = Buffer.from(JSON.stringify({ sha: COMMIT }));
    const value = harness({
      signal: controller.signal,
      requestMetadata: () => new Promise((resolve) => {
        announceRequest();
        resolveRequest = resolve;
      }),
    });
    const pending = resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    );

    await requestCalled;
    controller.abort('SECRET');
    resolveRequest(body);
    const error = await pending.catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'METADATA_PORT_FAILURE' });
    expect(String(error)).not.toContain('SECRET');
    expect(body.every((byte) => byte === 0)).toBe(true);
    expect(value.requestMetadata).toHaveBeenCalledTimes(1);
    expect(value.openReleaseAsset).not.toHaveBeenCalled();
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a credential that settles successfully after abort', async () => {
    const controller = new AbortController();
    let resolveCredential!: (
      credential: DisposableProjectTemplateGhCredential,
    ) => void;
    let announceCredential!: () => void;
    const credentialCalled = new Promise<void>((resolve) => {
      announceCredential = resolve;
    });
    const value = harness({
      signal: controller.signal,
      acquireCredential: () => new Promise((resolve) => {
        announceCredential();
        resolveCredential = resolve;
      }),
    });
    const pending = resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    );

    await credentialCalled;
    controller.abort('SECRET');
    resolveCredential(value.credential);
    const error = await pending.catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'METADATA_PORT_FAILURE' });
    expect(String(error)).not.toContain('SECRET');
    expect(value.requestMetadata).not.toHaveBeenCalled();
    expect(value.openReleaseAsset).not.toHaveBeenCalled();
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a malformed acquired credential exactly once', async () => {
    const dispose = vi.fn(() => undefined);
    const value = harness({
      acquireCredential: async () => Object.freeze({
        dispose,
        unexpected: true,
      }) as unknown as DisposableProjectTemplateGhCredential,
    });

    await expect(resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    )).rejects.toMatchObject({ code: 'METADATA_PORT_FAILURE' });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(value.requestMetadata).not.toHaveBeenCalled();
    expect(value.openReleaseAsset).not.toHaveBeenCalled();
  });

  it('copies descriptor bytes without invoking a hostile iterator and wipes it', async () => {
    const value = harness();
    const iterator = vi.fn(() => {
      throw new Error('SECRET iterator');
    });
    Object.defineProperty(value.rawBodies[1], Symbol.iterator, {
      configurable: true,
      get: iterator,
    });

    await expect(resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    )).resolves.toMatchObject({ commit: COMMIT });

    expect(iterator).not.toHaveBeenCalled();
    expect(value.rawBodies[1]!.every((byte) => byte === 0)).toBe(true);
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });

  it('uses its captured byte allocator when the mutable global is replaced', async () => {
    const value = harness();
    const NativeUint8Array = Uint8Array;
    const construct = vi.fn(() => {
      throw new Error('SECRET constructor');
    });
    const HostileUint8Array = new Proxy(function HostileUint8Array() {
      return undefined;
    }, {
      construct,
    });
    Object.defineProperty(HostileUint8Array, Symbol.hasInstance, {
      value: (candidate: unknown) => candidate instanceof NativeUint8Array,
    });
    const original = globalThis.Uint8Array;
    globalThis.Uint8Array = HostileUint8Array as unknown as
      Uint8ArrayConstructor;
    try {
      await expect(resolveAuthenticatedGithubTemplateSource(
        value.options,
        value.dependencies,
      )).resolves.toMatchObject({ commit: COMMIT });
    } finally {
      globalThis.Uint8Array = original;
    }

    expect(construct).not.toHaveBeenCalled();
    expect(value.rawBodies[1]!.every((byte) => byte === 0)).toBe(true);
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns a checksum iterator on overflow and consumes no later chunk', async () => {
    const returned = vi.fn(async () => ({
      value: undefined,
      done: true as const,
    }));
    const next = vi.fn()
      .mockResolvedValueOnce({
        value: new Uint8Array(4097),
        done: false,
      });
    const value = harness({
      checksumIterable: {
        [Symbol.asyncIterator]() {
          return { next, return: returned };
        },
      },
    });

    await expect(resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    )).rejects.toMatchObject({ code: 'METADATA_PORT_FAILURE' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(returned).toHaveBeenCalledTimes(1);
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns a checksum iterator whose next settles successfully after abort', async () => {
    const controller = new AbortController();
    let resolveNext!: (
      result: IteratorResult<Uint8Array>,
    ) => void;
    let announceNext!: () => void;
    const nextCalled = new Promise<void>((resolve) => {
      announceNext = resolve;
    });
    const returned = vi.fn(async () => ({
      value: undefined,
      done: true as const,
    }));
    const value = harness({
      signal: controller.signal,
      checksumIterable: {
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              announceNext();
              return new Promise((resolve) => {
                resolveNext = resolve;
              });
            },
            return: returned,
          };
        },
      },
    });
    const pending = resolveAuthenticatedGithubTemplateSource(
      value.options,
      value.dependencies,
    );

    await nextCalled;
    controller.abort('SECRET');
    resolveNext({
      value: new TextEncoder().encode(CHECKSUM),
      done: false,
    });
    const error = await pending.catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'METADATA_PORT_FAILURE' });
    expect(String(error)).not.toContain('SECRET');
    expect(returned).toHaveBeenCalledTimes(1);
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['open', 'iterator'] as const)(
    'stops before checksum next when %s synchronously aborts',
    async (boundary) => {
      const controller = new AbortController();
      const next = vi.fn(async () => ({
        value: new TextEncoder().encode(CHECKSUM),
        done: false as const,
      }));
      const createIterator = vi.fn(() => {
        if (boundary === 'iterator') controller.abort('SECRET');
        return { next };
      });
      const value = harness({
        signal: controller.signal,
        openReleaseAsset: () => {
          if (boundary === 'open') controller.abort('SECRET');
          return { [Symbol.asyncIterator]: createIterator };
        },
      });

      const error = await resolveAuthenticatedGithubTemplateSource(
        value.options,
        value.dependencies,
      ).catch((reason: unknown) => reason);

      expect(error).toMatchObject({ code: 'METADATA_PORT_FAILURE' });
      expect(String(error)).not.toContain('SECRET');
      expect(createIterator).toHaveBeenCalledTimes(
        boundary === 'open' ? 0 : 1,
      );
      expect(next).not.toHaveBeenCalled();
      expect(value.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects non-exact options and dependencies without side effects', async () => {
    const value = harness();
    const accessor = vi.fn(() => value.options.source);
    const portAccessor = vi.fn(() => value.openReleaseAsset);
    const accessorOptions = { ...value.options } as Record<string, unknown>;
    Object.defineProperty(accessorOptions, 'source', {
      enumerable: true,
      get: accessor,
    });
    const accessorPort = Object.create(Object.prototype);
    Object.defineProperty(accessorPort, 'openReleaseAsset', {
      enumerable: true,
      get: portAccessor,
    });
    for (const candidate of [
      accessorOptions,
      { ...value.options, extra: true },
      new Proxy(value.options, {}),
      { ...value.options, checksumAssets: accessorPort },
      { ...value.options, checksumAssets: ['checksum'] },
      {
        ...value.options,
        checksumAssets: new Proxy(value.checksumAssets, {}),
      },
    ]) {
      await expect(resolveAuthenticatedGithubTemplateSource(
        candidate as typeof value.options,
        value.dependencies,
      )).rejects.toBeInstanceOf(TypeError);
    }
    for (const candidate of [
      { ...value.dependencies, extra: true },
      new Proxy(value.dependencies, {}),
      Object.freeze({
        ...value.dependencies,
        requestMetadata: new Proxy(value.dependencies.requestMetadata, {}),
      }),
    ]) {
      await expect(resolveAuthenticatedGithubTemplateSource(
        value.options,
        candidate as ProjectTemplateSourceResolverDependencies,
      )).rejects.toBeInstanceOf(TypeError);
    }
    expect(accessor).not.toHaveBeenCalled();
    expect(portAccessor).not.toHaveBeenCalled();
    expect(value.acquireCredential).not.toHaveBeenCalled();
    expect(value.requestMetadata).not.toHaveBeenCalled();
    expect(value.openReleaseAsset).not.toHaveBeenCalled();
  });
});

function harness(overrides: {
  readonly signal?: AbortSignal;
  readonly mutable?: boolean;
  readonly acquireCredential?: (
  ) => Promise<DisposableProjectTemplateGhCredential>;
  readonly requestMetadata?: (
    options: Parameters<
      ProjectTemplateSourceResolverDependencies['requestMetadata']
    >[0],
  ) => Promise<Buffer>;
  readonly checksumIterable?: AsyncIterable<Uint8Array>;
  readonly openReleaseAsset?: () => AsyncIterable<Uint8Array>;
  readonly disposeThrows?: boolean;
} = {}) {
  const receivers: Array<{
    readonly kind: 'dependency' | 'asset';
    readonly receiver: unknown;
  }> = [];
  const dispose = vi.fn(() => {
    if (overrides.disposeThrows === true) {
      throw new Error('SECRET dispose');
    }
    return undefined;
  });
  const credential = Object.freeze({ dispose });
  const rawBodies = [
    Buffer.from(JSON.stringify({ sha: COMMIT })),
    Buffer.from(DESCRIPTOR),
    Buffer.from(JSON.stringify({ sha: COMMIT })),
    Buffer.from(JSON.stringify({
      id: 101,
      tag_name: 'v1.2.3',
      assets: [
        {
          id: 201,
          name: ASSET_NAME,
          size: 1024,
          browser_download_url: 'https://example.invalid/archive',
        },
        {
          id: 202,
          name: CHECKSUM_NAME,
          size: Buffer.byteLength(CHECKSUM),
          browser_download_url: 'https://example.invalid/checksum',
        },
      ],
    })),
  ];
  let requestIndex = 0;
  const acquireCredential = vi.fn(function (
    this: unknown,
  ): Promise<DisposableProjectTemplateGhCredential> {
    receivers.push({ kind: 'dependency', receiver: this });
    return overrides.acquireCredential?.() ?? Promise.resolve(credential);
  });
  const requestMetadata = vi.fn(async function (
    this: unknown,
    options: Parameters<
      ProjectTemplateSourceResolverDependencies['requestMetadata']
    >[0],
  ): Promise<Buffer> {
    receivers.push({ kind: 'dependency', receiver: this });
    if (overrides.requestMetadata !== undefined) {
      return overrides.requestMetadata(options);
    }
    const body = rawBodies[requestIndex]!;
    requestIndex += 1;
    return body;
  });
  const openReleaseAsset = vi.fn(function (
    this: unknown,
  ): AsyncIterable<Uint8Array> {
    receivers.push({ kind: 'asset', receiver: this });
    if (overrides.openReleaseAsset !== undefined) {
      return overrides.openReleaseAsset();
    }
    return overrides.checksumIterable ?? (async function* () {
      yield new TextEncoder().encode(CHECKSUM);
    })();
  });
  const mutableDependencies = {
    acquireCredential,
    requestMetadata,
  };
  const mutableChecksumAssets = { openReleaseAsset };
  const dependencies = overrides.mutable === true
    ? mutableDependencies
    : Object.freeze(mutableDependencies);
  const checksumAssets = overrides.mutable === true
    ? mutableChecksumAssets
    : Object.freeze(mutableChecksumAssets);
  return {
    options: Object.freeze({
      source: 'github:octo/demo@main',
      checksumAssets,
      deadlineMs: 10_000,
      ...(overrides.signal === undefined
        ? {}
        : { signal: overrides.signal }),
    }),
    dependencies,
    checksumAssets,
    mutableDependencies: overrides.mutable === true
      ? mutableDependencies
      : undefined,
    mutableChecksumAssets: overrides.mutable === true
      ? mutableChecksumAssets
      : undefined,
    credential,
    rawBodies,
    receivers,
    acquireCredential,
    requestMetadata,
    openReleaseAsset,
    dispose,
  };
}
