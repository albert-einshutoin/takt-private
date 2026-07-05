import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatPersonalCheckReport,
  runPersonalCheck,
} from '../devloopd/personalCheck.js';
import type { DevloopCommandRunner } from '../devloopd/commandRunner.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';

function writeProjectConfig(projectDir: string, provider = 'opencode-cli'): void {
  mkdirSync(join(projectDir, '.takt'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
    'subscription_only: true',
    `provider: ${provider}`,
    'allowed_providers: [codex-cli, cursor-cli, opencode-cli, agy-cli, mock]',
  ].join('\n'), 'utf-8');
}

function makeRunner(options: {
  failCommand?: string;
  providerAuthExitCode?: number;
} = {}): DevloopCommandRunner {
  return {
    resolveCommand(command) {
      return `/mock/bin/${command}`;
    },
    async exec(command, args) {
      const label = [command, ...args].join(' ');
      if (label === options.failCommand) {
        return { exitCode: 1, stdout: '', stderr: 'failed with token sk-secret-test' };
      }
      if (args.join(' ') === 'auth list') {
        return {
          exitCode: options.providerAuthExitCode ?? 0,
          stdout: options.providerAuthExitCode === 1 ? '' : 'OpenCode Go',
          stderr: options.providerAuthExitCode === 1 ? 'not logged in' : '',
        };
      }
      if (args.join(' ') === '--version') {
        return { exitCode: 0, stdout: `${command} 1.2.3`, stderr: '' };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  };
}

describe('devloopd personal check gate', () => {
  let projectDir: string;
  let globalConfigDir: string;
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    projectDir = join(tmpdir(), `takt-personal-check-${randomUUID()}`);
    globalConfigDir = join(tmpdir(), `takt-personal-check-global-${randomUUID()}`);
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalConfigDir, { recursive: true });
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    writeFileSync(join(globalConfigDir, 'config.yaml'), 'language: en\nprovider: codex-cli\n', 'utf-8');
    writeProjectConfig(projectDir);
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

  it('passes required gates and writes a machine-readable summary', async () => {
    const summaryPath = join(projectDir, '.devloop', 'summary.json');
    const report = await runPersonalCheck({
      repoPath: projectDir,
      summaryPath,
      skipBuild: true,
      runner: makeRunner(),
      env: { PATH: '/mock/bin' },
    });

    expect(report.passed).toBe(true);
    expect(report.gates.find((gate) => gate.name === 'build')).toMatchObject({
      status: 'pass',
      message: 'build already completed by the npm script wrapper',
    });
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8')) as { passed?: boolean; gates?: unknown[] };
    expect(summary.passed).toBe(true);
    expect(summary.gates?.length).toBe(report.gates.length);
    expect(formatPersonalCheckReport(report)).toContain('devloopd check-personal passed');
  });

  it('fails when a required command gate fails and redacts details', async () => {
    const report = await runPersonalCheck({
      repoPath: projectDir,
      skipBuild: true,
      providerSmoke: false,
      runner: makeRunner({ failCommand: 'npm run lint' }),
      env: { PATH: '/mock/bin' },
    });

    const lint = report.gates.find((gate) => gate.name === 'lint');
    expect(report.passed).toBe(false);
    expect(lint).toMatchObject({ status: 'fail', required: true });
    expect(lint?.detail).toContain('[REDACTED]');
    expect(lint?.detail).not.toContain('sk-secret-test');
  });

  it('does not silently pass when a required gate is skipped', async () => {
    const report = await runPersonalCheck({
      repoPath: projectDir,
      skipBuild: true,
      skipMockE2e: true,
      providerSmoke: false,
      runner: makeRunner(),
      env: { PATH: '/mock/bin' },
    });

    expect(report.passed).toBe(false);
    expect(report.gates.find((gate) => gate.name === 'mock-e2e')).toMatchObject({
      status: 'skip',
      required: true,
    });
  });

  it('reports optional provider smoke failure without blocking mandatory readiness', async () => {
    const report = await runPersonalCheck({
      repoPath: projectDir,
      skipBuild: true,
      runner: makeRunner({ providerAuthExitCode: 1 }),
      env: { PATH: '/mock/bin' },
    });

    expect(report.passed).toBe(true);
    expect(report.gates.find((gate) => gate.name === 'provider-smoke')).toMatchObject({
      status: 'fail',
      required: false,
    });
  });

  it('blocks readiness when provider smoke is explicitly required', async () => {
    const report = await runPersonalCheck({
      repoPath: projectDir,
      skipBuild: true,
      requireProviderSmoke: true,
      runner: makeRunner({ providerAuthExitCode: 1 }),
      env: { PATH: '/mock/bin' },
    });

    expect(report.passed).toBe(false);
    expect(report.gates.find((gate) => gate.name === 'provider-smoke')).toMatchObject({
      status: 'fail',
      required: true,
    });
  });
});
