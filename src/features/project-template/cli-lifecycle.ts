import {
  createProjectTemplateCliFailure,
  snapshotProjectTemplateCliOutcome,
  type ProjectTemplateCliCommand,
  type ProjectTemplateCliMode,
  type ProjectTemplateCliOutcome,
} from './cli-machine-contract.js';
import { types } from 'node:util';
import {
  createProjectTemplateCliV1_1FailureFor,
  snapshotProjectTemplateCliV1_1Outcome,
  type ProjectTemplateCliV1_1Outcome,
} from './cli-machine-contract-v1-1.js';

declare const PROJECT_TEMPLATE_ADMISSION_BRAND: unique symbol;
export type ProjectTemplateCliMutationAdmission = (() => void) & {
  readonly [PROJECT_TEMPLATE_ADMISSION_BRAND]: never;
};

const ACTIVE_ADMISSIONS = new WeakSet<() => void>();
const CAPTURED_WEAK_SET_ADD = WeakSet.prototype.add;
const CAPTURED_WEAK_SET_DELETE = WeakSet.prototype.delete;
const CAPTURED_WEAK_SET_HAS = WeakSet.prototype.has;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_IS_PROXY = types.isProxy;
const CAPTURED_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const CAPTURED_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const CAPTURED_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_CREATE = Object.create;

export interface ProjectTemplateCliLifecycleContext {
  readonly signal: AbortSignal;
  readonly admitMutation: ProjectTemplateCliMutationAdmission;
}

export interface ProjectTemplateCliLifecycleExecution<
  Outcome extends ProjectTemplateCliOutcome | ProjectTemplateCliV1_1Outcome = ProjectTemplateCliOutcome,
> {
  readonly interrupt: () => void;
  readonly result: Promise<Outcome>;
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

export class ProjectTemplateCliInvalidAdmission extends Error {
  constructor() {
    super('mutation admission capability is invalid or stale');
    this.name = 'ProjectTemplateCliInvalidAdmission';
  }
}

/** @internal Consumes a one-shot capability minted only by the CLI lifecycle. */
export function consumeProjectTemplateCliMutationAdmission(value: unknown): void {
  if (typeof value !== 'function' || CAPTURED_IS_PROXY(value)
    || !(CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_SET_HAS, ACTIVE_ADMISSIONS, [value]) as boolean)) {
    throw new ProjectTemplateCliInvalidAdmission();
  }
  CAPTURED_REFLECT_APPLY(value, undefined, []);
}

/** @internal Copies a closed plain-object input without invoking caller code. */
export function snapshotProjectTemplateCliOwnData(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || CAPTURED_IS_PROXY(value)
    || CAPTURED_REFLECT_APPLY(CAPTURED_GET_PROTOTYPE_OF, Object, [value])
      !== CAPTURED_OBJECT_PROTOTYPE) throw new ProjectTemplateCliInvalidAdmission();
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const keys = CAPTURED_REFLECT_APPLY(CAPTURED_OWN_KEYS, Reflect, [descriptors]) as PropertyKey[];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    let allowed = false;
    if (typeof key === 'string') {
      for (let requiredIndex = 0; requiredIndex < required.length; requiredIndex += 1) {
        if (required[requiredIndex] === key) allowed = true;
      }
      for (let optionalIndex = 0; optionalIndex < optional.length; optionalIndex += 1) {
        if (optional[optionalIndex] === key) allowed = true;
      }
    }
    if (!allowed) throw new ProjectTemplateCliInvalidAdmission();
  }
  for (let requiredIndex = 0; requiredIndex < required.length; requiredIndex += 1) {
    let present = false;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      if (keys[keyIndex] === required[requiredIndex]) present = true;
    }
    if (!present) throw new ProjectTemplateCliInvalidAdmission();
  }
  const result = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE, Object, [null],
  ) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string') throw new ProjectTemplateCliInvalidAdmission();
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new ProjectTemplateCliInvalidAdmission();
    }
    result[key] = descriptor.value;
  }
  return CAPTURED_REFLECT_APPLY(CAPTURED_OBJECT_FREEZE, Object, [result]) as Readonly<Record<string, unknown>>;
}

function failureOutcome(
  command: ProjectTemplateCliCommand,
  mode: ProjectTemplateCliMode,
  code:
    | 'INTERRUPTED'
    | 'INTERNAL'
    | 'RECOVERY_REQUIRED'
    | 'RESULT_INDETERMINATE',
  schemaVersion: '1.0' | '1.1',
): ProjectTemplateCliOutcome | ProjectTemplateCliV1_1Outcome {
  const exitCode = code === 'INTERRUPTED'
    ? 130
    : code === 'RECOVERY_REQUIRED' || code === 'RESULT_INDETERMINATE'
      ? 25
      : 70;
  if (schemaVersion === '1.1') {
    return { envelope: createProjectTemplateCliV1_1FailureFor({ command, mode, code }), exitCode };
  }
  return { envelope: createProjectTemplateCliFailure({ command, mode, code }), exitCode };
}

