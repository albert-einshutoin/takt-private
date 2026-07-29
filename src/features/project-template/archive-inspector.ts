import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import {
  DEFAULT_TAKTPACK_LIMITS,
  TAKTPACK_BLOB_PREFIX,
  TAKTPACK_ENTRY_NAMES,
  type InspectTaktpackOptions,
  type TaktpackDescriptorV1,
  type TaktpackExportReportV1,
  type TaktpackInspectResult,
  type TaktpackLockSeedV1,
  type TaktpackBlobIndexEntry,
} from './archive-types.js';
import {
  calculateProjectTemplateManifestSha256,
  validateManifestLockPair,
} from './binding.js';
import { validateDetectedTemplateCapabilities } from './capability-detection.js';
import { classifyProjectTemplateEntry } from './classifier-core.js';
import {
  ProjectTemplateValidationError,
  TaktpackError,
} from './errors.js';
import { parseTemplateLock } from './lock.js';
import { parseProjectTemplateManifest } from './manifest.js';
import type {
  DetectedTemplateCapabilities,
  ProjectTemplateManifestV1,
  TemplateEntryPolicy,
  TemplateLockV1,
} from './types.js';
import { compareSemVer, requireSemVer } from './validation.js';
import { parseSha256 } from './validation.js';
import { canonicalizeTaktpackJson } from './canonical-json.js';
import { PROJECT_TEMPLATE_CLASSIFICATION_REASONS } from './classifier-types.js';
import {
  maxBytesForTaktpackEntry,
  resolveTaktpackLimits,
  type TaktpackEntryKind,
} from './archive-limits.js';

const TAR_BLOCK_BYTES = 512;
const ZERO_BLOCK = Buffer.alloc(TAR_BLOCK_BYTES);
const BLOB_NAME_PATTERN = /^blobs\/sha256\/([a-f0-9]{64})$/;

interface ParsedHeader {
  name: string;
  size: number;
}

interface PackMetadata {
  descriptor: TaktpackDescriptorV1;
  manifestSha256: string;
  exportReportSha256: string;
  lockSeed: TaktpackLockSeedV1;
  blobs: TaktpackBlobIndexEntry[];
}

function parseOctal(field: Buffer, name: string): number {
  const text = field.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]+$/.test(text)) {
    throw new TaktpackError('INVALID_PACK', `invalid USTAR octal field: ${name}`, name);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', `USTAR field exceeds safe integer: ${name}`, name);
  }
  return value;
}

function isZeroBlock(block: Buffer): boolean {
  return block.equals(ZERO_BLOCK);
}

function checksumFor(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return sum;
}

function canonicalOctal(value: number, length: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii');
}

function parseHeader(header: Buffer): ParsedHeader {
  if (header.subarray(257, 263).toString('binary') !== 'ustar\0'
    || header.subarray(263, 265).toString('ascii') !== '00') {
    throw new TaktpackError('INVALID_PACK', 'archive must use POSIX USTAR headers', 'header.magic');
  }
  const checksum = checksumFor(header);
  if (
    parseOctal(header.subarray(148, 156), 'header.checksum') !== checksum
    || !header.subarray(148, 156).equals(
      Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii'),
    )
  ) {
    throw new TaktpackError('INVALID_PACK', 'USTAR header checksum mismatch', 'header.checksum');
  }
  const type = header[156];
  if (type !== 0x30) {
    throw new TaktpackError('UNSAFE_ARCHIVE_ENTRY', 'only regular USTAR file entries are allowed', 'entry.type');
  }
  if (
    !header.subarray(157, 257).equals(Buffer.alloc(100))
    || !header.subarray(345, 500).equals(Buffer.alloc(155))
  ) {
    throw new TaktpackError('UNSAFE_ARCHIVE_ENTRY', 'link, device, or prefixed entries are not allowed', 'entry.header');
  }
  const nameField = header.subarray(0, 100);
  const nameEnd = nameField.indexOf(0);
  if (
    nameEnd === -1
    || !nameField.subarray(nameEnd).equals(Buffer.alloc(100 - nameEnd))
  ) {
    throw new TaktpackError(
      'INVALID_PACK',
      'USTAR name field is not canonically terminated',
      'entry.name',
    );
  }
  const name = nameField.subarray(0, nameEnd).toString('ascii');
  if (
    name === ''
    || !/^[\x20-\x7e]+$/.test(name)
    || (!TAKTPACK_ENTRY_NAMES.includes(name as typeof TAKTPACK_ENTRY_NAMES[number])
      && !BLOB_NAME_PATTERN.test(name))
  ) {
    throw new TaktpackError('UNSAFE_ARCHIVE_ENTRY', 'archive entry name is unsafe or unknown', 'entry.name');
  }
  if (
    !header.subarray(100, 108).equals(canonicalOctal(0o644, 8))
    || !header.subarray(108, 116).equals(canonicalOctal(0, 8))
    || !header.subarray(116, 124).equals(canonicalOctal(0, 8))
    || !header.subarray(124, 136).equals(canonicalOctal(
      parseOctal(header.subarray(124, 136), 'header.size'),
      12,
    ))
    || !header.subarray(136, 148).equals(canonicalOctal(0, 12))
    || !header.subarray(265, 329).equals(Buffer.alloc(64))
    || !header.subarray(329, 337).equals(canonicalOctal(0, 8))
    || !header.subarray(337, 345).equals(canonicalOctal(0, 8))
    || !header.subarray(500, 512).equals(Buffer.alloc(12))
  ) {
    throw new TaktpackError('INVALID_PACK', 'archive metadata is not canonical', 'entry.metadata');
  }
  return { name, size: parseOctal(header.subarray(124, 136), 'header.size') };
}

