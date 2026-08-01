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
import { isProjectTemplateCliInvocation } from './projectTemplateInvocation.js';
import {
  type ProjectTemplateCliCommand,
} from '../../features/project-template/index.js';
import { settleProjectTemplateParserFailure } from './projectTemplateCommands.js';

const projectTemplateInvocation = isProjectTemplateCliInvocation(
  process.argv.slice(2),
);
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
);

if (projectTemplateInvocation) {
  program.exitOverride();
  program.configureOutput({ writeErr() {} });
}

function requestedProjectTemplateCommand(): ProjectTemplateCliCommand {
  const args = process.argv.slice(2);
  const index = args.indexOf('project-template');
  const name = index < 0 ? undefined : args[index + 1];
  return name === 'inspect' || name === 'list' || name === 'export'
    || name === 'diff' || name === 'apply' || name === 'update'
    || name === 'rollback'
    ? `project-template ${name}`
    : 'project-template list';
}

async function writeProjectTemplateEntrypointFailure(): Promise<void> {
  const command = requestedProjectTemplateCommand();
  const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';
  if (!await settleProjectTemplateParserFailure(program, command, mode)) {
    throw new Error('project template parser lifecycle is unavailable');
  }
}

(async () => {
  const args = process.argv.slice(2);
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
