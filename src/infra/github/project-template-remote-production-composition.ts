import { types } from 'node:util';
import {
  issueTrustedProjectTemplateApplyPreviewApproval,
  type ProjectTemplateApplyPreviewApprovalEvidence,
} from '../../features/project-template/apply-preview-approval.js';
import type { ProjectTemplateRemoteApplyPreview } from '../../features/project-template/apply-preview-types.js';
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
  const source = exactRecord(value, [
    'keyStore', 'resolver', 'asset', 'repertoireInspectionPort',
  ], ['now', 'handleTtlMs']);
  const now = source['now'] === undefined ? Date.now : source['now'];
  const handleTtlMs = source['handleTtlMs'] ?? DEFAULT_HANDLE_TTL_MS;
  if (
    typeof now !== 'function'
    || types.isProxy(now)
    || typeof handleTtlMs !== 'number'
    || !Number.isSafeInteger(handleTtlMs)
    || handleTtlMs <= 0
    || handleTtlMs > MAX_HANDLE_TTL_MS
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
  let activeOperations = 0;
  let drainWaiter: (() => void) | undefined;
  const shutdown = new AbortController();

  const time = (): number => {
    const value = Reflect.apply(now as () => number, undefined, []) as number;
    if (!Number.isFinite(value)) failure('OPERATION_FAILED');
    return value;
  };
  const available = (): void => { if (disposed) failure('DISPOSED'); };
  const active = <T extends { readonly expiresAt: number }>(
    map: Map<string, T>,
    id: string,
    code: 'UNKNOWN_RECEIPT' | 'UNKNOWN_PREVIEW' | 'UNKNOWN_APPROVAL',
  ): T => {
    const handle = map.get(id);
    if (handle === undefined || handle.expiresAt <= time()) {
      map.delete(id);
      failure(code);
    }
    return handle;
  };
  const reserve = (map: Map<string, unknown>): void => {
    if (map.size >= MAX_HANDLES) failure('HANDLE_LIMIT_EXCEEDED');
  };
  const operation = async <T>(run: () => Promise<T>): Promise<T> => {
    available();
    activeOperations += 1;
    try {
      return await run();
    } catch (error) {
      if (error instanceof ProjectTemplateRemoteProductionCompositionError) throw error;
      failure('OPERATION_FAILED');
    } finally {
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
      return await operation(async () => {
        const options = exactRecord(input, [
          'projectRoot', 'cacheRoot', 'source', 'advisory',
        ], ['signal']);
        reserve(receipts);
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
        receipts.set(result.receiptKey, { expiresAt: time() + (handleTtlMs as number) });
        return Object.freeze({ receiptKey: result.receiptKey });
      });
    },
    async preview(input: unknown) {
      return await operation(async () => {
        const options = exactRecord(input, [
          'cacheRoot', 'receiptKey', 'projectRoot', 'currentTaktVersion', 'baselineStrategy',
        ], ['signal']);
        const receiptKey = text(options, 'receiptKey');
        if (!SHA256.test(receiptKey)) failure('INVALID_ARGUMENT');
        const receipt = active(receipts, receiptKey, 'UNKNOWN_RECEIPT');
        reserve(previews);
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
        previews.set(preview.previewId, {
          receiptKey, preview, projectRoot, baselineStrategy,
          expiresAt: Math.min(receipt.expiresAt, time() + (handleTtlMs as number)),
        });
        return Object.freeze({
          previewId: preview.previewId,
          transactionPlanId: preview.transactionPlanId,
        });
      });
    },
    async approve(input: unknown) {
      return await operation(async () => {
        const options = exactRecord(input, [
          'projectRoot', 'previewId', 'transactionPlanId', 'baselineStrategy',
        ]);
        const previewId = text(options, 'previewId');
        const transactionPlanId = text(options, 'transactionPlanId');
        if (!SHA256.test(previewId) || !SHA256.test(transactionPlanId)) {
          failure('INVALID_ARGUMENT');
        }
        const handle = active(previews, previewId, 'UNKNOWN_PREVIEW');
        if (
          handle.preview.transactionPlanId !== transactionPlanId
          || handle.projectRoot !== text(options, 'projectRoot')
          || handle.baselineStrategy !== strategy(options)
        ) failure('UNKNOWN_PREVIEW');
        previews.delete(previewId);
        reserve(approvals);
        const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
          projectRoot: handle.projectRoot,
          preview: handle.preview,
          baselineStrategy: handle.baselineStrategy,
        });
        approvals.set(evidence.approvalId, { ...handle, evidence });
        return Object.freeze({ approvalId: evidence.approvalId });
      });
    },
    async apply(input: unknown) {
      return await operation(async () => {
        const options = exactRecord(input, [
          'cacheRoot', 'receiptKey', 'previewId', 'transactionPlanId', 'approvalId',
          'projectRoot', 'currentTaktVersion', 'baselineStrategy',
        ], ['signal']);
        const approvalId = text(options, 'approvalId');
        if (!APPROVAL_ID.test(approvalId)) failure('INVALID_ARGUMENT');
        const handle = active(approvals, approvalId, 'UNKNOWN_APPROVAL');
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
      return await operation(async () => {
        const options = exactRecord(input, ['projectRoot']);
        return Object.freeze(await recoverProjectTemplateCompanionLockTransaction({
          projectRoot: text(options, 'projectRoot'),
        }));
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      shutdown.abort();
      if (activeOperations > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            drainWaiter = undefined;
            resolve();
          }, DISPOSE_DRAIN_TIMEOUT_MS);
          drainWaiter = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      // New work was rejected synchronously before the bounded drain. Clear
      // handles only after in-flight operations release their private claims.
      receipts.clear();
      previews.clear();
      approvals.clear();
      try {
        await runtime.dispose();
      } catch (error) {
        throw new ProjectTemplateRemoteProductionCompositionError(
          'OPERATION_FAILED',
          new AggregateError([error], 'receipt runtime disposal failed'),
        );
      }
    },
  });
}
