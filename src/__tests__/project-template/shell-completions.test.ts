import { readFileSync } from 'node:fs';
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

describe('project-template shell completions', () => {
  for (const file of completionFiles) {
    it(`${file} exposes the deterministic seven-command option contract`, () => {
      const text = readFileSync(resolve(file), 'utf8');
      for (const command of commands) expect(text).toContain(command);
      for (const option of common) expect(text).toContain(option);
      for (const option of mutation) expect(text).toContain(option);
      expect(text).not.toMatch(/(?:token|password|secret|https?:\/\/)/iu);
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
      for (const code of ['`0`', '`20`', '`21`', '`22`', '`23`', '`24`', '`25`', '`70`', '`130`']) {
        expect(guide).toContain(code);
      }
      expect(guide).toContain('process-local');
      expect(guide).toContain('devloopd onboard-repo');
      expect(guide).toContain('TaktDesk');
    }
  });
});
