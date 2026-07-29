import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createDefaultDevloopCommandRunner,
  githubMetadataExecOptions,
  type DevloopCommandRunner,
} from './commandRunner.js';
import { inspectActiveRuns } from './activeRuns.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type PersonalReadinessStatus = 'pass' | 'warn' | 'fail';

export interface PersonalReadinessCheck {
  status: PersonalReadinessStatus;
  name: string;
  message: string;
  detail?: string;
}

export interface PersonalReadinessReport {
  passed: boolean;
  checks: PersonalReadinessCheck[];
}

export interface RunPersonalReadinessOptions {
  repoPath?: string;
  repo?: string;
  workflowPath?: string;
  skipAuth?: boolean;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
}

const REQUIRED_IGNORES = ['.devloop/', '.takt/runs/'] as const;
const REQUIRED_GITHUB_LABELS = ['agent:ready', 'agent:auto-merge', 'agent:blocked', 'human:review'] as const;
const DEFAULT_SUBSCRIPTION_WORKFLOW = '.takt/workflows/subscription-devloop.yaml';

function makeCheck(
  status: PersonalReadinessStatus,
  name: string,
  message: string,
  detail?: string,
): PersonalReadinessCheck {
  return detail === undefined ? { status, name, message } : { status, name, message, detail };
}

function sanitizeDetail(text: string): string {
  return sanitizeSensitiveText(text).replace(/\s+/g, ' ').trim();
}

function resolveRepoPath(repoPath: string | undefined): string {
  return resolve(repoPath ?? process.cwd());
}

function checkCommand(command: string, env: NodeJS.ProcessEnv, runner: DevloopCommandRunner): PersonalReadinessCheck {
  const resolved = runner.resolveCommand(command, env);
  if (resolved === undefined) {
    return makeCheck('fail', `command:${command}`, `command not found: ${command}`);
  }
  return makeCheck('pass', `command:${command}`, `found ${command}`, resolved);
}

async function checkGitRoot(
  repoPath: string,
  env: NodeJS.ProcessEnv,
  runner: DevloopCommandRunner,
): Promise<PersonalReadinessCheck> {
  const result = await runner.exec('git', ['rev-parse', '--show-toplevel'], { cwd: repoPath, env });
  if (result.exitCode === 0) {
    return makeCheck('pass', 'git repository', 'repository root detected', sanitizeDetail(result.stdout));
  }
  return makeCheck('fail', 'git repository', 'not a git repository', sanitizeDetail(result.stderr || result.stdout));
}

