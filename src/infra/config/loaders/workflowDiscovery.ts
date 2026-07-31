import { Stats, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { getGlobalConfigDir } from '../paths.js';
import { formatWorkflowLoadWarning } from './workflowLoadWarning.js';
import { isMissingWorkflowCallArgError } from './workflowCallableArgResolver.js';
import {
  loadWorkflowApprovedTextWithResolutionOptions,
  loadWorkflowFileWithResolutionOptions,
} from './workflowResolvedLoader.js';
import type { WorkflowConfig } from '../../../core/models/index.js';
import {
  assertActiveRepertoireReadPermit,
  withImmediateRepertoireReadPermit,
  type RepertoireReadPermit,
} from '../../../features/repertoire/read-permit.js';
import { WorkflowDiscoveryReadError } from './workflowDiscoveryError.js';
import { readApprovedRepertoireWorkflowText } from './workflowRepertoireSafeReader.js';

const log = createLogger('workflow-discovery');

export { WorkflowDiscoveryReadError } from './workflowDiscoveryError.js';

/** @internal Authority threaded only while repertoire material is read. */
export interface InternalWorkflowReadContext {
  readonly globalConfigDir: string;
  readonly permit: RepertoireReadPermit;
  readonly repertoireDir: string;
  readonly repertoireRealPath: string;
}

export type WorkflowSource = 'builtin' | 'user' | 'project' | 'repertoire';

export interface WorkflowDirEntry {
  name: string;
  path: string;
  category?: string;
  source: WorkflowSource;
}

export interface WorkflowDiscoveryConfig {
  name: string;
  description?: string;
  subworkflow?: WorkflowConfig['subworkflow'];
}

export interface WorkflowWithSource<Config extends WorkflowConfig | WorkflowDiscoveryConfig = WorkflowDiscoveryConfig> {
  config: Config;
  source: WorkflowSource;
}

export type WorkflowDiscoveryWithSource = WorkflowWithSource<WorkflowDiscoveryConfig>;

interface LoadWorkflowsOptions {
  onWarning?: (message: string) => void;
}

interface WorkflowLookupDir {
  dir: string;
  source: WorkflowSource;
  disabled?: string[];
}

interface ValidatedWorkflowEntry<Config extends WorkflowConfig | WorkflowDiscoveryConfig> {
  entry: WorkflowDirEntry;
  config: Config;
}

type WorkflowEntryLoader<Config extends WorkflowConfig | WorkflowDiscoveryConfig> = (
  entry: WorkflowDirEntry,
  cwd: string,
  readContext?: InternalWorkflowReadContext,
) => Config;

function isHiddenInternalWorkflow(config: Pick<WorkflowConfig, 'subworkflow'>): boolean {
  return config.subworkflow?.visibility === 'internal';
}

function isHiddenInternalCallableWorkflowMetadata(
  filePath: string,
  source: WorkflowSource,
  readContext?: InternalWorkflowReadContext,
): boolean {
  let text: string;
  try {
    assertRepertoireRead(source, readContext);
    text = source === 'repertoire' && readContext !== undefined
      ? readRepertoireWorkflowTextWithReadContext(filePath, readContext)
      : readFileSync(filePath, 'utf-8');
  } catch {
    throw discoveryReadFailed();
  }
  try {
    const raw = parseYaml(text);
    if (typeof raw !== 'object' || raw === null) {
      return false;
    }

    const subworkflow = (raw as {
      subworkflow?: {
        callable?: unknown;
        visibility?: unknown;
      };
    }).subworkflow;
    return subworkflow?.callable === true && subworkflow.visibility === 'internal';
  } catch {
    return false;
  }
}

function shouldSuppressHiddenInternalWorkflowWarning(
  entry: WorkflowDirEntry,
  error: unknown,
  readContext?: InternalWorkflowReadContext,
): boolean {
  if (!isMissingWorkflowCallArgError(error)) return false;
  return isHiddenInternalCallableWorkflowMetadata(
    entry.path,
    entry.source,
    entry.source === 'repertoire' ? readContext : undefined,
  );
}

function emitWorkflowLoadWarning(options: LoadWorkflowsOptions | undefined, workflowName: string, error: unknown): void {
  if (options?.onWarning) {
    options.onWarning(formatWorkflowLoadWarning(workflowName, error));
  }
}

function loadWorkflowEntry(
  entry: WorkflowDirEntry,
  cwd: string,
  readContext?: InternalWorkflowReadContext,
): WorkflowConfig {
  const options = {
    projectCwd: cwd,
    lookupCwd: cwd,
    source: entry.source,
    loadMode: 'discovery' as const,
  };
  return entry.source === 'repertoire' && readContext !== undefined
    ? loadWorkflowApprovedTextWithResolutionOptions(
      entry.path,
      readRepertoireWorkflowTextWithReadContext(entry.path, readContext),
      options,
    )
    : loadWorkflowFileWithResolutionOptions(entry.path, options);
}

export function* iterateWorkflowDir(
  dir: string,
  source: WorkflowSource,
  disabled?: string[],
): Generator<WorkflowDirEntry> {
  const rootStat = statOrMissing(dir);
  if (rootStat === undefined) return;
  if (!rootStat.isDirectory()) throw discoveryReadFailed();
  for (const entry of readDirectory(dir)) {
    const entryPath = join(dir, entry);
    const stat = statRequired(entryPath);
    if (stat.isFile() && (entry.endsWith('.yaml') || entry.endsWith('.yml'))) {
      const name = entry.replace(/\.ya?ml$/, '');
      if (!disabled?.includes(name)) {
        yield { name, path: entryPath, source };
      }
      continue;
    }
    if (!stat.isDirectory() || entry === 'provider-options') continue;
    for (const subEntry of readDirectory(entryPath)) {
      if (!subEntry.endsWith('.yaml') && !subEntry.endsWith('.yml')) continue;
      const subEntryPath = join(entryPath, subEntry);
      if (!statRequired(subEntryPath).isFile()) continue;
      const qualifiedName = `${entry}/${subEntry.replace(/\.ya?ml$/, '')}`;
      if (!disabled?.includes(qualifiedName)) {
        yield { name: qualifiedName, path: subEntryPath, category: entry, source };
      }
    }
  }
}

export function listWorkflowNamesInDir(
  dir: string,
  source: WorkflowSource,
  disabled?: string[],
): string[] {
  return Array.from(iterateWorkflowDir(dir, source, disabled)).map((entry) => entry.name);
}

export function listBuiltinWorkflowNamesForDir(
  dir: string,
  disabled?: string[],
): string[] {
  return listWorkflowNamesInDir(dir, 'builtin', disabled);
}

function* iterateRepertoireWorkflows(
  readContext: InternalWorkflowReadContext,
): Generator<WorkflowDirEntry> {
  const repertoireDir = readContext.repertoireDir;
  const rootStat = validateCanonicalRepertoireDirectory(
    repertoireDir,
    readContext.repertoireRealPath,
    readContext,
  );
  if (rootStat === undefined) return;
  const rootEntries = readRepertoireDirectory(repertoireDir, readContext);
  for (const ownerEntry of rootEntries) {
    if (!ownerEntry.startsWith('@')) continue;
    const ownerPath = join(repertoireDir, ownerEntry);
    const ownerStat = validateCanonicalRepertoireDirectory(
      ownerPath,
      join(readContext.repertoireRealPath, ownerEntry),
      readContext,
    );
    if (ownerStat === undefined) throw discoveryReadFailed();
    const ownerEntries = readRepertoireDirectory(ownerPath, readContext);
    for (const repoEntry of ownerEntries) {
      const repoPath = join(ownerPath, repoEntry);
      const workflowsDir = join(repoPath, 'workflows');
      const repoStat = validateCanonicalRepertoireDirectory(
        repoPath,
        join(readContext.repertoireRealPath, ownerEntry, repoEntry),
        readContext,
      );
      if (repoStat === undefined) throw discoveryReadFailed();
      const workflowsStat = validateCanonicalRepertoireDirectory(
        workflowsDir,
        join(readContext.repertoireRealPath, ownerEntry, repoEntry, 'workflows'),
        readContext,
      );
      if (workflowsStat === undefined) continue;
      const workflowEntries = readRepertoireDirectory(workflowsDir, readContext);
      for (const workflowFile of workflowEntries) {
        if (!workflowFile.endsWith('.yaml') && !workflowFile.endsWith('.yml')) continue;
        const workflowPath = join(workflowsDir, workflowFile);
        validateCanonicalRepertoireFile(
          workflowPath,
          join(readContext.repertoireRealPath, ownerEntry, repoEntry, 'workflows', workflowFile),
          readContext,
        );
        yield {
          name: `@${ownerEntry.slice(1)}/${repoEntry}/${workflowFile.replace(/\.ya?ml$/, '')}`,
          path: workflowPath,
          source: 'repertoire',
        };
      }
      assertRepertoireDirectoryUnchanged(workflowsDir, workflowEntries, workflowsStat, readContext);
    }
    assertRepertoireDirectoryUnchanged(ownerPath, ownerEntries, ownerStat, readContext);
  }
  assertRepertoireDirectoryUnchanged(repertoireDir, rootEntries, rootStat, readContext);
}

export function listRepertoireWorkflowEntries(): WorkflowDirEntry[] {
  const globalConfigDir = getGlobalConfigDir();
  return withImmediateRepertoireReadPermit({
    globalConfigDir,
    operation: (permit) => listRepertoireWorkflowEntriesWithReadContext(
      createInternalWorkflowReadContext(globalConfigDir, permit),
    ),
  });
}

/** @internal Avoids nested lease acquisition during one discovery transaction. */
export function listRepertoireWorkflowEntriesWithReadContext(
  readContext: InternalWorkflowReadContext,
): WorkflowDirEntry[] {
  return Array.from(iterateRepertoireWorkflows(readContext));
}

export function collectValidatedWorkflowEntries<Config extends WorkflowConfig | WorkflowDiscoveryConfig>(
  entries: Iterable<WorkflowDirEntry>,
  cwd: string,
  options?: LoadWorkflowsOptions,
  workflowEntryLoader: WorkflowEntryLoader<Config> = loadWorkflowEntry as WorkflowEntryLoader<Config>,
  includeInternalWorkflows = false,
): ValidatedWorkflowEntry<Config>[] {
  return collectValidatedWorkflowEntriesWithReadContext(
    entries,
    cwd,
    options,
    workflowEntryLoader,
    includeInternalWorkflows,
  );
}

/** @internal Materializes repertoire entries under an ambient permit. */
export function collectValidatedWorkflowEntriesWithReadContext<Config extends WorkflowConfig | WorkflowDiscoveryConfig>(
  entries: Iterable<WorkflowDirEntry>,
  cwd: string,
  options?: LoadWorkflowsOptions,
  workflowEntryLoader: WorkflowEntryLoader<Config> = loadWorkflowEntry as WorkflowEntryLoader<Config>,
  includeInternalWorkflows = false,
  readContext?: InternalWorkflowReadContext,
): ValidatedWorkflowEntry<Config>[] {
  const validatedEntries = new Map<string, ValidatedWorkflowEntry<Config>>();
  for (const entry of entries) {
    try {
      assertRepertoireRead(entry.source, readContext);
      if (entry.source === 'repertoire' && readContext !== undefined) {
        assertRepertoireEntryPath(entry, readContext);
      }
      const config = workflowEntryLoader(entry, cwd, readContext);
      if (!includeInternalWorkflows && isHiddenInternalWorkflow(config)) {
        continue;
      }
      validatedEntries.set(entry.name, { entry, config });
    } catch (error) {
      if (error instanceof WorkflowDiscoveryReadError) throw error;
      log.debug('Skipping invalid workflow file', { path: entry.path, error: getErrorMessage(error) });
      if (shouldSuppressHiddenInternalWorkflowWarning(entry, error, readContext)) {
        continue;
      }
      emitWorkflowLoadWarning(options, entry.name, error);
    }
  }
  return Array.from(validatedEntries.values());
}

export function loadAllWorkflowsWithSourcesFromDirs<Config extends WorkflowConfig | WorkflowDiscoveryConfig>(
  cwd: string,
  dirs: WorkflowLookupDir[],
  options?: LoadWorkflowsOptions,
  workflowEntryLoader: WorkflowEntryLoader<Config> = loadWorkflowEntry as WorkflowEntryLoader<Config>,
  includeInternalWorkflows = false,
): Map<string, WorkflowWithSource<Config>> {
  const globalConfigDir = getGlobalConfigDir();
  const warnings: string[] = [];
  const workflows = withImmediateRepertoireReadPermit({
    globalConfigDir,
    operation: (permit) => loadAllWorkflowsWithSourcesFromDirsWithReadContext(
      cwd,
      dirs,
      { onWarning: (message) => warnings.push(message) },
      workflowEntryLoader,
      includeInternalWorkflows,
      createInternalWorkflowReadContext(globalConfigDir, permit),
    ),
  });
  for (const warning of warnings) options?.onWarning?.(warning);
  return workflows;
}

/** @internal Performs discovery under an already-active global read permit. */
export function loadAllWorkflowsWithSourcesFromDirsWithReadContext<Config extends WorkflowConfig | WorkflowDiscoveryConfig>(
  cwd: string,
  dirs: WorkflowLookupDir[],
  options: LoadWorkflowsOptions | undefined,
  workflowEntryLoader: WorkflowEntryLoader<Config>,
  includeInternalWorkflows: boolean,
  readContext: InternalWorkflowReadContext,
): Map<string, WorkflowWithSource<Config>> {
  const workflows = new Map<string, WorkflowWithSource<Config>>();
  const entries = dirs.flatMap(({ dir, source, disabled }) => Array.from(iterateWorkflowDir(dir, source, disabled)));
  entries.push(...Array.from(iterateRepertoireWorkflows(readContext)));
  for (const { entry, config } of collectValidatedWorkflowEntriesWithReadContext(
    entries,
    cwd,
    options,
    workflowEntryLoader,
    includeInternalWorkflows,
    readContext,
  )) {
    workflows.set(entry.name, { config, source: entry.source });
  }
  return workflows;
}

function assertRepertoireRead(
  source: WorkflowSource | 'repertoire',
  readContext: InternalWorkflowReadContext | undefined,
): void {
  if (source !== 'repertoire') return;
  if (readContext === undefined) throw discoveryReadFailed();
  assertActiveRepertoireReadPermit(readContext.permit, readContext.globalConfigDir);
}

function assertRepertoireEntryPath(
  entry: WorkflowDirEntry,
  readContext: InternalWorkflowReadContext,
): void {
  const relativePath = relative(readContext.repertoireDir, entry.path);
  const segments = relativePath.split(sep);
  if (
    relativePath.startsWith('..')
    || isAbsolute(relativePath)
    || segments.length !== 4
    || !segments[0]?.startsWith('@')
    || segments[2] !== 'workflows'
  ) throw discoveryReadFailed();
  validateCanonicalRepertoireFile(entry.path, join(readContext.repertoireRealPath, ...segments), readContext);
}

/** @internal Reads approved repertoire YAML bytes exactly once for parsing. */
export function readRepertoireWorkflowTextWithReadContext(
  path: string,
  readContext: InternalWorkflowReadContext,
): string {
  const relativePath = relative(readContext.repertoireDir, path);
  const segments = relativePath.split(sep);
  if (
    relativePath.startsWith('..')
    || isAbsolute(relativePath)
    || segments.length !== 4
    || !segments[0]?.startsWith('@')
    || segments[2] !== 'workflows'
    || (!segments[3]?.endsWith('.yaml') && !segments[3]?.endsWith('.yml'))
  ) throw discoveryReadFailed();
  return readApprovedRepertoireWorkflowText({
    assertRead: () => assertRepertoireRead('repertoire', readContext),
    expectedRealPath: join(readContext.repertoireRealPath, ...segments),
    path,
    repertoireDir: readContext.repertoireDir,
  });
}

/** @internal Establishes canonical global/repertoire identity under the lease. */
export function createInternalWorkflowReadContext(
  globalConfigDir: string,
  permit: RepertoireReadPermit,
): InternalWorkflowReadContext {
  const assertAuthority = () => assertActiveRepertoireReadPermit(permit, globalConfigDir);
  assertAuthority();
  if (!isAbsolute(globalConfigDir) || resolve(globalConfigDir) !== globalConfigDir) {
    throw discoveryReadFailed();
  }
  const globalBefore = repertoireLstatRequired(globalConfigDir);
  if (!globalBefore.isDirectory() || globalBefore.isSymbolicLink()) throw discoveryReadFailed();
  assertAuthority();
  const globalRealPath = realpathSync(globalConfigDir);
  assertAuthority();
  const globalAfter = repertoireLstatRequired(globalRealPath);
  if (!sameIdentity(globalBefore, globalAfter)) throw discoveryReadFailed();
  const repertoireDir = join(globalConfigDir, 'repertoire');
  const repertoireRealPath = join(globalRealPath, 'repertoire');
  assertAuthority();
  const repertoireBefore = repertoireLstatOrMissing(repertoireDir);
  if (repertoireBefore !== undefined) {
    if (!repertoireBefore.isDirectory() || repertoireBefore.isSymbolicLink()) {
      throw discoveryReadFailed();
    }
    assertAuthority();
    const resolvedRepertoire = realpathSync(repertoireDir);
    assertAuthority();
    const repertoireAfter = repertoireLstatRequired(resolvedRepertoire);
    if (
      resolvedRepertoire !== repertoireRealPath
      || !sameIdentity(repertoireBefore, repertoireAfter)
    ) throw discoveryReadFailed();
  }
  return { globalConfigDir, permit, repertoireDir, repertoireRealPath };
}

function statOrMissing(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw discoveryReadFailed();
  }
}

