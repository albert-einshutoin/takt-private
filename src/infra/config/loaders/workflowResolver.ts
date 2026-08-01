/**
 * Workflow resolution.
 */

import { existsSync, lstatSync, realpathSync, Stats } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { types as utilTypes } from 'node:util';
import { isScopeRef, parseScopeRef } from 'faceted-prompting';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { validateWorkflowCallContracts as validateWorkflowCallContractsImpl } from './workflowCallContractValidator.js';
import { buildWorkflowDiscoveryConfig, loadValidatedWorkflowDiscoveryEntry } from './workflowDiscoveryLoader.js';
import {
  findWorkflowInLookupDirs,
  getBuiltinWorkflowPath,
  getNamedWorkflowLookupDirs,
  getWorkflowDirs,
  listBuiltinWorkflowNames as listBuiltinWorkflowNamesImpl,
  resolveWorkflowFileWithReadGuard,
  type NamedWorkflowLookupDir,
} from './workflowLookupDirectories.js';
import {
  loadWorkflowApprovedTextWithResolutionOptions,
  loadWorkflowFileWithResolutionOptions,
} from './workflowResolvedLoader.js';
import { getGlobalConfigDir } from '../paths.js';
import { type WorkflowTrustInfo } from './workflowTrustSource.js';
import {
  collectValidatedWorkflowEntriesWithReadContext,
  createInternalWorkflowReadContext,
  iterateWorkflowDir,
  listRepertoireWorkflowEntriesWithReadContext,
  loadAllWorkflowsWithSourcesFromDirs,
  readRepertoireWorkflowTextWithReadContext,
  type WorkflowDirEntry,
  type WorkflowDiscoveryConfig,
  type WorkflowDiscoveryWithSource,
  type WorkflowWithSource,
  type InternalWorkflowReadContext,
  WorkflowDiscoveryReadError,
} from './workflowDiscovery.js';
import {
  assertActiveRepertoireReadPermit,
  withImmediateRepertoireReadPermit,
} from '../../../features/repertoire/read-permit.js';
import {
  createRepertoireResourceReadAccess,
  isRepertoireResourcePath,
} from './repertoireResourceReadAccess.js';

const safeObjectCreate = Object.create.bind(Object);
const safeObjectFreeze = Object.freeze.bind(Object);
const safeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const safeObjectGetPrototypeOf = Object.getPrototypeOf.bind(Object);
const safeObjectHasOwn = Object.hasOwn.bind(Object);
const safeReflectOwnKeys = Reflect.ownKeys.bind(Reflect);
const safeIsProxy = utilTypes.isProxy.bind(utilTypes);
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeStatsIsFileMethod = Stats.prototype.isFile;
const localObjectPrototype = Object.prototype;

interface LoadWorkflowsOptions {
  onWarning?: (message: string) => void;
}

export interface WorkflowLookupOptions {
  basePath?: string;
  lookupCwd?: string;
}

interface InternalWorkflowLookupOptions extends WorkflowLookupOptions {
  callableArgs?: Record<string, string | string[]>;
  parentTrustInfo?: WorkflowTrustInfo;
  skipWorkflowCallContractValidation?: boolean;
  repertoireReadContext?: InternalWorkflowReadContext;
}

export type {
  WorkflowDirEntry,
  WorkflowDiscoveryConfig,
  WorkflowDiscoveryWithSource,
  WorkflowSource,
  WorkflowWithSource,
} from './workflowDiscovery.js';
export { getWorkflowDescription, type FirstStepInfo, type StepPreview } from './workflowPreview.js';

