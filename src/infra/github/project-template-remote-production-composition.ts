import { types } from 'node:util';
import {
  issueTrustedProjectTemplateApplyPreviewApproval,
  revokeProjectTemplateApplyPreviewApproval,
  type ProjectTemplateApplyPreviewApprovalEvidence,
} from '../../features/project-template/apply-preview-approval.js';
import type { ProjectTemplateRemoteApplyPreview } from '../../features/project-template/apply-preview-types.js';
import { initializeProjectTemplateApplyStorage } from '../../features/project-template/apply-storage.js';
import {
  recoverProjectTemplateCompanionLockTransaction,
} from '../../features/project-template/companion-lock-transaction.js';
import {
  downloadGithubTemplateSource,
  type GithubTemplateArchiveAssetPort,
} from '../../features/project-template/github-download-orchestrator.js';
import type { GithubTemplateSourceResolverPort } from '../../features/project-template/github-source-resolver-port.js';
import type { GithubTemplateSourceAdvisory } from '../../features/project-template/github-update-check.js';
import {
  createGithubProjectTemplateRemotePreview,
} from '../../features/project-template/remote-preview-facade.js';
import {
  createProjectTemplateRemoteApplyComposition,
} from '../../features/project-template/remote-transaction-apply-facade.js';
import type { ProjectTemplateRepertoireDependencyInspectionPort } from '../../features/project-template/repertoire-dependency-inspection-port.js';
import type { ProjectTemplateReceiptKeyStore } from '../security/project-template-receipt-key-store.js';
import {
  createProjectTemplateReceiptAuthenticationRuntime,
} from './project-template-receipt-authentication-runtime.js';

const SHA256 = /^[a-f0-9]{64}$/;
const APPROVAL_ID = /^approval-[a-f0-9-]{36}$/;
const DEFAULT_HANDLE_TTL_MS = 15 * 60 * 1_000;
const MAX_HANDLE_TTL_MS = 60 * 60 * 1_000;
const MAX_HANDLES = 64;
const DISPOSE_DRAIN_TIMEOUT_MS = 30_000;
const INTERNAL_ERROR_CAUSES = new WeakMap<Error, AggregateError>();

export type ProjectTemplateRemoteProductionCompositionErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNKNOWN_RECEIPT'
  | 'UNKNOWN_PREVIEW'
  | 'UNKNOWN_APPROVAL'
  | 'HANDLE_LIMIT_EXCEEDED'
  | 'DISPOSED'
  | 'OPERATION_FAILED';

export class ProjectTemplateRemoteProductionCompositionError extends Error {
  readonly operatorDetail: string;

  constructor(
    public readonly code: ProjectTemplateRemoteProductionCompositionErrorCode,
    internalCause?: AggregateError,
  ) {
    super('project template remote production operation failed');
    this.name = 'ProjectTemplateRemoteProductionCompositionError';
    this.operatorDetail = code.toLowerCase().replaceAll('_', '-');
    if (internalCause !== undefined) INTERNAL_ERROR_CAUSES.set(this, internalCause);
    Object.freeze(this);
  }
}

export interface ProjectTemplateRemoteProductionCompositionOptions {
  readonly keyStore: ProjectTemplateReceiptKeyStore;
  readonly resolver: GithubTemplateSourceResolverPort;
  readonly asset: GithubTemplateArchiveAssetPort;
  readonly repertoireInspectionPort: ProjectTemplateRepertoireDependencyInspectionPort;
  /** @internal deterministic bounded-handle clock for tests. */
  readonly now?: () => number;
  /** @internal deterministic bounded-handle TTL for tests. */
  readonly handleTtlMs?: number;
  /** @internal deterministic bounded-handle capacity for tests. */
  readonly handleLimit?: number;
}

