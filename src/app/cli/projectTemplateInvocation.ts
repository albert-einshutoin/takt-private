const ROOT_OPTIONS_WITH_VALUE = new Set([
  '-i', '--issue', '--pr', '-w', '--workflow', '-b', '--branch', '--repo',
  '--provider', '--model', '-t', '--task', '--isolation', '--cwd',
]);

/** Pure command detection that never mistakes a known option value for a command. */
export function isProjectTemplateCliInvocation(args: readonly string[]): boolean {
  const consumed = new Set<number>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const equals = argument.indexOf('=');
    const option = equals < 0 ? argument : argument.slice(0, equals);
    if (!ROOT_OPTIONS_WITH_VALUE.has(option)) continue;
    if (equals < 0 && args[index + 1] !== undefined) {
      consumed.add(index + 1);
      index += 1;
    }
  }
  return args.some((argument, index) => (
    argument === 'project-template' && !consumed.has(index)
  ));
}
