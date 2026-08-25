/**
 * File filtering for repertoire package copy operations.
 *
 * Security constraints:
 * - Only .md, .yaml, .yml files are copied
 * - Only files under facets/, workflows/, or provider-options/ top-level directories are copied
 * - Symbolic links are skipped (lstat check)
 * - Files exceeding MAX_FILE_SIZE (1 MB) are skipped
 * - Packages with more than MAX_FILE_COUNT files throw an error
 */

import { Stats, lstatSync, readdirSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { createLogger } from '../../shared/utils/debug.js';

const log = createLogger('repertoire-file-filter');
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeArrayIncludesMethod = Array.prototype.includes;
const safeArrayPushMethod = Array.prototype.push;
const safeArraySortMethod = Array.prototype.sort;
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const safeArrayIncludes = <T>(values: readonly T[], value: T): boolean => (
  safeReflectApply(safeArrayIncludesMethod, values, [value]) as boolean
);
const safeArrayPush = <T>(values: T[], value: T): void => {
  safeReflectApply(safeArrayPushMethod, values, [value]);
};
const safeArraySort = (values: string[]): string[] => (
  safeReflectApply(safeArraySortMethod, values, []) as string[]
);

/** Allowed file extensions for repertoire package files. */
export const ALLOWED_EXTENSIONS = ['.md', '.yaml', '.yml'] as const;

/** Top-level directories that are copied from a package. */
export const ALLOWED_DIRS = ['facets', 'workflows', 'provider-options'] as const;

/** Maximum single file size in bytes (1 MB). */
export const MAX_FILE_SIZE = 1024 * 1024;

/** Maximum total file count per package. */
export const MAX_FILE_COUNT = 500;

export interface CopyTarget {
  /** Absolute path to the source file. */
  absolutePath: string;
  /** Relative path from the package root (e.g. "facets/personas/coder.md"). */
  relativePath: string;
}

/**
 * Check if a filename has an allowed extension.
 */
export function isAllowedExtension(filename: string): boolean {
  const ext = extname(filename);
  return safeArrayIncludes(ALLOWED_EXTENSIONS, ext);
}

/**
 * Determine whether a single file should be copied.
 *
 * @param filePath - absolute path to the file
 * @param stats    - result of lstat(filePath)
 */
function shouldCopyFile(
  filePath: string,
  stats: Stats,
): boolean {
  if (stats.size > MAX_FILE_SIZE) return false;
  if (!isAllowedExtension(filePath)) return false;
  return true;
}

/**
 * Recursively collect files eligible for copying from within a directory.
 * Used internally by collectCopyTargets.
 */
function collectFromDir(
  dir: string,
  packageRoot: string,
  targets: CopyTarget[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir, 'utf-8');
    safeArraySort(entries);
  } catch (err) {
    log.debug('Failed to read directory', { dir, err });
    return;
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (targets.length >= MAX_FILE_COUNT) {
      throw new Error(
        `Package exceeds maximum file count of ${MAX_FILE_COUNT}`,
      );
    }

    const absolutePath = join(dir, entry);
    const stats = lstatSync(absolutePath);

    if (safeReflectApply(safeStatsIsSymbolicLinkMethod, stats, [])) continue;

    if (safeReflectApply(safeStatsIsDirectoryMethod, stats, [])) {
      collectFromDir(absolutePath, packageRoot, targets);
      continue;
    }

    if (!shouldCopyFile(absolutePath, stats)) continue;

    safeArrayPush(targets, {
      absolutePath,
      relativePath: relative(packageRoot, absolutePath),
    });
  }
}

/**
 * Collect all files to copy from a package root directory.
 *
 * Only files under allowed top-level directories are included.
 * Symbolic links are skipped. Files over MAX_FILE_SIZE are skipped.
 * Throws if total file count exceeds MAX_FILE_COUNT.
 *
 * @param packageRoot - absolute path to the package root (respects takt-repertoire.yaml path)
 */
export function collectCopyTargets(packageRoot: string): CopyTarget[] {
  const targets: CopyTarget[] = [];

  for (let index = 0; index < ALLOWED_DIRS.length; index += 1) {
    const allowedDir = ALLOWED_DIRS[index]!;
    const dirPath = join(packageRoot, allowedDir);
    let stats: Stats | undefined;
    try {
      stats = lstatSync(dirPath);
    } catch (err) {
      log.debug('Directory not accessible, skipping', { dirPath, err });
      continue;
    }
    if (!safeReflectApply(safeStatsIsDirectoryMethod, stats, [])) continue;

    collectFromDir(dirPath, packageRoot, targets);

    if (targets.length >= MAX_FILE_COUNT) {
      throw new Error(
        `Package exceeds maximum file count of ${MAX_FILE_COUNT}`,
      );
    }
  }

  return targets;
}
