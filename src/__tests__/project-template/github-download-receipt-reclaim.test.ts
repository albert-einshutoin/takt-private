import {
  chmodSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
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
  createGithubTemplateDownloadReceiptTempName,
} from '../../features/project-template/github-download-receipt-paths.js';

const KEY = 'a'.repeat(64);
const UUID = '123e4567-e89b-42d3-a456-426614174000';
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
});
