import { createHash } from 'node:crypto';
import {
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
  canonicalizeTaktpackJson,
  createProjectTemplateExportPlan,
  inspectTaktpack,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  materializeTaktpackContentsWithIoSeam,
} from '../../features/project-template/archive-inspector.js';

const roots: string[] = [];
type ArchiveRecord = Record<string, unknown>;
type ArchiveMutation = (metadata: ArchiveRecord, manifest: ArchiveRecord) => void;

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'taktpack-v1-1-contract-'));
  roots.push(root);
  return root;
}

async function makeV1Pack(root: string): Promise<string> {
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
  const archive = join(root, 'template.taktpack');
  await writeTaktpack(archive, plan);
  return archive;
}

function tarEntryOffset(archive: Buffer, entryName: string): number {
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '');
    if (name === entryName) return offset;
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii'), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`missing fixture archive entry: ${entryName}`);
}

function entryJson(archive: Buffer, entryName: string): ArchiveRecord {
  const offset = tarEntryOffset(archive, entryName);
  const size = Number.parseInt(archive.subarray(offset + 124, offset + 136).toString('ascii'), 8);
  return JSON.parse(archive.subarray(offset + 512, offset + 512 + size).toString('utf8')) as ArchiveRecord;
}

function rewriteChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

function replaceTarEntry(archive: Buffer, entryName: string, content: Buffer): Buffer {
  const offset = tarEntryOffset(archive, entryName);
  const header = Buffer.from(archive.subarray(offset, offset + 512));
  const previousSize = Number.parseInt(header.subarray(124, 136).toString('ascii'), 8);
  const previousEnd = offset + 512 + Math.ceil(previousSize / 512) * 512;
  const paddedSize = Math.ceil(content.byteLength / 512) * 512;
  header.write(`${content.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  rewriteChecksum(header);
  return Buffer.concat([
    archive.subarray(0, offset),
    header,
    content,
    Buffer.alloc(paddedSize - content.byteLength),
    archive.subarray(previousEnd),
  ]);
}

function rewriteArchiveJson(
  archivePath: string,
  mutate: ArchiveMutation,
): void {
  let archive = readFileSync(archivePath);
  const metadata = entryJson(archive, 'pack.json');
  const manifest = entryJson(archive, 'manifest.json');
  mutate(metadata, manifest);
  const manifestContent = Buffer.from(canonicalizeTaktpackJson(manifest));
  metadata.manifestSha256 = createHash('sha256').update(manifestContent).digest('hex');
  archive = replaceTarEntry(archive, 'manifest.json', manifestContent);
  archive = replaceTarEntry(
    archive,
    'pack.json',
    Buffer.from(canonicalizeTaktpackJson(metadata)),
  );
  writeFileSync(archivePath, archive);
}

function rewritePackMetadata(
  archivePath: string,
  mutate: (metadata: ArchiveRecord) => void,
): void {
  let archive = readFileSync(archivePath);
  const metadata = entryJson(archive, 'pack.json');
  mutate(metadata);
  archive = replaceTarEntry(
    archive,
    'pack.json',
    Buffer.from(canonicalizeTaktpackJson(metadata)),
  );
  writeFileSync(archivePath, archive);
}

function promoteToV1_1(
  archivePath: string,
  options: { derived?: boolean; withDependency?: boolean } = {},
): void {
  const draftId = 'c'.repeat(64);
  const dependencies: ArchiveRecord[] = options.withDependency === true
    ? [{
      scope: '@acme/editor-tools',
      version: '2.3.4',
      source: 'github:acme/editor-tools@v2.3.4',
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
      capabilities: ['edit'],
    }]
    : [];
  const derivation: ArchiveRecord = options.derived === true
    ? {
      kind: 'derived',
      operation: 'editor-save',
      draftId,
      editDocumentSha256: 'd'.repeat(64),
      parent: {
        archiveSha256: 'a'.repeat(64),
        manifestSha256: 'b'.repeat(64),
        packVersion: '0.9.0',
      },
    }
    : { kind: 'root' };
  const derivedSource: ArchiveRecord = {
    kind: 'derived',
    method: 'takt-editor-v1',
    draftId,
  };
  rewriteArchiveJson(archivePath, (metadata, manifest) => {
    metadata.version = '1.1';
    const lockSeed = metadata.lockSeed as ArchiveRecord;
    lockSeed.schemaVersion = '1.1';
    lockSeed.derivation = derivation;
    lockSeed.repertoireDependencies = dependencies;
    manifest.schemaVersion = '1.1';
    manifest.metadata = {
      name: 'Team workflow defaults',
      description: 'Portable review and release workflow defaults.',
    };
    manifest.derivation = derivation;
    manifest.repertoireDependencies = dependencies;
    if (options.derived === true) {
      lockSeed.source = derivedSource;
      manifest.source = derivedSource;
    }
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('taktpack archive v1.1 version negotiation contract', () => {
  it('keeps the v1.0 byte stream and inspection behavior unchanged', async () => {
    const root = makeRoot();
    const archive = await makeV1Pack(root);
    const copy = join(root, 'template-copy.taktpack');
    writeFileSync(copy, readFileSync(archive));

    const [original, duplicate] = await Promise.all([
      inspectTaktpack(archive, { currentTaktVersion: '0.48.0' }),
      inspectTaktpack(copy, { currentTaktVersion: '0.48.0' }),
    ]);

    expect(readFileSync(copy)).toEqual(readFileSync(archive));
    expect(original).toEqual(duplicate);
    expect(original).toMatchObject({
      descriptor: { version: '1.0' },
      lockSeed: { schemaVersion: '1.0' },
      manifest: { schemaVersion: '1.0' },
      compatibility: { status: 'compatible' },
    });
  });

  it('accepts a v1.1 archive only when pack, manifest, and lock seed negotiate v1.1 together', async () => {
    const root = makeRoot();
    const archive = await makeV1Pack(root);
    promoteToV1_1(archive);

    const result = await inspectTaktpack(archive, { currentTaktVersion: '0.48.0' });

    expect(result).toMatchObject({
      descriptor: { version: '1.1' },
      manifest: { schemaVersion: '1.1' },
      lockSeed: { schemaVersion: '1.1' },
      compatibility: { status: 'compatible' },
    });
  });

  it.each([
    ['manifest', (_metadata: ArchiveRecord, manifest: ArchiveRecord) => {
      manifest.schemaVersion = '1.0';
    }, 'manifest.json.schemaVersion'],
    ['lock seed', (metadata: ArchiveRecord, manifest: ArchiveRecord) => {
      (metadata.lockSeed as ArchiveRecord).schemaVersion = '1.0';
    }, 'pack.json.lockSeed.schemaVersion'],
  ] as const)('rejects a v1.1 pack paired with a v1.0 %s before materialization', async (
    _part,
    mutate,
    field,
  ) => {
    const root = makeRoot();
    const archive = await makeV1Pack(root);
    promoteToV1_1(archive);
    rewriteArchiveJson(archive, mutate);
    const allocations: string[] = [];

    await expect(inspectTaktpack(archive)).rejects.toMatchObject({
      code: 'INVALID_PACK',
      field,
    });
    await expect(materializeTaktpackContentsWithIoSeam(archive, {}, {
      onMaterializedPathAllocation(path) {
        allocations.push(path);
      },
    })).rejects.toMatchObject({
      code: 'INVALID_PACK',
      field,
    });
    expect(allocations).toEqual([]);
  });

  it.each(['1.2', '2.0'])('fails closed with a stable unsupported-version error for future pack %s', async (version) => {
    const root = makeRoot();
    const archive = await makeV1Pack(root);
    rewriteArchiveJson(archive, (metadata) => {
      metadata.version = version;
    });

    await expect(inspectTaktpack(archive)).rejects.toMatchObject({
      code: 'UNSUPPORTED_PACK_VERSION',
      field: 'pack.json.version',
    });
  });

  it('rejects metadata-integrity, dependency-binding, and derivation-binding tampering', async () => {
    const metadataRoot = makeRoot();
    const metadataArchive = await makeV1Pack(metadataRoot);
    promoteToV1_1(metadataArchive);
    rewritePackMetadata(metadataArchive, (metadata) => {
      metadata.manifestSha256 = 'f'.repeat(64);
    });
    await expect(inspectTaktpack(metadataArchive), 'metadata digest').rejects.toMatchObject({
      code: 'HASH_MISMATCH',
      field: 'manifest.json',
    });

    const dependencyRoot = makeRoot();
    const dependencyArchive = await makeV1Pack(dependencyRoot);
    promoteToV1_1(dependencyArchive, { withDependency: true });
    rewritePackMetadata(dependencyArchive, (metadata) => {
      (metadata.lockSeed as ArchiveRecord).repertoireDependencies = [];
    });
    await expect(inspectTaktpack(dependencyArchive), 'repertoire dependency').rejects.toMatchObject({
      code: 'LOCK_MISMATCH',
      field: 'repertoireDependencies',
    });

    const derivationRoot = makeRoot();
    const derivationArchive = await makeV1Pack(derivationRoot);
    promoteToV1_1(derivationArchive, { derived: true });
    rewritePackMetadata(derivationArchive, (metadata) => {
      const seedDerivation = (metadata.lockSeed as ArchiveRecord).derivation as ArchiveRecord;
      const parent = seedDerivation.parent as ArchiveRecord;
      parent.archiveSha256 = 'e'.repeat(64);
    });
    await expect(inspectTaktpack(derivationArchive), 'derived parent provenance').rejects.toMatchObject({
      code: 'LOCK_MISMATCH',
      field: 'derivation',
    });
  });
});
