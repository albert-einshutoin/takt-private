import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_SUBSCRIPTION_ONLY_ALLOWED_PROVIDERS,
  SUBSCRIPTION_ONLY_FORBIDDEN_ENV_NAMES,
  assertSubscriptionOnlyProvider,
  findForbiddenSubscriptionOnlyConfigKeyPaths,
  getSubscriptionOnlyAllowedProviders,
  type SubscriptionOnlyPolicyConfig,
} from '../core/subscription-only/policy.js';
import { getGlobalConfigPath, getProjectConfigPath, resolveWorkflowConfigValues } from '../infra/config/index.js';
import {
  inspectWorkflowFile,
  resolveWorkflowDoctorTargets,
} from '../infra/config/loaders/workflowDoctor.js';
import {
  buildSubscriptionCliInvocation,
  buildSubscriptionOnlyEnv,
  type SubscriptionCliProviderType,
} from '../infra/subscription-cli/client.js';
import { getErrorMessage } from '../shared/utils/index.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';
import { stripAnsi } from '../shared/utils/text.js';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandResult,
  type DevloopCommandRunner,
} from './commandRunner.js';

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

export type DevloopDoctorCommandResult = DevloopCommandResult;
export type DevloopDoctorCommandRunner = DevloopCommandRunner;

export interface RunDevloopDoctorOptions {
  repoPath?: string;
  policyPath?: string;
  subscriptionOnly?: boolean;
  verbose?: boolean;
  skipAuth?: boolean;
  smokeCli?: boolean;
  smokeTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopDoctorCommandRunner;
}

const REQUIRED_SUBSCRIPTION_COMMANDS = ['takt', 'gh', 'codex', 'opencode', 'agy'] as const;
const CURSOR_COMMAND_CANDIDATES = ['cursor-agent', 'agent'] as const;
const SUBSCRIPTION_CLI_SMOKE_PROVIDERS: readonly SubscriptionCliProviderType[] = [
  'codex-cli',
  'cursor-cli',
  'opencode-cli',
  'agy-cli',
];
const DEFAULT_CLI_SMOKE_TIMEOUT_MS = 60_000;
const OPENCODE_AUTH_LIST_TIMEOUT_MS = 10_000;
const OPENCODE_RECENT_LOG_LIMIT = 10;
const OPENCODE_RECENT_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const OPENCODE_LOG_TAIL_BYTES = 64 * 1_024;
const CLI_SMOKE_PROMPT = 'Reply with exactly: Done';

function makeCheck(status: DevloopDoctorStatus, name: string, message: string, detail?: string): DevloopDoctorCheck {
  return detail === undefined ? { status, name, message } : { status, name, message, detail };
}

function sanitizeDetail(text: string): string {
  return sanitizeSensitiveText(stripAnsi(text)).trim();
}

