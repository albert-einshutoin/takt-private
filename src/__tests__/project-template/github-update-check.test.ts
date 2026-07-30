import { describe, expect, it } from 'vitest';
import { DEFAULT_TAKTPACK_LIMITS } from '../../features/project-template/archive-types.js';
import { parseProjectTemplateGithubSourceSpec } from '../../features/project-template/github-source-spec.js';
import {
  GithubTemplateSourceResolutionError,
  resolveGithubTemplateSource,
  type GithubTemplateSourceMetadataPort,
} from '../../features/project-template/github-update-check.js';
import {
  calculateProjectTemplateSourceDescriptorSha256,
  serializeProjectTemplateSourceDescriptor,
} from '../../features/project-template/source-descriptor.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ARCHIVE_SHA = 'a'.repeat(64);
const ASSET_NAME = 'template.taktpack';
const CHECKSUM_NAME = `${ASSET_NAME}.sha256`;
const CHECKSUM_LINE = `${ARCHIVE_SHA}  ${ASSET_NAME}\n`;
const CURRENT_IDENTITY = {
  owner: 'acme',
  repo: 'template',
  repositoryUrl: 'https://github.com/acme/template',
} as const;

function descriptor(version = '1.2.3'): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    pack: {
      version,
      releaseTag: `v${version}`,
      assetName: ASSET_NAME,
      checksumAssetName: CHECKSUM_NAME,
      sha256: ARCHIVE_SHA,
    },
    repertoireDependencies: [{
      scope: '@acme/dependency',
      version: '2.0.0',
      source: 'github:acme/dependency@v2.0.0',
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
      capabilities: ['edit'],
    }],
  };
}

function releaseMetadata(
  assets: unknown[] = [
    { id: 201, name: ASSET_NAME, size: 1024 },
    { id: 202, name: CHECKSUM_NAME, size: CHECKSUM_LINE.length },
  ],
): Record<string, unknown> {
  return {
    id: 101,
    tagName: 'v1.2.3',
    assets,
  };
}

interface PortFixture {
  port: GithubTemplateSourceMetadataPort;
  calls: Array<{ method: string; input: unknown }>;
}

function createPort(overrides: Partial<GithubTemplateSourceMetadataPort> = {}): PortFixture {
  const calls: Array<{ method: string; input: unknown }> = [];
  const canonicalDescriptor = serializeProjectTemplateSourceDescriptor(descriptor());
  const base: GithubTemplateSourceMetadataPort = {
    async resolveRefToCommit(input) {
      calls.push({ method: 'resolveRefToCommit', input });
      return { commit: COMMIT };
    },
    async readFileAtCommit(input) {
      calls.push({ method: 'readFileAtCommit', input });
      return new TextEncoder().encode(canonicalDescriptor);
    },
    async getReleaseByTag(input) {
      calls.push({ method: 'getReleaseByTag', input });
      return releaseMetadata();
    },
    async readReleaseAsset(input) {
      calls.push({ method: 'readReleaseAsset', input });
      return new TextEncoder().encode(CHECKSUM_LINE);
    },
  };
  const port: GithubTemplateSourceMetadataPort = {
    resolveRefToCommit: overrides.resolveRefToCommit ?? base.resolveRefToCommit,
    readFileAtCommit: overrides.readFileAtCommit ?? base.readFileAtCommit,
    getReleaseByTag: overrides.getReleaseByTag ?? base.getReleaseByTag,
    readReleaseAsset: overrides.readReleaseAsset ?? base.readReleaseAsset,
  };
  return { port, calls };
}

