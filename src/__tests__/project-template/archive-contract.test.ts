import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAKTPACK_LIMITS,
  TAKTPACK_ENTRY_NAMES,
  TaktpackError,
  canonicalizeTaktpackJson,
} from '../../features/project-template/index.js';
import * as publicApi from '../../index.js';
import type {
  TaktpackInspectResult,
  TaktpackLockSeedV1,
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
      maxPackJsonBytes: 4 * 1024 * 1024,
      maxManifestJsonBytes: 4 * 1024 * 1024,
      maxExportReportJsonBytes: 1024 * 1024,
      maxBlobBytes: 1024 * 1024,
      maxTotalBytes: 32 * 1024 * 1024,
      maxArchiveBytes: 40 * 1024 * 1024,
    });
  });

  it('provides stable machine-readable archive error codes', () => {
    const nameDescriptor = Object.getOwnPropertyDescriptor(
      TaktpackError.prototype,
      'name',
    );
    let setterCalls = 0;
    let reentryCalls = 0;
    let attemptedReentry = false;
    let nestedError: TaktpackError | undefined;
    let error: TaktpackError | undefined;
    try {
      Object.defineProperty(TaktpackError.prototype, 'name', {
        configurable: true,
        set() {
          setterCalls += 1;
          if (attemptedReentry) return;
          attemptedReentry = true;
          reentryCalls += 1;
          nestedError = new TaktpackError(
            'INVALID_PACK',
            'nested archive error',
          );
        },
      });
      error = new TaktpackError(
        'UNSAFE_ARCHIVE_ENTRY',
        'not a regular file',
        'entry.type',
      );
    } finally {
      if (nameDescriptor === undefined) {
        Reflect.deleteProperty(TaktpackError.prototype, 'name');
      } else {
        Object.defineProperty(
          TaktpackError.prototype,
          'name',
          nameDescriptor,
        );
      }
    }
    expect(setterCalls).toBe(0);
    expect(reentryCalls).toBe(0);
    expect(nestedError).toBeUndefined();
    expect(Object.hasOwn(error!, 'name')).toBe(true);
    expect(error).toMatchObject({
      name: 'TaktpackError',
      code: 'UNSAFE_ARCHIVE_ENTRY',
      field: 'entry.type',
    });
  });

  it('publishes export and inspect as structured library APIs', () => {
    expect(publicApi.createProjectTemplateExportPlan).toBeTypeOf('function');
    expect(publicApi.writeTaktpack).toBeTypeOf('function');
    expect(publicApi.inspectTaktpack).toBeTypeOf('function');
  });

  it('keeps an inspected lock seed structurally distinct from a formal lock', () => {
    const seed: TaktpackLockSeedV1 = {
      kind: 'project-template-lock-seed',
      schemaVersion: '1.0',
      packVersion: '1.0.0',
      source: {
        kind: 'local',
        uri: '.',
        ref: 'workspace',
        commit: 'a'.repeat(40),
      },
      capabilities: [],
      entries: [],
    };
    const resultKey: keyof TaktpackInspectResult = 'lockSeed';

    expect(seed.kind).toBe('project-template-lock-seed');
    expect(resultKey).toBe('lockSeed');
  });
});
