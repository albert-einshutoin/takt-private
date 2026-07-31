import {
  REPERTOIRE_COORDINATION_LOCK_ORDER,
  RepertoireCoordinationError,
  acquireRepertoireCoordinationLease,
  type AcquireRepertoireCoordinationLeaseOptions,
  type RepertoireCoordinationLease,
} from './coordination-lease.js';

declare const repertoireReadPermitBrand: unique symbol;

/** Opaque proof that a global repertoire read lease is active for one root. */
export type RepertoireReadPermit = {
  readonly [repertoireReadPermitBrand]: true;
};

export type RepertoireReadPermitOptions = Omit<
  AcquireRepertoireCoordinationLeaseOptions,
  'mode'
>;

type PermitState = {
  active: boolean;
  root: string;
};

type CapturedFailure = { error: unknown };

// This module is a private authority boundary. Capture every mutable intrinsic
// used to mint or validate authority before plugins can replace its behavior.
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeObjectCreate = Object.create.bind(Object);
const safeObjectFreeze = Object.freeze.bind(Object);
const SafeWeakMap = WeakMap;
const safeWeakMapGetMethod = WeakMap.prototype.get;
const safeWeakMapSetMethod = WeakMap.prototype.set;
const safeAcquireCoordinationLease = acquireRepertoireCoordinationLease;
const permitAuthority = new SafeWeakMap<object, PermitState>();

export const REPERTOIRE_READ_PERMIT_LOCK_ORDER = REPERTOIRE_COORDINATION_LOCK_ORDER;

/**
 * Runs an asynchronous read while retaining the global read lease until the
 * callback settles. The permit is revoked before lease release begins.
 */
export async function withRepertoireReadPermit<T>(
  options: RepertoireReadPermitOptions,
  callback: (permit: RepertoireReadPermit) => T | PromiseLike<T>,
): Promise<T> {
  const lease = await acquireReadLease(options);
  const { permit, state } = mintPermit(options.globalConfigDir);
  let result!: T;
  let primaryFailure: CapturedFailure | undefined;

  try {
    result = await callback(permit);
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
  options: RepertoireReadPermitOptions,
  prepare: (permit: RepertoireReadPermit) => PromiseLike<T>,
): Promise<T> {
  const lease = await acquireReadLease(options);
  const { permit, state } = mintPermit(options.globalConfigDir);
  let prepared!: PromiseLike<T>;
  let primaryFailure: CapturedFailure | undefined;

  try {
    prepared = prepare(permit);
  } catch (error) {
    primaryFailure = { error };
  }

  state.active = false;
  const releaseFailure = releaseLease(lease);
  if (primaryFailure !== undefined) throw primaryFailure.error;
  if (releaseFailure !== undefined) throw releaseFailure.error;
  return await prepared;
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
  options: RepertoireReadPermitOptions,
): Promise<RepertoireCoordinationLease> {
  return await safeAcquireCoordinationLease({ ...options, mode: 'read' });
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
