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
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<DevloopCommandResult>;
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
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf-8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8');
        });
        child.on('error', (error) => {
          resolveResult({ exitCode: 1, stdout, stderr: getErrorMessage(error) });
        });
        child.on('close', (exitCode, signal) => {
          const signalDetail = signal ? `terminated by signal ${signal}` : '';
          resolveResult({
            exitCode: exitCode ?? 1,
            stdout,
            stderr: [stderr, signalDetail].filter(Boolean).join('\n'),
          });
        });
      });
    },
  };
}
