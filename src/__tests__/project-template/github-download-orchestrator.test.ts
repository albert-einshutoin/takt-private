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
import {
  downloadGithubTemplateSource,
  type GithubTemplateArchiveAssetPort,
} from '../../features/project-template/github-download-orchestrator.js';
import * as githubDownloadStorage from '../../features/project-template/github-download-storage.js';
import {
  createProjectTemplateExportPlan,
  parseProjectTemplateGithubSourceSpec,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  resolveGithubTemplateSource,
  type GithubTemplateSourceMetadataPort,
  type ResolvedGithubTemplateSource,
} from '../../features/project-template/github-update-check.js';
import {
  serializeProjectTemplateSourceDescriptor,
  type ProjectTemplateSourceDescriptorV1,
} from '../../features/project-template/source-descriptor.js';

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
  const metadata: GithubTemplateSourceMetadataPort = {
    async resolveRefToCommit() {
      calls.push('resolve-ref');
      return { commit };
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
  const advisory = await resolveGithubTemplateSource({ source, metadata });
  calls.length = 0;
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
    setCommit(value: string) {
      commit = value;
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
  it('re-resolves under the download lease, stages, and consumes staging privately', async () => {
    const fixture = await makeFixture();

    const result = await downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      metadata: fixture.metadata,
      asset: fixture.asset,
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
    expect(stagingEntries(fixture.projectRoot)).toEqual([]);
    const lease = acquireProjectTemplateMutationLease(
      fixture.projectRoot,
      'download',
    );
    lease.release();
  });

  it('rejects advisory ineligibility before guard, lease, metadata, or asset work', async () => {
    const fixture = await makeFixture();
    const current = {
      owner: fixture.advisory.owner,
      repo: fixture.advisory.repo,
      repositoryUrl: fixture.advisory.repositoryUrl,
      canonicalSource: fixture.advisory.canonicalSource,
      version: fixture.advisory.version,
      sha256: fixture.advisory.sha256,
      commit: fixture.advisory.commit,
      descriptorSha256: fixture.advisory.descriptorSha256,
    };
    const ineligible = await resolveGithubTemplateSource({
      source: parseProjectTemplateGithubSourceSpec(fixture.source),
      metadata: fixture.metadata,
      current,
    });
    fixture.calls.length = 0;

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: ineligible,
      metadata: fixture.metadata,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
      current,
    })).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_ELIGIBLE' });
    expect(fixture.calls).toEqual([]);
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
        metadata: fixture.metadata,
        asset: fixture.asset,
        cacheRoot: fixture.cacheRoot,
        authenticator: fixture.authenticator,
        verifier: fixture.verifier,
      })).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
    } finally {
      blocker.release();
    }
    expect(fixture.calls).toEqual([]);
    expect(fixture.assetCalls).toEqual([]);
  });

  it('rejects any fresh resolved authority field drift before asset access', async () => {
    const fixture = await makeFixture();
    fixture.setCommit(OTHER_COMMIT);

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      metadata: fixture.metadata,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
    })).rejects.toMatchObject({ code: 'SOURCE_DRIFT' });
    expect(fixture.assetCalls).toEqual([]);
    const lease = acquireProjectTemplateMutationLease(
      fixture.projectRoot,
      'download',
    );
    lease.release();
  });

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
    const advisory = Object.freeze({
      ...fixture.advisory,
      [field]: replacements[field],
    }) as ResolvedGithubTemplateSource;

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory,
      metadata: fixture.metadata,
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
      metadata: fixture.metadata,
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
        metadata: fixture.metadata,
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
      metadata: fixture.metadata,
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
      metadata: fixture.metadata,
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
      metadata: fixture.metadata,
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
      metadata: fixture.metadata,
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
      metadata: fixture.metadata,
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
      metadata: fixture.metadata,
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
      metadata: fixture.metadata,
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
    'metadata',
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
        metadata: fixture.metadata,
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
      }) as ResolvedGithubTemplateSource;

      await expect(downloadGithubTemplateSource({
        projectRoot: fixture.projectRoot,
        source: fixture.source,
        advisory,
        metadata: fixture.metadata,
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
      metadata: fixture.metadata,
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

  it.each(['source', 'projectRoot', 'cacheRoot', 'advisory', 'current'] as const)(
    'rejects malformed %s before remote or lease work',
    async (field) => {
      const fixture = await makeFixture();
      const base = {
        projectRoot: fixture.projectRoot,
        source: fixture.source,
        advisory: fixture.advisory,
        metadata: fixture.metadata,
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
          assetSize: '1',
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

  it('uses port methods captured before metadata can replace them', async () => {
    const fixture = await makeFixture();
    const authenticator = { ...fixture.authenticator };
    const verifier = { ...fixture.verifier };
    let replaced = false;
    const metadata: GithubTemplateSourceMetadataPort = {
      async resolveRefToCommit(input) {
        if (!replaced) {
          replaced = true;
          authenticator.acquireSigningKey = async () => {
            throw new Error('replacement authenticator');
          };
          verifier.verify = async () => {
            throw new Error('replacement verifier');
          };
        }
        return fixture.metadata.resolveRefToCommit(input);
      },
      readFileAtCommit(input) {
        return fixture.metadata.readFileAtCommit(input);
      },
      getReleaseByTag(input) {
        return fixture.metadata.getReleaseByTag(input);
      },
      readReleaseAsset(input) {
        return fixture.metadata.readReleaseAsset(input);
      },
    };

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory: fixture.advisory,
      metadata,
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
    const advisory = await resolveGithubTemplateSource({
      source: parseProjectTemplateGithubSourceSpec(fixture.source),
      metadata: fixture.metadata,
      current,
    });
    fixture.calls.length = 0;

    await expect(downloadGithubTemplateSource({
      projectRoot: fixture.projectRoot,
      source: fixture.source,
      advisory,
      metadata: fixture.metadata,
      asset: fixture.asset,
      cacheRoot: fixture.cacheRoot,
      authenticator: fixture.authenticator,
      verifier: fixture.verifier,
      current,
    })).resolves.toMatchObject({ status: 'downloaded' });
  });
});
