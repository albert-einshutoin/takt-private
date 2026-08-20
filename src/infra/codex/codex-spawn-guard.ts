import { basename } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { guardChildProcessStreams } from '../../shared/utils/child-process-guard.js';
import { createLogger } from '../../shared/utils/debug.js';

const log = createLogger('codex-spawn-guard');
const CODEX_BINARY_BASENAMES = new Set(['codex', 'codex.exe', 'codex.cmd']);
const CODEX_SDK_ORIGINATOR_ENV = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE';

type SpawnFn = (
  command: string,
  argsOrOptions?: readonly string[] | SpawnOptions,
  options?: SpawnOptions,
) => ChildProcess;

let installed = false;

function isCodexSpawn(
  command: string,
  argsOrOptions: readonly string[] | SpawnOptions | undefined,
  options: SpawnOptions | undefined,
): boolean {
  if (CODEX_BINARY_BASENAMES.has(basename(command).toLowerCase())) return true;
  if (!Array.isArray(argsOrOptions)) return false;
  return argsOrOptions[0] === 'exec'
    && argsOrOptions[1] === '--experimental-json'
    && options?.env !== undefined
    && Object.hasOwn(options.env, CODEX_SDK_ORIGINATOR_ENV);
}

export function installCodexSpawnGuard(): void {
  if (installed) return;
  const require = createRequire(import.meta.url);
  const childProcessModule = require('node:child_process') as { spawn: SpawnFn };
  const originalSpawn = childProcessModule.spawn;

  childProcessModule.spawn = (command, argsOrOptions, options) => {
    const child = originalSpawn(command, argsOrOptions, options);
    if (!isCodexSpawn(command, argsOrOptions, options)) return child;

    let streamFailureHandled = false;
    const teardown = guardChildProcessStreams(child, (error, source) => {
      log.debug('Swallowed stdio error from Codex child process', {
        source,
        message: error.message,
        code: (error as NodeJS.ErrnoException).code,
      });
      if (source === 'process' || streamFailureHandled) return;
      streamFailureHandled = true;
      if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
      try {
        child.kill();
      } catch (killError) {
        log.debug('Failed to terminate Codex child after stdio error', {
          message: killError instanceof Error ? killError.message : String(killError),
        });
      }
    });
    const finalize = (): void => {
      child.removeListener('close', finalize);
      child.removeListener('error', finalize);
      teardown();
    };
    child.on('close', finalize);
    child.on('error', finalize);
    return child;
  };

  syncBuiltinESMExports();
  installed = true;
}

installCodexSpawnGuard();
