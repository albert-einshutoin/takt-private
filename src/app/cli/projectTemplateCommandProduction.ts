import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import {
  executeProjectTemplateCliExport,
} from '../../features/project-template/cli-export-service.js';
import {
  inspectProjectTemplateForCli,
  inspectProjectTemplateForCliV1_1,
  listProjectTemplatesForCli,
  listProjectTemplatesForCliV1_1,
} from '../../features/project-template/cli-inspect-list-service.js';
import {
  createProductionProjectTemplateCliLocalApplyService,
} from '../../features/project-template/cli-local-apply-service.js';
import {
  createProductionProjectTemplateCliRollbackService,
} from '../../features/project-template/cli-rollback-service.js';
import {
  COMMIT_PATTERN_SOURCE,
  MAX_SEMVER_LENGTH,
  SEMVER_PATTERN_SOURCE,
} from '../../features/project-template/validation.js';
import { initializeProjectTemplateApplyStorage } from '../../features/project-template/apply-storage.js';
import { createProjectTemplateGithubSourceComposition } from '../../infra/github/project-template-github-source-composition.js';
import { createProjectTemplateCliRemoteProductionRuntime } from '../../infra/github/project-template-cli-remote-production.js';
import { createPosixProjectTemplateReceiptKeyStore } from '../../infra/security/project-template-receipt-key-store-posix.js';
import { createWin32ProjectTemplateReceiptKeyStore } from '../../infra/security/project-template-receipt-key-store-win32.js';
import {
  createProjectTemplateCliFailure,
  projectTemplateCliExitCodeForErrorCode,
  type ProjectTemplateCliErrorCode,
  type ProjectTemplateCliOutcome,
} from '../../features/project-template/cli-machine-contract.js';
import {
  createProjectTemplateCliV1_1FailureFor,
  type ProjectTemplateCliV1_1Outcome,
} from '../../features/project-template/cli-machine-contract-v1-1.js';
import type {
  ProjectTemplateCliCommandAdapterDependencies,
  ProjectTemplateCliCommandRequest,
} from './projectTemplateCommands.js';
import type { ProjectTemplateCliRemoteProductionRuntime } from '../../infra/github/project-template-cli-remote-production.js';
import type { ProjectTemplateCliLifecycleContext } from '../../features/project-template/cli-lifecycle.js';
import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { DEFAULT_LANGUAGE } from '../../shared/constants.js';
import type { Language } from '../../core/models/config-types.js';
import {
  isProjectTemplateCliExportApprovalError,
  parseProjectTemplateCliExportApprovals,
} from '../../features/project-template/cli-export-approvals.js';

// Why: call the captured exec intrinsic directly. Captured `test` still performs
// a dynamic `regexp.exec` lookup and can be poisoned after module initialization.
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REGEXP_EXEC = RegExp.prototype.exec;
// Why: repository export must accept exactly the commit formats that its manifest can validate.
const COMMIT_PATTERN = new RegExp(COMMIT_PATTERN_SOURCE, 'u');
const SEMVER_PATTERN = new RegExp(SEMVER_PATTERN_SOURCE, 'u');
const REMOTE_DEADLINE_MS = 30_000;

function isValidCommit(value: unknown): value is string {
  return typeof value === 'string'
    && CAPTURED_REFLECT_APPLY(CAPTURED_REGEXP_EXEC, COMMIT_PATTERN, [value]) !== null;
}

function isValidExportSemVer(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_SEMVER_LENGTH
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_REGEXP_EXEC,
      SEMVER_PATTERN,
      [value],
    ) !== null;
}

function privateDirectory(path: string): string {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const canonical = realpathSync(path);
  const stat = lstatSync(path);
  if (
    canonical !== resolve(path)
    || stat.isSymbolicLink()
    || !stat.isDirectory()
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) throw new Error('project template runtime directory is unsafe');
  return canonical;
}

