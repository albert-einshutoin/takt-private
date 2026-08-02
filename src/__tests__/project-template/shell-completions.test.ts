import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const completionFiles = [
  'bin/completions/takt.bash',
  'bin/completions/_takt',
  'bin/completions/takt.fish',
] as const;
const commands = ['export', 'inspect', 'diff', 'apply', 'update', 'rollback', 'list'];
const common = ['--cwd', '--json'];
const mutation = ['--dry-run', '--apply', '--expected-plan-id', '--force'];
const exportApprovals = ['--approve-policy', '--approve-capability'];

function registeredRootCommands(): string[] {
  const source = readFileSync(resolve('src/app/cli/commands.ts'), 'utf8');
  return [...source.matchAll(
    /(?:^program|^const\s+\w+\s+=\s+program)\s*\n\s*\.command\('([^']+)'\)/gmu,
  )].map((match) => match[1] as string);
}

function declaredRootCommands(text: string, file: typeof completionFiles[number]): string[] {
  const pattern = file.endsWith('.bash')
    ? /root_commands="([^"]+)"/u
    : file.endsWith('_takt')
      ? /root_commands=\(([^)]+)\)/u
      : /set -l root_commands ([^\n]+)/u;
  const match = pattern.exec(text);
  if (match?.[1] === undefined) throw new Error(`missing root command declaration: ${file}`);
  return match[1].trim().split(/\s+/u);
}

