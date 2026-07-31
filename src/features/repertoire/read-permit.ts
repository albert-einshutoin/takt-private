import {
  REPERTOIRE_COORDINATION_LOCK_ORDER,
  RepertoireCoordinationError,
  acquireRepertoireCoordinationLease,
  acquireRepertoireCoordinationReadLeaseImmediate,
  type AcquireRepertoireCoordinationLeaseOptions,
  type RepertoireCoordinationLease,
} from './coordination-lease.js';
import { types as utilTypes } from 'node:util';

declare const repertoireReadPermitBrand: unique symbol;

/** Opaque proof that a global repertoire read lease is active for one root. */
export type RepertoireReadPermit = {
  readonly [repertoireReadPermitBrand]: true;
};

type RepertoireReadPermitBaseOptions = Omit<
  AcquireRepertoireCoordinationLeaseOptions,
  'mode'
>;

export type RepertoireReadPermitOptions<T> = RepertoireReadPermitBaseOptions & {
  operation: (permit: RepertoireReadPermit) => T | PromiseLike<T>;
};

export type PrepareRepertoireReadOptions<T> = RepertoireReadPermitBaseOptions & {
  operation: (permit: RepertoireReadPermit) => PromiseLike<T>;
};

export type ImmediateRepertoireReadPermitOptions<T> = Omit<
  RepertoireReadPermitBaseOptions,
  'timeoutMs'
> & {
  operation: (permit: RepertoireReadPermit) => T;
};

export class RepertoireReadBusyError extends Error {
  readonly code = 'REPERTOIRE_BUSY' as const;

  constructor() {
    super('Repertoire is busy');
    this.name = 'RepertoireReadBusyError';
  }
}

type PermitState = {
  active: boolean;
  root: string;
};

type CapturedFailure = { error: unknown };

type OptionsSnapshot<T> = {
  globalConfigDir: string;
  operation: (permit: RepertoireReadPermit) => T;
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
};

// This module is a private authority boundary. Capture every mutable intrinsic
// used to mint or validate authority before plugins can replace its behavior.
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeObjectCreate = Object.create.bind(Object);
const safeObjectFreeze = Object.freeze.bind(Object);
const safeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const safeObjectGetPrototypeOf = Object.getPrototypeOf.bind(Object);
const safeObjectHasOwn = Object.hasOwn.bind(Object);
const safeReflectOwnKeys = Reflect.ownKeys.bind(Reflect);
const safeIsProxy = utilTypes.isProxy.bind(utilTypes);
const localObjectPrototype = Object.prototype;
const SafeWeakMap = WeakMap;
const safeWeakMapGetMethod = WeakMap.prototype.get;
const safeWeakMapSetMethod = WeakMap.prototype.set;
const safeAcquireCoordinationLease = acquireRepertoireCoordinationLease;
const safeAcquireImmediateReadLease = acquireRepertoireCoordinationReadLeaseImmediate;
const permitAuthority = new SafeWeakMap<object, PermitState>();

export const REPERTOIRE_READ_PERMIT_LOCK_ORDER = REPERTOIRE_COORDINATION_LOCK_ORDER;

/**
 * Runs an asynchronous read while retaining the global read lease until the
 * callback settles. The permit is revoked before lease release begins.
 */
export async function withRepertoireReadPermit<T>(
  options: RepertoireReadPermitOptions<T>,
): Promise<T> {
  const snapshot = snapshotOptions<T | PromiseLike<T>>(options);
  const lease = await acquireReadLease(snapshot);
  const { permit, state } = mintPermit(snapshot.globalConfigDir);
  let result!: T;
  let primaryFailure: CapturedFailure | undefined;

  try {
    result = await snapshot.operation(permit);
  } catch (error) {
    primaryFailure = { error };
  }

  state.active = false;
  const releaseFailure = releaseLease(lease);
  if (primaryFailure !== undefined) throw primaryFailure.error;
  if (releaseFailure !== undefined) throw releaseFailure.error;
  return result;
}

/**
 * Prepares asynchronous work synchronously under a permit, then revokes and
 * releases before adopting the returned Promise. Code after the first async
 * suspension therefore cannot reuse the permit.
 */
export async function prepareRepertoireRead<T>(
  options: PrepareRepertoireReadOptions<T>,
): Promise<T> {
  const snapshot = snapshotOptions<PromiseLike<T>>(options);
  const lease = await acquireReadLease(snapshot);
  const { permit, state } = mintPermit(snapshot.globalConfigDir);
  let prepared!: PromiseLike<T>;
  let primaryFailure: CapturedFailure | undefined;

  try {
    prepared = snapshot.operation(permit);
  } catch (error) {
    primaryFailure = { error };
  }

  state.active = false;
  const releaseFailure = releaseLease(lease);
  if (primaryFailure !== undefined) throw primaryFailure.error;
  if (releaseFailure !== undefined) throw releaseFailure.error;
  return await prepared;
}

