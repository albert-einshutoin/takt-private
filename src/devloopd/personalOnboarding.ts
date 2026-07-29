import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  createDefaultDevloopCommandRunner,
  githubMetadataExecOptions,
  type DevloopCommandRunner,
} from './commandRunner.js';
import { writeFileAtomic } from './stateStore.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type PersonalOnboardingActionStatus = 'pass' | 'warn' | 'fail' | 'exists' | 'would_change' | 'changed';

export interface PersonalOnboardingAction {
  status: PersonalOnboardingActionStatus;
  name: string;
  message: string;
  path?: string;
  detail?: string;
}

export interface PersonalOnboardingReport {
  passed: boolean;
  changed: boolean;
  apply: boolean;
  repoPath: string;
  actions: PersonalOnboardingAction[];
}

export interface RunPersonalOnboardingOptions {
  repoPath?: string;
  repo?: string;
  apply?: boolean;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopCommandRunner;
}

interface LabelTemplate {
  name: string;
  color: string;
  description: string;
}

const ROOT_GITIGNORE_PATTERNS = [
  '.devloop/',
  '.env',
  '.env.local',
  '.env.*.local',
  'task_planning/',
] as const;

const TAKT_GITIGNORE_TEMPLATE = `# Ignore local TAKT runtime state by default
*

# Version-controlled personal automation config
!.gitignore
!config.yaml
!devloopd.yaml
!workflows/
!workflows/**
!quality-gates/
!quality-gates/**
!automation/
!automation/**
`;

const TAKT_CONFIG_TEMPLATE = `subscription_only: true
provider: codex-cli
allowed_providers:
  - codex-cli
  - cursor-cli
  - opencode-cli
  - agy-cli
  - mock
forbidden_providers:
  - codex
  - claude-sdk
`;

const DEVLOOP_POLICY_TEMPLATE = 'mode: subscription_only\n';

const SUBSCRIPTION_WORKFLOW_TEMPLATE = `name: subscription-devloop
description: Personal subscription-only devloop wrapper around the TAKT default workflow.
max_steps: 50
initial_step: takt_default
steps:
  - name: takt_default
    kind: workflow_call
    call: takt-default
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`;

const LABEL_TEMPLATES: readonly LabelTemplate[] = [
  {
    name: 'agent:ready',
    color: '0e8a16',
    description: 'Issue is safe for mechanical devloop consideration',
  },
  {
    name: 'agent:auto-merge',
    color: '5319e7',
    description: 'PR passed dual LLM review and is eligible for mechanical merge gates',
  },
  {
    name: 'agent:blocked',
    color: 'd93f0b',
    description: 'Automation is blocked and needs operator attention',
  },
  {
    name: 'human:review',
    color: 'fbca04',
    description: 'Human product or policy decision is required before automation resumes',
  },
];

function makeAction(
  status: PersonalOnboardingActionStatus,
  name: string,
  message: string,
  options: { path?: string; detail?: string } = {},
): PersonalOnboardingAction {
  return {
    status,
    name,
    message,
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
  };
}

function resolveRepoPath(repoPath: string | undefined): string {
  return resolve(repoPath ?? process.cwd());
}

function sanitizeDetail(text: string): string {
  return sanitizeSensitiveText(text).replace(/\s+/g, ' ').trim();
}

async function checkGitRepository(options: {
  repoPath: string;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
  force: boolean;
}): Promise<PersonalOnboardingAction> {
  if (options.runner.resolveCommand('git', options.env) === undefined) {
    return makeAction('fail', 'git repository', 'command not found: git');
  }

  const result = await options.runner.exec('git', ['rev-parse', '--show-toplevel'], {
    cwd: options.repoPath,
    env: options.env,
  });
  if (result.exitCode === 0) {
    return makeAction('pass', 'git repository', 'repository root detected', {
      detail: sanitizeDetail(result.stdout),
    });
  }
  if (options.force) {
    return makeAction('warn', 'git repository', 'git repository check failed but --force was provided', {
      detail: sanitizeDetail(result.stderr || result.stdout),
    });
  }
  return makeAction('fail', 'git repository', 'not a git repository; rerun with --force only for a deliberate local setup', {
    detail: sanitizeDetail(result.stderr || result.stdout),
  });
}

function normalizeLine(line: string): string {
  return line.trim().replace(/^\/+/, '');
}

function ensureRootGitignore(repoPath: string, apply: boolean): PersonalOnboardingAction {
  const filePath = join(repoPath, '.gitignore');
  const existingContent = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const existing = new Set(
    existingContent
      .split('\n')
      .map(normalizeLine)
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
  const missing = ROOT_GITIGNORE_PATTERNS.filter((pattern) => !existing.has(pattern));
  if (missing.length === 0) {
    return makeAction('exists', 'root gitignore', 'required local state patterns already ignored', { path: filePath });
  }
  if (!apply) {
    return makeAction('would_change', 'root gitignore', 'would append local automation ignore patterns', {
      path: filePath,
      detail: missing.join(', '),
    });
  }

  const prefix = existingContent.length > 0 && !existingContent.endsWith('\n') ? '\n' : '';
  const addition = [
    prefix,
    existingContent.length > 0 ? '\n# TAKT personal automation runtime state\n' : '# TAKT personal automation runtime state\n',
    ...missing.map((pattern) => `${pattern}\n`),
  ].join('');
  writeFileAtomic(filePath, `${existingContent}${addition}`, { mode: 0o644 });
  return makeAction('changed', 'root gitignore', 'appended local automation ignore patterns', {
    path: filePath,
    detail: missing.join(', '),
  });
}

function ensureTemplateFile(options: {
  repoPath: string;
  relativePath: string;
  name: string;
  content: string;
  apply: boolean;
  force: boolean;
}): PersonalOnboardingAction {
  const filePath = join(options.repoPath, options.relativePath);
  if (existsSync(filePath) && !options.force) {
    return makeAction('exists', options.name, 'existing file preserved', { path: filePath });
  }
  if (!options.apply) {
    return makeAction(existsSync(filePath) ? 'warn' : 'would_change', options.name, existsSync(filePath)
      ? 'would preserve existing file without --force'
      : 'would create template file', { path: filePath });
  }

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileAtomic(filePath, options.content, { mode: 0o644 });
  return makeAction('changed', options.name, existsSync(filePath) && options.force
    ? 'wrote template file with --force'
    : 'created template file', { path: filePath });
}

function parseLabelList(output: string): Set<string> | undefined {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return new Set(parsed
      .map((item) => typeof item === 'object' && item !== null ? (item as { name?: unknown }).name : undefined)
      .filter((name): name is string => typeof name === 'string'));
  } catch {
    return undefined;
  }
}

