import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireProjectTemplateMutationLease,
} from '../../features/project-template/apply-lease.js';
import * as applyLease from '../../features/project-template/apply-lease.js';
import {
  downloadGithubTemplateSource,
  type GithubTemplateArchiveAssetPort,
} from '../../features/project-template/github-download-orchestrator.js';
import * as githubDownloadStorage from '../../features/project-template/github-download-storage.js';
import * as githubUpdateCheck from '../../features/project-template/github-update-check.js';
import {
  createProjectTemplateExportPlan,
  parseProjectTemplateGithubSourceSpec,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  demoteResolvedGithubTemplateSourceToAdvisory,
  discardResolvedGithubTemplateSource,
  resolveGithubTemplateSource,
  resolveGithubTemplateSourceForAuthenticatedDownload,
  type GithubTemplateSourceAdvisory,
  type GithubTemplateSourceMetadataPort,
  type ResolvedGithubTemplateSource,
} from '../../features/project-template/github-update-check.js';
import type {
  GithubTemplateSourceResolutionInput,
  GithubTemplateSourceResolverPort,
} from '../../features/project-template/github-source-resolver-port.js';
import {
  serializeProjectTemplateSourceDescriptor,
  type ProjectTemplateSourceDescriptorV1,
} from '../../features/project-template/source-descriptor.js';
import {
  calculateProjectTemplateRepertoireDependencyDeclarationSha256,
} from '../../features/project-template/repertoire-dependency-canonical.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OTHER_COMMIT = '1123456789abcdef0123456789abcdef01234567';
const ASSET_NAME = 'template.taktpack';
const CHECKSUM_NAME = `${ASSET_NAME}.sha256`;
const SECRET = 'orchestrator-test-secret';
const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function makeFixture() {
  const projectRoot = makeRoot('takt-github-orchestrator-');
  const sourcePath = join(projectRoot, '.takt', 'workflows', 'review.yaml');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, 'name: review\n');
  const plan = await createProjectTemplateExportPlan(projectRoot, {
    packVersion: '1.2.3',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'github',
      uri: 'https://github.com/acme/template',
      ref: 'v1.2.3',
      commit: COMMIT,
    },
  });
  const packPath = join(projectRoot, 'source.taktpack');
  await writeTaktpack(packPath, plan);
  const content = readFileSync(packPath);
  const archiveSha = createHash('sha256').update(content).digest('hex');
  const descriptor: ProjectTemplateSourceDescriptorV1 = {
    schemaVersion: '1.0',
    pack: {
      version: '1.2.3',
      releaseTag: 'v1.2.3',
      assetName: ASSET_NAME,
      checksumAssetName: CHECKSUM_NAME,
      sha256: archiveSha,
    },
    repertoireDependencies: [{
      scope: '@acme/dependency',
      version: '2.0.0',
      source: 'github:acme/dependency@v2.0.0',
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
      capabilities: ['edit'],
    }],
  };
  const checksum = `${archiveSha}  ${ASSET_NAME}\n`;
  const calls: string[] = [];
  let commit = COMMIT;
  let dependencyCommit = descriptor.repertoireDependencies[0]!.commit;
  const metadata: GithubTemplateSourceMetadataPort = {
    async resolveRefToCommit(input) {
      calls.push('resolve-ref');
      return {
        commit: input.owner === 'acme' && input.repo === 'dependency'
          ? dependencyCommit
          : commit,
      };
    },
    async readFileAtCommit() {
      calls.push('read-descriptor');
      return new TextEncoder().encode(
        serializeProjectTemplateSourceDescriptor(descriptor),
      );
    },
    async getReleaseByTag() {
      calls.push('get-release');
      return {
        id: 101,
        tagName: 'v1.2.3',
        assets: [
          { id: 201, name: ASSET_NAME, size: content.byteLength },
          { id: 202, name: CHECKSUM_NAME, size: checksum.length },
        ],
      };
    },
    async readReleaseAsset() {
      calls.push('read-checksum');
      return new TextEncoder().encode(checksum);
    },
  };
  const source = parseProjectTemplateGithubSourceSpec(
    'github:acme/template@main',
  );
  const advisory = demoteResolvedGithubTemplateSourceToAdvisory(
    await resolveGithubTemplateSource({ source, metadata }),
  );
  calls.length = 0;
  const resolverInputs: GithubTemplateSourceResolutionInput[] = [];
  const resolverMethods: string[] = [];
  const resolver: GithubTemplateSourceResolverPort = {
    async resolveAdvisory(input) {
      resolverMethods.push('resolveAdvisory');
      resolverInputs.push(input);
      return demoteResolvedGithubTemplateSourceToAdvisory(
        await resolveGithubTemplateSource({
          source: parseProjectTemplateGithubSourceSpec(input.source),
          metadata,
          ...(input.current === undefined ? {} : { current: input.current }),
        }),
      );
    },
    async resolveForDownload(input) {
      resolverMethods.push('resolveForDownload');
      resolverInputs.push(input);
      return resolveGithubTemplateSourceForAuthenticatedDownload({
        source: parseProjectTemplateGithubSourceSpec(input.source),
        metadata,
        ...(input.current === undefined ? {} : { current: input.current }),
      });
    },
  };
  const assetCalls: unknown[] = [];
  const asset: GithubTemplateArchiveAssetPort = {
    openReleaseAsset(input) {
      assetCalls.push(input);
      return (async function* () {
        yield content;
      })();
    },
  };
  const requestedCacheRoot = makeRoot('takt-github-orchestrator-cache-');
  chmodSync(requestedCacheRoot, 0o700);
  const cacheRoot = realpathSync.native(requestedCacheRoot);
  const authenticator = {
    async acquireSigningKey() {
      return {
        keyId: 'orchestrator-key-1',
        async sign(input: Uint8Array) {
          return createHmac('sha256', SECRET).update(input).digest('hex');
        },
      };
    },
  };
  const verifier = {
    async verify(request: {
      readonly input: Uint8Array;
      readonly tag: string;
    }) {
      return createHmac('sha256', SECRET).update(request.input).digest('hex')
          === request.tag
        ? 'valid' as const
        : 'invalid' as const;
    },
  };
  return {
    advisory,
    asset,
    assetCalls,
    authenticator,
    cacheRoot,
    calls,
    content,
    metadata,
    projectRoot,
    resolver,
    resolverInputs,
    resolverMethods,
    setCommit(value: string) {
      commit = value;
    },
    setDependencyCommit(value: string) {
      dependencyCommit = value;
    },
    source: 'github:acme/template@main',
    verifier,
  };
}