function appendSubscriptionCliSmokeHint(
  provider: SubscriptionCliProviderType,
  detail: string,
): string {
  if (provider !== 'opencode-cli' || !/UnknownError/i.test(detail) || !/Unexpected server error/i.test(detail)) {
    return detail;
  }

  // OpenCode UnknownError is returned after the CLI reaches OpenCode, so TAKT
  // should steer users toward direct CLI/account/service checks instead of
  // implying a subscription-only config or API-key fallback issue.
  const hint = [
    'OpenCode returned a server-side UnknownError.',
    'Run `opencode run "Reply with exactly: Done"` directly to confirm the CLI outside TAKT.',
    'If global MCP config is suspect, retry with `OPENCODE_CONFIG_CONTENT=\'{"mcp":{"pencil":{"enabled":false}}}\' opencode run "Reply with exactly: Done"`.',
    'If the direct command still fails, check OpenCode account/service state; TAKT does not fall back to API-key providers in subscription-only mode.',
  ].join(' ');
  return `${detail}\n${hint}`;
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

const DEFAULT_DEVLOOP_POLICY_PATH = join('.takt', 'devloopd.yaml');

function resolveDevloopPolicyPath(repoPath: string, policyPath: string | undefined): string | undefined {
  if (policyPath !== undefined) {
    return policyPath;
  }

  // Keep private checkout readiness self-contained while preserving explicit --policy precedence.
  const defaultPolicyPath = join(repoPath, DEFAULT_DEVLOOP_POLICY_PATH);
  return existsSync(defaultPolicyPath) ? defaultPolicyPath : undefined;
}

function checkDevloopPolicy(repoPath: string, policyPath: string | undefined): DevloopDoctorCheck {
  const resolvedPolicyPath = resolveDevloopPolicyPath(repoPath, policyPath);
  if (resolvedPolicyPath === undefined) {
    return makeCheck('warn', 'devloop policy', 'no devloop policy file provided');
  }

  if (!existsSync(resolvedPolicyPath)) {
    return makeCheck('fail', 'devloop policy', `policy file not found: ${resolvedPolicyPath}`);
  }

  try {
    const parsed = parseYaml(readFileSync(resolvedPolicyPath, 'utf-8')) as unknown;
    if (!isRecord(parsed)) {
      return makeCheck('fail', 'devloop policy', 'policy file must be a YAML object');
    }
    if (parsed.mode !== 'subscription_only') {
      return makeCheck('fail', 'devloop policy', 'policy mode must be subscription_only');
    }
    return makeCheck('pass', 'devloop policy', 'policy mode is subscription_only', resolvedPolicyPath);
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
  repoPath: string,
): DevloopDoctorCheck {
  const resolved = runner.resolveCommand(command, env) ?? resolveSourceCheckoutCommand(command, repoPath);
  if (resolved === undefined) {
    return makeCheck('fail', `command:${command}`, `command not found: ${command}`);
  }
  return makeCheck('pass', `command:${command}`, `found ${command}`, resolved);
}

function resolveSourceCheckoutCommand(command: string, repoPath: string): string | undefined {
  if (command !== 'takt') {
    return undefined;
  }

  const candidate = join(repoPath, 'bin', 'takt');
  try {
    // Source-checkout users often run bin/devloopd.mjs before npm link. Accept the
    // adjacent wrapper so readiness checks verify this checkout instead of global PATH state.
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

function resolveCursorCommand(
  env: NodeJS.ProcessEnv,
  runner: DevloopDoctorCommandRunner,
): { command: string; path: string } | undefined {
  for (const command of CURSOR_COMMAND_CANDIDATES) {
    const resolved = runner.resolveCommand(command, env);
    if (resolved !== undefined) {
      return { command, path: resolved };
    }
  }
  return undefined;
}

function checkCursorCommand(env: NodeJS.ProcessEnv, runner: DevloopDoctorCommandRunner): DevloopDoctorCheck {
  const resolved = resolveCursorCommand(env, runner);
  if (resolved !== undefined) {
    return makeCheck('pass', 'command:cursor', `using cursor CLI: ${resolved.command}`, resolved.path);
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
    return makeCheck('pass', label, `config file not found; skipped: ${configPath}`);
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

function resolveTaktSubscriptionPolicy(repoPath: string): SubscriptionOnlyPolicyConfig {
  const config = resolveWorkflowConfigValues(repoPath, [
    'subscriptionOnly',
    'allowedProviders',
    'forbiddenProviders',
    'provider',
  ]);
  const policy = buildSubscriptionPolicy(config);
  assertSubscriptionOnlyProvider(config.provider, 'TAKT config provider', policy);
  return policy;
}

function isOpenCodeSdkProviderAllowed(repoPath: string): boolean {
  try {
    return getSubscriptionOnlyAllowedProviders(resolveTaktSubscriptionPolicy(repoPath)).has('opencode');
  } catch {
    return false;
  }
}

function checkResolvedTaktConfig(repoPath: string): DevloopDoctorCheck {
  try {
    const config = resolveWorkflowConfigValues(repoPath, ['subscriptionOnly']);
    if (config.subscriptionOnly !== true) {
      return makeCheck('fail', 'TAKT config', 'TAKT config must set subscription_only: true');
    }

    const policy = resolveTaktSubscriptionPolicy(repoPath);

    return makeCheck(
      'pass',
      'TAKT config',
      `subscription_only is true; allowed providers: ${(policy.allowedProviders ?? DEFAULT_SUBSCRIPTION_ONLY_ALLOWED_PROVIDERS).join(', ')}`,
    );
  } catch (error) {
    return makeCheck('fail', 'TAKT config', sanitizeDetail(getErrorMessage(error)));
  }
}

async function checkOpenCodeAuthStore(
  repoPath: string,
  env: NodeJS.ProcessEnv,
  runner: DevloopDoctorCommandRunner,
): Promise<DevloopDoctorCheck | undefined> {
  if (!isOpenCodeSdkProviderAllowed(repoPath)) {
    return undefined;
  }

  const commandPath = runner.resolveCommand('opencode', env);
  if (commandPath === undefined) {
    return makeCheck('fail', 'OpenCode auth store', 'cannot check OpenCode auth because opencode is missing');
  }

  const result = await runner.exec(commandPath, ['auth', 'list'], {
    cwd: repoPath,
    env: buildSubscriptionOnlyEnv(env),
    timeoutMs: OPENCODE_AUTH_LIST_TIMEOUT_MS,
  });
  if (result.exitCode === 0) {
    return makeCheck('pass', 'OpenCode auth store', 'opencode auth list succeeded');
  }

  return makeCheck(
    'fail',
    'OpenCode auth store',
    'opencode auth list failed',
    sanitizeDetail(result.stderr || result.stdout),
  );
}

function resolveOpenCodeDataDir(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME?.trim() === '' ? undefined : env.HOME;
  const resolvedHome = home ?? homedir();
  return resolvedHome === '' ? undefined : join(resolvedHome, '.local', 'share', 'opencode');
}

function listRecentOpenCodeLogPaths(logDir: string): string[] {
  const cutoff = Date.now() - OPENCODE_RECENT_LOG_MAX_AGE_MS;
  const entries: Array<{ filePath: string; mtimeMs: number }> = [];

  try {
    for (const entry of readdirSync(logDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) {
        continue;
      }

      const filePath = join(logDir, entry.name);
      try {
        const stat = statSync(filePath);
        if (stat.isFile() && stat.mtimeMs >= cutoff) {
          entries.push({ filePath, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // A rotating log can disappear between readdir and stat; another recent log is enough for doctor.
      }
    }
  } catch {
    return [];
  }

  return entries
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, OPENCODE_RECENT_LOG_LIMIT)
    .map((entry) => entry.filePath);
}

function readUtf8Tail(filePath: string, maxBytes: number): string {
  const stat = statSync(filePath);
  if (stat.size <= maxBytes) {
    return readFileSync(filePath, 'utf-8');
  }

  const fd = openSync(filePath, 'r');
  try {
    // Storage failures are appended near the end of OpenCode logs; reading the tail avoids loading large model traces.
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function containsOpenCodeSqliteStorageError(text: string): boolean {
  return /session_message\.seq/i.test(text)
    && /(SQLiteError|SQLITE_CONSTRAINT|constraint failed|NOT NULL)/i.test(text);
}

function checkOpenCodeRecentStorageErrors(repoPath: string, env: NodeJS.ProcessEnv): DevloopDoctorCheck | undefined {
  if (!isOpenCodeSdkProviderAllowed(repoPath)) {
    return undefined;
  }

  const dataDir = resolveOpenCodeDataDir(env);
  if (dataDir === undefined) {
    return undefined;
  }

  const logDir = join(dataDir, 'log');
  if (!existsSync(logDir)) {
    return undefined;
  }

  const logPaths = listRecentOpenCodeLogPaths(logDir);
  for (const logPath of logPaths) {
    try {
      if (containsOpenCodeSqliteStorageError(readUtf8Tail(logPath, OPENCODE_LOG_TAIL_BYTES))) {
        return makeCheck(
          'warn',
          'OpenCode storage',
          'recent OpenCode log contains a SQLite storage error',
          `OpenCode local database may need backup or repair before CLI/SDK smoke can pass: ${join(dataDir, 'opencode.db')}`,
        );
      }
    } catch {
      // Log readability is advisory; auth and direct smoke checks remain the source of pass/fail readiness.
    }
  }

  return makeCheck('pass', 'OpenCode storage', 'no recent OpenCode SQLite storage errors found', logDir);
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

function commandForSmokeProvider(
  provider: SubscriptionCliProviderType,
  env: NodeJS.ProcessEnv,
  runner: DevloopDoctorCommandRunner,
): { commandPath: string; commandName: string } | undefined {
  if (provider === 'codex-cli') {
    const commandPath = runner.resolveCommand('codex', env);
    return commandPath === undefined ? undefined : { commandPath, commandName: 'codex' };
  }
  if (provider === 'opencode-cli') {
    const commandPath = runner.resolveCommand('opencode', env);
    return commandPath === undefined ? undefined : { commandPath, commandName: 'opencode' };
  }
  if (provider === 'agy-cli') {
    const commandPath = runner.resolveCommand('agy', env);
    return commandPath === undefined ? undefined : { commandPath, commandName: 'agy' };
  }

  const cursor = resolveCursorCommand(env, runner);
  return cursor === undefined ? undefined : { commandPath: cursor.path, commandName: cursor.command };
}

async function checkSubscriptionCliSmokeProvider(
  provider: SubscriptionCliProviderType,
  repoPath: string,
  env: NodeJS.ProcessEnv,
  runner: DevloopDoctorCommandRunner,
  timeoutMs: number,
): Promise<DevloopDoctorCheck> {
  const command = commandForSmokeProvider(provider, env, runner);
  if (command === undefined) {
    return makeCheck('fail', `smoke:${provider}`, `cannot run ${provider} smoke because its CLI command is missing`);
  }

  const invocation = buildSubscriptionCliInvocation(provider, CLI_SMOKE_PROMPT, {
    cwd: repoPath,
    commandPath: command.commandPath,
    agyPrintTimeout: `${Math.max(1, Math.ceil(timeoutMs / 1_000))}s`,
  });
  const result = await runner.exec(invocation.command, invocation.args, {
    cwd: repoPath,
    env: buildSubscriptionOnlyEnv(env),
    stdin: invocation.stdin,
    // Smoke checks intentionally fail boundedly; hanging CLIs are a real readiness failure.
    timeoutMs: invocation.timeoutMs ?? timeoutMs,
  });

  if (result.exitCode === 0) {
    return makeCheck('pass', `smoke:${provider}`, `${provider} smoke run completed`, command.commandName);
  }

  return makeCheck(
    'fail',
    `smoke:${provider}`,
    `${provider} smoke run failed`,
    appendSubscriptionCliSmokeHint(provider, sanitizeDetail(result.stderr || result.stdout)),
  );
}

async function checkSubscriptionCliSmoke(
  repoPath: string,
  env: NodeJS.ProcessEnv,
  runner: DevloopDoctorCommandRunner,
  timeoutMs: number,
): Promise<DevloopDoctorCheck[]> {
  const checks: DevloopDoctorCheck[] = [];
  for (const provider of SUBSCRIPTION_CLI_SMOKE_PROVIDERS) {
    checks.push(await checkSubscriptionCliSmokeProvider(provider, repoPath, env, runner, timeoutMs));
  }
  return checks;
}

export async function runDevloopDoctor(options: RunDevloopDoctorOptions = {}): Promise<DevloopDoctorReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const checks: DevloopDoctorCheck[] = [
    checkSubscriptionOnlyFlag(options.subscriptionOnly === true),
    checkDevloopPolicy(repoPath, options.policyPath),
    checkForbiddenEnvironment(env),
    ...REQUIRED_SUBSCRIPTION_COMMANDS.map((command) => checkCommand(command, env, runner, repoPath)),
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
    const openCodeAuthCheck = await checkOpenCodeAuthStore(repoPath, env, runner);
    if (openCodeAuthCheck !== undefined) {
      checks.push(openCodeAuthCheck);
    }
    const openCodeStorageCheck = checkOpenCodeRecentStorageErrors(repoPath, env);
    if (openCodeStorageCheck !== undefined) {
      checks.push(openCodeStorageCheck);
    }
  }

  if (options.smokeCli === true) {
    if (checks.some((check) => check.status === 'fail')) {
      checks.push(makeCheck('warn', 'subscription CLI smoke', 'skipped because prerequisite doctor checks failed'));
    } else {
      checks.push(...await checkSubscriptionCliSmoke(
        repoPath,
        env,
        runner,
        options.smokeTimeoutMs ?? DEFAULT_CLI_SMOKE_TIMEOUT_MS,
      ));
    }
  }

  return {
    passed: checks.every((check) => check.status !== 'fail'),
    checks,
  };
}

export function formatDevloopDoctorReport(report: DevloopDoctorReport, options: { verbose?: boolean } = {}): string {
  const visibleChecks = options.verbose === true
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
