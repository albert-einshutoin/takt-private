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

  it.each([
    [{ packId: HASH, entryCount: 4_097, archiveBytes: 1, dependencyCount: 0 }],
    [{ packId: HASH, entryCount: 1, archiveBytes: 32 * 1024 * 1024 + 1, dependencyCount: 0 }],
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

  it('keeps every closed error code exhaustively mapped at runtime', () => {
    for (const [code, exitCode] of Object.entries(PROJECT_TEMPLATE_CLI_ERROR_EXIT_CODES)) {
      expect(projectTemplateCliExitCodeForErrorCode(code)).toBe(exitCode);
    }
  });
});
