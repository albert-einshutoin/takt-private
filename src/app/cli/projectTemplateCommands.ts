import { resolve } from 'node:path';
import type { Command } from 'commander';
import { parseProjectTemplateGithubSourceSpec } from '../../features/project-template/github-source-spec.js';
import { ProjectTemplateCliContractError } from '../../features/project-template/cli-contract-error.js';
import {
  createProjectTemplateCliFailure,
  parseProjectTemplateCliMutationOptions,
  projectTemplateCliExitCodeForErrorCode,
  snapshotProjectTemplateCliOutcome,
  writeProjectTemplateCliOutcome,
  type ProjectTemplateCliCommand,
  type ProjectTemplateCliErrorCode,
  type ProjectTemplateCliFailureEnvelope,
  type ProjectTemplateCliMutationOptions,
  type ProjectTemplateCliOutcome,
} from '../../features/project-template/cli-machine-contract.js';
import {
  createProjectTemplateCliV1_1FailureFor,
  snapshotProjectTemplateCliV1_1Outcome,
  writeProjectTemplateCliV1_1Outcome,
  type ProjectTemplateCliV1_1Outcome,
} from '../../features/project-template/cli-machine-contract-v1-1.js';
import {
  startProjectTemplateCliLifecycle,
  type ProjectTemplateCliLifecycleContext,
} from '../../features/project-template/cli-lifecycle.js';
import {
  MAX_TEMPLATE_ENTRIES,
  MAX_SEMVER_LENGTH,
  SEMVER_PATTERN_SOURCE,
  TEMPLATE_CAPABILITIES,
} from '../../features/project-template/validation.js';
import {
  isProjectTemplateCliExportApprovalError,
  parseProjectTemplateCliExportApprovals,
} from '../../features/project-template/cli-export-approvals.js';
import { projectTemplateNamedCommandUsesApplyMode } from './projectTemplateInvocation.js';

function parserFailureMode(
  args: readonly string[],
  commandName: string,
): 'dry-run' | 'apply' {
  return projectTemplateNamedCommandUsesApplyMode(
    args,
    commandName,
  ) ? 'apply' : 'dry-run';
}

function requestedSchemaVersions(args: readonly string[]): readonly string[] {
  const versions: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--schema-version') {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith('--')) {
        versions.push(value);
        index += 1;
      } else {
        versions.push('');
      }
    } else if (argument?.startsWith('--schema-version=')) {
      versions.push(argument.slice('--schema-version='.length));
    }
    if (versions.length > 2) break;
  }
  return Object.freeze(versions);
}

export type ProjectTemplateCliCommandSource =
  | { readonly kind: 'local'; readonly value: string }
  | { readonly kind: 'github'; readonly value: string };

export interface ProjectTemplateCliCommandRequest {
  readonly command: ProjectTemplateCliCommand;
  readonly cwd: string;
  readonly json: boolean;
  readonly schemaVersion?: '1.0' | '1.1';
  readonly source?: ProjectTemplateCliCommandSource;
  readonly outputPath?: string;
  readonly backupId?: string;
  readonly currentTaktVersion: string;
  readonly mutation?: ProjectTemplateCliMutationOptions;
  readonly exportMetadata?: {
    readonly packVersion?: string;
    readonly minTaktVersion?: string;
    readonly sourceCommit?: string;
    readonly policyApprovals?: readonly string[];
    readonly capabilityApprovals?: readonly string[];
  };
}

export interface ProjectTemplateCliCommandAdapterDependencies {
  readonly dispatch: (
    request: ProjectTemplateCliCommandRequest,
    context: ProjectTemplateCliLifecycleContext,
  ) => Promise<ProjectTemplateCliOutcome | ProjectTemplateCliV1_1Outcome>;
  readonly dispose: () => void | Promise<void>;
  readonly writeStdout: (chunk: string) => void | Promise<void>;
  readonly setExitCode: (code: number) => void;
  readonly installInterrupt: (interrupt: () => void) => () => void;
  readonly cwd: () => string;
  readonly currentTaktVersion: string;
}

type ProjectTemplateCliAnyOutcome = ProjectTemplateCliOutcome | ProjectTemplateCliV1_1Outcome;

