import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateExportPlan,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  claimPreparedGithubTemplateDownloadReceiptForStorage,
  consumePreparedGithubTemplateDownloadReceiptStorageClaim,
  createGithubTemplateDownloadReceiptAuthenticationInput,
  GithubTemplateDownloadReceiptError,
  MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES,
  parseGithubTemplateDownloadReceipt,
  prepareGithubTemplateDownloadReceipt,
  serializeGithubTemplateDownloadReceipt,
} from '../../features/project-template/github-download-receipt.js';
import {
  materializeGithubTemplateCache,
  stageGithubTemplateDownload,
} from '../../features/project-template/github-download-storage.js';
import { parseProjectTemplateGithubSourceSpec } from '../../features/project-template/github-source-spec.js';
import {
  claimResolvedGithubTemplateSourceForDownload,
  resolveGithubTemplateSource,
  resolveGithubTemplateSourceForAuthenticatedDownload,
  type GithubTemplateSourceMetadataPort,
} from '../../features/project-template/github-update-check.js';
import {
  calculateProjectTemplateSourceDescriptorSha256,
  serializeProjectTemplateSourceDescriptor,
  type ProjectTemplateSourceDescriptorV1,
} from '../../features/project-template/source-descriptor.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ASSET_NAME = 'template.taktpack';
const CHECKSUM_NAME = `${ASSET_NAME}.sha256`;
const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function* chunks(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

interface FixtureOptions {
  manifestVersion?: string;
  manifestRepositoryUrl?: string;
  manifestRef?: string;
  manifestCommit?: string;
  declaredAssetSize?: number;
  dependencyCommit?: string;
  directSource?: boolean;
}

interface MutableReceipt {
  payload: {
    source: {
      descriptorSha256: string;
      canonicalSource: string;
      requestedRef: string;
      releaseTag: string;
      dependencyVerification?: unknown;
      sourceDescriptor: {
        schemaVersion: string;
        pack: { sha256: string };
        repertoireDependencies: unknown[];
      };
    };
    release: {
      releaseId: number;
      assetId: number;
      assetName: string;
      assetSize: number;
      checksumAssetId: number;
      checksumAssetName: string;
      checksumAssetSize: number;
    };
    archive: {
      bytes: number;
      version: string;
      source: {
        uri: string;
        ref: string;
        commit: string;
      };
      takt: { minVersion: string; maxVersion?: string };
    };
  };
}

async function createFixture(options: FixtureOptions = {}) {
  const projectRoot = makeRoot('takt-receipt-project-');
  const sourcePath = join(projectRoot, '.takt', 'workflows', 'review.yaml');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, 'name: review\n');
  const plan = await createProjectTemplateExportPlan(projectRoot, {
    packVersion: options.manifestVersion ?? '1.2.3',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'github',
      uri: (
        options.manifestRepositoryUrl
        ?? 'https://github.com/acme/template'
      ) as `https://github.com/${string}/${string}`,
      ref: options.manifestRef ?? 'v1.2.3',
      commit: options.manifestCommit ?? COMMIT,
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
      commit: options.dependencyCommit
        ?? 'abcdef0123456789abcdef0123456789abcdef01',
      capabilities: ['edit'],
    }],
  };
  const checksum = `${archiveSha}  ${ASSET_NAME}\n`;
  const metadata: GithubTemplateSourceMetadataPort = {
    async resolveRefToCommit(input) {
      return {
        commit: input.owner === 'acme' && input.repo === 'dependency'
          ? descriptor.repertoireDependencies[0]!.commit
          : COMMIT,
      };
    },
    async readFileAtCommit() {
      return new TextEncoder().encode(
        serializeProjectTemplateSourceDescriptor(descriptor),
      );
    },
    async getReleaseByTag() {
      return {
        id: 101,
        tagName: 'v1.2.3',
        assets: [
          {
            id: 201,
            name: ASSET_NAME,
            size: options.declaredAssetSize ?? content.byteLength,
          },
          { id: 202, name: CHECKSUM_NAME, size: checksum.length },
        ],
      };
    },
    async readReleaseAsset() {
      return new TextEncoder().encode(checksum);
    },
  };
  const resolved = await resolveGithubTemplateSourceForAuthenticatedDownload({
    source: parseProjectTemplateGithubSourceSpec(
      options.directSource
        ? `https://github.com/acme/template/releases/download/v1.2.3/${ASSET_NAME}`
        : 'github:acme/template@main',
    ),
    metadata,
  });
  const controlRoot = join(projectRoot, '.takt-template-state');
  mkdirSync(controlRoot, { mode: 0o700 });
  const staged = await stageGithubTemplateDownload({
    projectRoot,
    expectedBytes: content.byteLength,
    expectedSha256: archiveSha,
    chunks: chunks(content),
  });
  const cacheRoot = makeRoot('takt-receipt-cache-');
  chmodSync(cacheRoot, 0o700);
  const materialized = await materializeGithubTemplateCache({
    staged,
    cacheRoot: realpathSync.native(cacheRoot),
  });
  const downloadClaim =
    claimResolvedGithubTemplateSourceForDownload(resolved);
  return { downloadClaim, materialized };
}

