import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAKTPACK_LIMITS,
  TAKTPACK_ENTRY_NAMES,
  TaktpackError,
  canonicalizeTaktpackJson,
} from '../../features/project-template/index.js';

describe('taktpack v1 archive contract', () => {
  it('serializes JSON with recursively sorted object keys and a trailing newline', () => {
    expect(canonicalizeTaktpackJson({
      z: 1,
      nested: { beta: true, alpha: ['x', { z: 2, a: 1 }] },
      a: null,
    })).toBe(
      '{"a":null,"nested":{"alpha":["x",{"a":1,"z":2}],"beta":true},"z":1}\n',
    );
  });

  it('exposes the only allowed metadata entries in canonical order', () => {
    expect(TAKTPACK_ENTRY_NAMES).toEqual([
      'pack.json',
      'manifest.json',
      'export-report.json',
    ]);
  });

  it('uses bounded defaults for hostile archive inspection', () => {
    expect(DEFAULT_TAKTPACK_LIMITS).toEqual({
      maxEntries: 4_099,
      maxEntryBytes: 1024 * 1024,
      maxTotalBytes: 32 * 1024 * 1024,
      maxArchiveBytes: 40 * 1024 * 1024,
    });
  });

  it('provides stable machine-readable archive error codes', () => {
    const error = new TaktpackError('UNSAFE_ARCHIVE_ENTRY', 'not a regular file', 'entry.type');
    expect(error).toMatchObject({
      name: 'TaktpackError',
      code: 'UNSAFE_ARCHIVE_ENTRY',
      field: 'entry.type',
    });
  });
});
