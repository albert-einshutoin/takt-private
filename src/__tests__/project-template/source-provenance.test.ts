import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProjectTemplateValidationError } from '../../features/project-template/errors.js';
import {
  calculateProjectTemplateSourceProvenanceSha256,
  MAX_PROJECT_TEMPLATE_SOURCE_PROVENANCE_BYTES,
  parseProjectTemplateSourceProvenance,
  parseProjectTemplateSourceProvenanceJson,
  PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
  serializeProjectTemplateSourceProvenance,
} from '../../features/project-template/source-provenance.js';

const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const SHA256_C = 'c'.repeat(64);
const SHA256_D = 'd'.repeat(64);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function validProvenance(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    source: {
      owner: 'acme',
      repo: 'takt-template',
      repositoryUrl: 'https://github.com/acme/takt-template',
      canonicalSource: 'github:acme/takt-template@refs/tags/v2.1.0',
      requestedRef: 'refs/tags/v2.1.0',
      releaseTag: 'v2.1.0',
      commit: COMMIT,
      descriptorSha256: SHA256_A,
    },
    archive: {
      sha256: SHA256_B,
      version: '2.1.0',
      manifestSha256: SHA256_C,
    },
    dependencyVerification: {
      method: 'github-ref-to-commit-v1',
      declarationSha256: SHA256_D,
      count: 2,
    },
  };
}

function expectProvenanceError(
  value: unknown,
  code?: ProjectTemplateValidationError['code'],
): void {
  try {
    parseProjectTemplateSourceProvenance(value);
    throw new Error('expected source provenance validation to fail');
  } catch (error) {
    expect((error as ProjectTemplateValidationError).name)
      .toBe('ProjectTemplateValidationError');
    if (code !== undefined) {
      expect((error as ProjectTemplateValidationError).code).toBe(code);
    }
  }
}

