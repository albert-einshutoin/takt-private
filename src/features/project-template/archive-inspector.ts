import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  DEFAULT_TAKTPACK_LIMITS,
  TAKTPACK_BLOB_PREFIX,
  TAKTPACK_ENTRY_NAMES,
  type InspectTaktpackOptions,
  type TaktpackDescriptorV1,
  type TaktpackExportReportV1,
  type TaktpackInspectResult,
  type TaktpackLimits,
} from './archive-types.js';
import { validateManifestLockPair } from './binding.js';
import { validateDetectedTemplateCapabilities } from './capability-detection.js';
import { classifyProjectTemplateEntry } from './classifier-core.js';
import { TaktpackError } from './errors.js';
import { parseTemplateLock } from './lock.js';
import { parseProjectTemplateManifest } from './manifest.js';
import type {
  DetectedTemplateCapabilities,
  ProjectTemplateManifestV1,
  TemplateEntryPolicy,
  TemplateLockV1,
} from './types.js';
import { compareSemVer, requireSemVer } from './validation.js';

const TAR_BLOCK_BYTES = 512;
const ZERO_BLOCK = Buffer.alloc(TAR_BLOCK_BYTES);
const BLOB_NAME_PATTERN = /^blobs\/sha256\/([a-f0-9]{64})$/;

interface ParsedHeader {
  name: string;
  size: number;
}

interface PackMetadata {
  descriptor: TaktpackDescriptorV1;
  lock: TemplateLockV1;
}

function resolveLimits(input: Partial<TaktpackLimits> | undefined): TaktpackLimits {
  const bounded = (key: keyof TaktpackLimits): number => {
    const requested = input?.[key] ?? DEFAULT_TAKTPACK_LIMITS[key];
    if (!Number.isSafeInteger(requested) || requested < 0) {
      throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', `${key} must be a non-negative safe integer`, key);
    }
    return Math.min(requested, DEFAULT_TAKTPACK_LIMITS[key]);
  };
  return {
    maxEntries: bounded('maxEntries'),
    maxEntryBytes: bounded('maxEntryBytes'),
    maxTotalBytes: bounded('maxTotalBytes'),
    maxArchiveBytes: bounded('maxArchiveBytes'),
  };
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

function parseHeader(header: Buffer): ParsedHeader {
  if (header.subarray(257, 263).toString('binary') !== 'ustar\0'
    || header.subarray(263, 265).toString('ascii') !== '00') {
    throw new TaktpackError('INVALID_PACK', 'archive must use POSIX USTAR headers', 'header.magic');
  }
  if (parseOctal(header.subarray(148, 156), 'header.checksum') !== checksumFor(header)) {
    throw new TaktpackError('INVALID_PACK', 'USTAR header checksum mismatch', 'header.checksum');
  }
  const type = header[156];
  if (type !== 0x30) {
    throw new TaktpackError('UNSAFE_ARCHIVE_ENTRY', 'only regular USTAR file entries are allowed', 'entry.type');
  }
  if (
    !header.subarray(157, 257).equals(Buffer.alloc(100))
    || !header.subarray(345, 500).equals(Buffer.alloc(155))
    || parseOctal(header.subarray(329, 337), 'header.devmajor') !== 0
    || parseOctal(header.subarray(337, 345), 'header.devminor') !== 0
  ) {
    throw new TaktpackError('UNSAFE_ARCHIVE_ENTRY', 'link, device, or prefixed entries are not allowed', 'entry.header');
  }
  const nameEnd = header.indexOf(0, 0);
  const name = header.subarray(0, nameEnd === -1 || nameEnd > 100 ? 100 : nameEnd).toString('ascii');
  if (
    name === ''
    || !/^[\x20-\x7e]+$/.test(name)
    || (!TAKTPACK_ENTRY_NAMES.includes(name as typeof TAKTPACK_ENTRY_NAMES[number])
      && !BLOB_NAME_PATTERN.test(name))
  ) {
    throw new TaktpackError('UNSAFE_ARCHIVE_ENTRY', `unsafe or unknown archive entry: ${name}`, 'entry.name');
  }
  if (
    parseOctal(header.subarray(100, 108), 'header.mode') !== 0o644
    || parseOctal(header.subarray(108, 116), 'header.uid') !== 0
    || parseOctal(header.subarray(116, 124), 'header.gid') !== 0
    || parseOctal(header.subarray(136, 148), 'header.mtime') !== 0
  ) {
    throw new TaktpackError('INVALID_PACK', 'archive metadata is not canonical', 'entry.metadata');
  }
  return { name, size: parseOctal(header.subarray(124, 136), 'header.size') };
}

function parseJson(content: Buffer, field: string): unknown {
  try {
    return JSON.parse(content.toString('utf8')) as unknown;
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
  const expected = ['archive', 'contentAddressed', 'format', 'lock', 'version'].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)
    || record['format'] !== 'taktpack'
    || record['version'] !== '1.0'
    || record['archive'] !== 'ustar'
    || record['contentAddressed'] !== true) {
    throw new TaktpackError('INVALID_PACK', 'unsupported pack descriptor', 'pack.json');
  }
  return {
    descriptor: {
      format: 'taktpack',
      version: '1.0',
      archive: 'ustar',
      contentAddressed: true,
    },
    lock: parseTemplateLock(record['lock']),
  };
}

