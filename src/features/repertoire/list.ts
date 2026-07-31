/**
 * Repertoire package listing.
 *
 * Scans the repertoire directory for installed packages and reads their
 * metadata (description, ref, truncated commit SHA) for display.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseTaktRepertoireConfig } from './takt-repertoire-config.js';
import { parseLockFile } from './lock-file.js';
import { TAKT_REPERTOIRE_MANIFEST_FILENAME, TAKT_REPERTOIRE_LOCK_FILENAME } from './constants.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import {
  assertActiveRepertoireReadPermit,
  withImmediateRepertoireReadPermit,
  type RepertoireReadPermit,
} from './read-permit.js';

const log = createLogger('repertoire-list');

export interface PackageInfo {
  /** e.g. "@nrslib/takt-fullstack" */
  scope: string;
  description?: string;
  ref: string;
  /** First 7 characters of the commit SHA. */
  commit: string;
}

/**
 * Read package metadata from a package directory.
 *
 * @param packageDir - absolute path to the package directory
 * @param scope      - e.g. "@nrslib/takt-fullstack"
 */
export function readPackageInfo(packageDir: string, scope: string): PackageInfo {
  const packageContainer = dirname(dirname(packageDir));
  const globalConfigDir = basename(packageContainer) === 'repertoire'
    ? dirname(packageContainer)
    : packageContainer;
  return withImmediateRepertoireReadPermit({
    globalConfigDir,
    operation: (permit) => readPackageInfoWithPermit(packageDir, scope, globalConfigDir, permit),
  });
}

function readPackageInfoWithPermit(
  packageDir: string,
  scope: string,
  globalConfigDir: string,
  permit: RepertoireReadPermit,
): PackageInfo {
  const packConfigPath = join(packageDir, TAKT_REPERTOIRE_MANIFEST_FILENAME);
  const lockPath = join(packageDir, TAKT_REPERTOIRE_LOCK_FILENAME);

  assertActiveRepertoireReadPermit(permit, globalConfigDir);
  const configYaml = existsSync(packConfigPath)
    ? readApprovedText(packConfigPath, globalConfigDir, permit)
    : '';
  const config = parseTaktRepertoireConfig(configYaml);

  assertActiveRepertoireReadPermit(permit, globalConfigDir);
  const lockYaml = existsSync(lockPath)
    ? readApprovedText(lockPath, globalConfigDir, permit)
    : '';
  const lock = parseLockFile(lockYaml);

  return {
    scope,
    description: config.description,
    ref: lock.ref,
    commit: lock.commit.slice(0, 7),
  };
}

/**
 * List all installed packages under the repertoire directory.
 *
 * Directory structure:
 *   repertoireDir/
 *     @{owner}/
 *       {repo}/
 *         takt-repertoire.yaml
 *         .takt-repertoire-lock.yaml
 *
 * @param repertoireDir - absolute path to the repertoire root (~/.takt/repertoire)
 */
export function listPackages(repertoireDir: string): PackageInfo[] {
  const globalConfigDir = dirname(repertoireDir);
  return withImmediateRepertoireReadPermit({
    globalConfigDir,
    operation: (permit) => listPackagesWithPermit(repertoireDir, globalConfigDir, permit),
  });
}

function listPackagesWithPermit(
  repertoireDir: string,
  globalConfigDir: string,
  permit: RepertoireReadPermit,
): PackageInfo[] {
  assertActiveRepertoireReadPermit(permit, globalConfigDir);
  if (!existsSync(repertoireDir)) return [];

  const packages: PackageInfo[] = [];

  assertActiveRepertoireReadPermit(permit, globalConfigDir);
  for (const ownerEntry of readdirSync(repertoireDir)) {
    if (!ownerEntry.startsWith('@')) continue;
    const ownerDir = join(repertoireDir, ownerEntry);
    assertActiveRepertoireReadPermit(permit, globalConfigDir);
    try { if (!statSync(ownerDir).isDirectory()) continue; } catch (e) { log.debug(`stat failed for ${ownerDir}: ${getErrorMessage(e)}`); continue; }

    assertActiveRepertoireReadPermit(permit, globalConfigDir);
    for (const repoEntry of readdirSync(ownerDir)) {
      const packageDir = join(ownerDir, repoEntry);
      assertActiveRepertoireReadPermit(permit, globalConfigDir);
      try { if (!statSync(packageDir).isDirectory()) continue; } catch (e) { log.debug(`stat failed for ${packageDir}: ${getErrorMessage(e)}`); continue; }
      const scope = `${ownerEntry}/${repoEntry}`;
      packages.push(readPackageInfoWithPermit(packageDir, scope, globalConfigDir, permit));
    }
  }

  return packages;
}

function readApprovedText(
  path: string,
  globalConfigDir: string,
  permit: RepertoireReadPermit,
): string {
  assertActiveRepertoireReadPermit(permit, globalConfigDir);
  return readFileSync(path, 'utf-8');
}
