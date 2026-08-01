/** Stable, bounded repertoire reference scanning and owner helpers. */

import { createHash } from 'node:crypto';
import { Stats, lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readApprovedRegularFile } from './filesystem-proof.js';
import { createLogger } from '../../shared/utils/debug.js';

export const REFERENCE_MAX_DEPTH = 24;
export const REFERENCE_MAX_FILES = 4_096;
export const REFERENCE_MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
export const REFERENCE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const log = createLogger('repertoire-remove');
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeStringIncludesMethod = String.prototype.includes;
const safeStringEndsWithMethod = String.prototype.endsWith;
const safeArrayPushMethod = Array.prototype.push;
const safeArraySortMethod = Array.prototype.sort;
const safeArrayJoinMethod = Array.prototype.join;
const safeSetHasMethod = Set.prototype.has;
const safeSetAddMethod = Set.prototype.add;
const safeStatsIsFileMethod = Stats.prototype.isFile;
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const safeBufferToStringMethod = Buffer.prototype.toString;
const safeNumber = Number;

export class RepertoireReferenceScanError extends Error {
  readonly code = 'REFERENCE_SCAN_FAILED' as const;

  constructor() {
    super('Repertoire reference scan could not be completed safely');
    this.name = 'RepertoireReferenceScanError';
  }
}

export interface ScopeReference {
  filePath: string;
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

type ScanBudget = { entries: number; totalBytes: number };

export function findScopeReferences(scope: string, config: ScanConfig): ScopeReference[] {
  const first = scanOnce(scope, config);
  const second = scanOnce(scope, config);
  if (referenceDigest(first) !== referenceDigest(second)) throw new RepertoireReferenceScanError();
  return second;
}

function scanOnce(scope: string, config: ScanConfig): ScopeReference[] {
  const results: ScopeReference[] = [];
  const scannedDirs = new Set<string>();
  const budget: ScanBudget = { entries: 0, totalBytes: 0 };
  const failClosed = config.failClosed ?? false;
  scanConfigured(config.workflowDirs, scope, results, scannedDirs, budget, failClosed);
  scanConfigured(config.providerOptionsDirs, scope, results, scannedDirs, budget, failClosed);
  for (let index = 0; index < config.categoriesFiles.length; index += 1) {
    const filePath = config.categoriesFiles[index]!;
    const stat = checkedLstat(filePath, failClosed);
    if (stat === undefined) continue;
    scanFile(filePath, dirname(filePath), scope, results, budget, failClosed, stat);
  }
  return results;
}

function scanConfigured(
  directories: string[],
  scope: string,
  results: ScopeReference[],
  scanned: Set<string>,
  budget: ScanBudget,
  failClosed: boolean,
): void {
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    if (safeSetHas(scanned, directory)) continue;
    scanDirectory(directory, directory, scope, results, budget, failClosed, 0);
    safeSetAdd(scanned, directory);
  }
}

function scanDirectory(
  directory: string,
  scanRoot: string,
  scope: string,
  results: ScopeReference[],
  budget: ScanBudget,
  failClosed: boolean,
  depth: number,
): void {
  if (depth > REFERENCE_MAX_DEPTH) return handleFailure(failClosed);
  const directoryStat = checkedLstat(directory, failClosed);
  if (directoryStat === undefined) return;
  if (!isDirectory(directoryStat) || isSymbolicLink(directoryStat)) return handleFailure(failClosed);
  const before = checkedReadDirectory(directory, failClosed);
  if (before === undefined) return;
  // Non-YAML names still consume filesystem work and must not bypass limits.
  budget.entries += before.length;
  if (budget.entries > REFERENCE_MAX_FILES) return handleFailure(failClosed);
  safeArraySort(before);
  for (let index = 0; index < before.length; index += 1) {
    const entry = before[index]!;
    const path = join(directory, entry);
    const stat = checkedLstat(path, failClosed);
    if (stat === undefined) return handleFailure(failClosed);
    if (isDirectory(stat) && !isSymbolicLink(stat)) {
      scanDirectory(path, scanRoot, scope, results, budget, failClosed, depth + 1);
      continue;
    }
    if (!safeStringEndsWith(entry, '.yaml') && !safeStringEndsWith(entry, '.yml')) continue;
    scanFile(path, scanRoot, scope, results, budget, failClosed, stat);
  }
  const after = checkedReadDirectory(directory, failClosed);
  const freshDirectory = checkedLstat(directory, failClosed);
  if (after === undefined || freshDirectory === undefined) return handleFailure(failClosed);
  safeArraySort(after);
  if (
    safeArrayJoin(before, '\0') !== safeArrayJoin(after, '\0')
    || directoryStat.dev !== freshDirectory.dev
    || directoryStat.ino !== freshDirectory.ino
    || directoryStat.mtimeMs !== freshDirectory.mtimeMs
    || directoryStat.ctimeMs !== freshDirectory.ctimeMs
  ) handleFailure(failClosed);
}

