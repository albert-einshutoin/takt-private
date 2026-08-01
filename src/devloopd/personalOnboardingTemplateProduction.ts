import { createDefaultDevloopCommandRunner } from './commandRunner.js';
import {
  ensurePersonalOnboardingGithubLabels,
  ensurePersonalOnboardingRootGitignore,
  type PersonalOnboardingAction,
} from './personalOnboarding.js';
import {
  createPersonalOnboardingTemplateFacade,
} from './personalOnboardingTemplate.js';
import {
  startProjectTemplateCliLifecycle,
} from '../features/project-template/cli-lifecycle.js';
import type {
  ProjectTemplateCliCommandAdapterDependencies,
} from '../app/cli/projectTemplateCommands.js';

type CommandDependenciesFactory = (
  currentTaktVersion: string,
) => ProjectTemplateCliCommandAdapterDependencies;

export interface ProductionPersonalOnboardingTemplateFacadeOptions {
  readonly currentTaktVersion: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly loadCommandDependenciesFactory?: () => Promise<CommandDependenciesFactory>;
  readonly installInterrupt?: (interrupt: () => void) => () => void;
  readonly ensureRootGitignore?: (
    repoPath: string,
    apply: boolean,
  ) => PersonalOnboardingAction;
  readonly ensureGithubLabels?: typeof ensurePersonalOnboardingGithubLabels;
}

async function defaultFactoryLoader(): Promise<CommandDependenciesFactory> {
  // Reuse the audited CLI composition instead of creating a second credential,
  // receipt-key, cache, and mutation-authority implementation in devloopd.
  const production = await import('../app/cli/projectTemplateCommandProduction.js');
  return production.createProjectTemplateCliCommandProductionDependencies;
}

function defaultInterruptInstaller(interrupt: () => void): () => void {
  // Why: onboarding reuses the transaction lifecycle. A persistent listener
  // prevents a second SIGINT from invoking Node's default exit while admitted
  // work is still draining to commit, rollback, or recovery.
  process.on('SIGINT', interrupt);
  return () => { process.removeListener('SIGINT', interrupt); };
}

export function createProductionPersonalOnboardingTemplateFacade(
  options: ProductionPersonalOnboardingTemplateFacadeOptions,
) {
  const env = options.env ?? process.env;
  const runner = createDefaultDevloopCommandRunner();
  const loadFactory = options.loadCommandDependenciesFactory ?? defaultFactoryLoader;
  const installInterrupt = options.installInterrupt ?? defaultInterruptInstaller;
  const ensureRootGitignore = options.ensureRootGitignore
    ?? ensurePersonalOnboardingRootGitignore;
  const ensureGithubLabels = options.ensureGithubLabels
    ?? ensurePersonalOnboardingGithubLabels;

  return createPersonalOnboardingTemplateFacade({
    async applyFiles(request) {
      let commandDependencies: ProjectTemplateCliCommandAdapterDependencies | undefined;
      let removeInterrupt: (() => void) | undefined;
      const executionState: {
        current?: ReturnType<typeof startProjectTemplateCliLifecycle>;
      } = {};
      let interruptedBeforeStart = false;
      const command = 'project-template apply' as const;
      const mode = request.mutation.mode;
      const lifecycle = startProjectTemplateCliLifecycle({
        command,
        mode,
        async dispose() {
          let primary: unknown;
          try {
            await commandDependencies?.dispose();
          } catch (error) {
            primary = error;
          }
          try {
            removeInterrupt?.();
          } catch (error) {
            if (primary !== undefined) {
              throw new AggregateError([primary, error], 'template onboarding cleanup failed');
            }
            throw error;
          }
          if (primary !== undefined) throw primary;
        },
        async handle(context) {
          removeInterrupt = installInterrupt(() => {
            if (executionState.current === undefined) interruptedBeforeStart = true;
            else executionState.current.interrupt();
          });
          await Promise.resolve();
          const createCommandDependencies = await loadFactory();
          context.signal.throwIfAborted();
          commandDependencies = createCommandDependencies(options.currentTaktVersion);
          return await commandDependencies.dispatch({
            command,
            cwd: request.repoPath,
            json: true,
            currentTaktVersion: options.currentTaktVersion,
            source: request.source,
            mutation: request.mutation,
          }, context);
        },
      });
      executionState.current = lifecycle;
      if (interruptedBeforeStart) lifecycle.interrupt();
      return await lifecycle.result;
    },
    ensureRootGitignore,
    ensureGithubLabels(postOptions) {
      return ensureGithubLabels({
        ...postOptions,
        env,
        runner,
      });
    },
  });
}