async function checkGitOrigin(
  repoPath: string,
  env: NodeJS.ProcessEnv,
  runner: DevloopCommandRunner,
): Promise<PersonalReadinessCheck> {
  const result = await runner.exec('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, env });
  if (result.exitCode === 0 && result.stdout.trim().length > 0) {
    return makeCheck('pass', 'git origin', 'origin remote configured', sanitizeDetail(result.stdout));
  }
  return makeCheck('fail', 'git origin', 'origin remote is required for PR automation', sanitizeDetail(result.stderr || result.stdout));
}

async function checkGitHubAuth(
  repoPath: string,
  env: NodeJS.ProcessEnv,
  runner: DevloopCommandRunner,
  skipAuth: boolean,
): Promise<PersonalReadinessCheck> {
  if (skipAuth) {
    return makeCheck('warn', 'gh auth', 'GitHub auth status check skipped');
  }
  const result = await runner.exec('gh', ['auth', 'status'], githubMetadataExecOptions({ cwd: repoPath, env }));
  if (result.exitCode === 0) {
    return makeCheck('pass', 'gh auth', 'GitHub CLI is authenticated');
  }
  return makeCheck('fail', 'gh auth', 'GitHub CLI is not authenticated', sanitizeDetail(result.stderr || result.stdout));
}

function normalizeIgnorePattern(pattern: string): string {
  return pattern.trim().replace(/^\/+/, '');
}

function checkLocalIgnores(repoPath: string): PersonalReadinessCheck {
  const gitignorePath = resolve(repoPath, '.gitignore');
  const taktGitignorePath = resolve(repoPath, '.takt', '.gitignore');
  if (!existsSync(gitignorePath) && !existsSync(taktGitignorePath)) {
    return makeCheck('warn', 'local ignores', 'no .gitignore found for local automation state');
  }

  const rootIgnored = existsSync(gitignorePath)
    ? new Set(
      readFileSync(gitignorePath, 'utf-8')
        .split('\n')
        .map(normalizeIgnorePattern)
        .filter((line) => line.length > 0 && !line.startsWith('#')),
    )
    : new Set<string>();
  const taktIgnored = existsSync(taktGitignorePath)
    ? new Set(
      readFileSync(taktGitignorePath, 'utf-8')
        .split('\n')
        .map(normalizeIgnorePattern)
        .filter((line) => line.length > 0 && !line.startsWith('#')),
    )
    : new Set<string>();

  const missing = REQUIRED_IGNORES.filter((pattern) => {
    if (rootIgnored.has(pattern)) {
      return false;
    }
    if (pattern === '.takt/runs/' && (taktIgnored.has('*') || taktIgnored.has('runs/') || taktIgnored.has('runs'))) {
      return false;
    }
    return true;
  });
  if (missing.length === 0) {
    return makeCheck('pass', 'local ignores', 'local automation state is ignored');
  }
  return makeCheck(
    'warn',
    'local ignores',
    'local automation state is not fully ignored',
    `missing patterns: ${missing.join(', ')}`,
  );
}

function checkActiveRuns(repoPath: string): PersonalReadinessCheck {
  const report = inspectActiveRuns({ repoPath });
  if (!report.passed) {
    return makeCheck('fail', 'active runs', report.message);
  }
  if (report.activeRuns.some((run) => run.stale)) {
    return makeCheck('warn', 'active runs', 'stale active TAKT runs detected');
  }
  if (report.activeRuns.length > 0) {
    return makeCheck('warn', 'active runs', report.message);
  }
  return makeCheck('pass', 'active runs', report.message);
}

function checkWorkflow(repoPath: string, workflowPath: string | undefined): PersonalReadinessCheck {
  const relativeWorkflowPath = workflowPath ?? DEFAULT_SUBSCRIPTION_WORKFLOW;
  const resolvedWorkflowPath = resolve(repoPath, relativeWorkflowPath);
  if (existsSync(resolvedWorkflowPath)) {
    return makeCheck('pass', 'workflow', 'default subscription devloop workflow exists', relativeWorkflowPath);
  }
  return makeCheck('fail', 'workflow', 'default subscription devloop workflow is missing', relativeWorkflowPath);
}

async function checkGitHubLabels(
  repoPath: string,
  repo: string | undefined,
  env: NodeJS.ProcessEnv,
  runner: DevloopCommandRunner,
): Promise<PersonalReadinessCheck> {
  if (repo === undefined || repo.trim().length === 0) {
    return makeCheck('warn', 'github labels', 'GitHub label check skipped because --repo was not provided');
  }
  const result = await runner.exec(
    'gh',
    ['label', 'list', '--repo', repo, '--json', 'name', '--limit', '200'],
    githubMetadataExecOptions({ cwd: repoPath, env }),
  );
  if (result.exitCode !== 0) {
    return makeCheck('fail', 'github labels', 'failed to list GitHub labels', sanitizeDetail(result.stderr || result.stdout));
  }

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const labels = Array.isArray(parsed)
      ? new Set(parsed
        .map((item) => typeof item === 'object' && item !== null ? (item as { name?: unknown }).name : undefined)
        .filter((name): name is string => typeof name === 'string'))
      : new Set<string>();
    const missing = REQUIRED_GITHUB_LABELS.filter((label) => !labels.has(label));
    if (missing.length === 0) {
      return makeCheck('pass', 'github labels', 'required automation labels exist');
    }
    return makeCheck('fail', 'github labels', 'required automation labels are missing', `missing labels: ${missing.join(', ')}`);
  } catch {
    return makeCheck('fail', 'github labels', 'failed to parse GitHub labels', sanitizeDetail(result.stdout));
  }
}

export async function runPersonalReadiness(
  options: RunPersonalReadinessOptions = {},
): Promise<PersonalReadinessReport> {
  const repoPath = resolveRepoPath(options.repoPath);
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const checks: PersonalReadinessCheck[] = [
    checkCommand('git', env, runner),
    checkCommand('gh', env, runner),
  ];

  if (checks.every((check) => check.status !== 'fail')) {
    checks.push(
      await checkGitRoot(repoPath, env, runner),
      await checkGitOrigin(repoPath, env, runner),
      await checkGitHubAuth(repoPath, env, runner, options.skipAuth === true),
      await checkGitHubLabels(repoPath, options.repo, env, runner),
    );
  }
  checks.push(checkWorkflow(repoPath, options.workflowPath), checkLocalIgnores(repoPath), checkActiveRuns(repoPath));

  return {
    passed: checks.every((check) => check.status !== 'fail'),
    checks,
  };
}

export function formatPersonalReadinessReport(report: PersonalReadinessReport): string {
  const lines = [
    report.passed ? 'devloopd ready passed' : 'devloopd ready failed',
  ];
  for (const check of report.checks) {
    lines.push(`- ${check.status.toUpperCase()} ${check.name}: ${check.message}`);
    if (check.detail !== undefined && check.detail.length > 0) {
      lines.push(`  ${check.detail}`);
    }
  }
  return lines.join('\n');
}
