import { types as utilTypes } from 'node:util';
import type { InternalWorkflowReadContext } from '../../../infra/config/loaders/workflowDiscovery.js';
import { createInternalWorkflowReadContext } from '../../../infra/config/loaders/workflowDiscovery.js';
import { getGlobalConfigDir } from '../../../infra/config/paths.js';
import { WorkflowDiscoveryReadError } from '../../../infra/config/loaders/workflowDiscoveryError.js';
import { prepareRepertoireRead } from '../../repertoire/read-permit.js';

const safeIsPromise = utilTypes.isPromise.bind(utilTypes);

interface PrepareWorkflowRuntimeReadOptions<Result> {
  readonly abortSignal?: AbortSignal;
  readonly prepare: (context: InternalWorkflowReadContext) => Promise<Result>;
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
