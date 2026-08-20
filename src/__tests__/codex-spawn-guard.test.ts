import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn as esmSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../infra/codex/codex-spawn-guard.js';

type SpawnFunction = (
  command: string,
  argsOrOptions?: readonly string[] | SpawnOptions,
  options?: SpawnOptions,
) => ChildProcess;

const require = createRequire(import.meta.url);
const childProcessModule = require('node:child_process') as { spawn: SpawnFunction };
const tempRoots = new Set<string>();

function makeExecutable(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-codex-guard-'));
  tempRoots.add(dir);
  const file = join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(file, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') chmodSync(file, 0o755);
  return file;
}

function waitForClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('close', () => resolve()));
}

function spawnOptions(): SpawnOptions {
  return {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(process.platform === 'win32' ? { shell: true } : {}),
  };
}

describe('codex spawn guard', () => {
  afterEach(() => {
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
    tempRoots.clear();
  });

  it('synchronizes the guarded CJS spawn into the ESM binding', () => {
    expect(childProcessModule.spawn).toBe(esmSpawn);
  });

  it('guards Codex stdio without altering unrelated children', async () => {
    const codex = childProcessModule.spawn(makeExecutable('codex'), [], spawnOptions());
    const other = childProcessModule.spawn(makeExecutable('other'), [], spawnOptions());

    expect((codex.stdin as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
    expect((codex.stdout as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
    expect((codex.stderr as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
    expect((other.stdin as EventEmitter).listenerCount('error')).toBe(0);

    await Promise.all([waitForClose(codex), waitForClose(other)]);
    expect((codex.stdin as EventEmitter).listenerCount('error')).toBe(0);
  });
});