describe('project template source provenance', () => {
  it('uses the dedicated third companion lock path', () => {
    expect(PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH)
      .toBe('.takt-template-source-lock.json');
  });

  it('snapshots, deeply freezes, canonically serializes, and hashes v1', () => {
    const input = validProvenance();
    const parsed = parseProjectTemplateSourceProvenance(input);
    const canonical = JSON.stringify(validProvenance(), null, 2);

    (input['source'] as Record<string, unknown>)['commit'] = 'f'.repeat(40);
    (input['archive'] as Record<string, unknown>)['version'] = '9.0.0';

    expect(parsed).toEqual(validProvenance());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.source)).toBe(true);
    expect(Object.isFrozen(parsed.archive)).toBe(true);
    expect(Object.isFrozen(parsed.dependencyVerification)).toBe(true);
    expect(serializeProjectTemplateSourceProvenance(validProvenance()))
      .toBe(canonical);
    expect(calculateProjectTemplateSourceProvenanceSha256(validProvenance()))
      .toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'));
  });

  it('accepts only the exact canonical JSON byte representation', () => {
    const canonical = serializeProjectTemplateSourceProvenance(validProvenance());

    expect(parseProjectTemplateSourceProvenanceJson(canonical))
      .toEqual(validProvenance());
    expect(() => parseProjectTemplateSourceProvenanceJson(`${canonical}\n`))
      .toThrow(/canonical/i);
    expect(() => parseProjectTemplateSourceProvenanceJson(
      canonical.replace('  "source"', '\t"source"'),
    )).toThrow(/canonical/i);
  });

  it('rejects oversized and malformed UTF-8 input before semantic parsing', () => {
    expect(() => parseProjectTemplateSourceProvenanceJson(
      'x'.repeat(MAX_PROJECT_TEMPLATE_SOURCE_PROVENANCE_BYTES + 1),
    )).toThrow(/byte limit/i);
    expect(() => parseProjectTemplateSourceProvenanceJson(
      new Uint8Array([0xc3, 0x28]),
    )).toThrow(/UTF-8/i);
  });

  it.each([
    ['credential', 'credential', 'ghp_secret'],
    ['token', 'token', 'ghp_secret'],
    ['absolute path', 'cachePath', '/Users/alice/.cache/takt'],
    ['receipt key', 'receiptKey', SHA256_A],
    ['timestamp', 'downloadedAt', '2026-08-01T00:00:00.000Z'],
    ['release numeric id', 'releaseId', 42],
  ])('rejects prohibited persisted authority: %s', (_label, key, value) => {
    const provenance = validProvenance();
    provenance[key] = value;
    expectProvenanceError(provenance, 'UNKNOWN_KEY');
  });

  it('rejects prohibited authority at every nested boundary', () => {
    for (const field of ['source', 'archive', 'dependencyVerification']) {
      const provenance = validProvenance();
      (provenance[field] as Record<string, unknown>)['receiptKey'] = SHA256_A;
      expectProvenanceError(provenance, 'UNKNOWN_KEY');
    }
  });

  it.each([
    ['repositoryUrl owner mismatch', (value: Record<string, unknown>) => {
      source(value)['repositoryUrl'] = 'https://github.com/other/takt-template';
    }],
    ['canonicalSource repository mismatch', (value: Record<string, unknown>) => {
      source(value)['canonicalSource'] =
        'github:other/takt-template@refs/tags/v2.1.0';
    }],
    ['canonicalSource ref mismatch', (value: Record<string, unknown>) => {
      source(value)['canonicalSource'] =
        'github:acme/takt-template@refs/tags/v2.2.0';
    }],
    ['requested ref and release tag mismatch', (value: Record<string, unknown>) => {
      source(value)['requestedRef'] = 'refs/tags/v2.2.0';
    }],
    ['version and release tag mismatch', (value: Record<string, unknown>) => {
      archive(value)['version'] = '2.2.0';
    }],
  ])('rejects cross-field identity aliases: %s', (_label, mutate) => {
    const provenance = validProvenance();
    mutate(provenance);
    expectProvenanceError(provenance);
  });

  it.each([
    ['uppercase commit', () => COMMIT.toUpperCase(), 'commit'],
    ['short commit', () => COMMIT.slice(1), 'commit'],
    ['uppercase hash', () => SHA256_A.toUpperCase(), 'descriptorSha256'],
    ['short hash', () => SHA256_A.slice(1), 'descriptorSha256'],
  ])('rejects noncanonical immutable identity: %s', (_label, invalid, field) => {
    const provenance = validProvenance();
    source(provenance)[field] = invalid();
    expectProvenanceError(provenance);
  });

  it('requires exact dependency verification evidence', () => {
    for (const mutate of [
      (evidence: Record<string, unknown>) => {
        evidence['method'] = 'caller-asserted';
      },
      (evidence: Record<string, unknown>) => {
        evidence['declarationSha256'] = SHA256_D.toUpperCase();
      },
      (evidence: Record<string, unknown>) => {
        evidence['count'] = -1;
      },
      (evidence: Record<string, unknown>) => {
        evidence['count'] = 129;
      },
    ]) {
      const provenance = validProvenance();
      mutate(provenance['dependencyVerification'] as Record<string, unknown>);
      expectProvenanceError(provenance);
    }
  });

  it('rejects proxies, accessors, inherited records, arrays, and symbols', () => {
    const proxy = new Proxy(validProvenance(), {});
    expectProvenanceError(proxy, 'NON_PLAIN_OBJECT');

    const accessor = validProvenance();
    let getterCalls = 0;
    Object.defineProperty(accessor, 'source', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return validProvenance()['source'];
      },
    });
    expectProvenanceError(accessor);
    expect(getterCalls).toBe(0);

    expectProvenanceError(Object.create(validProvenance()));
    expectProvenanceError([]);

    const symbol = validProvenance();
    symbol[Symbol('secret') as unknown as string] = 'secret';
    expectProvenanceError(symbol, 'UNKNOWN_KEY');
  });

  it('never reflects prohibited values in validation errors', () => {
    const secret = 'ghp_DO_NOT_LOG_ME';
    const provenance = validProvenance();
    provenance['token'] = secret;

    try {
      parseProjectTemplateSourceProvenance(provenance);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

function source(value: Record<string, unknown>): Record<string, unknown> {
  return value['source'] as Record<string, unknown>;
}

function archive(value: Record<string, unknown>): Record<string, unknown> {
  return value['archive'] as Record<string, unknown>;
}
