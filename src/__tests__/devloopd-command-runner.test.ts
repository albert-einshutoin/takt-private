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

  it('resolves GitHub metadata timeout from environment with a safe default', () => {
    expect(resolveGithubMetadataTimeoutMs({})).toBe(DEFAULT_GITHUB_METADATA_TIMEOUT_MS);
    expect(resolveGithubMetadataTimeoutMs({ TAKT_LOOP_GH_TIMEOUT_MS: '1234' })).toBe(1234);
    expect(githubMetadataExecOptions({ cwd: '/repo', env: {} })).toMatchObject({
      cwd: '/repo',
      timeoutMs: DEFAULT_GITHUB_METADATA_TIMEOUT_MS,
    });
  });
});