describe('project-template shell completions', () => {
  for (const file of completionFiles) {
    it(`${file} exposes the deterministic seven-command option contract`, () => {
      const text = readFileSync(resolve(file), 'utf8');
      for (const command of commands) expect(text).toContain(command);
      for (const option of common) expect(text).toContain(option);
      for (const option of mutation) expect(text).toContain(option);
      for (const option of exportApprovals) expect(text).toContain(option);
      expect(text).not.toMatch(/(?:token|password|secret|https?:\/\/)/iu);
    });

    it(`${file} keeps the root command registry ahead of project-template`, () => {
      const text = readFileSync(resolve(file), 'utf8');
      expect(declaredRootCommands(text, file)).toEqual(registeredRootCommands());
      expect(text).toContain('run');
      expect(text).toContain('repertoire');
      expect(text).toContain('review');
      expect(text.indexOf('root_commands')).toBeLessThan(text.indexOf('pt_commands'));
    });
  }

  it('keeps mutation-only options off inspect, diff, and list', () => {
    const bash = readFileSync(resolve('bin/completions/takt.bash'), 'utf8');
    for (const command of ['inspect', 'diff', 'list']) {
      const line = bash.split('\n').find((candidate) => candidate.startsWith(`${command})`));
      expect(line).toBeDefined();
      for (const option of mutation) expect(line).not.toContain(option);
    }
  });

  it.each([
    ['root run', '(takt r)', '1', 'run'],
    ['root repertoire', '(takt rep)', '1', 'repertoire'],
    ['metrics review', '(takt metrics r)', '2', 'review'],
    ['root project-template', '(takt pro)', '1', 'project-template'],
    ['group', '(takt project-template "")', '2', 'rollback'],
    ['group cwd', '(takt --cwd /work project-template "")', '4', 'rollback'],
    ['command cwd', '(takt project-template --cwd /work rollback "")', '5', '--expected-plan-id'],
  ])('executes bash completion for %s', (_name, words, current, expected) => {
    const output = execFileSync('bash', ['-c', [
      'source bin/completions/takt.bash',
      `COMP_WORDS=${words}`,
      `COMP_CWORD=${current}`,
      '_takt_project_template',
      'printf "%s\\n" "${COMPREPLY[@]}"',
    ].join('; ')], { encoding: 'utf8' });
    expect(output).toContain(expected);
  });

  it('does not treat a bash positional operand as the project-template root command', () => {
    const output = execFileSync('bash', ['-c', [
      'source bin/completions/takt.bash',
      'COMP_WORDS=(takt add project-template "")',
      'COMP_CWORD=3',
      '_takt_project_template',
      'printf "%s\\n" "${COMPREPLY[@]}"',
    ].join('; ')], { encoding: 'utf8' });
    expect(output).not.toContain('rollback');
  });

  it.each(['i', 'w', 'b', 't'] as const)(
    'treats a terminal -%s in a bash short cluster as consuming project-template',
    (option) => {
      const output = execFileSync('bash', ['-c', [
        'source bin/completions/takt.bash',
        `COMP_WORDS=(takt -q${option} project-template "")`,
        'COMP_CWORD=3',
        '_takt_project_template',
        'printf "%s\\n" "${COMPREPLY[@]}"',
      ].join('; ')], { encoding: 'utf8' });
      expect(output).not.toContain('rollback');
    },
  );

  it.each([
    ['boolean short', '-q', true],
    ['attached short value', '-iqfoo', true],
    ['boolean cluster', '-qV', true],
    ['unknown short', '-x', false],
    ['unknown long', '--mystery', false],
  ] as const)('classifies bash %s before project-template', (_name, option, expected) => {
    const output = execFileSync('bash', ['-c', [
      'source bin/completions/takt.bash',
      `COMP_WORDS=(takt ${option} project-template "")`,
      'COMP_CWORD=3',
      '_takt_project_template',
      'printf "%s\\n" "${COMPREPLY[@]}"',
    ].join('; ')], { encoding: 'utf8' });
    expect(output.includes('rollback')).toBe(expected);
  });

  it.each([
    ['reset', 'categories'],
    ['workflow', 'doctor'],
    ['metrics', 'review'],
    ['repertoire', 'remove'],
  ] as const)('limits bash %s children to the actual root command', (group, child) => {
    const complete = (words: string, current: number): string => execFileSync(
      'bash',
      ['-c', [
        'source bin/completions/takt.bash',
        `COMP_WORDS=${words}`,
        `COMP_CWORD=${String(current)}`,
        '_takt_project_template',
        'printf "%s\\n" "${COMPREPLY[@]}"',
      ].join('; ')],
      { encoding: 'utf8' },
    );
    expect(complete(`(takt ${group} "")`, 2)).toContain(child);
    expect(complete(`(takt run ${group} "")`, 3)).not.toContain(child);
  });

  it.each([
    ['root group', '(takt project-template "")', '3', true],
    ['positional operand', '(takt add project-template "")', '4', false],
  ] as const)('limits zsh project-template children for %s', (
    _name,
    words,
    current,
    expected,
  ) => {
    const output = execFileSync('zsh', ['-c', [
      '_values() { shift; print -l -- "$@"; }',
      '_describe() { local array_name=$2; eval "print -l -- \\${${array_name}[@]}"; }',
      `words=${words}`,
      `CURRENT=${current}`,
      'source bin/completions/_takt',
    ].join('; ')], { encoding: 'utf8' });
    expect(output.includes('rollback')).toBe(expected);
  });

  it.each(['i', 'w', 'b', 't'] as const)(
    'treats a terminal -%s in a zsh short cluster as consuming project-template',
    (option) => {
      const output = execFileSync('zsh', ['-c', [
        '_values() { shift; print -l -- "$@"; }',
        '_describe() { local array_name=$2; eval "print -l -- \\${${array_name}[@]}"; }',
        `words=(takt -q${option} project-template "")`,
        'CURRENT=4',
        'source bin/completions/_takt',
      ].join('; ')], { encoding: 'utf8' });
      expect(output).not.toContain('rollback');
    },
  );

  it.each([
    ['boolean short', '-q', true],
    ['attached short value', '-iqfoo', true],
    ['boolean cluster', '-qV', true],
    ['unknown short', '-x', false],
    ['unknown long', '--mystery', false],
  ] as const)('classifies zsh %s before project-template', (_name, option, expected) => {
    const output = execFileSync('zsh', ['-c', [
      '_values() { shift; print -l -- "$@"; }',
      '_describe() { local array_name=$2; eval "print -l -- \\${${array_name}[@]}"; }',
      `words=(takt ${option} project-template "")`,
      'CURRENT=4',
      'source bin/completions/_takt',
    ].join('; ')], { encoding: 'utf8' });
    expect(output.includes('rollback')).toBe(expected);
  });

  it.each([
    ['reset', 'categories'],
    ['workflow', 'doctor'],
    ['metrics', 'review'],
    ['repertoire', 'remove'],
  ] as const)('limits zsh %s children to the actual root command', (group, child) => {
    const complete = (words: string, current: number): string => execFileSync(
      'zsh',
      ['-c', [
        '_values() { shift; print -l -- "$@"; }',
        '_describe() { local array_name=$2; eval "print -l -- \\${${array_name}[@]}"; }',
        `words=${words}`,
        `CURRENT=${String(current)}`,
        'source bin/completions/_takt',
      ].join('; ')],
      { encoding: 'utf8' },
    );
    expect(complete(`(takt ${group} "")`, 3)).toContain(child);
    expect(complete(`(takt run ${group} "")`, 4)).not.toContain(child);
  });

  it('binds every fish project-template child and option to its root predicate', () => {
    const fish = readFileSync(resolve('bin/completions/takt.fish'), 'utf8');
    expect(fish).toContain('function __takt_is_root_command');
    expect(fish).toContain('set -l short_options_with_value i w b t');
    expect(fish).toContain('set -l short_boolean_options q c h V');
    expect(fish).toContain('set -l ambiguous 0');
    expect(fish).toContain('function __takt_project_template_is_root_command');
    expect(fish).not.toMatch(
      /__fish_seen_subcommand_from (?:project-template|reset|workflow|metrics|repertoire)/u,
    );
    for (const group of ['reset', 'workflow', 'metrics', 'repertoire']) {
      expect(fish).toContain(`-n '__takt_is_root_command ${group}'`);
    }
    for (const line of fish.split('\n').filter((candidate) => (
      candidate.startsWith('complete -c takt')
      && !candidate.includes('__fish_use_subcommand')
      && !candidate.includes('__takt_is_root_command reset')
      && !candidate.includes('__takt_is_root_command workflow')
      && !candidate.includes('__takt_is_root_command metrics')
      && !candidate.includes('__takt_is_root_command repertoire')
    ))) expect(line).toContain('__takt_project_template_is_root_command');
  });

  it('keeps the English and Japanese operator contracts synchronized', () => {
    const guides = [
      readFileSync(resolve('docs/project-templates.md'), 'utf8'),
      readFileSync(resolve('docs/project-templates.ja.md'), 'utf8'),
    ];
    for (const guide of guides) {
      for (const command of commands) {
        expect(guide).toContain(`\`${command}\``);
      }
      for (const option of [...common, ...mutation]) expect(guide).toContain(option);
      for (const option of exportApprovals) expect(guide).toContain(option);
      for (const code of ['`0`', '`20`', '`21`', '`22`', '`23`', '`24`', '`25`', '`70`', '`130`']) {
        expect(guide).toContain(code);
      }
      expect(guide).toContain('process-local');
      expect(guide).toContain('devloopd onboard-repo');
      expect(guide).toContain('TaktDesk');
    }
  });
});
