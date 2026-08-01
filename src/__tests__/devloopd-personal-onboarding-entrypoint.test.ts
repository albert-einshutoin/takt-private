import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatPersonalOnboardingReport,
  runPersonalOnboarding,
} from '../devloopd/personalOnboarding.js';

const runner = resolve('node_modules/.bin/vite-node');
const entrypoint = resolve('src/app/devloopd/index.ts');
const roots: string[] = [];

function run(args: readonly string[]) {
  return spawnSync(runner, [entrypoint, '--', ...args], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('devloopd onboard-repo template entrypoint', () => {
  it('keeps template-absent legacy output byte-equivalent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-devloopd-onboard-'));
    roots.push(root);
    mkdirSync(join(root, '.git'));
    const expected = await runPersonalOnboarding({ repoPath: root, apply: false });

    const result = run(['onboard-repo', '--cwd', root]);

    expect(result.status).toBe(expected.passed ? 0 : 1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${formatPersonalOnboardingReport(expected)}\n`);
  });

  it('advertises only the explicit template mutation options', () => {
    const result = run(['onboard-repo', '--help']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    for (const option of ['--template <source>', '--expected-plan-id <sha256>', '--json']) {
      expect(result.stdout).toContain(option);
    }
  });

  it.each([
    ['force dry-run', ['--force'], 'FORCE_REQUIRES_APPLY'],
    ['expected dry-run', ['--expected-plan-id', 'a'.repeat(64)], 'EXPECTED_PLAN_ID_REQUIRES_APPLY'],
    ['missing expected', ['--apply'], 'MISSING_EXPECTED_PLAN_ID'],
  ] as const)('returns one closed JSON error for %s', (_name, flags, code) => {
    const result = run([
      'onboard-repo', '--cwd', '/not-observed', '--template', './starter.taktpack',
      '--json', ...flags,
    ]);

    expect(result.status).toBe(20);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: '1.0', status: 'error', command: 'onboard-repo',
      error: { code },
    });
    expect(result.stdout).not.toContain('/not-observed');
  });
});
