import { types } from 'node:util';
import {
  createProjectTemplateArtifactDownloadBridge,
  type ProjectTemplateArtifactDownloadBridge,
  type ProjectTemplateArtifactDownloadSettlement,
} from './project-template-artifact-download.js';
import {
  type ProjectTemplateArtifactSingleAttempt,
  type ProjectTemplateArtifactSingleAttemptFailure,
  type ProjectTemplateArtifactSingleAttemptSettlement,
} from './project-template-artifact-download-attempt.js';
import {
  isRetryableProjectTemplateArtifactHttpStatus,
  MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES,
} from './project-template-artifact-download-contract.js';

type RetryableFailure = Extract<
ProjectTemplateArtifactSingleAttemptFailure,
{ readonly retryable: true; readonly replaySafe: true }
>;
type TerminalFailure = Extract<
ProjectTemplateArtifactSingleAttemptFailure,
{ readonly retryable: false; readonly replaySafe: false }
>;

declare const RETRY_CONTROL_BRAND: unique symbol;
declare const TERMINAL_CONTROL_BRAND: unique symbol;

export interface ProjectTemplateArtifactDownloadRetryControl {
  readonly [RETRY_CONTROL_BRAND]: true;
  retry(nextAttempt: ProjectTemplateArtifactSingleAttempt): undefined;
  fail(): undefined;
}

export interface ProjectTemplateArtifactDownloadTerminalControl {
  readonly [TERMINAL_CONTROL_BRAND]: true;
  fail(): undefined;
}

export type ProjectTemplateArtifactDownloadDecisionEvent =
  | {
    readonly kind: 'retryable';
    readonly failure: RetryableFailure;
    readonly control: ProjectTemplateArtifactDownloadRetryControl;
  }
  | {
    readonly kind: 'terminal';
    readonly failure: TerminalFailure;
    readonly control: ProjectTemplateArtifactDownloadTerminalControl;
  };

export interface ProjectTemplateArtifactDownloadPolicy {
  readonly decide: (
    event: ProjectTemplateArtifactDownloadDecisionEvent,
  ) => undefined;
}

interface PolicySnapshot {
  readonly receiver: ProjectTemplateArtifactDownloadPolicy;
  readonly decide: ProjectTemplateArtifactDownloadPolicy['decide'];
}

interface AttemptSnapshot {
  readonly receiver: ProjectTemplateArtifactSingleAttempt;
  readonly pull: ProjectTemplateArtifactSingleAttempt['pull'];
  readonly dispose: ProjectTemplateArtifactSingleAttempt['dispose'];
}

interface AttemptToken {
  active: boolean;
}

interface PendingPull {
  readonly settlement: ProjectTemplateArtifactDownloadSettlement;
}

interface Decision {
  active: boolean;
  invoking: boolean;
  selected:
    | { readonly kind: 'retry'; readonly attempt: AttemptSnapshot }
    | { readonly kind: 'fail' }
    | undefined;
  control: object | undefined;
  readonly state: CoordinatorState;
  readonly pending: PendingPull;
}

interface CoordinatorState {
  phase: 'cold' | 'active' | 'deciding' | 'done' | 'failed' | 'disposed';
  current: AttemptSnapshot | undefined;
  pending: PendingPull | undefined;
  attemptToken: AttemptToken | undefined;
  decision: Decision | undefined;
  deliveredAny: boolean;
  readonly policy: PolicySnapshot;
  readonly seenAttempts: WeakSet<object>;
}

const decisionAuthorities = new WeakMap<object, Decision>();
const expiredDecisionControls = new WeakSet<object>();
const claimedAttempts = new WeakSet<object>();
const disposedAttempts = new WeakSet<object>();
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;

const OUTPUT_LIMIT_FAILURE = Object.freeze(
  Object.assign(Object.create(null) as object, {
    code: 'OUTPUT_LIMIT' as const,
    retryable: false as const,
    replaySafe: false as const,
  }),
);
const INTERNAL_FAILURE = Object.freeze(
  Object.assign(Object.create(null) as object, {
    code: 'INTERNAL' as const,
    retryable: false as const,
    replaySafe: false as const,
  }),
);

function invalidArgument(): TypeError {
  return new TypeError('GitHub template artifact coordinator input is invalid');
}

function expiredControl(): TypeError {
  return new TypeError('GitHub template artifact decision is no longer active');
}

