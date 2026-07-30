import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateExportPlan,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  claimStoredGithubTemplateDownloadReceiptForOfflineRead,
  consumeStoredGithubTemplateDownloadReceiptOfflineReadClaim,
  githubTemplateReceiptDirectoryDurability,
  GithubTemplateDownloadReceiptStorageError,
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
import { parseProjectTemplateGithubSourceSpec } from '../../features/project-template/github-source-spec.js';
import {
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
const SECRET = 'receipt-storage-secret';
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
  const projectRoot = makeRoot('takt-receipt-store-project-');
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
  const cacheRoot = makeRoot('takt-receipt-store-cache-');
  chmodSync(cacheRoot, 0o700);
  const canonicalCacheRoot = realpathSync.native(cacheRoot);
  const materialized = await materializeGithubTemplateCache({
    staged,
    cacheRoot: canonicalCacheRoot,
  });
  const prepared = await prepareGithubTemplateDownloadReceipt({
    resolved,
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
  };
}

describe('GitHub template authenticated receipt durable store D2a', () => {
  it('stores a canonical authenticated receipt with derived private paths', async () => {
    const fixture = await createFixture();
    const stored = await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });

    expect(stored).toEqual({
      receiptKey: fixture.prepared.receiptKey,
      artifactSha256: fixture.materialized.sha256,
      bytes: Buffer.byteLength(fixture.prepared.serialized, 'utf8'),
      status: 'stored',
      directoryDurability:
        githubTemplateReceiptDirectoryDurability(),
    });
    expect(Object.isFrozen(stored)).toBe(true);
    expect(stored).not.toHaveProperty('path');
    expect(readFileSync(fixture.receiptPath, 'utf8'))
      .toBe(fixture.prepared.serialized);
    expect(statSync(fixture.receiptPath).mode & 0o777).toBe(0o600);
    for (let path = dirname(fixture.receiptPath);
      path !== fixture.cacheRoot;
      path = dirname(path)) {
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
  });

  it('reports Windows directory fsync as explicitly unsupported', () => {
    expect(githubTemplateReceiptDirectoryDurability('win32'))
      .toBe('unsupported');
    expect(githubTemplateReceiptDirectoryDurability('darwin')).toBe('synced');
    expect(githubTemplateReceiptDirectoryDurability('linux')).toBe('synced');
  });

  it('seals the stored result for one future D2b offline-read claim', async () => {
    const fixture = await createFixture();
    const stored = await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    });
    expect(() => claimStoredGithubTemplateDownloadReceiptForOfflineRead({
      ...stored,
    })).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    const claim = claimStoredGithubTemplateDownloadReceiptForOfflineRead(
      stored,
    );
    expect(claim.stored).toBe(stored);
    expect(() => claimStoredGithubTemplateDownloadReceiptForOfflineRead(
      stored,
    )).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    expect(() => consumeStoredGithubTemplateDownloadReceiptOfflineReadClaim({
      ...claim,
    })).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    consumeStoredGithubTemplateDownloadReceiptOfflineReadClaim(claim);
    expect(() => consumeStoredGithubTemplateDownloadReceiptOfflineReadClaim(
      claim,
    )).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
  });

  it('rejects clone, reuse, and parallel use before verifier progress', async () => {
    const cloneFixture = await createFixture();
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: { ...cloneFixture.prepared },
      cacheRoot: cloneFixture.cacheRoot,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });

    const fixture = await createFixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: {
        async verify(request) {
          await blocked;
          return verifier().verify(request);
        },
      },
    });
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
    release();
    await expect(first).resolves.toMatchObject({ status: 'stored' });
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
  });

  it('rejects unknown options before claiming the prepared authority', async () => {
    const fixture = await createFixture();
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      receiptPath: '/tmp/caller-controlled.json',
    } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    })).resolves.toMatchObject({ status: 'stored' });
  });

  it('binds the verifier receiver and passes a frozen canonical request', async () => {
    const fixture = await createFixture();
    let receiverWasPort = false;
    let requestWasFrozen = false;
    const port: GithubTemplateDownloadReceiptVerifier = {
      async verify(this: unknown, request) {
        receiverWasPort = this === port;
        requestWasFrozen = Object.isFrozen(request);
        return verifier().verify(request);
      },
    };
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: port,
    });
    expect(receiverWasPort).toBe(true);
    expect(requestWasFrozen).toBe(true);
  });

  it('rejects hostile verifier ports before claiming authority', async () => {
    const fixture = await createFixture();
    const candidates: unknown[] = [
      { ...verifier(), unknown: true },
      Object.defineProperty({}, 'verify', {
        get() {
          throw new Error('ghp_receipt_verifier_port_secret');
        },
      }),
      new Proxy({}, {
        ownKeys() {
          throw new Error('ghp_receipt_verifier_port_secret');
        },
      }),
    ];
    for (const candidate of candidates) {
      const error = await storeGithubTemplateDownloadReceipt({
        prepared: fixture.prepared,
        cacheRoot: fixture.cacheRoot,
        verifier: candidate as never,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(String((error as Error).message)).not.toContain('secret');
    }
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    })).resolves.toMatchObject({ status: 'stored' });
  });

  it.each(['invalid', 'unavailable'] as const)(
    'fails closed when verifier reports %s and consumes authority',
    async (state) => {
      const fixture = await createFixture();
      await expect(storeGithubTemplateDownloadReceipt({
        prepared: fixture.prepared,
        cacheRoot: fixture.cacheRoot,
        verifier: verifier(state),
      })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
      expect(existsSync(fixture.receiptPath)).toBe(false);
      await expect(storeGithubTemplateDownloadReceipt({
        prepared: fixture.prepared,
        cacheRoot: fixture.cacheRoot,
        verifier: verifier(),
      })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
    },
  );

  it.each([
    ['throw', {
      async verify() {
        throw new Error('ghp_receipt_verifier_secret');
      },
    }],
    ['invalid union', {
      async verify() {
        return 'maybe';
      },
    }],
    ['function Proxy', {
      verify: new Proxy(async () => 'valid', {
        apply() {
          throw new Error('ghp_receipt_verifier_secret');
        },
      }),
    }],
    ['captured authentic error', {
      async verify() {
        throw new GithubTemplateDownloadReceiptStorageError(
          'CACHE_INVALID',
          'ghp_receipt_verifier_secret',
        );
      },
    }],
  ])('redacts hostile verifier result: %s', async (_label, port) => {
    const fixture = await createFixture();
    const error = await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: port as never,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it('supports bounded partial writes and reuses only an identical winner', async () => {
    const first = await createFixture();
    const firstStored = await storeGithubTemplateDownloadReceipt({
      prepared: first.prepared,
      cacheRoot: first.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        write(fd, buffer, offset, length, position) {
          const partial = Math.min(7, length);
          return writeSync(fd, buffer, offset, partial, position);
        },
      },
    });
    expect(firstStored.status).toBe('stored');

    const second = await createFixture();
    mkdirSync(dirname(second.receiptPath), { recursive: true, mode: 0o700 });
    writeFileSync(second.receiptPath, second.prepared.serialized, {
      mode: 0o600,
    });
    const existing = await storeGithubTemplateDownloadReceipt({
      prepared: second.prepared,
      cacheRoot: second.cacheRoot,
      verifier: verifier(),
    });
    expect(existing.status).toBe('existing');
    expect(readFileSync(second.receiptPath, 'utf8'))
      .toBe(second.prepared.serialized);
  });

  it('preserves and rejects an invalid existing winner', async () => {
    const fixture = await createFixture();
    mkdirSync(dirname(fixture.receiptPath), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(fixture.receiptPath, '{}', { mode: 0o600 });
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' });
    expect(readFileSync(fixture.receiptPath, 'utf8')).toBe('{}');
  });

  it('rejects multiply-linked artifact and winner files', async () => {
    const artifactFixture = await createFixture();
    linkSync(
      artifactFixture.materialized.cachePath,
      `${artifactFixture.materialized.cachePath}.alias`,
    );
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: artifactFixture.prepared,
      cacheRoot: artifactFixture.cacheRoot,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });

    const winnerFixture = await createFixture();
    mkdirSync(dirname(winnerFixture.receiptPath), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      winnerFixture.receiptPath,
      winnerFixture.prepared.serialized,
      { mode: 0o600 },
    );
    linkSync(
      winnerFixture.receiptPath,
      `${winnerFixture.receiptPath}.alias`,
    );
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: winnerFixture.prepared,
      cacheRoot: winnerFixture.cacheRoot,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' });
  });

  it('accepts bounded partial reads without trusting reported total size', async () => {
    const fixture = await createFixture();
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        read(fd, buffer, offset, length, position) {
          return readSync(
            fd,
            buffer,
            offset,
            Math.min(11, length),
            position,
          );
        },
      },
    })).resolves.toMatchObject({ status: 'stored' });
  });

  it('fails closed if the retained artifact inode mutates before success', async () => {
    const fixture = await createFixture();
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        onPhase(phase) {
          if (phase !== 'before-artifact-success-verify') return;
          const corrupted = Buffer.from(fixture.content);
          corrupted[0] = corrupted[0]! ^ 0xff;
          writeFileSync(fixture.materialized.cachePath, corrupted);
        },
      },
    })).rejects.toMatchObject({
      code: 'CACHE_INVALID',
      receiptState: 'receipt-published',
    });
  });

  it('rejects artifact path replacement while retaining the opened FD', async () => {
    const fixture = await createFixture();
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        onPhase(phase) {
          if (phase !== 'before-artifact-final-verify') return;
          renameSync(
            fixture.materialized.cachePath,
            `${fixture.materialized.cachePath}.replaced`,
          );
          writeFileSync(
            fixture.materialized.cachePath,
            fixture.content,
            { mode: 0o600 },
          );
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
  });

  it('rejects receipt parent directory replacement before publication', async () => {
    const fixture = await createFixture();
    let replaced = false;
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        onPhase(phase, path) {
          if (phase !== 'before-receipt-link' || replaced) return;
          replaced = true;
          const parent = dirname(path);
          renameSync(parent, `${parent}.replaced`);
          mkdirSync(parent, { mode: 0o700 });
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
  });

  it('rejects an identical final path replacement after publication', async () => {
    const fixture = await createFixture();
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        onPhase(phase, path) {
          if (phase !== 'before-receipt-final-verify') return;
          renameSync(path, `${path}.replaced`);
          writeFileSync(path, fixture.prepared.serialized, { mode: 0o600 });
        },
      },
    })).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' });
  });

  it('retains but rejects a winner when its key becomes unavailable', async () => {
    const fixture = await createFixture();
    let verification = 0;
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: {
        async verify(request) {
          verification += 1;
          if (verification === 3) return 'unavailable';
          return verifier().verify(request);
        },
      },
    })).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' });
    expect(readFileSync(fixture.receiptPath, 'utf8'))
      .toBe(fixture.prepared.serialized);
  });

  it.each(['final-unlink', 'ancestor-swap'] as const)(
    'rejects %s at the final joint success boundary',
    async (mutation) => {
      const fixture = await createFixture();
      await expect(storeGithubTemplateDownloadReceipt({
        prepared: fixture.prepared,
        cacheRoot: fixture.cacheRoot,
        verifier: verifier(),
        ioSeam: {
          onPhase(phase) {
            if (phase !== 'before-artifact-success-verify') return;
            if (mutation === 'final-unlink') {
              unlinkSync(fixture.receiptPath);
              return;
            }
            const receipts = join(fixture.cacheRoot, 'receipts');
            renameSync(receipts, `${receipts}.replaced`);
            mkdirSync(receipts, { mode: 0o700 });
          },
        },
      })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
    },
  );

  it('revalidates after close hooks mutate a successful final', async () => {
    const fixture = await createFixture();
    let mutated = false;
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        close(_fd, kind) {
          if (kind !== 'final' || mutated) return;
          mutated = true;
          unlinkSync(fixture.receiptPath);
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
  });

  it('fsyncs an identical EEXIST winner file and retained parent', async () => {
    const fixture = await createFixture();
    mkdirSync(dirname(fixture.receiptPath), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      fixture.receiptPath,
      fixture.prepared.serialized,
      { mode: 0o600 },
    );
    const fsyncKinds: Array<'file' | 'directory'> = [];
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        fsync(fd, kind) {
          fsyncKinds.push(kind);
          if (
            kind === 'file'
            && fsyncKinds.filter((value) => value === 'file').length === 2
          ) {
            // Same-size truncate is non-mutating but requires a writable FD.
            ftruncateSync(fd, fstatSync(fd).size);
          }
          // Exercise the real syscall while observing its type.
          if (process.platform !== 'win32' || kind === 'file') fsyncSync(fd);
        },
      },
    });
    expect(fsyncKinds.filter((kind) => kind === 'file')).toHaveLength(2);
    expect(fsyncKinds).toContain('directory');
  });

  it('reuses the fsynced writable temporary authority for a new link', async () => {
    const fixture = await createFixture();
    let fileSyncs = 0;
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        fsync(fd, kind) {
          if (kind === 'file') fileSyncs += 1;
          fsyncSync(fd);
        },
      },
    });
    expect(fileSyncs).toBe(1);
  });

  it('uses only native reads after the final verifier callback', async () => {
    const fixture = await createFixture();
    let verifications = 0;
    let callerReadsAfterFinalVerifier = 0;
    await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: {
        async verify(request) {
          verifications += 1;
          return verifier().verify(request);
        },
      },
      ioSeam: {
        read(fd, buffer, offset, length, position) {
          if (verifications >= 4) callerReadsAfterFinalVerifier += 1;
          return readSync(fd, buffer, offset, length, position);
        },
      },
    });
    expect(verifications).toBe(4);
    expect(callerReadsAfterFinalVerifier).toBe(0);
  });

  it.each(['artifact', 'receipt'] as const)(
    'detects %s path replacement from the pre-final read callback',
    async (target) => {
      const fixture = await createFixture();
      let armed = false;
      let firstReadFd: number | undefined;
      let mutated = false;
      await expect(storeGithubTemplateDownloadReceipt({
        prepared: fixture.prepared,
        cacheRoot: fixture.cacheRoot,
        verifier: verifier(),
        ioSeam: {
          close() {
            armed = true;
          },
          read(fd, buffer, offset, length, position) {
            if (armed && !mutated) {
              firstReadFd ??= fd;
              if (target === 'artifact' || fd !== firstReadFd) {
                mutated = true;
                const path = target === 'artifact'
                  ? fixture.materialized.cachePath
                  : fixture.receiptPath;
                const content = target === 'artifact'
                  ? fixture.content
                  : fixture.prepared.serialized;
                renameSync(path, `${path}.read-callback`);
                writeFileSync(path, content, { mode: 0o600 });
              }
            }
            return readSync(fd, buffer, offset, length, position);
          },
        },
      })).rejects.toMatchObject({
        code: 'CACHE_INVALID',
        receiptState: 'receipt-published',
      });
      expect(mutated).toBe(true);
    },
  );

  it.each(['artifact', 'receipt'] as const)(
    'rejects %s replacement after the final verifier callback',
    async (target) => {
      const fixture = await createFixture();
      let verifications = 0;
      await expect(storeGithubTemplateDownloadReceipt({
        prepared: fixture.prepared,
        cacheRoot: fixture.cacheRoot,
        verifier: {
          async verify(request) {
            verifications += 1;
            if (verifications === 4) {
              const path = target === 'artifact'
                ? fixture.materialized.cachePath
                : fixture.receiptPath;
              const content = target === 'artifact'
                ? fixture.content
                : fixture.prepared.serialized;
              renameSync(path, `${path}.last-seam`);
              writeFileSync(path, content, { mode: 0o600 });
            }
            return verifier().verify(request);
          },
        },
      })).rejects.toMatchObject({
        code: 'CACHE_INVALID',
        receiptState: 'receipt-published',
      });
    },
  );

  it('preserves the primary failure when a close hook also fails', async () => {
    const fixture = await createFixture();
    const error = await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        onPhase(phase) {
          if (phase !== 'before-artifact-final-verify') return;
          const corrupted = Buffer.from(fixture.content);
          corrupted[0] = corrupted[0]! ^ 0xff;
          writeFileSync(fixture.materialized.cachePath, corrupted);
        },
        close() {
          throw new Error('secondary close failure');
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'CACHE_INVALID',
      receiptState: 'temporary-only',
    });
  });

  it('rejects EEXIST parent replacement after before-final phase', async () => {
    const fixture = await createFixture();
    mkdirSync(dirname(fixture.receiptPath), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      fixture.receiptPath,
      fixture.prepared.serialized,
      { mode: 0o600 },
    );
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        onPhase(phase, path) {
          if (phase !== 'before-receipt-final-verify') return;
          const parent = dirname(path);
          renameSync(parent, `${parent}.replaced`);
          mkdirSync(parent, { mode: 0o700 });
          writeFileSync(path, fixture.prepared.serialized, { mode: 0o600 });
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
  });

  it.each([
    ['none', 'initial-auth'],
    ['temporary-only', 'temp-fsync'],
    ['receipt-present', 'publish-fsync'],
    ['receipt-published', 'temp-unlink'],
    ['receipt-published', 'close'],
  ] as const)('reports receiptState %s after %s failure', async (
    receiptState,
    failurePoint,
  ) => {
    const fixture = await createFixture();
    const error = await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: failurePoint === 'initial-auth'
        ? verifier('unavailable')
        : verifier(),
      ioSeam: failurePoint === 'initial-auth'
        ? undefined
        : {
          onPhase(phase) {
            if (
              (failurePoint === 'temp-fsync'
                && phase === 'before-receipt-temp-fsync')
              || (failurePoint === 'publish-fsync'
                && phase === 'before-receipt-publish-fsync')
              || (failurePoint === 'temp-unlink'
                && phase === 'before-receipt-temp-unlink')
            ) throw new Error('fault');
          },
          close(_fd, kind) {
            if (failurePoint === 'close' && kind === 'artifact') {
              throw new Error('fault');
            }
          },
        },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ receiptState });
  });

  it('fsyncs retained parents even when receipt directories already exist', async () => {
    const fixture = await createFixture();
    mkdirSync(dirname(fixture.receiptPath), {
      recursive: true,
      mode: 0o700,
    });
    const error = await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam: {
        fsync(_fd, kind) {
          if (kind === 'directory') throw new Error('repair failed');
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'IO_FAILURE',
      receiptState: 'none',
    });
  });

  it.each([
    ['fsync', {
      fsync() {
        throw new Error('ghp_receipt_io_secret');
      },
    }],
    ['zero write progress', {
      write() {
        return 0;
      },
    }],
    ['link', {
      link() {
        throw new Error('ghp_receipt_io_secret');
      },
    }],
    ['forged EEXIST', {
      link() {
        const error = new Error('ghp_receipt_io_secret') as
          NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      },
    }],
    ['unlink', {
      unlink() {
        throw new Error('ghp_receipt_io_secret');
      },
    }],
    ['close', {
      close(_fd: number, kind: string) {
        if (kind === 'artifact') {
          throw new Error('ghp_receipt_io_secret');
        }
      },
    }],
  ])('redacts %s seam failure and consumes authority', async (
    _label,
    ioSeam,
  ) => {
    const fixture = await createFixture();
    const error = await storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
      ioSeam,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'IO_FAILURE' });
    expect(String((error as Error).message)).not.toContain('secret');
    await expect(storeGithubTemplateDownloadReceipt({
      prepared: fixture.prepared,
      cacheRoot: fixture.cacheRoot,
      verifier: verifier(),
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
  });
});
