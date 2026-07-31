import { describe, expect, it } from 'vitest';
import {
  parseProjectTemplateRepertoireStrictLock,
} from '../../infra/repertoire/project-template-repertoire-strict-lock.js';

function validLock(overrides: Partial<Record<
  'source' | 'ref' | 'commit' | 'imported_at',
  string
>> = {}): Buffer {
  const values = {
    source: 'github:acme/repertoire',
    ref: 'v1.2.3',
    commit: '0123456789abcdef0123456789abcdef01234567',
    imported_at: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
  return Buffer.from(
    `source: ${values.source}\n`
    + `ref: ${values.ref}\n`
    + `commit: ${values.commit}\n`
    + `imported_at: ${values.imported_at}\n`,
  );
}

describe('project template repertoire strict lock G3.1', () => {
  it('returns an immutable canonical snapshot and derives version from ref', () => {
    const lock = parseProjectTemplateRepertoireStrictLock(validLock());
    expect(lock).toEqual({
      source: 'github:acme/repertoire',
      ref: 'v1.2.3',
      version: '1.2.3',
      commit: '0123456789abcdef0123456789abcdef01234567',
      importedAt: '2026-07-31T00:00:00.000Z',
    });
    expect(Object.isFrozen(lock)).toBe(true);

    expect(parseProjectTemplateRepertoireStrictLock(
      validLock({ ref: '2.0.0' }),
    ).version).toBe('2.0.0');
  });

  it.each([
    ['duplicate', Buffer.from('source: github:acme/repertoire\nsource: github:evil/repo\nref: v1.0.0\ncommit: 0123456789abcdef0123456789abcdef01234567\nimported_at: 2026-07-31T00:00:00.000Z\n')],
    ['anchor', Buffer.from('source: &source github:acme/repertoire\nref: v1.0.0\ncommit: 0123456789abcdef0123456789abcdef01234567\nimported_at: 2026-07-31T00:00:00.000Z\n')],
    ['alias', Buffer.from('source: &source github:acme/repertoire\nref: *source\ncommit: 0123456789abcdef0123456789abcdef01234567\nimported_at: 2026-07-31T00:00:00.000Z\n')],
    ['merge', Buffer.from('source: github:acme/repertoire\nref: v1.0.0\ncommit: 0123456789abcdef0123456789abcdef01234567\nimported_at: 2026-07-31T00:00:00.000Z\n<<: {}\n')],
    ['custom tag', Buffer.from('source: !secret github:acme/repertoire\nref: v1.0.0\ncommit: 0123456789abcdef0123456789abcdef01234567\nimported_at: 2026-07-31T00:00:00.000Z\n')],
    ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), validLock()])],
  ])('rejects YAML ambiguity: %s', (_label, bytes) => {
    expect(() => parseProjectTemplateRepertoireStrictLock(bytes))
      .toThrow(expect.objectContaining({ code: 'INVALID_YAML' }));
  });

  it.each([
    ['extra key', Buffer.concat([validLock(), Buffer.from('extra: value\n')])],
    ['missing key', Buffer.from('source: github:acme/repertoire\n')],
    ['sequence', Buffer.from('- source\n- ref\n')],
    ['non-string', Buffer.from('source: github:acme/repertoire\nref: v1.0.0\ncommit: 123\nimported_at: 2026-07-31T00:00:00.000Z\n')],
  ])('rejects non-exact lock structure: %s', (_label, bytes) => {
    expect(() => parseProjectTemplateRepertoireStrictLock(bytes))
      .toThrow(expect.objectContaining({ code: 'INVALID_LOCK' }));
  });

  it.each([
    ['uppercase source', { source: 'github:Acme/repertoire' }],
    ['git suffix', { source: 'github:acme/repertoire.git' }],
    ['branch', { ref: 'main' }],
    ['HEAD', { ref: 'HEAD' }],
    ['refs tag', { ref: 'refs/tags/v1.2.3' }],
    ['sha ref', { ref: '0123456789abcdef0123456789abcdef01234567' }],
    ['uppercase commit', { commit: '0123456789ABCDEF0123456789ABCDEF01234567' }],
    ['short commit', { commit: '01234567' }],
    ['offset date', { imported_at: '2026-07-31T09:00:00.000+09:00' }],
    ['normalized date', { imported_at: '2026-07-31T00:00:00Z' }],
    ['invalid date', { imported_at: '2026-02-30T00:00:00.000Z' }],
  ])('rejects malformed canonical provenance: %s', (_label, override) => {
    expect(() => parseProjectTemplateRepertoireStrictLock(validLock(override)))
      .toThrow(expect.objectContaining({ code: 'INVALID_LOCK' }));
  });

  it('keeps canonical source and ref mismatches as later-stage material', () => {
    const lock = parseProjectTemplateRepertoireStrictLock(validLock({
      source: 'github:other/package',
      ref: '9.8.7',
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
    }));
    expect(lock).toMatchObject({
      source: 'github:other/package',
      version: '9.8.7',
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
    });
  });

  it('rejects oversized, invalid UTF-8, proxied, accessor, and coercible inputs', () => {
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    const proxied = new Proxy(validLock(), {});
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    const accessor = {};
    Object.defineProperty(accessor, 'byteLength', {
      get() {
        throw new Error('must not read');
      },
    });
    const coercible = {
      toString() {
        throw new Error('must not coerce');
      },
    };
    expect(() => parseProjectTemplateRepertoireStrictLock(
      Buffer.alloc(64 * 1024 + 1),
    )).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(() => parseProjectTemplateRepertoireStrictLock(invalidUtf8))
      .toThrow(expect.objectContaining({ code: 'INVALID_ENCODING' }));
    for (const value of [proxied, shared, accessor, coercible]) {
      expect(() => parseProjectTemplateRepertoireStrictLock(value as never))
        .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });

  it('redacts lock bytes from fixed public failures', () => {
    const secret = 'top-secret-lock-value';
    let failure: unknown;
    try {
      parseProjectTemplateRepertoireStrictLock(Buffer.from(secret));
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).not.toContain(secret);
  });
});
