import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env.js';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo.js';

const RUNNER = resolve('node_modules/.bin/vite-node');
const ENTRYPOINT = resolve('src/app/cli/index.ts');
const REPOSITORY_ROOT = resolve('.');
const COMMAND_TIMEOUT_MS = 20_000;

interface CliResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

interface CliEnvelope {
  readonly schemaVersion: string;
  readonly status: 'success' | 'error';
  readonly command: string;
  readonly mode: 'dry-run' | 'apply';
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: string };
}

function formatResult(result: CliResult): string {
  return [
    `status=${String(result.status)} signal=${String(result.signal)}`,
    `stdout=${result.stdout}`,
    `stderr=${result.stderr}`,
    `error=${result.error?.message ?? ''}`,
  ].join('\n');
}

function runCli(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): CliResult {
  const result = spawnSync(RUNNER, ['--root', REPOSITORY_ROOT, ENTRYPOINT, '--', ...args], {
    cwd,
    env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function expectEnvelope(result: CliResult, exitCode: number): CliEnvelope {
  expect(result.error, formatResult(result)).toBeUndefined();
  expect(result.signal, formatResult(result)).toBeNull();
  expect(result.status, formatResult(result)).toBe(exitCode);
  expect(result.stderr, formatResult(result)).toBe('');
  const lines = result.stdout.trim().split('\n');
  expect(lines, formatResult(result)).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!) as CliEnvelope;
  expect(parsed.schemaVersion).toBe('1.0');
  return parsed;
}

function writeTemplateProject(repo: LocalRepo, content?: string): string {
  const workflow = join(repo.path, '.takt', 'workflows', 'review.yaml');
  mkdirSync(join(workflow, '..'), { recursive: true });
  writeFileSync(workflow, content ?? [
    'name: review',
    'max_steps: 10',
    'initial_step: review',
    'steps:',
    '  - name: review',
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '',
  ].join('\n'));
  execFileSync('git', ['add', '.takt'], { cwd: repo.path, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'add portable template'], {
    cwd: repo.path,
    stdio: 'pipe',
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo.path,
    encoding: 'utf8',
  }).trim();
}

function exportPack(source: LocalRepo, sourceCommit: string, env: NodeJS.ProcessEnv): {
  readonly outputPath: string;
  readonly apply: CliEnvelope;
} {
  const outputRoot = join(source.path, 'artifacts');
  const outputPath = join(outputRoot, 'team.taktpack');
  mkdirSync(outputRoot);
  const common = [
    'project-template', 'export', outputPath,
    '--cwd', source.path,
    '--pack-version', '1.0.0',
    '--min-takt-version', '0.48.0',
    '--source-commit', sourceCommit,
    '--json',
  ];
  const preview = expectEnvelope(runCli(source.path, env, [...common, '--dry-run']), 0);
  expect(preview).toMatchObject({
    status: 'success', command: 'project-template export', mode: 'dry-run',
  });
  const planId = preview.result?.['planId'];
  expect(planId).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));

  const apply = expectEnvelope(runCli(source.path, env, [
    ...common, '--apply', '--expected-plan-id', String(planId),
  ]), 0);
  expect(apply).toMatchObject({
    status: 'success', command: 'project-template export', mode: 'apply',
    result: { planId },
  });
  return { outputPath, apply };
}

