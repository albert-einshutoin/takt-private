const ROOT_OPTIONS_WITH_VALUE = new Set([
  '-i', '--issue', '--pr', '-w', '--workflow', '-b', '--branch', '--repo',
  '--provider', '--model', '-t', '--task', '--isolation', '--cwd',
]);
const ROOT_BOOLEAN_OPTIONS = new Set([
  '--auto-pr', '--draft', '--pipeline', '--copy-workspace', '--skip-git',
  '-q', '--quiet', '-c', '--continue', '-h', '--help', '-V', '--version',
]);
const ROOT_SHORT_OPTIONS_WITH_VALUE = new Set(['i', 'w', 'b', 't']);
const ROOT_SHORT_BOOLEAN_OPTIONS = new Set(['q', 'c', 'h', 'V']);
const PROJECT_TEMPLATE_SUBCOMMANDS = new Set([
  'inspect', 'list', 'export', 'diff', 'apply', 'update', 'rollback',
]);

type ShortOptionShape = 'self-contained' | 'consumes-next' | 'unknown';

function shortOptionShape(argument: string): ShortOptionShape {
  for (let index = 1; index < argument.length; index += 1) {
    const name = argument[index]!;
    if (ROOT_SHORT_BOOLEAN_OPTIONS.has(name)) continue;
    if (ROOT_SHORT_OPTIONS_WITH_VALUE.has(name)) {
      return index === argument.length - 1 ? 'consumes-next' : 'self-contained';
    }
    return 'unknown';
  }
  return 'unknown';
}

function isProjectTemplateCommandCandidate(
  args: readonly string[],
  index: number,
): boolean {
  if (args[index] !== 'project-template') return false;
  const next = args[index + 1];
  return next === undefined
    || next === '--help'
    || next === '-h'
    || PROJECT_TEMPLATE_SUBCOMMANDS.has(next);
}

/** Pure command detection that never mistakes an option value or later operand for a command. */
export function isProjectTemplateCliInvocation(args: readonly string[]): boolean {
  let unknownOptionValuePending = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') return args[index + 1] === 'project-template';
    if (unknownOptionValuePending) {
      // Why: an unknown option is ambiguous, but a complete known command
      // shape must still enter the redacted machine-error lifecycle. A value
      // named project-template followed by an unrelated command remains data.
      if (isProjectTemplateCommandCandidate(args, index)) return true;
      unknownOptionValuePending = false;
      continue;
    }
    const equals = argument.indexOf('=');
    const option = equals < 0 ? argument : argument.slice(0, equals);
    if (ROOT_OPTIONS_WITH_VALUE.has(option)) {
      if (equals < 0 && args[index + 1] !== undefined) {
        index += 1;
      }
      continue;
    }
    if (ROOT_BOOLEAN_OPTIONS.has(option)) continue;
    if (argument.startsWith('-') && !argument.startsWith('--')) {
      const shape = shortOptionShape(argument);
      if (shape === 'consumes-next' && args[index + 1] !== undefined) index += 1;
      else if (shape === 'unknown') unknownOptionValuePending = true;
      continue;
    }
    if (argument.startsWith('-')) {
      // Unknown root options must still reach the project-template machine-error
      // lifecycle, so conservatively redact one following value from detection.
      unknownOptionValuePending = equals < 0;
      continue;
    }
    // Why: Commander assigns the first positional operand to the root command;
    // later values named project-template still belong to commands such as add.
    return argument === 'project-template';
  }
  return false;
}
