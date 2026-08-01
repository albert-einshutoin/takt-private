import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateExportPlan,
  parseProjectTemplateGithubSourceSpec,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  demoteResolvedGithubTemplateSourceToAdvisory,
  resolveGithubTemplateSource,
  resolveGithubTemplateSourceForAuthenticatedDownload,
  type GithubTemplateSourceMetadataPort,
} from '../../features/project-template/github-update-check.js';
import type { GithubTemplateSourceResolverPort } from '../../features/project-template/github-source-resolver-port.js';
import { deriveGithubTemplateDownloadArtifactPaths } from '../../features/project-template/github-download-receipt-paths.js';
import { serializeProjectTemplateSourceDescriptor } from '../../features/project-template/source-descriptor.js';
import type { ProjectTemplateReceiptKeyRegistry, ProjectTemplateReceiptKeyStore } from '../../infra/security/project-template-receipt-key-store.js';
import {
  createProjectTemplateRemoteProductionComposition,
} from '../../index.js';
import {
  createProjectTemplateRemoteProductionCompositionForTest,
} from '../../infra/github/project-template-remote-production-composition.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const roots: string[] = [];

function temp(prefix: string): string {
  const value = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(value);
  return value;
}

function memoryStore(): ProjectTemplateReceiptKeyStore & { disposed: boolean } {
  let registry: ProjectTemplateReceiptKeyRegistry | undefined;
  let generation: number | undefined;
  let tail = Promise.resolve();
  return {
    disposed: false,
    async read() { return registry === undefined ? undefined : structuredClone(registry); },
    async write(value) {
      registry = structuredClone(value);
      generation = (generation ?? -1) + 1;
    },
    async withExclusiveLease(operation) {
      const run = tail.then(async () => operation({
        snapshot: registry === undefined ? undefined : {
          generation: generation!, registry: structuredClone(registry),
        },
        compareAndSwap: async (expected, next) => {
          if (expected !== generation) return undefined;
          generation = (generation ?? -1) + 1;
          registry = structuredClone(next);
          return { generation, registry: structuredClone(registry) };
        },
      }));
      tail = run.then(() => undefined, () => undefined);
      return await run;
    },
    async dispose() { this.disposed = true; },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: { readonly invalidDoctor?: boolean } = {}) {
  const sourceRoot = temp('takt-production-source-');
  const sourcePath = join(sourceRoot, '.takt', 'workflows', 'review.yaml');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, options.invalidDoctor ? 'name: broken\nsteps: nope\n' : `name: review
initial_step: review
max_steps: 1
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
  const plan = await createProjectTemplateExportPlan(sourceRoot, {
    packVersion: '1.2.3',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'github', uri: 'https://github.com/acme/template', ref: 'v1.2.3', commit: COMMIT,
    },
  });
  const packPath = join(sourceRoot, 'source.taktpack');
  await writeTaktpack(packPath, plan);
  let archive = readFileSync(packPath);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const descriptor = serializeProjectTemplateSourceDescriptor({
    schemaVersion: '1.0',
    pack: {
      version: '1.2.3', releaseTag: 'v1.2.3', assetName: 'template.taktpack',
      checksumAssetName: 'template.taktpack.sha256', sha256,
    },
    repertoireDependencies: [],
  });
  const checksum = `${sha256}  template.taktpack\n`;
  const metadata: GithubTemplateSourceMetadataPort = {
    async resolveRefToCommit() { return { commit: COMMIT }; },
    async readFileAtCommit() { return new TextEncoder().encode(descriptor); },
    async getReleaseByTag() {
      return {
        id: 1, tagName: 'v1.2.3', assets: [
          { id: 2, name: 'template.taktpack', size: archive.byteLength },
          { id: 3, name: 'template.taktpack.sha256', size: checksum.length },
        ],
      };
    },
    async readReleaseAsset() {
      return new TextEncoder().encode(checksum);
    },
  };
  const source = 'github:acme/template@main';
  const advisory = demoteResolvedGithubTemplateSourceToAdvisory(
    await resolveGithubTemplateSource({
      source: parseProjectTemplateGithubSourceSpec(source), metadata,
    }),
  );
  let online = true;
  const resolver: GithubTemplateSourceResolverPort = {
    async resolveAdvisory() { throw new Error('unused'); },
    async resolveForDownload(input) {
      if (!online) throw new Error('network disabled');
      return await resolveGithubTemplateSourceForAuthenticatedDownload({
        source: parseProjectTemplateGithubSourceSpec(input.source), metadata,
      });
    },
  };
  const asset = {
    openReleaseAsset() {
      if (!online) throw new Error('network disabled');
      return (async function* () { yield archive; })();
    },
  };
  const projectRoot = temp('takt-production-target-');
  const cacheRoot = temp('takt-production-cache-');
  chmodSync(cacheRoot, 0o700);
  return {
    advisory, asset, cacheRoot, projectRoot, resolver, sha256, source,
    goOffline() { online = false; archive = Buffer.alloc(0); },
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('project template remote production composition', () => {
  it('keeps all authority private across online download and offline apply', async () => {
    const value = await fixture();
    const store = memoryStore();
    const composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: store,
      resolver: value.resolver,
      asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
    });
    expect(Reflect.ownKeys(composition)).toEqual([
      'download', 'preview', 'approve', 'apply', 'recover', 'dispose',
    ]);
    const downloaded = await composition.download({
      projectRoot: value.projectRoot,
      cacheRoot: value.cacheRoot,
      source: value.source,
      advisory: value.advisory,
    });
    expect(Reflect.ownKeys(downloaded)).toEqual(['receiptKey']);
    const previewed = await composition.preview({
      cacheRoot: value.cacheRoot,
      receiptKey: downloaded.receiptKey,
      projectRoot: value.projectRoot,
      currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    });
    expect(Reflect.ownKeys(previewed)).toEqual(['previewId', 'transactionPlanId']);
    await expect(composition.approve({
      projectRoot: value.projectRoot,
      previewId: previewed.previewId,
      transactionPlanId: previewed.previewId,
      baselineStrategy: 'conflict',
    })).rejects.toMatchObject({ code: 'UNKNOWN_PREVIEW' });
    const approved = await composition.approve({
      projectRoot: value.projectRoot,
      previewId: previewed.previewId,
      transactionPlanId: previewed.transactionPlanId,
      baselineStrategy: 'conflict',
    });
    expect(Reflect.ownKeys(approved)).toEqual(['approvalId']);
    value.goOffline();
    const applied = await composition.apply({
      cacheRoot: value.cacheRoot,
      receiptKey: downloaded.receiptKey,
      previewId: previewed.previewId,
      transactionPlanId: previewed.transactionPlanId,
      approvalId: approved.approvalId,
      projectRoot: value.projectRoot,
      currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    });
    expect(applied).toEqual({
      status: 'committed', transactionPlanId: previewed.transactionPlanId,
    });
    expect(readFileSync(join(value.projectRoot, '.takt', 'workflows', 'review.yaml'), 'utf8'))
      .toContain('name: review');
    await expect(composition.apply({
      cacheRoot: value.cacheRoot,
      receiptKey: downloaded.receiptKey,
      previewId: previewed.previewId,
      transactionPlanId: previewed.transactionPlanId,
      approvalId: approved.approvalId,
      projectRoot: value.projectRoot,
      currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    })).rejects.toMatchObject({ code: 'UNKNOWN_APPROVAL' });
    await composition.dispose();
    expect(store.disposed).toBe(true);
    await expect(composition.preview({
      cacheRoot: value.cacheRoot,
      receiptKey: downloaded.receiptKey,
      projectRoot: value.projectRoot,
      currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    })).rejects.toMatchObject({ code: 'DISPOSED' });
  });

  it('rejects guessed, cloned-to-another-composition, and expired handles', async () => {
    const value = await fixture();
    let now = 0;
    const first = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: { inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; } },
      now: () => now,
      handleTtlMs: 10,
    });
    const second = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: { inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; } },
    });
    const downloaded = await first.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    await expect(second.preview({
      cacheRoot: value.cacheRoot, receiptKey: downloaded.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0', baselineStrategy: 'conflict',
    })).rejects.toMatchObject({ code: 'UNKNOWN_RECEIPT' });
    now = 11;
    await expect(first.preview({
      cacheRoot: value.cacheRoot, receiptKey: downloaded.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0', baselineStrategy: 'conflict',
    })).rejects.toMatchObject({ code: 'UNKNOWN_RECEIPT' });
    await first.dispose();
    await second.dispose();
  });

  it('disposes the receipt runtime when later factory composition fails', async () => {
    const value = await fixture();
    const store = memoryStore();
    await expect(createProjectTemplateRemoteProductionComposition({
      keyStore: store,
      resolver: value.resolver,
      asset: value.asset,
      repertoireInspectionPort: {} as never,
    })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      operatorDetail: 'invalid-argument',
    });
    expect(store.disposed).toBe(true);
  });

  it('keeps factory primary code and public detail fixed when cleanup also fails', async () => {
    const value = await fixture();
    const store = memoryStore();
    store.dispose = async () => {
      throw new Error(`secret cleanup failure at ${value.projectRoot}`);
    };
    let observed: unknown;
    try {
      await createProjectTemplateRemoteProductionComposition({
        keyStore: store,
        resolver: value.resolver,
        asset: value.asset,
        repertoireInspectionPort: {} as never,
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({
      code: 'INVALID_ARGUMENT',
      operatorDetail: 'invalid-argument',
    });
    expect(JSON.stringify(observed)).not.toContain(value.projectRoot);
    expect(Reflect.ownKeys(observed as object)).not.toContain('cause');
  });

  it('blocks new work, aborts and drains in-flight work before runtime disposal', async () => {
    const value = await fixture();
    const store = memoryStore();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowAsset = {
      openReleaseAsset(input: Parameters<typeof value.asset.openReleaseAsset>[0]) {
        const source = value.asset.openReleaseAsset(input);
        return (async function* () {
          entered();
          await gate;
          for await (const chunk of source) yield chunk;
        })();
      },
    };
    const composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: store, resolver: value.resolver, asset: slowAsset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
    });
    const downloading = composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    const downloadFailure = expect(downloading).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
    await enteredPromise;
    const disposing = composition.dispose();
    await expect(composition.recover({ projectRoot: value.projectRoot }))
      .rejects.toMatchObject({ code: 'DISPOSED' });
    release();
    await downloadFailure;
    await disposing;
    expect(store.disposed).toBe(true);
  });

  it.each(['tampered', 'missing'] as const)(
    'fails closed when the sealed artifact is %s',
    async (failureMode) => {
      const value = await fixture();
      const composition = await createProjectTemplateRemoteProductionComposition({
        keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
        repertoireInspectionPort: {
          inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
        },
      });
      const downloaded = await composition.download({
        projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
        source: value.source, advisory: value.advisory,
      });
      const artifactPath = deriveGithubTemplateDownloadArtifactPaths({
        cacheRoot: value.cacheRoot,
        archiveSha256: value.sha256,
      }).artifactPath;
      if (failureMode === 'missing') unlinkSync(artifactPath);
      else writeFileSync(artifactPath, 'tampered');
      await expect(composition.preview({
        cacheRoot: value.cacheRoot, receiptKey: downloaded.receiptKey,
        projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
        baselineStrategy: 'conflict',
      })).rejects.toMatchObject({
        code: 'OPERATION_FAILED',
        operatorDetail: 'operation-failed',
      });
      await composition.dispose();
    },
  );

  it('burns approval, rolls back doctor failure, and allows offline restart recovery', async () => {
    const value = await fixture({ invalidDoctor: true });
    const dependencies = {
      resolver: value.resolver,
      asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
    };
    const composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), ...dependencies,
    });
    const downloaded = await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    const previewed = await composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: downloaded.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    });
    const approved = await composition.approve({
      projectRoot: value.projectRoot, previewId: previewed.previewId,
      transactionPlanId: previewed.transactionPlanId, baselineStrategy: 'conflict',
    });
    const applyInput = {
      cacheRoot: value.cacheRoot, receiptKey: downloaded.receiptKey,
      previewId: previewed.previewId, transactionPlanId: previewed.transactionPlanId,
      approvalId: approved.approvalId, projectRoot: value.projectRoot,
      currentTaktVersion: '0.48.0', baselineStrategy: 'conflict' as const,
    };
    await expect(composition.apply(applyInput)).rejects.toMatchObject({
      code: 'OPERATION_FAILED', operatorDetail: 'operation-failed',
    });
    expect(existsSync(join(value.projectRoot, '.takt', 'workflows', 'review.yaml')))
      .toBe(false);
    await expect(composition.apply(applyInput)).rejects.toMatchObject({
      code: 'UNKNOWN_APPROVAL',
    });
    await composition.dispose();

    const restarted = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), ...dependencies,
    });
    await expect(restarted.recover({ projectRoot: value.projectRoot }))
      .resolves.toEqual({ status: 'none' });
    await restarted.dispose();
  });

  it('sweeps expired receipt, preview, and approval handles before each capacity reservation', async () => {
    const value = await fixture();
    let now = 0;
    const composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
      now: () => now,
      handleTtlMs: 10,
      handleLimit: 1,
    });
    const firstReceipt = await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    const firstPreview = await composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: firstReceipt.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    });
    const firstApproval = await composition.approve({
      projectRoot: value.projectRoot, previewId: firstPreview.previewId,
      transactionPlanId: firstPreview.transactionPlanId, baselineStrategy: 'conflict',
    });
    now = 11;
    const secondReceipt = await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    mkdirSync(join(value.projectRoot, '.takt'), { recursive: true });
    writeFileSync(join(value.projectRoot, '.takt', 'config.yaml'), 'language: ja\n');
    const secondPreview = await composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: secondReceipt.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    });
    expect(secondPreview.previewId).not.toBe(firstPreview.previewId);
    await expect(composition.apply({
      cacheRoot: value.cacheRoot, receiptKey: firstReceipt.receiptKey,
      previewId: firstPreview.previewId,
      transactionPlanId: firstPreview.transactionPlanId,
      approvalId: firstApproval.approvalId,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    })).rejects.toMatchObject({ code: 'UNKNOWN_APPROVAL' });
    await expect(composition.approve({
      projectRoot: value.projectRoot, previewId: firstPreview.previewId,
      transactionPlanId: firstPreview.transactionPlanId, baselineStrategy: 'conflict',
    })).rejects.toMatchObject({ code: 'UNKNOWN_PREVIEW' });
    await expect(composition.approve({
      projectRoot: value.projectRoot, previewId: secondPreview.previewId,
      transactionPlanId: secondPreview.transactionPlanId, baselineStrategy: 'conflict',
    })).resolves.toHaveProperty('approvalId');
    await composition.dispose();
  });

  it('sweeps only expired handles in a mixed expired/live preview set', async () => {
    const value = await fixture();
    let now = 0;
    const composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
      now: () => now,
      handleTtlMs: 10,
      handleLimit: 2,
    });
    const receipt = await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    const expired = await composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0', baselineStrategy: 'conflict',
    });
    now = 5;
    await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    mkdirSync(join(value.projectRoot, '.takt'), { recursive: true });
    writeFileSync(join(value.projectRoot, '.takt', 'config.yaml'), 'language: ja\n');
    const live = await composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
      baselineStrategy: 'adopt-identical',
    });
    now = 11;
    writeFileSync(join(value.projectRoot, '.takt', 'config.yaml'), 'language: en\n');
    const replacement = await composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0', baselineStrategy: 'conflict',
    });
    expect(new Set([expired.previewId, live.previewId, replacement.previewId]).size)
      .toBe(3);
    await expect(composition.approve({
      projectRoot: value.projectRoot, previewId: expired.previewId,
      transactionPlanId: expired.transactionPlanId, baselineStrategy: 'conflict',
    })).rejects.toMatchObject({ code: 'UNKNOWN_PREVIEW' });
    for (const [handle, baselineStrategy] of [
      [live, 'adopt-identical'],
      [replacement, 'conflict'],
    ] as const) {
      await expect(composition.approve({
        projectRoot: value.projectRoot, previewId: handle.previewId,
        transactionPlanId: handle.transactionPlanId, baselineStrategy,
      })).resolves.toHaveProperty('approvalId');
    }
    await composition.dispose();
  });

  it.each([Number.NaN, -1])('fails closed on invalid or rolled-back clock %s', async (badNow) => {
    const value = await fixture();
    let now = 0;
    const composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
      now: () => now,
      handleTtlMs: 10,
      handleLimit: 1,
    });
    await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    now = badNow;
    await expect(composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    })).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    await composition.dispose();
  });

  it('keeps an in-flight reservation while an expired sweep and dispose race', async () => {
    const value = await fixture();
    let now = 0;
    const composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
      now: () => now,
      handleTtlMs: 10,
      handleLimit: 1,
    });
    await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    now = 11;
    const concurrent = await Promise.allSettled([
      composition.download({
        projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
        source: value.source, advisory: value.advisory,
      }),
      composition.download({
        projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
        source: value.source, advisory: value.advisory,
      }),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')[0])
      .toMatchObject({ reason: { code: 'HANDLE_LIMIT_EXCEEDED' } });
    await composition.dispose();
  });

  it('does not publish a reservation when dispose reenters the sweep clock', async () => {
    const value = await fixture();
    let now = 0;
    let triggerDispose = false;
    let disposePromise: Promise<void> | undefined;
    let composition!: Awaited<ReturnType<
      typeof createProjectTemplateRemoteProductionComposition
    >>;
    composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
      now: () => {
        if (triggerDispose && disposePromise === undefined) {
          disposePromise = composition.dispose();
        }
        return now;
      },
      handleTtlMs: 10,
      handleLimit: 1,
    });
    await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    now = 11;
    triggerDispose = true;
    await expect(composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    })).rejects.toMatchObject({ code: 'DISPOSED' });
    await disposePromise;
  });

  it('does not consume a live preview when approval capacity is reserved', async () => {
    const value = await fixture();
    const composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
      handleLimit: 1,
    });
    const receipt = await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    const first = await composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    });
    await composition.approve({
      projectRoot: value.projectRoot, previewId: first.previewId,
      transactionPlanId: first.transactionPlanId, baselineStrategy: 'conflict',
    });
    mkdirSync(join(value.projectRoot, '.takt'), { recursive: true });
    writeFileSync(join(value.projectRoot, '.takt', 'config.yaml'), 'language: ja\n');
    const second = await composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    });
    const approveSecond = () => composition.approve({
      projectRoot: value.projectRoot, previewId: second.previewId,
      transactionPlanId: second.transactionPlanId, baselineStrategy: 'conflict',
    });
    await expect(approveSecond()).rejects.toMatchObject({
      code: 'HANDLE_LIMIT_EXCEEDED',
    });
    await expect(approveSecond()).rejects.toMatchObject({
      code: 'HANDLE_LIMIT_EXCEEDED',
    });
    await composition.dispose();
  });

  it.each(['download', 'preview', 'approve', 'recover'] as const)(
    'rejects a late %s completion after the bounded dispose drain',
    async (blockedOperation) => {
      const value = await fixture();
      const entered = deferred();
      const release = deferred();
      const composition = await createProjectTemplateRemoteProductionCompositionForTest({
        keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
        repertoireInspectionPort: {
          inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
        },
      }, {
        disposeDrainTimeoutMs: 1,
        operationGate: async (operation) => {
          if (operation !== blockedOperation) return;
          entered.resolve();
          await release.promise;
        },
      });
      const receipt = blockedOperation === 'download' ? undefined : await composition.download({
        projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
        source: value.source, advisory: value.advisory,
      });
      const preview = blockedOperation === 'approve' && receipt !== undefined
        ? await composition.preview({
          cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
          projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
          baselineStrategy: 'conflict',
        })
        : undefined;
      const pending = blockedOperation === 'download'
        ? composition.download({
          projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
          source: value.source, advisory: value.advisory,
        })
        : blockedOperation === 'preview'
          ? composition.preview({
            cacheRoot: value.cacheRoot, receiptKey: receipt!.receiptKey,
            projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
            baselineStrategy: 'conflict',
          })
          : blockedOperation === 'approve'
            ? composition.approve({
              projectRoot: value.projectRoot, previewId: preview!.previewId,
              transactionPlanId: preview!.transactionPlanId, baselineStrategy: 'conflict',
            })
            : composition.recover({ projectRoot: value.projectRoot });
      await entered.promise;
      const firstDispose = composition.dispose();
      const secondDispose = composition.dispose();
      expect(secondDispose).toBe(firstDispose);
      await firstDispose;
      release.resolve();
      await expect(pending).rejects.toMatchObject({ code: 'DISPOSED' });
      expect(composition.dispose()).toBe(firstDispose);
    },
  );

  it('uses one admission and one publication clock snapshot per handle operation', async () => {
    const value = await fixture();
    let readings = [0];
    let calls = 0;
    const composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
      now: () => readings[Math.min(calls++, readings.length - 1)]!,
      handleTtlMs: 10,
    });
    const receipt = await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    expect(calls).toBe(2);

    readings = [9];
    calls = 0;
    const preview = await composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    });
    expect(calls).toBe(2);

    readings = [9];
    calls = 0;
    await expect(composition.approve({
      projectRoot: value.projectRoot, previewId: preview.previewId,
      transactionPlanId: preview.transactionPlanId, baselineStrategy: 'conflict',
    })).resolves.toHaveProperty('approvalId');
    expect(calls).toBe(2);
    await composition.dispose();
  });

  it('starts a downloaded handle TTL at publication after an async operation', async () => {
    const value = await fixture();
    let now = 0;
    let armed = true;
    const entered = deferred();
    const release = deferred();
    const composition = await createProjectTemplateRemoteProductionCompositionForTest({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
      now: () => now,
      handleTtlMs: 10,
    }, {
      operationGate: async (operation) => {
        if (!armed || operation !== 'download') return;
        entered.resolve();
        await release.promise;
      },
    });
    const downloading = composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    await entered.promise;
    now = 11;
    armed = false;
    release.resolve();
    const receipt = await downloading;
    await expect(composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    })).resolves.toHaveProperty('previewId');
    await composition.dispose();
  });

  it('returns one stable rejected dispose promise without exposing cleanup details', async () => {
    const value = await fixture();
    const store = memoryStore();
    store.dispose = async () => {
      throw new Error(`secret cleanup failure at ${value.projectRoot}`);
    };
    const composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: store, resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
    });
    const first = composition.dispose();
    expect(composition.dispose()).toBe(first);
    const firstError = await first.catch((error: unknown) => error);
    const secondError = await composition.dispose().catch((error: unknown) => error);
    expect(secondError).toBe(firstError);
    expect(firstError).toMatchObject({
      code: 'OPERATION_FAILED', operatorDetail: 'operation-failed',
    });
    expect(JSON.stringify(firstError)).not.toContain(value.projectRoot);
  });

  it('keeps dispose pending once a non-cancellable apply mutation starts', async () => {
    const value = await fixture();
    const entered = deferred();
    const release = deferred();
    const composition = await createProjectTemplateRemoteProductionCompositionForTest({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
    }, {
      disposeDrainTimeoutMs: 1,
      mutationGate: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const receipt = await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    const preview = await composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    });
    const approval = await composition.approve({
      projectRoot: value.projectRoot, previewId: preview.previewId,
      transactionPlanId: preview.transactionPlanId, baselineStrategy: 'conflict',
    });
    const applying = composition.apply({
      cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
      previewId: preview.previewId, transactionPlanId: preview.transactionPlanId,
      approvalId: approval.approvalId, projectRoot: value.projectRoot,
      currentTaktVersion: '0.48.0', baselineStrategy: 'conflict',
    });
    await entered.promise;
    const disposing = composition.dispose();
    expect(composition.dispose()).toBe(disposing);
    let disposeSettled = false;
    void disposing.finally(() => { disposeSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(disposeSettled).toBe(false);
    release.resolve();
    await expect(applying).resolves.toMatchObject({ status: 'committed' });
    await expect(disposing).resolves.toBeUndefined();
  });

  it('keeps dispose pending once non-cancellable recovery is admitted', async () => {
    const value = await fixture();
    const entered = deferred();
    const release = deferred();
    const composition = await createProjectTemplateRemoteProductionCompositionForTest({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
    }, {
      disposeDrainTimeoutMs: 1,
      mutationGate: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const recovering = composition.recover({ projectRoot: value.projectRoot });
    await entered.promise;
    const disposing = composition.dispose();
    let disposeSettled = false;
    void disposing.finally(() => { disposeSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(disposeSettled).toBe(false);
    release.resolve();
    await expect(recovering).resolves.toEqual({ status: 'none' });
    await expect(disposing).resolves.toBeUndefined();
  });

  it('drains rollback failure before reporting disposal cleanup separately', async () => {
    const value = await fixture({ invalidDoctor: true });
    const store = memoryStore();
    store.dispose = async () => { throw new Error(`cleanup ${value.projectRoot}`); };
    const entered = deferred();
    const release = deferred();
    const composition = await createProjectTemplateRemoteProductionCompositionForTest({
      keyStore: store, resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
    }, {
      disposeDrainTimeoutMs: 1,
      mutationGate: async () => { entered.resolve(); await release.promise; },
    });
    const receipt = await composition.download({
      projectRoot: value.projectRoot, cacheRoot: value.cacheRoot,
      source: value.source, advisory: value.advisory,
    });
    const preview = await composition.preview({
      cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
    });
    const approval = await composition.approve({
      projectRoot: value.projectRoot, previewId: preview.previewId,
      transactionPlanId: preview.transactionPlanId, baselineStrategy: 'conflict',
    });
    const applying = composition.apply({
      cacheRoot: value.cacheRoot, receiptKey: receipt.receiptKey,
      previewId: preview.previewId, transactionPlanId: preview.transactionPlanId,
      approvalId: approval.approvalId, projectRoot: value.projectRoot,
      currentTaktVersion: '0.48.0', baselineStrategy: 'conflict',
    });
    await entered.promise;
    const disposing = composition.dispose();
    release.resolve();
    const applyFailure = await applying.catch((error: unknown) => error);
    expect(applyFailure).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(existsSync(join(value.projectRoot, '.takt', 'workflows', 'review.yaml')))
      .toBe(false);
    const disposeFailure = await disposing.catch((error: unknown) => error);
    expect(disposeFailure).not.toBe(applyFailure);
    expect(disposeFailure).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(JSON.stringify(applyFailure)).not.toContain(value.projectRoot);
  });
});