function authenticator(keyId = 'receipt-key-1', secret = 'test-secret') {
  return {
    async acquireSigningKey() {
      return {
        keyId,
        async sign(input: Uint8Array) {
          return createHmac('sha256', secret).update(input).digest('hex');
        },
      };
    },
  };
}

describe('GitHub template authenticated download receipt D1', () => {
  it('prepares a canonical authenticated envelope without runtime state', async () => {
    const fixture = await createFixture();
    let signedInput: Uint8Array | undefined;
    const prepared = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: {
        async acquireSigningKey() {
          return {
            keyId: 'receipt-key-1',
            async sign(input: Uint8Array) {
              signedInput = input.slice();
              return createHmac('sha256', 'test-secret')
                .update(input)
                .digest('hex');
            },
          };
        },
      },
    });

    expect(prepared.receipt).toMatchObject({
      schemaVersion: '1.0',
      kind: 'github-template-download-receipt',
      payload: {
        source: {
          owner: 'acme',
          repo: 'template',
          repositoryUrl: 'https://github.com/acme/template',
          requestedRef: 'main',
          releaseTag: 'v1.2.3',
          commit: COMMIT,
          dependencyVerification: {
            method: 'github-ref-to-commit-v1',
            declarationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            count: 1,
          },
        },
        release: {
          releaseId: 101,
          assetId: 201,
          checksumAssetId: 202,
        },
        archive: {
          bytes: fixture.materialized.bytes,
          sha256: fixture.materialized.sha256,
          version: '1.2.3',
          takt: fixture.materialized.inspection.manifest.takt,
          source: {
            kind: 'github',
            uri: 'https://github.com/acme/template',
            ref: 'v1.2.3',
            commit: COMMIT,
          },
        },
      },
      authentication: {
        algorithm: 'hmac-sha256',
        keyId: 'receipt-key-1',
      },
    });
    expect(prepared.serialized.endsWith('\n')).toBe(false);
    expect(prepared.serialized).toBe(
      JSON.stringify(prepared.receipt, null, 2),
    );
    expect(prepared.receiptKey).toMatch(/^[a-f0-9]{64}$/);
    const signedText = new TextDecoder().decode(signedInput);
    expect(signedText).toMatch(
      /^takt:github-template-download-receipt:v1:pre-auth-envelope\u0000\{/,
    );
    expect(signedText).toContain('"algorithm": "hmac-sha256"');
    expect(signedText).toContain('"keyId": "receipt-key-1"');
    expect(signedText).toContain('"method": "github-ref-to-commit-v1"');
    expect(signedText).not.toContain('"tag"');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.receipt.payload.source.sourceDescriptor))
      .toBe(true);
    for (const forbidden of [
      'updateState',
      'hardBlocked',
      'downloadEligible',
      'token',
      'cachePath',
      'pid',
      'timestamp',
      'compatibility',
      'currentVersion',
    ]) {
      expect(prepared.serialized).not.toContain(`"${forbidden}"`);
    }
  });

  it('is deterministic for equal provenance and differs by key identity', async () => {
    const first = await createFixture();
    const second = await createFixture();
    const third = await createFixture();
    const fourth = await createFixture({
      dependencyCommit: 'fbcdef0123456789abcdef0123456789abcdef01',
    });
    const firstPrepared = await prepareGithubTemplateDownloadReceipt({
      ...first,
      authenticator: authenticator(),
    });
    const secondPrepared = await prepareGithubTemplateDownloadReceipt({
      ...second,
      authenticator: authenticator(),
    });
    const thirdPrepared = await prepareGithubTemplateDownloadReceipt({
      ...third,
      authenticator: authenticator('receipt-key-2'),
    });
    const fourthPrepared = await prepareGithubTemplateDownloadReceipt({
      ...fourth,
      authenticator: authenticator(),
    });

    expect(firstPrepared.serialized).toBe(secondPrepared.serialized);
    expect(firstPrepared.receiptKey).toBe(secondPrepared.receiptKey);
    expect(thirdPrepared.receiptKey).not.toBe(firstPrepared.receiptKey);
    expect(fourthPrepared.receiptKey).not.toBe(firstPrepared.receiptKey);
  });

  it('uses one stable signing-key lease across key rotation and alias mutation', async () => {
    const fixture = await createFixture();
    let activeSecret = 'lease-secret-1';
    let signedInput: Uint8Array | undefined;
    let receiverWasLease = false;
    const lease = {
      keyId: 'receipt-key-1',
      async sign(this: unknown, input: Uint8Array) {
        receiverWasLease = this === lease;
        signedInput = input.slice();
        lease.keyId = 'receipt-key-2';
        activeSecret = 'lease-secret-2';
        return createHmac('sha256', 'lease-secret-1')
          .update(input)
          .digest('hex');
      },
    };
    const prepared = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: {
        async acquireSigningKey() {
          return lease;
        },
      },
    });

    expect(receiverWasLease).toBe(true);
    expect(activeSecret).toBe('lease-secret-2');
    expect(lease.keyId).toBe('receipt-key-2');
    expect(prepared.receipt.authentication.keyId).toBe('receipt-key-1');
    expect(prepared.receipt.authentication.tag).toBe(
      createHmac('sha256', 'lease-secret-1')
        .update(signedInput!)
        .digest('hex'),
    );
  });

  it.each([
    ['manifest version', { manifestVersion: '1.2.4' }],
    ['repository URL', { manifestRepositoryUrl: 'https://github.com/acme/other' }],
    ['release tag', { manifestRef: 'v1.2.4' }],
    ['commit', { manifestCommit: 'f'.repeat(40) }],
    ['archive bytes', { declaredAssetSize: 1 }],
  ] as const)('rejects cross-binding mismatch: %s', async (_label, options) => {
    const fixture = await createFixture(options);
    await expect(prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    })).rejects.toMatchObject({ code: 'BINDING_MISMATCH' });
  });

  it('rejects clones and consumes both authorities after signer failure', async () => {
    const cloneFixture = await createFixture();
    for (const downloadClaim of [
      { ...cloneFixture.downloadClaim },
      JSON.parse(JSON.stringify(cloneFixture.downloadClaim)) as
        typeof cloneFixture.downloadClaim,
      new Proxy(cloneFixture.downloadClaim, {}),
    ]) {
      await expect(prepareGithubTemplateDownloadReceipt({
        downloadClaim,
        materialized: cloneFixture.materialized,
        authenticator: authenticator(),
      })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
    }
    await expect(prepareGithubTemplateDownloadReceipt({
      ...cloneFixture,
      authenticator: authenticator(),
    })).resolves.toMatchObject({
      receipt: { kind: 'github-template-download-receipt' },
    });

    for (const materializedKind of ['clone', 'json', 'proxy'] as const) {
      const materializedFixture = await createFixture();
      const materialized = materializedKind === 'clone'
        ? { ...materializedFixture.materialized }
        : materializedKind === 'json'
          ? JSON.parse(
            JSON.stringify(materializedFixture.materialized),
          ) as typeof materializedFixture.materialized
          : new Proxy(materializedFixture.materialized, {});
      await expect(prepareGithubTemplateDownloadReceipt({
        downloadClaim: materializedFixture.downloadClaim,
        materialized,
        authenticator: authenticator(),
      })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
    }

    const failureFixture = await createFixture();
    const error = await prepareGithubTemplateDownloadReceipt({
      ...failureFixture,
      authenticator: {
        async acquireSigningKey() {
          return {
            keyId: 'receipt-key-1',
            async sign() {
              throw new Error('ghp_receipt_signer_secret');
            },
          };
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(String((error as Error).message)).not.toContain(
      'ghp_receipt_signer_secret',
    );
    await expect(prepareGithubTemplateDownloadReceipt({
      ...failureFixture,
      authenticator: authenticator(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
  });

  it('claims both authorities before the first authenticator await', async () => {
    const fixture = await createFixture();
    let releaseKeyId!: (value: string) => void;
    const keyId = new Promise<string>((resolve) => {
      releaseKeyId = resolve;
    });
    const first = prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: {
        async acquireSigningKey() {
          const acquiredKeyId = await keyId;
          return {
            keyId: acquiredKeyId,
            async sign() {
              return '0'.repeat(64);
            },
          };
        },
      },
    });

    await expect(prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
    releaseKeyId('receipt-key-1');
    await expect(first).resolves.toMatchObject({
      receipt: { authentication: { keyId: 'receipt-key-1' } },
    });
  });

  it.each([
    ['unknown path', (value: Record<PropertyKey, unknown>) => {
      value['path'] = '/tmp/receipt.json';
      return value;
    }],
    ['symbol', (value: Record<PropertyKey, unknown>) => {
      value[Symbol('path')] = '/tmp/receipt.json';
      return value;
    }],
    ['accessor', (value: Record<PropertyKey, unknown>) => {
      Object.defineProperty(value, 'downloadClaim', {
        get() {
          throw new Error('ghp_receipt_option_secret');
        },
      });
      return value;
    }],
    ['Proxy', (value: Record<PropertyKey, unknown>) => new Proxy(value, {
      ownKeys() {
        throw new Error('ghp_receipt_option_secret');
      },
    })],
  ])('rejects strict prepare option boundary: %s', async (_label, mutate) => {
    const fixture = await createFixture();
    const options = mutate({
      ...fixture,
      authenticator: authenticator(),
    });
    const error = await prepareGithubTemplateDownloadReceipt(
      options as never,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String((error as Error).message)).not.toContain(
      'ghp_receipt_option_secret',
    );
    await expect(prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    })).resolves.toMatchObject({
      receipt: { kind: 'github-template-download-receipt' },
    });
  });

  it.each([
    ['invalid key id', authenticator('UPPERCASE')],
    ['invalid tag', {
      async acquireSigningKey() {
        return {
          keyId: 'receipt-key-1',
          async sign() {
            return 'A'.repeat(64);
          },
        };
      },
    }],
  ])('redacts invalid authenticator output and consumes authorities: %s', async (
    _label,
    port,
  ) => {
    const fixture = await createFixture();
    const error = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: port as never,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(String((error as Error).message)).not.toContain('secret');
    await expect(prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
  });

  it.each([
    ['unknown key', () => ({
      keyId: 'receipt-key-1',
      async sign() {
        return '0'.repeat(64);
      },
      secretPath: '/tmp/receipt-key',
    })],
    ['symbol', () => ({
      keyId: 'receipt-key-1',
      async sign() {
        return '0'.repeat(64);
      },
      [Symbol('secret')]: true,
    })],
    ['accessor', () => Object.defineProperty({
      async sign() {
        return '0'.repeat(64);
      },
    }, 'keyId', {
      get() {
        throw new Error('ghp_receipt_lease_secret');
      },
    })],
    ['Proxy', () => new Proxy({
      keyId: 'receipt-key-1',
      async sign() {
        return '0'.repeat(64);
      },
    }, {
      ownKeys() {
        throw new Error('ghp_receipt_lease_secret');
      },
    })],
  ])('rejects strict signing-key lease boundary: %s', async (
    _label,
    createLease,
  ) => {
    const fixture = await createFixture();
    const error = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: {
        async acquireSigningKey() {
          return createLease();
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(String((error as Error).message)).not.toContain(
      'ghp_receipt_lease_secret',
    );
    await expect(prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
  });

  it.each([
    ['function Proxy', new Proxy(async () => '0'.repeat(64), {
      apply() {
        throw new Error('ghp_receipt_auth_proxy_secret');
      },
    })],
    ['captured authentic error', async () => {
      throw new GithubTemplateDownloadReceiptError(
        'BINDING_MISMATCH',
        'ghp_receipt_captured_secret',
      );
    }],
  ])('normalizes signer %s after synchronous authority claim', async (
    _label,
    sign,
  ) => {
    const fixture = await createFixture();
    const error = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: {
        async acquireSigningKey() {
          return { keyId: 'receipt-key-1', sign };
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(String((error as Error).message)).not.toContain('secret');
    await expect(prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
  });

  it('rejects a hostile authenticator object before claiming authorities', async () => {
    const fixture = await createFixture();
    const port = new Proxy({}, {
      ownKeys() {
        throw new Error('ghp_receipt_auth_proxy_secret');
      },
    });
    await expect(prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: port as never,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    })).resolves.toMatchObject({
      receipt: { kind: 'github-template-download-receipt' },
    });
  });

  it('round-trips only the sole canonical UTF-8 representation', async () => {
    const fixture = await createFixture();
    const prepared = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    });
    const parsed = parseGithubTemplateDownloadReceipt(prepared.serialized);
    expect(parsed).toEqual(prepared.receipt);
    expect(Object.isFrozen(parsed.payload.archive.takt)).toBe(true);

    for (const invalid of [
      `${prepared.serialized}\n`,
      `\uFEFF${prepared.serialized}`,
      prepared.serialized.replace(
        '"schemaVersion": "1.0",',
        '"schemaVersion": "1.0",\n  "schemaVersion": "1.0",',
      ),
      Buffer.alloc(MAX_GITHUB_TEMPLATE_DOWNLOAD_RECEIPT_BYTES + 1),
      Buffer.from([0xff]),
    ]) {
      expect(() => parseGithubTemplateDownloadReceipt(invalid))
        .toThrow(expect.objectContaining({ code: 'INVALID_RECEIPT' }));
    }
  });

  it('accepts legacy v1 evidence omission only for zero dependencies', async () => {
    const fixture = await createFixture();
    const prepared = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    });
    const nonzero = JSON.parse(prepared.serialized) as MutableReceipt;
    delete nonzero.payload.source.dependencyVerification;
    expect(() => parseGithubTemplateDownloadReceipt(
      JSON.stringify(nonzero, null, 2),
    )).toThrow(expect.objectContaining({ code: 'INVALID_RECEIPT' }));

    nonzero.payload.source.sourceDescriptor.repertoireDependencies = [];
    nonzero.payload.source.descriptorSha256 =
      calculateProjectTemplateSourceDescriptorSha256(
        nonzero.payload.source.sourceDescriptor as unknown as
          ProjectTemplateSourceDescriptorV1,
      );
    const legacyZero = JSON.stringify(nonzero, null, 2);
    const parsed = parseGithubTemplateDownloadReceipt(legacyZero);
    expect(parsed.payload.source).not.toHaveProperty(
      'dependencyVerification',
    );
    expect(createGithubTemplateDownloadReceiptAuthenticationInput(parsed))
      .toEqual(expect.any(Uint8Array));
  });

  it('rejects accessor, symbol, unknown, and Proxy serializer inputs', async () => {
    const fixture = await createFixture();
    const prepared = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    });
    const candidates: unknown[] = [
      { ...prepared.receipt, unknown: true },
      { ...prepared.receipt, [Symbol('unknown')]: true },
      Object.defineProperty({ ...prepared.receipt }, 'payload', {
        get() {
          throw new Error('ghp_receipt_serializer_secret');
        },
      }),
      new Proxy(prepared.receipt, {
        ownKeys() {
          throw new Error('ghp_receipt_serializer_secret');
        },
      }),
    ];
    for (const candidate of candidates) {
      const error = (() => {
        try {
          serializeGithubTemplateDownloadReceipt(candidate as never);
          return undefined;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ code: 'INVALID_RECEIPT' });
      expect(String((error as Error).message)).not.toContain('secret');
    }
  });

  it.each([
    ['descriptor hash', (receipt: MutableReceipt) => {
      receipt.payload.source.descriptorSha256 = 'f'.repeat(64);
    }],
    ['descriptor archive', (receipt: MutableReceipt) => {
      receipt.payload.source.sourceDescriptor.pack.sha256 = 'f'.repeat(64);
    }],
    ['release asset', (receipt: MutableReceipt) => {
      receipt.payload.release.assetName = 'other.taktpack';
    }],
    ['archive bytes', (receipt: MutableReceipt) => {
      receipt.payload.archive.bytes += 1;
    }],
    ['archive repository', (receipt: MutableReceipt) => {
      receipt.payload.archive.source.uri =
        'https://github.com/acme/other';
    }],
    ['archive ref', (receipt: MutableReceipt) => {
      receipt.payload.archive.source.ref = 'v9.0.0';
    }],
    ['archive commit', (receipt: MutableReceipt) => {
      receipt.payload.archive.source.commit = 'f'.repeat(40);
    }],
    ['takt range', (receipt: MutableReceipt) => {
      receipt.payload.archive.takt.maxVersion = '0.1.0';
    }],
  ])('rejects canonical receipt internal mismatch: %s', async (
    _label,
    mutate,
  ) => {
    const fixture = await createFixture();
    const prepared = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    });
    const receipt = JSON.parse(prepared.serialized) as MutableReceipt;
    mutate(receipt);
    expect(() => parseGithubTemplateDownloadReceipt(
      JSON.stringify(receipt, null, 2),
    )).toThrow(expect.objectContaining({ code: 'INVALID_RECEIPT' }));
  });

  it.each([
    ['release id zero', (receipt: MutableReceipt) => {
      receipt.payload.release.releaseId = 0;
    }],
    ['asset id zero', (receipt: MutableReceipt) => {
      receipt.payload.release.assetId = 0;
    }],
    ['checksum id zero', (receipt: MutableReceipt) => {
      receipt.payload.release.checksumAssetId = 0;
    }],
    ['duplicate asset ids', (receipt: MutableReceipt) => {
      receipt.payload.release.checksumAssetId =
        receipt.payload.release.assetId;
    }],
    ['archive bytes zero', (receipt: MutableReceipt) => {
      receipt.payload.release.assetSize = 0;
      receipt.payload.archive.bytes = 0;
    }],
    ['archive bytes over limit', (receipt: MutableReceipt) => {
      receipt.payload.release.assetSize = 40 * 1024 * 1024 + 1;
      receipt.payload.archive.bytes = 40 * 1024 * 1024 + 1;
    }],
    ['checksum bytes zero', (receipt: MutableReceipt) => {
      receipt.payload.release.checksumAssetSize = 0;
    }],
    ['checksum bytes over limit', (receipt: MutableReceipt) => {
      receipt.payload.release.checksumAssetSize = 4 * 1024 + 1;
    }],
    ['asset name', (receipt: MutableReceipt) => {
      receipt.payload.release.assetName = '../template.taktpack';
    }],
    ['checksum name', (receipt: MutableReceipt) => {
      receipt.payload.release.checksumAssetName = '../checksum';
    }],
    ['requested ref bound', (receipt: MutableReceipt) => {
      receipt.payload.source.requestedRef = 'r'.repeat(513);
    }],
    ['archive semver', (receipt: MutableReceipt) => {
      receipt.payload.archive.version = 'not-semver';
    }],
    ['takt semver', (receipt: MutableReceipt) => {
      receipt.payload.archive.takt.minVersion = 'not-semver';
    }],
  ])('rejects producer invariant independently of HMAC: %s', async (
    _label,
    mutate,
  ) => {
    const fixture = await createFixture();
    const prepared = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    });
    const receipt = JSON.parse(prepared.serialized) as MutableReceipt;
    mutate(receipt);
    expect(() => parseGithubTemplateDownloadReceipt(
      JSON.stringify(receipt, null, 2),
    )).toThrow(expect.objectContaining({ code: 'INVALID_RECEIPT' }));
  });

  it('binds direct release canonical ref and asset name', async () => {
    const fixture = await createFixture({ directSource: true });
    const prepared = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    });
    expect(prepared.receipt.payload.source.requestedRef).toBe('v1.2.3');

    const receipt = JSON.parse(prepared.serialized) as MutableReceipt;
    receipt.payload.source.canonicalSource =
      'https://github.com/acme/template/releases/download/v1.2.3/other.taktpack';
    expect(() => parseGithubTemplateDownloadReceipt(
      JSON.stringify(receipt, null, 2),
    )).toThrow(expect.objectContaining({ code: 'INVALID_RECEIPT' }));
  });

  it('seals the prepared result for one future D2 storage claim', async () => {
    const fixture = await createFixture();
    const prepared = await prepareGithubTemplateDownloadReceipt({
      ...fixture,
      authenticator: authenticator(),
    });
    expect(() => claimPreparedGithubTemplateDownloadReceiptForStorage({
      ...prepared,
    })).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    const claim = claimPreparedGithubTemplateDownloadReceiptForStorage(
      prepared,
    );
    expect(claim.prepared).toBe(prepared);
    expect(() => claimPreparedGithubTemplateDownloadReceiptForStorage(
      prepared,
    )).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => consumePreparedGithubTemplateDownloadReceiptStorageClaim({
      ...claim,
    })).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    consumePreparedGithubTemplateDownloadReceiptStorageClaim(claim);
    expect(() => consumePreparedGithubTemplateDownloadReceiptStorageClaim(
      claim,
    )).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
  });
});
