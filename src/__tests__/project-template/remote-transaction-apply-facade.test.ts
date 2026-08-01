import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGithubProjectTemplateRemoteTransaction,
  createGithubProjectTemplateRemotePreview,
  createProjectTemplateExportPlan,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  createProjectTemplateRemoteApplyComposition,
  claimProjectTemplateRemoteApplyLeaseForExecution,
  consumeProjectTemplateRemoteApplyLeaseExecutionClaim,
} from '../../features/project-template/remote-transaction-apply-facade.js';
import {
  acquireProjectTemplateApplyLease,
} from '../../features/project-template/apply-lease.js';
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

const roots: string[] = [];
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SECRET = 'remote-transaction-apply-test-key';

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

function publicOptions(cacheRoot: string, projectRoot: string) {
  return {
    cacheRoot,
    receiptKey: 'a'.repeat(64),
    expectedTransactionPlanId: 'b'.repeat(64),
    approvalEvidence: Object.freeze({ kind: 'caller-forged-approval' }),
    projectRoot,
    currentTaktVersion: '0.48.0',
    baselineStrategy: 'conflict' as const,
  };
}

async function* chunks(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

function verifier(
  result: 'valid' | 'invalid' = 'valid',
): GithubTemplateDownloadReceiptVerifier {
  return {
    async verify({ input, tag }) {
      if (result === 'invalid') return 'invalid';
      return createHmac('sha256', SECRET).update(input).digest('hex') === tag
        ? 'valid'
        : 'invalid';
    },
  };
}

async function storedFixture() {
  const sourceRoot = root('takt-remote-apply-source-');
  const sourcePath = join(sourceRoot, '.takt', 'workflows', 'review.yaml');
  mkdirSync(join(sourceRoot, '.takt', 'workflows'), { recursive: true });
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
          {
            id: 3,
            name: 'template.taktpack.sha256',
            size: checksum.length,
          },
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
  const rawCacheRoot = root('takt-remote-apply-cache-');
  chmodSync(rawCacheRoot, 0o700);
  const cacheRoot = realpathSync.native(rawCacheRoot);
  const materialized = await materializeGithubTemplateCache({ staged, cacheRoot });
  const prepared = await prepareGithubTemplateDownloadReceipt({
    downloadClaim: claimResolvedGithubTemplateSourceForDownload(resolved),
    materialized,
    authenticator: {
      async acquireSigningKey() {
        return {
          keyId: 'remote-apply-key',
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
  const receiptPath = join(
    cacheRoot,
    'receipts',
    'v1',
    'sha256',
    prepared.receiptKey.slice(0, 2),
    `${prepared.receiptKey}.json`,
  );
  return {
    cacheRoot,
    artifactPath: materialized.cachePath,
    receiptPath,
    prepared,
    projectRoot: root('takt-remote-apply-target-'),
  };
}

function flipFirstHexBit(value: string): string {
  return `${value[0] === '0' ? '1' : '0'}${value.slice(1)}`;
}

describe('GitHub project template remote transaction apply facade', () => {
  it.each(['verifier', 'repertoireInspectionPort'] as const)(
    'rejects caller-forged %s authority before any apply-side effect',
    async (authorityField) => {
      const cacheRoot = root('takt-remote-apply-cache-');
      const projectRoot = root('takt-remote-apply-project-');
      const cacheSentinel = join(cacheRoot, 'sentinel');
      const targetSentinel = join(projectRoot, 'sentinel');
      writeFileSync(cacheSentinel, 'cache unchanged');
      writeFileSync(targetSentinel, 'target unchanged');
      let authorityCalls = 0;
      const forgedAuthority = authorityField === 'verifier'
        ? {
          async verify() {
            authorityCalls += 1;
            return 'valid';
          },
        }
        : {
          inspect() {
            authorityCalls += 1;
            return { witnessSha256: 'c'.repeat(64), observations: [] };
          },
        };

      await expect(Promise.resolve().then(async () => (
        await applyGithubProjectTemplateRemoteTransaction({
          ...publicOptions(cacheRoot, projectRoot),
          [authorityField]: forgedAuthority,
        } as never)
      ))).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
        message: 'GitHub project template remote apply options are invalid',
      });
      expect(authorityCalls).toBe(0);
      expect(readFileSync(cacheSentinel, 'utf8')).toBe('cache unchanged');
      expect(readFileSync(targetSentinel, 'utf8')).toBe('target unchanged');
    },
  );

  it('accepts one genuine owned lease claim and rejects its structural clone', () => {
    const projectRoot = root('takt-remote-apply-lease-');
    const lease = acquireProjectTemplateApplyLease(projectRoot);
    try {
      const claim = claimProjectTemplateRemoteApplyLeaseForExecution({
        projectRoot,
        lease,
      });
      expect(() => consumeProjectTemplateRemoteApplyLeaseExecutionClaim({
        projectRoot,
        claim: { ...claim },
      } as never)).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
      expect(() => consumeProjectTemplateRemoteApplyLeaseExecutionClaim({
        projectRoot,
        claim,
      })).not.toThrow();
      expect(() => consumeProjectTemplateRemoteApplyLeaseExecutionClaim({
        projectRoot,
        claim,
      })).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    } finally {
      lease.release();
    }
  });

  it('rejects a released lease and an active lease owned by another project', () => {
    const projectRoot = root('takt-remote-apply-lease-owner-');
    const otherRoot = root('takt-remote-apply-lease-other-');
    const active = acquireProjectTemplateApplyLease(projectRoot);
    try {
      expect(() => claimProjectTemplateRemoteApplyLeaseForExecution({
        projectRoot: otherRoot,
        lease: active,
      })).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    } finally {
      active.release();
    }
    expect(() => claimProjectTemplateRemoteApplyLeaseForExecution({
      projectRoot,
      lease: active,
    })).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
  });

  it.each([
    ['cache drift', 'CACHE_INVALID', (value: Awaited<ReturnType<typeof storedFixture>>) => {
      writeFileSync(value.artifactPath, 'changed');
    }, 'valid'],
    ['HMAC failure', 'AUTHENTICATION_FAILED', () => {}, 'invalid'],
    ['artifact clone', 'CACHE_INVALID', (value: Awaited<ReturnType<typeof storedFixture>>) => {
      linkSync(value.artifactPath, `${value.artifactPath}.clone`);
    }, 'valid'],
    ['receipt clone', 'CACHE_INVALID', (value: Awaited<ReturnType<typeof storedFixture>>) => {
      linkSync(value.receiptPath, `${value.receiptPath}.clone`);
    }, 'valid'],
  ] as const)(
    'freshly rejects %s before approval or execution',
    async (_label, expectedCode, mutate, verifierResult) => {
      const value = await storedFixture();
      const projectRoot = root('takt-remote-apply-target-');
      const sentinel = join(projectRoot, 'sentinel');
      writeFileSync(sentinel, 'unchanged');
      mutate(value);
      let inspections = 0;
      const composition = createProjectTemplateRemoteApplyComposition({
        verifier: verifier(verifierResult),
        repertoireInspectionPort: {
          inspect() {
            inspections += 1;
            return { witnessSha256: 'e'.repeat(64), observations: [] };
          },
        },
      });

      await expect(composition.apply({
        ...publicOptions(value.cacheRoot, projectRoot),
        receiptKey: value.prepared.receiptKey,
      } as never)).rejects.toMatchObject({ code: expectedCode });
      expect(inspections).toBe(0);
      expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
    },
  );

  it('rejects a one-bit expected transaction drift after fresh rederivation', async () => {
    const value = await storedFixture();
    const inspectionPort = {
      inspect() {
        return { witnessSha256: 'e'.repeat(64), observations: [] };
      },
    };
    const preview = await createGithubProjectTemplateRemotePreview({
      cacheRoot: value.cacheRoot,
      receiptKey: value.prepared.receiptKey,
      verifier: verifier(),
      projectRoot: value.projectRoot,
      currentTaktVersion: '0.48.0',
      repertoireInspectionPort: inspectionPort,
      baselineStrategy: 'conflict',
    });
    let applyInspections = 0;
    const composition = createProjectTemplateRemoteApplyComposition({
      verifier: verifier(),
      repertoireInspectionPort: {
        inspect() {
          applyInspections += 1;
          return { witnessSha256: 'e'.repeat(64), observations: [] };
        },
      },
    });

    await expect(composition.apply({
      ...publicOptions(value.cacheRoot, value.projectRoot),
      receiptKey: value.prepared.receiptKey,
      expectedTransactionPlanId: flipFirstHexBit(preview.transactionPlanId),
    } as never)).rejects.toMatchObject({
      code: 'TRANSACTION_PLAN_MISMATCH',
    });
    expect(applyInspections).toBe(1);
  });
});