function stagingEntries(projectRoot: string): string[] {
  const root = join(
    projectRoot,
    '.takt-template-state',
    'download-staging',
  );
  return existsSync(root) ? readdirSync(root) : [];
}

describe('GitHub template download orchestrator O1', () => {
  it('passes one exact frozen input through the high-level resolver port', async () => {
    const fixture = await makeFixture();
    const controller = new AbortController();
    const inputs: GithubTemplateSourceResolutionInput[] = [];
    const resolver: GithubTemplateSourceResolverPort = {
      async resolveAdvisory() {
        throw new Error('unused');
      },
      async resolveForDownload(input) {
        inputs.push(input);
        return resolveGithubTemplateSourceForAuthenticatedDownload({
          source: parseProjectTemplateGithubSourceSpec(input.source),
          metadata: fixture.metadata,
          ...(input.current === undefined ? {} : { current: input.current }),
        });
      },
    };

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
      signal: controller.signal,
    })).resolves.toMatchObject({ status: 'downloaded' });

    expect(inputs).toHaveLength(1);
    expect(Reflect.ownKeys(inputs[0]!)).toEqual(['source', 'signal']);
    expect(Object.isFrozen(inputs[0])).toBe(true);
    expect(Object.getPrototypeOf(inputs[0])).toBe(Object.prototype);
    expect(inputs[0]!.source).toBe(fixture.source);
    expect(inputs[0]!.signal).toBe(controller.signal);
  });

  it.each([
    [false, 'SOURCE_RESOLUTION_FAILED'],
    [true, 'ABORTED'],
  ] as const)(
    'redacts resolver failure and maps cancellation=%s to %s',
    async (abort, code) => {
      const fixture = await makeFixture();
      const controller = new AbortController();
      const resolver: GithubTemplateSourceResolverPort = {
        resolveAdvisory: fixture.resolver.resolveAdvisory,
        async resolveForDownload() {
          if (abort) controller.abort();
          throw new Error('ghp_resolver_secret');
        },
      };

      const error = await downloadGithubTemplateSource({
        projectRoot: fixture.projectRoot,
        source: fixture.source,
        advisory: fixture.advisory,
        resolver,
        asset: fixture.asset,
        cacheRoot: fixture.cacheRoot,
        authenticator: fixture.authenticator,
        verifier: fixture.verifier,
        signal: controller.signal,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain('ghp_resolver_secret');
      expect(fixture.assetCalls).toEqual([]);
      expect(readdirSync(fixture.cacheRoot)).toEqual([]);
    },
  );

  it.each(['clone', 'proxy'] as const)(
    'rejects a forged fresh resolver %s result before asset or cache work',
    async (attack) => {
      const fixture = await makeFixture();
      let traps = 0;
      const materialize = vi.spyOn(
        githubDownloadStorage,
        'materializeGithubTemplateCache',
      );
      const resolver: GithubTemplateSourceResolverPort = {
        resolveAdvisory: fixture.resolver.resolveAdvisory,
        async resolveForDownload(input) {
          const real = await fixture.resolver.resolveForDownload(input);
          const forged = attack === 'clone'
            ? Object.freeze({ ...real })
            : new Proxy(real, {
              get(target, property, receiver) {
                // Promise resolution must inspect `then`; count any later
                // property access by the orchestrator as a boundary failure.
                if (property === 'then') return undefined;
                traps += 1;
                return Reflect.get(target, property, receiver);
              },
              getPrototypeOf() {
                traps += 1;
                throw new Error('ghp_proxy_secret');
              },
              ownKeys() {
                traps += 1;
                throw new Error('ghp_proxy_secret');
              },
            });
          discardResolvedGithubTemplateSource(real);
          return forged as ResolvedGithubTemplateSource;
        },
      };

      await expect(downloadGithubTemplateSource({
        projectRoot: fixture.projectRoot,
        source: fixture.source,
        advisory: fixture.advisory,
        resolver,
        asset: fixture.asset,
        cacheRoot: fixture.cacheRoot,
        authenticator: fixture.authenticator,
        verifier: fixture.verifier,
      })).rejects.toMatchObject({ code: 'SOURCE_RESOLUTION_FAILED' });

      expect(fixture.assetCalls).toEqual([]);
      expect(materialize).not.toHaveBeenCalled();
      expect(readdirSync(fixture.cacheRoot)).toEqual([]);
      expect(traps).toBe(0);
    },
  );

  it.each([
    'open',
    'stream',
    'hash',
    'size',
    'cache',
    'sign',
  ] as const)(
    'consumes fresh download authority after %s failure',
    async (boundary) => {
      const fixture = await makeFixture();
      const originalClaim =
        githubUpdateCheck.claimResolvedGithubTemplateSourceForDownload;
      let captured:
        ReturnType<typeof originalClaim> | undefined;
      vi.spyOn(
        githubUpdateCheck,
        'claimResolvedGithubTemplateSourceForDownload',
      ).mockImplementation((value) => {
        captured = originalClaim(value);
        return captured;
      });
      let asset = fixture.asset;
      let authenticator = fixture.authenticator;
      if (boundary === 'open') {
        asset = {
          openReleaseAsset() {
            throw new Error('SECRET_SENTINEL');
          },
        };
      } else if (boundary === 'stream') {
        asset = {
          openReleaseAsset() {
            return (async function* () {
              throw new Error('SECRET_SENTINEL');
            })();
          },
        };
      } else if (boundary === 'hash') {
        asset = {
          openReleaseAsset() {
            const corrupt = fixture.content.slice();
            corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
            return (async function* () {
              yield corrupt;
            })();
          },
        };
      } else if (boundary === 'size') {
        asset = {
          openReleaseAsset() {
            return (async function* () {
              yield fixture.content.subarray(1);
            })();
          },
        };
      } else if (boundary === 'cache') {
        vi.spyOn(
          githubDownloadStorage,
          'materializeGithubTemplateCache',
        ).mockRejectedValue(new Error('SECRET_SENTINEL'));
      } else {
        authenticator = {
          async acquireSigningKey() {
            throw new Error('SECRET_SENTINEL');
          },
        };
      }

      const error = await downloadGithubTemplateSource({
        projectRoot: fixture.projectRoot,
        source: fixture.source,
        advisory: fixture.advisory,
        resolver: fixture.resolver,
        asset,
        cacheRoot: fixture.cacheRoot,
        authenticator,
        verifier: fixture.verifier,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('SECRET_SENTINEL');
      expect(captured).toBeDefined();
      expect(() =>
        githubUpdateCheck
          .handoffResolvedGithubTemplateSourceDownloadClaimForReceipt(
            captured!,
          )
      ).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
      vi.restoreAllMocks();
    },
  );

  it('re-resolves under the download lease, stages, and consumes staging privately', async () => {
    const fixture = await makeFixture();
    const originalClaim =
      githubUpdateCheck.claimResolvedGithubTemplateSourceForDownload;
    const claimed: unknown[] = [];
    let claimEstablished = false;
    vi.spyOn(
      githubUpdateCheck,
      'claimResolvedGithubTemplateSourceForDownload',
    ).mockImplementation((value) => {
      claimed.push(value);
      claimEstablished = true;
      return originalClaim(value);
    });
    const asset: GithubTemplateArchiveAssetPort = {
      openReleaseAsset(input) {
        expect(claimEstablished).toBe(true);
        return Reflect.apply(
          fixture.asset.openReleaseAsset,
          fixture.asset,
          [input],
        );
      },
    };

    const result = await downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    });

    expect(result).toMatchObject({
      status: 'downloaded',
      commit: COMMIT,
      sha256: createHash('sha256').update(fixture.content).digest('hex'),
      artifactState: 'cache-published',
      receiptState: 'receipt-published',
      bytes: fixture.content.byteLength,
      directoryDurability: process.platform === 'win32'
        ? 'unsupported'
        : 'synced',
    });
    expect(result).not.toHaveProperty('staged');
    expect(result).not.toHaveProperty('stagingPath');
    expect(result).not.toHaveProperty('resolved');
    expect(result).not.toHaveProperty('materialized');
    expect(result).not.toHaveProperty('prepared');
    expect(result).not.toHaveProperty('stored');
    expect(Object.isFrozen(result)).toBe(true);
    expect(fixture.calls).toEqual([
      'resolve-ref',
      'read-descriptor',
      'resolve-ref',
      'resolve-ref',
      'get-release',
      'read-checksum',
    ]);
    expect(fixture.assetCalls).toEqual([
      {
        owner: 'acme',
        repo: 'template',
        releaseId: 101,
        assetId: 201,
        maxBytes: fixture.content.byteLength,
      },
    ]);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).not.toBe(fixture.advisory);
    expect(fixture.resolverMethods).toEqual(['resolveForDownload']);
    expect(stagingEntries(fixture.projectRoot)).toEqual([]);
    const lease = acquireProjectTemplateMutationLease(
      fixture.projectRoot,
      'download',
    );
    lease.release();
  });

  it('stops dependency republish before release, authority, archive, cache, or signing', async () => {
    const fixture = await makeFixture();
    fixture.setDependencyCommit('ffffffffffffffffffffffffffffffffffffffff');
    const claim = vi.spyOn(
      githubUpdateCheck,
      'claimResolvedGithubTemplateSourceForDownload',
    );
    const materialize = vi.spyOn(
      githubDownloadStorage,
      'materializeGithubTemplateCache',
    );
    const acquireSigningKey = vi.spyOn(
      fixture.authenticator,
      'acquireSigningKey',
    );

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    })).rejects.toMatchObject({ code: 'SOURCE_RESOLUTION_FAILED' });

    expect(fixture.calls).toEqual([
      'resolve-ref',
      'read-descriptor',
      'resolve-ref',
      'resolve-ref',
    ]);
    expect(claim).not.toHaveBeenCalled();
    expect(fixture.assetCalls).toEqual([]);
    expect(materialize).not.toHaveBeenCalled();
    expect(acquireSigningKey).not.toHaveBeenCalled();
  });

  it('reports SOURCE_DRIFT when fresh dependency evidence no longer binds the advisory declaration', async () => {
    const fixture = await makeFixture();
    const original = fixture.resolver.resolveForDownload;
    const resolver: GithubTemplateSourceResolverPort = {
      resolveAdvisory: fixture.resolver.resolveAdvisory,
      async resolveForDownload(input) {
        const fresh = await Reflect.apply(
          original,
          fixture.resolver,
          [input],
        );
        return Object.freeze({
          ...fresh,
          declaredDependencies: Object.freeze([]),
          dependencyVerification: Object.freeze({
            method: 'github-ref-to-commit-v1' as const,
            declarationSha256:
              calculateProjectTemplateRepertoireDependencyDeclarationSha256(
                [],
              ),
            count: 0,
          }),
        });
      },
    };

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    })).rejects.toMatchObject({ code: 'SOURCE_DRIFT' });
    expect(fixture.assetCalls).toEqual([]);
  });

  it('rejects advisory ineligibility before guard, lease, metadata, or asset work', async () => {
    const fixture = await makeFixture();
    const current = {
      owner: fixture.advisory.source.owner,
      repo: fixture.advisory.source.repo,
      repositoryUrl: fixture.advisory.source.repositoryUrl,
      canonicalSource: fixture.advisory.source.canonicalSource,
      version: fixture.advisory.release.version,
      sha256: fixture.advisory.release.sha256,
      commit: fixture.advisory.source.commit,
      descriptorSha256: fixture.advisory.source.descriptorSha256,
    };
    const ineligible = demoteResolvedGithubTemplateSourceToAdvisory(
      await resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(fixture.source),
        metadata: fixture.metadata,
        current,
      }),
    );
    fixture.calls.length = 0;

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: ineligible,
      resolver: fixture.resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
      current,
    })).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_ELIGIBLE' });
    expect(fixture.calls).toEqual([]);
    expect(fixture.resolverInputs).toEqual([]);
    expect(fixture.assetCalls).toEqual([]);
  });

  it('fails the initial guard before remote side effects', async () => {
    const fixture = await makeFixture();
    const blocker = acquireProjectTemplateMutationLease(
      fixture.projectRoot,
      'apply',
    );
    try {
      await expect(downloadGithubTemplateSource({
        projectRoot: fixture.projectRoot,
        source: fixture.source,
        advisory: fixture.advisory,
        resolver: fixture.resolver,
        asset: fixture.asset,
        cacheRoot: fixture.cacheRoot,
        authenticator: fixture.authenticator,
        verifier: fixture.verifier,
      })).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
    } finally {
      blocker.release();
    }
    expect(fixture.calls).toEqual([]);
    expect(fixture.resolverInputs).toEqual([]);
    expect(fixture.assetCalls).toEqual([]);
  });

  it('fails lease acquisition before invoking the resolver', async () => {
    const fixture = await makeFixture();
    vi.spyOn(
      applyLease,
      'acquireProjectTemplateMutationLease',
    ).mockImplementation(() => {
      throw new Error('coordination unavailable');
    });

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    })).rejects.toMatchObject({ code: 'COORDINATION_FAILED' });
    expect(fixture.resolverInputs).toEqual([]);
    expect(fixture.assetCalls).toEqual([]);
  });

  it('rejects any fresh resolved authority field drift before asset access', async () => {
    const fixture = await makeFixture();
    fixture.setCommit(OTHER_COMMIT);
    let fresh: ResolvedGithubTemplateSource | undefined;
    const resolver: GithubTemplateSourceResolverPort = {
      resolveAdvisory: fixture.resolver.resolveAdvisory,
      async resolveForDownload(input) {
        fresh = await fixture.resolver.resolveForDownload(input);
        return fresh;
      },
    };

    const error = await downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'SOURCE_DRIFT',
      message: 'GitHub template source changed before download',
      cleanupState: undefined,
    });
    expect(fixture.assetCalls).toEqual([]);
    expect(fresh).toBeDefined();
    expect(() =>
      githubUpdateCheck.claimResolvedGithubTemplateSourceForDownload(fresh)
    ).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => discardResolvedGithubTemplateSource(fresh))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    const lease = acquireProjectTemplateMutationLease(
      fixture.projectRoot,
      'download',
    );
    lease.release();
  });

  it('discards a valid fresh authority when download claiming fails', async () => {
    const fixture = await makeFixture();
    let fresh: ResolvedGithubTemplateSource | undefined;
    const resolver: GithubTemplateSourceResolverPort = {
      resolveAdvisory: fixture.resolver.resolveAdvisory,
      async resolveForDownload(input) {
        fresh = await fixture.resolver.resolveForDownload(input);
        return fresh;
      },
    };
    const claim = vi.spyOn(
      githubUpdateCheck,
      'claimResolvedGithubTemplateSourceForDownload',
    ).mockImplementation(() => {
      throw new Error('ghp_claim_secret');
    });

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    })).rejects.toMatchObject({ code: 'SOURCE_RESOLUTION_FAILED' });
    claim.mockRestore();

    expect(fixture.assetCalls).toEqual([]);
    expect(fresh).toBeDefined();
    expect(() =>
      githubUpdateCheck.claimResolvedGithubTemplateSourceForDownload(fresh)
    ).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
  });

  it.each([
    ['ineligible', 'DOWNLOAD_NOT_ELIGIBLE'],
    ['aborted', 'ABORTED'],
    ['lease-lost', 'LEASE_LOST'],
  ] as const)(
    'retires fresh authority after post-resolution %s',
    async (boundary, code) => {
      const fixture = await makeFixture();
      const controller = new AbortController();
      let fresh: ResolvedGithubTemplateSource | undefined;
      const resolver: GithubTemplateSourceResolverPort = {
        resolveAdvisory: fixture.resolver.resolveAdvisory,
        async resolveForDownload(input) {
          if (boundary === 'ineligible') {
            fresh = await resolveGithubTemplateSourceForAuthenticatedDownload({
              source: parseProjectTemplateGithubSourceSpec(input.source),
              metadata: fixture.metadata,
              current: {
                owner: fixture.advisory.source.owner,
                repo: fixture.advisory.source.repo,
                repositoryUrl: fixture.advisory.source.repositoryUrl,
                canonicalSource: fixture.advisory.source.canonicalSource,
                version: fixture.advisory.release.version,
                sha256: fixture.advisory.release.sha256,
                commit: fixture.advisory.source.commit,
                descriptorSha256:
                  fixture.advisory.source.descriptorSha256,
              },
            });
          } else {
            fresh = await fixture.resolver.resolveForDownload(input);
          }
          if (boundary === 'aborted') controller.abort();
          if (boundary === 'lease-lost') {
            unlinkSync(join(
              fixture.projectRoot,
              '.takt-template-state',
              'apply.lock',
            ));
          }
          return fresh;
        },
      };

      await expect(downloadGithubTemplateSource({
        projectRoot: fixture.projectRoot,
        source: fixture.source,
        advisory: fixture.advisory,
        resolver,
        asset: fixture.asset,
        cacheRoot: fixture.cacheRoot,
        authenticator: fixture.authenticator,
        verifier: fixture.verifier,
        signal: controller.signal,
      })).rejects.toMatchObject({ code });

      expect(fresh).toBeDefined();
      expect(() =>
        githubUpdateCheck.claimResolvedGithubTemplateSourceForDownload(fresh)
      ).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
      expect(fixture.assetCalls).toEqual([]);
      expect(readdirSync(fixture.cacheRoot)).toEqual([]);
    },
  );

  it.each([
    'kind',
    'owner',
    'repo',
    'repositoryUrl',
    'canonicalSource',
    'requestedRef',
    'releaseTag',
    'commit',
    'descriptorSha256',
    'releaseId',
    'assetId',
    'assetName',
    'assetSize',
    'checksumAssetId',
    'checksumAssetName',
    'checksumAssetSize',
    'sha256',
    'version',
    'declaredDependencies',
    'updateState',
    'hardBlocked',
    'downloadEligible',
  ] as const)('exactly matches fresh resolved field %s', async (field) => {
    const fixture = await makeFixture();
    const replacements: Record<string, unknown> = {
      kind: 'other-kind',
      owner: 'other',
      repo: 'other',
      repositoryUrl: 'https://github.com/other/template',
      canonicalSource: 'github:other/template@main',
      requestedRef: 'other',
      releaseTag: 'v9.9.9',
      commit: OTHER_COMMIT,
      descriptorSha256: 'd'.repeat(64),
      releaseId: 999,
      assetId: 998,
      assetName: 'other.taktpack',
      assetSize: fixture.content.byteLength + 1,
      checksumAssetId: 997,
      checksumAssetName: 'other.taktpack.sha256',
      checksumAssetSize: 999,
      sha256: 'e'.repeat(64),
      version: '9.9.9',
      declaredDependencies: [],
      updateState: 'source-changed',
      hardBlocked: true,
      downloadEligible: false,
    };
    const sourceFields = new Set([
      'owner',
      'repo',
      'repositoryUrl',
      'canonicalSource',
      'requestedRef',
      'commit',
      'descriptorSha256',
    ]);
    const releaseFields: Record<string, string> = {
      releaseTag: 'tag',
      releaseId: 'id',
      sha256: 'sha256',
      version: 'version',
    };
    const assetFields: Record<string, string> = {
      assetId: 'id',
      assetName: 'name',
      assetSize: 'size',
    };
    const checksumFields: Record<string, string> = {
      checksumAssetId: 'id',
      checksumAssetName: 'name',
      checksumAssetSize: 'size',
    };
    let advisory: GithubTemplateSourceAdvisory;
    if (sourceFields.has(field)) {
      advisory = Object.freeze({
        ...fixture.advisory,
        source: Object.freeze({
          ...fixture.advisory.source,
          [field]: replacements[field],
        }),
      }) as GithubTemplateSourceAdvisory;
    } else if (field in releaseFields) {
      advisory = Object.freeze({
        ...fixture.advisory,
        release: Object.freeze({
          ...fixture.advisory.release,
          [releaseFields[field]!]: replacements[field],
        }),
      }) as GithubTemplateSourceAdvisory;
    } else if (field in assetFields) {
      advisory = Object.freeze({
        ...fixture.advisory,
        release: Object.freeze({
          ...fixture.advisory.release,
          asset: Object.freeze({
            ...fixture.advisory.release.asset,
            [assetFields[field]!]: replacements[field],
          }),
        }),
      }) as GithubTemplateSourceAdvisory;
    } else if (field in checksumFields) {
      advisory = Object.freeze({
        ...fixture.advisory,
        release: Object.freeze({
          ...fixture.advisory.release,
          checksumAsset: Object.freeze({
            ...fixture.advisory.release.checksumAsset,
            [checksumFields[field]!]: replacements[field],
          }),
        }),
      }) as GithubTemplateSourceAdvisory;
    } else {
      advisory = Object.freeze({
        ...fixture.advisory,
        [field]: replacements[field],
      }) as GithubTemplateSourceAdvisory;
    }

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory,
      resolver: fixture.resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    })).rejects.toMatchObject({
      code: field === 'kind'
        ? 'INVALID_ARGUMENT'
        : field === 'hardBlocked' || field === 'downloadEligible'
          ? 'DOWNLOAD_NOT_ELIGIBLE'
          : 'SOURCE_DRIFT',
    });
    expect(fixture.assetCalls).toEqual([]);
  });

  it('discards sealed staging after transport-triggered lease loss', async () => {
    const fixture = await makeFixture();
    const lockPath = join(
      fixture.projectRoot,
      '.takt-template-state',
      'apply.lock',
    );
    const asset: GithubTemplateArchiveAssetPort = {
      openReleaseAsset() {
        return (async function* () {
          yield fixture.content;
          unlinkSync(lockPath);
        })();
      },
    };

    const error = await downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'LEASE_LOST',
      artifactState: 'none',
    });
    expect(stagingEntries(fixture.projectRoot)).toEqual([]);
  });

  it('stops before authentication when the lease is lost during materialization', async () => {
    const fixture = await makeFixture();
    const lockPath = join(
      fixture.projectRoot,
      '.takt-template-state',
      'apply.lock',
    );
    let signingCalls = 0;
    let removed = false;
    const materialize = githubDownloadStorage.materializeGithubTemplateCache;
    const materializeSpy = vi.spyOn(
      githubDownloadStorage,
      'materializeGithubTemplateCache',
    ).mockImplementation(async (input) => {
      const materialized = await materialize(input);
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
        removed = true;
      }
      return materialized;
    });
    let error: unknown;
    try {
      error = await downloadGithubTemplateSource({
        projectRoot: fixture.projectRoot,
        source: fixture.source,
        advisory: fixture.advisory,
        resolver: fixture.resolver,
        asset: fixture.asset,
        cacheRoot: fixture.cacheRoot,
        authenticator: {
          async acquireSigningKey() {
            signingCalls += 1;
            return fixture.authenticator.acquireSigningKey();
          },
        },
        verifier: fixture.verifier,
      }).catch((caught: unknown) => caught);
    } finally {
      materializeSpy.mockRestore();
    }
    expect(removed).toBe(true);
    expect(error).toMatchObject({
      code: 'LEASE_LOST',
      artifactState: 'cache-published',
      receiptState: 'none',
      releaseState: 'uncertain',
    });
    expect(signingCalls).toBe(0);
  });

  it('preserves primary identity across discard and release failures', async () => {
    const fixture = await makeFixture();
    const lockPath = join(
      fixture.projectRoot,
      '.takt-template-state',
      'apply.lock',
    );
    const asset: GithubTemplateArchiveAssetPort = {
      openReleaseAsset() {
        return (async function* () {
          yield fixture.content;
          const stagingRoot = join(
            fixture.projectRoot,
            '.takt-template-state',
            'download-staging',
          );
          const stagingDirectory = join(
            stagingRoot,
            readdirSync(stagingRoot)[0]!,
          );
          writeFileSync(join(stagingDirectory, 'unexpected'), 'keep');
          unlinkSync(lockPath);
        })();
      },
    };

    const error = await downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'LEASE_LOST',
      artifactState: 'staging-only',
      receiptState: undefined,
      cleanupState: 'failed',
      releaseState: 'uncertain',
    });
  });

  it('discards partial staging and maps AbortSignal to a finite error', async () => {
    const fixture = await makeFixture();
    const controller = new AbortController();
    const asset: GithubTemplateArchiveAssetPort = {
      openReleaseAsset() {
        return (async function* () {
          yield fixture.content.subarray(0, 32);
          controller.abort();
          yield fixture.content.subarray(32);
        })();
      },
    };

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: 'ABORTED',
      artifactState: 'none',
    });
    expect(stagingEntries(fixture.projectRoot)).toEqual([]);
  });

  it('redacts a streaming port failure and removes partial staging', async () => {
    const fixture = await makeFixture();
    const asset: GithubTemplateArchiveAssetPort = {
      openReleaseAsset() {
        return (async function* () {
          yield fixture.content.subarray(0, 32);
          throw new Error('ghp_stream_secret');
        })();
      },
    };

    const error = await downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'DOWNLOAD_PORT_FAILURE',
      artifactState: 'none',
    });
    expect(String((error as Error).message)).not.toContain(
      'ghp_stream_secret',
    );
    expect(stagingEntries(fixture.projectRoot)).toEqual([]);
  });

  it('maps signing failure after materialization without leaking its secret', async () => {
    const fixture = await makeFixture();
    const error = await downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: {
        async acquireSigningKey() {
          throw new Error('ghp_signing_secret');
        },
      },
      verifier: fixture.verifier,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'RECEIPT_FAILED',
      artifactState: 'cache-published',
      receiptState: 'none',
    });
    expect(String((error as Error).message)).not.toContain(
      'ghp_signing_secret',
    );
    expect(stagingEntries(fixture.projectRoot)).toEqual([]);
    const lease = acquireProjectTemplateMutationLease(
      fixture.projectRoot,
      'download',
    );
    lease.release();
  });

  it('maps receipt verification failure with actual receipt state', async () => {
    const fixture = await makeFixture();
    const error = await downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: {
        async verify() {
          throw new Error('ghp_verifier_secret');
        },
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'RECEIPT_STORAGE_FAILED',
      artifactState: 'cache-published',
      receiptState: 'none',
    });
    expect(String((error as Error).message)).not.toContain(
      'ghp_verifier_secret',
    );
  });

  it('preserves a receipt primary and annotates uncertain lease release', async () => {
    const fixture = await makeFixture();
    const lockPath = join(
      fixture.projectRoot,
      '.takt-template-state',
      'apply.lock',
    );
    let removed = false;
    const error = await downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: {
        async verify() {
          if (!removed) {
            removed = true;
            unlinkSync(lockPath);
          }
          throw new Error('ghp_primary_release_secret');
        },
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'RECEIPT_STORAGE_FAILED',
      artifactState: 'cache-published',
      receiptState: 'none',
      releaseState: 'uncertain',
    });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it('reports lease release failure after a fully persisted tail', async () => {
    const fixture = await makeFixture();
    const lockPath = join(
      fixture.projectRoot,
      '.takt-template-state',
      'apply.lock',
    );
    let removed = false;
    const verifier = {
      async verify(request: {
        readonly input: Uint8Array;
        readonly tag: string;
      }) {
        if (!removed) {
          removed = true;
          unlinkSync(lockPath);
        }
        return createHmac('sha256', SECRET).update(request.input).digest('hex')
            === request.tag
          ? 'valid' as const
          : 'invalid' as const;
      },
    };

    const error = await downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'LEASE_RELEASE_FAILED',
      artifactState: 'cache-published',
      receiptState: 'receipt-published',
      releaseState: 'uncertain',
    });
  });

  it.each([
    'options',
    'advisory',
    'resolver',
    'asset',
    'authenticator',
    'verifier',
    'current',
    'signal',
  ] as const)(
    'rejects hostile %s proxies without invoking traps',
    async (target) => {
      const fixture = await makeFixture();
      let traps = 0;
      const hostile = new Proxy({}, {
        get() {
          traps += 1;
          throw new Error('trap');
        },
        getPrototypeOf() {
          traps += 1;
          throw new Error('trap');
        },
        ownKeys() {
          traps += 1;
          throw new Error('trap');
        },
      });
      const base = {
        projectRoot: fixture.projectRoot,
        source: fixture.source,
        advisory: fixture.advisory,
        resolver: fixture.resolver,
        asset: fixture.asset,
        cacheRoot: fixture.cacheRoot,
        authenticator: fixture.authenticator,
        verifier: fixture.verifier,
      };
      const value = target === 'options'
        ? hostile
        : {
          ...base,
          [target]: hostile,
        };

      await expect(downloadGithubTemplateSource(
        value as Parameters<typeof downloadGithubTemplateSource>[0],
      )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(traps).toBe(0);
    },
  );

  it.each([
    ['dependencies', 'index-getter'],
    ['dependencies', 'map'],
    ['dependencies', 'some'],
    ['dependencies', 'iterator'],
    ['dependencies', 'hole'],
    ['dependencies', 'proxy'],
    ['dependencies', 'extra-symbol'],
    ['capabilities', 'index-getter'],
    ['capabilities', 'map'],
    ['capabilities', 'some'],
    ['capabilities', 'iterator'],
    ['capabilities', 'hole'],
    ['capabilities', 'proxy'],
    ['capabilities', 'extra-symbol'],
  ] as const)(
    'rejects hostile %s array %s without executing it',
    async (target, attack) => {
      const fixture = await makeFixture();
      let executions = 0;
      const createHostileArray = (entry: unknown): unknown[] => {
        const array: unknown[] = [];
        if (attack === 'hole') {
          array.length = 1;
          return array;
        }
        if (attack === 'proxy') {
          return new Proxy(array, {
            get() {
              executions += 1;
              throw new Error('must not execute');
            },
            ownKeys() {
              executions += 1;
              throw new Error('must not execute');
            },
          });
        }
        if (attack === 'index-getter') {
          Object.defineProperty(array, '0', {
            enumerable: true,
            get() {
              executions += 1;
              throw new Error('must not execute');
            },
          });
          return array;
        }
        array.push(entry);
        const key = attack === 'iterator'
          ? Symbol.iterator
          : attack === 'extra-symbol'
            ? Symbol('extra')
            : attack;
        Object.defineProperty(array, key, {
          configurable: true,
          value() {
            executions += 1;
            throw new Error('must not execute');
          },
        });
        return array;
      };
      const originalDependency =
        fixture.advisory.declaredDependencies[0]!;
      const dependencies = target === 'dependencies'
        ? createHostileArray(originalDependency)
        : [Object.freeze({
          ...originalDependency,
          capabilities: createHostileArray('edit'),
        })];
      const advisory = Object.freeze({
        ...fixture.advisory,
        declaredDependencies: dependencies,
      }) as GithubTemplateSourceAdvisory;

      await expect(downloadGithubTemplateSource({
        projectRoot: fixture.projectRoot,
        source: fixture.source,
        advisory,
        resolver: fixture.resolver,
        asset: fixture.asset,
        cacheRoot: fixture.cacheRoot,
        authenticator: fixture.authenticator,
        verifier: fixture.verifier,
      })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(executions).toBe(0);
      expect(fixture.calls).toEqual([]);
      expect(fixture.assetCalls).toEqual([]);
    },
  );

  it('rejects unknown keys and accessors before acquiring a lease', async () => {
    const fixture = await makeFixture();
    const base = {
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver: fixture.resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    };
    await expect(downloadGithubTemplateSource({
      ...base,
      extra: true,
    } as Parameters<typeof downloadGithubTemplateSource>[0]))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(downloadGithubTemplateSource(Object.defineProperty(
      { ...base },
      'source',
      {
        enumerable: true,
        get() {
          throw new Error('must not run');
        },
      },
    ))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fixture.calls).toEqual([]);
    expect(fixture.assetCalls).toEqual([]);
  });

  it('rejects resolver accessors, extra keys, and the retired metadata option', async () => {
    const fixture = await makeFixture();
    let executions = 0;
    const accessorResolver = Object.defineProperty(
      {
        resolveAdvisory: fixture.resolver.resolveAdvisory,
      },
      'resolveForDownload',
      {
        enumerable: true,
        get() {
          executions += 1;
          throw new Error('must not execute');
        },
      },
    );
    const extraResolver = {
      ...fixture.resolver,
      credential: 'ghp_must_not_cross_boundary',
    };
    const base = {
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    };

    for (const resolver of [accessorResolver, extraResolver]) {
      await expect(downloadGithubTemplateSource({
        ...base,
        resolver,
      } as Parameters<typeof downloadGithubTemplateSource>[0]))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    await expect(downloadGithubTemplateSource({
      ...base,
      metadata: fixture.metadata,
    } as unknown as Parameters<typeof downloadGithubTemplateSource>[0]))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    expect(executions).toBe(0);
    expect(fixture.resolverInputs).toEqual([]);
    expect(fixture.assetCalls).toEqual([]);
  });

  it.each(['source', 'projectRoot', 'cacheRoot', 'advisory', 'current'] as const)(
    'rejects malformed %s before remote or lease work',
    async (field) => {
      const fixture = await makeFixture();
      const base = {
        projectRoot: fixture.projectRoot,
        source: fixture.source,
        advisory: fixture.advisory,
        resolver: fixture.resolver,
        asset: fixture.asset,
        cacheRoot: fixture.cacheRoot,
        authenticator: fixture.authenticator,
        verifier: fixture.verifier,
      };
      const replacements = {
        source: 'https://example.com/asset.taktpack',
        projectRoot: `${fixture.projectRoot}/.`,
        cacheRoot: `${fixture.cacheRoot}/.`,
        advisory: Object.freeze({
          ...fixture.advisory,
          release: Object.freeze({
            ...fixture.advisory.release,
            asset: Object.freeze({
              ...fixture.advisory.release.asset,
              size: '1',
            }),
          }),
        }),
        current: Object.freeze({ owner: 'missing-fields' }),
      };

      await expect(downloadGithubTemplateSource({
        ...base,
        [field]: replacements[field],
      } as Parameters<typeof downloadGithubTemplateSource>[0]))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(fixture.calls).toEqual([]);
      expect(fixture.assetCalls).toEqual([]);
      const lease = acquireProjectTemplateMutationLease(
        fixture.projectRoot,
        'download',
      );
      lease.release();
    },
  );

  it('uses resolver methods and receiver captured before replacement', async () => {
    const fixture = await makeFixture();
    const authenticator = { ...fixture.authenticator };
    const verifier = { ...fixture.verifier };
    let replaced = false;
    const resolver: GithubTemplateSourceResolverPort = {
      resolveAdvisory: fixture.resolver.resolveAdvisory,
      async resolveForDownload(input) {
        expect(this).toBe(resolver);
        if (!replaced) {
          replaced = true;
          authenticator.acquireSigningKey = async () => {
            throw new Error('replacement authenticator');
          };
          verifier.verify = async () => {
            throw new Error('replacement verifier');
          };
          resolver.resolveForDownload = async () => {
            throw new Error('replacement resolver');
          };
        }
        return fixture.resolver.resolveForDownload(input);
      },
    };

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator,
      verifier,
    })).resolves.toMatchObject({ status: 'downloaded' });
  });

  it('passes an exact snapshotted current object to fresh resolution', async () => {
    const fixture = await makeFixture();
    const current = {
      owner: 'other',
      repo: 'template',
      repositoryUrl: 'https://github.com/other/template' as const,
      canonicalSource: 'github:other/template@main',
      version: '1.0.0',
      sha256: 'b'.repeat(64),
      commit: OTHER_COMMIT,
      descriptorSha256: 'c'.repeat(64),
    };
    const advisory = demoteResolvedGithubTemplateSourceToAdvisory(
      await resolveGithubTemplateSource({
        source: parseProjectTemplateGithubSourceSpec(fixture.source),
        metadata: fixture.metadata,
        current,
      }),
    );
    fixture.calls.length = 0;

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory,
      resolver: fixture.resolver,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
      current,
    })).resolves.toMatchObject({ status: 'downloaded' });
    expect(fixture.resolverInputs).toHaveLength(1);
    expect(Reflect.ownKeys(fixture.resolverInputs[0]!))
      .toEqual(['source', 'current']);
    expect(Object.isFrozen(fixture.resolverInputs[0])).toBe(true);
    expect(Object.isFrozen(fixture.resolverInputs[0]!.current)).toBe(true);
    expect(fixture.resolverInputs[0]!.current).not.toBe(current);
    expect(fixture.resolverInputs[0]!.current).toEqual(current);
  });
});