describe('resolveGithubTemplateSource', () => {
  it.each([
    ['extra string key', (source: Record<PropertyKey, unknown>) => {
      source['unexpected'] = true;
      return source;
    }],
    ['symbol key', (source: Record<PropertyKey, unknown>) => {
      source[Symbol('unexpected')] = true;
      return source;
    }],
    ['accessor', (source: Record<PropertyKey, unknown>) => {
      Object.defineProperty(source, 'owner', {
        enumerable: true,
        get: () => 'acme',
      });
      return source;
    }],
    ['replaced prototype', (source: Record<PropertyKey, unknown>) => {
      return Object.assign(Object.create({}), source);
    }],
    ['array', (source: Record<PropertyKey, unknown>) => {
      return Object.assign([], source) as unknown as Record<PropertyKey, unknown>;
    }],
  ])('rejects github-ref source boundary with %s', async (_label, mutate) => {
    const parsed = parseProjectTemplateGithubSourceSpec(
      'github:acme/template@main',
    );
    const source = mutate({ ...parsed });
    const fixture = createPort();
    await expectResolutionCode(
      resolveGithubTemplateSource({
        source: source as never,
        metadata: fixture.port,
      }),
      'INVALID_SOURCE_SPEC',
    );
    expect(fixture.calls).toEqual([]);
  });

  it('rejects release source extra/accessor keys and any canonical field drift', async () => {
    const parsed = parseProjectTemplateGithubSourceSpec(
      `https://github.com/acme/template/releases/download/v1.2.3/${ASSET_NAME}`,
    );
    const extra = { ...parsed, unexpected: true };
    const accessor = { ...parsed };
    Object.defineProperty(accessor, 'assetName', {
      enumerable: true,
      get: () => ASSET_NAME,
    });
    const drifted = { ...parsed, repositoryUrl: 'https://github.com/acme/other' };

    for (const source of [extra, accessor, drifted]) {
      const fixture = createPort();
      await expectResolutionCode(
        resolveGithubTemplateSource({
          source: source as never,
          metadata: fixture.port,
        }),
        'INVALID_SOURCE_SPEC',
      );
      expect(fixture.calls).toEqual([]);
    }
  });

  it('accepts parser-frozen specs and exact plain clones for both source kinds', async () => {
    const sources = [
      parseProjectTemplateGithubSourceSpec('github:acme/template@main'),
      parseProjectTemplateGithubSourceSpec(
        `https://github.com/acme/template/releases/download/v1.2.3/${ASSET_NAME}`,
      ),
    ];
    for (const source of sources) {
      for (const candidate of [source, { ...source }]) {
        await expect(resolveGithubTemplateSource({
          source: candidate,
          metadata: createPort().port,
        })).resolves.toMatchObject({
          owner: 'acme',
          repo: 'template',
        });
      }
    }
  });

  it('redacts a public resolution error thrown by a source Proxy trap', async () => {
    const parsed = parseProjectTemplateGithubSourceSpec(
      'github:acme/template@main',
    );
    const source = throwingProxy(
      parsed,
      () => new GithubTemplateSourceResolutionError(
        'CHECKSUM_MISMATCH',
        'raw stderr ghp_source_proxy_secret',
      ),
    );
    const promise = resolveGithubTemplateSource({
      source,
      metadata: createPort().port,
    });
    await expectResolutionCode(promise, 'INVALID_SOURCE_SPEC');
    await expectRedacted(promise, 'ghp_source_proxy_secret');
  });

  it('resolves immutable descriptor, release, assets, and checksum evidence', async () => {
    const { port, calls } = createPort();
    const source = parseProjectTemplateGithubSourceSpec(
      'github:acme/template@main',
    );

    const result = await resolveGithubTemplateSource({ source, metadata: port });

    expect(result).toMatchObject({
      kind: 'resolved-github-template-source',
      owner: 'acme',
      repo: 'template',
      requestedRef: 'main',
      releaseTag: 'v1.2.3',
      commit: COMMIT,
      releaseId: 101,
      assetId: 201,
      assetName: ASSET_NAME,
      assetSize: 1024,
      checksumAssetId: 202,
      checksumAssetName: CHECKSUM_NAME,
      checksumAssetSize: CHECKSUM_LINE.length,
      sha256: ARCHIVE_SHA,
      version: '1.2.3',
      updateState: 'update-available',
      hardBlocked: false,
      downloadAllowed: true,
    });
    expect(result.descriptorSha256).toBe(
      calculateProjectTemplateSourceDescriptorSha256(descriptor()),
    );
    expect(result.declaredDependencies).toEqual(
      (descriptor()['repertoireDependencies'] as unknown[]),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.declaredDependencies)).toBe(true);
    expect(Object.isFrozen(result.declaredDependencies[0])).toBe(true);

    expect(calls[0]).toEqual({
      method: 'resolveRefToCommit',
      input: { owner: 'acme', repo: 'template', ref: 'main' },
    });
    expect(calls[1]).toEqual({
      method: 'readFileAtCommit',
      input: {
        owner: 'acme',
        repo: 'template',
        commit: COMMIT,
        path: '.takt-template-source.json',
        maxBytes: 64 * 1024,
      },
    });
    expect(calls[1]!.input).not.toHaveProperty('ref');
  });

  it('requires direct release URL tag and asset to exactly match descriptor', async () => {
    const good = createPort();
    const source = parseProjectTemplateGithubSourceSpec(
      `https://github.com/acme/template/releases/download/v1.2.3/${ASSET_NAME}`,
    );
    await expect(resolveGithubTemplateSource({
      source,
      metadata: good.port,
    })).resolves.toMatchObject({
      requestedRef: 'v1.2.3',
      releaseTag: 'v1.2.3',
      assetName: ASSET_NAME,
    });

    const badSource = parseProjectTemplateGithubSourceSpec(
      'https://github.com/acme/template/releases/download/v1.2.2/other.taktpack',
    );
    await expectResolutionCode(
      resolveGithubTemplateSource({ source: badSource, metadata: createPort().port }),
      'DIRECT_RELEASE_MISMATCH',
    );
  });

  it('requires descriptor releaseTag to resolve to the requested commit', async () => {
    let call = 0;
    const { port } = createPort({
      async resolveRefToCommit() {
        call += 1;
        return { commit: call === 1 ? COMMIT : '1'.repeat(40) };
      },
    });
    await expectResolutionCode(
      resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(
          'github:acme/template@main',
        ),
        metadata: port,
      }),
      'TAG_COMMIT_MISMATCH',
    );
  });

  it.each([
    ['non-plain release', new Date()],
    ['unknown release key', { ...releaseMetadata(), unexpected: true }],
    ['unsafe release ID', { ...releaseMetadata(), id: Number.MAX_SAFE_INTEGER + 1 }],
    ['too many assets', releaseMetadata(Array.from(
      { length: 257 },
      (_, index) => ({ id: index + 1, name: `asset-${index}`, size: 1 }),
    ))],
    ['negative asset size', releaseMetadata([
      { id: 201, name: ASSET_NAME, size: -1 },
      { id: 202, name: CHECKSUM_NAME, size: CHECKSUM_LINE.length },
    ])],
    ['sparse assets', (() => {
      const assets = new Array(2);
      assets[1] = { id: 202, name: CHECKSUM_NAME, size: CHECKSUM_LINE.length };
      return releaseMetadata(assets);
    })()],
  ])('rejects strict metadata violation: %s', async (_label, payload) => {
    const { port } = createPort({
      async getReleaseByTag() {
        return payload;
      },
    });
    await expectResolutionCode(
      resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(
          'github:acme/template@main',
        ),
        metadata: port,
      }),
      'INVALID_RELEASE_METADATA',
    );
  });

  it.each([
    { commit: 'A'.repeat(40) },
    { commit: 'a'.repeat(39) },
    { commit: COMMIT, unexpected: true },
  ])('requires strict ref metadata: %j', async (payload) => {
    const { port } = createPort({
      async resolveRefToCommit() {
        return payload;
      },
    });
    await expectResolutionCode(
      resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(
          'github:acme/template@main',
        ),
        metadata: port,
      }),
      'INVALID_REF_METADATA',
    );
  });

  it.each([
    ['missing archive', [
      { id: 202, name: CHECKSUM_NAME, size: CHECKSUM_LINE.length },
    ], 'ASSET_NOT_FOUND'],
    ['duplicate archive', [
      { id: 201, name: ASSET_NAME, size: 1024 },
      { id: 203, name: ASSET_NAME, size: 1024 },
      { id: 202, name: CHECKSUM_NAME, size: CHECKSUM_LINE.length },
    ], 'ASSET_AMBIGUOUS'],
    ['duplicate checksum', [
      { id: 201, name: ASSET_NAME, size: 1024 },
      { id: 202, name: CHECKSUM_NAME, size: CHECKSUM_LINE.length },
      { id: 203, name: CHECKSUM_NAME, size: CHECKSUM_LINE.length },
    ], 'ASSET_AMBIGUOUS'],
  ])('rejects %s in one release', async (_label, assets, code) => {
    const { port } = createPort({
      async getReleaseByTag() {
        return releaseMetadata(assets as unknown[]);
      },
    });
    await expectResolutionCode(
      resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(
          'github:acme/template@main',
        ),
        metadata: port,
      }),
      code,
    );
  });

  it('rejects archive and checksum metadata beyond their limits', async () => {
    const oversizedArchive = createPort({
      async getReleaseByTag() {
        return releaseMetadata([
          {
            id: 201,
            name: ASSET_NAME,
            size: DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes + 1,
          },
          { id: 202, name: CHECKSUM_NAME, size: CHECKSUM_LINE.length },
        ]);
      },
    });
    await expectResolutionCode(
      resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(
          'github:acme/template@main',
        ),
        metadata: oversizedArchive.port,
      }),
      'ASSET_TOO_LARGE',
    );

    const oversizedChecksum = createPort({
      async getReleaseByTag() {
        return releaseMetadata([
          { id: 201, name: ASSET_NAME, size: 1024 },
          { id: 202, name: CHECKSUM_NAME, size: 4097 },
        ]);
      },
    });
    await expectResolutionCode(
      resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(
          'github:acme/template@main',
        ),
        metadata: oversizedChecksum.port,
      }),
      'ASSET_TOO_LARGE',
    );
  });

  it.each([
    [`${ARCHIVE_SHA} ${ASSET_NAME}\n`, 'INVALID_CHECKSUM'],
    [`${ARCHIVE_SHA.toUpperCase()}  ${ASSET_NAME}\n`, 'INVALID_CHECKSUM'],
    [`${ARCHIVE_SHA}  other.taktpack\n`, 'INVALID_CHECKSUM'],
    [`${ARCHIVE_SHA}  ${ASSET_NAME}`, 'INVALID_CHECKSUM'],
    [`${'b'.repeat(64)}  ${ASSET_NAME}\n`, 'CHECKSUM_MISMATCH'],
  ])('rejects non-canonical or mismatched checksum payload', async (line, code) => {
    const { port } = createPort({
      async getReleaseByTag() {
        return releaseMetadata([
          { id: 201, name: ASSET_NAME, size: 1024 },
          { id: 202, name: CHECKSUM_NAME, size: line.length },
        ]);
      },
      async readReleaseAsset() {
        return new TextEncoder().encode(line);
      },
    });
    await expectResolutionCode(
      resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(
          'github:acme/template@main',
        ),
        metadata: port,
      }),
      code,
    );
  });

  it.each([
    [undefined, 'update-available', false, true],
    [{
      ...CURRENT_IDENTITY,
      version: '1.2.3',
      sha256: ARCHIVE_SHA,
      commit: COMMIT,
      descriptorSha256: calculateProjectTemplateSourceDescriptorSha256(
        descriptor(),
      ),
    }, 'up-to-date', false, false],
    [{
      ...CURRENT_IDENTITY,
      version: '1.2.3+old',
      sha256: ARCHIVE_SHA,
      commit: COMMIT,
      descriptorSha256: calculateProjectTemplateSourceDescriptorSha256(
        descriptor(),
      ),
    }, 'version-republished', true, false],
    [{
      ...CURRENT_IDENTITY,
      version: '1.2.3',
      sha256: 'b'.repeat(64),
      commit: COMMIT,
      descriptorSha256: calculateProjectTemplateSourceDescriptorSha256(
        descriptor(),
      ),
    }, 'version-republished', true, false],
    [{
      ...CURRENT_IDENTITY,
      version: '2.0.0',
      sha256: ARCHIVE_SHA,
      commit: COMMIT,
      descriptorSha256: calculateProjectTemplateSourceDescriptorSha256(
        descriptor(),
      ),
    }, 'downgrade', true, false],
  ])(
    'classifies current evidence as %s => %s',
    async (current, state, hardBlocked, downloadAllowed) => {
      const { port } = createPort();
      await expect(resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(
          'github:acme/template@main',
        ),
        metadata: port,
        current,
      })).resolves.toMatchObject({
        updateState: state,
        hardBlocked,
        downloadAllowed,
      });
    },
  );

  it('classifies a newer candidate as update-available', async () => {
    const { port } = createPort();
    await expect(resolveGithubTemplateSource({
      source: parseProjectTemplateGithubSourceSpec(
        'github:acme/template@main',
      ),
      metadata: port,
      current: {
        ...CURRENT_IDENTITY,
        version: '1.1.9',
        sha256: 'b'.repeat(64),
        commit: '1'.repeat(40),
        descriptorSha256: 'c'.repeat(64),
      },
    })).resolves.toMatchObject({
      updateState: 'update-available',
      hardBlocked: false,
      downloadAllowed: true,
    });
  });

  it('classifies a different repository identity as source-changed', async () => {
    const { port } = createPort();
    await expect(resolveGithubTemplateSource({
      source: parseProjectTemplateGithubSourceSpec(
        'github:acme/template@main',
      ),
      metadata: port,
      current: {
        owner: 'acme',
        repo: 'fork',
        repositoryUrl: 'https://github.com/acme/fork',
        version: '1.2.3',
        sha256: ARCHIVE_SHA,
        commit: COMMIT,
        descriptorSha256: calculateProjectTemplateSourceDescriptorSha256(
          descriptor(),
        ),
      },
    })).resolves.toMatchObject({
      updateState: 'source-changed',
      hardBlocked: false,
      downloadAllowed: true,
    });
  });

  it('wraps metadata failures without exposing provider stderr or tokens', async () => {
    const { port } = createPort({
      async resolveRefToCommit() {
        throw new Error('stderr token=ghp_super_secret');
      },
    });
    const promise = resolveGithubTemplateSource({
      source: parseProjectTemplateGithubSourceSpec(
        'github:acme/template@main',
      ),
      metadata: port,
    });
    await expectResolutionCode(promise, 'METADATA_PORT_FAILURE');
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(GithubTemplateSourceResolutionError);
      expect(JSON.stringify(error)).not.toContain('ghp_super_secret');
      expect((error as Error).message).not.toContain('stderr');
    }
  });

  it.each([
    ['ref metadata', 'INVALID_REF_METADATA', {
      resolveRefToCommit: async () => throwingProxy({ commit: COMMIT }),
    }],
    ['descriptor payload', 'INVALID_DESCRIPTOR', {
      readFileAtCommit: async () => throwingProxy(
        new TextEncoder().encode(
          serializeProjectTemplateSourceDescriptor(descriptor()),
        ),
      ),
    }],
    ['release metadata', 'INVALID_RELEASE_METADATA', {
      getReleaseByTag: async () => throwingProxy(releaseMetadata()),
    }],
    ['checksum payload', 'INVALID_CHECKSUM', {
      readReleaseAsset: async () => throwingProxy(
        new TextEncoder().encode(CHECKSUM_LINE),
      ),
    }],
  ])(
    'redacts Proxy reflection failures from %s',
    async (_label, code, overrides) => {
      const { port } = createPort(
        overrides as Partial<GithubTemplateSourceMetadataPort>,
      );
      const promise = resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(
          'github:acme/template@main',
        ),
        metadata: port,
      });
      await expectResolutionCode(promise, code);
      try {
        await promise;
      } catch (error) {
        expect((error as Error).message).not.toContain('ghp_proxy_secret');
        expect(JSON.stringify(error)).not.toContain('ghp_proxy_secret');
      }
    },
  );

  it.each([
    ['ref metadata', 'INVALID_REF_METADATA', {
      resolveRefToCommit: async () => throwingResolutionErrorProxy(
        { commit: COMMIT },
      ),
    }],
    ['descriptor payload', 'INVALID_DESCRIPTOR', {
      readFileAtCommit: async () => throwingResolutionErrorProxy(
        new TextEncoder().encode(
          serializeProjectTemplateSourceDescriptor(descriptor()),
        ),
      ),
    }],
    ['release metadata', 'INVALID_RELEASE_METADATA', {
      getReleaseByTag: async () => throwingResolutionErrorProxy(
        releaseMetadata(),
      ),
    }],
    ['checksum payload', 'INVALID_CHECKSUM', {
      readReleaseAsset: async () => throwingResolutionErrorProxy(
        new TextEncoder().encode(CHECKSUM_LINE),
      ),
    }],
  ])(
    'does not trust public resolution error instances from %s',
    async (_label, code, overrides) => {
      const promise = resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(
          'github:acme/template@main',
        ),
        metadata: createPort(
          overrides as Partial<GithubTemplateSourceMetadataPort>,
        ).port,
      });
      await expectResolutionCode(promise, code);
      await expectRedacted(promise, 'ghp_forged_resolution_secret');
    },
  );
});

async function expectResolutionCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toEqual(
    expect.objectContaining({
      name: 'GithubTemplateSourceResolutionError',
      code,
    }),
  );
}

function throwingProxy<T extends object>(
  target: T,
  createError: () => Error = () => new Error('raw stderr ghp_proxy_secret'),
): T {
  const fail = (): never => {
    throw createError();
  };
  return new Proxy(target, {
    get(_target, property) {
      if (property === 'then') return undefined;
      return fail();
    },
    getPrototypeOf: fail,
    ownKeys: fail,
    getOwnPropertyDescriptor: fail,
  });
}

function throwingResolutionErrorProxy<T extends object>(target: T): T {
  return throwingProxy(
    target,
    () => new GithubTemplateSourceResolutionError(
      'CHECKSUM_MISMATCH',
      'raw stderr ghp_forged_resolution_secret',
    ),
  );
}

async function expectRedacted(
  promise: Promise<unknown>,
  secret: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  }
}
