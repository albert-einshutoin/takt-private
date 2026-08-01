import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isProjectTemplateCliInvocation,
} from '../../app/cli/projectTemplateInvocation.js';

const runner = resolve('node_modules/.bin/vite-node');
const entrypoint = resolve('src/app/cli/index.ts');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(args: readonly string[]) {
  return spawnSync(runner, [entrypoint, '--', ...args], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

describe('project-template CLI entrypoint contract', () => {
  it('detects the real command without matching option values or task text', () => {
    expect(isProjectTemplateCliInvocation(['project-template', 'list'])).toBe(true);
    expect(isProjectTemplateCliInvocation(['--cwd', '/repo', 'project-template', 'list']))
      .toBe(true);
    expect(isProjectTemplateCliInvocation(['--quiet', 'project-template', 'list']))
      .toBe(true);
    expect(isProjectTemplateCliInvocation(['--task', 'project-template', 'run']))
      .toBe(false);
    expect(isProjectTemplateCliInvocation(['--task=project-template', 'run']))
      .toBe(false);
    expect(isProjectTemplateCliInvocation(['add', 'project-template'])).toBe(false);
    expect(isProjectTemplateCliInvocation(['workflow', 'init', 'project-template'])).toBe(false);
  });

  it('prints seven-command help without update UI, ANSI, or stderr', () => {
    const result = run(['project-template', '--help']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toMatch(/\u001b\[|new version|npm install/iu);
    for (const command of ['inspect', 'list', 'export', 'diff', 'apply', 'update', 'rollback']) {
      expect(result.stdout).toContain(command);
    }
  });

  it('honors root and per-command cwd while keeping one JSON document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'takt-cli-entrypoint-'));
    roots.push(root);
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first);
    await mkdir(second);

    const rootOption = run(['--cwd', first, 'project-template', 'list']);
    const commandOption = run([
      '--cwd', first, 'project-template', 'list', '--cwd', second, '--json',
    ]);

    for (const result of [rootOption, commandOption]) {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: '1.0', status: 'success', command: 'project-template list',
      });
    }
  });

  it('returns one INTERRUPTED envelope and exit 130 for in-flight SIGINT', async () => {
    const cache = resolve('node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const root = await mkdtemp(join(cache, 'takt-cli-entrypoint-'));
    roots.push(root);
    const marker = join(root, 'dispatch-started');
    const fixture = join(root, 'sigint-entrypoint.ts');
    const adapterUrl = pathToFileURL(resolve('src/app/cli/projectTemplateCommands.ts')).href;
    const machineUrl = pathToFileURL(resolve('src/features/project-template/cli-machine-contract.ts')).href;
    await writeFile(fixture, `
import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { registerProjectTemplateCommands } from ${JSON.stringify(adapterUrl)};
import { createProjectTemplateCliSuccess } from ${JSON.stringify(machineUrl)};
const program = new Command().name('takt').exitOverride();
program.option('--cwd <path>');
registerProjectTemplateCommands(program, {
  async dispatch(_request, context) {
    writeFileSync(${JSON.stringify(marker)}, 'started');
    await new Promise((resolveWait) => context.signal.addEventListener('abort', resolveWait, { once: true }));
    return {
      envelope: createProjectTemplateCliSuccess({
        command: 'project-template list', mode: 'dry-run',
        result: { installed: false, cohortId: '${'a'.repeat(64)}', backupIds: [], recoveryState: 'clean' },
      }),
      exitCode: 0,
    };
  },
  async dispose() {},
  writeStdout(chunk) { process.stdout.write(chunk); },
  setExitCode(code) { process.exitCode = code; },
  installInterrupt(interrupt) {
    process.once('SIGINT', interrupt);
    return () => process.removeListener('SIGINT', interrupt);
  },
  cwd: process.cwd,
  currentTaktVersion: '0.48.0',
});
await program.parseAsync(process.argv);
`);
    const child = spawn(runner, [fixture, '--', 'project-template', 'list', '--json'], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        NO_COLOR: '1', FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const startedAt = Date.now();
    while (true) {
      try {
        await access(marker);
        break;
      } catch {
        if (Date.now() - startedAt > 8_000) {
          child.kill('SIGKILL');
          throw new Error(`SIGINT fixture did not start: ${stdout} ${stderr}`);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    child.kill('SIGINT');
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });

    expect(exitCode).toBe(130);
    expect(stderr).toBe('');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({
      schemaVersion: '1.0', status: 'error', error: { code: 'INTERRUPTED' },
    });
  }, 15_000);

  it.each([
    ['per-command', ['project-template', 'list', '--wat', 'value']],
    ['root', ['--wat', 'value', 'project-template', 'list']],
    [
      'group apply-shaped',
      [
        'project-template', '--wat', 'secret-group-value', 'apply',
        '/private/entrypoint/group-source.taktpack', '--apply',
        '--expected-plan-id', 'a'.repeat(64),
      ],
    ],
    [
      'subcommand apply-shaped',
      [
        'project-template', 'secret-subcommand', '--apply',
        '/private/entrypoint/subcommand-source.taktpack',
      ],
    ],
  ] as const)('maps %s parser failure to one redacted envelope', (_name, args) => {
    const result = run(args);
    expect(result.status).toBe(20);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: '1.0', status: 'error', error: { code: 'UNKNOWN_OPTION' },
    });
    expect(result.stdout).not.toMatch(/secret-|\/private\/entrypoint/iu);
  });

  it('does not mistake a known root option value for the real apply command', () => {
    const result = run([
      '--task', 'project-template', '--wat', 'secret-root-value',
      'project-template', 'apply', '/private/entrypoint/source.taktpack',
      '--apply', '--expected-plan-id', 'a'.repeat(64),
    ]);

    expect(result.status).toBe(20);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: '1.0', status: 'error',
      command: 'project-template apply', mode: 'apply',
      error: { code: 'UNKNOWN_OPTION' },
    });
    expect(result.stdout).not.toMatch(/secret-root-value|\/private\/entrypoint/iu);
  });
});