function statRequired(path: string): Stats {
  const stat = statOrMissing(path);
  if (stat === undefined) throw discoveryReadFailed();
  return stat;
}

function repertoireLstatOrMissing(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw discoveryReadFailed();
  }
}

function repertoireLstatRequired(path: string): Stats {
  const stat = repertoireLstatOrMissing(path);
  if (stat === undefined) throw discoveryReadFailed();
  return stat;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateCanonicalRepertoireDirectory(
  path: string,
  expectedRealPath: string,
  readContext: InternalWorkflowReadContext,
): Stats | undefined {
  assertRepertoireRead('repertoire', readContext);
  const before = repertoireLstatOrMissing(path);
  if (before === undefined) return undefined;
  if (!before.isDirectory() || before.isSymbolicLink()) throw discoveryReadFailed();
  assertRepertoireRead('repertoire', readContext);
  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch {
    throw discoveryReadFailed();
  }
  assertRepertoireRead('repertoire', readContext);
  const after = repertoireLstatRequired(realPath);
  if (realPath !== expectedRealPath || !sameWorkflowIdentity(before, after)) throw discoveryReadFailed();
  return after;
}

function validateCanonicalRepertoireFile(
  path: string,
  expectedRealPath: string,
  readContext: InternalWorkflowReadContext,
): void {
  assertRepertoireRead('repertoire', readContext);
  const before = repertoireLstatRequired(path);
  if (!before.isFile() || before.isSymbolicLink()) throw discoveryReadFailed();
  assertRepertoireRead('repertoire', readContext);
  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch {
    throw discoveryReadFailed();
  }
  assertRepertoireRead('repertoire', readContext);
  const after = repertoireLstatRequired(realPath);
  if (realPath !== expectedRealPath || !sameWorkflowIdentity(before, after)) throw discoveryReadFailed();
}

function readRepertoireDirectory(path: string, readContext: InternalWorkflowReadContext): string[] {
  assertRepertoireRead('repertoire', readContext);
  return readDirectory(path).sort();
}

function assertRepertoireDirectoryUnchanged(
  path: string,
  expectedEntries: string[],
  expectedStat: Stats,
  readContext: InternalWorkflowReadContext,
): void {
  const actualEntries = readRepertoireDirectory(path, readContext);
  assertRepertoireRead('repertoire', readContext);
  const actualStat = repertoireLstatRequired(path);
  if (
    expectedEntries.join('\0') !== actualEntries.join('\0')
    || !sameWorkflowIdentity(expectedStat, actualStat)
  ) throw discoveryReadFailed();
}

function sameWorkflowIdentity(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    throw discoveryReadFailed();
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT';
}

function discoveryReadFailed(): WorkflowDiscoveryReadError {
  return new WorkflowDiscoveryReadError();
}