const parserFailureHandlers = new WeakMap<
Command,
(command: ProjectTemplateCliCommand, mode: 'dry-run' | 'apply') => Promise<void>
>();
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REGEXP_EXEC = RegExp.prototype.exec;
const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_ARRAY_PROTOTYPE = Array.prototype;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const SEMVER_PATTERN = new RegExp(SEMVER_PATTERN_SOURCE, 'u');

function isValidExportSemVer(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_SEMVER_LENGTH
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_REGEXP_EXEC,
      SEMVER_PATTERN,
      [value],
    ) !== null;
}

export function settleProjectTemplateParserFailure(
  root: Command,
  command: ProjectTemplateCliCommand,
  mode: 'dry-run' | 'apply',
): Promise<boolean> {
  const handler = parserFailureHandlers.get(root);
  if (handler === undefined) return Promise.resolve(false);
  return handler(command, mode).then(() => true);
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
  readonly schemaVersion?: readonly string[];
  readonly currentTaktVersion?: readonly string[];
  readonly packVersion?: string;
  readonly minTaktVersion?: string;
  readonly sourceCommit?: string;
  readonly approvePolicy?: readonly string[];
  readonly approveCapability?: readonly string[];
}

function addCurrentVersionAssertion(command: Command): Command {
  // Why: this assertion protects compatibility and mutation admission. Keep
  // every occurrence that Commander has already tokenized so attached values
  // and values which resemble option names cannot be miscounted by raw argv
  // scanning or silently collapsed with Commander's usual last-value-wins.
  return command.option(
    '--current-takt-version <version>',
    'Assert the executing Takt version',
    (value: string, previous: readonly string[] | undefined): readonly string[] => [
      ...(previous ?? []), value,
    ],
    [],
  );
}

function failure(
  command: ProjectTemplateCliCommand,
  mode: 'dry-run' | 'apply',
  code: ProjectTemplateCliErrorCode,
  schemaVersion: '1.0' | '1.1' = '1.0',
): ProjectTemplateCliOutcome | ProjectTemplateCliV1_1Outcome {
  if (schemaVersion === '1.1') {
    return {
      envelope: createProjectTemplateCliV1_1FailureFor({ command, mode, code }),
      exitCode: projectTemplateCliExitCodeForErrorCode(code),
    };
  }
  return {
    envelope: createProjectTemplateCliFailure({ command, mode, code }),
    exitCode: projectTemplateCliExitCodeForErrorCode(code),
  };
}

function mutation(
  command: ProjectTemplateCliCommand,
  flags: MutationFlags,
  applyRequested = flags.apply === true,
): ProjectTemplateCliMutationOptions | ProjectTemplateCliAnyOutcome {
  if (flags.force === true && !applyRequested) {
    return failure(command, 'dry-run', 'INVALID_ARGUMENT');
  }
  const argv: string[] = [];
  if (applyRequested) argv.push('--apply');
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
        applyRequested ? 'apply' : 'dry-run',
        error.code as ProjectTemplateCliErrorCode,
      );
    }
    return failure(command, applyRequested ? 'apply' : 'dry-run', 'INTERNAL');
  }
}

function invalidMutationInput(
  command: ProjectTemplateCliCommand,
  parsed: ProjectTemplateCliMutationOptions | ProjectTemplateCliAnyOutcome,
): { readonly envelope: ProjectTemplateCliFailureEnvelope; readonly exitCode: number } {
  if ('envelope' in parsed) {
    if (parsed.envelope.schemaVersion !== '1.0' || parsed.envelope.status !== 'error') {
      throw new Error('mutation option parser returned an invalid failure outcome');
    }
    return parsed as { envelope: ProjectTemplateCliFailureEnvelope; exitCode: number };
  }
  // Why: machine clients correlate errors with the invocation they attempted.
  // Preserve an already-validated apply mode even when a later operand check
  // fails, instead of misreporting the request as a dry-run.
  return {
    envelope: createProjectTemplateCliFailure({
      command, mode: parsed.mode, code: 'INVALID_ARGUMENT',
    }),
    exitCode: projectTemplateCliExitCodeForErrorCode('INVALID_ARGUMENT'),
  };
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
    .option(
      '--schema-version <version>',
      'Machine schema version (1.0 default; 1.1 detailed review contract)',
      (value: string, previous: readonly string[] | undefined): readonly string[] => [
        ...(previous ?? []), value,
      ],
      [],
    )
    .option('--json', 'Explicitly request the always-machine JSON output contract');
}

