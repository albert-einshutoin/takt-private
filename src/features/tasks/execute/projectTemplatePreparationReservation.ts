import { randomUUID } from 'node:crypto';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { RunMetaManager } from './runMeta.js';

export interface ProjectTemplatePreparationOptions {
  readonly projectRoot: string;
  readonly task: string;
  readonly workflow: string;
}

export interface ProjectTemplatePreparationReservation {
  /**
   * Publish a successful terminal state after the protected operation or its
   * canonical running evidence is complete.
   */
  complete(): void;
  /** Publish an aborted terminal state after protected work has stopped. */
  abort(): void;
}

/**
 * Preserve both the protected-operation failure and a fail-closed
 * terminalization failure. Losing the first error makes runtime diagnosis
 * misleading, while losing the second hides uncertain coordination state.
 */
export function abortProjectTemplatePreparationAfterError(
  reservation: ProjectTemplatePreparationReservation,
  primaryError: unknown,
): void {
  try {
    reservation.abort();
  } catch (terminalizationError) {
    const terminalizationErrors = terminalizationError instanceof AggregateError
      ? terminalizationError.errors
      : [terminalizationError];
    throw new AggregateError(
      [primaryError, ...terminalizationErrors],
      'Project template preparation and abort publication both failed',
    );
  }
}

class RunMetaPreparationReservation implements ProjectTemplatePreparationReservation {
  private terminalizationStarted = false;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private heartbeatError: unknown;

  constructor(
    private readonly manager: RunMetaManager,
    heartbeatIntervalMs: number,
  ) {
    this.heartbeat = setInterval(() => {
      if (this.terminalizationStarted) return;
      try {
        this.manager.refresh();
      } catch (error) {
        // A timer exception must not crash the owner process. Stop refreshing
        // and retain the failure so the protected operation cannot later
        // report a clean completion.
        this.heartbeatError = error;
        clearInterval(this.heartbeat);
      }
    }, heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  complete(): void {
    this.finalize('completed');
  }

  abort(): void {
    this.finalize('aborted');
  }

  private finalize(status: 'completed' | 'aborted'): void {
    if (this.terminalizationStarted) return;
    // Set the flag before the durable write. If publication fails, retrying a
    // different terminal status could replace fail-closed running evidence
    // and hide an uncertain transition.
    this.terminalizationStarted = true;
    clearInterval(this.heartbeat);
    let terminalizationError: unknown;
    try {
      this.manager.finalize(status);
    } catch (error) {
      terminalizationError = error;
    }
    const failures = [
      ...(this.heartbeatError === undefined ? [] : [this.heartbeatError]),
      ...(terminalizationError === undefined ? [] : [terminalizationError]),
    ];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Project template preparation heartbeat and terminalization failed',
      );
    }
  }
}

/**
 * Publish coordination evidence before asynchronous preparation starts.
 *
 * A normal RunMeta record intentionally reuses the existing apply guard,
 * stale-run recovery, audit history, and retention contract. The constructor
 * is synchronous, so callers cannot read project template state before the
 * reservation is visible.
 */
export function beginProjectTemplatePreparation(
  options: ProjectTemplatePreparationOptions,
): ProjectTemplatePreparationReservation {
  const manager = new RunMetaManager(
    buildRunPaths(
      options.projectRoot,
      `project-template-preparation-${randomUUID()}`,
    ),
    options.task,
    options.workflow,
    undefined,
    { ownerPid: process.pid },
  );
  return new RunMetaPreparationReservation(manager, 60_000);
}
