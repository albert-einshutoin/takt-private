const ROOT_OPTIONS_WITH_VALUE = new Set([
  '-i', '--issue', '--pr', '-w', '--workflow', '-b', '--branch', '--repo',
  '--provider', '--model', '-t', '--task', '--isolation', '--cwd',
]);
const ROOT_BOOLEAN_OPTIONS = new Set([
  '--auto-pr', '--draft', '--pipeline', '--copy-workspace', '--skip-git',
  '-q', '--quiet', '-c', '--continue',
]);
const ROOT_TERMINAL_OPTIONS = new Set(['-h', '--help', '-V', '--version']);
const ROOT_SHORT_OPTIONS_WITH_VALUE = new Set(['i', 'w', 'b', 't']);
const ROOT_SHORT_BOOLEAN_OPTIONS = new Set(['q', 'c', 'h', 'V']);
const PROJECT_TEMPLATE_SUBCOMMANDS = new Set([
  'inspect', 'list', 'export', 'diff', 'apply', 'update', 'rollback',
]);

type ShortOptionShape = 'self-contained' | 'consumes-next' | 'terminal' | 'unknown';

function shortOptionShape(argument: string): ShortOptionShape {
  for (let index = 1; index < argument.length; index += 1) {
    const name = argument[index]!;
    if (name === 'h' || name === 'V') return 'terminal';
    if (ROOT_SHORT_BOOLEAN_OPTIONS.has(name)) continue;
    if (ROOT_SHORT_OPTIONS_WITH_VALUE.has(name)) {
      return index === argument.length - 1 ? 'consumes-next' : 'self-contained';
    }
    return 'unknown';
  }
  return 'self-contained';
}

export interface ProjectTemplateCommandCandidate {
  readonly commandIndex: number | null;
}

export function projectTemplateCommandCandidate(
  args: readonly string[],
  index: number,
): ProjectTemplateCommandCandidate | null {
  if (args[index] !== 'project-template') return null;
  let cursor = index + 1;
  // Why: this recovery path runs after an unknown root option. Mirror the
  // parent Commander's global grammar here so valid trailing options still
  // enter the redacted project-template machine lifecycle.
  while (cursor < args.length) {
    const argument = args[cursor]!;
    if (argument === '--') {
      return PROJECT_TEMPLATE_SUBCOMMANDS.has(args[cursor + 1] ?? '')
        ? { commandIndex: cursor + 1 }
        : null;
    }
    if (argument === '--json') {
      cursor += 1;
      continue;
    }
    const equals = argument.indexOf('=');
    const option = equals < 0 ? argument : argument.slice(0, equals);
    if (ROOT_OPTIONS_WITH_VALUE.has(option)) {
      cursor += equals < 0 && args[cursor + 1] !== undefined ? 2 : 1;
      continue;
    }
    if (ROOT_TERMINAL_OPTIONS.has(argument)) return { commandIndex: null };
    if (ROOT_BOOLEAN_OPTIONS.has(argument)) {
      cursor += 1;
      continue;
    }
    if (argument === '-') return null;
    if (argument.startsWith('-') && !argument.startsWith('--')) {
      const shape = shortOptionShape(argument);
      if (shape === 'terminal') return { commandIndex: null };
      if (shape === 'unknown') return null;
      cursor += shape === 'consumes-next' && args[cursor + 1] !== undefined ? 2 : 1;
      continue;
    }
    if (argument.startsWith('-')) return null;
    return PROJECT_TEMPLATE_SUBCOMMANDS.has(argument)
      ? { commandIndex: cursor }
      : null;
  }
  return { commandIndex: null };
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
      if (projectTemplateCommandCandidate(args, index) !== null) return true;
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
    if (ROOT_TERMINAL_OPTIONS.has(argument)) return false;
    if (ROOT_BOOLEAN_OPTIONS.has(argument)) continue;
    if (argument === '-') return false;
    if (argument.startsWith('-') && !argument.startsWith('--')) {
      const shape = shortOptionShape(argument);
      if (shape === 'consumes-next' && args[index + 1] !== undefined) index += 1;
      else if (shape === 'terminal') return false;
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
