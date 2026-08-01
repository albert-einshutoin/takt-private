export type GithubProjectTemplateRemotePreviewErrorCode =
  | 'ABORTED'
  | 'TIMEOUT';

export class GithubProjectTemplateRemotePreviewError extends Error {
  constructor(public readonly code: GithubProjectTemplateRemotePreviewErrorCode) {
    super(code === 'ABORTED'
      ? 'GitHub project template remote preview was aborted'
      : 'GitHub project template remote preview timed out');
    this.name = 'GithubProjectTemplateRemotePreviewError';
    Object.freeze(this);
  }
}

export interface ProjectTemplateRemotePreviewOperationContext {
  readonly signal?: AbortSignal;
  /** Absolute deadline in the monotonic performance time domain. */
  readonly deadlineMs: number;
  readonly __remotePreviewOperationContextBrand: true;
}

const AUTHORIZED_CONTEXTS = new WeakSet<object>();

const ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    if (ABORTED_GETTER === undefined) return true;
    return Reflect.apply(ABORTED_GETTER, signal, []) as boolean;
  } catch {
    return true;
  }
}

export function requireActiveRemotePreview(
  context: ProjectTemplateRemotePreviewOperationContext,
): void {
  if (!AUTHORIZED_CONTEXTS.has(context)) {
    throw new TypeError('remote preview operation context is invalid');
  }
  // Cancellation remains primary when it races the monotonic deadline.
  if (isAborted(context.signal)) {
    throw new GithubProjectTemplateRemotePreviewError('ABORTED');
  }
  if (performance.now() >= context.deadlineMs) {
    throw new GithubProjectTemplateRemotePreviewError('TIMEOUT');
  }
}

export function createRemotePreviewOperationContext(
  signal: AbortSignal | undefined,
  deadlineMs: number,
): ProjectTemplateRemotePreviewOperationContext {
  const context: ProjectTemplateRemotePreviewOperationContext = {
    ...(signal === undefined ? {} : { signal }),
    deadlineMs,
    __remotePreviewOperationContextBrand: true,
  };
  AUTHORIZED_CONTEXTS.add(context);
  return Object.freeze(context);
}