interface ProjectTemplateCliLifecycleInput<Outcome> {
  readonly command: ProjectTemplateCliCommand;
  readonly mode: ProjectTemplateCliMode;
  readonly dispose: () => void | Promise<void>;
  readonly handle: (
    context: ProjectTemplateCliLifecycleContext,
  ) => Promise<Outcome>;
}

export function startProjectTemplateCliLifecycle(
  input: ProjectTemplateCliLifecycleInput<ProjectTemplateCliOutcome> & {
    readonly schemaVersion?: '1.0';
  },
): ProjectTemplateCliLifecycleExecution<ProjectTemplateCliOutcome>;
export function startProjectTemplateCliLifecycle(
  input: ProjectTemplateCliLifecycleInput<ProjectTemplateCliV1_1Outcome> & {
    readonly schemaVersion: '1.1';
  },
): ProjectTemplateCliLifecycleExecution<ProjectTemplateCliV1_1Outcome>;
export function startProjectTemplateCliLifecycle(
  input: ProjectTemplateCliLifecycleInput<
    ProjectTemplateCliOutcome | ProjectTemplateCliV1_1Outcome
  > & { readonly schemaVersion?: '1.0' | '1.1' },
): ProjectTemplateCliLifecycleExecution<
  ProjectTemplateCliOutcome | ProjectTemplateCliV1_1Outcome
> {
  const schemaVersion = input.schemaVersion ?? '1.0';
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

  let admitMutation: ProjectTemplateCliMutationAdmission | undefined;
  const capability = (() => {
    // The callable checks its own registry membership as well as lifecycle
    // state because trusted adapters can retain and invoke the function
    // directly. Settlement must revoke both call paths, not only consume().
    if (settled || admitMutation !== capability
      || !(CAPTURED_REFLECT_APPLY(
        CAPTURED_WEAK_SET_HAS, ACTIVE_ADMISSIONS, [capability],
      ) as boolean)) {
      throw new ProjectTemplateCliInvalidAdmission();
    }
    if (admitted) {
      throw new ProjectTemplateCliDuplicateAdmission();
    }
    CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_SET_DELETE, ACTIVE_ADMISSIONS, [capability]);
    // This synchronous check is the linearization point: a prior interrupt can
    // never be followed by a newly admitted filesystem mutation.
    if (interrupted || controller.signal.aborted) {
      throw new ProjectTemplateCliPreAdmissionInterrupt();
    }
    admitted = true;
  }) as ProjectTemplateCliMutationAdmission;
  admitMutation = capability;
  CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_SET_ADD, ACTIVE_ADMISSIONS, [admitMutation]);

  const result = (async (): Promise<
    ProjectTemplateCliOutcome | ProjectTemplateCliV1_1Outcome
  > => {
    let outcome: ProjectTemplateCliOutcome | ProjectTemplateCliV1_1Outcome;
    try {
      const rawHandled = await input.handle({
        signal: controller.signal,
        admitMutation: admitMutation!,
      });
      const handled = schemaVersion === '1.1'
        ? snapshotProjectTemplateCliV1_1Outcome(rawHandled)
        : snapshotProjectTemplateCliOutcome(rawHandled);
      if (
        handled.envelope.command !== input.command
        || handled.envelope.mode !== input.mode
      ) {
        throw new Error('handler outcome identity does not match lifecycle input');
      }
      outcome = handled;
      if (interrupted && !admitted) {
        outcome = failureOutcome(input.command, input.mode, 'INTERRUPTED', schemaVersion);
      }
    } catch (error) {
      if (
        !admitted
        && (interrupted || error instanceof ProjectTemplateCliPreAdmissionInterrupt)
      ) {
        outcome = failureOutcome(input.command, input.mode, 'INTERRUPTED', schemaVersion);
      } else if (admitted) {
        outcome = failureOutcome(input.command, input.mode, 'RESULT_INDETERMINATE', schemaVersion);
      } else {
        // Exception messages are intentionally not reflected into the envelope:
        // upstream errors can contain paths, credentials, or provider details.
        outcome = failureOutcome(input.command, input.mode, 'INTERNAL', schemaVersion);
      }
    }

    settled = true;
    if (admitMutation !== undefined) {
      CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_SET_DELETE, ACTIVE_ADMISSIONS, [admitMutation]);
      admitMutation = undefined;
    }
    try {
      await input.dispose();
    } catch {
      outcome = failureOutcome(
        input.command,
        input.mode,
        admitted ? 'RECOVERY_REQUIRED' : 'INTERNAL',
        schemaVersion,
      );
    }
    return schemaVersion === '1.1'
      ? snapshotProjectTemplateCliV1_1Outcome(outcome)
      : snapshotProjectTemplateCliOutcome(outcome);
  })();

  return Object.freeze({ interrupt, result });
}
