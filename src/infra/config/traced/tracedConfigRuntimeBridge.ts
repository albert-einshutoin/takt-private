import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { SchemaShape, TracedValue } from 'traced-config';
import { ensureCurrentTmpDirExists } from '../../../shared/utils/index.js';

type SerializedSchemaFormat = 'string' | 'number' | 'boolean' | 'json' | undefined;

type SerializedSchemaEntry = {
  default?: unknown;
  doc: string;
  format?: SerializedSchemaFormat;
  env?: string;
  sources?: {
    global?: boolean;
    local?: boolean;
    env?: boolean;
    cli?: boolean;
  };
};

type RuntimeLoadInput = {
  schemaGroups: Array<Record<string, SerializedSchemaEntry>>;
  fileOrigin: 'global' | 'local';
  tempConfigPath?: string;
};

type RuntimeLoadOutput = {
  traceEntries: Array<[string, TracedValue<unknown>]>;
};

const DEFAULT_TRACED_CONFIG_HELPER_TIMEOUT_MS = 10_000;
const TRACED_CONFIG_HELPER_TIMEOUT_ENV = 'TAKT_TRACED_CONFIG_HELPER_TIMEOUT_MS';

const require = createRequire(import.meta.url);
const { execFileSync: execFileSyncRuntime } = require('node:child_process') as typeof import('node:child_process');

function resolveRuntimeLoaderTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const rawTimeout = env[TRACED_CONFIG_HELPER_TIMEOUT_ENV];
  if (rawTimeout === undefined || rawTimeout.trim() === '') {
    return DEFAULT_TRACED_CONFIG_HELPER_TIMEOUT_MS;
  }

  const timeoutMs = Number(rawTimeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${TRACED_CONFIG_HELPER_TIMEOUT_ENV} must be a positive integer number of milliseconds`);
  }
  return timeoutMs;
}

type RuntimeLoaderError = Error & {
  code?: string;
  signal?: string | null;
  stderr?: Buffer | string;
};

function stringifyChildOutput(output: Buffer | string | undefined): string {
  if (output === undefined) {
    return '';
  }
  return Buffer.isBuffer(output) ? output.toString('utf-8').trim() : output.trim();
}

function createRuntimeLoaderError(error: unknown, timeoutMs: number): Error {
  const execError = error as RuntimeLoaderError;
  if (execError?.code === 'ETIMEDOUT') {
    return new Error(`traced-config helper timed out after ${timeoutMs}ms`, { cause: error });
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const stderr = stringifyChildOutput(execError?.stderr);
  const details = stderr ? `\n${stderr}` : '';
  return new Error(`traced-config helper failed: ${errorMessage}${details}`, { cause: error });
}

function executeRuntimeLoader(input: RuntimeLoadInput): RuntimeLoadOutput {
  const timeoutMs = resolveRuntimeLoaderTimeoutMs();
  let stdout: string;
  try {
    stdout = execFileSyncRuntime(
      process.execPath,
      ['--input-type=module', '-e', TRACED_CONFIG_RUNTIME_SCRIPT],
      {
        cwd: TAKT_PACKAGE_ROOT,
        env: process.env,
        input: JSON.stringify(input),
        encoding: 'utf-8',
        // This helper runs at workflow step transitions. A bounded subprocess keeps
        // config tracing from freezing the whole run if Node startup or traced-config stalls.
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
      },
    );
  } catch (error) {
    throw createRuntimeLoaderError(error, timeoutMs);
  }

  return JSON.parse(stdout.trim()) as RuntimeLoadOutput;
}

function serializeSchema(schema: SchemaShape): Record<string, SerializedSchemaEntry> {
  const serialized: Record<string, SerializedSchemaEntry> = {};
  for (const [key, entry] of Object.entries(schema)) {
    let format: SerializedSchemaFormat;
    if (entry.format === String) format = 'string';
    else if (entry.format === Number) format = 'number';
    else if (entry.format === Boolean) format = 'boolean';
    else if (entry.format === 'json') format = 'json';
    else format = undefined;

    serialized[key] = {
      default: entry.default,
      doc: entry.doc,
      format,
      env: entry.env,
      sources: entry.sources,
    };
  }
  return serialized;
}

function coerceJsonEnvValue(
  key: string,
  format: SerializedSchemaFormat,
  traced: TracedValue<unknown>,
): TracedValue<unknown> {
  if (format !== 'json' || (traced.origin !== 'env' && traced.origin !== 'cli') || typeof traced.value !== 'string') {
    return traced;
  }

  try {
    return {
      ...traced,
      value: JSON.parse(traced.value),
    };
  } catch {
    throw new Error(`Invalid JSON override for ${key}`);
  }
}

function hasSchemaCollision(schemaKeys: readonly string[], key: string): boolean {
  return schemaKeys.some((candidate) =>
    candidate === key || candidate.startsWith(`${key}.`) || key.startsWith(`${candidate}.`),
  );
}

function partitionSchema(schema: SchemaShape): SchemaShape[] {
  const groups: SchemaShape[] = [];
  for (const [key, entry] of Object.entries(schema)) {
    const group = groups.find((candidate) => !hasSchemaCollision(Object.keys(candidate), key));
    if (group) {
      group[key] = entry;
      continue;
    }
    groups.push({ [key]: entry });
  }
  return groups;
}

const TRACED_CONFIG_RUNTIME_SCRIPT = `
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const tracedConfigModuleUrl = import.meta.resolve('traced-config');
const { tracedConfig } = await import(tracedConfigModuleUrl);
const traceEntries = [];
for (const schemaGroup of input.schemaGroups) {
  const schema = {};
  for (const [key, entry] of Object.entries(schemaGroup)) {
    let format;
    if (entry.format === 'string') format = String;
    else if (entry.format === 'number') format = Number;
    else if (entry.format === 'boolean') format = Boolean;
    else if (entry.format === 'json') format = 'json';
    schema[key] = {
      default: entry.default,
      doc: entry.doc,
      format,
      env: entry.env,
      sources: entry.sources,
    };
  }

  const config = tracedConfig({
    defaultSources: { env: false, cli: false },
    schema,
  });

  if (input.tempConfigPath) {
    await config.loadFile([{ path: input.tempConfigPath, label: input.fileOrigin }]);
  }

  for (const key of Object.keys(schema)) {
    traceEntries.push([key, config.getTraced(key)]);
  }
}
process.stdout.write(JSON.stringify({ traceEntries }));
`;

const TAKT_PACKAGE_ROOT = dirname(fileURLToPath(new URL('../../../../package.json', import.meta.url)));

export function loadTraceEntriesViaRuntime(
  schema: SchemaShape,
  fileOrigin: 'global' | 'local',
  parsedConfig: Record<string, unknown>,
): Map<string, TracedValue<unknown>> {
  const tempDir = mkdtempSync(join(ensureCurrentTmpDirExists(), 'takt-traced-config-'));

  try {
    const tempConfigPath = Object.keys(parsedConfig).length > 0
      ? join(tempDir, 'config.yaml')
      : undefined;
    if (tempConfigPath) {
      writeFileSync(tempConfigPath, stringifyYaml(parsedConfig), 'utf-8');
    }

    const input: RuntimeLoadInput = {
      schemaGroups: partitionSchema(schema).map((schemaGroup) => serializeSchema(schemaGroup)),
      fileOrigin,
      tempConfigPath,
    };
    const result = executeRuntimeLoader(input);
    const traceEntries = new Map<string, TracedValue<unknown>>();
    for (const [key, traced] of result.traceEntries) {
      const entry = input.schemaGroups.find((group) => key in group)?.[key];
      if (!entry) {
        throw new Error(`Missing traced-config schema entry for ${key}`);
      }
      traceEntries.set(key, coerceJsonEnvValue(key, entry.format, traced));
    }
    return traceEntries;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
