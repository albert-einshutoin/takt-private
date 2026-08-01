import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
  prepareProjectTemplateApplyPlan,
  captureProjectTemplateTargetSnapshot,
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
import { serializeTemplateLock } from '../../features/project-template/lock.js';
import {
  PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
  serializeProjectTemplateRepertoireDependencyLock,
} from '../../features/project-template/repertoire-dependency-lock.js';
import {
  PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
  serializeProjectTemplateSourceProvenance,
} from '../../features/project-template/source-provenance.js';
import {
  calculateProjectTemplateRepertoireDependencyDeclarationSha256,
} from '../../features/project-template/repertoire-dependency-canonical.js';
import {
  initializeProjectTemplateApplyStorage,
} from '../../features/project-template/apply-storage.js';
import {
  readGithubProjectTemplateRemoteTransactionSummary,
} from '../../features/project-template/remote-transaction-derivation.js';
import {
  writeProjectTemplateMergeBaseline,
} from '../../features/project-template/merge-baseline-store.js';

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

async function fixture(
  sourceInput = 'github:acme/template@main',
  template = {
    path: 'workflows/review.yaml',
    content: 'name: review\n',
  },
) {
  const sourceRoot = temp('takt-remote-source-');
  const sourcePath = join(sourceRoot, '.takt', template.path);
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, template.content);
  const exportPlan = await createProjectTemplateExportPlan(sourceRoot, {
    packVersion: '1.2.3',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'github',
      uri: 'https://github.com/acme/template',
      ref: 'v1.2.3',
      commit: COMMIT,
    },
    policies: { [template.path]: 'merge' },
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
    source: parseProjectTemplateGithubSourceSpec(sourceInput),
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
    exportPlan,
    template,
  };
}