function projectRootIdentity(projectRoot: string): string {
  const requested = resolve(projectRoot);
  const canonical = realpathSync(requested);
  const rootStat = lstatSync(requested);
  if (canonical !== requested || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('project template project root is unsafe');
  }
  const markers = [join(canonical, '.takt'), join(canonical, '.git')];
  const hasProjectMarker = markers.some((marker) => {
    try {
      const stat = lstatSync(marker);
      return !stat.isSymbolicLink()
        && stat.dev === rootStat.dev
        && (stat.isDirectory() || (marker.endsWith('.git') && stat.isFile()));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  });
  if (!hasProjectMarker) throw new Error('project template project root is not initialized');
  return canonical;
}

type RemoteRuntimeFactory = (
  projectRoot: string,
) => Promise<ProjectTemplateCliRemoteProductionRuntime>;

/** Resolve repertoire selection without initializing or rewriting configuration. */
export function resolveProjectTemplateCliProductionLanguage(
  canonicalProjectRoot: string,
): Language {
  return resolveConfigValue(canonicalProjectRoot, 'language') ?? DEFAULT_LANGUAGE;
}

async function createRemoteRuntime(projectRoot: string) {
  // Reuse the transaction storage guard so a hostile `.takt` symlink is
  // rejected before any runtime directory or key material can be created.
  const canonicalProjectRoot = projectRootIdentity(projectRoot);
  const language = resolveProjectTemplateCliProductionLanguage(canonicalProjectRoot);
  const storage = await initializeProjectTemplateApplyStorage({
    repoPath: canonicalProjectRoot,
  });
  const runtimeRoot = privateDirectory(join(storage.controlRoot, 'remote-runtime'));
  const cacheRoot = privateDirectory(join(runtimeRoot, 'cache'));
  const keyRoot = privateDirectory(join(runtimeRoot, 'receipt-keys'));
  const github = createProjectTemplateGithubSourceComposition({
    deadlineMs: performance.now() + REMOTE_DEADLINE_MS,
  });
  const {
    createProjectTemplateInstalledRepertoireDependencyInspectionPort,
  } = await import(
    '../../infra/repertoire/project-template-repertoire-dependency-inspector.js'
  );
  const keyStore = process.platform === 'win32'
    ? createWin32ProjectTemplateReceiptKeyStore({ directory: keyRoot })
    : createPosixProjectTemplateReceiptKeyStore({ directory: keyRoot });
  try {
    return await createProjectTemplateCliRemoteProductionRuntime({
      cacheRoot,
      keyStore,
      resolver: github.resolver,
      asset: github.archive,
      repertoireInspectionPort:
        createProjectTemplateInstalledRepertoireDependencyInspectionPort({
          projectRoot: canonicalProjectRoot, language,
        }),
    });
  } catch (error) {
    // The production composition normally owns the key store. If construction
    // fails before ownership transfers, erase its in-memory key material here.
    try { await keyStore.dispose(); } catch { /* Preserve the primary error. */ }
    throw error;
  }
}

function createRemoteRuntimeOwner(factory: RemoteRuntimeFactory) {
  let creation: Promise<ProjectTemplateCliRemoteProductionRuntime> | undefined;
  let disposePromise: Promise<void> | undefined;
  let state: 'active' | 'disposing' | 'disposed' = 'active';
  return Object.freeze({
    acquire(projectRoot: string) {
      if (state !== 'active') {
        return Promise.reject(new Error('project template remote runtime is disposed'));
      }
      creation ??= factory(projectRoot);
      return creation;
    },
    dispose() {
      disposePromise ??= (async () => {
        state = 'disposing';
        if (creation === undefined) {
          state = 'disposed';
          return;
        }
        let runtime: ProjectTemplateCliRemoteProductionRuntime;
        try {
          runtime = await creation;
        } catch {
          // Construction failed before a runtime existed. The command path
          // retains that primary error and the factory owns partial cleanup.
          state = 'disposed';
          return;
        }
        try {
          await runtime.dispose();
        } finally {
          state = 'disposed';
        }
      })();
      return disposePromise;
    },
  });
}

function failure(
  request: ProjectTemplateCliCommandRequest,
  code: ProjectTemplateCliErrorCode,
): ProjectTemplateCliOutcome | ProjectTemplateCliV1_1Outcome {
  const mode = request.mutation?.mode ?? 'dry-run';
  if (request.schemaVersion === '1.1') {
    return {
      envelope: createProjectTemplateCliV1_1FailureFor({ command: request.command, mode, code }),
      exitCode: projectTemplateCliExitCodeForErrorCode(code),
    };
  }
  return {
    envelope: createProjectTemplateCliFailure({ command: request.command, mode, code }),
    exitCode: projectTemplateCliExitCodeForErrorCode(code),
  };
}

async function dispatchProjectTemplateCommand(
  request: ProjectTemplateCliCommandRequest,
  context: ProjectTemplateCliLifecycleContext,
  acquireRemoteRuntime: RemoteRuntimeFactory,
): Promise<ProjectTemplateCliOutcome | ProjectTemplateCliV1_1Outcome> {
  if (request.command === 'project-template inspect') {
    if (request.source?.kind !== 'local') return failure(request, 'INVALID_ARGUMENT');
    const inspectOptions = {
      cwd: request.cwd,
      sourcePath: request.source.value,
      currentTaktVersion: request.currentTaktVersion,
      signal: context.signal,
    };
    return request.schemaVersion === '1.1'
      ? await inspectProjectTemplateForCliV1_1({ ...inspectOptions, schemaVersion: '1.1' })
      : await inspectProjectTemplateForCli(inspectOptions);
  }
  if (request.command === 'project-template list') {
    const options = { cwd: request.cwd, signal: context.signal };
    return request.schemaVersion === '1.1'
      ? await listProjectTemplatesForCliV1_1(options)
      : await listProjectTemplatesForCli(options);
  }
  if (request.command === 'project-template export') {
    const metadata = request.exportMetadata;
    if (
      request.outputPath === undefined
      || request.mutation === undefined
      || metadata?.packVersion === undefined
      || metadata.minTaktVersion === undefined
      || !isValidExportSemVer(metadata.packVersion)
      || !isValidExportSemVer(metadata.minTaktVersion)
      || !isValidCommit(metadata.sourceCommit)
    ) return failure(request, 'INVALID_ARGUMENT');
    let approvals;
    try {
      approvals = parseProjectTemplateCliExportApprovals({
        policies: metadata.policyApprovals,
        capabilities: metadata.capabilityApprovals,
      });
    } catch (error) {
      if (isProjectTemplateCliExportApprovalError(error)) {
        return failure(request, 'INVALID_ARGUMENT');
      }
      throw error;
    }
    if (request.schemaVersion === '1.1' && request.mutation.mode === 'apply') {
      return failure(request, 'INVALID_ARGUMENT');
    }
    const exportInput = {
      projectRoot: request.cwd,
      outputPath: request.outputPath,
      exportOptions: {
        packVersion: metadata.packVersion,
        takt: { minVersion: metadata.minTaktVersion },
        source: {
          kind: 'local' as const, uri: '.', ref: 'workspace' as const,
          commit: metadata.sourceCommit,
        },
        ...approvals,
      },
      mutation: request.mutation,
      signal: context.signal,
      ...(request.mutation.mode === 'apply'
        ? { admitMutation: context.admitMutation }
        : {}),
    };
    return request.schemaVersion === '1.1'
      ? await executeProjectTemplateCliExport({ ...exportInput, schemaVersion: '1.1' })
      : await executeProjectTemplateCliExport(exportInput);
  }
  if (request.command === 'project-template rollback') {
    if (request.schemaVersion === '1.1') return failure(request, 'INVALID_ARGUMENT');
    if (request.mutation === undefined || request.backupId === undefined) {
      return failure(request, 'INVALID_ARGUMENT');
    }
    return await createProductionProjectTemplateCliRollbackService().rollback({
      cwd: request.cwd,
      backupId: request.backupId,
      force: request.mutation.force,
      signal: context.signal,
      ...(request.mutation.mode === 'apply'
        ? {
          mode: 'apply' as const,
          expectedPlanId: request.mutation.expectedPlanId,
          admitMutation: context.admitMutation,
        }
        : { mode: 'dry-run' as const }),
    });
  }
  if (request.source?.kind === 'github') {
    if (request.mutation === undefined) return failure(request, 'INVALID_ARGUMENT');
    if (request.schemaVersion === '1.1'
      && (request.command === 'project-template update' || request.mutation.mode === 'apply')) {
      return failure(request, 'INVALID_ARGUMENT');
    }
    const runtime = await acquireRemoteRuntime(request.cwd);
    context.signal.throwIfAborted();
    const base = {
      cwd: request.cwd,
      source: request.source.value,
      currentTaktVersion: request.currentTaktVersion,
      baselineStrategy: 'conflict' as const,
      force: request.mutation.force,
      signal: context.signal,
    };
    if (request.command === 'project-template diff') {
      return request.schemaVersion === '1.1'
        ? await runtime.service.diffV1_1(base)
        : await runtime.service.diff(base);
    }
    if (request.schemaVersion === '1.1') return await runtime.service.applyDryRunV1_1(base);
    const options = request.mutation.mode === 'apply'
      ? {
        ...base,
        mode: 'apply' as const,
        expectedPlanId: request.mutation.expectedPlanId,
        admitMutation: context.admitMutation,
      }
      : { ...base, mode: 'dry-run' as const };
    return request.command === 'project-template update'
      ? await runtime.service.update(options)
      : await runtime.service.apply(options);
  }
  if (request.source?.kind !== 'local' || request.mutation === undefined) {
    return failure(request, 'INVALID_ARGUMENT');
  }
  if (request.command === 'project-template update') {
    return failure(request, 'INVALID_ARGUMENT');
  }
  const service = createProductionProjectTemplateCliLocalApplyService();
  const base = {
    cwd: request.cwd,
    sourcePath: request.source.value,
    currentTaktVersion: request.currentTaktVersion,
    force: request.mutation.force,
    signal: context.signal,
  };
  if (request.schemaVersion === '1.1') {
    if (request.mutation.mode === 'apply') return failure(request, 'INVALID_ARGUMENT');
    return request.command === 'project-template diff'
      ? await service.diffV1_1(base)
      : await service.applyDryRunV1_1(base);
  }
  if (request.command === 'project-template diff') return await service.diff(base);
  return await service.apply(request.mutation.mode === 'apply'
    ? {
      ...base,
      mode: 'apply',
      expectedPlanId: request.mutation.expectedPlanId,
      admitMutation: context.admitMutation,
    }
    : { ...base, mode: 'dry-run' });
}

export function createProjectTemplateCliCommandProductionDependencies(
  currentTaktVersion: string,
  testSeams: { readonly createRemoteRuntime?: RemoteRuntimeFactory } = {},
): ProjectTemplateCliCommandAdapterDependencies {
  const remoteRuntime = createRemoteRuntimeOwner(
    testSeams.createRemoteRuntime ?? createRemoteRuntime,
  );
  return {
    dispatch(request, context) {
      return dispatchProjectTemplateCommand(
        request,
        context,
        remoteRuntime.acquire,
      );
    },
    dispose() { return remoteRuntime.dispose(); },
    writeStdout(chunk) { process.stdout.write(chunk); },
    setExitCode(code) { process.exitCode = code; },
    installInterrupt(interrupt) {
      // Why: after mutation admission, the first SIGINT intentionally starts a
      // transaction drain. Keep consuming later SIGINTs until disposal so Node's
      // default handler cannot terminate commit, rollback, or recovery midway.
      process.on('SIGINT', interrupt);
      return () => { process.removeListener('SIGINT', interrupt); };
    },
    cwd: process.cwd,
    currentTaktVersion,
  };
}
