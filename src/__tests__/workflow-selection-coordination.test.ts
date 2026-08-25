import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireRepertoireCoordinationLease } from '../features/repertoire/coordination-lease.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';

const promptState = vi.hoisted(() => ({
  selectOption: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  selectOption: (...args: unknown[]) => promptState.selectOption(...args),
}));

const { selectWorkflow } = await import('../features/workflowSelection/index.js');

describe('workflow selection repertoire coordination', () => {
  let configDir: string;
  let projectDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'takt-selection-global-'));
    projectDir = mkdtempSync(join(tmpdir(), 'takt-selection-project-'));
    chmodSync(configDir, 0o700);
    process.env.TAKT_CONFIG_DIR = configDir;
    writeFileSync(join(configDir, 'config.yaml'), 'enable_builtin_workflows: false\n');
    const workflowsDir = join(configDir, 'repertoire', '@owner', 'repo', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'review.yaml'), [
      'name: review',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    instruction: review',
    ].join('\n'));
    invalidateGlobalConfigCache();
    promptState.selectOption.mockReset();
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    rmSync(configDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('releases discovery before awaiting the selection prompt', async () => {
    let writerAcquired = false;
    promptState.selectOption.mockImplementation(async () => {
      const writer = await acquireRepertoireCoordinationLease({
        globalConfigDir: configDir,
        mode: 'write',
        timeoutMs: 250,
      });
      writerAcquired = true;
      writer.release();
      return null;
    });

    await expect(selectWorkflow(projectDir, { fallbackToDefault: false })).resolves.toBeNull();
    expect(writerAcquired).toBe(true);
  });
});
