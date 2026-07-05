import { resolve } from 'node:path';
import { loadWorkflow } from '../infra/config/loaders/workflowResolver.js';
import { resolveWorkflowConfigValues } from '../infra/config/index.js';
import {
  buildSubscriptionCliInvocation,
  buildSubscriptionOnlyEnv,
  type SubscriptionCliProviderType,
} from '../infra/subscription-cli/client.js';
import {
  PROVIDER_TYPES,
  isProviderType,
  type ProviderType,
} from '../shared/types/provider.js';
import { getErrorMessage } from '../shared/utils/error.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';
import { stripAnsi } from '../shared/utils/text.js';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandRunner,
} from './commandRunner.js';

export type ProviderSmokeStatus = 'pass' | 'fail' | 'skip';

export interface ProviderSmokeProbe {
  status: ProviderSmokeStatus;
  name: string;
  message: string;
  detail?: string;
}

export interface ProviderSmokeResult {
  provider: ProviderType;
  configured: boolean;
  status: ProviderSmokeStatus;
  commandName?: string;
  commandPath?: string;
  version?: string;
  authStatus: ProviderSmokeStatus;
  remediation?: string;
  probes: ProviderSmokeProbe[];
}

export interface ProviderSmokeMatrixReport {
  passed: boolean;
  repoPath: string;
  workflow?: string;
  configuredProviders: ProviderType[];
  results: ProviderSmokeResult[];
}

export interface RunProviderSmokeMatrixOptions {
  repoPath?: string;
  workflow?: string;
  providers?: readonly ProviderType[];
  runPromptSmoke?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
}

interface CliProviderSpec {
  provider: SubscriptionCliProviderType;
  commandNames: readonly string[];
  versionArgs: readonly string[];
  helpArgs: readonly string[];
  authArgs?: readonly string[];
}

const DEFAULT_SMOKE_TIMEOUT_MS = 15_000;
const SAFE_PROMPT = 'Reply with exactly: Done';

const CLI_PROVIDER_SPECS: Partial<Record<ProviderType, CliProviderSpec>> = {
  'codex-cli': {
    provider: 'codex-cli',
    commandNames: ['codex'],
    versionArgs: ['--version'],
    helpArgs: ['--help'],
  },
  'cursor-cli': {
    provider: 'cursor-cli',
    commandNames: ['cursor-agent', 'agent'],
    versionArgs: ['--version'],
    helpArgs: ['--help'],
  },
  'opencode-cli': {
    provider: 'opencode-cli',
    commandNames: ['opencode'],
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    authArgs: ['auth', 'list'],
  },
  'agy-cli': {
    provider: 'agy-cli',
    commandNames: ['agy'],
    versionArgs: ['--version'],
    helpArgs: ['--help'],
  },
};

function makeProbe(
  status: ProviderSmokeStatus,
  name: string,
  message: string,
  detail?: string,
): ProviderSmokeProbe {
  return detail === undefined ? { status, name, message } : { status, name, message, detail };
}

function sanitizeDetail(value: string): string {
  return sanitizeSensitiveText(stripAnsi(value)).replace(/\s+/g, ' ').trim();
}

