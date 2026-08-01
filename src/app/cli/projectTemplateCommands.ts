import { resolve } from 'node:path';
import type { Command } from 'commander';
import { parseProjectTemplateGithubSourceSpec } from '../../features/project-template/github-source-spec.js';
import { ProjectTemplateCliContractError } from '../../features/project-template/cli-contract-error.js';
import {
  createProjectTemplateCliFailure,
  parseProjectTemplateCliMutationOptions,
  projectTemplateCliExitCodeForErrorCode,
  writeProjectTemplateCliOutcome,
  type ProjectTemplateCliCommand,
  type ProjectTemplateCliErrorCode,
  type ProjectTemplateCliMutationOptions,
  type ProjectTemplateCliOutcome,
} from '../../features/project-template/cli-machine-contract.js';
import {
  startProjectTemplateCliLifecycle,
  type ProjectTemplateCliLifecycleContext,
} from '../../features/project-template/cli-lifecycle.js';

export type ProjectTemplateCliCommandSource =
  | { readonly kind: 'local'; readonly value: string }
  | { readonly kind: 'github'; readonly value: string };

export interface ProjectTemplateCliCommandRequest {
  readonly command: ProjectTemplateCliCommand;
  readonly cwd: string;
  readonly json: boolean;
  readonly source?: ProjectTemplateCliCommandSource;
  readonly outputPath?: string;
  readonly backupId?: string;
  readonly currentTaktVersion: string;
  readonly mutation?: ProjectTemplateCliMutationOptions;
  readonly exportMetadata?: {
    readonly packVersion?: string;
    readonly minTaktVersion?: string;
    readonly sourceCommit?: string;
  };
}

export interface ProjectTemplateCliCommandAdapterDependencies {
  readonly dispatch: (
    request: ProjectTemplateCliCommandRequest,
    context: ProjectTemplateCliLifecycleContext,
  ) => Promise<ProjectTemplateCliOutcome>;
  readonly dispose: () => void | Promise<void>;
  readonly writeStdout: (chunk: string) => void | Promise<void>;
  readonly setExitCode: (code: number) => void;
  readonly installInterrupt: (interrupt: () => void) => () => void;
  readonly cwd: () => string;
  readonly currentTaktVersion: string;
}

interface MutationFlags {
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly expectedPlanId?: string;
}

interface CommonFlags extends MutationFlags {
  readonly cwd?: string;
  readonly json?: boolean;
  readonly currentTaktVersion?: string;
  readonly packVersion?: string;
  readonly minTaktVersion?: string;
  readonly sourceCommit?: string;
}

function failure(
  command: ProjectTemplateCliCommand,
  mode: 'dry-run' | 'apply',
  code: ProjectTemplateCliErrorCode,
): ProjectTemplateCliOutcome {
  return {
    envelope: createProjectTemplateCliFailure({ command, mode, code }),
    exitCode: projectTemplateCliExitCodeForErrorCode(code),
  };
}

function mutation(
  command: ProjectTemplateCliCommand,
  flags: MutationFlags,
): ProjectTemplateCliMutationOptions | ProjectTemplateCliOutcome {
  if (flags.force === true && flags.apply !== true) {
    return failure(command, 'dry-run', 'INVALID_ARGUMENT');
  }
  const argv: string[] = [];
  if (flags.apply === true) argv.push('--apply');
  if (flags.dryRun === true) argv.push('--dry-run');
  if (flags.force === true) argv.push('--force');
  if (flags.expectedPlanId !== undefined) {
    argv.push('--expected-plan-id', flags.expectedPlanId);
  }
  try {
    return parseProjectTemplateCliMutationOptions(argv);
  } catch (error) {
    if (error instanceof ProjectTemplateCliContractError) {
      return failure(
        command,
        flags.apply === true ? 'apply' : 'dry-run',
        error.code as ProjectTemplateCliErrorCode,
      );
    }
    return failure(command, flags.apply === true ? 'apply' : 'dry-run', 'INTERNAL');
  }
}

function canonicalSource(cwd: string, value: string | undefined): ProjectTemplateCliCommandSource | undefined {
  if (value === undefined || value.length === 0 || value.includes('\0')) return undefined;
  if (value.startsWith('github:') || value.startsWith('https://github.com/')) {
    try {
      const parsed = parseProjectTemplateGithubSourceSpec(value);
      const canonical = parsed.kind === 'github-ref'
        ? `github:${parsed.owner}/${parsed.repo}@${parsed.ref}`
        : parsed.assetUrl;
      return canonical === value ? { kind: 'github', value } : undefined;
    } catch {
      return undefined;
    }
  }
  if (!value.endsWith('.taktpack')) return undefined;
  return { kind: 'local', value: resolve(cwd, value) };
}

