import { describe, expect, it, vi } from 'vitest';
import {
  ProjectTemplateCliContractError,
  createProjectTemplateCliFailure,
  createProjectTemplateCliSuccess,
  parseProjectTemplateCliMutationOptions,
  presentProjectTemplateCliEnvelope,
  projectTemplateCliExitCodeForErrorCode,
  writeProjectTemplateCliOutcome,
} from '../../features/project-template/cli-machine-contract.js';

const PLAN_ID = 'a'.repeat(64);

describe('project template CLI machine contract', () => {
  it('renders exactly one canonical JSON object followed by one newline', () => {
    const envelope = createProjectTemplateCliSuccess({
      command: 'project-template preview',
      mode: 'dry-run',
      result: { planId: PLAN_ID, changed: false },
    });

    expect(presentProjectTemplateCliEnvelope(envelope)).toBe(
      `{"command":"project-template preview","mode":"dry-run","result":{"changed":false,"planId":"${PLAN_ID}"},"schemaVersion":"1.0","status":"success","warnings":[]}\n`,
    );
    expect(presentProjectTemplateCliEnvelope(envelope).split('\n')).toHaveLength(2);
  });

  it('keeps result and error mutually exclusive and uses symbolic error codes', () => {
    const failure = createProjectTemplateCliFailure({
      command: 'project-template apply',
      mode: 'apply',
      code: 'PLAN_DRIFT',
    });

    expect(failure).toEqual({
      schemaVersion: '1.0',
      command: 'project-template apply',
      status: 'error',
      mode: 'apply',
      error: { code: 'PLAN_DRIFT' },
      warnings: [],
    });
    expect('result' in failure).toBe(false);
  });

  it('rejects forged envelopes instead of trusting TypeScript at runtime', () => {
    const forged = {
      schemaVersion: '1.0',
      command: 'project-template preview',
      status: 'success',
      mode: 'dry-run',
      result: { changed: false },
      error: { code: 'INTERNAL', detail: '/Users/alice/.takt/cache' },
      warnings: [],
    };

    expect(() => presentProjectTemplateCliEnvelope(
      forged as never,
    )).toThrow(ProjectTemplateCliContractError);
  });

  it.each([
    [{ absolutePath: '/Users/example/.takt/cache' }],
    [{ credential: 'github-token' }],
    [{ nested: { approvalEvidence: 'receipt-1' } }],
    [{ leaseId: 'lease-1' }],
  ])('rejects machine fields that could disclose local or authority data: %j', (result) => {
    expect(() => createProjectTemplateCliSuccess({
      command: 'project-template preview',
      mode: 'dry-run',
      result,
    })).toThrow(ProjectTemplateCliContractError);
  });

  it.each([
    ['non-finite number', { value: Number.NaN }],
    ['negative zero', { value: -0 }],
    ['undefined', { value: undefined }],
    ['sparse array', Array(2)],
    ['symbol key', { [Symbol('hidden')]: 'value' }],
  ])('rejects unsafe JSON graph shape: %s', (_label, result) => {
    expect(() => createProjectTemplateCliSuccess({
      command: 'project-template preview',
      mode: 'dry-run',
      result,
    })).toThrow(ProjectTemplateCliContractError);
  });

  it('rejects getters, proxies, cycles, and bounded-resource overflow', () => {
    const getter = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 'must-not-run',
    });
    const proxy = new Proxy({ value: 1 }, {});
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 70; index += 1) deep = { deep };
    const tooManyNodes = Array.from({ length: 10_001 }, () => ({}));
    const tooManyBytes = { value: 'x'.repeat(1_048_577) };

    for (const result of [getter, proxy, cycle, deep, tooManyNodes, tooManyBytes]) {
      expect(() => createProjectTemplateCliSuccess({
        command: 'project-template preview',
        mode: 'dry-run',
        result,
      })).toThrow(ProjectTemplateCliContractError);
    }
  });

  it.each([
    ['INVALID_ARGUMENT', 20],
    ['REVIEW_REQUIRED', 21],
    ['PLAN_DRIFT', 22],
    ['ACTIVE_RUN', 23],
    ['NETWORK_FAILED', 24],
    ['RECOVERY_REQUIRED', 25],
    ['PROTOCOL_ERROR', 70],
    ['UNRECOGNIZED_UPSTREAM_CODE', 70],
  ] as const)('maps %s to stable exit category %i', (code, expected) => {
    expect(projectTemplateCliExitCodeForErrorCode(code)).toBe(expected);
  });

  it.each([
    [[], { mode: 'dry-run', force: false }],
    [['--dry-run'], { mode: 'dry-run', force: false }],
    [['--force'], { mode: 'dry-run', force: true }],
    [['--apply', '--expected-plan-id', PLAN_ID], {
      mode: 'apply', expectedPlanId: PLAN_ID, force: false,
    }],
    [['--force', '--apply', '--expected-plan-id', PLAN_ID], {
      mode: 'apply', expectedPlanId: PLAN_ID, force: true,
    }],
  ] as const)('parses mutation arguments %j', (argv, expected) => {
    expect(parseProjectTemplateCliMutationOptions(argv)).toEqual(expected);
  });

  it.each([
    [['--apply'], 'MISSING_EXPECTED_PLAN_ID'],
    [['--apply', '--dry-run', '--expected-plan-id', PLAN_ID], 'MUTUALLY_EXCLUSIVE_OPTIONS'],
    [['--expected-plan-id', PLAN_ID], 'EXPECTED_PLAN_ID_REQUIRES_APPLY'],
    [['--apply', '--expected-plan-id', 'latest'], 'INVALID_EXPECTED_PLAN_ID'],
    [['--unknown'], 'UNKNOWN_OPTION'],
  ] as const)('rejects unsafe mutation arguments %j', (argv, code) => {
    expect(() => parseProjectTemplateCliMutationOptions(argv)).toThrow(
      expect.objectContaining({ code, exitCode: 20 }),
    );
  });

  it('calls the top-level writer once and leaves exit handling to the caller', async () => {
    const write = vi.fn(() => undefined);
    const outcome = {
      envelope: createProjectTemplateCliSuccess({
        command: 'project-template preview',
        mode: 'dry-run',
        result: { changed: false },
      }),
      exitCode: 0 as const,
    };

    await writeProjectTemplateCliOutcome(outcome, write);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/^\{.*\}\n$/));
  });

  it('does not write an outcome whose exit category contradicts its envelope', async () => {
    const write = vi.fn(() => undefined);
    const outcome = {
      envelope: createProjectTemplateCliFailure({
        command: 'project-template apply',
        mode: 'apply',
        code: 'PLAN_DRIFT',
      }),
      exitCode: 0 as const,
    };

    await expect(writeProjectTemplateCliOutcome(outcome, write)).rejects.toThrow(
      ProjectTemplateCliContractError,
    );
    expect(write).not.toHaveBeenCalled();
  });
});
