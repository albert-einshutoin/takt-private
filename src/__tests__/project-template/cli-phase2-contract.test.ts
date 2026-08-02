import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_TEMPLATE_CLI_ERROR_EXIT_CODES,
  ProjectTemplateCliContractError,
  createProjectTemplateCliSuccess,
  parseProjectTemplateCliEnvelopeJson,
  presentProjectTemplateCliEnvelope,
  projectTemplateCliExitCodeForErrorCode,
} from '../../features/project-template/cli-machine-contract.js';
import {
  serializeProjectTemplateCliJson,
  snapshotProjectTemplateCliJson,
} from '../../features/project-template/cli-bounded-json.js';
import { DEFAULT_TAKTPACK_LIMITS } from '../../features/project-template/archive-types.js';
import { PROJECT_TEMPLATE_TRANSACTION_LIMITS } from '../../features/project-template/transaction-limits.js';

const HASH = 'b'.repeat(64);

function runWithPoison(
  receiver: object,
  key: PropertyKey,
  operation: () => unknown,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(receiver, key)!;
  Object.defineProperty(receiver, key, {
    ...descriptor,
    value: () => { throw new Error(`poisoned ${String(key)}`); },
  });
  try {
    return operation();
  } finally {
    Object.defineProperty(receiver, key, descriptor);
  }
}

function rejectAllWithPoison(receiver: object, key: PropertyKey): boolean {
  const unknownCommand = JSON.stringify({
    schemaVersion: '1.0', command: 'project-template provider-debug',
    status: 'error', mode: 'dry-run', error: { code: 'INTERNAL' }, warnings: [],
  });
  const unknownCode = JSON.stringify({
    schemaVersion: '1.0', command: 'project-template inspect',
    status: 'error', mode: 'dry-run', error: { code: 'PROVIDER_ERROR' }, warnings: [],
  });
  const pathPackId = {
    command: 'project-template inspect' as const,
    mode: 'dry-run' as const,
    result: {
      packId: '/Users/alice/.takt/pack', entryCount: 1, archiveBytes: 1,
      dependencyCount: 0, readiness: 'ready' as const, reviewCodes: [],
    },
  };
  const valid = JSON.stringify({
    schemaVersion: '1.0',
    command: 'project-template inspect',
    status: 'success',
    mode: 'dry-run',
    result: {
      packId: HASH, entryCount: 1, archiveBytes: 1, dependencyCount: 0,
      readiness: 'review-required', reviewCodes: ['REVIEW_REQUIRED'],
    },
    warnings: [{ code: 'PARTIAL_RESULT' }],
  });
  return runWithPoison(receiver, key, () => {
    const operations = [
      () => parseProjectTemplateCliEnvelopeJson(unknownCommand),
      () => parseProjectTemplateCliEnvelopeJson(unknownCode),
      () => createProjectTemplateCliSuccess(pathPackId as never),
    ];
    for (let index = 0; index < operations.length; index += 1) {
      try {
        operations[index]!();
        return false;
      } catch (error) {
        if (!(error instanceof ProjectTemplateCliContractError)) return false;
      }
    }
    return parseProjectTemplateCliEnvelopeJson(valid).status === 'success';
  }) as boolean;
}