function requestedCwd(
  root: Command,
  command: Command,
  flags: CommonFlags,
  dependencies: ProjectTemplateCliCommandAdapterDependencies,
): string {
  const groupCwd = command.parent?.opts<{ cwd?: string }>().cwd;
  const rootCwd = root.opts<{ cwd?: string }>().cwd;
  return resolve(flags.cwd ?? groupCwd ?? rootCwd ?? dependencies.cwd());
}

function addCommonOptions(command: Command): Command {
  return command
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('--cwd <path>', 'Project root (overrides root/project-template --cwd)')
    .option('--json', 'Explicitly request the always-machine JSON output contract');
}

function addMutationOptions(command: Command): Command {
  return addCommonOptions(command)
    .option('--dry-run', 'Plan only (default)')
    .option('--apply', 'Apply the exact expected plan')
    .option('--expected-plan-id <sha256>', 'Required with --apply')
    .option('--force', 'Approve reviewable changes; valid only with --apply');
}

export function registerProjectTemplateCommands(
  root: Command,
  dependencies: ProjectTemplateCliCommandAdapterDependencies,
): Command {
  const group = root.command('project-template')
    .description('Portable .takt project template operations')
    .exitOverride()
    .allowUnknownOption(true)
    .option('--cwd <path>', 'Project root');

  const settle = async (
    command: ProjectTemplateCliCommand,
    mode: 'dry-run' | 'apply',
    handle: (context: ProjectTemplateCliLifecycleContext) =>
      Promise<ProjectTemplateCliOutcome>,
  ): Promise<void> => {
    let lifecycle: ReturnType<typeof startProjectTemplateCliLifecycle> | undefined;
    let interruptedBeforeStart = false;
    const removeInterrupt = dependencies.installInterrupt(() => {
      if (lifecycle === undefined) interruptedBeforeStart = true;
      else lifecycle.interrupt();
    });
    lifecycle = startProjectTemplateCliLifecycle({
      command,
      mode,
      dispose: dependencies.dispose,
      async handle(context) {
        // Yield once so the returned lifecycle can receive a SIGINT that fired
        // during listener installation before dispatch can admit mutation.
        await Promise.resolve();
        return await handle(context);
      },
    });
    if (interruptedBeforeStart) lifecycle.interrupt();
    try {
      const result = await lifecycle.result;
      await writeProjectTemplateCliOutcome(result, dependencies.writeStdout);
      dependencies.setExitCode(result.exitCode);
    } finally {
      removeInterrupt();
    }
  };

  const invalid = (
    command: ProjectTemplateCliCommand,
    mode: 'dry-run' | 'apply',
    code: ProjectTemplateCliErrorCode,
  ): Promise<void> => settle(command, mode, async () => failure(command, mode, code));

  const hasUnknownOption = (command: Command): boolean => (
    command.args.length !== command.processedArgs.length
  );

  const run = async (
    command: Command,
    flags: CommonFlags,
    request: Omit<ProjectTemplateCliCommandRequest, 'cwd' | 'json' | 'currentTaktVersion'>,
  ): Promise<void> => {
    const cwd = requestedCwd(root, command, flags, dependencies);
    const fullRequest: ProjectTemplateCliCommandRequest = {
      ...request,
      cwd,
      json: flags.json === true,
      currentTaktVersion:
        flags.currentTaktVersion ?? dependencies.currentTaktVersion,
    };
    await settle(
      fullRequest.command,
      fullRequest.mutation?.mode ?? 'dry-run',
      (context) => dependencies.dispatch(fullRequest, context),
    );
  };

  addCommonOptions(group.command('inspect')
    .description('Inspect a local .taktpack without mutation')
    .argument('[source]', 'Local .taktpack path')
    .option('--current-takt-version <version>', 'Compatibility version'))
    .action(async (source: string | undefined, flags: CommonFlags, command: Command) => {
      if (hasUnknownOption(command)) {
        await invalid('project-template inspect', 'dry-run', 'UNKNOWN_OPTION');
        return;
      }
      const cwd = requestedCwd(root, command, flags, dependencies);
      const parsed = canonicalSource(cwd, source);
      if (parsed?.kind !== 'local') {
        await invalid('project-template inspect', 'dry-run', 'INVALID_ARGUMENT');
        return;
      }
      await run(command, flags, { command: 'project-template inspect', source: parsed });
    });

  addCommonOptions(group.command('list')
    .description('List installed template state and rollback backups'))
    .action(async (flags: CommonFlags, command: Command) => {
      if (hasUnknownOption(command)) {
        await invalid('project-template list', 'dry-run', 'UNKNOWN_OPTION');
        return;
      }
      await run(command, flags, { command: 'project-template list' });
    });

  addMutationOptions(group.command('export')
    .description('Export the current .takt project as a .taktpack')
    .argument('[output]', 'Output .taktpack path')
    .option('--pack-version <version>', 'Template pack version')
    .option('--min-takt-version <version>', 'Minimum compatible Takt version')
    .option('--source-commit <sha>', 'Source commit recorded in the pack'))
    .action(async (output: string | undefined, flags: CommonFlags, command: Command) => {
      if (hasUnknownOption(command)) {
        await invalid('project-template export', flags.apply === true ? 'apply' : 'dry-run', 'UNKNOWN_OPTION');
        return;
      }
      const parsedMutation = mutation('project-template export', flags);
      const cwd = requestedCwd(root, command, flags, dependencies);
      if ('envelope' in parsedMutation || output === undefined || !output.endsWith('.taktpack')) {
        const result = 'envelope' in parsedMutation
          ? parsedMutation
          : failure('project-template export', 'dry-run', 'INVALID_ARGUMENT');
        await settle(
          'project-template export', result.envelope.mode,
          async () => result,
        );
        return;
      }
      await run(command, flags, {
        command: 'project-template export', outputPath: resolve(cwd, output),
        mutation: parsedMutation,
        exportMetadata: {
          packVersion: flags.packVersion,
          minTaktVersion: flags.minTaktVersion,
          sourceCommit: flags.sourceCommit,
        },
      });
    });

  const addSourceCommand = (
    name: 'diff' | 'apply' | 'update',
    mutating: boolean,
  ): void => {
    const command = group.command(name)
      .description(`${name} a local or canonical GitHub project template`)
      .argument('[source]', 'Local .taktpack path or canonical GitHub source')
      .option('--current-takt-version <version>', 'Compatibility version');
    (mutating ? addMutationOptions(command) : addCommonOptions(command))
      .action(async (source: string | undefined, flags: CommonFlags, action: Command) => {
        const machineCommand = `project-template ${name}` as ProjectTemplateCliCommand;
        if (hasUnknownOption(action)) {
          await invalid(machineCommand, flags.apply === true ? 'apply' : 'dry-run', 'UNKNOWN_OPTION');
          return;
        }
        const parsedMutation = mutating
          ? mutation(machineCommand, flags)
          : ({ mode: 'dry-run', force: false } as const);
        const cwd = requestedCwd(root, action, flags, dependencies);
        const parsedSource = canonicalSource(cwd, source);
        if ('envelope' in parsedMutation || parsedSource === undefined
          || (name === 'update' && parsedSource.kind !== 'github')) {
          const result = 'envelope' in parsedMutation
            ? parsedMutation
            : failure(machineCommand, 'dry-run', 'INVALID_ARGUMENT');
          await settle(machineCommand, result.envelope.mode, async () => result);
          return;
        }
        await run(action, flags, {
          command: machineCommand, source: parsedSource, mutation: parsedMutation,
        });
      });
  };
  addSourceCommand('diff', false);
  addSourceCommand('apply', true);
  addSourceCommand('update', true);

  addMutationOptions(group.command('rollback')
    .description('Rollback to a durable project-template backup')
    .argument('[backup-id]', 'Backup identifier'))
    .action(async (backupId: string | undefined, flags: CommonFlags, command: Command) => {
      if (hasUnknownOption(command)) {
        await invalid('project-template rollback', flags.apply === true ? 'apply' : 'dry-run', 'UNKNOWN_OPTION');
        return;
      }
      const parsedMutation = mutation('project-template rollback', flags);
      if ('envelope' in parsedMutation || backupId === undefined) {
        const result = 'envelope' in parsedMutation
          ? parsedMutation
          : failure('project-template rollback', 'dry-run', 'INVALID_ARGUMENT');
        await settle('project-template rollback', result.envelope.mode, async () => result);
        return;
      }
      await run(command, flags, {
        command: 'project-template rollback', backupId, mutation: parsedMutation,
      });
    });

  return group;
}
