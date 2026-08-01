import { resolve } from 'node:path';
import { parseProjectTemplateGithubSourceSpec } from '../features/project-template/github-source-spec.js';
import type {
  PersonalOnboardingReport,
  RunPersonalOnboardingOptions,
} from './personalOnboarding.js';

const SHA256 = /^[a-f0-9]{64}$/u;

export type PersonalOnboardingTemplateSource =
  | { readonly kind: 'local'; readonly value: string }
  | { readonly kind: 'github'; readonly value: string };

export type PersonalOnboardingTemplateMutation =
  | { readonly mode: 'dry-run'; readonly force: false }
  | {
    readonly mode: 'apply';
    readonly force: boolean;
    readonly expectedPlanId: string;
  };

export interface PersonalOnboardingTemplateCommandFacade {
  run(options: {
    readonly repoPath: string;
    readonly repo?: string;
    readonly source: PersonalOnboardingTemplateSource;
    readonly mutation: PersonalOnboardingTemplateMutation;
  }): Promise<{
    readonly passed: boolean;
    readonly machineOutput: string;
    readonly humanOutput: string;
  }>;
}

export interface PersonalOnboardingCommandOptions {
  readonly cwd: string;
  readonly repo?: string;
  readonly apply?: boolean;
  readonly force?: boolean;
  readonly template?: string;
  readonly expectedPlanId?: string;
  readonly json?: boolean;
}

export interface PersonalOnboardingCommandDependencies {
  readonly runLegacy: (
    options: RunPersonalOnboardingOptions,
  ) => Promise<PersonalOnboardingReport>;
  readonly formatLegacy: (report: PersonalOnboardingReport) => string;
  readonly createTemplateFacade: () => PersonalOnboardingTemplateCommandFacade;
}

export interface PersonalOnboardingCommandResult {
  readonly stdout: string;
  readonly exitCode: number;
}

type ArgumentErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FORCE_REQUIRES_APPLY'
  | 'EXPECTED_PLAN_ID_REQUIRES_APPLY'
  | 'MISSING_EXPECTED_PLAN_ID'
  | 'INVALID_EXPECTED_PLAN_ID';

function argumentFailure(
  mode: 'dry-run' | 'apply',
  code: ArgumentErrorCode,
): PersonalOnboardingCommandResult {
  return {
    stdout: JSON.stringify({
      schemaVersion: '1.0',
      status: 'error',
      command: 'onboard-repo',
      mode,
      error: { code },
      components: {},
    }),
    exitCode: 20,
  };
}

function source(
  cwd: string,
  value: string,
): PersonalOnboardingTemplateSource | undefined {
  if (value.length === 0 || value.includes('\0')) return undefined;
  if (value.startsWith('github:') || value.startsWith('https://github.com/')) {
    try {
      const parsed = parseProjectTemplateGithubSourceSpec(value);
      const canonical = parsed.kind === 'github-ref'
        ? `github:${parsed.owner}/${parsed.repo}@${parsed.ref}`
        : parsed.assetUrl;
      return canonical === value ? { kind: 'github', value } : undefined;
    } catch {
      return undefined;
    }
  }
  if (!value.endsWith('.taktpack')) return undefined;
  return { kind: 'local', value: resolve(cwd, value) };
}

/**
 * Keeps legacy onboarding completely isolated from template authority setup.
 * This function returns output instead of writing it so the CLI remains the
 * sole stdout owner for both human and machine modes.
 */
export async function executePersonalOnboardingCommand(
  options: PersonalOnboardingCommandOptions,
  dependencies: PersonalOnboardingCommandDependencies,
): Promise<PersonalOnboardingCommandResult> {
  const repoPath = resolve(options.cwd);
  if (options.template === undefined) {
    const report = await dependencies.runLegacy({
      repoPath,
      repo: options.repo,
      apply: options.apply === true,
      force: options.force === true,
    });
    return {
      stdout: dependencies.formatLegacy(report),
      exitCode: report.passed ? 0 : 1,
    };
  }

  const mode = options.apply === true ? 'apply' : 'dry-run';
  if (mode === 'dry-run' && options.force === true) {
    return argumentFailure(mode, 'FORCE_REQUIRES_APPLY');
  }
  if (mode === 'dry-run' && options.expectedPlanId !== undefined) {
    return argumentFailure(mode, 'EXPECTED_PLAN_ID_REQUIRES_APPLY');
  }
  if (mode === 'apply' && options.expectedPlanId === undefined) {
    return argumentFailure(mode, 'MISSING_EXPECTED_PLAN_ID');
  }
  if (mode === 'apply' && !SHA256.test(options.expectedPlanId!)) {
    return argumentFailure(mode, 'INVALID_EXPECTED_PLAN_ID');
  }
  const parsedSource = source(repoPath, options.template);
  if (parsedSource === undefined) return argumentFailure(mode, 'INVALID_ARGUMENT');

  const mutation: PersonalOnboardingTemplateMutation = mode === 'apply'
    ? {
      mode,
      force: options.force === true,
      expectedPlanId: options.expectedPlanId!,
    }
    : { mode, force: false };
  const result = await dependencies.createTemplateFacade().run({
    repoPath,
    repo: options.repo,
    source: parsedSource,
    mutation,
  });
  return {
    stdout: options.json === true ? result.machineOutput : result.humanOutput,
    exitCode: result.passed ? 0 : 1,
  };
}
