import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatPersonalOnboardingReport,
  runPersonalOnboarding,
} from '../devloopd/personalOnboarding.js';
import type { DevloopCommandRunner } from '../devloopd/commandRunner.js';

const cleanupDirs = new Set<string>();

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-personal-onboard-'));
  cleanupDirs.add(dir);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

function makeRunner(existingLabels: string[] = []): DevloopCommandRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveCommand(command) {
      return command === 'git' || command === 'gh' ? `/mock/bin/${command}` : undefined;
    },
    async exec(command, args) {
      calls.push(`${command} ${args.join(' ')}`);
      const invocation = `${command} ${args.join(' ')}`;
      if (invocation === 'git rev-parse --show-toplevel') {
        return { exitCode: 0, stdout: '/repo\n', stderr: '' };
      }
      if (invocation === 'gh label list --repo owner/repo --json name --limit 200') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(existingLabels.map((name) => ({ name }))),
          stderr: '',
        };
      }
      if (command === 'gh' && args[0] === 'label' && args[1] === 'create') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describe('devloopd personal onboarding', () => {
  it('dry-runs clean repo onboarding without mutating files or labels', async () => {
    const repoPath = makeTempRepo();
    const runner = makeRunner();

    const report = await runPersonalOnboarding({
      repoPath,
      repo: 'owner/repo',
      apply: false,
      runner,
      env: { PATH: '/mock/bin' },
    });

    expect(report.passed).toBe(true);
    expect(report.changed).toBe(false);
    expect(report.actions.map((action) => `${action.status}:${action.name}`)).toEqual([
      'pass:git repository',
      'would_change:root gitignore',
      'would_change:takt gitignore',
      'would_change:takt config',
      'would_change:devloop policy',
      'would_change:subscription workflow',
      'would_change:github label agent:ready',
      'would_change:github label agent:auto-merge',
      'would_change:github label agent:blocked',
    ]);
    expect(existsSync(join(repoPath, '.takt'))).toBe(false);
    expect(runner.calls).not.toContain('gh label create agent:ready --repo owner/repo --color 0e8a16 --description Issue is safe for mechanical devloop consideration');
    expect(formatPersonalOnboardingReport(report)).toContain('devloopd onboard-repo passed');
  });

  it('applies local templates and creates missing GitHub labels', async () => {
    const repoPath = makeTempRepo();
    const runner = makeRunner(['agent:ready']);

    const report = await runPersonalOnboarding({
      repoPath,
      repo: 'owner/repo',
      apply: true,
      runner,
      env: { PATH: '/mock/bin' },
    });

    expect(report.passed).toBe(true);
    expect(report.changed).toBe(true);
    expect(readFileSync(join(repoPath, '.gitignore'), 'utf-8')).toContain('.devloop/');
    expect(readFileSync(join(repoPath, '.takt', '.gitignore'), 'utf-8')).toContain('!workflows/**');
    expect(readFileSync(join(repoPath, '.takt', 'config.yaml'), 'utf-8')).toContain('subscription_only: true');
    expect(readFileSync(join(repoPath, '.takt', 'devloopd.yaml'), 'utf-8')).toContain('mode: subscription_only');
    expect(readFileSync(join(repoPath, '.takt', 'workflows', 'subscription-devloop.yaml'), 'utf-8')).toContain('call: takt-default');
    expect(runner.calls).toContain('gh label create agent:auto-merge --repo owner/repo --color 5319e7 --description PR passed dual LLM review and is eligible for mechanical merge gates');
    expect(runner.calls).toContain('gh label create agent:blocked --repo owner/repo --color d93f0b --description Automation is blocked and needs operator attention');
  });

  it('preserves existing target workflow unless force is explicit', async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(repoPath, '.takt', 'workflows', 'subscription-devloop.yaml'), 'custom: true\n', 'utf-8');
    const runner = makeRunner(['agent:ready', 'agent:auto-merge', 'agent:blocked']);

    const report = await runPersonalOnboarding({
      repoPath,
      repo: 'owner/repo',
      apply: true,
      runner,
      env: { PATH: '/mock/bin' },
    });

    expect(report.passed).toBe(true);
    expect(readFileSync(join(repoPath, '.takt', 'workflows', 'subscription-devloop.yaml'), 'utf-8')).toBe('custom: true\n');
    expect(report.actions).toContainEqual({
      status: 'exists',
      name: 'subscription workflow',
      message: 'existing file preserved',
      path: join(repoPath, '.takt', 'workflows', 'subscription-devloop.yaml'),
    });
  });
});