function parseReport(content: Buffer): TaktpackExportReportV1 {
  const value = parseJson(content, 'export-report.json');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaktpackError('INVALID_PACK', 'export report must be an object', 'export-report.json');
  }
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== '1.0'
    || typeof record['counts'] !== 'object' || record['counts'] === null
    || typeof record['excludedReasons'] !== 'object' || record['excludedReasons'] === null
    || !Array.isArray(record['warnings'])
  ) {
    throw new TaktpackError('INVALID_PACK', 'invalid export report', 'export-report.json');
  }
  const countsRecord = record['counts'] as Record<string, unknown>;
  const counts = {} as Record<TemplateEntryPolicy, number>;
  for (const policy of ['managed', 'merge', 'scaffold', 'excluded'] as const) {
    const count = countsRecord[policy];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new TaktpackError('INVALID_PACK', 'invalid export report count', `counts.${policy}`);
    }
    counts[policy] = count as number;
  }
  if (record['warnings'].length > 100
    || record['warnings'].some((warning) => typeof warning !== 'string' || warning.length > 1024)) {
    throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'export report warnings exceed limits', 'warnings');
  }
  const excludedReasons = record['excludedReasons'] as Record<string, unknown>;
  if (Object.values(excludedReasons).some((count) => !Number.isSafeInteger(count) || (count as number) < 0)) {
    throw new TaktpackError('INVALID_PACK', 'invalid excluded reason count', 'excludedReasons');
  }
  return {
    schemaVersion: '1.0',
    counts,
    excludedReasons: excludedReasons as TaktpackExportReportV1['excludedReasons'],
    warnings: record['warnings'] as string[],
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

export async function inspectTaktpack(
  archivePath: string,
  options: InspectTaktpackOptions = {},
): Promise<TaktpackInspectResult> {
  const limits = resolveLimits(options.limits);
  const handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const archiveDigest = createHash('sha256');
  let position = 0;
  let totalPayloadBytes = 0;
  let entryCount = 0;
  let metadata: PackMetadata | undefined;
  let manifest: ProjectTemplateManifestV1 | undefined;
  let report: TaktpackExportReportV1 | undefined;
  const detections: DetectedTemplateCapabilities[] = [];
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limits.maxArchiveBytes) {
      throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive file exceeds safety limits', 'archive');
    }

    const readExact = async (length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
        if (bytesRead === 0) {
          throw new TaktpackError('TRUNCATED_ARCHIVE', 'archive ended before the declared USTAR boundary');
        }
        offset += bytesRead;
      }
      position += length;
      archiveDigest.update(buffer);
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
      if (header.size > limits.maxEntryBytes) {
        throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive entry exceeds size limit', header.name);
      }
      totalPayloadBytes += header.size;
      if (totalPayloadBytes > limits.maxTotalBytes) {
        throw new TaktpackError('ARCHIVE_LIMIT_EXCEEDED', 'archive payload exceeds total size limit', 'entries');
      }

      const expectedName = entryCount <= TAKTPACK_ENTRY_NAMES.length
        ? TAKTPACK_ENTRY_NAMES[entryCount - 1]
        : manifest === undefined
          ? undefined
          : [...new Set(manifest.entries.map((entry) => entry.sha256))]
            .sort((left, right) => left.localeCompare(right, 'en-US'))[
              entryCount - TAKTPACK_ENTRY_NAMES.length - 1
            ]?.replace(/^/, TAKTPACK_BLOB_PREFIX);
      if (expectedName === undefined) {
        throw new TaktpackError('ORPHAN_BLOB', `unexpected archive entry: ${header.name}`, header.name);
      }
      if (header.name !== expectedName) {
        throw new TaktpackError('INVALID_ARCHIVE_ORDER', `expected ${expectedName}, got ${header.name}`, header.name);
      }

      // One entry is bounded independently. Blobs are discarded immediately
      // after hashing and reclassification instead of accumulating the archive.
      const content = await readExact(header.size);
      const paddingBytes = (TAR_BLOCK_BYTES - (header.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (paddingBytes > 0 && !isZeroBlock(Buffer.concat([
        await readExact(paddingBytes),
        Buffer.alloc(TAR_BLOCK_BYTES - paddingBytes),
      ]))) {
        throw new TaktpackError('INVALID_PACK', 'USTAR entry padding must be zero', header.name);
      }

      if (header.name === 'pack.json') {
        metadata = parsePackMetadata(content);
      } else if (header.name === 'manifest.json') {
        manifest = parseProjectTemplateManifest(parseJson(content, 'manifest.json'));
      } else if (header.name === 'export-report.json') {
        report = parseReport(content);
      } else {
        const match = BLOB_NAME_PATTERN.exec(header.name)!;
        const hash = createHash('sha256').update(content).digest('hex');
        if (hash !== match[1]) {
          throw new TaktpackError('HASH_MISMATCH', 'blob content does not match its content address', header.name);
        }
        for (const entry of manifest!.entries.filter((candidate) => candidate.sha256 === hash)) {
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
            throw new TaktpackError('INVALID_PACK', `blob failed semantic inspection: ${classification.reasonCode}`, entry.path);
          }
          detections.push(classification.detectedCapabilities);
        }
      }
    }
    if (metadata === undefined || manifest === undefined || report === undefined) {
      throw new TaktpackError('MISSING_ARCHIVE_ENTRY', 'archive metadata is incomplete');
    }
    const expectedEntries = TAKTPACK_ENTRY_NAMES.length
      + new Set(manifest.entries.map((entry) => entry.sha256)).size;
    if (entryCount !== expectedEntries) {
      throw new TaktpackError('MISSING_ARCHIVE_ENTRY', 'one or more content-addressed blobs are missing');
    }
    validateManifestLockPair(manifest, metadata.lock);
    validateDetectedTemplateCapabilities(manifest, detections);
    validateReportAgainstManifest(report, manifest);
    const currentVersion = options.currentTaktVersion === undefined
      ? undefined
      : requireSemVer(options.currentTaktVersion, 'currentTaktVersion');
    const compatible = currentVersion === undefined
      || (
        compareSemVer(currentVersion, manifest.takt.minVersion) >= 0
        && (manifest.takt.maxVersion === undefined
          || compareSemVer(currentVersion, manifest.takt.maxVersion) <= 0)
      );
    return {
      descriptor: metadata.descriptor,
      manifest,
      lock: metadata.lock,
      report,
      archiveSha256: archiveDigest.digest('hex'),
      compatibility: {
        compatible,
        ...(currentVersion === undefined ? {} : { currentVersion }),
        minVersion: manifest.takt.minVersion,
        ...(manifest.takt.maxVersion === undefined ? {} : { maxVersion: manifest.takt.maxVersion }),
      },
    };
  } finally {
    await handle.close();
  }
}
