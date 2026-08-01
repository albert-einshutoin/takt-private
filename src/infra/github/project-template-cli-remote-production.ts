import { inspectProjectTemplateApplyGuard } from '../../features/project-template/apply-guard.js';
import {
  createProjectTemplateCliRemoteApplyService,
  ProjectTemplateCliRemotePortError,
  type ProjectTemplateCliRemoteApplyPort,
  type ProjectTemplateCliRemoteApplyService,
  type ProjectTemplateCliRemoteDerivedPlan,
} from '../../features/project-template/cli-remote-apply-service.js';
import { readProjectTemplateCompanionLockState } from '../../features/project-template/companion-lock-state-reader.js';
import type { GithubTemplateArchiveAssetPort } from '../../features/project-template/github-download-orchestrator.js';
import type { GithubTemplateSourceResolverPort } from '../../features/project-template/github-source-resolver-port.js';
import type { GithubTemplateCurrentSourceEvidence } from '../../features/project-template/github-update-check.js';
import type { ProjectTemplateRepertoireDependencyInspectionPort } from '../../features/project-template/repertoire-dependency-inspection-port.js';
import type { ProjectTemplateReceiptKeyStore } from '../security/project-template-receipt-key-store.js';
import {
  createProjectTemplateRemoteProductionComposition,
  ProjectTemplateRemoteProductionCompositionError,
  type ProjectTemplateRemoteProductionComposition,
} from './project-template-remote-production-composition.js';

interface RemoteAuthority {
  readonly cwd: string;
  readonly source: string;
  readonly currentTaktVersion: string;
  readonly baselineStrategy: 'conflict' | 'adopt-identical';
  readonly receiptKey: string;
  readonly previewId: string;
  readonly transactionPlanId: string;
  state: 'active' | 'consumed';
}

const AUTHORITIES = new WeakMap<object, RemoteAuthority>();
const DEFAULT_RUNTIME_DISPOSE_DRAIN_TIMEOUT_MS = 30_000;

export interface ProjectTemplateCliRemoteProductionOptions {
  readonly cacheRoot: string;
  readonly keyStore: ProjectTemplateReceiptKeyStore;
  readonly resolver: GithubTemplateSourceResolverPort;
  readonly asset: GithubTemplateArchiveAssetPort;
  readonly repertoireInspectionPort: ProjectTemplateRepertoireDependencyInspectionPort;
}

export interface ProjectTemplateCliRemoteProductionRuntime {
  readonly service: ProjectTemplateCliRemoteApplyService;
  dispose(): Promise<void>;
}

function currentEvidence(projectRoot: string): GithubTemplateCurrentSourceEvidence | undefined {
  const companion = readProjectTemplateCompanionLockState(projectRoot);
  if (companion.state !== 'update') return undefined;
  const provenance = companion.sourceProvenance;
  const source = provenance.source;
  if ('kind' in source) return undefined;
  return Object.freeze({
    owner: source.owner,
    repo: source.repo,
    repositoryUrl: source.repositoryUrl as `https://github.com/${string}/${string}`,
    canonicalSource: source.canonicalSource,
    version: provenance.archive.version,
    sha256: provenance.archive.sha256,
    commit: source.commit,
    descriptorSha256: source.descriptorSha256,
  });
}

function deriveFailure(error: unknown): never {
  if (error instanceof ProjectTemplateCliRemotePortError) throw error;
  if (error instanceof ProjectTemplateRemoteProductionCompositionError) {
    if (error.code === 'INVALID_ARGUMENT') {
      throw new ProjectTemplateCliRemotePortError('SECURITY_GUARD');
    }
  }
  throw new ProjectTemplateCliRemotePortError('SOURCE_UNAVAILABLE');
}

function executeFailure(error: unknown): never {
  if (error instanceof ProjectTemplateCliRemotePortError) throw error;
  if (error instanceof ProjectTemplateRemoteProductionCompositionError) {
    if (error.code === 'UNKNOWN_PREVIEW' || error.code === 'INVALID_ARGUMENT') {
      throw new ProjectTemplateCliRemotePortError('SECURITY_GUARD');
    }
  }
  // Once production composition admits mutation, an opaque failure cannot be
  // safely reported as not-started; callers must recover or inspect state.
  throw new ProjectTemplateCliRemotePortError('RESULT_INDETERMINATE');
}