async function installSemanticUpdateState(
  value: Awaited<ReturnType<typeof fixture>>,
  base: string,
  local: string,
): Promise<void> {
  const baseSha256 = createHash('sha256').update(base).digest('hex');
  const previousManifestSha256 = 'c'.repeat(64);
  mkdirSync(join(value.projectRoot, '.takt'), { recursive: true });
  writeFileSync(join(value.projectRoot, '.takt', 'config.yaml'), local);
  writeFileSync(join(value.projectRoot, '.takt-template-lock.json'), serializeTemplateLock({
    schemaVersion: '1.0',
    manifestSha256: previousManifestSha256,
    packVersion: '1.1.0',
    source: {
      kind: 'github',
      uri: 'https://github.com/acme/template',
      ref: 'v1.1.0',
      commit: COMMIT,
    },
    capabilities: [],
    entries: [{
      path: 'config.yaml',
      policy: 'merge',
      mode: '0644',
      sha256: baseSha256,
      capabilities: [],
    }],
  }));
  writeFileSync(
    join(value.projectRoot, PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH),
    serializeProjectTemplateRepertoireDependencyLock({
      schemaVersion: '1.0',
      sourceDescriptorSha256: 'a'.repeat(64),
      manifestSha256: previousManifestSha256,
      dependencies: [],
    }),
  );
  writeFileSync(
    join(value.projectRoot, PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH),
    serializeProjectTemplateSourceProvenance({
      schemaVersion: '1.0',
      source: {
        owner: 'acme',
        repo: 'template',
        repositoryUrl: 'https://github.com/acme/template',
        canonicalSource: 'github:acme/template@main',
        requestedRef: 'main',
        releaseTag: 'v1.1.0',
        commit: COMMIT,
        descriptorSha256: 'a'.repeat(64),
      },
      archive: {
        sha256: 'b'.repeat(64),
        version: '1.1.0',
        manifestSha256: previousManifestSha256,
      },
      dependencyVerification: {
        method: 'github-ref-to-commit-v1',
        declarationSha256:
          calculateProjectTemplateRepertoireDependencyDeclarationSha256([]),
        count: 0,
      },
    }),
  );
  const storage = await initializeProjectTemplateApplyStorage({
    repoPath: value.projectRoot,
  });
  await writeProjectTemplateMergeBaseline({
    storage,
    expectedSha256: baseSha256,
    content: Buffer.from(base),
  });
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
    const summary = readGithubProjectTemplateRemoteTransactionSummary(preview);
    expect(summary).toEqual({
      changeCount: 1,
      conflictCount: 0,
      dependencyCount: 0,
      reviewRequired: true,
      hardConflict: false,
      defaultApplyPossible: false,
    });
    expect(Reflect.ownKeys(summary!)).not.toContain('candidatePaths');
    expect(readGithubProjectTemplateRemoteTransactionSummary({ ...preview }))
      .toBeUndefined();
    expect(closed).toContain('artifact');
    expect(closed).toContain('receipt');
    expect(closed.filter((kind) => kind === 'directory').length).toBeGreaterThan(0);
    expect(renderProjectTemplateApplyPreviewJson(preview))
      .not.toContain(value.prepared.receiptKey);
  });

  it('creates provenance for a canonical direct HTTPS release asset', async () => {
    const value = await fixture(
      'https://github.com/acme/template/releases/download/v1.2.3/template.taktpack',
    );
    await expect(createGithubProjectTemplateRemotePreview(facadeOptions(value)))
      .resolves.toMatchObject({ schemaVersion: '1.0', hardConflict: false });
  });

  it('uses the owned formal baseline for a semantic three-way update preview', async () => {
    const base = 'provider_routing:\n  personas:\n    planner: codex\n';
    const local = 'provider_routing:\n  personas:\n    planner: claude\n';
    const incoming = `${base}timezone: Asia/Tokyo\n`;
    const value = await fixture('github:acme/template@main', {
      path: 'config.yaml',
      content: incoming,
    });
    await installSemanticUpdateState(value, base, local);

    const preview = await createGithubProjectTemplateRemotePreview(
      facadeOptions(value),
    );
    expect(preview.hardConflict).toBe(false);

    const target = await captureProjectTemplateTargetSnapshot(
      value.projectRoot,
      ['config.yaml'],
    );
    const expected = prepareProjectTemplateApplyPlan({
      baseLock: JSON.parse(readFileSync(
        join(value.projectRoot, '.takt-template-lock.json'),
        'utf8',
      )),
      baseContents: [{ path: 'config.yaml', content: Buffer.from(base) }],
      incomingManifest: value.exportPlan.manifest,
      incomingContents: [{ path: 'config.yaml', content: Buffer.from(incoming) }],
      localEntries: target.entries,
      targetRootState: target.rootState,
      missingPathTracking: target.missingPathTracking,
      incomingInspection: {
        archiveSha256: value.prepared.receipt.payload.archive.sha256,
        manifestSha256: value.prepared.receipt.payload.archive.manifestSha256,
        currentTaktVersion: '0.48.0',
        compatibilityStatus: 'compatible',
      },
      baselineStrategy: 'adopt-identical',
    });
    expect(preview.bindings.contentPlanId).toBe(expected.plan.planId);
  });

  it.each(['missing', 'tampered'] as const)(
    'reports BASE_UNAVAILABLE without repairing a %s formal baseline',
    async (state) => {
      const base = 'provider_routing:\n  personas:\n    planner: codex\n';
      const local = 'provider_routing:\n  personas:\n    planner: claude\n';
      const incoming = `${base}timezone: Asia/Tokyo\n`;
      const value = await fixture('github:acme/template@main', {
        path: 'config.yaml',
        content: incoming,
      });
      await installSemanticUpdateState(value, base, local);
      const baseSha256 = createHash('sha256').update(base).digest('hex');
      const baselinePath = join(
        value.projectRoot,
        '.takt-template-state',
        'merge-baselines',
        baseSha256,
      );
      if (state === 'missing') rmSync(baselinePath);
      else writeFileSync(baselinePath, 'private tampered baseline');

      const before = state === 'missing'
        ? 'absent'
        : readFileSync(baselinePath, 'utf8');
      const preview = await createGithubProjectTemplateRemotePreview(
        facadeOptions(value),
      );
      expect(preview.hardConflict).toBe(true);
      expect(preview.contentHardConflicts).toContainEqual({
        code: 'CONTENT_ENTRY_CONFLICT',
        path: 'config.yaml',
        reasonCode: 'BASE_UNAVAILABLE',
      });
      expect(state === 'missing'
        ? (existsSync(baselinePath) ? 'present' : 'absent')
        : readFileSync(baselinePath, 'utf8')).toBe(before);
    },
  );

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
    const monotonicStart = performance.now();
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
    expect(observedDeadline!).toBeGreaterThanOrEqual(monotonicStart + 4_500);
    expect(observedDeadline!).toBeLessThanOrEqual(performance.now() + 5_000);

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
