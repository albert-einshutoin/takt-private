import { resolve } from 'node:path';
import { writeFileAtomic } from './stateStore.js';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandRunner,
} from './commandRunner.js';
import {
  formatProviderSmokeMatrixReport,
  runProviderSmokeMatrix,
  type ProviderSmokeMatrixReport,
} from './providerSmoke.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';
import { stripAnsi } from '../shared/utils/text.js';

export type PersonalCheckStatus = 'pass' | 'fail' | 'skip';

export interface PersonalCheckGate {
  name: string;
  required: boolean;
  status: PersonalCheckStatus;
  command?: string;
  message: string;
  durationMs: number;
  detail?: string;
}

export interface PersonalCheckReport {
  passed: boolean;
  repoPath: string;
  summaryPath: string;
  gates: PersonalCheckGate[];
  providerSmoke?: ProviderSmokeMatrixReport;
}

export interface RunPersonalCheckOptions {
  repoPath?: string;
  summaryPath?: string;
  skipBuild?: boolean;
  skipMockE2e?: boolean;
  providerSmoke?: boolean;
  requireProviderSmoke?: boolean;
  workflow?: string;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
}

interface CommandGateDefinition {
  name: string;
  command: string;
  args: readonly string[];
  required: boolean;
  skipped?: boolean;
  skipStatus?: PersonalCheckStatus;
  skipMessage?: string;
}

const COMMAND_OUTPUT_DETAIL_LIMIT = 4_000;

function defaultSummaryPath(repoPath: string): string {
  return resolve(repoPath, '.devloop', 'check-personal-summary.json');
}

function sanitizeDetail(value: string): string {
  return sanitizeSensitiveText(stripAnsi(value)).trim();
}

function truncateDetail(value: string): string | undefined {
  const sanitized = sanitizeDetail(value);
  if (sanitized.length === 0) {
    return undefined;
  }
  if (sanitized.length <= COMMAND_OUTPUT_DETAIL_LIMIT) {
    return sanitized;
  }
  return sanitized.slice(sanitized.length - COMMAND_OUTPUT_DETAIL_LIMIT);
}

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

function buildCommandGates(options: RunPersonalCheckOptions): CommandGateDefinition[] {
  return [
    {
      name: 'build',
      command: 'npm',
      args: ['run', 'build'],
      required: true,
      skipped: options.skipBuild === true,
      skipStatus: 'pass',
      skipMessage: 'build already completed by the npm script wrapper',
    },
    { name: 'lint', command: 'npm', args: ['run', 'lint'], required: true },
    { name: 'devloopd-soak', command: 'npm', args: ['run', 'test:devloopd:soak'], required: true },
    { name: 'unit', command: 'npm', args: ['test'], required: true },
    {
      name: 'mock-e2e',
      command: 'npm',
      args: ['run', 'test:e2e:mock'],
      required: true,
      skipped: options.skipMockE2e === true,
      skipMessage: 'mock E2E skipped by operator option',
    },
    { name: 'audit-high', command: 'npm', args: ['audit', '--audit-level=high'], required: true },
    { name: 'whitespace', command: 'git', args: ['diff', '--check'], required: true },
  ];
}

async function runCommandGate(options: {
  repoPath: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
  gate: CommandGateDefinition;
}): Promise<PersonalCheckGate> {
  const startedAt = Date.now();
  const command = commandLabel(options.gate.command, options.gate.args);
  if (options.gate.skipped === true) {
    return {
      name: options.gate.name,
      required: options.gate.required,
      status: options.gate.skipStatus ?? 'skip',
      command,
      message: options.gate.skipMessage ?? 'skipped',
      durationMs: Date.now() - startedAt,
    };
  }

  const result = await options.runner.exec(options.gate.command, options.gate.args, {
    cwd: options.repoPath,
    env: options.env,
  });
  const passed = result.exitCode === 0;
  return {
    name: options.gate.name,
    required: options.gate.required,
    status: passed ? 'pass' : 'fail',
    command,
    message: passed ? 'gate passed' : `gate failed with exit code ${result.exitCode}`,
    durationMs: Date.now() - startedAt,
    ...(!passed ? { detail: truncateDetail([result.stderr, result.stdout].filter(Boolean).join('\n')) } : {}),
  };
}

function providerGateFromReport(
  report: ProviderSmokeMatrixReport,
  required: boolean,
  durationMs: number,
): PersonalCheckGate {
  const hasConfigured = report.configuredProviders.length > 0;
  const status: PersonalCheckStatus = !hasConfigured
    ? 'skip'
    : report.passed ? 'pass' : 'fail';
  return {
    name: 'provider-smoke',
    required,
    status,
    command: 'devloopd provider-smoke',
    message: !hasConfigured
      ? 'no configured provider detected'
      : report.passed
        ? 'configured provider smoke matrix passed'
        : required
          ? 'configured provider smoke matrix failed'
          : 'configured provider smoke matrix failed but is optional',
    durationMs,
    ...(!report.passed ? { detail: truncateDetail(formatProviderSmokeMatrixReport(report)) } : {}),
  };
}

function summaryFor(report: PersonalCheckReport): string {
  return `${JSON.stringify({
    passed: report.passed,
    repoPath: report.repoPath,
    gates: report.gates.map((gate) => ({
      name: gate.name,
      required: gate.required,
      status: gate.status,
      command: gate.command,
      message: gate.message,
      durationMs: gate.durationMs,
      ...(gate.detail !== undefined ? { detail: gate.detail } : {}),
    })),
    providerSmoke: report.providerSmoke,
  }, null, 2)}\n`;
}

export async function runPersonalCheck(
  options: RunPersonalCheckOptions = {},
): Promise<PersonalCheckReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const summaryPath = resolve(options.summaryPath ?? defaultSummaryPath(repoPath));
  const gates: PersonalCheckGate[] = [];

  for (const gate of buildCommandGates(options)) {
    gates.push(await runCommandGate({ repoPath, env, runner, gate }));
  }

  let providerSmoke: ProviderSmokeMatrixReport | undefined;
  if (options.providerSmoke !== false) {
    const startedAt = Date.now();
    providerSmoke = await runProviderSmokeMatrix({
      repoPath,
      workflow: options.workflow,
      env,
      runner,
    });
    gates.push(providerGateFromReport(
      providerSmoke,
      options.requireProviderSmoke === true,
      Date.now() - startedAt,
    ));
  } else {
    gates.push({
      name: 'provider-smoke',
      required: options.requireProviderSmoke === true,
      status: 'skip',
      command: 'devloopd provider-smoke',
      message: 'provider smoke skipped by operator option',
      durationMs: 0,
    });
  }

  const passed = gates.every((gate) => !gate.required || gate.status === 'pass');
  const report: PersonalCheckReport = {
    passed,
    repoPath,
    summaryPath,
    gates,
    ...(providerSmoke !== undefined ? { providerSmoke } : {}),
  };
  writeFileAtomic(summaryPath, summaryFor(report));
  return report;
}

export function formatPersonalCheckReport(report: PersonalCheckReport): string {
  const lines = [
    report.passed ? 'devloopd check-personal passed' : 'devloopd check-personal failed',
    `Repository: ${report.repoPath}`,
    `Summary: ${report.summaryPath}`,
  ];
  for (const gate of report.gates) {
    const required = gate.required ? 'required' : 'optional';
    const command = gate.command === undefined ? '' : ` - ${gate.command}`;
    lines.push(`[${gate.status}] ${gate.name} (${required})${command}: ${gate.message}`);
    if (gate.detail !== undefined) {
      lines.push(`  ${gate.detail}`);
    }
  }
  return lines.join('\n');
}
