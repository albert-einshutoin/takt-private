import {
  snapshotProjectTemplateCliOutcome,
  type ProjectTemplateCliOutcome,
} from '../features/project-template/cli-machine-contract.js';
import type { PersonalOnboardingAction } from './personalOnboarding.js';
import type {
  PersonalOnboardingTemplateCommandFacade,
  PersonalOnboardingTemplateMutation,
  PersonalOnboardingTemplateSource,
} from './personalOnboardingCommand.js';

export interface PersonalOnboardingTemplateFacadeDependencies {
  readonly applyFiles: (options: {
    readonly repoPath: string;
    readonly repo?: string;
    readonly source: PersonalOnboardingTemplateSource;
    readonly mutation: PersonalOnboardingTemplateMutation;
  }) => Promise<ProjectTemplateCliOutcome>;
  readonly ensureRootGitignore: (
    repoPath: string,
    apply: boolean,
  ) => PersonalOnboardingAction;
  readonly ensureGithubLabels: (options: {
    readonly repoPath: string;
    readonly repo?: string;
    readonly apply: boolean;
  }) => Promise<PersonalOnboardingAction[]>;
}

type ComponentStatus = 'success' | 'error' | 'skipped';

interface ComponentSummary {
  readonly status: ComponentStatus;
  readonly changed?: boolean;
  readonly code?: string;
}

function actionComponent(action: PersonalOnboardingAction): ComponentSummary {
  return action.status === 'fail'
    ? { status: 'error', changed: false }
    : { status: 'success', changed: action.status === 'changed' };
}

function actionsComponent(actions: readonly PersonalOnboardingAction[]): ComponentSummary {
  return actions.some((action) => action.status === 'fail')
    ? { status: 'error', changed: actions.some((action) => action.status === 'changed') }
    : { status: 'success', changed: actions.some((action) => action.status === 'changed') };
}

function backupId(outcome: ProjectTemplateCliOutcome): string | undefined {
  if (outcome.envelope.status !== 'success') return undefined;
  const result = outcome.envelope.result as Record<string, unknown>;
  return typeof result['backupId'] === 'string' ? result['backupId'] : undefined;
}

function humanOutput(options: {
  readonly status: 'success' | 'partial' | 'error';
  readonly mode: 'dry-run' | 'apply';
  readonly files: ComponentSummary;
  readonly rootGitignore: ComponentSummary;
  readonly labels: ComponentSummary;
  readonly backupId?: string;
}): string {
  return [
    `devloopd onboard-repo template ${options.status}`,
    `Mode: ${options.mode}`,
    `- ${options.files.status.toUpperCase()} template files`,
    `- ${options.rootGitignore.status.toUpperCase()} root gitignore`,
    `- ${options.labels.status.toUpperCase()} github labels`,
    ...(options.backupId === undefined ? [] : [`Backup: ${options.backupId}`]),
  ].join('\n');
}

/**
 * Coordinates only closed safe-service results. Legacy force never reaches a
 * direct filesystem writer: it is carried solely in the exact template
 * mutation passed to the safe file service.
 */
export function createPersonalOnboardingTemplateFacade(
  dependencies: PersonalOnboardingTemplateFacadeDependencies,
): PersonalOnboardingTemplateCommandFacade {
  return Object.freeze({
    async run(options) {
      const outcome = snapshotProjectTemplateCliOutcome(
        await dependencies.applyFiles(options),
      );
      const mode = options.mutation.mode;
      if (outcome.envelope.status === 'error') {
        const files = {
          status: 'error' as const,
          code: outcome.envelope.error.code,
        };
        const rootGitignore = { status: 'skipped' as const };
        const labels = { status: 'skipped' as const };
        const machineOutput = JSON.stringify({
          schemaVersion: '1.0', status: 'error', command: 'onboard-repo', mode,
          components: { files, rootGitignore, labels },
        });
        return {
          passed: false,
          machineOutput,
          humanOutput: humanOutput({
            status: 'error', mode, files, rootGitignore, labels,
          }),
        };
      }

      const apply = mode === 'apply';
      const files = { status: 'success' as const, changed: apply };
      const rootAction = dependencies.ensureRootGitignore(options.repoPath, apply);
      const rootGitignore = actionComponent(rootAction);
      const labelActions = await dependencies.ensureGithubLabels({
        repoPath: options.repoPath,
        repo: options.repo,
        apply,
      });
      const labels = actionsComponent(labelActions);
      const retainedBackupId = backupId(outcome);
      const passed = rootGitignore.status === 'success' && labels.status === 'success';
      const status = passed ? 'success' as const : 'partial' as const;
      const machine = {
        schemaVersion: '1.0', status, command: 'onboard-repo', mode,
        ...(retainedBackupId === undefined ? {} : { backupId: retainedBackupId }),
        components: { files, rootGitignore, labels },
      };
      return {
        passed,
        machineOutput: JSON.stringify(machine),
        humanOutput: humanOutput({
          status, mode, files, rootGitignore, labels,
          ...(retainedBackupId === undefined ? {} : { backupId: retainedBackupId }),
        }),
      };
    },
  });
}
