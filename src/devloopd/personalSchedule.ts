import { basename, isAbsolute, join, resolve } from 'node:path';
import type { StagedDevloopSafetyProfile } from './stagedScheduler.js';

export type PersonalScheduleKind = 'launchd' | 'cron';
export type PersonalScheduleSelection = PersonalScheduleKind | 'all';

export interface RunPersonalScheduleOptions {
  repoPath?: string;
  repo?: string;
  workflow?: string;
  logDir?: string;
  label?: string;
  intervalSeconds?: number;
  cronSchedule?: string;
  safetyProfile?: StagedDevloopSafetyProfile;
  maxCycles?: number;
  ghTimeoutMs?: number;
  pathEnv?: string;
  shellPath?: string;
  devloopdCommand?: string;
  npmCommand?: string;
  kind?: PersonalScheduleSelection;
}

export interface PersonalScheduleTemplate {
  kind: PersonalScheduleKind;
  content: string;
  pathHint: string;
  logPaths: string[];
  installCommands: string[];
  uninstallCommands: string[];
  statusCommands: string[];
  dryRunCommand: string;
}

export interface PersonalScheduleReport {
  repoPath: string;
  repo?: string;
  label: string;
  workflow: string;
  command: string;
  safetyProfile: StagedDevloopSafetyProfile;
  maxCycles: number;
  intervalSeconds: number;
  cronSchedule: string;
  ghTimeoutMs: number;
  pathEnv: string;
  templates: PersonalScheduleTemplate[];
}

const DEFAULT_WORKFLOW = '.takt/workflows/subscription-devloop.yaml';
const DEFAULT_INTERVAL_SECONDS = 60 * 60;
const DEFAULT_CRON_SCHEDULE = '17 * * * *';
const DEFAULT_GH_TIMEOUT_MS = 60_000;
const DEFAULT_PATH_ENV = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const DEFAULT_SHELL = '/bin/zsh';
const DEFAULT_DEVLOOPD_COMMAND = 'devloopd';
const DEFAULT_NPM_COMMAND = 'npm';

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function labelSegment(value: string): string {
  const normalized = value
    .replace(/[/\s]+/g, '-')
    .replace(/[^A-Za-z0-9_.-]+/g, '')
    .replace(/^-+|-+$/g, '');
  return normalized.length === 0 ? 'repo' : normalized.slice(0, 80);
}

function defaultLabel(repoPath: string, repo: string | undefined): string {
  const source = repo ?? basename(repoPath);
  return `com.takt.devloopd.${labelSegment(source)}`;
}

function resolveLabel(repoPath: string, repo: string | undefined, explicitLabel: string | undefined): string {
  const label = explicitLabel ?? defaultLabel(repoPath, repo);
  if (!/^[A-Za-z0-9_.-]+$/.test(label)) {
    throw new Error('label must contain only letters, numbers, dot, underscore, or hyphen');
  }
  return label;
}

function resolveProjectPath(repoPath: string, value: string | undefined, fallback: string): string {
  const candidate = value ?? fallback;
  return isAbsolute(candidate) ? resolve(candidate) : resolve(repoPath, candidate);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, '\'\\\'\'')}'`;
}

function shellCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildAutomationCommand(options: {
  repoPath: string;
  repo?: string;
  workflow: string;
  logDir: string;
  safetyProfile: StagedDevloopSafetyProfile;
  maxCycles: number;
  devloopdCommand: string;
  npmCommand: string;
}): string {
  const recover = shellCommand(options.devloopdCommand, [
    'recover-stale',
    '--cwd',
    options.repoPath,
    '--apply',
  ]);
  const stagedArgs = [
    'staged',
    'loop',
    '--cwd',
    options.repoPath,
    '--workflow',
    options.workflow,
    '--safety-profile',
    options.safetyProfile,
    '--max-cycles',
    String(options.maxCycles),
  ];
  if (options.repo !== undefined && options.repo.trim().length > 0) {
    stagedArgs.push('--repo', options.repo);
  }

  return [
    `cd ${shellQuote(options.repoPath)}`,
    `mkdir -p ${shellQuote(options.logDir)}`,
    shellCommand(options.npmCommand, ['run', 'check:personal']),
    recover,
    shellCommand(options.devloopdCommand, stagedArgs),
  ].join(' && ');
}

function envPrefix(options: {
  pathEnv: string;
  ghTimeoutMs: number;
  safetyProfile: StagedDevloopSafetyProfile;
}): string {
  return [
    `PATH=${shellQuote(options.pathEnv)}`,
    `TAKT_LOOP_GH_TIMEOUT_MS=${shellQuote(String(options.ghTimeoutMs))}`,
    `TAKT_LOOP_SAFETY_PROFILE=${shellQuote(options.safetyProfile)}`,
  ].join(' ');
}