function scanFile(
  filePath: string,
  scanRoot: string,
  scope: string,
  results: ScopeReference[],
  budget: ScanBudget,
  failClosed: boolean,
  initial: NonNullable<ReturnType<typeof lstatSync>>,
): void {
  if (!isFile(initial) || isSymbolicLink(initial) || initial.nlink !== 1) return handleFailure(failClosed);
  try {
    const approved = readApprovedRegularFile(filePath, scanRoot);
    if (approved.bytes.length > REFERENCE_MAX_SINGLE_FILE_BYTES) return handleFailure(failClosed);
    budget.totalBytes += approved.bytes.length;
    if (budget.totalBytes > REFERENCE_MAX_TOTAL_BYTES) return handleFailure(failClosed);
    const content = safeBufferToString(approved.bytes, 'utf8');
    if (safeStringIncludes(content, scope)) {
      safeArrayPush(results, {
        filePath,
        dev: safeNumber(approved.proof.dev),
        ino: safeNumber(approved.proof.ino),
        contentDigest: approved.proof.digest,
      });
    }
  } catch {
    handleFailure(failClosed);
  }
}

function checkedLstat(path: string, failClosed: boolean): NonNullable<ReturnType<typeof lstatSync>> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    handleFailure(failClosed);
    return undefined;
  }
}

function checkedReadDirectory(path: string, failClosed: boolean): string[] | undefined {
  try {
    return readdirSync(path);
  } catch {
    handleFailure(failClosed);
    return undefined;
  }
}

function handleFailure(failClosed: boolean): void {
  log.debug('Repertoire reference scan failed');
  if (failClosed) throw new RepertoireReferenceScanError();
}

function referenceDigest(refs: ScopeReference[]): string {
  const records: string[] = [];
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index]!;
    records[index] = `${ref.filePath}\0${ref.dev ?? '-'}\0${ref.ino ?? '-'}\0${ref.contentDigest ?? '-'}`;
  }
  safeArraySort(records);
  return createHash('sha256').update(safeArrayJoin(records, '\0')).digest('hex');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function isFile(stat: NonNullable<ReturnType<typeof lstatSync>>): boolean {
  return safeReflectApply(safeStatsIsFileMethod, stat, []) as boolean;
}

function isDirectory(stat: NonNullable<ReturnType<typeof lstatSync>>): boolean {
  return safeReflectApply(safeStatsIsDirectoryMethod, stat, []) as boolean;
}

function isSymbolicLink(stat: NonNullable<ReturnType<typeof lstatSync>>): boolean {
  return safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, []) as boolean;
}

function safeStringIncludes(value: string, search: string): boolean {
  return safeReflectApply(safeStringIncludesMethod, value, [search]) as boolean;
}

function safeStringEndsWith(value: string, search: string): boolean {
  return safeReflectApply(safeStringEndsWithMethod, value, [search]) as boolean;
}

function safeArrayPush<T>(values: T[], value: T): void {
  safeReflectApply(safeArrayPushMethod, values, [value]);
}

function safeArraySort(values: string[]): string[] {
  return safeReflectApply(safeArraySortMethod, values, []) as string[];
}

function safeArrayJoin(values: string[], separator: string): string {
  return safeReflectApply(safeArrayJoinMethod, values, [separator]) as string;
}

function safeSetHas(values: Set<string>, value: string): boolean {
  return safeReflectApply(safeSetHasMethod, values, [value]) as boolean;
}

function safeSetAdd(values: Set<string>, value: string): void {
  safeReflectApply(safeSetAddMethod, values, [value]);
}

function safeBufferToString(value: Buffer, encoding: BufferEncoding): string {
  return safeReflectApply(safeBufferToStringMethod, value, [encoding]) as string;
}

export function shouldRemoveOwnerDir(ownerDir: string, repoBeingRemoved: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(ownerDir);
  } catch (error) {
    if (isMissing(error)) return false;
    return false;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry === repoBeingRemoved) continue;
    try {
      if (safeReflectApply(safeStatsIsDirectoryMethod, statSync(join(ownerDir, entry)), [])) return false;
    } catch {
      return false;
    }
  }
  return true;
}