describe('project-template real CLI process E2E', () => {
  let isolated: IsolatedEnv;
  const repos: LocalRepo[] = [];

  beforeEach(() => {
    isolated = createIsolatedEnv();
  });

  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
    isolated.cleanup();
  });

  function repo(): LocalRepo {
    const created = createLocalRepo();
    const value: LocalRepo = { ...created, path: realpathSync(created.path) };
    repos.push(value);
    return value;
  }

  it('exports atomically, then inspects and lists through fresh CLI processes', () => {
    const source = repo();
    const target = repo();
    const sourceCommit = writeTemplateProject(source);

    const exported = exportPack(source, sourceCommit, isolated.env);

    expect(statSync(exported.outputPath).isFile()).toBe(true);
    expect(readFileSync(exported.outputPath).byteLength).toBeGreaterThan(0);
    expect(readdirSync(join(source.path, 'artifacts'))).toEqual(['team.taktpack']);

    const inspected = expectEnvelope(runCli(target.path, isolated.env, [
      'project-template', 'inspect', exported.outputPath,
      '--cwd', target.path,
      '--current-takt-version', '0.48.0',
      '--json',
    ]), 0);
    expect(inspected).toMatchObject({
      status: 'success', command: 'project-template inspect', mode: 'dry-run',
      result: { entryCount: 1, readiness: 'ready' },
    });

    const listed = expectEnvelope(runCli(target.path, isolated.env, [
      'project-template', 'list', '--cwd', target.path, '--json',
    ]), 0);
    expect(listed).toMatchObject({
      status: 'success', command: 'project-template list', mode: 'dry-run',
      result: { installed: false, backupIds: [], recoveryState: 'clean' },
    });
  }, 60_000);

  it('applies a local pack from a fresh plan and exposes its durable backup in list', () => {
    const source = repo();
    const target = repo();
    const sourceCommit = writeTemplateProject(source);
    const { outputPath } = exportPack(source, sourceCommit, isolated.env);
    const common = [
      'project-template', 'apply', outputPath,
      '--cwd', target.path,
      '--current-takt-version', '0.48.0',
      '--json',
    ];

    const preview = expectEnvelope(runCli(target.path, isolated.env, [
      ...common, '--dry-run',
    ]), 0);
    expect(preview).toMatchObject({
      status: 'success', command: 'project-template apply', mode: 'dry-run',
      result: { readiness: 'review-required', changeCount: 1 },
    });
    const planId = preview.result?.['planId'];
    expect(planId).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));

    const applied = expectEnvelope(runCli(target.path, isolated.env, [
      ...common, '--apply', '--expected-plan-id', String(planId), '--force',
    ]), 0);
    expect(applied).toMatchObject({
      status: 'success', command: 'project-template apply', mode: 'apply',
      result: { planId, applied: true, recoveryState: 'clean' },
    });
    const backupId = applied.result?.['backupId'];
    expect(backupId).toEqual(expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));

    expect(readFileSync(
      join(target.path, '.takt', 'workflows', 'review.yaml'),
      'utf8',
    )).toContain('initial_step: review');
    for (const lock of [
      '.takt-template-lock.json',
      '.takt-template-repertoire-lock.json',
      '.takt-template-source-lock.json',
    ]) expect(existsSync(join(target.path, lock))).toBe(true);
    const controlRoot = join(target.path, '.takt-template-state');
    expect(existsSync(join(controlRoot, 'backups', String(backupId), 'manifest.json')))
      .toBe(true);
    expect(existsSync(join(controlRoot, 'journal.json'))).toBe(false);
    expect(existsSync(join(controlRoot, 'apply.lock'))).toBe(false);
    expect(readdirSync(join(controlRoot, 'staging'))).toEqual([]);

    const listed = expectEnvelope(runCli(target.path, isolated.env, [
      'project-template', 'list', '--cwd', target.path, '--json',
    ]), 0);
    expect(listed).toMatchObject({
      status: 'success', command: 'project-template list', mode: 'dry-run',
      result: { installed: true, backupIds: [backupId], recoveryState: 'clean' },
    });
  }, 90_000);

  it('redacts invalid argv paths and rejected secret-bearing template content', () => {
    const target = repo();
    const secretArgument = 'synthetic-secret-cli-value';
    const privatePath = '/private/taktdesk/operator/team.taktpack';
    const invalid = runCli(target.path, isolated.env, [
      'project-template', 'apply', privatePath,
      '--cwd', target.path,
      '--apply', '--expected-plan-id', 'a'.repeat(64),
      '--unknown-secret', secretArgument,
      '--json',
    ]);
    const invalidEnvelope = expectEnvelope(invalid, 20);
    expect(invalidEnvelope).toMatchObject({
      status: 'error', command: 'project-template apply', mode: 'apply',
      error: { code: 'UNKNOWN_OPTION' },
    });
    expect(invalid.stdout).not.toContain(secretArgument);
    expect(invalid.stdout).not.toContain(privatePath);

    const source = repo();
    const secretContent = 'Authorization: Bearer synthetic-template-token';
    const sourceCommit = writeTemplateProject(source, `name: review\n${secretContent}\n`);
    const outputRoot = join(source.path, 'artifacts');
    mkdirSync(outputRoot);
    const rejected = runCli(source.path, isolated.env, [
      'project-template', 'export', join(outputRoot, 'rejected.taktpack'),
      '--cwd', source.path,
      '--pack-version', '1.0.0',
      '--min-takt-version', '0.48.0',
      '--source-commit', sourceCommit,
      '--dry-run', '--json',
    ]);
    const rejectedEnvelope = expectEnvelope(rejected, 23);
    expect(rejectedEnvelope).toMatchObject({
      status: 'error', command: 'project-template export', mode: 'dry-run',
      error: { code: 'SECURITY_GUARD' },
    });
    expect(rejected.stdout).not.toContain(secretContent);
    expect(rejected.stdout).not.toContain(source.path);
    expect(readdirSync(outputRoot)).toEqual([]);
  }, 45_000);
});