function templateRenderCommand(kind: PersonalScheduleKind, options: {
  repoPath: string;
  repo?: string;
  workflow: string;
  logDir: string;
  label: string;
  intervalSeconds: number;
  cronSchedule: string;
  safetyProfile: StagedDevloopSafetyProfile;
  maxCycles: number;
  ghTimeoutMs: number;
  pathEnv: string;
  shellPath: string;
  devloopdCommand: string;
  npmCommand: string;
}, outputPath: string): string {
  const args = [
    'schedule-template',
    '--kind',
    kind,
    '--cwd',
    options.repoPath,
    '--workflow',
    options.workflow,
    '--log-dir',
    options.logDir,
    '--label',
    options.label,
    '--safety-profile',
    options.safetyProfile,
    '--max-cycles',
    String(options.maxCycles),
    '--gh-timeout-ms',
    String(options.ghTimeoutMs),
    '--path-env',
    options.pathEnv,
    '--shell',
    options.shellPath,
    '--devloopd-command',
    options.devloopdCommand,
    '--npm-command',
    options.npmCommand,
    '--template-only',
  ];
  if (options.repo !== undefined && options.repo.trim().length > 0) {
    args.push('--repo', options.repo);
  }
  if (kind === 'launchd') {
    args.push('--interval-seconds', String(options.intervalSeconds));
  } else {
    args.push('--cron-schedule', options.cronSchedule);
  }
  return `${shellCommand('devloopd', args)} > ${shellQuote(outputPath)}`;
}

function renderLaunchdTemplate(options: {
  repoPath: string;
  repo?: string;
  workflow: string;
  command: string;
  label: string;
  intervalSeconds: number;
  cronSchedule: string;
  ghTimeoutMs: number;
  safetyProfile: StagedDevloopSafetyProfile;
  maxCycles: number;
  pathEnv: string;
  shellPath: string;
  devloopdCommand: string;
  npmCommand: string;
  logDir: string;
}): PersonalScheduleTemplate {
  const scheduleDir = join(options.repoPath, '.devloop', 'schedules');
  const plistPath = join(scheduleDir, `${options.label}.plist`);
  const stdoutPath = join(options.logDir, 'personal-automation.launchd.out.log');
  const stderrPath = join(options.logDir, 'personal-automation.launchd.err.log');
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(options.label)}</string>`,
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(options.repoPath)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(options.shellPath)}</string>`,
    '    <string>-lc</string>',
    `    <string>${xmlEscape(options.command)}</string>`,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${xmlEscape(options.pathEnv)}</string>`,
    '    <key>TAKT_LOOP_GH_TIMEOUT_MS</key>',
    `    <string>${options.ghTimeoutMs}</string>`,
    '    <key>TAKT_LOOP_SAFETY_PROFILE</key>',
    `    <string>${xmlEscape(options.safetyProfile)}</string>`,
    '  </dict>',
    '  <key>StartInterval</key>',
    `  <integer>${options.intervalSeconds}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  return {
    kind: 'launchd',
    content,
    pathHint: plistPath,
    logPaths: [stdoutPath, stderrPath],
    installCommands: [
      `mkdir -p ${shellQuote(scheduleDir)} ${shellQuote(options.logDir)}`,
      templateRenderCommand('launchd', options, plistPath),
      `launchctl bootstrap gui/$(id -u) ${shellQuote(plistPath)}`,
    ],
    uninstallCommands: [
      `launchctl bootout gui/$(id -u) ${shellQuote(plistPath)}`,
      `rm -f ${shellQuote(plistPath)}`,
    ],
    statusCommands: [
      `launchctl print gui/$(id -u)/${options.label}`,
      `tail -n 80 ${shellQuote(stdoutPath)} ${shellQuote(stderrPath)}`,
    ],
    dryRunCommand: `${envPrefix(options)} ${shellCommand(options.shellPath, ['-lc', options.command])}`,
  };
}

function renderCronTemplate(options: {
  repoPath: string;
  repo?: string;
  workflow: string;
  command: string;
  label: string;
  intervalSeconds: number;
  cronSchedule: string;
  ghTimeoutMs: number;
  safetyProfile: StagedDevloopSafetyProfile;
  maxCycles: number;
  pathEnv: string;
  shellPath: string;
  devloopdCommand: string;
  npmCommand: string;
  logDir: string;
}): PersonalScheduleTemplate {
  const scheduleDir = join(options.repoPath, '.devloop', 'schedules');
  const cronPath = join(scheduleDir, `${options.label}.cron`);
  const logPath = join(options.logDir, 'personal-automation.cron.log');
  const marker = `# takt devloopd personal automation: ${options.label}`;
  const command = `${envPrefix(options)} ${shellCommand(options.shellPath, ['-lc', options.command])} >> ${shellQuote(logPath)} 2>&1`;
  const content = [
    marker,
    `${options.cronSchedule} ${command}`,
    '',
  ].join('\n');

  return {
    kind: 'cron',
    content,
    pathHint: cronPath,
    logPaths: [logPath],
    installCommands: [
      `mkdir -p ${shellQuote(scheduleDir)} ${shellQuote(options.logDir)}`,
      templateRenderCommand('cron', options, cronPath),
      `(crontab -l 2>/dev/null | grep -v ${shellQuote(options.label)}; cat ${shellQuote(cronPath)}) | crontab -`,
    ],
    uninstallCommands: [
      `(crontab -l 2>/dev/null | grep -v ${shellQuote(options.label)}) | crontab -`,
      `rm -f ${shellQuote(cronPath)}`,
    ],
    statusCommands: [
      `crontab -l | grep ${shellQuote(options.label)}`,
      `tail -n 80 ${shellQuote(logPath)}`,
    ],
    dryRunCommand: `${envPrefix(options)} ${shellCommand(options.shellPath, ['-lc', options.command])}`,
  };
}

