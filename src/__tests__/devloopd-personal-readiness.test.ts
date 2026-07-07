import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatPersonalReadinessReport,
  runPersonalReadiness,
} from '../devloopd/personalReadiness.js';
import type { DevloopCommandRunner } from '../devloopd/commandRunner.js';

const cleanupDirs = new Set<string>();

function makeTempRepo(gitignore = '.devloop/\n.takt/runs/\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-personal-ready-'));
  cleanupDirs.add(dir);
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.takt', 'workflows', 'subscription-devloop.yaml'), 'steps: []\n', 'utf-8');
  writeFileSync(join(dir, '.gitignore'), gitignore, 'utf-8');
  return dir;
}

function makeRunner(options: {
  gitRoot?: boolean;
  origin?: string;
  ghAuth?: boolean;
  labels?: string[];
} = {}): DevloopCommandRunner {
  return {
    resolveCommand(command) {
      return command === 'git' || command === 'gh' ? `/mock/bin/${command}` : undefined;
    },
    async exec(command, args) {
      const invocation = `${command} ${args.join(' ')}`;
      if (invocation === 'git rev-parse --show-toplevel') {
        return options.gitRoot === false
          ? { exitCode: 1, stdout: '', stderr: 'not a git repository' }
          : { exitCode: 0, stdout: '/repo\n', stderr: '' };
      }
      if (invocation === 'git remote get-url origin') {
        return options.origin === undefined
          ? { exitCode: 1, stdout: '', stderr: 'No such remote' }
          : { exitCode: 0, stdout: `${options.origin}\n`, stderr: '' };
      }
      if (invocation === 'gh auth status') {
        return options.ghAuth === false
          ? { exitCode: 1, stdout: '', stderr: 'not logged in' }
          : { exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation === 'gh label list --repo owner/repo --json name --limit 200') {
        return {
          exitCode: 0,
          stdout: JSON.stringify((options.labels ?? ['agent:ready', 'agent:auto-merge', 'agent:blocked', 'human:review'])
            .map((name) => ({ name }))),
          stderr: '',
        };
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

describe('devloopd personal readiness', () => {
  it('passes when git, origin, GitHub auth, local ignores, and active-run checks are ready', async () => {
    const repoPath = makeTempRepo();

    const report = await runPersonalReadiness({
      repoPath,
      repo: 'owner/repo',
      runner: makeRunner({
        origin: 'https://github.com/owner/repo.git',
      }),
      env: { PATH: '/mock/bin' },
    });

    expect(report.passed).toBe(true);
    expect(report.checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(formatPersonalReadinessReport(report)).toContain('devloopd ready passed');
  });

  it('fails closed when the origin remote or GitHub auth is unavailable', async () => {
    const repoPath = makeTempRepo();

    const report = await runPersonalReadiness({
      repoPath,
      repo: 'owner/repo',
      runner: makeRunner({ ghAuth: false }),
      env: { PATH: '/mock/bin' },
    });

    expect(report.passed).toBe(false);
    expect(report.checks.map((check) => check.name)).toContain('git origin');
    expect(report.checks.map((check) => check.name)).toContain('gh auth');
    expect(formatPersonalReadinessReport(report)).toContain('devloopd ready failed');
  });

  it('fails when the subscription devloop workflow or required labels are missing', async () => {
    const repoPath = makeTempRepo();
    rmSync(join(repoPath, '.takt', 'workflows'), { recursive: true, force: true });

    const report = await runPersonalReadiness({
      repoPath,
      repo: 'owner/repo',
      runner: makeRunner({
        origin: 'https://github.com/owner/repo.git',
        labels: ['agent:ready'],
      }),
      env: { PATH: '/mock/bin' },
    });

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({
      status: 'fail',
      name: 'workflow',
      message: 'default subscription devloop workflow is missing',
      detail: '.takt/workflows/subscription-devloop.yaml',
    });
    expect(report.checks).toContainEqual({
      status: 'fail',
      name: 'github labels',
      message: 'required automation labels are missing',
      detail: 'missing labels: agent:auto-merge, agent:blocked, human:review',
    });
  });

  it('warns when local automation state is not ignored', async () => {
    const repoPath = makeTempRepo('node_modules/\n');

    const report = await runPersonalReadiness({
      repoPath,
      repo: 'owner/repo',
      runner: makeRunner({ origin: 'git@github.com:owner/repo.git' }),
      env: { PATH: '/mock/bin' },
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toContainEqual({
      status: 'warn',
      name: 'local ignores',
      message: 'local automation state is not fully ignored',
      detail: 'missing patterns: .devloop/, .takt/runs/',
    });
  });
});
