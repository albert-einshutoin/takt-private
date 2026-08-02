#!/usr/bin/env node

/**
 * TAKT CLI entry point
 *
 * Import order matters: program setup → commands → routing → parse.
 */

import { checkForUpdates } from '../../shared/utils/index.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { error as errorLog } from '../../shared/ui/index.js';
import { resolveRemovedRootCommand, resolveSlashFallbackTask } from './helpers.js';
import { installImmediateSigintExit } from './immediateSigintExit.js';
import { installOpencodeExitCleanup } from './opencodeExitCleanup.js';
import {
  isProjectTemplateCliInvocation,
  projectTemplateCommandCandidate,
  projectTemplateCommandUsesApplyMode,
} from './projectTemplateInvocation.js';
import {
  type ProjectTemplateCliCommand,
} from '../../features/project-template/index.js';
import { settleProjectTemplateParserFailure } from './projectTemplateCommands.js';

// Commander may normalize argv while parsing. Preserve the exact token stream
// once so parser-failure identity never reclassifies a delimited operand.
const entrypointArgs = Object.freeze([...process.argv.slice(2)]);
const projectTemplateInvocation = isProjectTemplateCliInvocation(entrypointArgs);
if (!projectTemplateInvocation) checkForUpdates();

// Import in dependency order
import { cliVersion, program, runPreActionHook } from './program.js';
import './commands.js';
import { registerProjectTemplateCommands } from './projectTemplateCommands.js';
import {
  createProjectTemplateCliCommandProductionDependencies,
} from './projectTemplateCommandProduction.js';
import { executeInteractiveDefaultActionLoop } from './routing.js';

registerProjectTemplateCommands(
  program,
  createProjectTemplateCliCommandProductionDependencies(cliVersion),
  entrypointArgs,
);

if (projectTemplateInvocation) {
  program.exitOverride();
  program.configureOutput({ writeErr() {} });
}

const PROJECT_TEMPLATE_COMMAND_NAMES = [
  'inspect', 'list', 'export', 'diff', 'apply', 'update', 'rollback',
] as const;
type ProjectTemplateCommandName = typeof PROJECT_TEMPLATE_COMMAND_NAMES[number];
const PROJECT_TEMPLATE_COMMANDS: ReadonlySet<string> = new Set(
  PROJECT_TEMPLATE_COMMAND_NAMES,
);
const PROJECT_TEMPLATE_APPLY_COMMANDS: ReadonlySet<ProjectTemplateCommandName> = new Set([
  'export', 'apply', 'update', 'rollback',
] as const);
const ROOT_OPTIONS_WITH_VALUE = new Set([
  '-i', '--issue', '--pr', '-w', '--workflow', '-b', '--branch', '--repo',
  '--provider', '--model', '-t', '--task', '--isolation', '--cwd',
]);

interface ProjectTemplateParserFailureIdentity {
  readonly command: ProjectTemplateCliCommand;
  readonly mode: 'dry-run' | 'apply';
}

function isProjectTemplateCommandName(
  value: string | undefined,
): value is ProjectTemplateCommandName {
  return value !== undefined && PROJECT_TEMPLATE_COMMANDS.has(value);
}

/**
 * Recover only identity fields that are safe to place in a parser-failure envelope.
 * Unknown group syntax is deliberately mapped to list/dry-run because guessing an
 * unknown option's arity could turn its value into a fabricated mutation command.
 */
function projectTemplateParserFailureIdentity(
  args: readonly string[],
): ProjectTemplateParserFailureIdentity {
  const consumedValues = new Set<number>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const equals = argument.indexOf('=');
    const option = equals < 0 ? argument : argument.slice(0, equals);
    if (!ROOT_OPTIONS_WITH_VALUE.has(option)) continue;
    if (equals < 0 && args[index + 1] !== undefined) {
      consumedValues.add(index + 1);
      index += 1;
    }
  }

  const groupIndex = args.findIndex((argument, index) => (
    argument === 'project-template' && !consumedValues.has(index)
  ));
  if (groupIndex < 0) {
    return { command: 'project-template list', mode: 'dry-run' };
  }

  // Why: parser-failure identity must use the same global-option grammar as
  // invocation detection. Otherwise a valid trailing global can hide a real
  // mutation command and report the wrong lifecycle mode.
  const candidate = projectTemplateCommandCandidate(args, groupIndex);
  const commandIndex = candidate?.commandIndex;
  const name = commandIndex === null || commandIndex === undefined
    ? undefined
    : args[commandIndex];
  if (!isProjectTemplateCommandName(name)) {
    return { command: 'project-template list', mode: 'dry-run' };
  }

  const apply = PROJECT_TEMPLATE_APPLY_COMMANDS.has(name)
    && projectTemplateCommandUsesApplyMode(args, commandIndex!);
  return {
    command: `project-template ${name}`,
    mode: apply ? 'apply' : 'dry-run',
  };
}

async function writeProjectTemplateEntrypointFailure(): Promise<void> {
  const { command, mode } = projectTemplateParserFailureIdentity(entrypointArgs);
  if (!await settleProjectTemplateParserFailure(program, command, mode)) {
    throw new Error('project template parser lifecycle is unavailable');
  }
}

(async () => {
  const args = [...entrypointArgs];
  installOpencodeExitCleanup();
  const cleanupImmediateSigintExit = projectTemplateInvocation
    ? () => {}
    : installImmediateSigintExit(args[0]);
  if (!projectTemplateInvocation) {
    const { operands } = program.parseOptions(args);
    const removedRootCommand = resolveRemovedRootCommand(operands);
    if (removedRootCommand !== null) {
      cleanupImmediateSigintExit();
      errorLog(`error: unknown command '${removedRootCommand}'`);
      process.exit(1);
    }

    const knownCommands = program.commands.map((cmd) => cmd.name());
    const slashFallbackTask = resolveSlashFallbackTask(args, knownCommands);

    if (slashFallbackTask !== null) {
      try {
        await runPreActionHook();
        await executeInteractiveDefaultActionLoop(slashFallbackTask);
      } finally {
        cleanupImmediateSigintExit();
      }
      process.exit(0);
    }
  }

  // Normal parsing for all other cases (including '#' prefixed inputs)
  try {
    await program.parseAsync();
  } finally {
    cleanupImmediateSigintExit();
  }

  const rootArg = process.argv.slice(2)[0];
  if (rootArg !== 'watch' && !projectTemplateInvocation) {
    process.exit(0);
  }
})().catch(async (err) => {
  if (projectTemplateInvocation) {
    if ((err as { code?: string }).code === 'commander.helpDisplayed') {
      process.exitCode = 0;
      return;
    }
    if ((err as { name?: string }).name === 'CommanderError') {
      await writeProjectTemplateEntrypointFailure();
      return;
    }
    // Do not claim a second stdout write if an action or its writer failed.
    process.stderr.write('project-template command failed\n');
    process.exitCode = 70;
    return;
  }
  errorLog(getErrorMessage(err));
  process.exit(1);
});
