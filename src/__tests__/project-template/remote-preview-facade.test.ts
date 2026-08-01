import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGithubProjectTemplateRemotePreview,
  createProjectTemplateExportPlan,
  renderProjectTemplateApplyPreviewJson,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  storeGithubTemplateDownloadReceipt,
  type GithubTemplateDownloadReceiptVerifier,
} from '../../features/project-template/github-download-receipt-storage.js';
import { prepareGithubTemplateDownloadReceipt } from '../../features/project-template/github-download-receipt.js';
import {
  materializeGithubTemplateCache,
  stageGithubTemplateDownload,
} from '../../features/project-template/github-download-storage.js';
import { parseProjectTemplateGithubSourceSpec } from '../../features/project-template/github-source-spec.js';
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
const SECRET = 'remote-preview-test-key';
const roots: string[] = [];

function temp(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function* chunks(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

function verifier(): GithubTemplateDownloadReceiptVerifier {
  return {
    async verify({ input, tag }) {
      return createHmac('sha256', SECRET).update(input).digest('hex') === tag
        ? 'valid'
        : 'invalid';
    },
  };
}

async function fixture() {
  const sourceRoot = temp('takt-remote-source-');
  const sourcePath = join(sourceRoot, '.takt', 'workflows', 'review.yaml');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, 'name: review\n');
  const exportPlan = await createProjectTemplateExportPlan(sourceRoot, {
    packVersion: '1.2.3',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'github',
      uri: 'https://github.com/acme/template',
      ref: 'v1.2.3',
      commit: COMMIT,
    },
  });
  const packPath = join(sourceRoot, 'source.taktpack');
  await writeTaktpack(packPath, exportPlan);
  const archive = readFileSync(packPath);
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const descriptor: ProjectTemplateSourceDescriptorV1 = {
    schemaVersion: '1.0',
    pack: {
      version: '1.2.3',
      releaseTag: 'v1.2.3',
      assetName: 'template.taktpack',
      checksumAssetName: 'template.taktpack.sha256',
      sha256: archiveSha256,
    },
    repertoireDependencies: [],
  };
  const checksum = `${archiveSha256}  template.taktpack\n`;
  const metadata: GithubTemplateSourceMetadataPort = {
    async resolveRefToCommit() { return { commit: COMMIT }; },
    async readFileAtCommit() {
      return new TextEncoder().encode(
        serializeProjectTemplateSourceDescriptor(descriptor),
      );
    },
    async getReleaseByTag() {
      return {
        id: 1,
        tagName: 'v1.2.3',
        assets: [
          { id: 2, name: 'template.taktpack', size: archive.byteLength },
          { id: 3, name: 'template.taktpack.sha256', size: checksum.length },
        ],
      };
    },
    async readReleaseAsset() {
      return new TextEncoder().encode(checksum);
    },
  };
  const resolved = await resolveGithubTemplateSource({
    source: parseProjectTemplateGithubSourceSpec('github:acme/template@main'),
    metadata,
  });
  mkdirSync(join(sourceRoot, '.takt-template-state'), { mode: 0o700 });
  const staged = await stageGithubTemplateDownload({
    projectRoot: sourceRoot,
    expectedBytes: archive.byteLength,
    expectedSha256: archiveSha256,
    chunks: chunks(archive),
  });
  const rawCacheRoot = temp('takt-remote-cache-');
  chmodSync(rawCacheRoot, 0o700);
  const cacheRoot = realpathSync.native(rawCacheRoot);
  const materialized = await materializeGithubTemplateCache({
    staged,
    cacheRoot,
  });
  const prepared = await prepareGithubTemplateDownloadReceipt({
    downloadClaim: claimResolvedGithubTemplateSourceForDownload(resolved),
    materialized,
    authenticator: {
      async acquireSigningKey() {
        return {
          keyId: 'remote-preview-key',
          async sign(input: Uint8Array) {
            return createHmac('sha256', SECRET).update(input).digest('hex');
          },
        };
      },
    },
  });
  await storeGithubTemplateDownloadReceipt({
    prepared,
    cacheRoot,
    verifier: verifier(),
  });
  const projectRoot = temp('takt-remote-target-');
  return {
    cacheRoot,
    prepared,
    projectRoot,
    artifactPath: materialized.cachePath,
    archive,
  };
}

function facadeOptions(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    cacheRoot: value.cacheRoot,
    receiptKey: value.prepared.receiptKey,
    verifier: verifier(),
    projectRoot: value.projectRoot,
    currentTaktVersion: '0.48.0',
    repertoireInspectionPort: {
      inspect: () => ({ witnessSha256: 'e'.repeat(64), observations: [] }),
    },
    baselineStrategy: 'adopt-identical' as const,
  };
}

