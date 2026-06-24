import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_SUBSCRIPTION_ONLY_ALLOWED_PROVIDERS,
  SUBSCRIPTION_ONLY_FORBIDDEN_ENV_NAMES,
  assertSubscriptionOnlyProvider,
  findForbiddenSubscriptionOnlyConfigKeyPaths,
  type SubscriptionOnlyPolicyConfig,
} from '../core/subscription-only/policy.js';
import { getGlobalConfigPath, getProjectConfigPath, resolveWorkflowConfigValues } from '../infra/config/index.js';
import {
  inspectWorkflowFile,
  resolveWorkflowDoctorTargets,
} from '../infra/config/loaders/workflowDoctor.js';
import { crossSpawn, getErrorMessage } from '../shared/utils/index.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type DevloopDoctorStatus = 'pass' | 'fail' | 'warn';

export interface DevloopDoctorCheck {
  status: DevloopDoctorStatus;
  name: string;
  message: string;
  detail?: string;
}

export interface DevloopDoctorReport {
  passed: boolean;
  checks: DevloopDoctorCheck[];
}

export interface DevloopDoctorCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DevloopDoctorCommandRunner {
  resolveCommand(command: string, env?: NodeJS.ProcessEnv): string | undefined;
  exec(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<DevloopDoctorCommandResult>;
}

export interface RunDevloopDoctorOptions {
  repoPath?: string;
  policyPath?: string;
  subscriptionOnly?: boolean;
  verbose?: boolean;
  skipAuth?: boolean;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopDoctorCommandRunner;
}

const REQUIRED_SUBSCRIPTION_COMMANDS = ['takt', 'gh', 'codex', 'opencode', 'agy'] as const;
const CURSOR_COMMAND_CANDIDATES = ['cursor-agent', 'agent'] as const;

function makeCheck(status: DevloopDoctorStatus, name: string, message: string, detail?: string): DevloopDoctorCheck {
  return detail === undefined ? { status, name, message } : { status, name, message, detail };
}

function sanitizeDetail(text: string): string {
  return sanitizeSensitiveText(text).trim();
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

function createDefaultCommandRunner(): DevloopDoctorCommandRunner {
  return {
    resolveCommand(command, env = process.env) {
      return resolveCommandFromPath(command, env);
    },
    async exec(command, args, options) {
      return new Promise<DevloopDoctorCommandResult>((resolveResult) => {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkSubscriptionOnlyFlag(required: boolean): DevloopDoctorCheck {
  if (required) {
    return makeCheck('pass', 'devloopd mode', 'subscription-only doctor mode enabled');
  }
  return makeCheck('fail', 'devloopd mode', 'run devloopd doctor with --subscription-only');
}

function checkDevloopPolicy(policyPath: string | undefined): DevloopDoctorCheck {
  if (policyPath === undefined) {
    return makeCheck('warn', 'devloop policy', 'no devloop policy file provided');
  }

  if (!existsSync(policyPath)) {
    return makeCheck('fail', 'devloop policy', `policy file not found: ${policyPath}`);
  }

  try {
    const parsed = parseYaml(readFileSync(policyPath, 'utf-8')) as unknown;
    if (!isRecord(parsed)) {
      return makeCheck('fail', 'devloop policy', 'policy file must be a YAML object');
    }
    if (parsed.mode !== 'subscription_only') {
      return makeCheck('fail', 'devloop policy', 'policy mode must be subscription_only');
    }
    return makeCheck('pass', 'devloop policy', 'policy mode is subscription_only');
  } catch (error) {
    return makeCheck('fail', 'devloop policy', `failed to read policy file: ${sanitizeDetail(getErrorMessage(error))}`);
  }
}

function checkForbiddenEnvironment(env: NodeJS.ProcessEnv): DevloopDoctorCheck {
  const forbiddenName = SUBSCRIPTION_ONLY_FORBIDDEN_ENV_NAMES.find((name) => env[name] !== undefined);
  if (forbiddenName === undefined) {
    return makeCheck('pass', 'environment', 'no API-key billing environment variables detected');
  }

  return makeCheck('fail', 'environment', `forbidden environment variable present: ${forbiddenName}`);
}

function checkCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  runner: DevloopDoctorCommandRunner,
): DevloopDoctorCheck {
  const resolved = runner.resolveCommand(command, env);
  if (resolved === undefined) {
    return makeCheck('fail', `command:${command}`, `command not found: ${command}`);
  }
  return makeCheck('pass', `command:${command}`, `found ${command}`, resolved);
}

function checkCursorCommand(env: NodeJS.ProcessEnv, runner: DevloopDoctorCommandRunner): DevloopDoctorCheck {
  for (const command of CURSOR_COMMAND_CANDIDATES) {
    const resolved = runner.resolveCommand(command, env);
    if (resolved !== undefined) {
      return makeCheck('pass', 'command:cursor', `using cursor CLI: ${command}`, resolved);
    }
  }

  return makeCheck('fail', 'command:cursor', 'command not found: cursor-agent or agent');
}

async function checkGitHubAuth(
  env: NodeJS.ProcessEnv,
  repoPath: string,
  runner: DevloopDoctorCommandRunner,
  skipAuth: boolean,
): Promise<DevloopDoctorCheck> {
  if (skipAuth) {
    return makeCheck('warn', 'gh auth', 'GitHub auth status check skipped');
  }
  if (runner.resolveCommand('gh', env) === undefined) {
    return makeCheck('fail', 'gh auth', 'cannot check GitHub auth because gh is missing');
  }

  const result = await runner.exec('gh', ['auth', 'status'], { cwd: repoPath, env });
  if (result.exitCode === 0) {
    return makeCheck('pass', 'gh auth', 'GitHub CLI is authenticated');
  }

  const detail = sanitizeDetail(result.stderr || result.stdout);
  return makeCheck('fail', 'gh auth', 'GitHub CLI is not authenticated', detail);
}

function checkRawConfigForForbiddenKeys(configPath: string, label: string): DevloopDoctorCheck {
  if (!existsSync(configPath)) {
    return makeCheck('warn', label, `config file not found: ${configPath}`);
  }

  try {
    const parsed = parseYaml(readFileSync(configPath, 'utf-8')) as unknown;
    const forbiddenPaths = findForbiddenSubscriptionOnlyConfigKeyPaths(parsed);
    if (forbiddenPaths.length === 0) {
      return makeCheck('pass', label, 'no API key config keys detected');
    }

    return makeCheck('fail', label, `forbidden config key present: ${forbiddenPaths[0]}`);
  } catch (error) {
    return makeCheck('fail', label, `failed to parse config: ${sanitizeDetail(getErrorMessage(error))}`);
  }
}

function buildSubscriptionPolicy(config: {
  subscriptionOnly?: boolean;
  allowedProviders?: readonly string[];
  forbiddenProviders?: readonly string[];
}): SubscriptionOnlyPolicyConfig {
  return {
    subscriptionOnly: config.subscriptionOnly,
    allowedProviders: config.allowedProviders as SubscriptionOnlyPolicyConfig['allowedProviders'],
    forbiddenProviders: config.forbiddenProviders,
  };
}

function checkResolvedTaktConfig(repoPath: string): DevloopDoctorCheck {
  try {
    const config = resolveWorkflowConfigValues(repoPath, [
      'subscriptionOnly',
      'allowedProviders',
      'forbiddenProviders',
      'provider',
    ]);

    if (config.subscriptionOnly !== true) {
      return makeCheck('fail', 'TAKT config', 'TAKT config must set subscription_only: true');
    }

    const policy = buildSubscriptionPolicy(config);
    assertSubscriptionOnlyProvider(config.provider, 'TAKT config provider', policy);

    return makeCheck(
      'pass',
      'TAKT config',
      `subscription_only is true; allowed providers: ${(policy.allowedProviders ?? DEFAULT_SUBSCRIPTION_ONLY_ALLOWED_PROVIDERS).join(', ')}`,
    );
  } catch (error) {
    return makeCheck('fail', 'TAKT config', sanitizeDetail(getErrorMessage(error)));
  }
}

function checkProjectWorkflows(repoPath: string): DevloopDoctorCheck[] {
  try {
    const targets = resolveWorkflowDoctorTargets([], repoPath);
    if (targets.length === 0) {
      return [makeCheck('pass', 'workflow files', 'no project workflows found')];
    }

    return targets.flatMap((target) => {
      const report = inspectWorkflowFile(target.filePath, repoPath, {
        lookupCwd: target.lookupCwd,
        source: target.source,
      });
      const failures = report.diagnostics.filter((diagnostic) => diagnostic.level === 'error');
      if (failures.length === 0) {
        return [makeCheck('pass', `workflow:${target.filePath}`, 'workflow passed doctor checks')];
      }

      return failures.map((failure) =>
        makeCheck(
          'fail',
          `workflow:${target.filePath}`,
          `workflow ${target.filePath}: ${sanitizeDetail(failure.message)}`,
        ),
      );
    });
  } catch (error) {
    return [makeCheck('fail', 'workflow files', sanitizeDetail(getErrorMessage(error)))];
  }
}

export async function runDevloopDoctor(options: RunDevloopDoctorOptions = {}): Promise<DevloopDoctorReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultCommandRunner();
  const checks: DevloopDoctorCheck[] = [
    checkSubscriptionOnlyFlag(options.subscriptionOnly === true),
    checkDevloopPolicy(options.policyPath),
    checkForbiddenEnvironment(env),
    ...REQUIRED_SUBSCRIPTION_COMMANDS.map((command) => checkCommand(command, env, runner)),
    checkCursorCommand(env, runner),
  ];

  checks.push(await checkGitHubAuth(env, repoPath, runner, options.skipAuth === true));

  if (options.subscriptionOnly === true) {
    checks.push(
      checkRawConfigForForbiddenKeys(getGlobalConfigPath(), 'global TAKT config'),
      checkRawConfigForForbiddenKeys(getProjectConfigPath(repoPath), 'project TAKT config'),
      checkResolvedTaktConfig(repoPath),
      ...checkProjectWorkflows(repoPath),
    );
  }

  return {
    passed: checks.every((check) => check.status !== 'fail'),
    checks,
  };
}

export function formatDevloopDoctorReport(report: DevloopDoctorReport, options: { verbose?: boolean } = {}): string {
  const visibleChecks = options.verbose
    || report.passed
    ? report.checks
    : report.checks.filter((check) => check.status !== 'pass');
  const lines = [
    report.passed ? 'devloopd doctor passed' : 'devloopd doctor failed',
    ...visibleChecks.map((check) => {
      const detail = check.detail ? ` (${sanitizeDetail(check.detail)})` : '';
      return `[${check.status}] ${check.name}: ${check.message}${detail}`;
    }),
  ];

  return lines.join('\n');
}
