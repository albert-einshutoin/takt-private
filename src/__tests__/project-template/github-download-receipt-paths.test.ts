import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createGithubTemplateDownloadReceiptTempName,
  deriveGithubTemplateDownloadReceiptPaths,
  parseGithubTemplateDownloadReceiptTempName,
} from '../../features/project-template/github-download-receipt-paths.js';

const RECEIPT_KEY = 'a'.repeat(64);
const ARCHIVE_SHA256 = 'b'.repeat(64);
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const CACHE_ROOT = resolve('/private/takt-cache');

describe('GitHub template receipt private path contract', () => {
  it('derives artifact and multi-provenance receipt paths from hashes only', () => {
    const paths = deriveGithubTemplateDownloadReceiptPaths({
      cacheRoot: CACHE_ROOT,
      receiptKey: RECEIPT_KEY,
      archiveSha256: ARCHIVE_SHA256,
    });

    expect(paths).toEqual({
      artifactDirectory: join(CACHE_ROOT, 'sha256'),
      artifactPath: join(
        CACHE_ROOT,
        'sha256',
        `${ARCHIVE_SHA256}.taktpack`,
      ),
      receiptAncestors: [
        join(CACHE_ROOT, 'receipts'),
        join(CACHE_ROOT, 'receipts', 'v1'),
        join(CACHE_ROOT, 'receipts', 'v1', 'sha256'),
        join(CACHE_ROOT, 'receipts', 'v1', 'sha256', 'aa'),
      ],
      receiptDirectory: join(
        CACHE_ROOT,
        'receipts',
        'v1',
        'sha256',
        'aa',
      ),
      receiptPath: join(
        CACHE_ROOT,
        'receipts',
        'v1',
        'sha256',
        'aa',
        `${RECEIPT_KEY}.json`,
      ),
    });
    expect(Object.isFrozen(paths)).toBe(true);
    expect(Object.isFrozen(paths.receiptAncestors)).toBe(true);
  });

  it.each([
    ['relative root', {
      cacheRoot: 'cache',
      receiptKey: RECEIPT_KEY,
      archiveSha256: ARCHIVE_SHA256,
    }],
    ['non-canonical root', {
      cacheRoot: `${CACHE_ROOT}/../takt-cache`,
      receiptKey: RECEIPT_KEY,
      archiveSha256: ARCHIVE_SHA256,
    }],
    ['receipt traversal', {
      cacheRoot: CACHE_ROOT,
      receiptKey: '../receipt',
      archiveSha256: ARCHIVE_SHA256,
    }],
    ['uppercase receipt key', {
      cacheRoot: CACHE_ROOT,
      receiptKey: 'A'.repeat(64),
      archiveSha256: ARCHIVE_SHA256,
    }],
    ['archive traversal', {
      cacheRoot: CACHE_ROOT,
      receiptKey: RECEIPT_KEY,
      archiveSha256: '../../archive',
    }],
    ['uppercase archive hash', {
      cacheRoot: CACHE_ROOT,
      receiptKey: RECEIPT_KEY,
      archiveSha256: 'B'.repeat(64),
    }],
    ['unknown path', {
      cacheRoot: CACHE_ROOT,
      receiptKey: RECEIPT_KEY,
      archiveSha256: ARCHIVE_SHA256,
      receiptPath: '/tmp/caller-controlled.json',
    }],
    ['symbol', {
      cacheRoot: CACHE_ROOT,
      receiptKey: RECEIPT_KEY,
      archiveSha256: ARCHIVE_SHA256,
      [Symbol('path')]: '/tmp/caller-controlled.json',
    }],
    ['accessor', Object.defineProperty({
      receiptKey: RECEIPT_KEY,
      archiveSha256: ARCHIVE_SHA256,
    }, 'cacheRoot', {
      get() {
        throw new Error('ghp_receipt_path_secret');
      },
    })],
    ['Proxy', new Proxy({}, {
      ownKeys() {
        throw new Error('ghp_receipt_path_secret');
      },
    })],
  ])('rejects invalid derived-path input: %s', (_label, value) => {
    const error = (() => {
      try {
        deriveGithubTemplateDownloadReceiptPaths(value);
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it('generates and parses one strict temporary receipt name', () => {
    const name = createGithubTemplateDownloadReceiptTempName({
      pid: 1234,
      uuid: UUID,
      receiptKey: RECEIPT_KEY,
    });
    expect(name).toBe(`.tmp.1234.${UUID}.${RECEIPT_KEY}`);
    const parsed = parseGithubTemplateDownloadReceiptTempName(name);
    expect(parsed).toEqual({
      pid: 1234,
      uuid: UUID,
      receiptKey: RECEIPT_KEY,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ['zero PID', { pid: 0, uuid: UUID, receiptKey: RECEIPT_KEY }],
    ['fractional PID', { pid: 1.5, uuid: UUID, receiptKey: RECEIPT_KEY }],
    ['unsafe PID', {
      pid: Number.MAX_SAFE_INTEGER + 1,
      uuid: UUID,
      receiptKey: RECEIPT_KEY,
    }],
    ['uppercase UUID', {
      pid: 1,
      uuid: UUID.toUpperCase(),
      receiptKey: RECEIPT_KEY,
    }],
    ['non-v4 UUID', {
      pid: 1,
      uuid: '123e4567-e89b-12d3-a456-426614174000',
      receiptKey: RECEIPT_KEY,
    }],
    ['invalid receipt key', {
      pid: 1,
      uuid: UUID,
      receiptKey: '../receipt',
    }],
    ['unknown field', {
      pid: 1,
      uuid: UUID,
      receiptKey: RECEIPT_KEY,
      path: '/tmp/receipt',
    }],
    ['accessor', Object.defineProperty({
      uuid: UUID,
      receiptKey: RECEIPT_KEY,
    }, 'pid', {
      get() {
        throw new Error('ghp_receipt_temp_secret');
      },
    })],
    ['Proxy', new Proxy({}, {
      ownKeys() {
        throw new Error('ghp_receipt_temp_secret');
      },
    })],
  ])('rejects invalid temp generation input: %s', (_label, value) => {
    const error = (() => {
      try {
        createGithubTemplateDownloadReceiptTempName(value);
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it.each([
    '.tmp.0.123e4567-e89b-42d3-a456-426614174000.'
      + 'a'.repeat(64),
    '.tmp.01.123e4567-e89b-42d3-a456-426614174000.'
      + 'a'.repeat(64),
    '.tmp.1.123E4567-E89B-42D3-A456-426614174000.'
      + 'a'.repeat(64),
    '.tmp.1.123e4567-e89b-12d3-a456-426614174000.'
      + 'a'.repeat(64),
    '.tmp.1.123e4567-e89b-42d3-a456-426614174000.'
      + 'A'.repeat(64),
    '.tmp.1.123e4567-e89b-42d3-a456-426614174000.'
      + 'a'.repeat(64) + '.extra',
    '../.tmp.1.123e4567-e89b-42d3-a456-426614174000.'
      + 'a'.repeat(64),
    '',
    {},
    new Proxy({}, {}),
  ])('rejects a non-canonical temp name: %s', (value) => {
    const error = (() => {
      try {
        parseGithubTemplateDownloadReceiptTempName(value);
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String((error as Error).message)).not.toContain('secret');
  });
});