/** @internal Test seam; intentionally absent from package barrels. */
export function createProjectTemplateCliRemoteProductionRuntimeForTest(value: {
  readonly cacheRoot: string;
  readonly resolver: GithubTemplateSourceResolverPort;
  readonly composition: ProjectTemplateRemoteProductionComposition;
  readonly disposeDrainTimeoutMs?: number;
}): ProjectTemplateCliRemoteProductionRuntime {
  const { cacheRoot, resolver, composition } = value;
  const disposeDrainTimeoutMs = value.disposeDrainTimeoutMs
    ?? DEFAULT_RUNTIME_DISPOSE_DRAIN_TIMEOUT_MS;
  const shutdown = new AbortController();
  let state: 'active' | 'disposing' | 'disposed' = 'active';
  let activeDerivations = 0;
  let activeExecutions = 0;
  let resolveDerivationDrain: (() => void) | undefined;
  let resolveExecutionDrain: (() => void) | undefined;
  let disposePromise: Promise<void> | undefined;
  const enter = (kind: 'derive' | 'execute'): (() => void) => {
    if (state !== 'active') {
      throw new ProjectTemplateCliRemotePortError('SOURCE_UNAVAILABLE');
    }
    if (kind === 'derive') activeDerivations += 1;
    else activeExecutions += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (kind === 'derive') {
        activeDerivations -= 1;
        if (activeDerivations === 0) {
          resolveDerivationDrain?.();
          resolveDerivationDrain = undefined;
        }
      } else {
        activeExecutions -= 1;
        if (activeExecutions === 0) {
          resolveExecutionDrain?.();
          resolveExecutionDrain = undefined;
        }
      }
    };
  };
  const operationSignal = (signal: AbortSignal | undefined): AbortSignal => (
    signal === undefined
      ? shutdown.signal
      : AbortSignal.any([signal, shutdown.signal])
  );
  const port: ProjectTemplateCliRemoteApplyPort = {
    inspectGuard(cwd) {
      try {
        return inspectProjectTemplateApplyGuard({ repoPath: cwd });
      } catch {
        return Object.freeze({
          passed: false,
          blocks: Object.freeze([{ code: 'SECURITY_GUARD' }]),
        });
      }
    },
    async derive(options) {
      const leave = enter('derive');
      try {
        const signal = operationSignal(options.signal);
        const advisory = await resolver.resolveAdvisory({
          source: options.source,
          current: currentEvidence(options.cwd),
          signal,
        });
        signal.throwIfAborted();
        const downloaded = await composition.download({
          projectRoot: options.cwd,
          cacheRoot,
          source: options.source,
          advisory,
          signal,
        });
        signal.throwIfAborted();
        const previewed = await composition.preview({
          cacheRoot,
          receiptKey: downloaded.receiptKey,
          projectRoot: options.cwd,
          currentTaktVersion: options.currentTaktVersion,
          baselineStrategy: options.baselineStrategy,
          signal,
        });
        signal.throwIfAborted();
        const authority = Object.freeze({
          kind: 'project-template-cli-remote-authority',
        });
        AUTHORITIES.set(authority, {
          cwd: options.cwd,
          source: options.source,
          currentTaktVersion: options.currentTaktVersion,
          baselineStrategy: options.baselineStrategy,
          receiptKey: downloaded.receiptKey,
          previewId: previewed.previewId,
          transactionPlanId: previewed.transactionPlanId,
          state: 'active',
        });
        return Object.freeze({
          transactionPlanId: previewed.transactionPlanId,
          ...previewed.summary,
          updateAvailable: advisory.updateState !== 'up-to-date',
          hardConflict: previewed.summary.hardConflict || advisory.hardBlocked,
          defaultApplyPossible:
            previewed.summary.defaultApplyPossible && !advisory.hardBlocked,
          forceApplicable:
            previewed.summary.reviewRequired && !previewed.summary.hardConflict
              && !advisory.hardBlocked,
          authority,
        }) satisfies ProjectTemplateCliRemoteDerivedPlan;
      } catch (error) {
        deriveFailure(error);
      } finally {
        leave();
      }
    },
    async execute(options) {
      const leave = enter('execute');
      try {
        const key = options.derived.authority;
        const authority = typeof key === 'object' && key !== null
          ? AUTHORITIES.get(key) : undefined;
        if (
          authority === undefined
          || authority.state !== 'active'
          || authority.cwd !== options.cwd
          || authority.source !== options.source
          || authority.currentTaktVersion !== options.currentTaktVersion
          || authority.baselineStrategy !== options.baselineStrategy
          || authority.transactionPlanId !== options.expectedTransactionPlanId
        ) throw new ProjectTemplateCliRemotePortError('SECURITY_GUARD');
        authority.state = 'consumed';
        const result = await composition.applyWithInternalApproval({
          cacheRoot,
          receiptKey: authority.receiptKey,
          previewId: authority.previewId,
          transactionPlanId: authority.transactionPlanId,
          projectRoot: authority.cwd,
          currentTaktVersion: authority.currentTaktVersion,
          baselineStrategy: authority.baselineStrategy,
        });
        return Object.freeze({
          status: 'committed' as const,
          transactionPlanId: result.transactionPlanId,
          backupId: result.backupId,
        });
      } catch (error) {
        executeFailure(error);
      } finally {
        leave();
      }
    },
  };
  const dispose = (): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise;
    state = 'disposing';
    shutdown.abort();
    disposePromise = (async () => {
      if (activeExecutions !== 0) {
        await new Promise<void>((resolve) => { resolveExecutionDrain = resolve; });
      }
      if (activeDerivations !== 0) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (resolveDerivationDrain === finish) {
              resolveDerivationDrain = undefined;
            }
            resolve();
          };
          const timer = setTimeout(finish, disposeDrainTimeoutMs);
          timer.unref?.();
          resolveDerivationDrain = finish;
        });
      }
      try {
        await composition.dispose();
      } finally {
        state = 'disposed';
      }
    })();
    return disposePromise;
  };
  return Object.freeze({
    service: createProjectTemplateCliRemoteApplyService(port),
    dispose,
  });
}

export async function createProjectTemplateCliRemoteProductionRuntime(
  options: ProjectTemplateCliRemoteProductionOptions,
): Promise<ProjectTemplateCliRemoteProductionRuntime> {
  const composition = await createProjectTemplateRemoteProductionComposition({
    keyStore: options.keyStore,
    resolver: options.resolver,
    asset: options.asset,
    repertoireInspectionPort: options.repertoireInspectionPort,
  });
  return createProjectTemplateCliRemoteProductionRuntimeForTest({
    cacheRoot: options.cacheRoot,
    resolver: options.resolver,
    composition,
  });
}
