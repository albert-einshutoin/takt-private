import { TextDecoder, types } from 'node:util';
import { describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { generateLockFile } from '../../features/repertoire/lock-file.js';
import {
  parseProjectTemplateRepertoireStrictLock,
  ProjectTemplateRepertoireStrictLockError,
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
  it('normalizes hostile runtime error codes without prototype setters', () => {
    const original = Object.getOwnPropertyDescriptor(
      ProjectTemplateRepertoireStrictLockError.prototype,
      'code',
    );
    let calls = 0;
    let value: ProjectTemplateRepertoireStrictLockError;
    try {
      Object.defineProperty(
        ProjectTemplateRepertoireStrictLockError.prototype,
        'code',
        {
          configurable: true,
          set() {
            calls += 1;
          },
        },
      );
      value = new ProjectTemplateRepertoireStrictLockError(Symbol('hostile') as never);
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(
          ProjectTemplateRepertoireStrictLockError.prototype,
          'code',
        );
      } else {
        Object.defineProperty(
          ProjectTemplateRepertoireStrictLockError.prototype,
          'code',
          original,
        );
      }
    }
    expect(calls).toBe(0);
    expect(value!.code).toBe('INVALID_ARGUMENT');
  });

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

  it('accepts the exact YAML emitted by the repertoire lock writer', () => {
    const writerOutput = stringifyYaml(generateLockFile({
      source: 'github:acme/repertoire',
      ref: 'v1.2.3',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      importedAt: new Date('2026-07-31T00:00:00.000Z'),
    }));
    expect(parseProjectTemplateRepertoireStrictLock(
      Buffer.from(writerOutput),
    )).toMatchObject({
      source: 'github:acme/repertoire',
      ref: 'v1.2.3',
      commit: '0123456789abcdef0123456789abcdef01234567',
      importedAt: '2026-07-31T00:00:00.000Z',
    });
  });

  it.each([
    ['leading comment', Buffer.concat([
      Buffer.from('# generated lock\n'),
      validLock(),
    ])],
    ['reordered keys', Buffer.from(
      'ref: v1.2.3\n'
      + 'source: github:acme/repertoire\n'
      + 'commit: 0123456789abcdef0123456789abcdef01234567\n'
      + 'imported_at: 2026-07-31T00:00:00.000Z\n',
    )],
    ['quoted scalar', Buffer.from(
      'source: "github:acme/repertoire"\n'
      + 'ref: v1.2.3\n'
      + 'commit: 0123456789abcdef0123456789abcdef01234567\n'
      + 'imported_at: 2026-07-31T00:00:00.000Z\n',
    )],
  ])('rejects non-canonical but valid YAML: %s', (_label, bytes) => {
    expect(() => parseProjectTemplateRepertoireStrictLock(bytes))
      .toThrow(expect.objectContaining({ code: 'INVALID_LOCK' }));
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

  it('uses captured decoder, regexp, string, and SAB predicates', () => {
    const originalDecode = TextDecoder.prototype.decode;
    const originalTest = RegExp.prototype.test;
    const originalStartsWith = String.prototype.startsWith;
    const originalSlice = String.prototype.slice;
    const originalCharCodeAt = String.prototype.charCodeAt;
    const originalIndexOf = String.prototype.indexOf;
    const originalProxy = types.isProxy;
    const originalShared = types.isSharedArrayBuffer;
    const originalUint8Array = types.isUint8Array;
    let calls = 0;
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    const invalidCanonical = validLock({
      source: 'github:Acme/repertoire',
      ref: 'main',
      commit: 'short',
    });
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    const canonical = validLock();
    const thrown: unknown[] = [];
    let parsed: ReturnType<
    typeof parseProjectTemplateRepertoireStrictLock
    > | undefined;
    try {
      TextDecoder.prototype.decode = function poisonedDecode() {
        calls += 1;
        return validLock().toString();
      };
      RegExp.prototype.test = function poisonedTest() {
        calls += 1;
        return true;
      };
      String.prototype.startsWith = function poisonedStartsWith() {
        calls += 1;
        return false;
      };
      String.prototype.slice = function poisonedSlice() {
        calls += 1;
        return '1.2.3';
      };
      String.prototype.charCodeAt = function poisonedCharCodeAt() {
        calls += 1;
        return 0;
      };
      String.prototype.indexOf = function poisonedIndexOf() {
        calls += 1;
        return -1;
      };
      types.isProxy = function poisonedProxy() {
        calls += 1;
        return false;
      };
      types.isSharedArrayBuffer = function poisonedShared() {
        calls += 1;
        return false;
      };
      types.isUint8Array = function poisonedUint8Array() {
        calls += 1;
        return true;
      };
      for (const input of [invalidUtf8, invalidCanonical, shared]) {
        try {
          parseProjectTemplateRepertoireStrictLock(input);
        } catch (error) {
          thrown.push(error);
        }
      }
      parsed = parseProjectTemplateRepertoireStrictLock(canonical);
    } finally {
      TextDecoder.prototype.decode = originalDecode;
      RegExp.prototype.test = originalTest;
      String.prototype.startsWith = originalStartsWith;
      String.prototype.slice = originalSlice;
      String.prototype.charCodeAt = originalCharCodeAt;
      String.prototype.indexOf = originalIndexOf;
      types.isProxy = originalProxy;
      types.isSharedArrayBuffer = originalShared;
      types.isUint8Array = originalUint8Array;
    }
    expect(calls).toBe(0);
    expect(thrown).toEqual([
      expect.objectContaining({ code: 'INVALID_ENCODING' }),
      expect.objectContaining({ code: 'INVALID_LOCK' }),
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    ]);
    expect(parsed).toMatchObject({
      source: 'github:acme/repertoire',
      version: '1.2.3',
    });
  });

  it('uses a setter-safe YAML worklist and rejects depth beyond 32', () => {
    const originalZero = Object.getOwnPropertyDescriptor(
      Array.prototype,
      '0',
    );
    let setterCalls = 0;
    let nested = 'leaf: value\n';
    for (let depth = 0; depth < 33; depth += 1) {
      const indented = nested.replace(/^/gm, '  ');
      nested = `level${depth}:\n${indented}`;
    }
    const bytes = Buffer.from(
      'source: github:acme/repertoire\n'
      + 'ref: v1.2.3\n'
      + 'commit: 0123456789abcdef0123456789abcdef01234567\n'
      + 'imported_at: 2026-07-31T00:00:00.000Z\n'
      + `extra:\n${nested}`,
    );
    let thrown: unknown;
    try {
      Object.defineProperty(Array.prototype, '0', {
        configurable: true,
        set() {
          setterCalls += 1;
        },
      });
      try {
        parseProjectTemplateRepertoireStrictLock(bytes);
      } catch (error) {
        thrown = error;
      }
    } finally {
      if (originalZero === undefined) {
        Reflect.deleteProperty(Array.prototype, '0');
      } else {
        Object.defineProperty(Array.prototype, '0', originalZero);
      }
    }
    expect(setterCalls).toBe(0);
    expect(thrown).toEqual(expect.objectContaining({
      code: 'INVALID_YAML',
    }));
  });
});
