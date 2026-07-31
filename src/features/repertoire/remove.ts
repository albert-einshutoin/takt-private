/** Repertoire reference scanning and owner-directory helpers. */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../shared/utils/debug.js';

const log = createLogger('repertoire-remove');

// Reference scanning is an authorization boundary for package removal. Capture
// mutable intrinsics before plugins can poison their prototypes at runtime.
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeStringIncludesMethod = String.prototype.includes;
const safeStringEndsWithMethod = String.prototype.endsWith;
const safeArrayPushMethod = Array.prototype.push;
const safeArraySortMethod = Array.prototype.sort;
const safeSetHasMethod = Set.prototype.has;
const safeSetAddMethod = Set.prototype.add;
const safeNumber = Number;
const safeStringIncludes = (value: string, search: string): boolean => (
  safeReflectApply(safeStringIncludesMethod, value, [search]) as boolean
);
const safeStringEndsWith = (value: string, search: string): boolean => (
  safeReflectApply(safeStringEndsWithMethod, value, [search]) as boolean
);
const safeArrayPush = <T>(values: T[], value: T): void => {
  safeReflectApply(safeArrayPushMethod, values, [value]);
};
const safeArraySort = (values: string[]): string[] => (
  safeReflectApply(safeArraySortMethod, values, []) as string[]
);
const safeSetHas = (values: Set<string>, value: string): boolean => (
  safeReflectApply(safeSetHasMethod, values, [value]) as boolean
);
const safeSetAdd = (values: Set<string>, value: string): void => {
  safeReflectApply(safeSetAddMethod, values, [value]);
};

export class RepertoireReferenceScanError extends Error {
  readonly code = 'REFERENCE_SCAN_FAILED' as const;

  constructor() {
    super('Repertoire reference scan could not be completed safely');
    this.name = 'RepertoireReferenceScanError';
  }
}

export interface ScopeReference {
  filePath: string;
  /** Fresh file identity and bytes proof used by removal authorization. */
  dev?: number;
  ino?: number;
  contentDigest?: string;
}

export interface ScanConfig {
  workflowDirs: string[];
  providerOptionsDirs: string[];
  categoriesFiles: string[];
  failClosed?: boolean;
}

export function findScopeReferences(scope: string, config: ScanConfig): ScopeReference[] {
  const results: ScopeReference[] = [];
  const scannedDirs = new Set<string>();
  const failClosed = config.failClosed ?? false;

  scanConfiguredDirectories(config.workflowDirs, scope, results, scannedDirs, failClosed);
  scanConfiguredDirectories(config.providerOptionsDirs, scope, results, scannedDirs, failClosed);
  for (let index = 0; index < config.categoriesFiles.length; index += 1) {
    const filePath = config.categoriesFiles[index]!;
    if (!checkedExists(filePath, failClosed)) continue;
    scanReferenceFile(filePath, scope, results, failClosed);
  }
  return results;
}

function scanConfiguredDirectories(
  directories: string[],
  scope: string,
  results: ScopeReference[],
  scannedDirs: Set<string>,
  failClosed: boolean,
): void {
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    if (safeSetHas(scannedDirs, directory)) continue;
    scanYamlFilesInDir(directory, scope, results, failClosed);
    safeSetAdd(scannedDirs, directory);
  }
}

function scanYamlFilesInDir(
  directory: string,
  scope: string,
  results: ScopeReference[],
  failClosed: boolean,
): void {
  if (!checkedExists(directory, failClosed)) return;
  const entries = checkedReadDirectory(directory, failClosed);
  if (entries === undefined) return;
  safeArraySort(entries);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const filePath = join(directory, entry);
    const stats = checkedLstat(filePath, failClosed);
    if (stats === undefined) continue;
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      scanYamlFilesInDir(filePath, scope, results, failClosed);
      continue;
    }
    if (
      !safeStringEndsWith(entry, '.yaml')
      && !safeStringEndsWith(entry, '.yml')
    ) continue;
    scanReferenceFile(filePath, scope, results, failClosed, stats);
  }
}

function scanReferenceFile(
  filePath: string,
  scope: string,
  results: ScopeReference[],
  failClosed: boolean,
  initial = checkedLstat(filePath, failClosed),
): void {
  if (initial === undefined) return;
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) {
    handleScanFailure(failClosed);
    return;
  }
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    handleScanFailure(failClosed);
    return;
  }
  const fresh = checkedLstat(filePath, failClosed);
  if (
    fresh === undefined
    || !fresh.isFile()
    || fresh.isSymbolicLink()
    || fresh.nlink !== 1
    || fresh.dev !== initial.dev
    || fresh.ino !== initial.ino
    || fresh.size !== initial.size
    || fresh.mtimeMs !== initial.mtimeMs
    || fresh.ctimeMs !== initial.ctimeMs
  ) {
    handleScanFailure(failClosed);
    return;
  }
  if (safeStringIncludes(content, scope)) {
    safeArrayPush(results, {
      filePath,
      dev: safeNumber(fresh.dev),
      ino: safeNumber(fresh.ino),
      contentDigest: createHash('sha256').update(content).digest('hex'),
    });
  }
}

function checkedExists(path: string, failClosed: boolean): boolean {
  try {
    return existsSync(path);
  } catch {
    handleScanFailure(failClosed);
    return false;
  }
}

function checkedReadDirectory(path: string, failClosed: boolean): string[] | undefined {
  try {
    return readdirSync(path);
  } catch {
    handleScanFailure(failClosed);
    return undefined;
  }
}

function checkedLstat(
  path: string,
  failClosed: boolean,
): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    handleScanFailure(failClosed);
    return undefined;
  }
}

function handleScanFailure(failClosed: boolean): void {
  // Never disclose path, raw error, or cause through authorization diagnostics.
  log.debug('Repertoire reference scan failed');
  if (failClosed) throw new RepertoireReferenceScanError();
}

export function shouldRemoveOwnerDir(ownerDir: string, repoBeingRemoved: string): boolean {
  if (!existsSync(ownerDir)) return false;
  const entries = readdirSync(ownerDir);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry === repoBeingRemoved) continue;
    try {
      if (statSync(join(ownerDir, entry)).isDirectory()) return false;
    } catch {
      log.debug('Repertoire owner inspection failed');
    }
  }
  return true;
}
