import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatDevloopRunReport,
  runDevloopIssue,
  type DevloopRunCommandRunner,
} from '../devloopd/run.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';

interface ExecCall {
  command: string;
  args: readonly string[];
  cwd?: string;
}

function writeProjectConfig(projectDir: string, content: string): void {
  const configDir = join(projectDir, '.takt');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), content, 'utf-8');
}

function writeGlobalConfig(globalConfigDir: string, content: string): void {
  mkdirSync(globalConfigDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'config.yaml'), content, 'utf-8');
}

function makeRunner(options: {
  availableCommands?: Set<string>;
  taktExitCode?: number;
  taktStdout?: string;
  taktStderr?: string;
} = {}): DevloopRunCommandRunner & { calls: ExecCall[] } {
  const availableCommands = options.availableCommands ?? new Set(['takt', 'gh', 'codex', 'cursor-agent', 'opencode', 'agy']);
  const calls: ExecCall[] = [];

  return {
    calls,
    resolveCommand(command) {
      return availableCommands.has(command) ? `/mock/bin/${command}` : undefined;
    },
    async exec(command, args, execOptions) {
      if (command === 'gh' && args.join(' ') === 'auth status') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      calls.push({ command, args, cwd: execOptions?.cwd });
      return {
        exitCode: options.taktExitCode ?? 0,
        stdout: options.taktStdout ?? '',
        stderr: options.taktStderr ?? '',
      };
    },
  };
}

describe('devloopd run', () => {
  let projectDir: string;
  let globalConfigDir: string;
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    projectDir = join(tmpdir(), `takt-devloopd-run-${randomUUID()}`);
    globalConfigDir = join(tmpdir(), `takt-devloopd-run-global-${randomUUID()}`);
    mkdirSync(projectDir, { recursive: true });
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    writeGlobalConfig(globalConfigDir, 'language: en\nprovider: codex-cli\n');
    writeProjectConfig(projectDir, [
      'subscription_only: true',
      'provider: codex-cli',
      'allowed_providers: [codex-cli, cursor-cli, opencode-cli, agy-cli, mock]',
    ].join('\n'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    if (existsSync(globalConfigDir)) {
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('runs a TAKT issue pipeline after subscription-only doctor passes', async () => {
    const runner = makeRunner();

    const report = await runDevloopIssue({
      repoPath: projectDir,
      issue: 123,
      repo: 'nrslib/takt',
      workflow: 'workflows/subscription-devloop.yaml',
      env: { PATH: '/mock/bin' },
      runner,
    });

    expect(report.passed).toBe(true);
    expect(runner.calls).toEqual([
      {
        command: '/mock/bin/takt',
        args: [
          '--pipeline',
          '--isolation',
          'worktree',
          '--issue',
          '123',
          '--workflow',
          'workflows/subscription-devloop.yaml',
          '--auto-pr',
          '--quiet',
          '--repo',
          'nrslib/takt',
        ],
        cwd: projectDir,
      },
    ]);
    expect(formatDevloopRunReport(report)).toContain('--issue 123');
  });

  it('does not invoke TAKT when the subscription-only doctor fails', async () => {
    const runner = makeRunner();

    const report = await runDevloopIssue({
      repoPath: projectDir,
      issue: 123,
      env: { PATH: '/mock/bin', OPENAI_API_KEY: 'sk-should-not-leak' },
      runner,
    });

    const output = formatDevloopRunReport(report);
    expect(report.passed).toBe(false);
    expect(runner.calls).toEqual([]);
    expect(output).toContain('forbidden environment variable present: OPENAI_API_KEY');
    expect(output).not.toContain('sk-should-not-leak');
  });

  it('reports TAKT pipeline failure without leaking sensitive output', async () => {
    const runner = makeRunner({
      taktExitCode: 2,
      taktStderr: 'openai_api_key: sk-should-not-leak',
    });

    const report = await runDevloopIssue({
      repoPath: projectDir,
      issue: 123,
      env: { PATH: '/mock/bin' },
      runner,
    });

    const output = formatDevloopRunReport(report);
    expect(report.passed).toBe(false);
    expect(output).toContain('TAKT pipeline exited with code 2');
    expect(output).not.toContain('sk-should-not-leak');
  });

  it('omits auto-pr and quiet flags when explicitly disabled', async () => {
    const runner = makeRunner();

    await runDevloopIssue({
      repoPath: projectDir,
      issue: 123,
      env: { PATH: '/mock/bin' },
      runner,
      autoPr: false,
      quiet: false,
    });

    expect(runner.calls[0]?.args).toEqual([
      '--pipeline',
      '--isolation',
      'worktree',
      '--issue',
      '123',
      '--workflow',
      '.takt/workflows/subscription-devloop.yaml',
    ]);
  });
});
