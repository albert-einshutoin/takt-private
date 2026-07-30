import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reclaimGithubTemplateDownloadReceiptTemps,
} from '../../features/project-template/github-download-receipt-reclaim.js';
import {
  createProjectTemplateExportPlan,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  createGithubTemplateDownloadReceiptTempName,
} from '../../features/project-template/github-download-receipt-paths.js';
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
  resolveGithubTemplateSource,
  type GithubTemplateSourceMetadataPort,
} from '../../features/project-template/github-update-check.js';
import {
  serializeProjectTemplateSourceDescriptor,
  type ProjectTemplateSourceDescriptorV1,
} from '../../features/project-template/source-descriptor.js';

const KEY = 'a'.repeat(64);
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ASSET_NAME = 'template.taktpack';
const CHECKSUM_NAME = `${ASSET_NAME}.sha256`;
const SECRET = 'receipt-reclaim-secret';
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-receipt-reclaim-'));
  roots.push(root);
  chmodSync(root, 0o700);
  return realpathSync.native(root);
}

function prepareShard(root: string, shard = 'aa'): string {
  const path = join(root, 'receipts', 'v1', 'sha256', shard);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function tempPath(
  shard: string,
  pid: number,
  key = KEY,
  uuid = UUID,
): string {
  return join(shard, createGithubTemplateDownloadReceiptTempName({
    pid,
    uuid,
    receiptKey: key,
  }));
}

function verifier() {
  return {
    async verify() {
      return 'valid' as const;
    },
  };
}

function hmacVerifier(
  state: 'valid' | 'invalid' | 'unavailable' = 'valid',
): GithubTemplateDownloadReceiptVerifier {
  return {
    async verify({ input, tag }) {
      if (state !== 'valid') return state;
      return createHmac('sha256', SECRET).update(input).digest('hex') === tag
        ? 'valid'
        : 'invalid';
    },
  };
}

async function* chunks(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

async function createStoredFixture() {
  const projectRoot = makeRoot();
  const sourcePath = join(projectRoot, '.takt', 'workflows', 'review.yaml');
  mkdirSync(join(projectRoot, '.takt', 'workflows'), {
    recursive: true,
  });
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
  const cacheRoot = makeRoot();
  const materialized = await materializeGithubTemplateCache({
    staged,
    cacheRoot,
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
  await storeGithubTemplateDownloadReceipt({
    prepared,
    cacheRoot,
    verifier: hmacVerifier(),
  });
  const shard = join(
    cacheRoot,
    'receipts',
    'v1',
    'sha256',
    prepared.receiptKey.slice(0, 2),
  );
  const finalPath = join(shard, `${prepared.receiptKey}.json`);
  return { cacheRoot, shard, finalPath, prepared };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('GitHub template receipt orphan reclaim D2b', () => {
  it('rejects unknown and Proxy options before traps', async () => {
    await expect(reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: '/private/cache',
      verifier: verifier(),
      unknown: true,
    } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    let traps = 0;
    const value = {
      cacheRoot: '/private/cache',
      verifier: verifier(),
    };
    const proxy = new Proxy(value, {
      getPrototypeOf() {
        traps += 1;
        return Object.prototype;
      },
      ownKeys() {
        traps += 1;
        return Reflect.ownKeys(value);
      },
    });
    await expect(reclaimGithubTemplateDownloadReceiptTemps(proxy))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(traps).toBe(0);
  });

  it('returns a frozen zero result for nonexistent roots and hierarchies', async () => {
    const missing = join(makeRoot(), 'missing');
    const missingResult = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: missing,
      verifier: verifier(),
    });
    expect(missingResult).toEqual({
      scanned: 0,
      matched: 0,
      dead: 0,
      reclaimed: 0,
      skipped: 0,
      unsafeRetained: 0,
      truncated: false,
      directoryDurability: 'synced',
      status: 'complete',
    });
    expect(Object.isFrozen(missingResult)).toBe(true);

    const root = makeRoot();
    const descriptors: number[] = [];
    const hierarchyResult = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
      io: {
        close(fd) {
          descriptors.push(fd);
        },
      },
    });
    expect(hierarchyResult.reclaimed).toBe(0);
    expect(descriptors).toHaveLength(1);
    expect(() => fstatSync(descriptors[0]!)).toThrow();
  });

  it('reclaims dead nlink1 partial files without trusting content', async () => {
    const root = makeRoot();
    const shard = prepareShard(root);
    const zero = tempPath(shard, 900001);
    const partial = tempPath(
      shard,
      900002,
      'b'.repeat(64),
      '223e4567-e89b-42d3-a456-426614174000',
    );
    const oversize = tempPath(
      shard,
      900003,
      'c'.repeat(64),
      '323e4567-e89b-42d3-a456-426614174000',
    );
    writeFileSync(zero, '', { mode: 0o600 });
    writeFileSync(partial, '{partial', { mode: 0o600 });
    writeFileSync(oversize, Buffer.alloc(256 * 1024 + 1), { mode: 0o600 });

    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
      io: {
        processProbe() {
          return 'missing';
        },
      },
    });

    expect(result).toMatchObject({
      scanned: 3,
      matched: 3,
      dead: 3,
      reclaimed: 3,
      skipped: 0,
      unsafeRetained: 0,
      directoryDurability: 'synced',
      status: 'complete',
    });
    expect([zero, partial, oversize].some(existsSync)).toBe(false);
  });

  it('retains current, live, inaccessible, thrown, and invalid probes', async () => {
    const root = makeRoot();
    const shard = prepareShard(root);
    const pids = [process.pid, 900011, 900012, 900013, 900014];
    const paths = pids.map((pid, index) => tempPath(
      shard,
      pid,
      String(index + 1).repeat(64).slice(0, 64),
      `${String(index + 1).repeat(8)}-e89b-42d3-a456-426614174000`,
    ));
    for (const path of paths) writeFileSync(path, '', { mode: 0o600 });
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
      io: {
        processProbe(pid) {
          if (pid === 900011) return 'alive';
          if (pid === 900012) return 'inaccessible';
          if (pid === 900013) throw new Error('ghp_probe_secret');
          return 'invalid' as never;
        },
      },
    });
    expect(result).toMatchObject({
      matched: 5,
      dead: 0,
      reclaimed: 0,
      skipped: 5,
    });
    expect(paths.every(existsSync)).toBe(true);
  });

  it('retains PID reuse when the second probe is no longer ESRCH', async () => {
    const root = makeRoot();
    const shard = prepareShard(root);
    const path = tempPath(shard, 900020);
    writeFileSync(path, '', { mode: 0o600 });
    let probes = 0;
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
      io: {
        processProbe() {
          probes += 1;
          return probes === 1 ? 'missing' : 'alive';
        },
      },
    });
    expect(result).toMatchObject({
      dead: 1,
      reclaimed: 0,
      skipped: 1,
    });
    expect(existsSync(path)).toBe(true);
    expect(probes).toBe(2);
  });

  it('ignores non-canonical temp names', async () => {
    const root = makeRoot();
    const shard = prepareShard(root);
    const names = [
      `.tmp.01.${UUID}.${KEY}`,
      `.tmp.1.${UUID.toUpperCase()}.${KEY}`,
      `.tmp.1.${UUID}.${KEY.toUpperCase()}`,
      `.tmp.1.${UUID}.${KEY}.extra`,
      '.tmp.not-valid',
    ];
    for (const name of names) {
      writeFileSync(join(shard, name), '', { mode: 0o600 });
    }
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
    });
    expect(result).toMatchObject({ matched: 0, reclaimed: 0 });
    expect(result.scanned).toBeGreaterThan(0);
  });

  it('retains unsafe mode, symlink, and nlink greater than two', async () => {
    const root = makeRoot();
    const shard = prepareShard(root);
    const broad = tempPath(shard, 900030);
    const symlink = tempPath(
      shard,
      900031,
      'b'.repeat(64),
      '223e4567-e89b-42d3-a456-426614174000',
    );
    const linked = tempPath(
      shard,
      900032,
      'c'.repeat(64),
      '323e4567-e89b-42d3-a456-426614174000',
    );
    writeFileSync(broad, '', { mode: 0o644 });
    writeFileSync(`${symlink}.target`, '', { mode: 0o600 });
    symlinkSync(`${symlink}.target`, symlink);
    writeFileSync(linked, '', { mode: 0o600 });
    linkSync(linked, `${linked}.one`);
    linkSync(linked, `${linked}.two`);
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
      io: { processProbe: () => 'missing' },
    });
    expect(result).toMatchObject({
      matched: 3,
      dead: 3,
      reclaimed: 0,
      skipped: 3,
      unsafeRetained: 3,
      status: 'unsafe-retained',
    });
    expect([broad, symlink, linked].every(existsSync)).toBe(true);
  });

  it('deletes at most 32 candidates', async () => {
    const root = makeRoot();
    const shard = prepareShard(root);
    for (let index = 0; index < 33; index += 1) {
      writeFileSync(tempPath(
        shard,
        910000 + index,
        index.toString(16).padStart(64, '0'),
        `${index.toString(16).padStart(8, '0')}-e89b-42d3-a456-426614174000`,
      ), '', { mode: 0o600 });
    }
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
      io: { processProbe: () => 'missing' },
    });
    expect(result).toMatchObject({
      reclaimed: 32,
      truncated: true,
      status: 'delete-limit',
    });
  });

  it('scans at most 8192 direct shard entries in total', async () => {
    const root = makeRoot();
    const shard = prepareShard(root);
    for (let index = 0; index < 8_192; index += 1) {
      writeFileSync(
        join(shard, `unrelated-${index.toString().padStart(4, '0')}`),
        '',
        { mode: 0o600 },
      );
    }
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
    });
    expect(result).toMatchObject({
      scanned: 8_192,
      reclaimed: 0,
      truncated: true,
      status: 'scan-limit',
    });
  });

  it('does no filesystem or mutation work on Windows', async () => {
    const root = makeRoot();
    const shard = prepareShard(root);
    writeFileSync(tempPath(shard, 900040), '', { mode: 0o600 });
    let calls = 0;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: {
        async verify() {
          calls += 1;
          return 'valid';
        },
      },
      io: {
        processProbe() {
          calls += 1;
          return 'missing';
        },
        unlink() {
          calls += 1;
        },
        fsync() {
          calls += 1;
        },
      },
    });
    expect(result).toEqual({
      scanned: 0,
      matched: 0,
      dead: 0,
      reclaimed: 0,
      skipped: 0,
      unsafeRetained: 0,
      truncated: false,
      directoryDurability: 'unsupported',
      status: 'complete',
    });
    expect(calls).toBe(0);
  });

  it('unlinks only a dead authenticated nlink2 temporary alias', async () => {
    const fixture = await createStoredFixture();
    const temporary = tempPath(
      fixture.shard,
      920001,
      fixture.prepared.receiptKey,
    );
    linkSync(fixture.finalPath, temporary);
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: fixture.cacheRoot,
      verifier: hmacVerifier(),
      io: { processProbe: () => 'missing' },
    });
    expect(result).toMatchObject({
      matched: 1,
      dead: 1,
      reclaimed: 1,
      unsafeRetained: 0,
    });
    expect(existsSync(temporary)).toBe(false);
    expect(readFileSync(fixture.finalPath, 'utf8'))
      .toBe(fixture.prepared.serialized);
    expect(lstatSync(fixture.finalPath).nlink).toBe(1);
  });

  it.each([
    ['invalid', hmacVerifier('invalid')],
    ['unavailable', hmacVerifier('unavailable')],
    ['throw', {
      async verify() {
        throw new Error('ghp_reclaim_verifier_secret');
      },
    }],
  ] as const)('retains nlink2 when verifier is %s', async (
    _label,
    receiptVerifier,
  ) => {
    const fixture = await createStoredFixture();
    const temporary = tempPath(
      fixture.shard,
      920002,
      fixture.prepared.receiptKey,
    );
    linkSync(fixture.finalPath, temporary);
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: fixture.cacheRoot,
      verifier: receiptVerifier,
      io: { processProbe: () => 'missing' },
    });
    expect(result).toMatchObject({
      reclaimed: 0,
      skipped: 1,
      unsafeRetained: 1,
      status: 'unsafe-retained',
    });
    expect(existsSync(temporary)).toBe(true);
    expect(existsSync(fixture.finalPath)).toBe(true);
  });

  it('retains nlink2 aliases with the wrong final key or invalid bytes', async () => {
    const wrongKeyFixture = await createStoredFixture();
    const wrongKey = 'f'.repeat(64);
    const wrongKeyTemp = tempPath(
      wrongKeyFixture.shard,
      920003,
      wrongKey,
    );
    linkSync(wrongKeyFixture.finalPath, wrongKeyTemp);
    const wrongKeyResult = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: wrongKeyFixture.cacheRoot,
      verifier: hmacVerifier(),
      io: { processProbe: () => 'missing' },
    });
    expect(wrongKeyResult).toMatchObject({
      reclaimed: 0,
      unsafeRetained: 1,
    });
    expect(existsSync(wrongKeyTemp)).toBe(true);

    const invalidFixture = await createStoredFixture();
    const invalidTemp = tempPath(
      invalidFixture.shard,
      920004,
      invalidFixture.prepared.receiptKey,
    );
    linkSync(invalidFixture.finalPath, invalidTemp);
    const bytes = Buffer.from(invalidFixture.prepared.serialized);
    bytes[0] = 0x5b;
    writeFileSync(invalidFixture.finalPath, bytes);
    const invalidResult = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: invalidFixture.cacheRoot,
      verifier: hmacVerifier(),
      io: { processProbe: () => 'missing' },
    });
    expect(invalidResult).toMatchObject({
      reclaimed: 0,
      unsafeRetained: 1,
    });
    expect(existsSync(invalidTemp)).toBe(true);
  });

  it('reclaims nlink1 even when a different final inode exists', async () => {
    const root = makeRoot();
    const shard = prepareShard(root);
    const temporary = tempPath(shard, 920005);
    const finalPath = join(shard, `${KEY}.json`);
    writeFileSync(temporary, 'partial', { mode: 0o600 });
    writeFileSync(finalPath, 'different-final', { mode: 0o600 });
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
      io: { processProbe: () => 'missing' },
    });
    expect(result.reclaimed).toBe(1);
    expect(existsSync(temporary)).toBe(false);
    expect(readFileSync(finalPath, 'utf8')).toBe('different-final');
  });

  it.each([
    'same-inode-content',
    'final-path',
    'ancestor',
    'root',
  ] as const)('retains nlink2 after %s changes post-HMAC', async (kind) => {
    const fixture = await createStoredFixture();
    const temporary = tempPath(
      fixture.shard,
      920006,
      fixture.prepared.receiptKey,
    );
    linkSync(fixture.finalPath, temporary);
    let changed = false;
    const errorOrResult = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: fixture.cacheRoot,
      verifier: hmacVerifier(),
      io: {
        processProbe: () => 'missing',
        onPhase(phase) {
          if (phase !== 'before-reclaim-unlink' || changed) return;
          changed = true;
          if (kind === 'same-inode-content') {
            const bytes = Buffer.from(fixture.prepared.serialized);
            bytes[bytes.byteLength - 2] = bytes[bytes.byteLength - 2]! ^ 1;
            writeFileSync(fixture.finalPath, bytes);
          } else if (kind === 'final-path') {
            renameSync(fixture.finalPath, `${fixture.finalPath}.replacement`);
            writeFileSync(
              fixture.finalPath,
              fixture.prepared.serialized,
              { mode: 0o600 },
            );
          } else {
            const path = kind === 'root'
              ? fixture.cacheRoot
              : fixture.shard;
            const replacement = `${path}.replacement`;
            renameSync(path, replacement);
            roots.push(replacement);
          }
        },
      },
    }).catch((error: unknown) => error);
    if (kind === 'same-inode-content' || kind === 'final-path') {
      expect(errorOrResult).toMatchObject({
        reclaimed: 0,
        unsafeRetained: 1,
      });
    } else {
      expect(errorOrResult).toMatchObject({ code: 'CACHE_INVALID' });
    }
    const retainedFinal = kind === 'root'
      ? fixture.finalPath.replace(
        fixture.cacheRoot,
        `${fixture.cacheRoot}.replacement`,
      )
      : kind === 'ancestor'
        ? fixture.finalPath.replace(
          fixture.shard,
          `${fixture.shard}.replacement`,
        )
        : kind === 'final-path'
          ? `${fixture.finalPath}.replacement`
          : fixture.finalPath;
    expect(existsSync(retainedFinal)).toBe(true);
  });

  it('supports partial receipt reads and verifies post-state close/fsync', async () => {
    const fixture = await createStoredFixture();
    const temporary = tempPath(
      fixture.shard,
      920007,
      fixture.prepared.receiptKey,
    );
    linkSync(fixture.finalPath, temporary);
    const closed: number[] = [];
    let synced = 0;
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: fixture.cacheRoot,
      verifier: hmacVerifier(),
      io: {
        processProbe: () => 'missing',
        read(fd, buffer, offset, length, position) {
          return readSync(
            fd,
            buffer,
            offset,
            Math.min(length, 7),
            position,
          );
        },
        fsync() {
          synced += 1;
        },
        close(fd) {
          closed.push(fd);
        },
      },
    });
    expect(result.reclaimed).toBe(1);
    expect(synced).toBe(1);
    expect(closed.length).toBeGreaterThanOrEqual(7);
    for (const fd of closed) expect(() => fstatSync(fd)).toThrow();
  });

  it.each([
    'after-reclaim-unlink',
    'before-reclaim-fsync',
    'fsync',
  ] as const)('fails closed when %s mutates final bytes post-unlink', async (
    mutationPoint,
  ) => {
    const fixture = await createStoredFixture();
    const temporary = tempPath(
      fixture.shard,
      920008,
      fixture.prepared.receiptKey,
    );
    linkSync(fixture.finalPath, temporary);
    let changed = false;
    const mutate = () => {
      if (changed) return;
      changed = true;
      const bytes = Buffer.from(fixture.prepared.serialized);
      bytes[bytes.byteLength - 2] = bytes[bytes.byteLength - 2]! ^ 1;
      writeFileSync(fixture.finalPath, bytes);
    };
    const error = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: fixture.cacheRoot,
      verifier: hmacVerifier(),
      io: {
        processProbe: () => 'missing',
        onPhase(phase) {
          if (phase === mutationPoint) mutate();
        },
        fsync() {
          if (mutationPoint === 'fsync') mutate();
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'CACHE_INVALID' });
    expect(existsSync(fixture.finalPath)).toBe(true);
    expect(existsSync(temporary)).toBe(false);
  });

  it('revalidates the temporary path after the unlink seam', async () => {
    const root = makeRoot();
    const shard = prepareShard(root);
    const temporary = tempPath(shard, 920009);
    writeFileSync(temporary, 'orphan', { mode: 0o600 });
    const moved = `${temporary}.moved`;
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
      io: {
        processProbe: () => 'missing',
        unlink() {
          renameSync(temporary, moved);
          writeFileSync(temporary, 'replacement', { mode: 0o600 });
        },
      },
    });
    expect(result).toMatchObject({
      reclaimed: 0,
      unsafeRetained: 1,
    });
    expect(existsSync(temporary)).toBe(true);
    expect(existsSync(moved)).toBe(true);
  });

  it('fsyncs every shard changed by deletion', async () => {
    const root = makeRoot();
    const first = prepareShard(root, 'aa');
    const second = prepareShard(root, 'bb');
    writeFileSync(tempPath(first, 920010), '', { mode: 0o600 });
    writeFileSync(tempPath(
      second,
      920011,
      'b'.repeat(64),
      '223e4567-e89b-42d3-a456-426614174000',
    ), '', { mode: 0o600 });
    let syncs = 0;
    const result = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
      io: {
        processProbe: () => 'missing',
        fsync() {
          syncs += 1;
        },
      },
    });
    expect(result.reclaimed).toBe(2);
    expect(syncs).toBe(2);
  });

  it('preserves unlink failure while attempting every close', async () => {
    const root = makeRoot();
    const shard = prepareShard(root);
    const temporary = tempPath(shard, 920012);
    writeFileSync(temporary, '', { mode: 0o600 });
    const closed: number[] = [];
    const error = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
      io: {
        processProbe: () => 'missing',
        unlink() {
          throw new Error('ghp_reclaim_unlink_secret');
        },
        close(fd) {
          closed.push(fd);
          throw new Error('ghp_reclaim_close_secret');
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'IO_FAILURE' });
    expect(String((error as Error).message)).not.toContain('secret');
    expect(closed.length).toBeGreaterThanOrEqual(6);
    for (const fd of closed) expect(() => fstatSync(fd)).toThrow();
  });

  it('revalidates the retained final after every candidate close hook', async () => {
    const fixture = await createStoredFixture();
    const temporary = tempPath(
      fixture.shard,
      920013,
      fixture.prepared.receiptKey,
    );
    linkSync(fixture.finalPath, temporary);
    let changed = false;
    const error = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: fixture.cacheRoot,
      verifier: hmacVerifier(),
      io: {
        processProbe: () => 'missing',
        close(_fd, kind) {
          if (kind !== 'final' || changed) return;
          changed = true;
          const bytes = Buffer.from(fixture.prepared.serialized);
          bytes[bytes.byteLength - 2] = bytes[bytes.byteLength - 2]! ^ 1;
          writeFileSync(fixture.finalPath, bytes);
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'CACHE_INVALID' });
    expect(existsSync(fixture.finalPath)).toBe(true);
    expect(existsSync(temporary)).toBe(false);
  });

  it.each([
    'directory-stream',
    'shard-descriptor',
    'root-descriptor',
  ] as const)('revalidates hierarchy after %s close hooks', async (kind) => {
    const root = makeRoot();
    const shard = prepareShard(root);
    writeFileSync(join(shard, 'unrelated'), '', { mode: 0o600 });
    let directoryCloses = 0;
    let changed = false;
    const movedRoot = `${root}.replacement`;
    const movedShard = `${shard}.replacement`;
    const error = await reclaimGithubTemplateDownloadReceiptTemps({
      cacheRoot: root,
      verifier: verifier(),
      io: {
        closeDirectoryStream() {
          if (kind !== 'directory-stream' || changed) return;
          changed = true;
          renameSync(shard, movedShard);
        },
        close(_fd, descriptorKind) {
          if (descriptorKind !== 'directory') return;
          directoryCloses += 1;
          if (changed) return;
          if (kind === 'shard-descriptor' && directoryCloses === 1) {
            changed = true;
            renameSync(shard, movedShard);
          } else if (kind === 'root-descriptor' && directoryCloses === 5) {
            changed = true;
            renameSync(root, movedRoot);
          }
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'CACHE_INVALID' });
    if (existsSync(movedRoot)) roots.push(movedRoot);
  });
});
