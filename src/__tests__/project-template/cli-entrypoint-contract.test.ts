import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const CLI_CHILD_TIMEOUT_MS = 12_000;
const duplicateRuntimeAssertionCases = [
  [
    'inspect', './missing.taktpack',
    ['--current-takt-version', '99.0.0', '--current-takt-version', '0.48.0'],
    'dry-run',
  ],
  [
    'diff', './missing.taktpack',
    ['--current-takt-version', '0.48.0', '--current-takt-version', '99.0.0'],
    'dry-run',
  ],
  [
    'apply', './missing.taktpack',
    ['--current-takt-version', '0.48.0', '--current-takt-version', '0.48.0'],
    'apply',
  ],
  [
    'update', 'github:owner/template@v1.0.0',
    ['--current-takt-version=0.48.0', '--current-takt-version', '99.0.0'],
    'apply',
  ],
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface BoundedRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

function runBounded(
  command: string,
  args: readonly string[],
  options: BoundedRunOptions = {},
) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? resolve('.'),
    encoding: 'utf8',
    env: options.env ?? process.env,
    // Why: Vitest cannot interrupt spawnSync. SIGKILL makes a hung real CLI
    // process bounded even when it ignores graceful termination signals.
    timeout: options.timeoutMs ?? CLI_CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
}

function run(args: readonly string[], envOverrides: NodeJS.ProcessEnv = {}) {
  return runBounded(runner, [entrypoint, '--', ...args], {
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...envOverrides,
    },
  });
}

