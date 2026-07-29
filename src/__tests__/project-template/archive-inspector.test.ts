import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateExportPlan,
  inspectTaktpack,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  inspectTaktpackWithIoSeam,
  type TaktpackInspectorIoPhase,
} from '../../features/project-template/archive-inspector.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'taktpack-inspect-'));
  roots.push(root);
  return root;
}

async function makePack(root: string, withExcludedRuntime = false): Promise<string> {
  const sourcePath = join(root, '.takt', 'workflows', 'review.yaml');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, 'name: review\n');
  if (withExcludedRuntime) {
    writeFileSync(join(root, '.takt', 'tasks.yaml'), 'runtime task\n');
  }
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

async function makeCapabilityPack(root: string): Promise<string> {
  const sourcePath = join(root, '.takt', 'workflows', 'release.yaml');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, 'steps:\n  - run: npm test\n');
  const plan = await createProjectTemplateExportPlan(root, {
    packVersion: '1.0.0',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'local',
      uri: '.',
      ref: 'workspace',
      commit: 'a'.repeat(40),
    },
    approvedCapabilities: ['external-command'],
  });
  const output = join(root, 'capability.taktpack');
  await writeTaktpack(output, plan);
  return output;
}

function replaceExcludedReason(pack: string, replacement: string): void {
  const bytes = readFileSync(pack);
  const reportHeaderOffset = findTarEntryOffset(bytes, 'export-report.json');
  const reportSize = Number.parseInt(
    bytes.subarray(reportHeaderOffset + 124, reportHeaderOffset + 136).toString('ascii'),
    8,
  );
  const report = bytes.subarray(
    reportHeaderOffset + 512,
    reportHeaderOffset + 512 + reportSize,
  );
  const oldReason = Buffer.from('RUNTIME_STATE');
  const reasonOffset = report.indexOf(oldReason);
  expect(reasonOffset).toBeGreaterThanOrEqual(0);
  expect(Buffer.byteLength(replacement)).toBe(oldReason.byteLength);
  report.write(replacement, reasonOffset, oldReason.byteLength, 'ascii');

  const packHeaderOffset = findTarEntryOffset(bytes, 'pack.json');
  const packSize = Number.parseInt(
    bytes.subarray(packHeaderOffset + 124, packHeaderOffset + 136).toString('ascii'),
    8,
  );
  const packContent = bytes.subarray(packHeaderOffset + 512, packHeaderOffset + 512 + packSize);
  const metadata = JSON.parse(packContent.toString('utf8')) as { exportReportSha256: string };
  const digestOffset = packContent.indexOf(Buffer.from(metadata.exportReportSha256));
  const newDigest = createHash('sha256').update(report).digest('hex');
  packContent.write(newDigest, digestOffset, 64, 'ascii');
  writeFileSync(pack, bytes);
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
    expect(result).not.toHaveProperty('lock');
    expect(result.lockSeed).toMatchObject({
      kind: 'project-template-lock-seed',
      schemaVersion: '1.0',
    });
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

  it('validates currentTaktVersion before opening the archive and preserves INVALID_SEMVER', async () => {
    const root = makeRoot();
    const pack = await makePack(root);
    const phases: TaktpackInspectorIoPhase[] = [];

    const error = await inspectTaktpackWithIoSeam(pack, {
      currentTaktVersion: 'not-semver',
    }, {
      onPhase(phase) {
        phases.push(phase);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'INVALID_SEMVER',
      field: 'currentTaktVersion',
    });
    expect(phases).toEqual([]);
  });

  it.each([
    ['manifest semver', 'INVALID_SEMVER', async (root: string) => {
      const pack = await makePack(root);
      const bytes = readFileSync(pack);
      const offset = findTarEntryOffset(bytes, 'manifest.json');
      const content = bytes.subarray(offset + 512);
      const marker = content.indexOf(Buffer.from('"packVersion":"1.0.0"'));
      content.write('"packVersion":"not-a"', marker, 21, 'ascii');
      writeFileSync(pack, bytes);
      return pack;
    }],
    ['lock seed semver', 'INVALID_SEMVER', async (root: string) => {
      const pack = await makePack(root);
      const bytes = readFileSync(pack);
      const marker = bytes.indexOf(Buffer.from('"packVersion":"1.0.0"'));
      bytes.write('"packVersion":"not-a"', marker, 21, 'ascii');
      writeFileSync(pack, bytes);
      return pack;
    }],
    ['manifest capability', 'UNDECLARED_CAPABILITY', async (root: string) => {
      const pack = await makeCapabilityPack(root);
      const bytes = readFileSync(pack);
      const offset = findTarEntryOffset(bytes, 'manifest.json');
      const content = bytes.subarray(offset + 512);
      const marker = content.indexOf(Buffer.from('external-command'));
      content.write('unknown-capabili', marker, 16, 'ascii');
      writeFileSync(pack, bytes);
      return pack;
    }],
  ])('preserves the stable semantic code for malformed %s', async (_label, code, mutate) => {
    const root = makeRoot();
    const pack = await mutate(root);

    await expect(inspectTaktpack(pack)).rejects.toMatchObject({ code });
  });

  it('redacts an unreadable archive path and token marker', async () => {
    const root = makeRoot();
    const archivePath = join(root, 'TOKEN_MARKER_ARCHIVE.taktpack');

    const error = await inspectTaktpack(archivePath).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'UNSAFE_ARCHIVE_ENTRY', field: 'archive' });
    expect(String(error)).not.toContain(root);
    expect(JSON.stringify(error)).not.toContain('TOKEN_MARKER_ARCHIVE');
  });

  it.each([
    ['handle-stat', 'archive.stat'],
    ['read', 'archive.read'],
    ['final-stat', 'archive.finalStat'],
    ['close', 'archive.close'],
  ] as const)('normalizes and redacts a %s I/O failure', async (phase, field) => {
    const root = makeRoot();
    const pack = await makePack(root);

    const error = await inspectTaktpackWithIoSeam(pack, {}, {
      onPhase(currentPhase) {
        if (currentPhase === phase) throw new Error(`raw ${phase} ${root}`);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'ARCHIVE_READ_FAILED', field });
    expect(String(error)).not.toContain(root);
  });

  it('does not let close failure mask the primary read failure', async () => {
    const root = makeRoot();
    const pack = await makePack(root);
    const phases: TaktpackInspectorIoPhase[] = [];

    const error = await inspectTaktpackWithIoSeam(pack, {}, {
      onPhase(phase) {
        phases.push(phase);
        if (phase === 'read' || phase === 'close') {
          throw new Error(`raw ${phase} ${root}`);
        }
      },
    }).catch((caught: unknown) => caught);

    expect(phases).toContain('close');
    expect(error).toMatchObject({ code: 'ARCHIVE_READ_FAILED', field: 'archive.read' });
    expect(String(error)).not.toContain(root);
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
    ['unknown reason', 'TOKEN_MARKERX', 'TOKEN_MARKERX'],
    ['control character reason', '\\u001bTOKENXX', 'TOKENXX'],
  ])('rejects and redacts an excludedReasons %s', async (_label, replacement, marker) => {
    const root = makeRoot();
    const pack = await makePack(root, true);
    replaceExcludedReason(pack, replacement);

    const error = await inspectTaktpack(pack).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'INVALID_PACK', field: 'excludedReasons' });
    expect(String(error)).not.toContain(marker);
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

  it.each([
    ['uname', 265],
    ['gname', 297],
    ['reserved header bytes', 500],
  ])('rejects non-zero %s bytes', async (_label, offset) => {
    const root = makeRoot();
    const pack = await makePack(root);
    const bytes = readFileSync(pack);
    bytes[offset] = 0x41;
    rewriteTarChecksum(bytes.subarray(0, 512));
    writeFileSync(pack, bytes);

    await expect(inspectTaktpack(pack)).rejects.toMatchObject({
      code: 'INVALID_PACK',
      field: 'entry.metadata',
    });
  });

  it('rejects non-zero bytes after the USTAR name terminator', async () => {
    const root = makeRoot();
    const pack = await makePack(root);
    const bytes = readFileSync(pack);
    const nameTerminator = bytes.subarray(0, 100).indexOf(0);
    expect(nameTerminator).toBeGreaterThanOrEqual(0);
    bytes[nameTerminator + 1] = 0x41;
    rewriteTarChecksum(bytes.subarray(0, 512));
    writeFileSync(pack, bytes);

    await expect(inspectTaktpack(pack)).rejects.toMatchObject({
      code: 'INVALID_PACK',
      field: 'entry.name',
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
