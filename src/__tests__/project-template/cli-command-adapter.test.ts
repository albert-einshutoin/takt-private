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
  settleProjectTemplateParserFailure,
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

function harness(overrides: Partial<ProjectTemplateCliCommandAdapterDependencies> = {}) {
  const writes: string[] = [];
  const exitCodes: number[] = [];
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
  const dispose = vi.fn(async () => undefined);
  const dependencies: ProjectTemplateCliCommandAdapterDependencies = {
    dispatch,
    dispose,
    writeStdout(chunk) { writes.push(chunk); },
    setExitCode(code) { exitCodes.push(code); },
    installInterrupt() { return () => {}; },
    cwd() { return '/workspace'; },
    currentTaktVersion: '0.48.0',
    ...overrides,
  };
  const program = new Command().name('takt').exitOverride();
  program.configureOutput({ writeErr() {} });
  program.option('--cwd <path>');
  registerProjectTemplateCommands(program, dependencies);
  return { admissions, dispatch, dispose, exitCodes, program, requests, writes };
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

  it('returns one canonical INVALID_ARGUMENT envelope for a JSON group invocation', async () => {
    const value = harness();
    await value.program.parseAsync([
      'node', 'takt', 'project-template', '--json', '--cwd=/workspace',
    ]);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(value.dispose).toHaveBeenCalledOnce();
    expect(value.exitCodes).toEqual([20]);
    expect(value.writes).toHaveLength(1);
    expect(value.writes[0]!.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      schemaVersion: '1.0', status: 'error',
      command: 'project-template', mode: 'dry-run',
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('keeps the always-machine INVALID_ARGUMENT contract without --json', async () => {
    const value = harness();
    await value.program.parseAsync(['node', 'takt', 'project-template']);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(value.dispose).toHaveBeenCalledOnce();
    expect(value.exitCodes).toEqual([20]);
    expect(value.writes).toHaveLength(1);
    expect(value.writes[0]!.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      schemaVersion: '1.0', status: 'error',
      command: 'project-template', mode: 'dry-run',
      error: { code: 'INVALID_ARGUMENT' },
    });
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

  it('treats an exact current Takt version as a runtime assertion, not an override', async () => {
    const value = harness();
    await value.program.parseAsync([
      'node', 'takt', 'project-template', 'apply', './template.taktpack',
      '--current-takt-version', '0.48.0',
    ]);

    expect(value.dispatch).toHaveBeenCalledOnce();
    expect(value.requests[0]).toMatchObject({
      command: 'project-template apply',
      currentTaktVersion: '0.48.0',
    });
  });

  it.each([
    ['apply higher', 'apply', './template.taktpack', '99.0.0'],
    ['apply lower', 'apply', './template.taktpack', '0.1.0'],
    ['apply invalid', 'apply', './template.taktpack', 'not-semver'],
    ['update higher', 'update', 'github:owner/template@v1.0.0', '99.0.0'],
    ['update lower', 'update', 'github:owner/template@v1.0.0', '0.1.0'],
    ['update invalid', 'update', 'github:owner/template@v1.0.0', 'not-semver'],
  ] as const)('rejects a mismatched runtime assertion before %s mutation', async (
    _label,
    command,
    source,
    assertedVersion,
  ) => {
    const value = harness();
    await value.program.parseAsync([
      'node', 'takt', 'project-template', command, source,
      '--current-takt-version', assertedVersion,
      '--apply', '--expected-plan-id', PLAN_ID, '--force',
    ]);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(value.admissions).toEqual([]);
    expect(value.writes).toHaveLength(1);
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      status: 'error', mode: 'apply', error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('rejects a changed runtime assertion between dry-run and exact-plan apply', async () => {
    const preview = harness();
    await preview.program.parseAsync([
      'node', 'takt', 'project-template', 'apply', './template.taktpack',
      '--current-takt-version', '0.48.0', '--dry-run',
    ]);
    const apply = harness();
    await apply.program.parseAsync([
      'node', 'takt', 'project-template', 'apply', './template.taktpack',
      '--current-takt-version', '99.0.0', '--apply',
      '--expected-plan-id', PLAN_ID, '--force',
    ]);

    expect(preview.dispatch).toHaveBeenCalledOnce();
    expect(apply.dispatch).not.toHaveBeenCalled();
    expect(apply.admissions).toEqual([]);
    expect(JSON.parse(apply.writes[0]!)).toMatchObject({
      status: 'error', command: 'project-template apply', mode: 'apply',
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it.each([
    ['inspect', './template.taktpack'],
    ['diff', './template.taktpack'],
  ] as const)('rejects mismatched runtime assertions for read-only %s too', async (
    command,
    source,
  ) => {
    const value = harness();
    await value.program.parseAsync([
      'node', 'takt', 'project-template', command, source,
      '--current-takt-version', '99.0.0',
    ]);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      status: 'error', mode: 'dry-run', error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it.each([
    [
      'inspect higher then exact', 'inspect', './template.taktpack',
      ['--current-takt-version', '99.0.0', '--current-takt-version', '0.48.0'],
      'dry-run',
    ],
    [
      'diff exact then higher', 'diff', './template.taktpack',
      ['--current-takt-version', '0.48.0', '--current-takt-version', '99.0.0'],
      'dry-run',
    ],
    [
      'apply exact then exact', 'apply', './template.taktpack',
      ['--current-takt-version', '0.48.0', '--current-takt-version', '0.48.0'],
      'apply',
    ],
    [
      'update attached then separated', 'update', 'github:owner/template@v1.0.0',
      ['--current-takt-version=0.48.0', '--current-takt-version', '99.0.0'],
      'apply',
    ],
  ] as const)('rejects duplicate runtime assertions before %s dispatch', async (
    _label,
    command,
    source,
    assertions,
    expectedMode,
  ) => {
    const value = harness();
    const mutation = expectedMode === 'apply'
      ? ['--apply', '--expected-plan-id', PLAN_ID, '--force']
      : [];
    await value.program.parseAsync([
      'node', 'takt', 'project-template', command, source,
      ...assertions, ...mutation,
    ]);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(value.admissions).toEqual([]);
    expect(value.exitCodes).toEqual([20]);
    expect(value.writes).toHaveLength(1);
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      status: 'error', command: `project-template ${command}`,
      mode: expectedMode, error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('does not count an attached option value that equals the option name', async () => {
    const value = harness({ currentTaktVersion: '--current-takt-version' });
    await value.program.parseAsync([
      'node', 'takt', 'project-template', 'diff', './template.taktpack',
      '--current-takt-version=--current-takt-version',
    ]);

    expect(value.dispatch).toHaveBeenCalledOnce();
    expect(value.requests[0]).toMatchObject({
      command: 'project-template diff',
      currentTaktVersion: '--current-takt-version',
    });
  });

  it('rejects force-only and expected-plan drift options before dispatch', async () => {
    const force = harness();
    await force.program.parseAsync([
      'node', 'takt', 'project-template', 'apply', './template.taktpack', '--force',
    ]);
    const expected = harness();
    await expected.program.parseAsync([
      'node', 'takt', 'project-template', 'update',
      'github:owner/template@v1.0.0', '--expected-plan-id', PLAN_ID,
    ]);
    const writes = [...force.writes, ...expected.writes];

    expect(force.dispatch).not.toHaveBeenCalled();
    expect(expected.dispatch).not.toHaveBeenCalled();
    expect(writes.map((chunk) => JSON.parse(chunk).error.code)).toEqual([
      'INVALID_ARGUMENT', 'EXPECTED_PLAN_ID_REQUIRES_APPLY',
    ]);
    expect(force.dispose).toHaveBeenCalledOnce();
    expect(expected.dispose).toHaveBeenCalledOnce();
  });

  it('maps unknown options to one stable envelope and still disposes', async () => {
    const value = harness();
    await value.program.parseAsync([
      'node', 'takt', 'project-template', 'list', '--credential-path', '/secret',
    ]);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(value.dispose).toHaveBeenCalledOnce();
    expect(value.writes).toHaveLength(1);
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      status: 'error', error: { code: 'UNKNOWN_OPTION' },
    });
    expect(value.writes[0]).not.toContain('/secret');
  });

  it('maps excess operands to UNKNOWN_OPTION without Commander stderr', async () => {
    const value = harness();
    await value.program.parseAsync([
      'node', 'takt', 'project-template', 'list', 'unexpected-value',
    ]);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(value.dispose).toHaveBeenCalledOnce();
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      error: { code: 'UNKNOWN_OPTION' },
    });
  });

  it.each([
    ['export output', ['project-template', 'export', 'invalid.txt']],
    ['apply source', ['project-template', 'apply']],
    ['update source', ['project-template', 'update', './local.taktpack']],
    ['rollback backup', ['project-template', 'rollback']],
  ] as const)('preserves apply mode for an invalid %s', async (_label, prefix) => {
    const value = harness();
    await value.program.parseAsync([
      'node', 'takt', ...prefix,
      '--apply', '--expected-plan-id', PLAN_ID,
    ]);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      mode: 'apply', error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it.each([
    ['preview', '--pack-version'],
    ['preview', '--min-takt-version'],
    ['apply', '--pack-version'],
    ['apply', '--min-takt-version'],
  ] as const)('rejects malformed export SemVer in %s for %s before dispatch', async (
    mode,
    option,
  ) => {
    const value = harness();
    const mutationArgs = mode === 'apply'
      ? ['--apply', '--expected-plan-id', PLAN_ID]
      : [];
    await value.program.parseAsync([
      'node', 'takt', 'project-template', 'export', 'template.taktpack',
      '--pack-version', option === '--pack-version' ? 'not-semver' : '1.0.0',
      '--min-takt-version', option === '--min-takt-version' ? 'not-semver' : '0.48.0',
      '--source-commit', 'a'.repeat(40),
      ...mutationArgs,
    ]);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(value.admissions).toEqual([]);
    expect(value.exitCodes).toEqual([20]);
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      command: 'project-template export',
      mode: mode === 'apply' ? 'apply' : 'dry-run',
      status: 'error',
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('installs SIGINT before synchronous mutation admission can begin', async () => {
    let listenerInstalled = false;
    const value = harness({
      installInterrupt(interrupt) {
        listenerInstalled = true;
        interrupt();
        return () => {};
      },
      async dispatch(_request, context) {
        expect(listenerInstalled).toBe(true);
        context.admitMutation();
        return outcome('project-template apply', 'apply');
      },
    });
    await value.program.parseAsync([
      'node', 'takt', 'project-template', 'apply', './template.taktpack',
      '--apply', '--expected-plan-id', PLAN_ID,
    ]);

    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      status: 'error', error: { code: 'INTERRUPTED' },
    });
    expect(value.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ['root', ['--credential-path', '/secret', 'project-template', 'list']],
    ['group', ['project-template', '--credential-path', '/secret', 'list']],
    ['subcommand', ['project-template', 'unexpected']],
  ] as const)('settles %s parser failures through the registered lifecycle', async (_name, args) => {
    const value = harness();
    await expect(value.program.parseAsync(['node', 'takt', ...args])).rejects.toBeDefined();

    await expect(settleProjectTemplateParserFailure(
      value.program, 'project-template list', 'dry-run',
    )).resolves.toBe(true);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(value.dispose).toHaveBeenCalledOnce();
    expect(value.writes).toHaveLength(1);
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      status: 'error', error: { code: 'UNKNOWN_OPTION' },
    });
    expect(value.writes[0]).not.toContain('/secret');
  });

  it('closes installInterrupt failure through disposal and one envelope', async () => {
    const value = harness({
      installInterrupt() { throw new Error('listener install failed'); },
    });

    await value.program.parseAsync(['node', 'takt', 'project-template', 'list']);

    expect(value.dispatch).not.toHaveBeenCalled();
    expect(value.dispose).toHaveBeenCalledOnce();
    expect(value.writes).toHaveLength(1);
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      status: 'error', error: { code: 'INTERNAL' },
    });
  });

  it('classifies interrupt-listener removal failure before the single write', async () => {
    const value = harness({
      installInterrupt() {
        return () => { throw new Error('listener removal failed'); };
      },
    });

    await value.program.parseAsync(['node', 'takt', 'project-template', 'list']);

    expect(value.dispatch).toHaveBeenCalledOnce();
    expect(value.dispose).toHaveBeenCalledOnce();
    expect(value.writes).toHaveLength(1);
    expect(JSON.parse(value.writes[0]!)).toMatchObject({
      status: 'error', error: { code: 'INTERNAL' },
    });
  });
});
