import { resolve } from 'node:path';
import {
  formatDevloopDoctorReport,
  runDevloopDoctor,
  type DevloopDoctorReport,
} from './doctor.js';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandResult,
  type DevloopCommandRunner,
} from './commandRunner.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type DevloopRunCommandRunner = DevloopCommandRunner;

export interface RunDevloopIssueOptions {
  repoPath?: string;
  issue: number | string;
  repo?: string;
  workflow?: string;
  policyPath?: string;
  skipAuth?: boolean;
  autoPr?: boolean;
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopRunCommandRunner;
}

export interface DevloopRunCommand {
  command: string;
  displayCommand: string;
  args: readonly string[];
  cwd: string;
}

export interface DevloopRunReport {
  passed: boolean;
  doctor?: DevloopDoctorReport;
  command?: DevloopRunCommand;
  result?: DevloopCommandResult;
  message: string;
  detail?: string;
}

const DEFAULT_SUBSCRIPTION_WORKFLOW = '.takt/workflows/subscription-devloop.yaml';

function sanitizeDetail(text: string): string {
  return sanitizeSensitiveText(text).trim();
}

function normalizeIssue(issue: number | string): string | undefined {
  const normalized = String(issue).trim();
  return /^\d+$/.test(normalized) ? normalized : undefined;
}

function buildTaktIssueArgs(options: {
  issue: string;
  workflow: string;
  repo?: string;
  autoPr: boolean;
  quiet: boolean;
}): string[] {
  const args = [
    '--pipeline',
    '--issue',
    options.issue,
    '--workflow',
    options.workflow,
  ];

  if (options.autoPr) {
    args.push('--auto-pr');
  }
  if (options.quiet) {
    args.push('--quiet');
  }
  if (options.repo) {
    args.push('--repo', options.repo);
  }

  return args;
}

function quoteArgForDisplay(arg: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(arg)) {
    return arg;
  }
  return JSON.stringify(arg);
}

function formatCommandForDisplay(command: DevloopRunCommand): string {
  return [command.displayCommand, ...command.args].map(quoteArgForDisplay).join(' ');
}

export async function runDevloopIssue(options: RunDevloopIssueOptions): Promise<DevloopRunReport> {
  const issue = normalizeIssue(options.issue);
  if (issue === undefined) {
    return {
      passed: false,
      message: `issue must be a numeric GitHub issue number: ${String(options.issue)}`,
    };
  }

  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const doctor = await runDevloopDoctor({
    repoPath,
    policyPath: options.policyPath,
    subscriptionOnly: true,
    skipAuth: options.skipAuth,
    env,
    runner,
  });

  if (!doctor.passed) {
    return {
      passed: false,
      doctor,
      message: 'subscription-only doctor failed; TAKT pipeline was not started',
    };
  }

  const taktCommand = runner.resolveCommand('takt', env);
  if (taktCommand === undefined) {
    return {
      passed: false,
      doctor,
      message: 'command not found: takt',
    };
  }

  const args = buildTaktIssueArgs({
    issue,
    workflow: options.workflow ?? DEFAULT_SUBSCRIPTION_WORKFLOW,
    repo: options.repo,
    autoPr: options.autoPr !== false,
    quiet: options.quiet !== false,
  });
  const command: DevloopRunCommand = {
    command: taktCommand,
    displayCommand: 'takt',
    args,
    cwd: repoPath,
  };
  const result = await runner.exec(taktCommand, args, { cwd: repoPath, env });

  if (result.exitCode !== 0) {
    return {
      passed: false,
      doctor,
      command,
      result,
      message: `TAKT pipeline exited with code ${result.exitCode}`,
      detail: sanitizeDetail(result.stderr || result.stdout),
    };
  }

  return {
    passed: true,
    doctor,
    command,
    result,
    message: 'TAKT issue pipeline completed',
  };
}

export function formatDevloopRunReport(report: DevloopRunReport, options: { verbose?: boolean } = {}): string {
  const lines = [
    report.passed ? 'devloopd run passed' : 'devloopd run failed',
    report.message,
  ];

  if (report.command) {
    lines.push(`TAKT command: ${formatCommandForDisplay(report.command)}`);
  }
  if (report.detail && report.detail.length > 0) {
    lines.push(`Detail: ${sanitizeDetail(report.detail)}`);
  }
  if (report.doctor && (!report.doctor.passed || options.verbose === true)) {
    lines.push('', formatDevloopDoctorReport(report.doctor, { verbose: options.verbose }));
  }

  return lines.join('\n');
}
