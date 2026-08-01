import { createHash } from 'node:crypto';
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
import { serializeProjectTemplateSourceDescriptor } from '../../features/project-template/source-descriptor.js';
import type { ProjectTemplateReceiptKeyRegistry, ProjectTemplateReceiptKeyStore } from '../../infra/security/project-template-receipt-key-store.js';
import {
  createProjectTemplateRemoteProductionComposition,
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

async function fixture() {
  const sourceRoot = temp('takt-production-source-');
  const sourcePath = join(sourceRoot, '.takt', 'workflows', 'review.yaml');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, `name: review
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
  const metadata: GithubTemplateSourceMetadataPort = {
    async resolveRefToCommit() { return { commit: COMMIT }; },
    async readFileAtCommit() { return new TextEncoder().encode(descriptor); },
    async getReleaseByTag() {
      return {
        id: 1, tagName: 'v1.2.3', assets: [
          { id: 2, name: 'template.taktpack', size: archive.byteLength },
          { id: 3, name: 'template.taktpack.sha256', size: 90 },
        ],
      };
    },
    async readReleaseAsset() {
      return new TextEncoder().encode(`${sha256}  template.taktpack\n`);
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
    advisory, asset, cacheRoot, projectRoot, resolver, source,
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
    const first = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: { inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; } },
      now: () => 0,
      handleTtlMs: 10,
    });
    const second = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryStore(), resolver: value.resolver, asset: value.asset,
      repertoireInspectionPort: { inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; } },
    });
    await expect(second.preview({
      cacheRoot: value.cacheRoot, receiptKey: 'a'.repeat(64),
      projectRoot: value.projectRoot, currentTaktVersion: '0.48.0', baselineStrategy: 'conflict',
    })).rejects.toMatchObject({ code: 'UNKNOWN_RECEIPT' });
    await first.dispose();
    await second.dispose();
  });
});