function parseJson(content: Buffer, field: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    return JSON.parse(text) as unknown;
  } catch {
    throw new TaktpackError('INVALID_PACK', `${field} is not valid UTF-8 JSON`, field);
  }
}

function parsePackMetadata(content: Buffer): PackMetadata {
  const value = parseJson(content, 'pack.json');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaktpackError('INVALID_PACK', 'pack.json must be an object', 'pack.json');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'archive',
    'blobs',
    'contentAddressed',
    'exportReportSha256',
    'format',
    'lockSeed',
    'manifestSha256',
    'version',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)
    || record['format'] !== 'taktpack'
    || record['version'] !== '1.0'
    || record['archive'] !== 'ustar'
    || record['contentAddressed'] !== true) {
    throw new TaktpackError('INVALID_PACK', 'unsupported pack descriptor', 'pack.json');
  }
  if (canonicalizeTaktpackJson(value) !== content.toString('utf8')) {
    throw new TaktpackError('INVALID_PACK', 'pack.json is not canonical JSON', 'pack.json');
  }
  if (!Array.isArray(record['blobs']) || record['blobs'].length > DEFAULT_TAKTPACK_LIMITS.maxEntries) {
    throw new TaktpackError('INVALID_PACK', 'pack blob index is invalid', 'pack.json.blobs');
  }
  const blobs = record['blobs'].map((blob, index): TaktpackBlobIndexEntry => {
    if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) {
      throw new TaktpackError('INVALID_PACK', 'pack blob index entry is invalid', `pack.json.blobs[${index}]`);
    }
    const blobRecord = blob as Record<string, unknown>;
    if (JSON.stringify(Object.keys(blobRecord).sort()) !== JSON.stringify(['bytes', 'sha256'])) {
      throw new TaktpackError('INVALID_PACK', 'pack blob index entry has unknown fields', `pack.json.blobs[${index}]`);
    }
    if (!Number.isSafeInteger(blobRecord['bytes']) || (blobRecord['bytes'] as number) < 0) {
      throw new TaktpackError('INVALID_PACK', 'pack blob size is invalid', `pack.json.blobs[${index}].bytes`);
    }
    return {
      sha256: parseSha256(blobRecord['sha256'], `pack.json.blobs[${index}].sha256`),
      bytes: blobRecord['bytes'] as number,
    };
  });
  const sortedHashes = blobs.map((blob) => blob.sha256);
  if (
    new Set(sortedHashes).size !== sortedHashes.length
    || JSON.stringify(sortedHashes) !== JSON.stringify([...sortedHashes].sort())
  ) {
    throw new TaktpackError('INVALID_PACK', 'pack blob index must be unique and sorted', 'pack.json.blobs');
  }
  if (typeof record['lockSeed'] !== 'object'
    || record['lockSeed'] === null
    || Array.isArray(record['lockSeed'])
    || (record['lockSeed'] as Record<string, unknown>)['kind'] !== 'project-template-lock-seed') {
    throw new TaktpackError('INVALID_PACK', 'pack lock seed is invalid', 'pack.json.lockSeed');
  }
  const seedFields = { ...record['lockSeed'] as Record<string, unknown> };
  delete seedFields['kind'];
  const parsedSeed = parseTemplateLock({
    ...seedFields,
    manifestSha256: '0'.repeat(64),
  });
  const lockSeed: TaktpackLockSeedV1 = {
    kind: 'project-template-lock-seed',
    schemaVersion: parsedSeed.schemaVersion,
    packVersion: parsedSeed.packVersion,
    source: parsedSeed.source,
    capabilities: parsedSeed.capabilities,
    entries: parsedSeed.entries,
  };
  return {
    descriptor: {
      format: 'taktpack',
      version: '1.0',
      archive: 'ustar',
      contentAddressed: true,
    },
    manifestSha256: parseSha256(record['manifestSha256'], 'pack.json.manifestSha256'),
    exportReportSha256: parseSha256(record['exportReportSha256'], 'pack.json.exportReportSha256'),
    lockSeed,
    blobs,
  };
}