function snapshotAttempt(value: unknown): AttemptSnapshot {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || !Object.isFrozen(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw invalidArgument();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== 2
    || !['pull', 'dispose'].every((name) => {
      const descriptor = descriptors[name];
      return (
        descriptor !== undefined
        && 'value' in descriptor
        && typeof descriptor.value === 'function'
        && !types.isProxy(descriptor.value)
      );
    })
  ) throw invalidArgument();
  return Object.freeze({
    receiver: value as ProjectTemplateArtifactSingleAttempt,
    pull: descriptors['pull']!.value as
      ProjectTemplateArtifactSingleAttempt['pull'],
    dispose: descriptors['dispose']!.value as
      ProjectTemplateArtifactSingleAttempt['dispose'],
  });
}

function snapshotPolicy(value: unknown): PolicySnapshot {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw invalidArgument();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const decide = descriptors['decide'];
  if (
    Reflect.ownKeys(value).length !== 1
    || decide === undefined
    || !('value' in decide)
    || typeof decide.value !== 'function'
    || types.isProxy(decide.value)
  ) throw invalidArgument();
  return Object.freeze({
    receiver: value as ProjectTemplateArtifactDownloadPolicy,
    decide: decide.value as ProjectTemplateArtifactDownloadPolicy['decide'],
  });
}

function isFailure(
  value: unknown,
): value is ProjectTemplateArtifactSingleAttemptFailure {
  const prototype = (
    typeof value === 'object'
    && value !== null
    && !types.isProxy(value)
  )
    ? Object.getPrototypeOf(value)
    : undefined;
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || !Object.isFrozen(value)
    || (prototype !== null && prototype !== Object.prototype)
  ) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((entry) => !('value' in entry))) {
    return false;
  }
  const code = descriptors['code']?.value;
  const retryable = descriptors['retryable']?.value;
  const replaySafe = descriptors['replaySafe']?.value;
  const hasStatus = code === 'HTTP_STATUS';
  if (
    Reflect.ownKeys(value).length !== (hasStatus ? 4 : 3)
    || typeof retryable !== 'boolean'
    || replaySafe !== retryable
  ) return false;
  if (hasStatus) {
    const statusCode = descriptors['statusCode']?.value;
    return Number.isSafeInteger(statusCode)
      && statusCode >= 100
      && statusCode <= 599
      && retryable
        === isRetryableProjectTemplateArtifactHttpStatus(statusCode);
  }
  return [
    'NETWORK',
    'DNS_REJECTED',
    'INVALID_RESPONSE',
    'OUTPUT_LIMIT',
    'INTERNAL',
  ].includes(code)
    && (
      code === 'NETWORK'
        ? true
        : retryable === false
    );
}

function safelyDisposeAttempt(attempt: AttemptSnapshot | undefined): void {
  if (attempt === undefined) return;
  try {
    if (disposedAttempts.has(attempt.receiver)) return;
    // Claim before untrusted cleanup so recursive dispose remains exact-once.
    disposedAttempts.add(attempt.receiver);
    Reflect.apply(attempt.dispose, attempt.receiver, []);
  } catch {
    // Logical generation revocation remains authoritative.
  }
}

function expireDecision(decision: Decision): void {
  decision.active = false;
  const control = decision.control;
  decision.control = undefined;
  if (control === undefined) return;
  decisionAuthorities.delete(control);
  expiredDecisionControls.add(control);
}

function failBridge(state: CoordinatorState, pending: PendingPull): void {
  if (
    state.phase === 'disposed'
    || state.phase === 'done'
    || state.phase === 'failed'
    || state.pending !== pending
  ) return;
  state.phase = 'failed';
  state.pending = undefined;
  const current = state.current;
  state.current = undefined;
  if (state.attemptToken !== undefined) state.attemptToken.active = false;
  state.attemptToken = undefined;
  const decision = state.decision;
  state.decision = undefined;
  if (decision !== undefined) expireDecision(decision);
  safelyDisposeAttempt(current);
  try {
    pending.settlement.fail();
  } catch {
    // D1 owns its terminal bridge outcome.
  }
}

function inspectChunkByteLength(value: unknown): number | undefined {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || !types.isUint8Array(value)
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) return undefined;
  try {
    const length = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
    return typeof length === 'number' && length > 0 ? length : undefined;
  } catch {
    return undefined;
  }
}

function applyDecision(decision: Decision): void {
  const { state, pending } = decision;
  if (
    !decision.active
    || state.phase !== 'deciding'
    || state.decision !== decision
    || state.pending !== pending
  ) return;
  const selected = decision.selected;
  if (selected === undefined) return;
  expireDecision(decision);
  state.decision = undefined;
  if (selected.kind === 'fail') {
    failBridge(state, pending);
    return;
  }
  state.phase = 'active';
  state.current = selected.attempt;
  state.seenAttempts.add(selected.attempt.receiver);
  claimedAttempts.add(selected.attempt.receiver);
  pullCurrent(state, pending);
}

