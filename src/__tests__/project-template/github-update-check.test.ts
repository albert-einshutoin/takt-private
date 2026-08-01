import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TAKTPACK_LIMITS } from '../../features/project-template/archive-types.js';
import { parseProjectTemplateGithubSourceSpec } from '../../features/project-template/github-source-spec.js';
import {
  claimResolvedGithubTemplateSourceForDownload,
  consumeResolvedGithubTemplateSourceReceiptClaim,
  demoteResolvedGithubTemplateSourceToAdvisory,
  discardResolvedGithubTemplateSource,
  discardResolvedGithubTemplateSourceDownloadClaim,
  GithubTemplateSourceResolutionError,
  handoffResolvedGithubTemplateSourceDownloadClaimForReceipt,
  resolveGithubTemplateSource,
  type GithubTemplateSourceMetadataPort,
} from '../../features/project-template/github-update-check.js';
import {
  calculateProjectTemplateSourceDescriptorSha256,
  serializeProjectTemplateSourceDescriptor,
} from '../../features/project-template/source-descriptor.js';
import {
  calculateProjectTemplateRepertoireDependencyDeclarationSha256,
} from '../../features/project-template/repertoire-dependency-canonical.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ARCHIVE_SHA = 'a'.repeat(64);
const ASSET_NAME = 'template.taktpack';
const CHECKSUM_NAME = `${ASSET_NAME}.sha256`;
const CHECKSUM_LINE = `${ARCHIVE_SHA}  ${ASSET_NAME}\n`;
const CURRENT_IDENTITY = {
  owner: 'acme',
  repo: 'template',
  repositoryUrl: 'https://github.com/acme/template',
  canonicalSource: 'github:acme/template@main',
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
  it('demotes active authority into deeply frozen advisory evidence', async () => {
    const resolved = await resolveDownloadAuthorityFixture();

    const advisory = demoteResolvedGithubTemplateSourceToAdvisory(resolved);

    expect(advisory).toMatchObject({
      kind: 'github-template-source-advisory',
      source: {
        owner: 'acme',
        repo: 'template',
        commit: COMMIT,
      },
      release: {
        tag: 'v1.2.3',
        id: 101,
        asset: { id: 201, name: ASSET_NAME, size: 1024 },
        checksumAsset: {
          id: 202,
          name: CHECKSUM_NAME,
          size: CHECKSUM_LINE.length,
        },
        sha256: ARCHIVE_SHA,
        version: '1.2.3',
      },
      updateState: 'update-available',
      hardBlocked: false,
      downloadEligible: true,
    });
    expect(Reflect.ownKeys(advisory)).toEqual([
      'kind',
      'source',
      'release',
      'declaredDependencies',
      'updateState',
      'hardBlocked',
      'downloadEligible',
    ]);
    expect(Object.isFrozen(advisory)).toBe(true);
    expect(Object.isFrozen(advisory.source)).toBe(true);
    expect(Object.isFrozen(advisory.release)).toBe(true);
    expect(Object.isFrozen(advisory.release.asset)).toBe(true);
    expect(Object.isFrozen(advisory.release.checksumAsset)).toBe(true);
    expect(Object.isFrozen(advisory.declaredDependencies)).toBe(true);
    expect(Object.isFrozen(advisory.declaredDependencies[0])).toBe(true);
    expect(Object.isFrozen(
      advisory.declaredDependencies[0]!.capabilities,
    )).toBe(true);
    expect(Reflect.ownKeys(advisory)).not.toContain('metadata');
    expect(Reflect.ownKeys(advisory)).not.toContain('credential');
    expect(() => claimResolvedGithubTemplateSourceForDownload(advisory))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => consumeResolvedGithubTemplateSourceReceiptClaim(
      advisory as never,
    )).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => claimResolvedGithubTemplateSourceForDownload(resolved))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => demoteResolvedGithubTemplateSourceToAdvisory(resolved))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
  });

  it('discards unused active authority exactly once', async () => {
    const resolved = await resolveDownloadAuthorityFixture();

    expect(() => discardResolvedGithubTemplateSource(resolved)).not.toThrow();
    expect(() => discardResolvedGithubTemplateSource(resolved))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => claimResolvedGithubTemplateSourceForDownload(resolved))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => demoteResolvedGithubTemplateSourceToAdvisory(resolved))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
  });

  it('retires canonical authority with module-captured WeakMap intrinsics', async () => {
    const resolved = await resolveDownloadAuthorityFixture();
    const resolvedForClaim = await resolveDownloadAuthorityFixture();
    const getDescriptor = Object.getOwnPropertyDescriptor(
      WeakMap.prototype,
      'get',
    )!;
    const deleteDescriptor = Object.getOwnPropertyDescriptor(
      WeakMap.prototype,
      'delete',
    )!;
    const setDescriptor = Object.getOwnPropertyDescriptor(
      WeakMap.prototype,
      'set',
    )!;
    const applyDescriptor = Object.getOwnPropertyDescriptor(
      Reflect,
      'apply',
    )!;
    let traps = 0;
    const poison = () => {
      traps += 1;
      claimResolvedGithubTemplateSourceForDownload(resolved);
      throw new Error('MUTABLE_INTRINSIC_EXECUTED');
    };
    Object.defineProperty(WeakMap.prototype, 'get', {
      ...getDescriptor,
      value: poison,
    });
    Object.defineProperty(WeakMap.prototype, 'delete', {
      ...deleteDescriptor,
      value: poison,
    });
    Object.defineProperty(WeakMap.prototype, 'set', {
      ...setDescriptor,
      value: poison,
    });
    Object.defineProperty(Reflect, 'apply', {
      ...applyDescriptor,
      value: poison,
    });

    let discardError: unknown;
    let claimLifecycleError: unknown;
    let claimError: unknown;
    let invalidError: unknown;
    try {
      try {
        discardResolvedGithubTemplateSource(resolved);
      } catch (error) {
        discardError = error;
      }
      try {
        claimResolvedGithubTemplateSourceForDownload(resolved);
      } catch (error) {
        claimError = error;
      }
      try {
        discardResolvedGithubTemplateSource({});
      } catch (error) {
        invalidError = error;
      }
      try {
        const claim =
          claimResolvedGithubTemplateSourceForDownload(resolvedForClaim);
        discardResolvedGithubTemplateSourceDownloadClaim(claim);
      } catch (error) {
        claimLifecycleError = error;
      }
    } finally {
      Object.defineProperty(WeakMap.prototype, 'get', getDescriptor);
      Object.defineProperty(WeakMap.prototype, 'delete', deleteDescriptor);
      Object.defineProperty(WeakMap.prototype, 'set', setDescriptor);
      Object.defineProperty(Reflect, 'apply', applyDescriptor);
    }
    expect(discardError).toBeUndefined();
    expect(claimError).toMatchObject({
      code: 'INVALID_AUTHORITY',
      message: 'resolved GitHub template source authority is invalid',
    });
    expect(invalidError).toMatchObject({
      code: 'INVALID_AUTHORITY',
      message: 'resolved GitHub template source authority is invalid',
    });
    expect(claimLifecycleError).toBeUndefined();
    expect(traps).toBe(0);
  });

  it('rejects synchronous reentry while advisory evidence is copied', async () => {
    const resolved = await resolveDownloadAuthorityFixture();
    const mapDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'map',
    )!;
    let reentryError: unknown;
    let reentryClaim: unknown;
    Object.defineProperty(Array.prototype, 'map', {
      ...mapDescriptor,
      value: function (this: unknown, ...args: unknown[]): unknown {
        if (this === resolved.declaredDependencies) {
          try {
            reentryClaim =
              claimResolvedGithubTemplateSourceForDownload(resolved);
          } catch (error) {
            reentryError = error;
          }
        }
        return Reflect.apply(
          mapDescriptor.value as (...values: unknown[]) => unknown,
          this,
          args,
        );
      },
    });

    try {
      expect(demoteResolvedGithubTemplateSourceToAdvisory(resolved))
        .toMatchObject({ kind: 'github-template-source-advisory' });
    } finally {
      Object.defineProperty(Array.prototype, 'map', mapDescriptor);
    }
    expect(reentryClaim).toBeUndefined();
    expect(reentryError).toMatchObject({ code: 'INVALID_AUTHORITY' });
  });

  it('restores active authority when advisory evidence copying fails', async () => {
    const resolved = await resolveDownloadAuthorityFixture();
    const mapDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'map',
    )!;
    Object.defineProperty(Array.prototype, 'map', {
      ...mapDescriptor,
      value: function (this: unknown, ...args: unknown[]): unknown {
        if (this === resolved.declaredDependencies) {
          throw new Error('COPY_FAILED');
        }
        return Reflect.apply(
          mapDescriptor.value as (...values: unknown[]) => unknown,
          this,
          args,
        );
      },
    });

    try {
      expect(() => demoteResolvedGithubTemplateSourceToAdvisory(resolved))
        .toThrow('COPY_FAILED');
    } finally {
      Object.defineProperty(Array.prototype, 'map', mapDescriptor);
    }

    const claim = claimResolvedGithubTemplateSourceForDownload(resolved);
    expect(claim.resolved).toBe(resolved);
    discardResolvedGithubTemplateSourceDownloadClaim(claim);
  });

  it.each(['demote', 'discard'] as const)(
    'rejects cloned, forged, and proxied authority during %s without consuming the canonical result',
    async (operation) => {
      const resolved = await resolveDownloadAuthorityFixture();
      const trap = vi.fn(() => {
        throw new Error('SECRET_SENTINEL');
      });
      const candidates = [
        Object.freeze({ ...resolved }),
        JSON.parse(JSON.stringify(resolved)),
        Object.freeze({ kind: 'resolved-github-template-source' }),
        new Proxy(resolved, {
          get: trap,
          getOwnPropertyDescriptor: trap,
          getPrototypeOf: trap,
          ownKeys: trap,
        }),
      ];

      for (const candidate of candidates) {
        const invoke = () => operation === 'demote'
          ? demoteResolvedGithubTemplateSourceToAdvisory(candidate)
          : discardResolvedGithubTemplateSource(candidate);
        expect(invoke).toThrow(expect.objectContaining({
          code: 'INVALID_AUTHORITY',
        }));
      }
      expect(trap).not.toHaveBeenCalled();

      const claim = claimResolvedGithubTemplateSourceForDownload(resolved);
      expect(claim.resolved).toBe(resolved);
      discardResolvedGithubTemplateSourceDownloadClaim(claim);
    },
  );

  it.each(['demote-first', 'claim-first'] as const)(
    'permits one synchronous authority winner when operations race: %s',
    async (order) => {
      const resolved = await resolveDownloadAuthorityFixture();
      const demote = async () =>
        demoteResolvedGithubTemplateSourceToAdvisory(resolved);
      const claim = async () =>
        claimResolvedGithubTemplateSourceForDownload(resolved);
      const results = await Promise.allSettled(
        order === 'demote-first'
          ? [demote(), claim()]
          : [claim(), demote()],
      );

      expect(results.filter((result) => result.status === 'fulfilled'))
        .toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected'))
        .toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({
        reason: { code: 'INVALID_AUTHORITY' },
      });
      const fulfilled = results.find(
        (result) => result.status === 'fulfilled',
      );
      if (
        fulfilled?.status === 'fulfilled'
        && 'resolved' in fulfilled.value
      ) {
        discardResolvedGithubTemplateSourceDownloadClaim(fulfilled.value);
      }
    },
  );

  it('rejects forged, cloned, and proxied resolved provenance for download', async () => {
    const resolved = await resolveDownloadAuthorityFixture();
    const candidates = [
      Object.freeze({ ...resolved }),
      JSON.parse(JSON.stringify(resolved)) as typeof resolved,
      new Proxy(resolved, {}),
    ];

    for (const candidate of candidates) {
      expect(() => claimResolvedGithubTemplateSourceForDownload(candidate))
        .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    }

    const claim = claimResolvedGithubTemplateSourceForDownload(resolved);
    expect(claim.resolved).toBe(resolved);
    discardResolvedGithubTemplateSourceDownloadClaim(claim);
  });

  it('permits only one concurrent download owner and one discard', async () => {
    const resolved = await resolveDownloadAuthorityFixture();
    const claim = claimResolvedGithubTemplateSourceForDownload(resolved);

    expect(() => claimResolvedGithubTemplateSourceForDownload(resolved))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => discardResolvedGithubTemplateSourceDownloadClaim({
      ...claim,
    })).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => discardResolvedGithubTemplateSourceDownloadClaim(
      new Proxy(claim, {}),
    )).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));

    discardResolvedGithubTemplateSourceDownloadClaim(claim);
    expect(() => discardResolvedGithubTemplateSourceDownloadClaim(claim))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => claimResolvedGithubTemplateSourceForDownload(resolved))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
  });

  it('hands the sole download owner to a single receipt consumer', async () => {
    const resolved = await resolveDownloadAuthorityFixture();
    const downloadClaim =
      claimResolvedGithubTemplateSourceForDownload(resolved);
    const receiptClaim =
      handoffResolvedGithubTemplateSourceDownloadClaimForReceipt(
        downloadClaim,
      );

    expect(receiptClaim.resolved).toBe(resolved);
    expect(() => handoffResolvedGithubTemplateSourceDownloadClaimForReceipt(
      downloadClaim,
    )).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => discardResolvedGithubTemplateSourceDownloadClaim(
      downloadClaim,
    )).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    consumeResolvedGithubTemplateSourceReceiptClaim(receiptClaim);
    expect(() => consumeResolvedGithubTemplateSourceReceiptClaim(receiptClaim))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
  });

  it('rejects invalid receipt claims without inspecting or consuming the real claim', async () => {
    const resolved = await resolveDownloadAuthorityFixture();
    const receiptClaim =
      handoffResolvedGithubTemplateSourceDownloadClaimForReceipt(
        claimResolvedGithubTemplateSourceForDownload(resolved),
      );
    const trap = vi.fn(() => {
      throw new Error('SECRET_SENTINEL');
    });
    const proxy = new Proxy(receiptClaim, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    });
    const candidates = [
      {
        resolved: receiptClaim.resolved,
        descriptor: receiptClaim.descriptor,
      },
      { ...receiptClaim },
      JSON.parse(JSON.stringify(receiptClaim)),
      proxy,
    ];

    for (const candidate of candidates) {
      expect(() => consumeResolvedGithubTemplateSourceReceiptClaim(
        candidate as typeof receiptClaim,
      )).toThrow(expect.objectContaining({
        code: 'INVALID_AUTHORITY',
        field: 'resolved',
        message: 'resolved GitHub template source claim is invalid',
      }));
    }
    expect(trap).not.toHaveBeenCalled();

    expect(() => consumeResolvedGithubTemplateSourceReceiptClaim(receiptClaim))
      .not.toThrow();
    expect(() => consumeResolvedGithubTemplateSourceReceiptClaim(receiptClaim))
      .toThrow(expect.objectContaining({
        code: 'INVALID_AUTHORITY',
        field: 'resolved',
        message: 'resolved GitHub template source claim is invalid',
      }));
  });

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
      canonicalSource: 'github:acme/template@main',
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
      downloadEligible: true,
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
    async (current, state, hardBlocked, downloadEligible) => {
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
        downloadEligible,
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
      downloadEligible: true,
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
        canonicalSource: 'github:acme/fork@main',
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
      downloadEligible: true,
    });
  });

  it.each([
    [
      'branch',
      'github:acme/template@main',
      'github:acme/template@stable',
    ],
    [
      'ref',
      'github:acme/template@release/v1.2.3',
      'github:acme/template@main',
    ],
    [
      'source kind',
      `https://github.com/acme/template/releases/download/v1.2.3/${ASSET_NAME}`,
      'github:acme/template@v1.2.3',
    ],
    [
      'release asset',
      `https://github.com/acme/template/releases/download/v1.2.3/${ASSET_NAME}`,
      'https://github.com/acme/template/releases/download/v1.2.3/other.taktpack',
    ],
  ])(
    'classifies a same-repository %s change as source-changed',
    async (_label, candidateSource, currentCanonicalSource) => {
      await expect(resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(candidateSource),
        metadata: createPort().port,
        current: {
          ...CURRENT_IDENTITY,
          canonicalSource: currentCanonicalSource,
          version: '1.2.3',
          sha256: ARCHIVE_SHA,
          commit: COMMIT,
          descriptorSha256: calculateProjectTemplateSourceDescriptorSha256(
            descriptor(),
          ),
        },
      })).resolves.toMatchObject({
        canonicalSource: candidateSource,
        updateState: 'source-changed',
        hardBlocked: false,
        downloadEligible: true,
      });
    },
  );

  it.each([
    ['malformed', 'not-a-source'],
    ['non-canonical', 'github:Acme/Template@main'],
    ['repository mismatch', 'github:acme/other@main'],
  ])(
    'rejects %s current canonical source evidence',
    async (_label, canonicalSource) => {
      const promise = resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(
          'github:acme/template@main',
        ),
        metadata: createPort().port,
        current: {
          ...CURRENT_IDENTITY,
          canonicalSource,
          version: '1.2.3',
          sha256: ARCHIVE_SHA,
          commit: COMMIT,
          descriptorSha256: calculateProjectTemplateSourceDescriptorSha256(
            descriptor(),
          ),
        },
      });
      await expectResolutionCode(promise, 'INVALID_CURRENT_EVIDENCE');
    },
  );

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

  it('normalizes a reinjected immutable internal error to its new stage', async () => {
    let captured: GithubTemplateSourceResolutionError | undefined;
    const invalidSource = {
      ...parseProjectTemplateGithubSourceSpec(
        'github:acme/template@main',
      ),
      unexpected: true,
    };
    try {
      await resolveGithubTemplateSource({
        source: invalidSource as never,
        metadata: createPort().port,
      });
    } catch (error) {
      captured = error as GithubTemplateSourceResolutionError;
    }
    expect(captured).toBeInstanceOf(GithubTemplateSourceResolutionError);
    expect(() => Object.assign(captured!, {
      code: 'CHECKSUM_MISMATCH',
      message: 'raw stderr ghp_mutated_internal_secret',
      field: 'mutated',
    })).toThrow(TypeError);
    expect(Object.isFrozen(captured)).toBe(true);

    const promise = resolveGithubTemplateSource({
      source: parseProjectTemplateGithubSourceSpec(
        'github:acme/template@main',
      ),
      metadata: createPort({
        async resolveRefToCommit() {
          return throwingProxy({ commit: COMMIT }, () => captured!);
        },
      }).port,
    });
    await expectResolutionCode(promise, 'INVALID_REF_METADATA');
    await expectRedacted(promise, 'ghp_mutated_internal_secret');
  });

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

async function resolveDownloadAuthorityFixture() {
  return resolveGithubTemplateSource({
    source: parseProjectTemplateGithubSourceSpec(
      'github:acme/template@main',
    ),
    metadata: createPort().port,
    async verifyDependencies(dependencies) {
      return Object.freeze({
        method: 'github-ref-to-commit-v1' as const,
        declarationSha256:
          calculateProjectTemplateRepertoireDependencyDeclarationSha256(
            dependencies,
          ),
        count: dependencies.length,
      });
    },
  });
}

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
