const ROOT_OPTIONS_WITH_VALUE = new Set([
  '-i', '--issue', '--pr', '-w', '--workflow', '-b', '--branch', '--repo',
  '--provider', '--model', '-t', '--task', '--isolation', '--cwd',
]);
const ROOT_BOOLEAN_OPTIONS = new Set([
  '--auto-pr', '--draft', '--pipeline', '--copy-workspace', '--skip-git',
  '-q', '--quiet', '-c', '--continue', '-h', '--help', '-V', '--version',
]);

/** Pure command detection that never mistakes an option value or later operand for a command. */
export function isProjectTemplateCliInvocation(args: readonly string[]): boolean {
  let unknownOptionValuePending = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') return args[index + 1] === 'project-template';
    const equals = argument.indexOf('=');
    const option = equals < 0 ? argument : argument.slice(0, equals);
    if (argument.startsWith('-')) unknownOptionValuePending = false;
    if (ROOT_OPTIONS_WITH_VALUE.has(option)) {
      if (equals < 0 && args[index + 1] !== undefined) {
        index += 1;
      }
      continue;
    }
    if (ROOT_BOOLEAN_OPTIONS.has(option)) continue;
    if (argument.startsWith('-')) {
      // Unknown root options must still reach the project-template machine-error
      // lifecycle, so conservatively redact one following value from detection.
      unknownOptionValuePending = equals < 0;
      continue;
    }
    if (unknownOptionValuePending) {
      unknownOptionValuePending = false;
      continue;
    }
    // Why: Commander assigns the first positional operand to the root command;
    // later values named project-template still belong to commands such as add.
    return argument === 'project-template';
  }
  return false;
}
