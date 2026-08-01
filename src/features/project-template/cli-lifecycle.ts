import {
  createProjectTemplateCliFailure,
  type ProjectTemplateCliMode,
  type ProjectTemplateCliOutcome,
} from './cli-machine-contract.js';

export interface ProjectTemplateCliLifecycleContext {
  readonly signal: AbortSignal;
  readonly admitMutation: () => void;
}

export interface ProjectTemplateCliLifecycleExecution {
  readonly interrupt: () => void;
  readonly result: Promise<ProjectTemplateCliOutcome>;
}

class ProjectTemplateCliPreAdmissionInterrupt extends Error {
  constructor() {
    super('project-template command interrupted before mutation admission');
    this.name = 'ProjectTemplateCliPreAdmissionInterrupt';
  }
}

class ProjectTemplateCliDuplicateAdmission extends Error {
  constructor() {
    super('mutation admission may only occur once');
    this.name = 'ProjectTemplateCliDuplicateAdmission';
  }
}

function failureOutcome(
  command: string,
  mode: ProjectTemplateCliMode,
  code:
    | 'INTERRUPTED'
    | 'INTERNAL'
    | 'RECOVERY_REQUIRED'
    | 'RESULT_INDETERMINATE',
): ProjectTemplateCliOutcome {
  const exitCode = code === 'INTERRUPTED'
    ? 130
    : code === 'RECOVERY_REQUIRED' || code === 'RESULT_INDETERMINATE'
      ? 25
      : 70;
  return {
    envelope: createProjectTemplateCliFailure({ command, mode, code }),
    exitCode,
  };
}

export function startProjectTemplateCliLifecycle(input: {
  readonly command: string;
  readonly mode: ProjectTemplateCliMode;
  readonly dispose: () => void | Promise<void>;
  readonly handle: (
    context: ProjectTemplateCliLifecycleContext,
  ) => Promise<ProjectTemplateCliOutcome>;
}): ProjectTemplateCliLifecycleExecution {
  const controller = new AbortController();
  let admitted = false;
  let interrupted = false;
  let settled = false;

  const interrupt = (): void => {
    if (settled || interrupted) return;
    interrupted = true;
    if (!admitted) {
      controller.abort(new ProjectTemplateCliPreAdmissionInterrupt());
    }
    // Once admitted, interruption only records intent. The transaction owns
    // the authority until it reaches commit, rollback, or recovery-required.
  };

  const admitMutation = (): void => {
    // This synchronous check is the linearization point: a prior interrupt can
    // never be followed by a newly admitted filesystem mutation.
    if (interrupted || controller.signal.aborted) {
      throw new ProjectTemplateCliPreAdmissionInterrupt();
    }
    if (admitted) {
      throw new ProjectTemplateCliDuplicateAdmission();
    }
    admitted = true;
  };

  const result = (async (): Promise<ProjectTemplateCliOutcome> => {
    let outcome: ProjectTemplateCliOutcome;
    try {
      outcome = await input.handle({
        signal: controller.signal,
        admitMutation,
      });
      if (interrupted && !admitted) {
        outcome = failureOutcome(input.command, input.mode, 'INTERRUPTED');
      }
    } catch (error) {
      if (
        !admitted
        && (interrupted || error instanceof ProjectTemplateCliPreAdmissionInterrupt)
      ) {
        outcome = failureOutcome(input.command, input.mode, 'INTERRUPTED');
      } else if (error instanceof ProjectTemplateCliDuplicateAdmission) {
        outcome = failureOutcome(input.command, input.mode, 'INTERNAL');
      } else if (admitted) {
        outcome = failureOutcome(input.command, input.mode, 'RESULT_INDETERMINATE');
      } else {
        // Exception messages are intentionally not reflected into the envelope:
        // upstream errors can contain paths, credentials, or provider details.
        outcome = failureOutcome(input.command, input.mode, 'INTERNAL');
      }
    }

    settled = true;
    try {
      await input.dispose();
    } catch {
      outcome = failureOutcome(
        input.command,
        input.mode,
        admitted ? 'RECOVERY_REQUIRED' : 'INTERNAL',
      );
    }
    return outcome;
  })();

  return Object.freeze({ interrupt, result });
}