function selectFail(control: object): undefined {
  const decision = decisionAuthorities.get(control);
  if (decision === undefined) {
    if (expiredDecisionControls.has(control)) throw expiredControl();
    throw invalidArgument();
  }
  if (
    !decision.active
    || decision.selected !== undefined
  ) throw invalidArgument();
  decision.selected = { kind: 'fail' };
  if (!decision.invoking) applyDecision(decision);
  return undefined;
}

function selectRetry(
  control: object,
  nextValue: ProjectTemplateArtifactSingleAttempt,
): undefined {
  const decision = decisionAuthorities.get(control);
  let next: AttemptSnapshot | undefined;
  try {
    next = snapshotAttempt(nextValue);
  } catch {
    if (decision === undefined || !decision.active) {
      try {
        next = snapshotAttempt(nextValue);
      } catch {
        throw invalidArgument();
      }
      safelyDisposeAttempt(next);
    }
    throw invalidArgument();
  }
  if (
    decision === undefined
    || !decision.active
    || decision.selected !== undefined
    || decision.state.seenAttempts.has(next.receiver)
    || claimedAttempts.has(next.receiver)
  ) {
    const alreadySelected = decision?.selected?.kind === 'retry'
      ? decision.selected.attempt.receiver
      : undefined;
    // A repeated call must not revoke the generation already selected by the
    // first call; genuinely late, unowned attempts are still contained.
    if (
      alreadySelected !== next.receiver
      && !claimedAttempts.has(next.receiver)
    ) safelyDisposeAttempt(next);
    if (
      decision === undefined
      && expiredDecisionControls.has(control)
    ) throw expiredControl();
    throw invalidArgument();
  }
  decision.selected = { kind: 'retry', attempt: next };
  if (!decision.invoking) applyDecision(decision);
  return undefined;
}

function retryWithControl(
  this: object,
  nextAttempt: ProjectTemplateArtifactSingleAttempt,
): undefined {
  return selectRetry(this, nextAttempt);
}

function failWithControl(this: object): undefined {
  return selectFail(this);
}

function createDecision(
  state: CoordinatorState,
  pending: PendingPull,
  failure: ProjectTemplateArtifactSingleAttemptFailure,
): Decision {
  const decision: Decision = {
    active: true,
    invoking: true,
    selected: undefined,
    control: undefined,
    state,
    pending,
  };
  const retryable = (
    failure.retryable
    && failure.replaySafe
    && !state.deliveredAny
  );
  const control = retryable
    ? Object.freeze<ProjectTemplateArtifactDownloadRetryControl>({
      retry: retryWithControl,
      fail: failWithControl,
    } as ProjectTemplateArtifactDownloadRetryControl)
    : Object.freeze<ProjectTemplateArtifactDownloadTerminalControl>({
      fail: failWithControl,
    } as ProjectTemplateArtifactDownloadTerminalControl);
  decision.control = control;
  decisionAuthorities.set(control, decision);
  const event = Object.freeze({
    kind: retryable ? 'retryable' as const : 'terminal' as const,
    failure,
    control,
  }) as ProjectTemplateArtifactDownloadDecisionEvent;
  state.decision = decision;
  let returned: unknown;
  try {
    returned = Reflect.apply(
      state.policy.decide,
      state.policy.receiver,
      [event],
    );
  } catch {
    returned = false;
  }
  decision.invoking = false;
  if (returned !== undefined) {
    expireDecision(decision);
    state.decision = undefined;
    const selected = decision.selected;
    if (selected?.kind === 'retry') safelyDisposeAttempt(selected.attempt);
    failBridge(state, pending);
  } else {
    applyDecision(decision);
  }
  return decision;
}

function handleFailure(
  state: CoordinatorState,
  pending: PendingPull,
  token: AttemptToken,
  failureValue: unknown,
): void {
  if (
    !token.active
    || state.attemptToken !== token
    || state.pending !== pending
    || state.phase !== 'active'
  ) return;
  token.active = false;
  state.attemptToken = undefined;
  const old = state.current;
  state.current = undefined;
  state.phase = 'deciding';
  const observed = isFailure(failureValue) ? failureValue : INTERNAL_FAILURE;
  // D2 marks every post-delivery failure non-replay-safe. Treat a structurally
  // valid but contract-breaking fake retryable failure as INTERNAL instead of
  // presenting an impossible terminal-event type to policy.
  const failure = observed.retryable && state.deliveredAny
    ? INTERNAL_FAILURE
    : observed;
  // Revoke and physically release the old generation before policy can expose
  // a replacement attempt or retain its one-shot decision control.
  safelyDisposeAttempt(old);
  if (state.phase !== 'deciding' || state.pending !== pending) return;
  createDecision(state, pending, failure);
}