describe('project template CLI phase 2 contract', () => {
  it.each([
    [Reflect, 'apply'],
    [Reflect, 'ownKeys'],
    [Object, 'getOwnPropertyDescriptor'],
    [Object, 'getPrototypeOf'],
    [Array, 'isArray'],
    [JSON, 'stringify'],
    [Buffer, 'byteLength'],
    [types, 'isProxy'],
  ] as const)('uses captured serializer intrinsic %s', (receiver, key) => {
    expect(runWithPoison(receiver, key, () => (
      serializeProjectTemplateCliJson({ z: 1, a: 2 })
    ))).toBe('{"a":2,"z":1}\n');
  });

  it('uses captured JSON.parse when creating an immutable snapshot', () => {
    expect(runWithPoison(JSON, 'parse', () => (
      snapshotProjectTemplateCliJson({ value: 1 })
    ))).toEqual({ value: 1 });
  });

  it.each([
    ['Array.isArray', Array, 'isArray'],
    ['Object.keys', Object, 'keys'],
    ['Object.hasOwn', Object, 'hasOwn'],
    ['Object.freeze', Object, 'freeze'],
    ['Number.isSafeInteger', Number, 'isSafeInteger'],
    ['Array.push', Array.prototype, 'push'],
    ['Array.iterator', Array.prototype, Symbol.iterator],
    ['Set.has', Set.prototype, 'has'],
    ['Set.add', Set.prototype, 'add'],
    ['RegExp.test', RegExp.prototype, 'test'],
  ] as const)('fails closed with poisoned schema intrinsic %s', (_label, receiver, key) => {
    expect(rejectAllWithPoison(receiver, key)).toBe(true);
  });

  it('round-trips canonical machine JSON through the public bounded parser', () => {
    const envelope = createProjectTemplateCliSuccess({
      command: 'project-template inspect',
      mode: 'dry-run',
      result: {
        packId: HASH,
        entryCount: 4_096,
        archiveBytes: 32 * 1024 * 1024,
        dependencyCount: 128,
        readiness: 'review-required',
        reviewCodes: ['REVIEW_REQUIRED'],
      },
    });
    const json = presentProjectTemplateCliEnvelope(envelope);

    expect(parseProjectTemplateCliEnvelopeJson(json)).toEqual(envelope);
    expect(presentProjectTemplateCliEnvelope(
      parseProjectTemplateCliEnvelopeJson(json),
    )).toBe(json);
  });

  it.each([
    '{"schemaVersion":"2.0"}\n',
    '{"schemaVersion":"1.0"}\n{}',
    `${' '.repeat(1_048_577)}{}`,
  ])('fails closed for invalid bounded JSON text', (text) => {
    expect(() => parseProjectTemplateCliEnvelopeJson(text)).toThrow(
      ProjectTemplateCliContractError,
    );
  });

  it('rejects apply mode for read-only inspect/diff/list envelopes', () => {
    for (const command of [
      'project-template inspect',
      'project-template diff',
      'project-template list',
    ]) {
      expect(() => parseProjectTemplateCliEnvelopeJson(JSON.stringify({
        schemaVersion: '1.0',
        command,
        status: 'error',
        mode: 'apply',
        error: { code: 'INVALID_ARGUMENT' },
        warnings: [],
      }))).toThrow(ProjectTemplateCliContractError);
    }
  });

  it.each([
    [{ packId: HASH, entryCount: 4_097, archiveBytes: 1, dependencyCount: 0 }],
    [{ packId: HASH, entryCount: 1, archiveBytes: 40 * 1024 * 1024 + 1, dependencyCount: 0 }],
    [{ packId: HASH, entryCount: 1, archiveBytes: 1, dependencyCount: 129 }],
  ])('rejects inspect counts beyond matching core limits: %j', (partial) => {
    expect(() => createProjectTemplateCliSuccess({
      command: 'project-template inspect',
      mode: 'dry-run',
      result: {
        ...partial,
        readiness: 'ready',
        reviewCodes: [],
      } as never,
    })).toThrow(ProjectTemplateCliContractError);
  });

  it('accepts archive overhead above cohort bytes without relaxing transaction bytes', () => {
    expect(PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxBytes).toBe(32 * 1024 * 1024);
    expect(DEFAULT_TAKTPACK_LIMITS.maxArchiveBytes).toBe(40 * 1024 * 1024);
    expect(() => createProjectTemplateCliSuccess({
      command: 'project-template inspect',
      mode: 'dry-run',
      result: {
        packId: HASH,
        entryCount: 1,
        archiveBytes: PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxBytes + 1,
        dependencyCount: 0,
        readiness: 'ready',
        reviewCodes: [],
      },
    })).not.toThrow();
  });

  it('keeps every closed error code exhaustively mapped at runtime', () => {
    for (const [code, exitCode] of Object.entries(PROJECT_TEMPLATE_CLI_ERROR_EXIT_CODES)) {
      expect(projectTemplateCliExitCodeForErrorCode(code)).toBe(exitCode);
    }
  });
});
