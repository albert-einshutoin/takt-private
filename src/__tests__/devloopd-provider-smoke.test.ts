import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatProviderSmokeMatrixReport,
  parseProviderSmokeProviderList,
  runProviderSmokeMatrix,
} from '../devloopd/providerSmoke.js';
import type { DevloopCommandRunner } from '../devloopd/commandRunner.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';

function writeProjectConfig(projectDir: string, content: string): void {
  mkdirSync(join(projectDir, '.takt'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), content, 'utf-8');
}

function writeGlobalConfig(globalConfigDir: string, content: string): void {
  mkdirSync(globalConfigDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'config.yaml'), content, 'utf-8');
}

function writeWorkflow(projectDir: string, name: string, content: string): void {
  mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'workflows', `${name}.yaml`), content, 'utf-8');
}

function makeRunner(options: {
  availableCommands?: readonly string[];
  authExitCode?: number;
  versionExitCode?: number;
} = {}): DevloopCommandRunner {
  const available = new Set(options.availableCommands ?? ['codex', 'cursor-agent', 'opencode', 'agy']);
  return {
    resolveCommand(command) {
      return available.has(command) ? `/mock/bin/${command}` : undefined;
    },
    async exec(command, args) {
      if (args.join(' ') === 'auth list') {
        return {
          exitCode: options.authExitCode ?? 0,
          stdout: options.authExitCode === 1 ? '' : 'OpenCode Go',
          stderr: options.authExitCode === 1 ? '\x1b[31mnot logged in\x1b[0m' : '',
        };
      }
      if (args.join(' ') === '--version') {
        return {
          exitCode: options.versionExitCode ?? 0,
          stdout: `${command} 1.2.3`,
          stderr: '',
        };
      }
      if (args.join(' ') === '--help') {
        return { exitCode: 0, stdout: `${command} help`, stderr: '' };
      }
      return { exitCode: 0, stdout: 'Done', stderr: '' };
    },
  };
}

describe('devloopd provider smoke matrix', () => {
  let projectDir: string;
  let globalConfigDir: string;
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    projectDir = join(tmpdir(), `takt-provider-smoke-${randomUUID()}`);
    globalConfigDir = join(tmpdir(), `takt-provider-smoke-global-${randomUUID()}`);
    mkdirSync(projectDir, { recursive: true });
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    writeGlobalConfig(globalConfigDir, 'language: en\nprovider: codex-cli\n');
    writeProjectConfig(projectDir, [
      'subscription_only: true',
      'provider: opencode-cli',
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

  it('passes configured provider checks and explicitly skips unconfigured providers', async () => {
    const report = await runProviderSmokeMatrix({
      repoPath: projectDir,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    const opencode = report.results.find((result) => result.provider === 'opencode-cli');
    const agy = report.results.find((result) => result.provider === 'agy-cli');
    expect(report.passed).toBe(true);
    expect(report.configuredProviders).toEqual(['opencode-cli']);
    expect(opencode).toMatchObject({
      configured: true,
      status: 'pass',
      commandName: 'opencode',
      commandPath: '/mock/bin/opencode',
      authStatus: 'pass',
    });
    expect(opencode?.version).toContain('/mock/bin/opencode 1.2.3');
    expect(agy).toMatchObject({
      configured: false,
      status: 'skip',
    });
    expect(formatProviderSmokeMatrixReport(report)).toContain('provider is not configured');
  });

  it('fails when a configured provider command is missing', async () => {
    writeProjectConfig(projectDir, [
      'subscription_only: true',
      'provider: codex-cli',
      'allowed_providers: [codex-cli, cursor-cli, opencode-cli, agy-cli, mock]',
    ].join('\n'));
    invalidateAllResolvedConfigCache();

    const report = await runProviderSmokeMatrix({
      repoPath: projectDir,
      env: { PATH: '/mock/bin' },
      runner: makeRunner({ availableCommands: ['opencode'] }),
    });

    const codex = report.results.find((result) => result.provider === 'codex-cli');
    expect(report.passed).toBe(false);
    expect(codex).toMatchObject({
      configured: true,
      status: 'fail',
      authStatus: 'skip',
    });
    expect(formatProviderSmokeMatrixReport(report)).toContain('command not found: codex');
  });

  it('fails configured provider readiness when auth status fails and redacts output', async () => {
    const report = await runProviderSmokeMatrix({
      repoPath: projectDir,
      env: { PATH: '/mock/bin' },
      runner: makeRunner({ authExitCode: 1 }),
    });

    const output = formatProviderSmokeMatrixReport(report);
    const opencode = report.results.find((result) => result.provider === 'opencode-cli');
    expect(report.passed).toBe(false);
    expect(opencode?.authStatus).toBe('fail');
    expect(output).toContain('not logged in');
    expect(output).not.toContain('\x1b');
  });

  it('includes selected workflow provider alongside effective project config provider', async () => {
    writeWorkflow(projectDir, 'provider-smoke', [
      'name: provider-smoke',
      'workflow_config:',
      '  provider: agy-cli',
      'steps:',
      '  - name: plan',
      '    prompt: test',
      'max_steps: 1',
    ].join('\n'));
    invalidateAllResolvedConfigCache();

    const report = await runProviderSmokeMatrix({
      repoPath: projectDir,
      workflow: 'provider-smoke',
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    expect(report.configuredProviders).toEqual(['agy-cli', 'opencode-cli']);
    expect(report.results.find((result) => result.provider === 'agy-cli')).toMatchObject({
      configured: true,
      status: 'pass',
    });
    expect(report.results.find((result) => result.provider === 'opencode-cli')).toMatchObject({
      configured: true,
      status: 'pass',
    });
  });

  it('validates explicit provider lists for the CLI boundary', () => {
    expect(parseProviderSmokeProviderList(['codex-cli', 'agy-cli'])).toEqual(['codex-cli', 'agy-cli']);
    expect(() => parseProviderSmokeProviderList(['unknown'])).toThrow('unknown provider');
  });
});