async function ensureGithubLabels(options: {
  repoPath: string;
  repo?: string;
  apply: boolean;
  env: NodeJS.ProcessEnv;
  runner: DevloopCommandRunner;
}): Promise<PersonalOnboardingAction[]> {
  if (options.repo === undefined || options.repo.trim().length === 0) {
    return [makeAction('warn', 'github labels', 'label verification skipped because --repo was not provided')];
  }
  if (options.runner.resolveCommand('gh', options.env) === undefined) {
    return [makeAction('fail', 'github labels', 'command not found: gh')];
  }

  const listResult = await options.runner.exec(
    'gh',
    ['label', 'list', '--repo', options.repo, '--json', 'name', '--limit', '200'],
    githubMetadataExecOptions({ cwd: options.repoPath, env: options.env }),
  );
  if (listResult.exitCode !== 0) {
    return [makeAction('fail', 'github labels', 'failed to list GitHub labels', {
      detail: sanitizeDetail(listResult.stderr || listResult.stdout),
    })];
  }

  const existingLabels = parseLabelList(listResult.stdout);
  if (existingLabels === undefined) {
    return [makeAction('fail', 'github labels', 'failed to parse GitHub labels', {
      detail: sanitizeDetail(listResult.stdout),
    })];
  }

  const actions: PersonalOnboardingAction[] = [];
  for (const label of LABEL_TEMPLATES) {
    if (existingLabels.has(label.name)) {
      actions.push(makeAction('exists', `github label ${label.name}`, 'label already exists'));
      continue;
    }
    if (!options.apply) {
      actions.push(makeAction('would_change', `github label ${label.name}`, 'would create GitHub label'));
      continue;
    }
    const result = await options.runner.exec(
      'gh',
      [
        'label',
        'create',
        label.name,
        '--repo',
        options.repo,
        '--color',
        label.color,
        '--description',
        label.description,
      ],
      githubMetadataExecOptions({ cwd: options.repoPath, env: options.env }),
    );
    if (result.exitCode === 0) {
      actions.push(makeAction('changed', `github label ${label.name}`, 'created GitHub label'));
    } else {
      actions.push(makeAction('fail', `github label ${label.name}`, 'failed to create GitHub label', {
        detail: sanitizeDetail(result.stderr || result.stdout),
      }));
    }
  }
  return actions;
}

export async function runPersonalOnboarding(
  options: RunPersonalOnboardingOptions = {},
): Promise<PersonalOnboardingReport> {
  const repoPath = resolveRepoPath(options.repoPath);
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const apply = options.apply === true;
  const force = options.force === true;
  const actions: PersonalOnboardingAction[] = [];

  const gitAction = await checkGitRepository({ repoPath, env, runner, force });
  actions.push(gitAction);
  if (gitAction.status !== 'fail') {
    actions.push(
      ensureRootGitignore(repoPath, apply),
      ensureTemplateFile({
        repoPath,
        relativePath: join('.takt', '.gitignore'),
        name: 'takt gitignore',
        content: TAKT_GITIGNORE_TEMPLATE,
        apply,
        force,
      }),
      ensureTemplateFile({
        repoPath,
        relativePath: join('.takt', 'config.yaml'),
        name: 'takt config',
        content: TAKT_CONFIG_TEMPLATE,
        apply,
        force,
      }),
      ensureTemplateFile({
        repoPath,
        relativePath: join('.takt', 'devloopd.yaml'),
        name: 'devloop policy',
        content: DEVLOOP_POLICY_TEMPLATE,
        apply,
        force,
      }),
      ensureTemplateFile({
        repoPath,
        relativePath: join('.takt', 'workflows', 'subscription-devloop.yaml'),
        name: 'subscription workflow',
        content: SUBSCRIPTION_WORKFLOW_TEMPLATE,
        apply,
        force,
      }),
      ...await ensureGithubLabels({
        repoPath,
        repo: options.repo,
        apply,
        env,
        runner,
      }),
    );
  }

  return {
    passed: actions.every((action) => action.status !== 'fail'),
    changed: actions.some((action) => action.status === 'changed'),
    apply,
    repoPath,
    actions,
  };
}

export function formatPersonalOnboardingReport(report: PersonalOnboardingReport): string {
  const lines = [
    report.passed ? 'devloopd onboard-repo passed' : 'devloopd onboard-repo failed',
    `Mode: ${report.apply ? 'apply' : 'dry-run'}`,
    `Repository: ${report.repoPath}`,
  ];
  for (const action of report.actions) {
    lines.push(`- ${action.status.toUpperCase()} ${action.name}: ${action.message}`);
    if (action.path !== undefined) {
      lines.push(`  ${action.path}`);
    }
    if (action.detail !== undefined && action.detail.length > 0) {
      lines.push(`  ${action.detail}`);
    }
  }
  return lines.join('\n');
}