export interface ProjectTemplateRemoteProductionComposition {
  download(options: {
    readonly projectRoot: string;
    readonly cacheRoot: string;
    readonly source: string;
    readonly advisory: GithubTemplateSourceAdvisory;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly receiptKey: string }>;
  preview(options: {
    readonly cacheRoot: string;
    readonly receiptKey: string;
    readonly projectRoot: string;
    readonly currentTaktVersion: string;
    readonly baselineStrategy: 'conflict' | 'adopt-identical';
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly previewId: string;
    readonly transactionPlanId: string;
  }>;
  approve(options: {
    readonly projectRoot: string;
    readonly previewId: string;
    readonly transactionPlanId: string;
    readonly baselineStrategy: 'conflict' | 'adopt-identical';
  }): Promise<{ readonly approvalId: string }>;
  apply(options: {
    readonly cacheRoot: string;
    readonly receiptKey: string;
    readonly previewId: string;
    readonly transactionPlanId: string;
    readonly approvalId: string;
    readonly projectRoot: string;
    readonly currentTaktVersion: string;
    readonly baselineStrategy: 'conflict' | 'adopt-identical';
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly status: 'committed';
    readonly transactionPlanId: string;
  }>;
  recover(options: { readonly projectRoot: string }): Promise<{
    readonly status: 'none' | 'committed' | 'rolled-back';
  }>;
  dispose(): Promise<void>;
}

interface ProjectTemplateRemoteProductionCompositionTestControl {
  readonly disposeDrainTimeoutMs?: number;
  readonly operationGate?: (
    operation: 'download' | 'preview' | 'approve' | 'recover',
  ) => Promise<void>;
}

interface ReceiptHandle {
  readonly expiresAt: number;
}

interface PreviewHandle {
  readonly receiptKey: string;
  readonly preview: ProjectTemplateRemoteApplyPreview;
  readonly projectRoot: string;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly expiresAt: number;
}

interface ApprovalHandle extends PreviewHandle {
  readonly evidence: ProjectTemplateApplyPreviewApprovalEvidence;
}

type HandleKind = 'receipts' | 'previews' | 'approvals';

function failure(code: ProjectTemplateRemoteProductionCompositionErrorCode): never {
  throw new ProjectTemplateRemoteProductionCompositionError(code);
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) failure('INVALID_ARGUMENT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    required.some((key) => !keys.includes(key))
    || keys.some((key) => typeof key !== 'string'
      || (!required.includes(key) && !optional.includes(key)))
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor))
  ) failure('INVALID_ARGUMENT');
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [
    key,
    (descriptor as PropertyDescriptor & { value: unknown }).value,
  ]));
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) failure('INVALID_ARGUMENT');
  return value;
}

function strategy(record: Record<string, unknown>): 'conflict' | 'adopt-identical' {
  const value = record['baselineStrategy'];
  if (value !== 'conflict' && value !== 'adopt-identical') failure('INVALID_ARGUMENT');
  return value;
}

/**
 * Creates the only production bridge allowed to hold receipt verification and
 * approval authorities. Public consumers receive opaque IDs, never secrets,
 * verifier functions, evidence objects, or mutation-lease claims.
 */
export async function createProjectTemplateRemoteProductionComposition(
  value: ProjectTemplateRemoteProductionCompositionOptions,
): Promise<ProjectTemplateRemoteProductionComposition> {
  return await createProjectTemplateRemoteProductionCompositionInternal(value, {});
}

/** @internal Test-only deterministic orchestration; never re-exported publicly. */
export async function createProjectTemplateRemoteProductionCompositionForTest(
  value: ProjectTemplateRemoteProductionCompositionOptions,
  control: ProjectTemplateRemoteProductionCompositionTestControl,
): Promise<ProjectTemplateRemoteProductionComposition> {
  return await createProjectTemplateRemoteProductionCompositionInternal(value, control);
}

