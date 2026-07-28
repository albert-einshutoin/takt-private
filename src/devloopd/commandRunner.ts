import { accessSync, constants } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { crossSpawn } from '../shared/utils/index.js';

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
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      stdin?: string;
      timeoutMs?: number;
      maxOutputBytes?: number;
    },
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
  maxOutputBytes?: number;
}): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
} {
  return {
    cwd: options.cwd,
    env: options.env,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: options.maxOutputBytes }),
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
        let closed = false;
        let terminationReason: 'timeout' | 'output_limit' | undefined;
        let spawnFailed = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
        const configuredOutputLimit = options?.maxOutputBytes;
        const maxOutputBytes = (
          configuredOutputLimit !== undefined
          && Number.isFinite(configuredOutputLimit)
          && configuredOutputLimit > 0
        )
          ? Math.floor(configuredOutputLimit)
          : undefined;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');

        const resolveOnce = (result: DevloopCommandResult): void => {
          if (settled) return;
          settled = true;
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          if (forceKillTimeout !== undefined) {
            clearTimeout(forceKillTimeout);
          }
          resolveResult(result);
        };

        const requestTermination = (reason: 'timeout' | 'output_limit'): void => {
          if (terminationReason !== undefined || closed) return;
          terminationReason = reason;
          // Once output becomes untrusted, discard both streams rather than
          // reflecting a secret-bearing prefix in the public failure result.
          stdout = '';
          stderr = '';
          stdoutBytes = 0;
          stderrBytes = 0;
          try {
            child.kill('SIGTERM');
          } catch {
            // The close event remains the only completion boundary.
          }
          forceKillTimeout = setTimeout(() => {
            if (closed) return;
            try {
              child.kill('SIGKILL');
            } catch {
              // The close event remains the only completion boundary.
            }
          }, 1_000);
          forceKillTimeout.unref?.();
        };

        if (options?.timeoutMs !== undefined) {
          timeout = setTimeout(() => {
            requestTermination('timeout');
          }, options.timeoutMs);
          timeout.unref?.();
        }

        const capture = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
          if (terminationReason !== undefined) return;
          const bytes = chunk.byteLength;
          const nextBytes = (stream === 'stdout' ? stdoutBytes : stderrBytes) + bytes;
          if (maxOutputBytes !== undefined && nextBytes > maxOutputBytes) {
            requestTermination('output_limit');
            return;
          }
          if (stream === 'stdout') {
            stdoutBytes = nextBytes;
            stdout += stdoutDecoder.write(chunk);
          } else {
            stderrBytes = nextBytes;
            stderr += stderrDecoder.write(chunk);
          }
        };

        child.stdout?.on('data', (chunk: Buffer) => {
          capture('stdout', chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          capture('stderr', chunk);
        });
        child.on('error', () => {
          // spawn errors are followed by close. Do not resolve early because a
          // caller may release an idempotency lock immediately after resolution.
          spawnFailed = true;
          stdout = '';
          stderr = '';
        });
        child.on('close', (exitCode, signal) => {
          closed = true;
          if (terminationReason === 'timeout') {
            resolveOnce({
              exitCode: 1,
              stdout: '',
              stderr: `command timed out after ${options?.timeoutMs}ms`,
            });
            return;
          }
          if (terminationReason === 'output_limit') {
            resolveOnce({
              exitCode: 1,
              stdout: '',
              stderr: 'command output exceeded limit',
            });
            return;
          }
          if (spawnFailed) {
            resolveOnce({
              exitCode: 1,
              stdout: '',
              stderr: 'command could not be started',
            });
            return;
          }
          // StringDecoder preserves multibyte code points split across data
          // chunks and deterministically replaces an incomplete trailing
          // sequence instead of silently dropping or double-decoding bytes.
          stdout += stdoutDecoder.end();
          stderr += stderrDecoder.end();
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
