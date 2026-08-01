import { types as utilTypes } from 'node:util';
import type { InternalWorkflowReadContext } from '../../../infra/config/loaders/workflowDiscovery.js';
import { createInternalWorkflowReadContext } from '../../../infra/config/loaders/workflowDiscovery.js';
import { getGlobalConfigDir } from '../../../infra/config/paths.js';
import { WorkflowDiscoveryReadError } from '../../../infra/config/loaders/workflowDiscoveryError.js';
import { prepareRepertoireRead } from '../../repertoire/read-permit.js';
import { withImmediateRepertoireReadPermit } from '../../repertoire/read-permit.js';

const safeIsPromise = utilTypes.isPromise.bind(utilTypes);
const safeIsProxy = utilTypes.isProxy.bind(utilTypes);
const safeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const safeGetPrototypeOf = Object.getPrototypeOf.bind(Object);

interface PrepareWorkflowRuntimeReadOptions<Result> {
  readonly abortSignal?: AbortSignal;
  readonly prepare: (context: InternalWorkflowReadContext) => Promise<Result>;
}

interface SnapshotWorkflowRuntimeReadOptions<Result> {
  readonly snapshot: (context: InternalWorkflowReadContext) => Result;
}

/** Captures synchronous runtime inputs without retaining the read authority. */
export function snapshotWorkflowRuntimeRead<Result>(
  options: SnapshotWorkflowRuntimeReadOptions<Result>,
): Readonly<Result> {
  const globalConfigDir = getGlobalConfigDir();
  return withImmediateRepertoireReadPermit({
    globalConfigDir,
    operation: (permit) => {
      const result = options.snapshot(createInternalWorkflowReadContext(globalConfigDir, permit));
      if (isUnsafeThenable(result)) throw new WorkflowDiscoveryReadError();
      return typeof result === 'object' && result !== null
        ? Object.freeze(result)
        : result;
    },
  });
}

function isUnsafeThenable(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  if (safeIsPromise(value) || safeIsProxy(value)) return true;
  let current: object | null = value as object;
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    const descriptor = safeGetOwnPropertyDescriptor(current, 'then');
    if (descriptor !== undefined) {
      return !('value' in descriptor) || typeof descriptor.value === 'function';
    }
    current = safeGetPrototypeOf(current);
  }
  return current !== null;
}

/**
 * Prepares an immutable runtime handoff under one global repertoire lease.
 * Why: native Promise creation must finish before the permit is revoked, while
 * adopting the Promise only after release keeps provider/network work outside.
 */
export function prepareWorkflowRuntimeRead<Result>(
  options: PrepareWorkflowRuntimeReadOptions<Result>,
): Promise<Result> {
  const globalConfigDir = getGlobalConfigDir();
  return prepareRepertoireRead({
    globalConfigDir,
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    operation: (permit) => {
      const context = createInternalWorkflowReadContext(globalConfigDir, permit);
      const prepared = options.prepare(context);
      // Arbitrary thenables can run getters or filesystem/network work when
      // adopted after release. Only a native Promise is a valid handoff.
      if (!safeIsPromise(prepared)) throw new WorkflowDiscoveryReadError();
      return prepared;
    },
  });
}