function parseReport(content: Buffer): TaktpackExportReportV1 {
  const value = parseJson(content, 'export-report.json');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaktpackError('INVALID_PACK', 'export report must be an object', 'export-report.json');
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort())
      !== JSON.stringify(['counts', 'excludedReasons', 'schemaVersion', 'warnings'])
  ) {
    throw new TaktpackError('INVALID_PACK', 'export report has unknown fields', 'export-report.json');
  }
  if (record['schemaVersion'] !== '1.0'
    || typeof record['counts'] !== 'object' || record['counts'] === null
    || typeof record['excludedReasons'] !== 'object' || record['excludedReasons'] === null
    || !Array.isArray(record['warnings'])
  ) {
    throw new TaktpackError('INVALID_PACK', 'invalid export report', 'export-report.json');
  }
  const countsRecord = record['counts'] as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(countsRecord).sort())
      !== JSON.stringify(['excluded', 'managed', 'merge', 'scaffold'])
  ) {
    throw new TaktpackError('INVALID_PACK', 'export report counts have unknown fields', 'counts');
  }
  const counts = {} as Record<TemplateEntryPolicy, number>;
  for (const policy of ['managed', 'merge', 'scaffold', 'excluded'] as const) {
    const count = countsRecord[policy];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new TaktpackError('INVALID_PACK', 'invalid export report count', `counts.${policy}`);
    }
    counts[policy] = count as number;
  }
  if (record['warnings'].length !== 0) {
    throw new TaktpackError('INVALID_PACK', 'export report warnings are not supported in v1', 'warnings');
  }
  if (canonicalizeTaktpackJson(value) !== content.toString('utf8')) {
    throw new TaktpackError('INVALID_PACK', 'export report is not canonical JSON', 'export-report.json');
  }
  const excludedReasons = record['excludedReasons'] as Record<string, unknown>;
  const allowedReasons = new Set<string>(PROJECT_TEMPLATE_CLASSIFICATION_REASONS);
  const reasonEntries = Object.entries(excludedReasons);
  if (
    Array.isArray(record['excludedReasons'])
    || reasonEntries.length > PROJECT_TEMPLATE_CLASSIFICATION_REASONS.length
    || reasonEntries.some(([reason, count]) => (
      !allowedReasons.has(reason)
      || !Number.isSafeInteger(count)
      || (count as number) < 0
      || (count as number) > 4_096
    ))
  ) {
    throw new TaktpackError('INVALID_PACK', 'invalid excluded reason count', 'excludedReasons');
  }
  const excludedTotal = reasonEntries.reduce((sum, [, count]) => sum + (count as number), 0);
  if (excludedTotal !== counts.excluded || excludedTotal > 4_096) {
    throw new TaktpackError('INVALID_PACK', 'excluded reason counts do not match excluded total', 'excludedReasons');
  }
  return {
    schemaVersion: '1.0',
    counts,
    excludedReasons: excludedReasons as TaktpackExportReportV1['excludedReasons'],
    warnings: Object.freeze([]),
  };
}