function addMutationOptions(command: Command): Command {
  return addCommonOptions(command)
    .option('--dry-run', 'Plan only (default)')
    .option('--apply', 'Apply the exact expected plan')
    .option('--expected-plan-id <sha256>', 'Required with --apply')
    .option(
      '--force',
      'Approve reviewable apply/overwrite only; never export policy/capability approval',
    );
}

function collectBounded(maxItems: number) {
  return (value: string, previous: readonly string[]): readonly string[] => {
    if (!CAPTURED_ARRAY_IS_ARRAY(previous)
      || CAPTURED_OBJECT_GET_PROTOTYPE_OF(previous) !== CAPTURED_ARRAY_PROTOTYPE) {
      throw new Error('invalid repeated project-template option state');
    }
    // Why: Commander calls the processor once per occurrence. Appending to its
    // private array avoids quadratic copies, while retaining one overflow item
    // lets the hardened parser return the canonical INVALID_ARGUMENT envelope.
    if (previous.length >= maxItems + 1) return previous;
    CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_DEFINE_PROPERTY,
      CAPTURED_OBJECT_RECEIVER,
      [previous, `${previous.length}`, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      }],
    );
    return previous;
  };
}

const collectPolicyApproval = collectBounded(MAX_TEMPLATE_ENTRIES);
const collectCapabilityApproval = collectBounded(TEMPLATE_CAPABILITIES.length);