/** Runs a synchronous read or fails immediately when a writer is present. */
export function withImmediateRepertoireReadPermit<T>(
  options: ImmediateRepertoireReadPermitOptions<T>,
): T {
  const snapshot = snapshotOptions<T>(options);
  let lease: RepertoireCoordinationLease;
  try {
    lease = safeAcquireImmediateReadLease({
      globalConfigDir: snapshot.globalConfigDir,
      signal: snapshot.signal,
    });
  } catch (error) {
    if (error instanceof RepertoireCoordinationError && error.code === 'WRITER_PENDING') {
      throw new RepertoireReadBusyError();
    }
    throw error;
  }
  const { permit, state } = mintPermit(snapshot.globalConfigDir);
  let result!: T;
  let primaryFailure: CapturedFailure | undefined;
  try {
    result = snapshot.operation(permit);
  } catch (error) {
    primaryFailure = { error };
  }
  state.active = false;
  const releaseFailure = releaseLease(lease);
  if (primaryFailure !== undefined) throw primaryFailure.error;
  if (releaseFailure !== undefined) throw releaseFailure.error;
  return result;
}

/** Validates authority without revealing its bound root or underlying lease. */
export function assertActiveRepertoireReadPermit(
  permit: unknown,
  globalConfigDir: string,
): asserts permit is RepertoireReadPermit {
  if (!isWeakMapKey(permit)) throw invalidPermit();
  const state = safeReflectApply(safeWeakMapGetMethod, permitAuthority, [permit]) as
    | PermitState
    | undefined;
  if (state === undefined || !state.active || state.root !== globalConfigDir) {
    throw invalidPermit();
  }
}

async function acquireReadLease(
  options: Pick<OptionsSnapshot<unknown>, 'globalConfigDir' | 'signal' | 'timeoutMs'>,
): Promise<RepertoireCoordinationLease> {
  return await safeAcquireCoordinationLease({
    globalConfigDir: options.globalConfigDir,
    mode: 'read',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

function snapshotOptions<T>(options: unknown): OptionsSnapshot<T> {
  if (
    typeof options !== 'object'
    || options === null
    || safeIsProxy(options)
    || !isPlainOptionsObject(options)
  ) throw invalidPermit();
  const keys = safeReflectOwnKeys(options);
  if (keys.length < 2 || keys.length > 4) throw invalidPermit();

  let globalConfigDir: unknown;
  let operation: unknown;
  let signal: unknown;
  let timeoutMs: unknown;
  let hasGlobalConfigDir = false;
  let hasOperation = false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string') throw invalidPermit();
    const descriptor = safeObjectGetOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !safeObjectHasOwn(descriptor, 'value')) {
      throw invalidPermit();
    }
    switch (key) {
      case 'globalConfigDir':
        hasGlobalConfigDir = true;
        globalConfigDir = descriptor.value;
        break;
      case 'operation':
        hasOperation = true;
        operation = descriptor.value;
        break;
      case 'signal':
        signal = descriptor.value;
        break;
      case 'timeoutMs':
        timeoutMs = descriptor.value;
        break;
      default:
        throw invalidPermit();
    }
  }
  if (!hasGlobalConfigDir || typeof globalConfigDir !== 'string') throw invalidPermit();
  if (!hasOperation || typeof operation !== 'function') throw invalidPermit();
  return safeObjectFreeze(safeObjectCreate(null, {
    globalConfigDir: { value: globalConfigDir },
    operation: { value: operation },
    signal: { value: signal },
    timeoutMs: { value: timeoutMs },
  })) as OptionsSnapshot<T>;
}

function isPlainOptionsObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = safeObjectGetPrototypeOf(value);
  return prototype === localObjectPrototype || prototype === null;
}

function mintPermit(root: string): {
  permit: RepertoireReadPermit;
  state: PermitState;
} {
  const state: PermitState = { active: true, root };
  const permit = safeObjectFreeze(safeObjectCreate(null)) as RepertoireReadPermit;
  safeReflectApply(safeWeakMapSetMethod, permitAuthority, [permit, state]);
  return { permit, state };
}

function releaseLease(lease: RepertoireCoordinationLease): CapturedFailure | undefined {
  try {
    safeReflectApply(lease.release, lease, []);
    return undefined;
  } catch (error) {
    return { error };
  }
}

function isWeakMapKey(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function invalidPermit(): RepertoireCoordinationError {
  return new RepertoireCoordinationError('UNSAFE_STATE');
}