describe('project-template CLI entrypoint contract', () => {
  it('force-kills a synchronous child that exceeds the bounded runner timeout', () => {
    const startedAt = Date.now();
    const result = runBounded(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 100 },
    );

    expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(result.signal).toBe('SIGKILL');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('detects the real command without matching option values or task text', () => {
    expect(isProjectTemplateCliInvocation(['project-template', 'list'])).toBe(true);
    expect(isProjectTemplateCliInvocation(['--cwd', '/repo', 'project-template', 'list']))
      .toBe(true);
    expect(isProjectTemplateCliInvocation(['--quiet', 'project-template', 'list']))
      .toBe(true);
    expect(isProjectTemplateCliInvocation(['-qc', 'project-template', 'list']))
      .toBe(true);
    expect(isProjectTemplateCliInvocation([
      '-tproject-template', 'project-template', 'list',
    ])).toBe(true);
    expect(isProjectTemplateCliInvocation(['-wdefault', 'project-template', 'list']))
      .toBe(true);
    expect(isProjectTemplateCliInvocation(['-i123', 'project-template', 'list']))
      .toBe(true);
    expect(isProjectTemplateCliInvocation(['--wat', 'project-template', 'list']))
      .toBe(true);
    expect(isProjectTemplateCliInvocation([
      '--wat', 'project-template', '--cwd', '/repo', 'list',
    ])).toBe(true);
    for (const option of [
      '--auto-pr', '--draft', '--pipeline', '--copy-workspace', '--skip-git',
      '--quiet', '--continue', '-q', '-c', '-qc',
    ]) {
      expect(isProjectTemplateCliInvocation(['--wat', 'project-template', option, 'list']))
        .toBe(true);
    }
    for (const option of [
      '--issue', '--pr', '--workflow', '--branch', '--repo', '--provider', '--model',
      '--task', '--isolation', '--cwd', '-i', '-w', '-b', '-t', '-qi', '-qw', '-qb', '-qt',
    ]) {
      expect(isProjectTemplateCliInvocation([
        '--wat', 'project-template', option, 'value', 'list',
      ])).toBe(true);
    }
    for (const option of [
      '--issue=value', '--pr=value', '--workflow=value', '--branch=value',
      '--repo=value', '--provider=value', '--model=value', '--task=value',
      '--isolation=value', '--cwd=value', '-ivalue', '-wvalue', '-bvalue', '-tvalue',
      '-qivalue', '-qwvalue', '-qbvalue', '-qtvalue',
    ]) {
      expect(isProjectTemplateCliInvocation(['--wat', 'project-template', option, 'list']))
        .toBe(true);
    }
    for (const option of ['--help', '--version', '-h', '-V', '-qh', '-qV']) {
      expect(isProjectTemplateCliInvocation(['--wat', 'project-template', option]))
        .toBe(true);
    }
    expect(isProjectTemplateCliInvocation(['--help', 'project-template', 'list']))
      .toBe(false);
    expect(isProjectTemplateCliInvocation(['-qV', 'project-template', 'list']))
      .toBe(false);
    expect(isProjectTemplateCliInvocation([
      '--wat', 'project-template', '--quiet=true', 'list',
    ])).toBe(false);
    expect(isProjectTemplateCliInvocation(['--wat', 'project-template', 'run']))
      .toBe(false);
    expect(isProjectTemplateCliInvocation(['--task', 'project-template', 'run']))
      .toBe(false);
    expect(isProjectTemplateCliInvocation(['--task=project-template', 'run']))
      .toBe(false);
    expect(isProjectTemplateCliInvocation(['add', 'project-template'])).toBe(false);
    expect(isProjectTemplateCliInvocation(['-qc', 'add', 'project-template']))
      .toBe(false);
    expect(isProjectTemplateCliInvocation(['workflow', 'init', 'project-template'])).toBe(false);
    expect(isProjectTemplateCliInvocation([
      '-qc', 'workflow', 'init', 'project-template',
    ])).toBe(false);
  });

  it.each([
    ['group boolean', ['--wat', 'project-template', '--quiet', 'list']],
    ['group value', ['--wat', 'project-template', '--issue', '1', 'list']],
    ['group cluster', ['--wat', 'project-template', '-qc', 'list']],
    [
      'child boolean',
      ['--wat', 'project-template', 'apply', 'missing.taktpack', '--quiet'],
    ],
  ] as const)('keeps the closed machine lifecycle for a trailing global %s option', (
    _name,
    args,
  ) => {
    const result = run(args);
    expect(result.status).toBe(20);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: '1.0', status: 'error', error: { code: 'UNKNOWN_OPTION' },
    });
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

  it.each([
    ['plain', ['project-template', '--json']],
    ['root cwd', ['--cwd', '/private/root-cwd', 'project-template', '--json']],
    ['attached root cwd', ['--cwd=/private/root-cwd', 'project-template', '--json']],
    ['group cwd', ['project-template', '--cwd', '/private/group-cwd', '--json']],
    ['attached group cwd', ['project-template', '--cwd=/private/group-cwd', '--json']],
  ] as const)('returns one JSON INVALID_ARGUMENT envelope when %s omits the child', (
    _name,
    args,
  ) => {
    const result = run(args);

    expect(result.status).toBe(20);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: '1.0', status: 'error',
      command: 'project-template', mode: 'dry-run',
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(result.stdout).not.toContain('/private/');
  });

  it.each([
    ['plain', ['project-template']],
    ['root cwd', ['--cwd', '/private/root-cwd', 'project-template']],
    ['attached root cwd', ['--cwd=/private/root-cwd', 'project-template']],
    ['group cwd', ['project-template', '--cwd', '/private/group-cwd']],
    ['attached group cwd', ['project-template', '--cwd=/private/group-cwd']],
  ] as const)('keeps one machine envelope when %s omits the child without --json', (
    _name,
    args,
  ) => {
    const result = run(args);

    expect(result.status).toBe(20);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: '1.0', status: 'error',
      command: 'project-template', mode: 'dry-run',
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(result.stdout).not.toContain('/private/');
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

  it.each(duplicateRuntimeAssertionCases)(
    'rejects duplicate runtime assertions for %s before filesystem work',
    async (command, source, assertions, mode) => {
      const root = await mkdtemp(join(tmpdir(), 'takt-cli-duplicate-version-'));
      roots.push(root);
      const cwd = join(root, command);
      await mkdir(cwd);
      const mutation = mode === 'apply'
        ? ['--apply', '--expected-plan-id', 'a'.repeat(64), '--force']
        : [];
      const result = run([
        '--cwd', cwd, 'project-template', command, source,
        ...assertions, ...mutation,
      ], {
        TAKT_CONFIG_DIR: join(root, 'global-config'),
      });

      expect(result.status).toBe(20);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: '1.0', status: 'error',
        command: `project-template ${command}`, mode,
        error: { code: 'INVALID_ARGUMENT' },
      });
      expect(await readdir(cwd)).toEqual([]);
      expect(await readdir(root)).toEqual([command]);
    },
  );

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

  it('survives repeated SIGINT after admission until terminal drain and listener cleanup', async () => {
    const cache = resolve('node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const root = await mkdtemp(join(cache, 'takt-cli-admitted-sigint-'));
    roots.push(root);
    const admitted = join(root, 'admitted');
    const release = join(root, 'release');
    const cleaned = join(root, 'listener-cleaned');
    const fixture = join(root, 'admitted-sigint-entrypoint.ts');
    const adapterUrl = pathToFileURL(resolve('src/app/cli/projectTemplateCommands.ts')).href;
    const machineUrl = pathToFileURL(resolve('src/features/project-template/cli-machine-contract.ts')).href;
    const lifecycleUrl = pathToFileURL(resolve('src/features/project-template/cli-lifecycle.ts')).href;
    const productionUrl = pathToFileURL(resolve('src/app/cli/projectTemplateCommandProduction.ts')).href;
    await writeFile(fixture, `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Command } from 'commander';
import { registerProjectTemplateCommands } from ${JSON.stringify(adapterUrl)};
import { createProjectTemplateCliSuccess } from ${JSON.stringify(machineUrl)};
import { consumeProjectTemplateCliMutationAdmission } from ${JSON.stringify(lifecycleUrl)};
import { createProjectTemplateCliCommandProductionDependencies } from ${JSON.stringify(productionUrl)};
const production = createProjectTemplateCliCommandProductionDependencies('0.48.0');
let installedInterrupt;
const program = new Command().name('takt').exitOverride();
program.option('--cwd <path>');
registerProjectTemplateCommands(program, {
  ...production,
  installInterrupt(interrupt) {
    installedInterrupt = interrupt;
    return production.installInterrupt(interrupt);
  },
  async dispatch(_request, context) {
    consumeProjectTemplateCliMutationAdmission(context.admitMutation);
    writeFileSync(${JSON.stringify(admitted)}, 'admitted');
    const deadline = Date.now() + 8_000;
    while (!existsSync(${JSON.stringify(release)})) {
      if (Date.now() >= deadline) throw new Error('release gate timeout');
      await delay(10);
    }
    return {
      envelope: createProjectTemplateCliSuccess({
        command: 'project-template apply', mode: 'apply',
        result: {
          planId: '${'a'.repeat(64)}', applied: true,
          backupId: 'backup-terminal', recoveryState: 'clean',
        },
      }),
      exitCode: 0,
    };
  },
});
await program.parseAsync(process.argv);
writeFileSync(
  ${JSON.stringify(cleaned)},
  String(process.listeners('SIGINT').includes(installedInterrupt)),
);
`);
    const child = spawn(runner, [
      fixture, '--', 'project-template', 'apply', './fixture.taktpack',
      '--apply', '--expected-plan-id', 'a'.repeat(64), '--json',
    ], {
      cwd: resolve('.'),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let closed = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const closePromise = new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        closed = true;
        resolveExit(code);
      });
    });
    const waitForFile = async (path: string, label: string): Promise<void> => {
      const startedAt = Date.now();
      while (true) {
        try {
          await access(path);
          return;
        } catch {
          if (closed || Date.now() - startedAt > 8_000) {
            throw new Error(`${label} timeout: ${stdout} ${stderr}`);
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
      }
    };

    try {
      await waitForFile(admitted, 'mutation admission');
      child.kill('SIGINT');
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      child.kill('SIGINT');
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      expect(closed).toBe(false);

      await writeFile(release, 'release');
      const exitCode = await new Promise<number | null>((resolveExit, reject) => {
        const timeout = setTimeout(() => reject(new Error('child drain timeout')), 8_000);
        closePromise.then((code) => {
          clearTimeout(timeout);
          resolveExit(code);
        }, (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(stdout)).toMatchObject({
        schemaVersion: '1.0', status: 'success',
        command: 'project-template apply', mode: 'apply',
        result: { applied: true, backupId: 'backup-terminal', recoveryState: 'clean' },
      });
      await waitForFile(cleaned, 'listener cleanup');
      expect(await readFile(cleaned, 'utf8')).toBe('false');
    } finally {
      if (!closed) {
        child.kill('SIGKILL');
        await Promise.race([
          closePromise.catch(() => null),
          new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
        ]);
      }
    }
  }, 20_000);

  it.each([
    ['per-command', ['project-template', 'list', '--wat', 'value']],
    ['root', ['--wat', 'value', 'project-template', 'list']],
    ['root unknown flag', ['--wat', 'project-template', 'list']],
    ['root short cluster', ['-qc', 'project-template', 'list', '--wat', 'value']],
    [
      'root attached short value',
      ['-tproject-template', 'project-template', 'list', '--wat', 'value'],
    ],
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
