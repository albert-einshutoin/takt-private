import { describe, expect, it } from 'vitest';
import { createDefaultDevloopCommandRunner } from '../devloopd/commandRunner.js';

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
});
