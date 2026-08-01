import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
  claimVerifiedGithubTemplateDownloadReceiptForApply,
  consumeVerifiedGithubTemplateDownloadReceiptApplyClaim,
  readGithubTemplateDownloadReceiptByReceiptKey,
  readGithubTemplateDownloadReceiptStored,
} from '../../features/project-template/github-download-receipt-offline-read.js';
import {
  storeGithubTemplateDownloadReceipt,
  type GithubTemplateDownloadReceiptVerifier,
} from '../../features/project-template/github-download-receipt-storage.js';
import {
  prepareGithubTemplateDownloadReceipt,
} from '../../features/project-template/github-download-receipt.js';
import {
  materializeGithubTemplateCache,
  stageGithubTemplateDownload,
} from '../../features/project-template/github-download-storage.js';
import {
  parseProjectTemplateGithubSourceSpec,
} from '../../features/project-template/github-source-spec.js';
import {
  claimResolvedGithubTemplateSourceForDownload,
  resolveGithubTemplateSource,
  type GithubTemplateSourceMetadataPort,
} from '../../features/project-template/github-update-check.js';
import {
  serializeProjectTemplateSourceDescriptor,
  type ProjectTemplateSourceDescriptorV1,
} from '../../features/project-template/source-descriptor.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ASSET_NAME = 'template.taktpack';
const CHECKSUM_NAME = `${ASSET_NAME}.sha256`;
const SECRET = 'receipt-offline-read-secret';
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

function verifier(
  result: 'valid' | 'invalid' | 'unavailable' = 'valid',
): GithubTemplateDownloadReceiptVerifier {
  return {
    async verify({ input, tag }) {
      if (result !== 'valid') return result;
      return createHmac('sha256', SECRET).update(input).digest('hex') === tag
        ? 'valid'
        : 'invalid';
    },
  };
}

async function createFixture() {
  const projectRoot = makeRoot('takt-receipt-offline-project-');
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
    repertoireDependencies: [],
  };
  const checksum = `${archiveSha}  ${ASSET_NAME}\n`;
  const metadata: GithubTemplateSourceMetadataPort = {
    async resolveRefToCommit() {
      return { commit: COMMIT };
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
          { id: 201, name: ASSET_NAME, size: content.byteLength },
          { id: 202, name: CHECKSUM_NAME, size: checksum.length },
        ],
      };
    },
    async readReleaseAsset() {
      return new TextEncoder().encode(checksum);
    },
  };
  const resolved = await resolveGithubTemplateSource({
    source: parseProjectTemplateGithubSourceSpec(
      'github:acme/template@main',
    ),
    metadata,
  });
  mkdirSync(join(projectRoot, '.takt-template-state'), { mode: 0o700 });
  const staged = await stageGithubTemplateDownload({
    projectRoot,
    expectedBytes: content.byteLength,
    expectedSha256: archiveSha,
    chunks: chunks(content),
  });
  const cacheRoot = makeRoot('takt-receipt-offline-cache-');
  chmodSync(cacheRoot, 0o700);
  const canonicalCacheRoot = realpathSync.native(cacheRoot);
  const materialized = await materializeGithubTemplateCache({
    staged,
    cacheRoot: canonicalCacheRoot,
  });
  const prepared = await prepareGithubTemplateDownloadReceipt({
    downloadClaim:
      claimResolvedGithubTemplateSourceForDownload(resolved),
    materialized,
    authenticator: {
      async acquireSigningKey() {
        return {
          keyId: 'receipt-key-1',
          async sign(input: Uint8Array) {
            return createHmac('sha256', SECRET)
              .update(input)
              .digest('hex');
          },
        };
      },
    },
  });
  const receiptPath = join(
    canonicalCacheRoot,
    'receipts',
    'v1',
    'sha256',
    prepared.receiptKey.slice(0, 2),
    `${prepared.receiptKey}.json`,
  );
  return {
    cacheRoot: canonicalCacheRoot,
    content,
    materialized,
    prepared,
    receiptPath,
    artifactPath: materialized.cachePath,
  };
}