export function runPersonalScheduleTemplates(
  options: RunPersonalScheduleOptions = {},
): PersonalScheduleReport {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const workflow = options.workflow ?? DEFAULT_WORKFLOW;
  const logDir = resolveProjectPath(repoPath, options.logDir, join('.devloop', 'logs'));
  const label = resolveLabel(repoPath, options.repo, options.label);
  const safetyProfile = options.safetyProfile ?? 'safe-default';
  const intervalSeconds = positiveInteger(options.intervalSeconds, DEFAULT_INTERVAL_SECONDS, 'intervalSeconds');
  const maxCycles = positiveInteger(options.maxCycles, 1, 'maxCycles');
  const ghTimeoutMs = positiveInteger(options.ghTimeoutMs, DEFAULT_GH_TIMEOUT_MS, 'ghTimeoutMs');
  const pathEnv = options.pathEnv ?? DEFAULT_PATH_ENV;
  const shellPath = options.shellPath ?? DEFAULT_SHELL;
  const devloopdCommand = options.devloopdCommand ?? DEFAULT_DEVLOOPD_COMMAND;
  const npmCommand = options.npmCommand ?? DEFAULT_NPM_COMMAND;
  const command = buildAutomationCommand({
    repoPath,
    repo: options.repo,
    workflow,
    logDir,
    safetyProfile,
    maxCycles,
    devloopdCommand,
    npmCommand,
  });
  const kinds: PersonalScheduleKind[] = options.kind === 'launchd'
    ? ['launchd']
    : options.kind === 'cron'
      ? ['cron']
      : ['launchd', 'cron'];
  const common = {
    repoPath,
    repo: options.repo,
    workflow,
    command,
    label,
    intervalSeconds,
    cronSchedule: options.cronSchedule ?? DEFAULT_CRON_SCHEDULE,
    ghTimeoutMs,
    safetyProfile,
    maxCycles,
    pathEnv,
    shellPath,
    devloopdCommand,
    npmCommand,
    logDir,
  };
  const templates = kinds.map((kind) => kind === 'launchd'
    ? renderLaunchdTemplate(common)
    : renderCronTemplate(common));

  return {
    repoPath,
    ...(options.repo ? { repo: options.repo } : {}),
    label,
    workflow,
    command,
    safetyProfile,
    maxCycles,
    intervalSeconds,
    cronSchedule: options.cronSchedule ?? DEFAULT_CRON_SCHEDULE,
    ghTimeoutMs,
    pathEnv,
    templates,
  };
}

function renderCommandBlock(title: string, commands: readonly string[]): string[] {
  return [
    title,
    '```bash',
    ...commands,
    '```',
  ];
}

export function formatPersonalScheduleReport(report: PersonalScheduleReport): string {
  const lines = [
    'devloopd schedule-template rendered',
    `Repository: ${report.repoPath}`,
    ...(report.repo !== undefined ? [`GitHub repo: ${report.repo}`] : []),
    `Label: ${report.label}`,
    `Safety profile: ${report.safetyProfile}`,
    `Max cycles per scheduled run: ${report.maxCycles}`,
    `GitHub metadata timeout: ${report.ghTimeoutMs}ms`,
    '',
    'Dry-run command:',
    '```bash',
    report.templates[0]?.dryRunCommand ?? '',
    '```',
  ];

  for (const template of report.templates) {
    lines.push(
      '',
      `## ${template.kind}`,
      `Template path: ${template.pathHint}`,
      `Log paths: ${template.logPaths.join(', ')}`,
      '',
      ...renderCommandBlock('Install:', template.installCommands),
      '',
      ...renderCommandBlock('Status:', template.statusCommands),
      '',
      ...renderCommandBlock('Uninstall:', template.uninstallCommands),
      '',
      'Template:',
      template.kind === 'launchd' ? '```xml' : '```cron',
      template.content.trimEnd(),
      '```',
    );
  }

  return lines.join('\n');
}