async function createProjectTemplateRemoteProductionCompositionInternal(
  value: ProjectTemplateRemoteProductionCompositionOptions,
  control: ProjectTemplateRemoteProductionCompositionTestControl,
): Promise<ProjectTemplateRemoteProductionComposition> {
  const source = exactRecord(value, [
    'keyStore', 'resolver', 'asset', 'repertoireInspectionPort',
  ], ['now', 'handleTtlMs', 'handleLimit']);
  const now = source['now'] === undefined ? Date.now : source['now'];
  const handleTtlMs = source['handleTtlMs'] ?? DEFAULT_HANDLE_TTL_MS;
  const handleLimit = source['handleLimit'] ?? MAX_HANDLES;
  const testControl = exactRecord(control, [], ['disposeDrainTimeoutMs', 'operationGate']);
  const disposeDrainTimeoutMs = testControl['disposeDrainTimeoutMs']
    ?? DISPOSE_DRAIN_TIMEOUT_MS;
  const operationGate = testControl['operationGate'];
  if (
    typeof now !== 'function'
    || types.isProxy(now)
    || typeof handleTtlMs !== 'number'
    || !Number.isSafeInteger(handleTtlMs)
    || handleTtlMs <= 0
    || handleTtlMs > MAX_HANDLE_TTL_MS
    || typeof handleLimit !== 'number'
    || !Number.isSafeInteger(handleLimit)
    || handleLimit <= 0
    || handleLimit > MAX_HANDLES
    || typeof disposeDrainTimeoutMs !== 'number'
    || !Number.isSafeInteger(disposeDrainTimeoutMs)
    || disposeDrainTimeoutMs <= 0
    || disposeDrainTimeoutMs > DISPOSE_DRAIN_TIMEOUT_MS
    || (operationGate !== undefined
      && (typeof operationGate !== 'function' || types.isProxy(operationGate)))
  ) failure('INVALID_ARGUMENT');

  const keyStore = source['keyStore'] as ProjectTemplateReceiptKeyStore;
  let runtime;
  try {
    runtime = await createProjectTemplateReceiptAuthenticationRuntime({
      keyStore,
    });
  } catch (primaryError) {
    let cleanupError: unknown;
    try {
      await keyStore.dispose();
    } catch (error) {
      cleanupError = error;
    }
    throw new ProjectTemplateRemoteProductionCompositionError(
      'OPERATION_FAILED',
      new AggregateError(
        cleanupError === undefined
          ? [primaryError]
          : [primaryError, cleanupError],
        'receipt runtime factory failed',
      ),
    );
  }
  let applyComposition;
  try {
    applyComposition = createProjectTemplateRemoteApplyComposition({
      verifier: runtime.verifier,
      repertoireInspectionPort: source['repertoireInspectionPort'] as
        ProjectTemplateRepertoireDependencyInspectionPort,
    });
  } catch (primaryError) {
    let cleanupError: unknown;
    try {
      await runtime.dispose();
    } catch (error) {
      cleanupError = error;
    }
    throw new ProjectTemplateRemoteProductionCompositionError(
      'INVALID_ARGUMENT',
      new AggregateError(
        cleanupError === undefined
          ? [primaryError]
          : [primaryError, cleanupError],
        'production composition factory failed',
      ),
    );
  }

  const receipts = new Map<string, ReceiptHandle>();
  const previews = new Map<string, PreviewHandle>();
  const approvals = new Map<string, ApprovalHandle>();
  let disposed = false;
  let operationEpoch = 0;
  let disposePromise: Promise<void> | undefined;
  let lastNow = Number.NEGATIVE_INFINITY;
  let activeOperations = 0;
  let drainWaiter: (() => void) | undefined;
  const shutdown = new AbortController();

  const time = (): number => {
    const value = Reflect.apply(now as () => number, undefined, []) as number;
    if (!Number.isFinite(value) || value < lastNow) failure('OPERATION_FAILED');
    lastNow = value;
    return value;
  };
  const available = (): void => { if (disposed) failure('DISPOSED'); };
  const current = (epoch: number): void => {
    if (disposed || epoch !== operationEpoch) failure('DISPOSED');
  };
  const active = <T extends { readonly expiresAt: number }>(
    map: Map<string, T>,
    id: string,
    code: 'UNKNOWN_RECEIPT' | 'UNKNOWN_PREVIEW' | 'UNKNOWN_APPROVAL',
    nowMs: number,
  ): T => {
    const handle = map.get(id);
    if (handle === undefined || handle.expiresAt <= nowMs) {
      map.delete(id);
      failure(code);
    }
    return handle;
  };
  const reservations: Record<HandleKind, number> = {
    receipts: 0,
    previews: 0,
    approvals: 0,
  };
  const handleMaps = { receipts, previews, approvals } as const;
  const sweepExpired = (nowMs: number): ApprovalHandle[] => {
    const expiredReceipts = new Set<string>();
    for (const [receiptKey, handle] of receipts) {
      if (handle.expiresAt <= nowMs) {
        receipts.delete(receiptKey);
        expiredReceipts.add(receiptKey);
      }
    }
    const expiredPreviews = new Set<string>();
    for (const [previewId, handle] of previews) {
      if (handle.expiresAt <= nowMs || expiredReceipts.has(handle.receiptKey)) {
        previews.delete(previewId);
        expiredPreviews.add(previewId);
      }
    }
    const revoked: ApprovalHandle[] = [];
    for (const [approvalId, handle] of approvals) {
      if (
        handle.expiresAt <= nowMs
        || expiredReceipts.has(handle.receiptKey)
        || expiredPreviews.has(handle.preview.previewId)
      ) {
        approvals.delete(approvalId);
        revoked.push(handle);
      }
    }
    return revoked;
  };
  const revokeExpired = async (
    handles: readonly ApprovalHandle[],
    nowMs: number,
  ): Promise<void> => {
    for (const handle of handles) {
      try {
        const storage = await initializeProjectTemplateApplyStorage({
          repoPath: handle.projectRoot,
        });
        await revokeProjectTemplateApplyPreviewApproval({
          storage,
          evidence: handle.evidence,
          now: new Date(nowMs),
        });
      } catch {
        // The public handle is already unreachable and the approval record is
        // expired. A later operation still validates the durable TTL.
      }
    }
  };
  interface OperationContext { readonly epoch: number; readonly nowMs: number }
  const operation = async <T>(
    kind: HandleKind | undefined,
    run: (context: OperationContext) => Promise<T>,
  ): Promise<T> => {
    available();
    activeOperations += 1;
    let reserved = false;
    try {
      const epoch = operationEpoch;
      const nowMs = time();
      const revoked = sweepExpired(nowMs);
      current(epoch);
      if (kind !== undefined) {
        if (handleMaps[kind].size + reservations[kind] >= handleLimit) {
          failure('HANDLE_LIMIT_EXCEEDED');
        }
        reservations[kind] += 1;
        reserved = true;
      }
      await revokeExpired(revoked, nowMs);
      current(epoch);
      const result = await run({ epoch, nowMs });
      current(epoch);
      return result;
    } catch (error) {
      if (error instanceof ProjectTemplateRemoteProductionCompositionError) throw error;
      failure('OPERATION_FAILED');
    } finally {
      if (kind !== undefined && reserved) reservations[kind] -= 1;
      activeOperations -= 1;
      if (activeOperations === 0) {
        drainWaiter?.();
        drainWaiter = undefined;
      }
    }
  };
  const operationSignal = (signal: unknown): AbortSignal => signal === undefined
    ? shutdown.signal
    : AbortSignal.any([signal as AbortSignal, shutdown.signal]);

  return Object.freeze({
    async download(input: unknown) {
      return await operation('receipts', async ({ epoch, nowMs }) => {
        const options = exactRecord(input, [
          'projectRoot', 'cacheRoot', 'source', 'advisory',
        ], ['signal']);
        const result = await downloadGithubTemplateSource({
          projectRoot: text(options, 'projectRoot'),
          cacheRoot: text(options, 'cacheRoot'),
          source: text(options, 'source'),
          advisory: options['advisory'] as GithubTemplateSourceAdvisory,
          resolver: source['resolver'] as GithubTemplateSourceResolverPort,
          asset: source['asset'] as GithubTemplateArchiveAssetPort,
          authenticator: runtime.authenticator,
          verifier: runtime.verifier,
          signal: operationSignal(options['signal']),
        });
        if (operationGate !== undefined) await Reflect.apply(
          operationGate as (operation: 'download') => Promise<void>, undefined, ['download'],
        );
        current(epoch);
        receipts.set(result.receiptKey, { expiresAt: nowMs + (handleTtlMs as number) });
        return Object.freeze({ receiptKey: result.receiptKey });
      });
    },
    async preview(input: unknown) {
      return await operation('previews', async ({ epoch, nowMs }) => {
        const options = exactRecord(input, [
          'cacheRoot', 'receiptKey', 'projectRoot', 'currentTaktVersion', 'baselineStrategy',
        ], ['signal']);
        const receiptKey = text(options, 'receiptKey');
        if (!SHA256.test(receiptKey)) failure('INVALID_ARGUMENT');
        const receipt = active(receipts, receiptKey, 'UNKNOWN_RECEIPT', nowMs);
        const baselineStrategy = strategy(options);
        const projectRoot = text(options, 'projectRoot');
        const preview = await createGithubProjectTemplateRemotePreview({
          cacheRoot: text(options, 'cacheRoot'), receiptKey,
          verifier: runtime.verifier, projectRoot,
          currentTaktVersion: text(options, 'currentTaktVersion'),
          repertoireInspectionPort: source['repertoireInspectionPort'] as
            ProjectTemplateRepertoireDependencyInspectionPort,
          baselineStrategy,
          signal: operationSignal(options['signal']),
        });
        if (preview.transactionPlanId === undefined) failure('OPERATION_FAILED');
        if (operationGate !== undefined) await Reflect.apply(
          operationGate as (operation: 'preview') => Promise<void>, undefined, ['preview'],
        );
        current(epoch);
        previews.set(preview.previewId, {
          receiptKey, preview, projectRoot, baselineStrategy,
          expiresAt: Math.min(receipt.expiresAt, nowMs + (handleTtlMs as number)),
        });
        return Object.freeze({
          previewId: preview.previewId,
          transactionPlanId: preview.transactionPlanId,
        });
      });
    },
    async approve(input: unknown) {
      return await operation('approvals', async ({ epoch, nowMs }) => {
        const options = exactRecord(input, [
          'projectRoot', 'previewId', 'transactionPlanId', 'baselineStrategy',
        ]);
        const previewId = text(options, 'previewId');
        const transactionPlanId = text(options, 'transactionPlanId');
        if (!SHA256.test(previewId) || !SHA256.test(transactionPlanId)) {
          failure('INVALID_ARGUMENT');
        }
        const handle = active(previews, previewId, 'UNKNOWN_PREVIEW', nowMs);
        if (
          handle.preview.transactionPlanId !== transactionPlanId
          || handle.projectRoot !== text(options, 'projectRoot')
          || handle.baselineStrategy !== strategy(options)
        ) failure('UNKNOWN_PREVIEW');
        previews.delete(previewId);
        const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
          projectRoot: handle.projectRoot,
          preview: handle.preview,
          baselineStrategy: handle.baselineStrategy,
        });
        if (operationGate !== undefined) await Reflect.apply(
          operationGate as (operation: 'approve') => Promise<void>, undefined, ['approve'],
        );
        if (disposed || epoch !== operationEpoch) {
          try {
            const storage = await initializeProjectTemplateApplyStorage({
              repoPath: handle.projectRoot,
            });
            await revokeProjectTemplateApplyPreviewApproval({
              storage, evidence, now: new Date(nowMs),
            });
          } catch {
            // The public approval is never published; durable validation remains fail-closed.
          }
          failure('DISPOSED');
        }
        approvals.set(evidence.approvalId, { ...handle, evidence });
        return Object.freeze({ approvalId: evidence.approvalId });
      });
    },
    async apply(input: unknown) {
      return await operation(undefined, async ({ nowMs }) => {
        const options = exactRecord(input, [
          'cacheRoot', 'receiptKey', 'previewId', 'transactionPlanId', 'approvalId',
          'projectRoot', 'currentTaktVersion', 'baselineStrategy',
        ], ['signal']);
        const approvalId = text(options, 'approvalId');
        if (!APPROVAL_ID.test(approvalId)) failure('INVALID_ARGUMENT');
        const handle = active(approvals, approvalId, 'UNKNOWN_APPROVAL', nowMs);
        approvals.delete(approvalId);
        const receiptKey = text(options, 'receiptKey');
        if (
          handle.receiptKey !== receiptKey
          || handle.preview.previewId !== text(options, 'previewId')
          || handle.preview.transactionPlanId !== text(options, 'transactionPlanId')
          || handle.projectRoot !== text(options, 'projectRoot')
          || handle.baselineStrategy !== strategy(options)
        ) failure('UNKNOWN_APPROVAL');
        const result = await applyComposition.apply({
          cacheRoot: text(options, 'cacheRoot'), receiptKey,
          expectedTransactionPlanId: handle.preview.transactionPlanId,
          approvalEvidence: handle.evidence,
          projectRoot: handle.projectRoot,
          currentTaktVersion: text(options, 'currentTaktVersion'),
          baselineStrategy: handle.baselineStrategy,
          signal: operationSignal(options['signal']),
        });
        if (result.status !== 'committed') failure('OPERATION_FAILED');
        return Object.freeze({
          status: 'committed' as const,
          transactionPlanId: handle.preview.transactionPlanId,
        });
      });
    },
    async recover(input: unknown) {
      return await operation(undefined, async ({ epoch }) => {
        const options = exactRecord(input, ['projectRoot']);
        if (operationGate !== undefined) await Reflect.apply(
          operationGate as (operation: 'recover') => Promise<void>, undefined, ['recover'],
        );
        current(epoch);
        return Object.freeze(await recoverProjectTemplateCompanionLockTransaction({
          projectRoot: text(options, 'projectRoot'),
        }));
      });
    },
    dispose() {
      if (disposePromise !== undefined) return disposePromise;
      disposed = true;
      operationEpoch += 1;
      shutdown.abort();
      disposePromise = (async () => {
        if (activeOperations > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              drainWaiter = undefined;
              resolve();
            }, disposeDrainTimeoutMs as number);
            drainWaiter = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        const revoked = [...approvals.values()];
        receipts.clear();
        previews.clear();
        approvals.clear();
        await revokeExpired(revoked, Date.now());
        try {
          await runtime.dispose();
        } catch (error) {
          throw new ProjectTemplateRemoteProductionCompositionError(
            'OPERATION_FAILED',
            new AggregateError([error], 'receipt runtime disposal failed'),
          );
        }
      })();
      return disposePromise;
    },
  });
}