export function registerProjectTemplateCommands(
  root: Command,
  dependencies: ProjectTemplateCliCommandAdapterDependencies,
  invocationArgs?: readonly string[],
): Command {
  // Why: Commander and runner layers may normalize delimiters while parsing.
  // Production supplies the entrypoint's immutable startup snapshot; embedded
  // adapters fall back to Commander's original rawArgs for testability.
  const startupArgs = invocationArgs === undefined
    ? undefined
    : Object.freeze([...invocationArgs]);
  const rawArgs = (): readonly string[] => {
    const embeddedRawArgs = (root as Command & { rawArgs?: readonly string[] }).rawArgs;
    return startupArgs ?? embeddedRawArgs?.slice(2) ?? [];
  };
  const group = root.command('project-template')
    .description('Portable .takt project template operations')
    .exitOverride()
    .allowUnknownOption(true)
    .option('--cwd <path>', 'Project root')
    .option('--schema-version <version>', 'Machine schema version (1.0 or 1.1)')
    .option('--json', 'Explicitly request the always-machine JSON output contract');

  const settle = async (
    command: ProjectTemplateCliCommand,
    mode: 'dry-run' | 'apply',
    handle: (context: ProjectTemplateCliLifecycleContext) =>
      Promise<ProjectTemplateCliAnyOutcome>,
    schemaVersion: '1.0' | '1.1' = '1.0',
  ): Promise<void> => {
    const lifecycleState: {
      current?: { readonly interrupt: () => void };
    } = {};
    let interruptedBeforeStart = false;
    let removeInterrupt: (() => void) | undefined;
    const dispose = async (): Promise<void> => {
      let disposalError: unknown;
      try {
        await dependencies.dispose();
      } catch (error) {
        disposalError = error;
      }
      let listenerError: unknown;
      try {
        removeInterrupt?.();
      } catch (error) {
        listenerError = error;
      }
      if (disposalError !== undefined && listenerError !== undefined) {
        throw new AggregateError([disposalError, listenerError], 'project template cleanup failed');
      }
      if (disposalError !== undefined) throw disposalError;
      if (listenerError !== undefined) throw listenerError;
    };
    const invoke = async (
      context: ProjectTemplateCliLifecycleContext,
    ): Promise<ProjectTemplateCliAnyOutcome> => {
      removeInterrupt = dependencies.installInterrupt(() => {
        if (lifecycleState.current === undefined) interruptedBeforeStart = true;
        else lifecycleState.current.interrupt();
      });
      // Yield once so the returned lifecycle can receive a SIGINT that fired
      // during listener installation before dispatch can admit mutation.
      await Promise.resolve();
      return await handle(context);
    };
    const lifecycle = schemaVersion === '1.1'
      ? startProjectTemplateCliLifecycle({
        command, mode, schemaVersion: '1.1', dispose,
        async handle(context) {
          return snapshotProjectTemplateCliV1_1Outcome(await invoke(context));
        },
      })
      : startProjectTemplateCliLifecycle({
      command,
      mode,
      schemaVersion: '1.0',
      dispose,
      async handle(context) {
        return snapshotProjectTemplateCliOutcome(await invoke(context));
      },
    });
    lifecycleState.current = lifecycle;
    if (interruptedBeforeStart) lifecycle.interrupt();
    const result = await lifecycle.result;
    if (result.envelope.schemaVersion === '1.1') {
      await writeProjectTemplateCliV1_1Outcome(
        result as ProjectTemplateCliV1_1Outcome,
        dependencies.writeStdout,
      );
    } else {
      await writeProjectTemplateCliOutcome(
        result as ProjectTemplateCliOutcome,
        dependencies.writeStdout,
      );
    }
    dependencies.setExitCode(result.exitCode);
  };

  const invalid = (
    command: ProjectTemplateCliCommand,
    mode: 'dry-run' | 'apply',
    code: ProjectTemplateCliErrorCode,
    requestedVersion?: '1.0' | '1.1',
  ): Promise<void> => {
    const selected = requestedSchemaVersions(rawArgs());
    // Why: once a caller has made one valid exact schema selection, every
    // parser and operand failure must remain in that schema. Invalid or
    // duplicate negotiation itself stays on the backward-compatible 1.0 path.
    const schemaVersion = requestedVersion
      ?? (selected.length === 1 && selected[0] === '1.1' ? '1.1' : '1.0');
    return settle(
      command, mode, async () => failure(command, mode, code, schemaVersion), schemaVersion,
    );
  };

  parserFailureHandlers.set(root, (command, mode) => (
    invalid(command, mode, 'UNKNOWN_OPTION')
  ));

  const hasUnknownOption = (command: Command): boolean => {
    // Why: Commander keeps an omitted optional operand as `undefined` in
    // processedArgs. Counting that placeholder as an excess token turns a
    // valid apply-shaped invocation into UNKNOWN_OPTION before operand
    // validation can preserve its mode.
    const processedArgumentCount = command.processedArgs.reduce(
      (count, argument) => count + (argument === undefined ? 0 : 1),
      0,
    );
    return command.args.length !== processedArgumentCount;
  };

  const run = async (
    command: Command,
    flags: CommonFlags,
    request: Omit<ProjectTemplateCliCommandRequest, 'cwd' | 'json' | 'schemaVersion' | 'currentTaktVersion'>,
  ): Promise<void> => {
    const schemaVersions = requestedSchemaVersions(rawArgs());
    if (schemaVersions.length > 1
      || (schemaVersions[0] !== undefined
        && schemaVersions[0] !== '1.0'
        && schemaVersions[0] !== '1.1')) {
      await invalid(request.command, request.mutation?.mode ?? 'dry-run', 'INVALID_ARGUMENT');
      return;
    }
    const schemaVersion = (schemaVersions[0] ?? '1.0') as '1.0' | '1.1';
    const currentVersionAssertions = flags.currentTaktVersion ?? [];
    if (currentVersionAssertions.length > 1
      || (currentVersionAssertions[0] !== undefined
        && currentVersionAssertions[0] !== dependencies.currentTaktVersion)) {
      // Why: compatibility is a mutation security boundary. Treat the option
      // as a caller/runtime assertion so neither preview nor apply can replace
      // the version of the binary that is actually executing the operation.
      await invalid(
        request.command,
        request.mutation?.mode ?? 'dry-run',
        'INVALID_ARGUMENT',
      );
      return;
    }
    const cwd = requestedCwd(root, command, flags, dependencies);
    const fullRequest: ProjectTemplateCliCommandRequest = {
      ...request,
      cwd,
      json: flags.json === true,
      schemaVersion,
      currentTaktVersion: dependencies.currentTaktVersion,
    };
    await settle(
      fullRequest.command,
      fullRequest.mutation?.mode ?? 'dry-run',
      (context) => dependencies.dispatch(fullRequest, context),
      schemaVersion,
    );
  };

  addCommonOptions(addCurrentVersionAssertion(group.command('inspect')
    .description('Inspect a local .taktpack without mutation')
    .argument('[source]', 'Local .taktpack path')))
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
    .option('--approve-policy <path=policy>', 'Approve an export policy', collectPolicyApproval, [])
    .option('--approve-capability <capability>', 'Approve a detected capability', collectCapabilityApproval, [])
    .action(async (output: string | undefined, flags: CommonFlags, command: Command) => {
      if (hasUnknownOption(command)) {
        await invalid(
          'project-template export', parserFailureMode(rawArgs(), 'export'), 'UNKNOWN_OPTION',
        );
        return;
      }
      const parsedMutation = mutation(
        'project-template export', flags,
        parserFailureMode(rawArgs(), 'export') === 'apply',
      );
      const cwd = requestedCwd(root, command, flags, dependencies);
      // Why: version metadata is operator input, so reject it before planning
      // or mutation admission. Do not broaden the dispatch catch boundary,
      // where genuine internal failures must remain INTERNAL.
      const validMetadata = isValidExportSemVer(flags.packVersion)
        && isValidExportSemVer(flags.minTaktVersion);
      let approvals;
      try {
        approvals = parseProjectTemplateCliExportApprovals({
          policies: flags.approvePolicy,
          capabilities: flags.approveCapability,
        });
      } catch (error) {
        if (!isProjectTemplateCliExportApprovalError(error)) throw error;
        approvals = undefined;
      }
      if ('envelope' in parsedMutation || output === undefined
        || !output.endsWith('.taktpack') || !validMetadata || approvals === undefined) {
        const result = invalidMutationInput('project-template export', parsedMutation);
        await invalid(
          'project-template export', result.envelope.mode, result.envelope.error.code,
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
          policyApprovals: flags.approvePolicy,
          capabilityApprovals: flags.approveCapability,
        },
      });
    });

  const addSourceCommand = (
    name: 'diff' | 'apply' | 'update',
    mutating: boolean,
  ): void => {
    const command = addCurrentVersionAssertion(group.command(name)
      .description(`${name} a local or canonical GitHub project template`)
      .argument('[source]', 'Local .taktpack path or canonical GitHub source'));
    (mutating ? addMutationOptions(command) : addCommonOptions(command))
      .action(async (source: string | undefined, flags: CommonFlags, action: Command) => {
        const machineCommand = `project-template ${name}` as ProjectTemplateCliCommand;
        if (hasUnknownOption(action)) {
          await invalid(machineCommand, parserFailureMode(rawArgs(), name), 'UNKNOWN_OPTION');
          return;
        }
        const parsedMutation = mutating
          ? mutation(machineCommand, flags, parserFailureMode(rawArgs(), name) === 'apply')
          : ({ mode: 'dry-run', force: false } as const);
        const cwd = requestedCwd(root, action, flags, dependencies);
        const parsedSource = canonicalSource(cwd, source);
        if ('envelope' in parsedMutation || parsedSource === undefined
          || (name === 'update' && parsedSource.kind !== 'github')) {
          const result = invalidMutationInput(machineCommand, parsedMutation);
          await invalid(machineCommand, result.envelope.mode, result.envelope.error.code);
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
        await invalid(
          'project-template rollback', parserFailureMode(rawArgs(), 'rollback'), 'UNKNOWN_OPTION',
        );
        return;
      }
      const parsedMutation = mutation(
        'project-template rollback', flags,
        parserFailureMode(rawArgs(), 'rollback') === 'apply',
      );
      if ('envelope' in parsedMutation || backupId === undefined) {
        const result = invalidMutationInput('project-template rollback', parsedMutation);
        await invalid(
          'project-template rollback', result.envelope.mode, result.envelope.error.code,
        );
        return;
      }
      await run(command, flags, {
        command: 'project-template rollback', backupId, mutation: parsedMutation,
      });
    });

  group.action(async (_flags: CommonFlags, command: Command) => {
    if (hasUnknownOption(command)) {
      // Preserve the existing UNKNOWN_OPTION parser lifecycle for unknown
      // children and group options; only the genuinely omitted child is the
      // new INVALID_ARGUMENT root-command case.
      command.error('invalid project-template invocation');
      return;
    }
    // Why: the root command is recognized as a machine invocation, so an
    // omitted child must settle through the same single-envelope lifecycle
    // instead of Commander's implicit help-and-success behavior.
    await invalid('project-template', 'dry-run', 'INVALID_ARGUMENT');
  });

  return group;
}
