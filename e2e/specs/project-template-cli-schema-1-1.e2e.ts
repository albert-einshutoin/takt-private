import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env.js';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo.js';
import {
  parseProjectTemplateCliEnvelopeJson,
  presentProjectTemplateCliEnvelope,
} from '../../src/features/project-template/cli-machine-contract.js';
import {
  parseProjectTemplateCliV1_1EnvelopeJson,
  presentProjectTemplateCliV1_1Envelope,
} from '../../src/features/project-template/cli-machine-contract-v1-1.js';

const RUNNER = resolve('node_modules/.bin/vite-node');
const ENTRYPOINT = resolve('src/app/cli/index.ts');
const REPOSITORY_ROOT = resolve('.');
const COMMAND_TIMEOUT_MS = 20_000;

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[]): CliResult {
  const result = spawnSync(RUNNER, ['--root', REPOSITORY_ROOT, ENTRYPOINT, '--', ...args], {
    cwd,
    env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function expectSingleJson(result: CliResult, exitCode: number): Record<string, unknown> {
  expect(result.status, result.stderr || result.stdout).toBe(exitCode);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function expectCanonicalV1(result: CliResult): Record<string, unknown> {
  const parsed = parseProjectTemplateCliEnvelopeJson(result.stdout);
  expect(presentProjectTemplateCliEnvelope(parsed)).toBe(result.stdout);
  return parsed as unknown as Record<string, unknown>;
}

function expectCanonicalV1_1(result: CliResult): Record<string, unknown> {
  const raw = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(raw.schemaVersion, result.stdout).toBe('1.1');
  const parsed = parseProjectTemplateCliV1_1EnvelopeJson(result.stdout);
  expect(presentProjectTemplateCliV1_1Envelope(parsed)).toBe(result.stdout);
  return parsed as unknown as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function createTemplate(repo: LocalRepo): string {
  const workflow = join(repo.path, '.takt', 'workflows', 'review.yaml');
  mkdirSync(join(workflow, '..'), { recursive: true });
  writeFileSync(workflow, [
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
  mkdirSync(join(repo.path, '.takt', 'runs'), { recursive: true });
  writeFileSync(join(repo.path, '.takt', 'runs', 'history.json'), '{}\n');
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

describe('project-template CLI schema 1.1 real child', () => {
  let isolated: IsolatedEnv;
  const repos: LocalRepo[] = [];

  beforeEach(() => { isolated = createIsolatedEnv(); });
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
    isolated.cleanup();
  });

  function repo(): LocalRepo {
    const created = createLocalRepo();
    const value = { ...created, path: realpathSync(created.path) };
    repos.push(value);
    return value;
  }

  it('negotiates library, export-security, and local preview DTOs without changing 1.0', () => {
    const source = repo();
    const target = repo();
    const commit = createTemplate(source);
    const artifactRoot = join(source.path, 'artifacts');
    const packPath = join(artifactRoot, 'team.taktpack');
    mkdirSync(artifactRoot);
    const exportBase = [
      'project-template', 'export', packPath,
      '--cwd', source.path,
      '--pack-version', '1.2.3',
      '--min-takt-version', '0.48.0',
      '--source-commit', commit,
      '--json',
    ];

    const defaultPreview = runCli(source.path, isolated.env, [...exportBase, '--dry-run']);
    expectSingleJson(defaultPreview, 0);
    const v1Preview = expectCanonicalV1(defaultPreview);
    expect(v1Preview.schemaVersion).toBe('1.0');
    expect(record(v1Preview.result)).not.toHaveProperty('detail');
    const planId = String(record(v1Preview.result).planId);

    const exported = runCli(source.path, isolated.env, [
      ...exportBase, '--apply', '--expected-plan-id', planId,
    ]);
    expectSingleJson(exported, 0);

    const inspectV1_1 = runCli(target.path, isolated.env, [
      'project-template', 'inspect', packPath,
      '--cwd', target.path,
      '--current-takt-version', '0.48.0',
      '--schema-version', '1.1', '--json',
    ]);
    expectSingleJson(inspectV1_1, 0);
    const inspected = expectCanonicalV1_1(inspectV1_1);
    const inspectDetail = record(record(inspected.result).detail);
    const identity = record(inspectDetail.identity);
    const compatibility = record(inspectDetail.compatibility);
    const libraryModel = {
      packVersion: identity.packVersion,
      archiveId: identity.archiveId,
      manifestId: identity.manifestId,
      compatibility: compatibility.status,
      sourceKind: record(inspectDetail.source).kind,
      declaredCapabilities: inspectDetail.declaredCapabilities,
      detectedCapabilities: inspectDetail.detectedCapabilities,
    };
    expect(libraryModel).toMatchObject({
      packVersion: '1.2.3',
      compatibility: 'compatible',
      sourceKind: 'local-import',
    });

    const inspectDefault = runCli(target.path, isolated.env, [
      'project-template', 'inspect', packPath, '--cwd', target.path, '--json',
    ]);
    expectSingleJson(inspectDefault, 0);
    expect(expectCanonicalV1(inspectDefault)).toMatchObject({ schemaVersion: '1.0' });

    const securityPreview = runCli(source.path, isolated.env, [
      ...exportBase,
      '--schema-version', '1.1',
      '--dry-run',
    ]);
    expectSingleJson(securityPreview, 0);
    const security = record(record(record(
      expectCanonicalV1_1(securityPreview).result,
    ).detail).securitySummary);
    expect(record(security.counts)).toMatchObject({
      portable: expect.any(Number),
      excluded: expect.any(Number),
      blocked: 0,
      reviewRequired: expect.any(Number),
    });
    expect(record(security.reasons)).toMatchObject({
      items: expect.any(Array),
      totalCount: expect.any(Number),
      truncated: false,
    });

    for (const command of ['diff', 'apply'] as const) {
      const preview = runCli(target.path, isolated.env, [
        'project-template', command, packPath,
        '--cwd', target.path,
        '--current-takt-version', '0.48.0',
        '--schema-version', '1.1',
        ...(command === 'apply' ? ['--dry-run'] : []),
        '--json',
      ]);
      expectSingleJson(preview, 0);
      const detail = record(record(expectCanonicalV1_1(preview).result).detail);
      expect(Object.keys(record(detail.actionCounts)).sort()).toEqual([
        'add', 'conflict', 'delete', 'excluded', 'keep', 'update',
      ]);
      expect(record(detail.targets)).toMatchObject({ items: expect.any(Array) });
      expect(record(detail.conflicts)).toMatchObject({ items: expect.any(Array) });
      expect(record(detail.capabilityWarnings)).toMatchObject({ items: expect.any(Array) });
    }

    for (const schemaArgs of [
      ['--schema-version', '2.0'],
      ['--schema-version', '1.1', '--schema-version', '1.1'],
    ]) {
      const rejected = runCli(target.path, isolated.env, [
        'project-template', 'inspect', packPath, '--cwd', target.path,
        ...schemaArgs, '--json',
      ]);
      const envelope = expectSingleJson(rejected, 20);
      expect(envelope).toMatchObject({
        status: 'error',
        error: { code: 'INVALID_ARGUMENT' },
      });
    }
  }, 90_000);
});
