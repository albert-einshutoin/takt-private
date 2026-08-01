import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTemplateCliSuccess,
  type ProjectTemplateCliCommand,
  type ProjectTemplateCliMode,
  type ProjectTemplateCliOutcome,
} from '../../features/project-template/cli-machine-contract.js';
import {
  registerProjectTemplateCommands,
  type ProjectTemplateCliCommandAdapterDependencies,
  type ProjectTemplateCliCommandRequest,
} from '../../app/cli/projectTemplateCommands.js';

const PLAN_ID = 'a'.repeat(64);

function outcome(
  command: ProjectTemplateCliCommand,
  mode: ProjectTemplateCliMode,
): ProjectTemplateCliOutcome {
  const result = command === 'project-template list'
    ? { installed: false, cohortId: 'b'.repeat(64), backupIds: [], recoveryState: 'clean' }
    : command === 'project-template inspect'
      ? {
        packId: 'b'.repeat(64), entryCount: 1, archiveBytes: 1,
        dependencyCount: 0, readiness: 'ready', reviewCodes: [],
      }
      : command === 'project-template apply' && mode === 'apply'
        ? { planId: PLAN_ID, applied: true, backupId: 'backup-safe', recoveryState: 'clean' }
        : {
          planId: PLAN_ID, changeCount: 1, conflictCount: 0,
          dependencyCount: 0, readiness: 'ready', reviewCodes: [],
        };
  return {
    envelope: createProjectTemplateCliSuccess({ command, mode, result } as never),
    exitCode: 0,
  };
}

function harness() {
  const writes: string[] = [];
  const requests: ProjectTemplateCliCommandRequest[] = [];
  const admissions: string[] = [];
  const dispatch = vi.fn(async (
    request: ProjectTemplateCliCommandRequest,
    context: { signal: AbortSignal; admitMutation(): void },
  ) => {
    requests.push(request);
    if (request.mutation?.mode === 'apply') {
      context.admitMutation();
      admissions.push(request.command);
    }
    return outcome(request.command, request.mutation?.mode ?? 'dry-run');
  });
  const dependencies: ProjectTemplateCliCommandAdapterDependencies = {
    dispatch,
    async dispose() {},
    writeStdout(chunk) { writes.push(chunk); },
    setExitCode() {},
    installInterrupt() { return () => {}; },
    cwd() { return '/workspace'; },
    currentTaktVersion: '0.48.0',
  };
  const program = new Command().name('takt').exitOverride();
  program.option('--cwd <path>');
  registerProjectTemplateCommands(program, dependencies);
  return { admissions, dispatch, program, requests, writes };
}

describe('project-template CLI command adapter', () => {
  it('registers the seven-command help and closed option matrix', () => {
    const { program } = harness();
    const group = program.commands.find((command) => command.name() === 'project-template')!;
    expect(group.commands.map((command) => command.name())).toEqual([
      'inspect', 'list', 'export', 'diff', 'apply', 'update', 'rollback',
    ]);
    expect(group.helpInformation()).toContain('--cwd <path>');
    for (const command of group.commands) {
      expect(command.helpInformation()).toContain('--cwd <path>');
      expect(command.helpInformation()).toContain('--json');
    }
    for (const name of ['export', 'apply', 'update', 'rollback']) {
      const help = group.commands.find((command) => command.name() === name)!
        .helpInformation();
      expect(help).toContain('--apply');
      expect(help).toContain('--expected-plan-id <sha256>');
      expect(help).toContain('--force');
    }
  });

  it('dispatches canonical GitHub and local sources without exposing authority', async () => {
    const remote = harness();
    await remote.program.parseAsync([
      'node', 'takt', '--cwd', '/root-cwd', 'project-template', 'diff',
      'github:owner/template@v1.0.0', '--cwd', '/command-cwd', '--json',
    ]);
    const local = harness();
    await local.program.parseAsync([
      'node', 'takt', 'project-template', 'apply', './template.taktpack',
      '--apply', '--expected-plan-id', PLAN_ID,
    ]);
    const requests = [...remote.requests, ...local.requests];
    const writes = [...remote.writes, ...local.writes];

    expect(requests).toMatchObject([
      { command: 'project-template diff', cwd: '/command-cwd', source: {
        kind: 'github', value: 'github:owner/template@v1.0.0',
      } },
      { command: 'project-template apply', cwd: '/workspace', source: {
        kind: 'local', value: '/workspace/template.taktpack',
      }, mutation: { mode: 'apply', expectedPlanId: PLAN_ID, force: false } },
    ]);
    expect(writes).toHaveLength(2);
    expect(writes.every((chunk) => JSON.parse(chunk).schemaVersion === '1.0')).toBe(true);
    expect(writes.join('')).not.toMatch(/authority|receipt|approval|cache/iu);
  });

  it('rejects force-only and expected-plan drift options before dispatch', async () => {
    const { dispatch, program, writes } = harness();
    await program.parseAsync([
      'node', 'takt', 'project-template', 'apply', './template.taktpack', '--force',
    ]);
    await program.parseAsync([
      'node', 'takt', 'project-template', 'update',
      'github:owner/template@v1.0.0', '--expected-plan-id', PLAN_ID,
    ]);

    expect(dispatch).not.toHaveBeenCalled();
    expect(writes.map((chunk) => JSON.parse(chunk).error.code)).toEqual([
      'INVALID_ARGUMENT', 'EXPECTED_PLAN_ID_REQUIRES_APPLY',
    ]);
  });
});
