import { accessSync, constants } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { crossSpawn, getErrorMessage } from '../shared/utils/index.js';

export interface DevloopCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DevloopCommandRunner {
  resolveCommand(command: string, env?: NodeJS.ProcessEnv): string | undefined;
  exec(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number },
  ): Promise<DevloopCommandResult>;
}

export const DEFAULT_GITHUB_METADATA_TIMEOUT_MS = 60_000;
export const GITHUB_METADATA_TIMEOUT_ENV = 'TAKT_LOOP_GH_TIMEOUT_MS';

export function resolveGithubMetadataTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env[GITHUB_METADATA_TIMEOUT_ENV]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GITHUB_METADATA_TIMEOUT_MS;
}

export function githubMetadataExecOptions(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
}): { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number } {
  return {
    cwd: options.cwd,
    env: options.env,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    timeoutMs: options.timeoutMs ?? resolveGithubMetadataTimeoutMs(options.env),
  };
}

function canExecute(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateCommandNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32' || extname(command)) {
    return [command];
  }

  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function resolveCommandFromPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH ?? '';
  if (pathValue.trim() === '') {
    return undefined;
  }

  for (const directory of pathValue.split(delimiter)) {
    if (directory.trim() === '') {
      continue;
    }
    for (const commandName of candidateCommandNames(command, env)) {
      const candidate = join(directory, commandName);
      if (canExecute(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

export function createDefaultDevloopCommandRunner(): DevloopCommandRunner {
  return {
    resolveCommand(command, env = process.env) {
      return resolveCommandFromPath(command, env);
    },
    async exec(command, args, options) {
      return new Promise<DevloopCommandResult>((resolveResult) => {
        const child = crossSpawn(command, args, {
          cwd: options?.cwd,
          env: options?.env,
          stdio: [options?.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;

        const resolveOnce = (result: DevloopCommandResult, keepForceKillTimer = false): void => {
          if (settled) return;
          settled = true;
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          if (!keepForceKillTimer && forceKillTimeout !== undefined) {
            clearTimeout(forceKillTimeout);
          }
          resolveResult(result);
        };

        if (options?.timeoutMs !== undefined) {
          timeout = setTimeout(() => {
            child.kill('SIGTERM');
            // Some provider CLIs ignore SIGTERM while waiting on network streams; the
            // follow-up SIGKILL keeps readiness checks from leaving orphaned processes.
            forceKillTimeout = setTimeout(() => child.kill('SIGKILL'), 1_000);
            forceKillTimeout.unref?.();
            resolveOnce({
              exitCode: 1,
              stdout,
              stderr: [stderr, `command timed out after ${options.timeoutMs}ms`].filter(Boolean).join('\n'),
            }, true);
          }, options.timeoutMs);
          timeout.unref?.();
        }

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf-8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8');
        });
        child.on('error', (error) => {
          resolveOnce({ exitCode: 1, stdout, stderr: getErrorMessage(error) });
        });
        child.on('close', (exitCode, signal) => {
          const signalDetail = signal ? `terminated by signal ${signal}` : '';
          resolveOnce({
            exitCode: exitCode ?? 1,
            stdout,
            stderr: [stderr, signalDetail].filter(Boolean).join('\n'),
          });
        });

        if (options?.stdin !== undefined) {
          child.stdin?.end(options.stdin);
        }
      });
    },
  };
}