function resolvePath(pathInput: string, basePath: string): string {
  if (pathInput.startsWith('~')) {
    return resolve(homedir(), pathInput.slice(1).replace(/^\//, ''));
  }
  if (isAbsolute(pathInput)) {
    return pathInput;
  }
  return resolve(basePath, pathInput);
}

function loadWorkflowFromLookupDirs(
  name: string,
  lookupDirs: NamedWorkflowLookupDir[],
  projectCwd: string,
  lookupCwd: string,
  callableArgs?: Record<string, string | string[]>,
  parentTrustInfo?: WorkflowTrustInfo,
  readContext?: InternalWorkflowReadContext,
): WorkflowConfig | null {
  const match = findWorkflowInLookupDirs(name, lookupDirs);
  if (!match) {
    return null;
  }

  return loadWorkflowFileWithResolutionOptions(match.filePath, {
    projectCwd,
    lookupCwd,
    source: match.source,
    callableArgs,
    parentTrustInfo,
    repertoireReadAccess: readContext ? createRepertoireResourceReadAccess(readContext) : undefined,
  });
}

export function listBuiltinWorkflowNames(cwd: string, options?: { includeDisabled?: boolean }): string[] {
  return listBuiltinWorkflowNamesImpl(cwd, options);
}

export function getBuiltinWorkflow(name: string, projectCwd: string): WorkflowConfig | null {
  const yamlPath = getBuiltinWorkflowPath(name, projectCwd);
  if (!yamlPath) {
    return null;
  }
  const workflow = loadWorkflowFileWithResolutionOptions(yamlPath, {
    projectCwd,
    lookupCwd: projectCwd,
    source: 'builtin',
  });
  return finalizeLoadedWorkflow(workflow, projectCwd, projectCwd);
}

function loadWorkflowFromPath(
  filePath: string,
  basePath: string,
  projectCwd: string,
  lookupCwd: string,
  callableArgs?: Record<string, string | string[]>,
  parentTrustInfo?: WorkflowTrustInfo,
  readContext?: InternalWorkflowReadContext,
): WorkflowConfig | null {
  const resolvedPath = resolvePath(filePath, basePath);
  return loadWorkflowFromResolvedPath(
    resolvedPath,
    projectCwd,
    lookupCwd,
    callableArgs,
    parentTrustInfo,
    readContext,
  );
}

function loadWorkflowFromResolvedPath(
  resolvedPath: string,
  projectCwd: string,
  lookupCwd = projectCwd,
  callableArgs?: Record<string, string | string[]>,
  parentTrustInfo?: WorkflowTrustInfo,
  readContext?: InternalWorkflowReadContext,
): WorkflowConfig | null {
  if (!existsSync(resolvedPath)) {
    return null;
  }

  const repertoireReadAccess = readContext
    ? createRepertoireResourceReadAccess(readContext)
    : undefined;
  const repertoirePath = isRepertoireResourcePath(resolvedPath, {
    lang: 'en',
    repertoireDir: readContext?.repertoireDir ?? join(getGlobalConfigDir(), 'repertoire'),
    repertoireReadAccess,
  });
  const stat = lstatSync(resolvedPath);
  if (
    (safeReflectApply(safeStatsIsFileMethod, stat, []) as boolean)
    && stat.nlink !== 1
  ) throw new WorkflowDiscoveryReadError();

  if (repertoirePath) {
    if (readContext === undefined) throw new WorkflowDiscoveryReadError();
    return loadWorkflowApprovedTextWithResolutionOptions(
      resolvedPath,
      readRepertoireWorkflowTextWithReadContext(resolvedPath, readContext),
      {
        projectCwd,
        lookupCwd,
        source: 'repertoire',
        callableArgs,
        parentTrustInfo,
        repertoireReadAccess,
      },
    );
  }

  return loadWorkflowFileWithResolutionOptions(resolvedPath, {
    projectCwd,
    lookupCwd,
    callableArgs,
    parentTrustInfo,
    repertoireReadAccess,
  });
}

function finalizeLoadedWorkflow(
  workflow: WorkflowConfig | null,
  projectCwd: string,
  lookupCwd: string,
  skipWorkflowCallContractValidation = false,
  allowPathBasedCalls = true,
  readContext?: InternalWorkflowReadContext,
): WorkflowConfig | null {
  if (!workflow || skipWorkflowCallContractValidation) {
    return workflow;
  }

  validateWorkflowCallContractsInternal(
    workflow,
    projectCwd,
    lookupCwd,
    { allowPathBasedCalls },
    readContext,
  );
  return workflow;
}

function loadWorkflowForDiscovery(
  entry: WorkflowDirEntry,
  cwd: string,
  readContext?: InternalWorkflowReadContext,
): WorkflowConfig {
  assertEntryRead(entry, readContext);
  const options = {
    projectCwd: cwd,
    lookupCwd: cwd,
    source: entry.source,
    loadMode: 'discovery' as const,
    repertoireReadAccess: readContext ? createRepertoireResourceReadAccess(readContext) : undefined,
  };
  return entry.source === 'repertoire' && readContext !== undefined
    ? loadWorkflowApprovedTextWithResolutionOptions(
      entry.path,
      readRepertoireWorkflowTextWithReadContext(entry.path, readContext),
      options,
    )
    : loadWorkflowFileWithResolutionOptions(entry.path, options);
}

function loadWorkflowForRuntime(
  entry: WorkflowDirEntry,
  cwd: string,
  readContext?: InternalWorkflowReadContext,
): WorkflowConfig {
  assertEntryRead(entry, readContext);
  const options = {
    projectCwd: cwd,
    lookupCwd: cwd,
    source: entry.source,
    repertoireReadAccess: readContext ? createRepertoireResourceReadAccess(readContext) : undefined,
  };
  return entry.source === 'repertoire' && readContext !== undefined
    ? loadWorkflowApprovedTextWithResolutionOptions(
      entry.path,
      readRepertoireWorkflowTextWithReadContext(entry.path, readContext),
      options,
    )
    : loadWorkflowFileWithResolutionOptions(entry.path, options);
}

function validateLoadedWorkflowEntryContracts(
  workflow: WorkflowConfig,
  cwd: string,
  allowPathBasedCalls: boolean,
  readContext?: InternalWorkflowReadContext,
): void {
  validateWorkflowCallContractsInternal(workflow, cwd, cwd, { allowPathBasedCalls }, readContext);
}

function loadValidatedWorkflowEntry(
  entry: WorkflowDirEntry,
  cwd: string,
  readContext?: InternalWorkflowReadContext,
): WorkflowDiscoveryConfig {
  return loadValidatedWorkflowDiscoveryEntry(entry, cwd, {
    loadWorkflowForDiscovery: (candidate, projectCwd) => (
      loadWorkflowForDiscovery(candidate, projectCwd, readContext)
    ),
    validateWorkflowCallContracts: (workflow, projectCwd, options) => {
      validateLoadedWorkflowEntryContracts(
        workflow,
        options?.lookupCwd ?? projectCwd,
        options?.allowPathBasedCalls ?? true,
        readContext,
      );
    },
  });
}

function loadValidatedWorkflowConfigEntry(
  entry: WorkflowDirEntry,
  cwd: string,
  readContext?: InternalWorkflowReadContext,
): WorkflowConfig {
  const workflow = loadWorkflowForRuntime(entry, cwd, readContext);
  validateLoadedWorkflowEntryContracts(workflow, cwd, true, readContext);
  return workflow;
}

function loadValidatedStandaloneWorkflowEntry(
  entry: WorkflowDirEntry,
  cwd: string,
  readContext?: InternalWorkflowReadContext,
): WorkflowDiscoveryConfig {
  return buildWorkflowDiscoveryConfig(loadValidatedWorkflowConfigEntry(entry, cwd, readContext));
}

export function loadWorkflow(name: string, projectCwd: string): WorkflowConfig | null {
  return loadIdentifierWithPermitOnRepertoireAccess(name, projectCwd);
}

export function isWorkflowPath(identifier: string): boolean {
  return (
    identifier.startsWith('/') ||
    identifier.startsWith('~') ||
    identifier.startsWith('./') ||
    identifier.startsWith('../') ||
    identifier.endsWith('.yaml') ||
    identifier.endsWith('.yml')
  );
}

function loadRepertoireWorkflowByRef(
  identifier: string,
  projectCwd: string,
  callableArgs?: Record<string, string | string[]>,
  parentTrustInfo?: WorkflowTrustInfo,
  readContext?: InternalWorkflowReadContext,
): WorkflowConfig | null {
  const scopeRef = parseScopeRef(identifier);
  if (readContext === undefined) throw new WorkflowDiscoveryReadError();
  const ownerDir = join(readContext.repertoireDir, `@${scopeRef.owner}`);
  const packageDir = join(ownerDir, scopeRef.repo);
  const workflowsDir = join(packageDir, 'workflows');
  const assertRead = () => assertActiveRepertoireReadPermit(
    readContext.permit,
    readContext.globalConfigDir,
  );
  if (!assertCanonicalRepertoireDirectory(
    ownerDir,
    join(readContext.repertoireRealPath, `@${scopeRef.owner}`),
    assertRead,
  )) return null;
  if (!assertCanonicalRepertoireDirectory(
    packageDir,
    join(readContext.repertoireRealPath, `@${scopeRef.owner}`, scopeRef.repo),
    assertRead,
  )) return null;
  if (!assertCanonicalRepertoireDirectory(
    workflowsDir,
    join(readContext.repertoireRealPath, `@${scopeRef.owner}`, scopeRef.repo, 'workflows'),
    assertRead,
  )) return null;
  const filePath = resolveWorkflowFileWithReadGuard(workflowsDir, scopeRef.name, assertRead, true);
  const approvedText = filePath
    ? readRepertoireWorkflowTextWithReadContext(filePath, readContext)
    : undefined;
  return filePath
    ? loadWorkflowApprovedTextWithResolutionOptions(filePath, approvedText!, {
      projectCwd,
      lookupCwd: projectCwd,
      source: 'repertoire',
      callableArgs,
      parentTrustInfo,
      repertoireReadAccess: createRepertoireResourceReadAccess(readContext),
    })
    : null;
}

export function validateWorkflowCallContracts(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd = projectCwd,
  options?: { allowPathBasedCalls?: boolean },
): void {
  validateWorkflowCallContractsInternal(workflow, projectCwd, lookupCwd, options);
}

function validateWorkflowCallContractsInternal(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd = projectCwd,
  options?: { allowPathBasedCalls?: boolean },
  readContext?: InternalWorkflowReadContext,
): void {
  validateWorkflowCallContractsImpl(workflow, projectCwd, {
    isWorkflowPath,
    loadWorkflowByIdentifierForWorkflowCall: (identifier, childProjectCwd, childOptions) => (
      loadWorkflowByIdentifierForWorkflowCall(identifier, childProjectCwd, {
        ...childOptions,
        repertoireReadContext: readContext,
      })
    ),
  }, {
    lookupCwd,
    allowPathBasedCalls: options?.allowPathBasedCalls,
  });
}

function loadWorkflowByIdentifierInternal(
  identifier: string,
  projectCwd: string,
  options?: InternalWorkflowLookupOptions,
): WorkflowConfig | null {
  const lookupCwd = options?.lookupCwd ?? projectCwd;
  const basePath = options?.basePath ?? lookupCwd;
  const workflow = isScopeRef(identifier)
    ? loadRepertoireWorkflowByRef(
      identifier,
      projectCwd,
      options?.callableArgs,
      options?.parentTrustInfo,
      options?.repertoireReadContext,
    )
    : isWorkflowPath(identifier)
      ? loadWorkflowFromPath(
        identifier,
        basePath,
        projectCwd,
        lookupCwd,
        options?.callableArgs,
        options?.parentTrustInfo,
        options?.repertoireReadContext,
      )
      : loadWorkflowFromLookupDirs(
        identifier,
        getNamedWorkflowLookupDirs(projectCwd),
        projectCwd,
        lookupCwd,
        options?.callableArgs,
        options?.parentTrustInfo,
        options?.repertoireReadContext,
      );

  return finalizeLoadedWorkflow(
    workflow,
    projectCwd,
    lookupCwd,
    options?.skipWorkflowCallContractValidation === true,
    true,
    options?.repertoireReadContext,
  );
}

export function loadWorkflowByIdentifier(
  identifier: string,
  projectCwd: string,
  options?: WorkflowLookupOptions,
): WorkflowConfig | null {
  const snapshot = snapshotPublicWorkflowLookupOptions(options);
  return isScopeRef(identifier)
    ? loadIdentifierWithImmediatePermit(identifier, projectCwd, snapshot)
    : loadIdentifierWithPermitOnRepertoireAccess(identifier, projectCwd, snapshot);
}

export function loadWorkflowByIdentifierForWorkflowCall(
  identifier: string,
  projectCwd: string,
  options: InternalWorkflowLookupOptions,
): WorkflowConfig | null {
  if (options.repertoireReadContext === undefined) {
    return isScopeRef(identifier)
      ? loadIdentifierWithImmediatePermit(identifier, projectCwd, options)
      : loadIdentifierWithPermitOnRepertoireAccess(identifier, projectCwd, options);
  }
  return loadWorkflowByIdentifierInternal(identifier, projectCwd, options);
}

/** @internal Runtime-only loader for callers already holding one read permit. */
export function loadWorkflowByIdentifierWithReadContext(
  identifier: string,
  projectCwd: string,
  options: WorkflowLookupOptions,
  readContext: InternalWorkflowReadContext,
): WorkflowConfig | null {
  const snapshot = snapshotPublicWorkflowLookupOptions(options);
  return loadWorkflowByIdentifierInternal(identifier, projectCwd, {
    ...snapshot,
    repertoireReadContext: readContext,
  });
}

function loadIdentifierWithPermitOnRepertoireAccess(
  identifier: string,
  projectCwd: string,
  options?: InternalWorkflowLookupOptions | WorkflowLookupOptions,
): WorkflowConfig | null {
  try {
    return loadWorkflowByIdentifierInternal(identifier, projectCwd, options);
  } catch (error) {
    if (!(error instanceof WorkflowDiscoveryReadError)) throw error;
    return loadIdentifierWithImmediatePermit(identifier, projectCwd, options);
  }
}

function loadIdentifierWithImmediatePermit(
  identifier: string,
  projectCwd: string,
  options?: InternalWorkflowLookupOptions | WorkflowLookupOptions,
): WorkflowConfig | null {
  const globalConfigDir = getGlobalConfigDir();
  return withImmediateRepertoireReadPermit({
    globalConfigDir,
    operation: (permit) => loadWorkflowByIdentifierInternal(identifier, projectCwd, {
      ...options,
      repertoireReadContext: createInternalWorkflowReadContext(globalConfigDir, permit),
    }),
  });
}

function snapshotPublicWorkflowLookupOptions(options: unknown): WorkflowLookupOptions {
  if (options === undefined) return safeObjectFreeze(safeObjectCreate(null)) as WorkflowLookupOptions;
  if (
    typeof options !== 'object'
    || options === null
    || safeIsProxy(options)
  ) throw new WorkflowDiscoveryReadError();
  const prototype = safeObjectGetPrototypeOf(options);
  if (prototype !== localObjectPrototype && prototype !== null) throw new WorkflowDiscoveryReadError();
  const keys = safeReflectOwnKeys(options);
  if (keys.length > 2) throw new WorkflowDiscoveryReadError();
  const snapshot = safeObjectCreate(null) as Record<string, string>;
  for (const key of keys) {
    if (typeof key !== 'string' || (key !== 'basePath' && key !== 'lookupCwd')) {
      throw new WorkflowDiscoveryReadError();
    }
    const descriptor = safeObjectGetOwnPropertyDescriptor(options, key);
    if (
      descriptor === undefined
      || !safeObjectHasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string'
    ) throw new WorkflowDiscoveryReadError();
    snapshot[key] = descriptor.value;
  }
  return safeObjectFreeze(snapshot) as WorkflowLookupOptions;
}

export function loadAllWorkflowsWithSources(
  cwd: string,
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowWithSource<WorkflowConfig>> {
  return loadAllWorkflowsWithSourcesFromDirs(
    cwd,
    getWorkflowDirs(cwd),
    options,
    loadValidatedWorkflowConfigEntry,
    true,
  );
}

export function loadAllWorkflowDiscoveryWithSources(
  cwd: string,
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowDiscoveryWithSource> {
  return loadAllWorkflowsWithSourcesFromDirs(
    cwd,
    getWorkflowDirs(cwd),
    options,
    loadValidatedWorkflowEntry,
  );
}

export function loadAllStandaloneWorkflowsWithSources(
  cwd: string,
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowDiscoveryWithSource> {
  return loadAllWorkflowsWithSourcesFromDirs(
    cwd,
    getWorkflowDirs(cwd),
    options,
    loadValidatedStandaloneWorkflowEntry,
  );
}

export function listWorkflowEntries(cwd: string, options?: LoadWorkflowsOptions): WorkflowDirEntry[] {
  return listWorkflowEntriesWithLoader(cwd, options, loadValidatedWorkflowEntry);
}

export function listStandaloneWorkflowEntries(cwd: string, options?: LoadWorkflowsOptions): WorkflowDirEntry[] {
  return listWorkflowEntriesWithLoader(cwd, options, loadValidatedStandaloneWorkflowEntry);
}

function listWorkflowEntriesWithLoader(
  cwd: string,
  options: LoadWorkflowsOptions | undefined,
  loader: typeof loadValidatedWorkflowEntry | typeof loadValidatedStandaloneWorkflowEntry,
): WorkflowDirEntry[] {
  const dirs = getWorkflowDirs(cwd);
  const globalConfigDir = getGlobalConfigDir();
  const warnings: string[] = [];
  const entries = withImmediateRepertoireReadPermit({
    globalConfigDir,
    operation: (permit) => {
      const readContext = createInternalWorkflowReadContext(globalConfigDir, permit);
      const candidates = dirs.flatMap(({ dir, source, disabled }) => (
        Array.from(iterateWorkflowDir(dir, source, disabled))
      ));
      candidates.push(...listRepertoireWorkflowEntriesWithReadContext(readContext));
      return collectValidatedWorkflowEntriesWithReadContext(
        candidates,
        cwd,
        { onWarning: (message) => warnings.push(message) },
        loader,
        false,
        readContext,
      ).map(({ entry }) => entry);
    },
  });
  for (const warning of warnings) options?.onWarning?.(warning);
  return entries;
}

function assertEntryRead(
  entry: WorkflowDirEntry,
  readContext: InternalWorkflowReadContext | undefined,
): void {
  if (entry.source !== 'repertoire') return;
  if (readContext === undefined) throw new WorkflowDiscoveryReadError();
  assertActiveRepertoireReadPermit(readContext.permit, readContext.globalConfigDir);
}

function assertCanonicalRepertoireDirectory(
  path: string,
  expectedRealPath: string,
  assertRead: () => void,
): boolean {
  const before = repertoireLstatOrMissing(path, assertRead);
  if (before === undefined) return false;
  if (!before.isDirectory() || before.isSymbolicLink()) throw new WorkflowDiscoveryReadError();
  assertRead();
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    throw new WorkflowDiscoveryReadError();
  }
  const after = repertoireLstatOrMissing(resolved, assertRead);
  if (
    after === undefined
    || resolved !== expectedRealPath
    || !sameIdentity(before, after)
  ) throw new WorkflowDiscoveryReadError();
  return true;
}

function repertoireLstatOrMissing(path: string, assertRead: () => void): Stats | undefined {
  assertRead();
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new WorkflowDiscoveryReadError();
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT';
}

export function loadAllWorkflows(cwd: string, options?: LoadWorkflowsOptions): Map<string, WorkflowConfig> {
  return new Map(
    Array.from(loadAllWorkflowsWithSources(cwd, options).entries()).map(([name, entry]) => [name, entry.config]),
  );
}

export function loadAllWorkflowDiscovery(
  cwd: string,
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowDiscoveryConfig> {
  return new Map(
    Array.from(loadAllWorkflowDiscoveryWithSources(cwd, options).entries()).map(([name, entry]) => [name, entry.config]),
  );
}

export function loadAllStandaloneWorkflows(
  cwd: string,
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowDiscoveryConfig> {
  return new Map(
    Array.from(loadAllStandaloneWorkflowsWithSources(cwd, options).entries()).map(([name, entry]) => [name, entry.config]),
  );
}

export function listWorkflows(cwd: string, options?: LoadWorkflowsOptions): string[] {
  return listWorkflowEntries(cwd, options).map((entry) => entry.name).sort();
}