function validateReportAgainstManifest(
  report: TaktpackExportReportV1,
  manifest: ProjectTemplateManifestV1,
): void {
  for (const policy of ['managed', 'merge', 'scaffold'] as const) {
    if (report.counts[policy] !== manifest.entries.filter((entry) => entry.policy === policy).length) {
      throw new TaktpackError('INVALID_PACK', `report count does not match manifest: ${policy}`, `counts.${policy}`);
    }
  }
}

export type TaktpackInspectorIoPhase = 'handle-stat' | 'read' | 'final-stat' | 'close';

export interface TaktpackInspectorIoSeam {
  onPhase?(phase: TaktpackInspectorIoPhase): void;
}

function normalizeInspectorIoError(error: unknown, field: string): Error {
  if (error instanceof TaktpackError) return error;
  return new TaktpackError(
    'ARCHIVE_READ_FAILED',
    'archive read operation failed',
    field,
  );
}

export async function inspectTaktpackWithIoSeam(
  archivePath: string,
  options: InspectTaktpackOptions = {},
  ioSeam: TaktpackInspectorIoSeam = {},
): Promise<TaktpackInspectResult> {
  const currentVersion = options.currentTaktVersion === undefined
    ? undefined
    : requireSemVer(options.currentTaktVersion, 'currentTaktVersion');
  const limits = resolveTaktpackLimits(options.limits);
  let pathSnapshot: Awaited<ReturnType<typeof lstat>>;
  try {
    pathSnapshot = await lstat(archivePath);
  } catch {
    throw new TaktpackError('UNSAFE_ARCHIVE_ENTRY', 'archive input cannot be read safely', 'archive');
  }
  if (pathSnapshot.isSymbolicLink() || !pathSnapshot.isFile() || pathSnapshot.nlink !== 1) {
    throw new TaktpackError('UNSAFE_ARCHIVE_ENTRY', 'archive input must be a regular single-link file', 'archive');
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new TaktpackError('UNSAFE_ARCHIVE_ENTRY', 'archive input cannot be opened safely', 'archive');
  }
  const archiveDigest = createHash('sha256');
  let position = 0;
  let totalPayloadBytes = 0;
  let entryCount = 0;
  let metadata: PackMetadata | undefined;
  let manifest: ProjectTemplateManifestV1 | undefined;
  let report: TaktpackExportReportV1 | undefined;
  const detections: DetectedTemplateCapabilities[] = [];
  let primaryError: Error | undefined;
  let closeFailure: unknown;
  let result: TaktpackInspectResult | undefined;
  const runIo = async <Value>(
    phase: Exclude<TaktpackInspectorIoPhase, 'close'>,
    field: string,
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    try {
      ioSeam.onPhase?.(phase);
      return await operation();
    } catch (error) {
      throw normalizeInspectorIoError(error, field);
    }
  };
  try {
    const stat = await runIo('handle-stat', 'archive.stat', () => handle.stat());
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || stat.dev !== pathSnapshot.dev
      || stat.ino !== pathSnapshot.ino
      || stat.size !== pathSnapshot.size
      || stat.size > limits.maxArchiveBytes
    ) {
      throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive file exceeds safety limits', 'archive');
    }

    const readExact = async (
      length: number,
      payloadDigest?: ReturnType<typeof createHash>,
    ): Promise<Buffer> => {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const requestedBytes = Math.min(64 * 1024, length - offset);
        const { bytesRead } = await runIo(
          'read',
          'archive.read',
          () => handle.read(buffer, offset, requestedBytes, position + offset),
        );
        if (bytesRead === 0) {
          throw new TaktpackError('TRUNCATED_ARCHIVE', 'archive ended before the declared USTAR boundary');
        }
        const chunk = buffer.subarray(offset, offset + bytesRead);
        archiveDigest.update(chunk);
        payloadDigest?.update(chunk);
        offset += bytesRead;
      }
      position += length;
      return buffer;
    };

    while (true) {
      const headerBlock = await readExact(TAR_BLOCK_BYTES);
      if (isZeroBlock(headerBlock)) {
        const secondEndBlock = await readExact(TAR_BLOCK_BYTES);
        if (!isZeroBlock(secondEndBlock)) {
          throw new TaktpackError('TRUNCATED_ARCHIVE', 'USTAR archive requires two zero end blocks');
        }
        if (position !== stat.size) {
          throw new TaktpackError('TRAILING_ARCHIVE_DATA', 'data follows the canonical USTAR end marker');
        }
        break;
      }
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive entry count exceeds limit', 'entries');
      }
      const header = parseHeader(headerBlock);
      const entryKind: TaktpackEntryKind = header.name === 'pack.json'
        ? 'pack'
        : header.name === 'manifest.json'
          ? 'manifest'
          : header.name === 'export-report.json'
            ? 'report'
            : 'blob';
      if (header.size > maxBytesForTaktpackEntry(entryKind, limits)) {
        throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive entry exceeds size limit', `entries[${entryCount - 1}]`);
      }
      totalPayloadBytes += header.size;
      if (totalPayloadBytes > limits.maxTotalBytes) {
        throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive payload exceeds total size limit', 'entries');
      }

      const expectedName = entryCount <= TAKTPACK_ENTRY_NAMES.length
        ? TAKTPACK_ENTRY_NAMES[entryCount - 1]
          : metadata === undefined
          ? undefined
          : metadata.blobs[entryCount - TAKTPACK_ENTRY_NAMES.length - 1]
            ?.sha256.replace(/^/, TAKTPACK_BLOB_PREFIX);
      if (expectedName === undefined) {
        throw new TaktpackError('ORPHAN_BLOB', 'archive contains an unexpected entry', `entries[${entryCount - 1}]`);
      }
      if (header.name !== expectedName) {
        throw new TaktpackError('INVALID_ARCHIVE_ORDER', 'archive entry order is not canonical', `entries[${entryCount - 1}]`);
      }

      // One entry is bounded independently. Blobs are discarded immediately
      // after hashing and reclassification instead of accumulating the archive.
      const blobDigest = header.name.startsWith(TAKTPACK_BLOB_PREFIX)
        ? createHash('sha256')
        : undefined;
      const content = await readExact(header.size, blobDigest);
      const paddingBytes = (TAR_BLOCK_BYTES - (header.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (paddingBytes > 0 && !isZeroBlock(Buffer.concat([
        await readExact(paddingBytes),
        Buffer.alloc(TAR_BLOCK_BYTES - paddingBytes),
      ]))) {
        throw new TaktpackError('INVALID_PACK', 'USTAR entry padding must be zero', `entries[${entryCount - 1}]`);
      }

      if (header.name === 'pack.json') {
        metadata = parsePackMetadata(content);
      } else if (header.name === 'manifest.json') {
        manifest = parseProjectTemplateManifest(parseJson(content, 'manifest.json'));
        if (
          metadata === undefined
          || calculateProjectTemplateManifestSha256(manifest) !== metadata.manifestSha256
        ) {
          throw new TaktpackError('HASH_MISMATCH', 'manifest digest does not match the pack index', 'manifest.json');
        }
        if (canonicalizeTaktpackJson(manifest) !== content.toString('utf8')) {
          throw new TaktpackError('INVALID_PACK', 'manifest is not canonical JSON', 'manifest.json');
        }
      } else if (header.name === 'export-report.json') {
        if (
          metadata === undefined
          || createHash('sha256').update(content).digest('hex') !== metadata.exportReportSha256
        ) {
          throw new TaktpackError('HASH_MISMATCH', 'export report digest does not match the pack index', 'export-report.json');
        }
        report = parseReport(content);
      } else {
        const match = BLOB_NAME_PATTERN.exec(header.name)!;
        const hash = blobDigest!.digest('hex');
        if (hash !== match[1]) {
          throw new TaktpackError('HASH_MISMATCH', 'blob content does not match its content address', `entries[${entryCount - 1}]`);
        }
        const indexedBlob = metadata!.blobs[entryCount - TAKTPACK_ENTRY_NAMES.length - 1]!;
        if (indexedBlob.bytes !== content.byteLength) {
          throw new TaktpackError('HASH_MISMATCH', 'blob size does not match the pack index', `entries[${entryCount - 1}]`);
        }
        for (const [manifestIndex, entry] of manifest!.entries.entries()) {
          if (entry.sha256 !== hash) continue;
          const classification = classifyProjectTemplateEntry({
            relativePath: entry.path,
            content,
            bytes: content.byteLength,
            mode: entry.mode,
            sha256: hash,
          });
          if (
            classification.classification === 'blocked'
            || classification.classification === 'excluded'
            || classification.detectedCapabilities.inspectionStatus !== 'complete'
          ) {
            throw new TaktpackError(
              'INVALID_PACK',
              `blob failed semantic inspection: ${classification.reasonCode}`,
              `manifest.entries[${manifestIndex}]`,
            );
          }
          detections.push(classification.detectedCapabilities);
        }
      }
    }
    if (metadata === undefined || manifest === undefined || report === undefined) {
      throw new TaktpackError('MISSING_ARCHIVE_ENTRY', 'archive metadata is incomplete');
    }
    const manifestHashes = [...new Set(manifest.entries.map((entry) => entry.sha256))]
      .sort((left, right) => left.localeCompare(right, 'en-US'));
    if (JSON.stringify(manifestHashes) !== JSON.stringify(metadata.blobs.map((blob) => blob.sha256))) {
      throw new TaktpackError('MISSING_ARCHIVE_ENTRY', 'pack blob index does not match the manifest');
    }
    const expectedEntries = TAKTPACK_ENTRY_NAMES.length + metadata.blobs.length;
    if (entryCount !== expectedEntries) {
      throw new TaktpackError('MISSING_ARCHIVE_ENTRY', 'one or more content-addressed blobs are missing');
    }
    const lock: TemplateLockV1 = {
      schemaVersion: metadata.lockSeed.schemaVersion,
      packVersion: metadata.lockSeed.packVersion,
      source: metadata.lockSeed.source,
      capabilities: metadata.lockSeed.capabilities,
      entries: metadata.lockSeed.entries,
      manifestSha256: metadata.manifestSha256,
    };
    validateManifestLockPair(manifest, lock);
    validateDetectedTemplateCapabilities(manifest, detections);
    validateReportAgainstManifest(report, manifest);
    const finalStat = await runIo('final-stat', 'archive.finalStat', () => handle.stat());
    if (
      finalStat.dev !== stat.dev
      || finalStat.ino !== stat.ino
      || finalStat.size !== stat.size
      || finalStat.mtimeMs !== stat.mtimeMs
      || finalStat.ctimeMs !== stat.ctimeMs
    ) {
      throw new TaktpackError('SOURCE_CHANGED', 'archive changed while it was inspected', 'archive');
    }
    const compatible = currentVersion === undefined
      ? undefined
      : (
        compareSemVer(currentVersion, manifest.takt.minVersion) >= 0
        && (manifest.takt.maxVersion === undefined
          || compareSemVer(currentVersion, manifest.takt.maxVersion) <= 0)
      );
    result = {
      descriptor: metadata.descriptor,
      manifest,
      lockSeed: metadata.lockSeed,
      report,
      archiveSha256: archiveDigest.digest('hex'),
      compatibility: {
        status: compatible === undefined ? 'unknown' : compatible ? 'compatible' : 'incompatible',
        ...(compatible === undefined ? {} : { compatible }),
        ...(currentVersion === undefined ? {} : { currentVersion }),
        minVersion: manifest.takt.minVersion,
        ...(manifest.takt.maxVersion === undefined ? {} : { maxVersion: manifest.takt.maxVersion }),
      },
    };
  } catch (error) {
    primaryError = error instanceof TaktpackError
      || error instanceof ProjectTemplateValidationError
      ? error
      : new TaktpackError(
        'INVALID_PACK',
        'archive semantic validation failed',
        'archive',
      );
  } finally {
    try {
      ioSeam.onPhase?.('close');
    } catch (error) {
      closeFailure = error;
    }
    try {
      await handle.close();
    } catch (error) {
      // Preserve the read/stat failure that explains the invalid inspection;
      // a secondary close error must not replace it or expose file details.
      if (closeFailure === undefined) closeFailure = error;
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (closeFailure !== undefined) {
    throw normalizeInspectorIoError(closeFailure, 'archive.close');
  }
  return result!;
}

export function inspectTaktpack(
  archivePath: string,
  options: InspectTaktpackOptions = {},
): Promise<TaktpackInspectResult> {
  return inspectTaktpackWithIoSeam(archivePath, options);
}
