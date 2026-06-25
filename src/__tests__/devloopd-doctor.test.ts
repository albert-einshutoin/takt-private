import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatDevloopDoctorReport,
  runDevloopDoctor,
  type DevloopDoctorCommandRunner,
} from '../devloopd/doctor.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';

function writeProjectConfig(projectDir: string, content: string): void {
  const configDir = join(projectDir, '.takt');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), content, 'utf-8');
}

function writeGlobalConfig(globalConfigDir: string, content: string): void {
  mkdirSync(globalConfigDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'config.yaml'), content, 'utf-8');
}

function writeDevloopPolicy(projectDir: string, content = 'mode: subscription_only\n'): string {
  const policyPath = join(projectDir, '.takt', 'devloopd.yaml');
  mkdirSync(join(projectDir, '.takt'), { recursive: true });
  writeFileSync(policyPath, content, 'utf-8');
  return policyPath;
}

function writeWorkflow(projectDir: string, content: string): void {
  const workflowDir = join(projectDir, '.takt', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, 'subscription.yaml'), content, 'utf-8');
}

function makeRunner(
  availableCommands = new Set(['takt', 'gh', 'codex', 'cursor-agent', 'opencode', 'agy']),
  ghAuthExitCode = 0,
): DevloopDoctorCommandRunner {
  return {
    resolveCommand(command) {
      return availableCommands.has(command) ? `/mock/bin/${command}` : undefined;
    },
    async exec(command, args) {
      if (command === 'gh' && args.join(' ') === 'auth status') {
        return { exitCode: ghAuthExitCode, stdout: '', stderr: ghAuthExitCode === 0 ? '' : 'not logged in' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

describe('devloopd doctor', () => {
  let projectDir: string;
  let globalConfigDir: string;
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    projectDir = join(tmpdir(), `takt-devloopd-doctor-${randomUUID()}`);
    globalConfigDir = join(tmpdir(), `takt-devloopd-doctor-global-${randomUUID()}`);
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

  it('passes when subscription-only config, required CLIs, and GitHub auth are available', async () => {
    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    expect(report.passed).toBe(true);
    expect(report.checks.filter((check) => check.status === 'fail')).toEqual([]);
  });

  it('uses the source checkout bin/takt when takt is not installed on PATH', async () => {
    mkdirSync(join(projectDir, 'bin'), { recursive: true });
    const localTakt = join(projectDir, 'bin', 'takt');
    writeFileSync(localTakt, '#!/usr/bin/env node\n', 'utf-8');
    chmodSync(localTakt, 0o755);

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(new Set(['gh', 'codex', 'cursor-agent', 'opencode', 'agy'])),
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toContainEqual({
      status: 'pass',
      name: 'command:takt',
      message: 'found takt',
      detail: localTakt,
    });
  });

  it('auto-discovers project-local devloop policy when --policy is omitted', async () => {
    const policyPath = writeDevloopPolicy(projectDir);

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toContainEqual({
      status: 'pass',
      name: 'devloop policy',
      message: 'policy mode is subscription_only',
      detail: policyPath,
    });
  });

  it('treats an absent optional global TAKT config as a passing skipped check', async () => {
    rmSync(join(globalConfigDir, 'config.yaml'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toContainEqual({
      status: 'pass',
      name: 'global TAKT config',
      message: `config file not found; skipped: ${join(globalConfigDir, 'config.yaml')}`,
    });
  });

  it('runs bounded real CLI smoke checks only when requested', async () => {
    const execCalls: Array<{
      command: string;
      args: readonly string[];
      stdin?: string;
      timeoutMs?: number;
    }> = [];
    const runner: DevloopDoctorCommandRunner = {
      resolveCommand(command) {
        return command === 'agent' ? undefined : `/mock/bin/${command}`;
      },
      async exec(command, args, options) {
        execCalls.push({ command, args, stdin: options?.stdin, timeoutMs: options?.timeoutMs });
        if (command === 'gh' && args.join(' ') === 'auth status') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: 'Done', stderr: '' };
      },
    };

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      smokeCli: true,
      smokeTimeoutMs: 1_234,
      env: { PATH: '/mock/bin' },
      runner,
    });

    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      'smoke:codex-cli',
      'smoke:cursor-cli',
      'smoke:opencode-cli',
      'smoke:agy-cli',
    ]));
    expect(execCalls).toContainEqual(expect.objectContaining({
      command: '/mock/bin/codex',
      stdin: 'Reply with exactly: Done',
      timeoutMs: 1_234,
    }));
    expect(execCalls).toContainEqual(expect.objectContaining({
      command: '/mock/bin/opencode',
      args: ['run', 'Reply with exactly: Done'],
      timeoutMs: 1_234,
    }));
  });

  it('fails the optional CLI smoke check when a provider command exits unsuccessfully', async () => {
    const runner: DevloopDoctorCommandRunner = {
      resolveCommand(command) {
        return command === 'agent' ? undefined : `/mock/bin/${command}`;
      },
      async exec(command, args) {
        if (command === 'gh' && args.join(' ') === 'auth status') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (command.endsWith('/opencode')) {
          return { exitCode: 1, stdout: '', stderr: '\x1b[91mUnknownError\x1b[0m: Unexpected server error' };
        }
        return { exitCode: 0, stdout: 'Done', stderr: '' };
      },
    };

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      smokeCli: true,
      env: { PATH: '/mock/bin' },
      runner,
    });

    expect(report.passed).toBe(false);
    const output = formatDevloopDoctorReport(report);
    expect(output).toContain('smoke:opencode-cli');
    expect(output).toContain('Unexpected server error');
    expect(output).not.toContain('\x1b');
  });

  it('skips optional CLI smoke checks when prerequisite doctor checks fail', async () => {
    const execCalls: string[] = [];
    const runner: DevloopDoctorCommandRunner = {
      resolveCommand(command) {
        return command === 'agy' ? undefined : `/mock/bin/${command}`;
      },
      async exec(command, args) {
        execCalls.push(`${command} ${args.join(' ')}`);
        if (command === 'gh' && args.join(' ') === 'auth status') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: 'Done', stderr: '' };
      },
    };

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      smokeCli: true,
      env: { PATH: '/mock/bin' },
      runner,
    });

    expect(report.passed).toBe(false);
    expect(formatDevloopDoctorReport(report)).toContain('subscription CLI smoke');
    expect(execCalls).toEqual(['gh auth status']);
  });

  it('hides passing check details unless verbose is enabled', () => {
    const report = {
      passed: true,
      checks: [
        { status: 'pass' as const, name: 'command:takt', message: 'found takt' },
        { status: 'warn' as const, name: 'devloop policy', message: 'no policy file provided' },
      ],
    };

    const terseOutput = formatDevloopDoctorReport(report);
    expect(terseOutput).toContain('devloopd doctor passed');
    expect(terseOutput).toContain('devloop policy');
    expect(terseOutput).not.toContain('command:takt');

    expect(formatDevloopDoctorReport(report, { verbose: true })).toContain('command:takt');
  });

  it('fails without leaking forbidden environment variable values', async () => {
    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: {
        PATH: '/mock/bin',
        OPENAI_API_KEY: 'sk-should-not-appear',
      },
      runner: makeRunner(),
    });

    const output = formatDevloopDoctorReport(report);

    expect(report.passed).toBe(false);
    expect(output).toContain('forbidden environment variable present: OPENAI_API_KEY');
    expect(output).not.toContain('sk-should-not-appear');
  });

  it('fails when TAKT config does not enable subscription-only mode', async () => {
    writeProjectConfig(projectDir, 'provider: codex-cli\n');
    invalidateAllResolvedConfigCache();

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    expect(report.passed).toBe(false);
    expect(formatDevloopDoctorReport(report)).toContain('TAKT config must set subscription_only: true');
  });

  it('fails when API key config exists in subscription-only mode', async () => {
    writeGlobalConfig(globalConfigDir, [
      'subscription_only: true',
      'provider: codex-cli',
      'openai_api_key: sk-should-not-appear',
    ].join('\n'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    const output = formatDevloopDoctorReport(report);
    expect(report.passed).toBe(false);
    expect(output).toContain('openai_api_key');
    expect(output).not.toContain('sk-should-not-appear');
  });

  it('fails when a project workflow declares an API provider', async () => {
    writeWorkflow(projectDir, `name: subscription
initial_step: plan
steps:
  - name: plan
    provider: codex
    rules:
      - condition: done
        next: COMPLETE
`);

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    expect(report.passed).toBe(false);
    expect(formatDevloopDoctorReport(report)).toMatch(/workflow.*codex/i);
  });

  it('accepts agent as the Cursor CLI fallback when cursor-agent is unavailable', async () => {
    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(new Set(['takt', 'gh', 'codex', 'agent', 'opencode', 'agy'])),
    });

    expect(report.passed).toBe(true);
    expect(formatDevloopDoctorReport(report, { verbose: true })).toContain('agent');
  });

  it('fails when a required subscription CLI is missing', async () => {
    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(new Set(['takt', 'gh', 'codex', 'cursor-agent', 'opencode'])),
    });

    expect(report.passed).toBe(false);
    expect(formatDevloopDoctorReport(report)).toContain('command not found: agy');
  });
});
