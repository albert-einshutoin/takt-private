import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GITHUB_METADATA_TIMEOUT_MS,
  createDefaultDevloopCommandRunner,
  githubMetadataExecOptions,
  resolveGithubMetadataTimeoutMs,
} from '../devloopd/commandRunner.js';

describe('devloopd command runner', () => {
  it('passes stdin to child processes when provided', async () => {
    const runner = createDefaultDevloopCommandRunner();

    const result = await runner.exec(process.execPath, [
      '-e',
      'process.stdin.on("data", chunk => process.stdout.write(chunk.toString().toUpperCase()))',
    ], {
      stdin: 'done',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('DONE');
  });

  it('fails boundedly when a child process exceeds timeout', async () => {
    const runner = createDefaultDevloopCommandRunner();
    const startedAt = Date.now();

    const result = await runner.exec(process.execPath, [
      '-e',
      'setTimeout(() => {}, 5000)',
    ], {
      timeoutMs: 10,
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('command timed out after 10ms');
  });

  it('waits for a SIGTERM-ignoring child to close before resolving timeout', async () => {
    const runner = createDefaultDevloopCommandRunner();
    const directory = join(tmpdir(), `takt-command-timeout-${randomUUID()}`);
    const sideEffectPath = join(directory, 'posted');
    mkdirSync(directory, { recursive: true });
    try {
      const startedAt = Date.now();
      const result = await runner.exec(process.execPath, [
        '-e',
        [
          'const fs = require("node:fs");',
          'process.on("SIGTERM", () => {});',
          `setTimeout(() => fs.writeFileSync(${JSON.stringify(sideEffectPath)}, "posted"), 100);`,
          'setTimeout(() => {}, 5000);',
        ].join(''),
      ], { timeoutMs: 50 });

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
      expect(existsSync(sideEffectPath)).toBe(true);
      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: 'command timed out after 50ms',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['stdout', 'stderr'] as const)(
    'bounds %s while returning a fixed non-reflective overflow error',
    async (stream) => {
      const runner = createDefaultDevloopCommandRunner();
      const secret = 'token=stream-secret';
      const script = stream === 'stdout'
        ? `process.stdout.write(${JSON.stringify(secret.repeat(10_000))});`
        : `process.stderr.write(${JSON.stringify(secret.repeat(10_000))});`;

      const result = await runner.exec(process.execPath, ['-e', script], {
        maxOutputBytes: 128,
        timeoutMs: 5_000,
      });

      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: 'command output exceeded limit',
      });
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(128);
    },
  );

  it('resolves GitHub metadata timeout from environment with a safe default', () => {
    expect(resolveGithubMetadataTimeoutMs({})).toBe(DEFAULT_GITHUB_METADATA_TIMEOUT_MS);
    expect(resolveGithubMetadataTimeoutMs({ TAKT_LOOP_GH_TIMEOUT_MS: '1234' })).toBe(1234);
    expect(githubMetadataExecOptions({ cwd: '/repo', env: {} })).toMatchObject({
      cwd: '/repo',
      timeoutMs: DEFAULT_GITHUB_METADATA_TIMEOUT_MS,
    });
  });
});
