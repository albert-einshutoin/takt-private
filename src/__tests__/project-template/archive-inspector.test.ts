import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateExportPlan,
  inspectTaktpack,
  writeTaktpack,
} from '../../features/project-template/index.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'taktpack-inspect-'));
  roots.push(root);
  return root;
}

async function makePack(root: string): Promise<string> {
  const sourcePath = join(root, '.takt', 'workflows', 'review.yaml');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, 'name: review\n');
  const plan = await createProjectTemplateExportPlan(root, {
    packVersion: '1.0.0',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'local',
      uri: '.',
      ref: 'workspace',
      commit: 'a'.repeat(40),
    },
  });
  const output = join(root, 'valid.taktpack');
  await writeTaktpack(output, plan);
  return output;
}

function rewriteTarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = `${checksum.toString(8).padStart(6, '0')}\0 `;
  header.write(encoded, 148, 8, 'ascii');
}

function findTarEntryOffset(bytes: Buffer, prefix: string): number {
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '');
    if (name.startsWith(prefix)) return offset;
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii'), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`entry not found: ${prefix}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('taktpack streaming inspector', () => {
  it('validates an exported pack without writing extracted files', async () => {
    const root = makeRoot();
    const pack = await makePack(root);

    const result = await inspectTaktpack(pack, { currentTaktVersion: '0.48.0' });

    expect(result).toMatchObject({
      descriptor: { format: 'taktpack', version: '1.0', archive: 'ustar' },
      compatibility: { status: 'compatible', compatible: true },
      report: { counts: { merge: 1 } },
    });
    expect(result.manifest.entries[0]?.path).toBe('workflows/review.yaml');
    expect(existsSync(join(root, 'pack.json'))).toBe(false);
    expect(existsSync(join(root, 'blobs'))).toBe(false);
  });

  it('reports compatibility as unknown when the caller provides no current version', async () => {
    const root = makeRoot();
    const pack = await makePack(root);

    const result = await inspectTaktpack(pack);

    expect(result.compatibility).toEqual({
      status: 'unknown',
      minVersion: '0.48.0',
    });
  });

  it('rejects trailing bytes after the two USTAR end blocks', async () => {
    const root = makeRoot();
    const pack = await makePack(root);
    appendFileSync(pack, Buffer.alloc(512));

    await expect(inspectTaktpack(pack)).rejects.toMatchObject({
      code: 'TRAILING_ARCHIVE_DATA',
    });
  });

  it('rejects a traversal entry name before reading its payload', async () => {
    const root = makeRoot();
    const pack = await makePack(root);
    const bytes = readFileSync(pack);
    bytes.fill(0, 0, 100);
    bytes.write('../pack.json', 0, 'ascii');
    rewriteTarChecksum(bytes.subarray(0, 512));
    writeFileSync(pack, bytes);

    const error = await inspectTaktpack(pack).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'UNSAFE_ARCHIVE_ENTRY' });
    expect(String(error)).not.toContain('../pack.json');
  });

  it('rejects report mutation through the pack index digest', async () => {
    const root = makeRoot();
    const pack = await makePack(root);
    const bytes = readFileSync(pack);
    const reportHeaderOffset = findTarEntryOffset(bytes, 'export-report.json');
    bytes[reportHeaderOffset + 512] ^= 1;
    writeFileSync(pack, bytes);

    await expect(inspectTaktpack(pack)).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });

  it.each([
    ['hardlink', '1'],
    ['symlink', '2'],
    ['character device', '3'],
    ['block device', '4'],
    ['directory', '5'],
    ['FIFO', '6'],
    ['PAX header', 'x'],
    ['GNU long path', 'L'],
  ])('rejects a %s entry', async (_label, type) => {
    const root = makeRoot();
    const pack = await makePack(root);
    const bytes = readFileSync(pack);
    bytes[156] = type.charCodeAt(0);
    rewriteTarChecksum(bytes.subarray(0, 512));
    writeFileSync(pack, bytes);

    await expect(inspectTaktpack(pack)).rejects.toMatchObject({
      code: 'UNSAFE_ARCHIVE_ENTRY',
    });
  });

  it('enforces a caller-tightened archive byte budget', async () => {
    const root = makeRoot();
    const pack = await makePack(root);
    const archiveBytes = readFileSync(pack).byteLength;

    await expect(inspectTaktpack(pack, {
      limits: { maxArchiveBytes: archiveBytes - 1 },
    })).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT_EXCEEDED' });
  });

  it('allows callers to tighten but not raise each entry-kind budget', async () => {
    const root = makeRoot();
    const pack = await makePack(root);

    await expect(inspectTaktpack(pack, {
      limits: { maxManifestJsonBytes: 1 },
    })).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT_EXCEEDED' });
    await expect(inspectTaktpack(pack, {
      limits: { maxManifestJsonBytes: Number.MAX_SAFE_INTEGER },
    })).resolves.toMatchObject({ descriptor: { format: 'taktpack' } });
  });

  it('rejects a blob whose content does not match its content address', async () => {
    const root = makeRoot();
    const pack = await makePack(root);
    const bytes = readFileSync(pack);
    const blobHeaderOffset = findTarEntryOffset(bytes, 'blobs/sha256/');
    bytes[blobHeaderOffset + 512] ^= 0xff;
    writeFileSync(pack, bytes);

    await expect(inspectTaktpack(pack)).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });

  it('rejects a truncated archive', async () => {
    const root = makeRoot();
    const pack = await makePack(root);
    const bytes = readFileSync(pack);
    writeFileSync(pack, bytes.subarray(0, bytes.length - 1));

    await expect(inspectTaktpack(pack)).rejects.toMatchObject({ code: 'TRUNCATED_ARCHIVE' });
  });
});