describe('GitHub project template remote preview production facade', () => {
  it('creates an offline first-install preview and retires every receipt FD/claim', async () => {
    const value = await fixture();
    const closed: string[] = [];
    const preview = await createGithubProjectTemplateRemotePreview({
      ...facadeOptions(value),
      receiptIo: {
        close(_fd, kind) { closed.push(kind); },
      },
    });

    expect(preview.transactionPlanId).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.reviewRequired).toBe(true);
    expect(preview.hardConflict).toBe(false);
    expect(closed).toContain('artifact');
    expect(closed).toContain('receipt');
    expect(closed.filter((kind) => kind === 'directory').length).toBeGreaterThan(0);
    expect(renderProjectTemplateApplyPreviewJson(preview))
      .not.toContain(value.prepared.receiptKey);
  });

  it('retires receipt authority before a downstream repertoire failure', async () => {
    const value = await fixture();
    const closed: string[] = [];
    const secret = 'private-inspection-secret';
    await expect(createGithubProjectTemplateRemotePreview({
      ...facadeOptions(value),
      repertoireInspectionPort: { inspect: () => { throw new Error(secret); } },
      receiptIo: { close(_fd, kind) { closed.push(kind); } },
    })).rejects.not.toThrow(secret);
    expect(closed).toContain('artifact');
    expect(closed).toContain('receipt');

    // A new preview must perform a fresh authenticated read; no prior claim is
    // reusable after the downstream failure.
    await expect(createGithubProjectTemplateRemotePreview(facadeOptions(value)))
      .resolves.toMatchObject({ schemaVersion: '1.0' });
  });

  it('fails closed on cache drift and a preview never preserves cache authority', async () => {
    const value = await fixture();
    const preview = await createGithubProjectTemplateRemotePreview(
      facadeOptions(value),
    );
    writeFileSync(value.artifactPath, Buffer.from('tampered'), { mode: 0o600 });

    expect(() => renderProjectTemplateApplyPreviewJson(preview)).not.toThrow();
    await expect(createGithubProjectTemplateRemotePreview(facadeOptions(value)))
      .rejects.toMatchObject({ code: 'CACHE_INVALID' });
  });

  it('consumes a claim when abort or second-pass materialization fails', async () => {
    const aborted = await fixture();
    const controller = new AbortController();
    await expect(createGithubProjectTemplateRemotePreview({
      ...facadeOptions(aborted),
      signal: controller.signal,
      receiptIo: {
        close(_fd, kind) {
          if (kind === 'artifact') controller.abort();
        },
      },
    })).rejects.toThrow(/aborted/);
    await expect(createGithubProjectTemplateRemotePreview(facadeOptions(aborted)))
      .resolves.toMatchObject({ schemaVersion: '1.0' });

    const drift = await fixture();
    let changed = false;
    await expect(createGithubProjectTemplateRemotePreview({
      ...facadeOptions(drift),
      receiptIo: {
        close(_fd, kind) {
          if (!changed && kind === 'artifact') {
            changed = true;
            writeFileSync(drift.artifactPath, Buffer.from('changed'), {
              mode: 0o600,
            });
          }
        },
      },
    })).rejects.toThrow();
    writeFileSync(drift.artifactPath, drift.archive, { mode: 0o600 });
    await expect(createGithubProjectTemplateRemotePreview(facadeOptions(drift)))
      .resolves.toMatchObject({ schemaVersion: '1.0' });
  });

  it('propagates one signal and absolute deadline and rejects a late inspection abort', async () => {
    const value = await fixture();
    const controller = new AbortController();
    let observedDeadline: number | undefined;
    await expect(createGithubProjectTemplateRemotePreview({
      ...facadeOptions(value),
      signal: controller.signal,
      dependencyInspectionTimeoutMs: 5_000,
      repertoireInspectionPort: {
        inspect(request) {
          expect(request.signal).toBe(controller.signal);
          observedDeadline = request.deadlineMs;
          controller.abort('private abort reason');
          return { witnessSha256: 'e'.repeat(64), observations: [] };
        },
      },
    })).rejects.toMatchObject({
      code: 'ABORTED',
      message: 'GitHub project template remote preview was aborted',
    });
    expect(observedDeadline).toBeTypeOf('number');

    await expect(createGithubProjectTemplateRemotePreview(facadeOptions(value)))
      .resolves.toMatchObject({ schemaVersion: '1.0' });
  });

  it('rejects Proxy options without executing traps', async () => {
    const value = await fixture();
    const options = facadeOptions(value);
    let traps = 0;
    const proxy = new Proxy(options, {
      getPrototypeOf() { traps += 1; return Object.prototype; },
      ownKeys() { traps += 1; return Reflect.ownKeys(options); },
      getOwnPropertyDescriptor(_target, key) {
        traps += 1;
        return Reflect.getOwnPropertyDescriptor(options, key);
      },
    });
    await expect(createGithubProjectTemplateRemotePreview(proxy))
      .rejects.toThrow(/options/);
    expect(traps).toBe(0);
  });
});