function firstLine(value: string): string | undefined {
  const line = sanitizeDetail(value).split('\n').map((part) => part.trim()).find((part) => part.length > 0);
  if (line === undefined) {
    return undefined;
  }
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function uniqueProviders(providers: readonly ProviderType[]): ProviderType[] {
  return [...new Set(providers)];
}

function resolveCommandForSpec(
  spec: CliProviderSpec,
  env: NodeJS.ProcessEnv,
  runner: DevloopCommandRunner,
): { commandName: string; commandPath: string } | undefined {
  for (const commandName of spec.commandNames) {
    const commandPath = runner.resolveCommand(commandName, env);
    if (commandPath !== undefined) {
      return { commandName, commandPath };
    }
  }
  return undefined;
}

function workflowContextFor(repoPath: string, workflow: string | undefined) {
  if (workflow === undefined || workflow.trim() === '') {
    return undefined;
  }
  const loaded = loadWorkflow(workflow, repoPath);
  if (loaded === null) {
    throw new Error(`workflow not found: ${workflow}`);
  }
  return {
    provider: loaded.provider,
    model: loaded.model,
    providerOptions: loaded.providerOptions,
  };
}

function resolveConfiguredProviders(options: {
  repoPath: string;
  workflow?: string;
  providers?: readonly ProviderType[];
}): ProviderType[] {
  if (options.providers !== undefined && options.providers.length > 0) {
    return uniqueProviders(options.providers);
  }
  const workflowContext = workflowContextFor(options.repoPath, options.workflow);
  const resolved = resolveWorkflowConfigValues(options.repoPath, ['provider'], { workflowContext });
  return uniqueProviders([
    ...(workflowContext?.provider !== undefined ? [workflowContext.provider] : []),
    ...(resolved.provider !== undefined ? [resolved.provider] : []),
  ]);
}

async function runVersionOrHelpProbe(options: {
  provider: ProviderType;
  spec: CliProviderSpec;
  commandPath: string;
  repoPath: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
  timeoutMs: number;
}): Promise<{ probe: ProviderSmokeProbe; version?: string }> {
  const versionResult = await options.runner.exec(options.commandPath, options.spec.versionArgs, {
    cwd: options.repoPath,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  if (versionResult.exitCode === 0) {
    const version = firstLine(versionResult.stdout || versionResult.stderr);
    return {
      probe: makeProbe('pass', `${options.provider}:version`, 'version command completed', version),
      ...(version !== undefined ? { version } : {}),
    };
  }

  const helpResult = await options.runner.exec(options.commandPath, options.spec.helpArgs, {
    cwd: options.repoPath,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  if (helpResult.exitCode === 0) {
    const help = firstLine(helpResult.stdout || helpResult.stderr);
    return {
      probe: makeProbe('pass', `${options.provider}:help`, 'help command completed after version failed', help),
      ...(help !== undefined ? { version: help } : {}),
    };
  }

  return {
    probe: makeProbe(
      'fail',
      `${options.provider}:version`,
      'version/help command failed',
      sanitizeDetail(helpResult.stderr || helpResult.stdout || versionResult.stderr || versionResult.stdout),
    ),
  };
}

async function runAuthProbe(options: {
  provider: ProviderType;
  authArgs: readonly string[] | undefined;
  commandPath: string;
  repoPath: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
  timeoutMs: number;
}): Promise<ProviderSmokeProbe> {
  if (options.authArgs === undefined) {
    return makeProbe('skip', `${options.provider}:auth`, 'no non-mutating auth status probe is defined for this CLI');
  }
  const result = await options.runner.exec(options.commandPath, options.authArgs, {
    cwd: options.repoPath,
    env: buildSubscriptionOnlyEnv(options.env),
    timeoutMs: options.timeoutMs,
  });
  if (result.exitCode === 0) {
    return makeProbe('pass', `${options.provider}:auth`, 'auth status command completed');
  }
  return makeProbe(
    'fail',
    `${options.provider}:auth`,
    'auth status command failed',
    sanitizeDetail(result.stderr || result.stdout),
  );
}

async function runPromptProbe(options: {
  provider: ProviderType;
  spec: CliProviderSpec;
  commandPath: string;
  repoPath: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
  timeoutMs: number;
  enabled: boolean;
}): Promise<ProviderSmokeProbe> {
  if (!options.enabled) {
    return makeProbe('skip', `${options.provider}:prompt`, 'prompt smoke disabled by default to avoid paid or network work');
  }
  const invocation = buildSubscriptionCliInvocation(options.spec.provider, SAFE_PROMPT, {
    cwd: options.repoPath,
    commandPath: options.commandPath,
    timeoutMs: options.timeoutMs,
    agyPrintTimeout: `${Math.max(1, Math.ceil(options.timeoutMs / 1_000))}s`,
  });
  const result = await options.runner.exec(invocation.command, invocation.args, {
    cwd: options.repoPath,
    env: buildSubscriptionOnlyEnv(options.env),
    stdin: invocation.stdin,
    timeoutMs: invocation.timeoutMs ?? options.timeoutMs,
  });
  if (result.exitCode === 0) {
    return makeProbe('pass', `${options.provider}:prompt`, 'minimal prompt smoke completed');
  }
  return makeProbe(
    'fail',
    `${options.provider}:prompt`,
    'minimal prompt smoke failed',
    sanitizeDetail(result.stderr || result.stdout),
  );
}

async function smokeConfiguredCliProvider(options: {
  provider: ProviderType;
  spec: CliProviderSpec;
  repoPath: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
  timeoutMs: number;
  runPromptSmoke: boolean;
}): Promise<ProviderSmokeResult> {
  const probes: ProviderSmokeProbe[] = [];
  const command = resolveCommandForSpec(options.spec, options.env, options.runner);
  if (command === undefined) {
    probes.push(makeProbe(
      'fail',
      `${options.provider}:command`,
      `command not found: ${options.spec.commandNames.join(' or ')}`,
    ));
    return {
      provider: options.provider,
      configured: true,
      status: 'fail',
      authStatus: 'skip',
      remediation: `Install and authenticate the ${options.provider} CLI, or change TAKT provider configuration.`,
      probes,
    };
  }

  probes.push(makeProbe('pass', `${options.provider}:command`, `found ${command.commandName}`, command.commandPath));
  const versionProbe = await runVersionOrHelpProbe({
    provider: options.provider,
    spec: options.spec,
    commandPath: command.commandPath,
    repoPath: options.repoPath,
    env: options.env,
    runner: options.runner,
    timeoutMs: options.timeoutMs,
  });
  probes.push(versionProbe.probe);
  const authProbe = await runAuthProbe({
    provider: options.provider,
    authArgs: options.spec.authArgs,
    commandPath: command.commandPath,
    repoPath: options.repoPath,
    env: options.env,
    runner: options.runner,
    timeoutMs: options.timeoutMs,
  });
  probes.push(authProbe);
  probes.push(await runPromptProbe({
    provider: options.provider,
    spec: options.spec,
    commandPath: command.commandPath,
    repoPath: options.repoPath,
    env: options.env,
    runner: options.runner,
    timeoutMs: options.timeoutMs,
    enabled: options.runPromptSmoke,
  }));

  const failed = probes.some((probe) => probe.status === 'fail');
  return {
    provider: options.provider,
    configured: true,
    status: failed ? 'fail' : 'pass',
    commandName: command.commandName,
    commandPath: command.commandPath,
    ...(versionProbe.version !== undefined ? { version: versionProbe.version } : {}),
    authStatus: authProbe.status,
    ...(failed ? { remediation: `Fix ${options.provider} CLI command/auth output before starting personal automation.` } : {}),
    probes,
  };
}

function makeSkippedProvider(provider: ProviderType, configured: boolean): ProviderSmokeResult {
  const message = configured
    ? 'configured provider has no CLI smoke specification; use provider E2E or a provider-specific gate'
    : 'provider is not configured for this repo/workflow';
  return {
    provider,
    configured,
    status: 'skip',
    authStatus: 'skip',
    remediation: configured ? 'Add a non-mutating CLI or SDK probe before treating this provider as smoke-covered.' : undefined,
    probes: [makeProbe('skip', `${provider}:selection`, message)],
  };
}

export async function runProviderSmokeMatrix(
  options: RunProviderSmokeMatrixOptions = {},
): Promise<ProviderSmokeMatrixReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  let configuredProviders: ProviderType[];
  try {
    configuredProviders = resolveConfiguredProviders({
      repoPath,
      workflow: options.workflow,
      providers: options.providers,
    });
  } catch (error) {
    return {
      passed: false,
      repoPath,
      ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
      configuredProviders: [],
      results: [{
        provider: 'mock',
        configured: false,
        status: 'fail',
        authStatus: 'skip',
        remediation: 'Fix workflow/config loading before provider smoke can run.',
        probes: [makeProbe('fail', 'provider-smoke:config', sanitizeDetail(getErrorMessage(error)))],
      }],
    };
  }

  const configured = new Set(configuredProviders);
  const results: ProviderSmokeResult[] = [];
  for (const provider of PROVIDER_TYPES) {
    const isConfigured = configured.has(provider);
    const spec = CLI_PROVIDER_SPECS[provider];
    if (!isConfigured || spec === undefined) {
      results.push(makeSkippedProvider(provider, isConfigured));
      continue;
    }
    results.push(await smokeConfiguredCliProvider({
      provider,
      spec,
      repoPath,
      env,
      runner,
      timeoutMs: options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS,
      runPromptSmoke: options.runPromptSmoke === true,
    }));
  }

  return {
    passed: results.every((result) => result.status !== 'fail'),
    repoPath,
    ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
    configuredProviders,
    results,
  };
}

function formatProbe(probe: ProviderSmokeProbe): string {
  const detail = probe.detail === undefined ? '' : ` (${sanitizeDetail(probe.detail)})`;
  return `  - [${probe.status}] ${probe.name}: ${probe.message}${detail}`;
}

export function formatProviderSmokeMatrixReport(report: ProviderSmokeMatrixReport): string {
  const lines = [
    report.passed ? 'devloopd provider-smoke passed' : 'devloopd provider-smoke failed',
    `Repository: ${report.repoPath}`,
    ...(report.workflow !== undefined ? [`Workflow: ${report.workflow}`] : []),
    `Configured providers: ${report.configuredProviders.length === 0 ? 'none' : report.configuredProviders.join(', ')}`,
  ];

  for (const result of report.results) {
    lines.push(`[${result.status}] ${result.provider}${result.configured ? ' (configured)' : ''}`);
    if (result.commandPath !== undefined) {
      lines.push(`  command: ${result.commandName ?? result.provider} -> ${result.commandPath}`);
    }
    if (result.version !== undefined) {
      lines.push(`  version: ${sanitizeDetail(result.version)}`);
    }
    if (result.remediation !== undefined) {
      lines.push(`  remediation: ${result.remediation}`);
    }
    lines.push(...result.probes.map(formatProbe));
  }

  return lines.join('\n');
}

export function parseProviderSmokeProviderList(values: readonly string[] | undefined): ProviderType[] | undefined {
  if (values === undefined || values.length === 0) {
    return undefined;
  }
  return values.map((value) => {
    if (!isProviderType(value)) {
      throw new Error(`unknown provider: ${value}`);
    }
    return value;
  });
}
