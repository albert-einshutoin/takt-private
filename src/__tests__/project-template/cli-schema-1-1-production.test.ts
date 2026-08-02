import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import {
  registerProjectTemplateCommands,
  type ProjectTemplateCliCommandAdapterDependencies,
  type ProjectTemplateCliCommandRequest,
} from '../../app/cli/projectTemplateCommands.js';
import {
  createProjectTemplateCliSuccess,
  type ProjectTemplateCliOutcome,
} from '../../features/project-template/cli-machine-contract.js';
import {
  parseProjectTemplateCliV1_1EnvelopeJson,
  type ProjectTemplateCliV1_1Outcome,
} from '../../features/project-template/cli-machine-contract-v1-1.js';

const PACK_ID = 'a'.repeat(64);
const FIXTURE_PATH = join(
  import.meta.dirname,
  '../fixtures/project-template/cli-schema-1.1/inspect.json',
);

function schemaV1Outcome(): ProjectTemplateCliOutcome {
  return {
    envelope: createProjectTemplateCliSuccess({
      command: 'project-template inspect',
      mode: 'dry-run',
      result: {
        packId: PACK_ID,
        entryCount: 0,
        archiveBytes: 0,
        dependencyCount: 0,
        readiness: 'ready',
        reviewCodes: [],
      },
    }),
    exitCode: 0,
  };
}

function schemaV1_1Outcome(): ProjectTemplateCliV1_1Outcome {
  return {
    envelope: parseProjectTemplateCliV1_1EnvelopeJson(
      readFileSync(FIXTURE_PATH, 'utf8'),
    ),
    exitCode: 0,
  };
}

function harness() {
  const requests: ProjectTemplateCliCommandRequest[] = [];
  const writes: string[] = [];
  const exitCodes: number[] = [];
  const dispatch = vi.fn(async (request: ProjectTemplateCliCommandRequest) => {
    requests.push(request);
    return request.schemaVersion === '1.1'
      ? schemaV1_1Outcome()
      : schemaV1Outcome();
  });
  const dependencies: ProjectTemplateCliCommandAdapterDependencies = {
    dispatch,
    async dispose() {},
    writeStdout(chunk) { writes.push(chunk); },
    setExitCode(code) { exitCodes.push(code); },
    installInterrupt() { return () => {}; },
    cwd() { return '/workspace'; },
    currentTaktVersion: '0.48.0',
  };
  const program = new Command().name('takt').exitOverride();
  program.configureOutput({ writeErr() {} });
  program.option('--cwd <path>');
  registerProjectTemplateCommands(program, dependencies);
  return { dispatch, exitCodes, program, requests, writes };
}

describe('project-template schema 1.1 production negotiation', () => {
  it('keeps the omitted schema option on the byte-stable schema 1.0 output', async () => {
    const value = harness();

    await value.program.parseAsync([
      'node', 'takt', 'project-template', 'inspect', './team.taktpack', '--json',
    ]);

    expect(value.requests).toHaveLength(1);
    expect(value.requests[0]!.schemaVersion).toBe('1.0');
    expect(value.writes).toEqual([
      `{"command":"project-template inspect","mode":"dry-run","result":{"archiveBytes":0,"dependencyCount":0,"entryCount":0,"packId":"${PACK_ID}","readiness":"ready","reviewCodes":[]},"schemaVersion":"1.0","status":"success","warnings":[]}\n`,
    ]);
    expect(value.exitCodes).toEqual([0]);
  });

  it('passes an explicit schema 1.1 request through to the production dispatcher', async () => {
    const value = harness();

    await value.program.parseAsync([
      'node', 'takt', 'project-template', 'inspect', './team.taktpack',
      '--schema-version', '1.1', '--json',
    ]);

    expect(value.requests).toHaveLength(1);
    expect(value.requests[0]!.schemaVersion).toBe('1.1');
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      schemaVersion: '1.1',
      result: { detail: { identity: { packVersion: '1.2.3' } } },
    });
    expect(value.exitCodes).toEqual([0]);
  });

  it.each([
    ['unsupported', ['--schema-version', '2.0']],
    ['duplicate', ['--schema-version', '1.1', '--schema-version', '1.1']],
  ])('fails closed for an %s schema selection before dispatch', async (_label, options) => {
    const value = harness();

    await value.program.parseAsync([
      'node', 'takt', 'project-template', 'inspect', './team.taktpack',
      ...options, '--json',
    ]);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(value.writes).toHaveLength(1);
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      status: 'error',
      command: 'project-template inspect',
      mode: 'dry-run',
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(value.exitCodes).toEqual([20]);
  });
});
