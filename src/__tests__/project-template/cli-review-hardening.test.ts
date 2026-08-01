import { describe, expect, it } from 'vitest';
import {
  ProjectTemplateCliContractError,
  createProjectTemplateCliFailure,
  createProjectTemplateCliSuccess,
} from '../../features/project-template/cli-machine-contract.js';
import {
  serializeProjectTemplateCliJson,
} from '../../features/project-template/cli-bounded-json.js';
import { startProjectTemplateCliLifecycle } from '../../features/project-template/cli-lifecycle.js';

const HASH = 'a'.repeat(64);

describe('project template CLI independent review hardening', () => {
  it.each([
    ['project-template export', { packId: HASH, entryCount: 2, byteLength: 512 }],
    ['project-template inspect', { packId: HASH, entryCount: 2, valid: true }],
    ['project-template diff', { planId: HASH, changeCount: 2, conflictCount: 0 }],
    ['project-template apply', { planId: HASH, applied: true }],
    ['project-template update', { planId: HASH, updateAvailable: true }],
    ['project-template rollback', { planId: HASH, rolledBack: true }],
    ['project-template list', { templateIds: ['base', 'team.default'] }],
  ] as const)('accepts the closed success DTO for %s', (command, result) => {
    expect(createProjectTemplateCliSuccess({
      command,
      mode: command === 'project-template apply' ? 'apply' : 'dry-run',
      result,
    }).result).toEqual(result);
  });

  it.each([
    [{ packId: HASH, entryCount: 1, valid: true, message: '/Users/alice/.takt' }],
    [{ packId: HASH, entryCount: 1, valid: true, providerError: { status: 500 } }],
    [{ packId: ['gh', 'p_', 'x'.repeat(36)].join(''), entryCount: 1, valid: true }],
  ])('rejects arbitrary or authority-bearing inspect results: %j', (result) => {
    expect(() => createProjectTemplateCliSuccess({
      command: 'project-template inspect',
      mode: 'dry-run',
      result,
    })).toThrow(ProjectTemplateCliContractError);
  });

  it('rejects unknown error and warning codes', () => {
    expect(() => createProjectTemplateCliFailure({
      command: 'project-template inspect',
      mode: 'dry-run',
      code: 'PROVIDER_SAID_NO',
    })).toThrow(ProjectTemplateCliContractError);
    expect(() => createProjectTemplateCliSuccess({
      command: 'project-template inspect',
      mode: 'dry-run',
      result: { packId: HASH, entryCount: 1, valid: true },
      warnings: [{ code: 'PROVIDER_WARNING' }],
    })).toThrow(ProjectTemplateCliContractError);
  });

  it('returns a deeply immutable success snapshot', () => {
    const envelope = createProjectTemplateCliSuccess({
      command: 'project-template list',
      mode: 'dry-run',
      result: { templateIds: ['base'] },
    });

    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.result)).toBe(true);
    expect(Object.isFrozen((envelope.result as { templateIds: string[] }).templateIds)).toBe(true);
  });

  it('bounds huge strings and array lengths before expensive traversal', () => {
    expect(() => serializeProjectTemplateCliJson('x'.repeat(1_048_577))).toThrow(
      ProjectTemplateCliContractError,
    );
    expect(() => serializeProjectTemplateCliJson(new Array(1_000_000_000))).toThrow(
      ProjectTemplateCliContractError,
    );
  });

  it('canonically serializes ten thousand reverse-ordered keys within bounds', () => {
    const fixture: Record<string, number> = {};
    for (let index = 9_999; index >= 0; index -= 1) {
      fixture[`key${index.toString().padStart(5, '0')}`] = index;
    }

    const serialized = serializeProjectTemplateCliJson(fixture);

    expect(serialized.startsWith('{"key00000":0,')).toBe(true);
    expect(Object.keys(JSON.parse(serialized) as object)).toHaveLength(10_000);
  });

  it('validates and freezes a handler outcome before lifecycle return', async () => {
    const execution = startProjectTemplateCliLifecycle({
      command: 'project-template list',
      mode: 'dry-run',
      dispose: () => undefined,
      handle: async () => ({
        envelope: createProjectTemplateCliSuccess({
          command: 'project-template list',
          mode: 'dry-run',
          result: { templateIds: ['base'] },
        }),
        exitCode: 0,
      }),
    });

    const outcome = await execution.result;
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.envelope)).toBe(true);
    expect(Object.isFrozen((outcome.envelope as { result: object }).result)).toBe(true);
  });
});
