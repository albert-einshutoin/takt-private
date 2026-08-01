import { types } from 'node:util';

export type ProjectTemplateRemoteTransactionLinearizationErrorCode =
  | 'INVALID_LINEARIZATION'
  | 'PREPARATION_FAILED'
  | 'APPROVAL_INVALID'
  | 'PUBLISH_FAILED';

export class ProjectTemplateRemoteTransactionLinearizationError extends Error {
  readonly operatorDetail: string;

  constructor(
    public readonly code:
      ProjectTemplateRemoteTransactionLinearizationErrorCode,
  ) {
    super(code === 'INVALID_LINEARIZATION'
      ? 'remote transaction linearization is invalid'
      : code === 'PREPARATION_FAILED'
        ? 'remote transaction preparation failed'
        : code === 'APPROVAL_INVALID'
          ? 'remote transaction approval is invalid'
          : 'remote transaction publish failed');
    this.name = 'ProjectTemplateRemoteTransactionLinearizationError';
    this.operatorDetail = code === 'INVALID_LINEARIZATION'
      ? 'trusted-linearization-shape-rejected'
      : code === 'PREPARATION_FAILED'
        ? 'pre-consume-preparation-did-not-complete'
        : code === 'APPROVAL_INVALID'
          ? 'single-use-approval-consume-rejected'
          : 'post-consume-publish-did-not-complete';
    Object.freeze(this);
  }
}

export interface LinearizePreparedProjectTemplateRemoteTransactionOptions<
  Prepared,
  Result,
> {
  readonly prepare: () => Promise<Prepared>;
  readonly consumeApproval: () => Promise<boolean>;
  readonly publish: (prepared: Prepared) => Promise<Result>;
  readonly assertAuthority: () => void;
}

function invalid(): never {
  throw new ProjectTemplateRemoteTransactionLinearizationError(
    'INVALID_LINEARIZATION',
  );
}

function snapshotOptions<Prepared, Result>(
  value: LinearizePreparedProjectTemplateRemoteTransactionOptions<
    Prepared,
    Result
  >,
): LinearizePreparedProjectTemplateRemoteTransactionOptions<Prepared, Result> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = [
    'prepare',
    'consumeApproval',
    'publish',
    'assertAuthority',
  ] as const;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expected.length
    || keys.some((key) => !expected.includes(key as typeof expected[number]))
  ) invalid();
  const methods = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !('value' in descriptor)
      || typeof descriptor.value !== 'function'
      || types.isProxy(descriptor.value)
    ) invalid();
    methods[key] = descriptor.value;
  }
  return Object.freeze({
    prepare: methods['prepare'] as () => Promise<Prepared>,
    consumeApproval: methods['consumeApproval'] as () => Promise<boolean>,
    publish: methods['publish'] as (prepared: Prepared) => Promise<Result>,
    assertAuthority: methods['assertAuthority'] as () => void,
  });
}

/**
 * Linearizes a fully prepared transaction at approval consumption. Preparation
 * is retryable because it precedes consumption; every later failure leaves the
 * approval burned and therefore cannot publish twice on retry.
 */
export async function linearizePreparedProjectTemplateRemoteTransaction<
  Prepared,
  Result,
>(
  value: LinearizePreparedProjectTemplateRemoteTransactionOptions<
    Prepared,
    Result
  >,
): Promise<Result> {
  const options = snapshotOptions(value);
  let prepared: Prepared;
  try {
    prepared = await options.prepare();
  } catch {
    throw new ProjectTemplateRemoteTransactionLinearizationError(
      'PREPARATION_FAILED',
    );
  }
  options.assertAuthority();

  let consumed = false;
  try {
    consumed = await options.consumeApproval();
  } catch {
    // The consume implementation owns its fail-closed durable claim. An
    // uncertain consume result is never treated as reusable authority.
    throw new ProjectTemplateRemoteTransactionLinearizationError(
      'APPROVAL_INVALID',
    );
  }
  options.assertAuthority();
  if (!consumed) {
    throw new ProjectTemplateRemoteTransactionLinearizationError(
      'APPROVAL_INVALID',
    );
  }

  let result: Result;
  try {
    result = await options.publish(prepared);
  } catch {
    throw new ProjectTemplateRemoteTransactionLinearizationError(
      'PUBLISH_FAILED',
    );
  }
  options.assertAuthority();
  return result;
}