describe('GitHub template authenticated receipt offline reader D2b', () => {
  it('never short-circuits native close after synchronous seal failure', () => {
    const source = readFileSync(join(
      process.cwd(),
      'src',
      'features',
      'project-template',
      'github-download-receipt-offline-read.ts',
    ), 'utf8');
    expect(source).not.toContain(
      'return failure ?? closeDescriptors(context);',
    );
    expect(source).toContain(
      'const closeFailure = closeDescriptors(context);',
    );
  });

  it.each([
    ['cross-process', readGithubTemplateDownloadReceiptByReceiptKey],
    ['same-process', readGithubTemplateDownloadReceiptStored],
  ])('rejects non-record and unknown options: %s', async (_label, read) => {
    await expect(read(undefined as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(read({ unknown: true } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it.each([
    ['cross-process', readGithubTemplateDownloadReceiptByReceiptKey, {
      cacheRoot: '/private/cache',
      receiptKey: 'a'.repeat(64),
      verifier: { async verify() { return 'valid' as const; } },
    }],
    ['same-process', readGithubTemplateDownloadReceiptStored, {
      cacheRoot: '/private/cache',
      stored: {},
      verifier: { async verify() { return 'valid' as const; } },
    }],
  ])('rejects transparent Proxy options before traps: %s', async (
    _label,
    read,
    value,
  ) => {
    let trapCalls = 0;
    const proxy = new Proxy(value, {
      getPrototypeOf() {
        trapCalls += 1;
        return Object.prototype;
      },
      ownKeys() {
        trapCalls += 1;
        return Reflect.ownKeys(value);
      },
      getOwnPropertyDescriptor(_target, key) {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(value, key);
      },
    });
    await expect(read(proxy as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(trapCalls).toBe(0);
  });

  it('reopens and verifies a receipt by key without a network port', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });

    const verified = await readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
    });

    expect(verified).toMatchObject({
      receiptKey: fixture.prepared.receiptKey,
      artifactSha256: fixture.materialized.sha256,
      bytes: Buffer.byteLength(fixture.prepared.serialized, 'utf8'),
      receipt: fixture.prepared.receipt,
      inspection: {
        archiveSha256: fixture.materialized.sha256,
        manifestSha256: fixture.prepared.receipt.payload.archive.manifestSha256,
      },
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.inspection)).toBe(true);
    expect(Object.isFrozen(verified.inspection.manifest)).toBe(true);
    expect(verified).not.toHaveProperty('path');
    expect(verified).not.toHaveProperty('cacheRoot');

    expect(() => claimVerifiedGithubTemplateDownloadReceiptForApply({
      ...verified,
    })).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    const claim = claimVerifiedGithubTemplateDownloadReceiptForApply(verified);
    expect(claim.verified).toBe(verified);
    expect(() => claimVerifiedGithubTemplateDownloadReceiptForApply(verified))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    consumeVerifiedGithubTemplateDownloadReceiptApplyClaim(claim);
    expect(() => consumeVerifiedGithubTemplateDownloadReceiptApplyClaim(claim))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
  });

  it('consumes a genuine stored handoff and matches all disk evidence', async () => {
    const fixture = await createFixture();
    const stored = await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    const verified = await readGithubTemplateDownloadReceiptStored({
      cacheRoot: fixture.cacheRoot,
      stored,
      verifier: verifier(),
    });
    expect(verified).toMatchObject({
      receiptKey: stored.receiptKey,
      artifactSha256: stored.artifactSha256,
      bytes: stored.bytes,
    });
    await expect(readGithubTemplateDownloadReceiptStored({
      cacheRoot: fixture.cacheRoot,
      stored,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
    await expect(readGithubTemplateDownloadReceiptStored({
      cacheRoot: fixture.cacheRoot,
      stored: { ...stored },
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
  });

  it('validates all stored options before claiming the one-shot handoff', async () => {
    const fixture = await createFixture();
    const stored = await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    await expect(readGithubTemplateDownloadReceiptStored({
      cacheRoot: 'relative-cache',
      stored,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(readGithubTemplateDownloadReceiptStored({
      cacheRoot: fixture.cacheRoot,
      stored,
      verifier: verifier(),
      unknown: true,
    } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(readGithubTemplateDownloadReceiptStored({
      cacheRoot: fixture.cacheRoot,
      stored,
      verifier: verifier(),
    })).resolves.toMatchObject({ receiptKey: stored.receiptKey });
  });

  it('consumes stored authority on authentication and IO failure paths', async () => {
    const authFixture = await createFixture();
    const authStored = await storeGithubTemplateDownloadReceipt({
      prepared: authFixture.prepared,
      cacheRoot: authFixture.cacheRoot,
      verifier: verifier(),
    });
    await expect(readGithubTemplateDownloadReceiptStored({
      cacheRoot: authFixture.cacheRoot,
      stored: authStored,
      verifier: verifier('invalid'),
    })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    await expect(readGithubTemplateDownloadReceiptStored({
      cacheRoot: authFixture.cacheRoot,
      stored: authStored,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });

    const ioFixture = await createFixture();
    const ioStored = await storeGithubTemplateDownloadReceipt({
      prepared: ioFixture.prepared,
      cacheRoot: ioFixture.cacheRoot,
      verifier: verifier(),
    });
    await expect(readGithubTemplateDownloadReceiptStored({
      cacheRoot: ioFixture.cacheRoot,
      stored: ioStored,
      verifier: verifier(),
      io: {
        read() {
          return 0;
        },
      },
    })).rejects.toMatchObject({ code: 'IO_FAILURE' });
    await expect(readGithubTemplateDownloadReceiptStored({
      cacheRoot: ioFixture.cacheRoot,
      stored: ioStored,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
  });

  it('supports bounded partial reads and attempts every close hook', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    const closed: Array<'artifact' | 'receipt' | 'directory'> = [];
    await readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
      io: {
        read(fd, buffer, offset, length, position) {
          return readSync(
            fd,
            buffer,
            offset,
            Math.min(length, 7),
            position,
          );
        },
        close(_fd, kind) {
          closed.push(kind);
        },
      },
    });
    expect(closed).toEqual([
      'artifact',
      'receipt',
      'directory',
      'directory',
      'directory',
      'directory',
      'directory',
      'directory',
    ]);
  });

  it('does not derive or open the artifact before receipt HMAC succeeds', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    const phases: string[] = [];
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier('invalid'),
      io: {
        onPhase(phase) {
          phases.push(phase);
        },
      },
    })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(phases).not.toContain('before-artifact-open');
    expect(phases).not.toContain('before-artifact-inspect');
  });

  it('rejects artifact mutation and redacts verifier and hook failures', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    const mutated = Buffer.from(fixture.content);
    mutated[0] = mutated[0]! ^ 0xff;
    writeFileSync(fixture.artifactPath, mutated);
    const error = await readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'CACHE_INVALID' });
    expect(String((error as Error).message)).not.toContain('secret');

    const hookFixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: hookFixture.prepared,
      cacheRoot: hookFixture.cacheRoot,
      verifier: verifier(),
    });
    const hookError = await readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: hookFixture.cacheRoot,
      receiptKey: hookFixture.prepared.receiptKey,
      verifier: {
        async verify() {
          throw new Error('ghp_offline_verifier_secret');
        },
      },
    }).catch((caught: unknown) => caught);
    expect(hookError).toMatchObject({ code: 'KEY_UNAVAILABLE' });
    expect(String((hookError as Error).message)).not.toContain('secret');
  });

  it.each([
    ['invalid', 'AUTHENTICATION_FAILED'],
    ['unavailable', 'KEY_UNAVAILABLE'],
  ] as const)('maps verifier %s without exposing its result', async (
    state,
    code,
  ) => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(state),
    })).rejects.toMatchObject({ code });
  });

  it('maps missing receipt/cache and receipt/limit failures precisely', async () => {
    const missingRoot = makeRoot('takt-receipt-offline-missing-root-');
    rmSync(missingRoot, { recursive: true });
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: missingRoot,
      receiptKey: 'a'.repeat(64),
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'CACHE_MISSING' });

    const receiptFixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: receiptFixture.prepared,
      cacheRoot: receiptFixture.cacheRoot,
      verifier: verifier(),
    });
    unlinkSync(receiptFixture.receiptPath);
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: receiptFixture.cacheRoot,
      receiptKey: receiptFixture.prepared.receiptKey,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'RECEIPT_MISSING' });

    const invalidFixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: invalidFixture.prepared,
      cacheRoot: invalidFixture.cacheRoot,
      verifier: verifier(),
    });
    const invalidReceipt = Buffer.from(invalidFixture.prepared.serialized);
    invalidReceipt[0] = 0x5b;
    writeFileSync(invalidFixture.receiptPath, invalidReceipt);
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: invalidFixture.cacheRoot,
      receiptKey: invalidFixture.prepared.receiptKey,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'RECEIPT_INVALID' });

    const limitFixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: limitFixture.prepared,
      cacheRoot: limitFixture.cacheRoot,
      verifier: verifier(),
    });
    writeFileSync(limitFixture.receiptPath, Buffer.alloc(256 * 1024 + 1));
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: limitFixture.cacheRoot,
      receiptKey: limitFixture.prepared.receiptKey,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });

    const artifactFixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: artifactFixture.prepared,
      cacheRoot: artifactFixture.cacheRoot,
      verifier: verifier(),
    });
    unlinkSync(artifactFixture.artifactPath);
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: artifactFixture.cacheRoot,
      receiptKey: artifactFixture.prepared.receiptKey,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'CACHE_MISSING' });
  });

  it('rejects accessors, symbols, and hostile nested ports before use', async () => {
    let trapCalls = 0;
    const verifierProxy = new Proxy({
      async verify() {
        return 'valid' as const;
      },
    }, {
      getPrototypeOf() {
        trapCalls += 1;
        return Object.prototype;
      },
      ownKeys(target) {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: '/private/cache',
      receiptKey: 'a'.repeat(64),
      verifier: verifierProxy,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(trapCalls).toBe(0);

    const accessor = Object.defineProperty({
      cacheRoot: '/private/cache',
      receiptKey: 'a'.repeat(64),
      verifier: verifier(),
    }, 'io', {
      get() {
        throw new Error('ghp_offline_options_secret');
      },
    });
    const accessorError = await readGithubTemplateDownloadReceiptByReceiptKey(
      accessor as never,
    ).catch((caught: unknown) => caught);
    expect(accessorError).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String((accessorError as Error).message)).not.toContain('secret');

    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: '/private/cache',
      receiptKey: 'a'.repeat(64),
      verifier: verifier(),
      [Symbol('network')]: {},
    } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('claims a stored handoff before verifier progress to stop concurrency', async () => {
    const fixture = await createFixture();
    const stored = await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = readGithubTemplateDownloadReceiptStored({
      cacheRoot: fixture.cacheRoot,
      stored,
      verifier: {
        async verify(request) {
          await blocked;
          return verifier().verify(request);
        },
      },
    });
    await expect(readGithubTemplateDownloadReceiptStored({
      cacheRoot: fixture.cacheRoot,
      stored,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
    release();
    await expect(first).resolves.toMatchObject({
      receiptKey: stored.receiptKey,
    });
  });

  it('runs every close hook and preserves the earlier primary failure', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    let closeCalls = 0;
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier('invalid'),
      io: {
        close() {
          closeCalls += 1;
          throw new Error('ghp_offline_close_secret');
        },
      },
    })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    // Receipt authentication fails before artifact authority exists.
    expect(closeCalls).toBe(6);
  });

  it('rejects an artifact swap queued by the final verifier microtask', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    let verifyCalls = 0;
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: {
        async verify(request) {
          verifyCalls += 1;
          const result = await verifier().verify(request);
          if (verifyCalls === 2) {
            queueMicrotask(() => {
              const mutated = Buffer.from(fixture.content);
              mutated[0] = mutated[0]! ^ 0xff;
              writeFileSync(fixture.artifactPath, mutated);
            });
          }
          return result;
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
    expect(verifyCalls).toBe(2);
  });

  it('rejects a read seam that lies about the declared EOF', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
      io: {
        read(fd, buffer, offset, length, position) {
          if (length === 1 && position === fixture.prepared.serialized.length) {
            return 1;
          }
          return readSync(fd, buffer, offset, length, position);
        },
      },
    })).rejects.toMatchObject({ code: 'IO_FAILURE' });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['over-report', 2],
  ])('rejects %s progress from the read seam', async (_label, reported) => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
      io: {
        read(_fd, _buffer, _offset, length) {
          return reported === 2 ? length + 1 : reported;
        },
      },
    })).rejects.toMatchObject({ code: 'IO_FAILURE' });
  });

  it('bounds each artifact hashing read to a fixed-size buffer', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    let maximumRequested = 0;
    await readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
      io: {
        read(fd, buffer, offset, length, position) {
          maximumRequested = Math.max(maximumRequested, length);
          return readSync(fd, buffer, offset, length, position);
        },
      },
    });
    expect(maximumRequested).toBeLessThanOrEqual(64 * 1024);
  });

  it.each([
    'receipt',
    'artifact',
  ] as const)('rejects a same-content %s path replacement', async (kind) => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    let replaced = false;
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
      io: {
        onPhase(phase) {
          if (phase !== 'before-final-preflight' || replaced) return;
          replaced = true;
          const path = kind === 'receipt'
            ? fixture.receiptPath
            : fixture.artifactPath;
          const replacement = `${path}.replacement`;
          writeFileSync(
            replacement,
            kind === 'receipt'
              ? fixture.prepared.serialized
              : fixture.content,
            { mode: 0o600 },
          );
          renameSync(replacement, path);
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
  });

  it.each([0, 1, 2, 3])(
    'rejects receipt ancestor %s replacement after opening',
    async (ancestorIndex) => {
      const fixture = await createFixture();
      await storeGithubTemplateDownloadReceipt({
        prepared: fixture.prepared,
        cacheRoot: fixture.cacheRoot,
        verifier: verifier(),
      });
      const ancestors = [
        join(fixture.cacheRoot, 'receipts'),
        join(fixture.cacheRoot, 'receipts', 'v1'),
        join(fixture.cacheRoot, 'receipts', 'v1', 'sha256'),
        dirname(fixture.receiptPath),
      ];
      let replaced = false;
      await expect(readGithubTemplateDownloadReceiptByReceiptKey({
        cacheRoot: fixture.cacheRoot,
        receiptKey: fixture.prepared.receiptKey,
        verifier: verifier(),
        io: {
          onPhase(phase) {
            if (phase !== 'before-final-preflight' || replaced) return;
            replaced = true;
            renameSync(
              ancestors[ancestorIndex]!,
              `${ancestors[ancestorIndex]!}.replacement`,
            );
            mkdirSync(dirname(fixture.receiptPath), {
              recursive: true,
              mode: 0o700,
            });
            writeFileSync(
              fixture.receiptPath,
              fixture.prepared.serialized,
              { mode: 0o600 },
            );
          },
        },
      })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
    },
  );

  it.each([
    ['receipt mode', (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      chmodSync(fixture.receiptPath, 0o644);
    }],
    ['artifact mode', (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      chmodSync(fixture.artifactPath, 0o644);
    }],
    ['ancestor mode', (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      chmodSync(dirname(fixture.receiptPath), 0o755);
    }],
    ['receipt nlink', (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      linkSync(fixture.receiptPath, `${fixture.receiptPath}.hardlink`);
    }],
    ['receipt symlink', (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      const original = `${fixture.receiptPath}.original`;
      renameSync(fixture.receiptPath, original);
      symlinkSync(original, fixture.receiptPath);
    }],
  ] as const)('rejects unsafe private cache metadata: %s', async (
    _label,
    mutate,
  ) => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    mutate(fixture);
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
  });

  it('rejects invalid verifier union values and thrown verifier details', async () => {
    const invalidFixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: invalidFixture.prepared,
      cacheRoot: invalidFixture.cacheRoot,
      verifier: verifier(),
    });
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: invalidFixture.cacheRoot,
      receiptKey: invalidFixture.prepared.receiptKey,
      verifier: {
        async verify() {
          return 'unexpected' as never;
        },
      },
    })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });

    const thrownFixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: thrownFixture.prepared,
      cacheRoot: thrownFixture.cacheRoot,
      verifier: verifier(),
    });
    const error = await readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: thrownFixture.cacheRoot,
      receiptKey: thrownFixture.prepared.receiptKey,
      verifier: {
        async verify() {
          throw new Error('ghp_offline_key_provider_secret');
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'KEY_UNAVAILABLE' });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it('rejects receipt mutation queued by the final verifier microtask', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    let verifyCalls = 0;
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: {
        async verify(request) {
          verifyCalls += 1;
          const result = await verifier().verify(request);
          if (verifyCalls === 2) {
            queueMicrotask(() => {
              const mutated = Buffer.from(fixture.prepared.serialized);
              mutated[mutated.byteLength - 2] =
                mutated[mutated.byteLength - 2]! ^ 1;
              writeFileSync(fixture.receiptPath, mutated);
            });
          }
          return result;
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
    expect(verifyCalls).toBe(2);
  });

  it('attempts native closure after close-hook failures', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    const descriptors: number[] = [];
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
      io: {
        close(fd) {
          descriptors.push(fd);
          throw new Error('ghp_offline_close_secret');
        },
      },
    })).rejects.toMatchObject({ code: 'IO_FAILURE' });
    expect(descriptors).toHaveLength(8);
    for (const fd of descriptors) {
      expect(() => fstatSync(fd)).toThrow();
    }
  });

  it('does not trust JSON or Proxy clones as apply handoffs', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    const verified = await readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
    });
    const jsonClone = JSON.parse(JSON.stringify(verified)) as unknown;
    expect(() => claimVerifiedGithubTemplateDownloadReceiptForApply(jsonClone))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => claimVerifiedGithubTemplateDownloadReceiptForApply(
      new Proxy(verified, {}),
    )).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    const claim = claimVerifiedGithubTemplateDownloadReceiptForApply(verified);
    expect(() => claimVerifiedGithubTemplateDownloadReceiptForApply(verified))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    consumeVerifiedGithubTemplateDownloadReceiptApplyClaim(claim);
  });

  it('consumes stored authority for every post-claim failure family', async () => {
    const cases = [
      {
        code: 'KEY_UNAVAILABLE',
        mutate() {},
        verifier: verifier('unavailable'),
      },
      {
        code: 'RECEIPT_MISSING',
        mutate(fixture: Awaited<ReturnType<typeof createFixture>>) {
          unlinkSync(fixture.receiptPath);
        },
        verifier: verifier(),
      },
      {
        code: 'RECEIPT_INVALID',
        mutate(fixture: Awaited<ReturnType<typeof createFixture>>) {
          const bytes = Buffer.from(fixture.prepared.serialized);
          bytes[0] = 0x5b;
          writeFileSync(fixture.receiptPath, bytes);
        },
        verifier: verifier(),
      },
      {
        code: 'CACHE_MISSING',
        mutate(fixture: Awaited<ReturnType<typeof createFixture>>) {
          unlinkSync(fixture.artifactPath);
        },
        verifier: verifier(),
      },
      {
        code: 'CACHE_INVALID',
        mutate(fixture: Awaited<ReturnType<typeof createFixture>>) {
          const bytes = Buffer.from(fixture.content);
          bytes[0] = bytes[0]! ^ 0xff;
          writeFileSync(fixture.artifactPath, bytes);
        },
        verifier: verifier(),
      },
      {
        code: 'LIMIT_EXCEEDED',
        mutate(fixture: Awaited<ReturnType<typeof createFixture>>) {
          writeFileSync(fixture.receiptPath, Buffer.alloc(256 * 1024 + 1));
        },
        verifier: verifier(),
      },
    ] as const;
    for (const testCase of cases) {
      const fixture = await createFixture();
      const stored = await storeGithubTemplateDownloadReceipt({
        prepared: fixture.prepared,
        cacheRoot: fixture.cacheRoot,
        verifier: verifier(),
      });
      testCase.mutate(fixture);
      await expect(readGithubTemplateDownloadReceiptStored({
        cacheRoot: fixture.cacheRoot,
        stored,
        verifier: testCase.verifier,
      })).rejects.toMatchObject({ code: testCase.code });
      await expect(readGithubTemplateDownloadReceiptStored({
        cacheRoot: fixture.cacheRoot,
        stored,
        verifier: verifier(),
      })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
    }
  });

  it.each([
    'cache-root',
    'artifact-directory',
  ] as const)('rejects %s replacement after opening', async (kind) => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    let replaced = false;
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
      io: {
        onPhase(phase) {
          if (phase !== 'before-final-preflight' || replaced) return;
          replaced = true;
          const path = kind === 'cache-root'
            ? fixture.cacheRoot
            : dirname(fixture.artifactPath);
          const replacement = `${path}.replacement`;
          renameSync(path, replacement);
          roots.push(replacement);
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
  });

  it('rejects an ancestor swap queued by the final verifier microtask', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    let verifyCalls = 0;
    await expect(readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: {
        async verify(request) {
          verifyCalls += 1;
          const result = await verifier().verify(request);
          if (verifyCalls === 2) {
            queueMicrotask(() => {
              const shard = dirname(fixture.receiptPath);
              renameSync(shard, `${shard}.replacement`);
            });
          }
          return result;
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
  });

  it('closes every retained descriptor after a final-preflight path swap', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    const descriptors: number[] = [];
    const error = await readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
      io: {
        onPhase(phase) {
          if (phase === 'before-final-preflight') {
            const shard = dirname(fixture.receiptPath);
            renameSync(shard, `${shard}.replacement`);
          }
        },
        close(fd) {
          descriptors.push(fd);
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'CACHE_INVALID' });
    expect(descriptors).toHaveLength(8);
    for (const fd of descriptors) {
      expect(() => fstatSync(fd)).toThrow();
    }
  });

  it('preserves cache failure when close hooks also fail and still closes all FDs', async () => {
    const fixture = await createFixture();
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    const mutated = Buffer.from(fixture.content);
    mutated[0] = mutated[0]! ^ 0xff;
    writeFileSync(fixture.artifactPath, mutated);
    const descriptors: number[] = [];
    const error = await readGithubTemplateDownloadReceiptByReceiptKey({
      cacheRoot: fixture.cacheRoot,
      receiptKey: fixture.prepared.receiptKey,
      verifier: verifier(),
      io: {
        close(fd) {
          descriptors.push(fd);
          throw new Error('ghp_offline_close_secret');
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'CACHE_INVALID' });
    expect(String((error as Error).message)).not.toContain('secret');
    expect(descriptors).toHaveLength(8);
    for (const fd of descriptors) {
      expect(() => fstatSync(fd)).toThrow();
    }
  });

});