function pullCurrent(state: CoordinatorState, pending: PendingPull): void {
  const attempt = state.current;
  if (
    attempt === undefined
    || state.pending !== pending
    || state.phase !== 'active'
  ) {
    failBridge(state, pending);
    return;
  }
  const token: AttemptToken = { active: true };
  state.attemptToken = token;
  const settlement = Object.freeze<ProjectTemplateArtifactSingleAttemptSettlement>({
    chunk(value): undefined {
      if (
        !token.active
        || state.attemptToken !== token
        || state.pending !== pending
        || state.phase !== 'active'
      ) return undefined;
      const byteLength = inspectChunkByteLength(value);
      if (
        byteLength === undefined
        || byteLength > MAX_PROJECT_TEMPLATE_ARTIFACT_CHUNK_BYTES
      ) {
        handleFailure(state, pending, token, OUTPUT_LIMIT_FAILURE);
        return undefined;
      }
      token.active = false;
      state.attemptToken = undefined;
      state.pending = undefined;
      state.deliveredAny = true;
      try {
        pending.settlement.chunk(value);
      } catch {
        // D1 owns validation and closes its bridge on malformed delivery.
      }
      return undefined;
    },
    done(): undefined {
      if (
        !token.active
        || state.attemptToken !== token
        || state.pending !== pending
        || state.phase !== 'active'
      ) return undefined;
      token.active = false;
      state.attemptToken = undefined;
      state.pending = undefined;
      state.phase = 'done';
      const completed = state.current;
      state.current = undefined;
      safelyDisposeAttempt(completed);
      try {
        pending.settlement.done();
      } catch {
        // D1 owns its terminal bridge outcome.
      }
      return undefined;
    },
    fail(failure): undefined {
      handleFailure(state, pending, token, failure);
      return undefined;
    },
  });
  let returned: unknown;
  try {
    returned = Reflect.apply(attempt.pull, attempt.receiver, [settlement]);
  } catch {
    returned = false;
  }
  if (returned !== undefined) {
    handleFailure(state, pending, token, INTERNAL_FAILURE);
  }
}

function pullCoordinator(
  state: CoordinatorState,
  settlement: ProjectTemplateArtifactDownloadSettlement,
): undefined {
  if (
    (state.phase !== 'cold' && state.phase !== 'active')
    || state.pending !== undefined
    || state.current === undefined
  ) {
    try {
      settlement.fail();
    } catch {
      // D1 owns its bridge failure.
    }
    return undefined;
  }
  const pending = Object.freeze({ settlement });
  state.pending = pending;
  state.phase = 'active';
  pullCurrent(state, pending);
  return undefined;
}

function disposeCoordinator(state: CoordinatorState): undefined {
  if (state.phase === 'disposed') return undefined;
  state.phase = 'disposed';
  state.pending = undefined;
  if (state.attemptToken !== undefined) state.attemptToken.active = false;
  state.attemptToken = undefined;
  const decision = state.decision;
  state.decision = undefined;
  if (decision !== undefined) {
    const selected = decision.selected;
    expireDecision(decision);
    if (selected?.kind === 'retry') safelyDisposeAttempt(selected.attempt);
  }
  const current = state.current;
  state.current = undefined;
  safelyDisposeAttempt(current);
  return undefined;
}

export function createProjectTemplateArtifactDownloadCoordinatorBridge(
  initialAttemptValue: ProjectTemplateArtifactSingleAttempt,
  policyValue: ProjectTemplateArtifactDownloadPolicy,
): ProjectTemplateArtifactDownloadBridge {
  const initialAttempt = snapshotAttempt(initialAttemptValue);
  const policy = snapshotPolicy(policyValue);
  if (claimedAttempts.has(initialAttempt.receiver)) throw invalidArgument();
  claimedAttempts.add(initialAttempt.receiver);
  const state: CoordinatorState = {
    phase: 'cold',
    current: initialAttempt,
    pending: undefined,
    attemptToken: undefined,
    decision: undefined,
    deliveredAny: false,
    policy,
    seenAttempts: new WeakSet([initialAttempt.receiver]),
  };
  return createProjectTemplateArtifactDownloadBridge(
    state,
    pullCoordinator,
    disposeCoordinator,
  );
}
