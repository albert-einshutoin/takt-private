/**
 * Repertoire package listing.
 *
 * Scans the repertoire directory for installed packages and reads their
 * metadata (description, ref, truncated commit SHA) for display.
 */

import { Stats, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { types as utilTypes } from 'node:util';
import { parseTaktRepertoireConfig } from './takt-repertoire-config.js';
import { parseLockFile } from './lock-file.js';
import { TAKT_REPERTOIRE_MANIFEST_FILENAME, TAKT_REPERTOIRE_LOCK_FILENAME } from './constants.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import {
  assertActiveRepertoireReadPermit,
  withImmediateRepertoireReadPermit,
  type RepertoireReadPermit,
} from './read-permit.js';
import { RepertoireCoordinationError } from './coordination-lease.js';
import { getGlobalConfigDir, getRepertoireDir } from '../../infra/config/paths.js';

const log = createLogger('repertoire-list');
const safeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const safeObjectGetPrototypeOf = Object.getPrototypeOf.bind(Object);
const safeObjectHasOwn = Object.hasOwn.bind(Object);
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeReflectOwnKeys = Reflect.ownKeys.bind(Reflect);
const safeIsProxy = utilTypes.isProxy.bind(utilTypes);
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const localObjectPrototype = Object.prototype;

export interface ListPackagesFromGlobalConfigOptions {
  globalConfigDir: string;
  repertoireDir: string;
}

export interface ReadPackageInfoFromGlobalConfigOptions extends ListPackagesFromGlobalConfigOptions {
  packageDir: string;
  scope: string;
}

type TrustedReadContext = {
  globalConfigDir: string;
  repertoireDir: string;
  repertoireRealPath: string;
  permit: RepertoireReadPermit;
};

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
  return readPackageInfoFromGlobalConfig({
    globalConfigDir: getGlobalConfigDir(),
    repertoireDir: getRepertoireDir(),
    packageDir,
    scope,
  });
}

export function readPackageInfoFromGlobalConfig(
  options: ReadPackageInfoFromGlobalConfigOptions,
): PackageInfo {
  const snapshot = snapshotReadPackageOptions(options);
  return withImmediateRepertoireReadPermit({
    globalConfigDir: snapshot.globalConfigDir,
    operation: (permit) => {
      const context = validateTrustedContext(snapshot, permit, true);
      assertApprovedPackagePath(snapshot.packageDir, context);
      return readPackageInfoWithPermit(snapshot.packageDir, snapshot.scope, context);
    },
  });
}

function readPackageInfoWithPermit(
  packageDir: string,
  scope: string,
  context: TrustedReadContext,
): PackageInfo {
  const packConfigPath = join(packageDir, TAKT_REPERTOIRE_MANIFEST_FILENAME);
  const lockPath = join(packageDir, TAKT_REPERTOIRE_LOCK_FILENAME);

  assertContext(context);
  const configYaml = existsSync(packConfigPath)
    ? readApprovedText(packConfigPath, context)
    : '';
  const config = parseTaktRepertoireConfig(configYaml);

  assertContext(context);
  const lockYaml = existsSync(lockPath)
    ? readApprovedText(lockPath, context)
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
  return listPackagesFromGlobalConfig({
    globalConfigDir: getGlobalConfigDir(),
    repertoireDir,
  });
}

export function listPackagesFromGlobalConfig(
  options: ListPackagesFromGlobalConfigOptions,
): PackageInfo[] {
  const snapshot = snapshotListOptions(options);
  return withImmediateRepertoireReadPermit({
    globalConfigDir: snapshot.globalConfigDir,
    operation: (permit) => {
      const context = validateTrustedContext(snapshot, permit, false);
      return listPackagesWithPermit(context);
    },
  });
}

function listPackagesWithPermit(
  context: TrustedReadContext,
): PackageInfo[] {
  assertContext(context);
  if (!existsSync(context.repertoireDir)) return [];

  const packages: PackageInfo[] = [];

  assertContext(context);
  for (const ownerEntry of readdirSync(context.repertoireDir)) {
    if (!ownerEntry.startsWith('@')) continue;
    const ownerDir = join(context.repertoireDir, ownerEntry);
    assertContext(context);
    try { if (!statSync(ownerDir).isDirectory()) continue; } catch (e) { log.debug(`stat failed for ${ownerDir}: ${getErrorMessage(e)}`); continue; }

    assertContext(context);
    for (const repoEntry of readdirSync(ownerDir)) {
      const packageDir = join(ownerDir, repoEntry);
      assertContext(context);
      try { if (!statSync(packageDir).isDirectory()) continue; } catch (e) { log.debug(`stat failed for ${packageDir}: ${getErrorMessage(e)}`); continue; }
      const scope = `${ownerEntry}/${repoEntry}`;
      assertApprovedPackagePath(packageDir, context);
      packages.push(readPackageInfoWithPermit(packageDir, scope, context));
    }
  }

  return packages;
}

function readApprovedText(
  path: string,
  context: TrustedReadContext,
): string {
  assertContext(context);
  return readFileSync(path, 'utf-8');
}

function validateTrustedContext(
  options: ListPackagesFromGlobalConfigOptions,
  permit: RepertoireReadPermit,
  requireRepertoire: boolean,
): TrustedReadContext {
  const assertAuthority = () => assertActiveRepertoireReadPermit(
    permit,
    options.globalConfigDir,
  );
  assertAuthority();
  assertNormalizedAbsolutePath(options.globalConfigDir);
  assertNormalizedAbsolutePath(options.repertoireDir);
  assertAuthority();
  const globalStat = lstatRequired(options.globalConfigDir);
  if (!isDirectory(globalStat) || isSymbolicLink(globalStat)) throw unsafeState();
  assertAuthority();
  const globalRealPath = realpathSync(options.globalConfigDir);
  assertAuthority();
  const globalRealStat = lstatRequired(globalRealPath);
  if (!sameIdentity(globalStat, globalRealStat)) throw unsafeState();

  const expectedRepertoirePath = join(resolve(options.globalConfigDir), 'repertoire');
  if (options.repertoireDir !== expectedRepertoirePath) throw unsafeState();
  assertAuthority();
  const repertoireStat = lstatOptional(options.repertoireDir);
  if (repertoireStat === undefined) {
    if (requireRepertoire) throw unsafeState();
    return {
      globalConfigDir: options.globalConfigDir,
      repertoireDir: options.repertoireDir,
      repertoireRealPath: join(globalRealPath, 'repertoire'),
      permit,
    };
  }
  if (!isDirectory(repertoireStat) || isSymbolicLink(repertoireStat)) throw unsafeState();
  assertAuthority();
  const repertoireRealPath = realpathSync(options.repertoireDir);
  assertAuthority();
  const repertoireRealStat = lstatRequired(repertoireRealPath);
  if (
    repertoireRealPath !== join(globalRealPath, 'repertoire')
    || !sameIdentity(repertoireStat, repertoireRealStat)
  ) throw unsafeState();
  return {
    globalConfigDir: options.globalConfigDir,
    repertoireDir: options.repertoireDir,
    repertoireRealPath,
    permit,
  };
}

function assertApprovedPackagePath(packageDir: string, context: TrustedReadContext): void {
  assertContext(context);
  assertNormalizedAbsolutePath(packageDir);
  const relativePath = relative(context.repertoireDir, packageDir);
  const segments = relativePath.split(sep);
  if (
    relativePath === ''
    || relativePath.startsWith('..')
    || isAbsolute(relativePath)
    || segments.length !== 2
    || !segments[0]?.startsWith('@')
  ) throw unsafeState();
  assertContext(context);
  const before = lstatRequired(packageDir);
  if (!isDirectory(before) || isSymbolicLink(before)) throw unsafeState();
  assertContext(context);
  const realPath = realpathSync(packageDir);
  assertContext(context);
  const after = lstatRequired(realPath);
  if (
    realPath !== join(context.repertoireRealPath, ...segments)
    || !sameIdentity(before, after)
  ) throw unsafeState();
}

function snapshotListOptions(options: unknown): ListPackagesFromGlobalConfigOptions {
  return snapshotExactOptions(options, ['globalConfigDir', 'repertoireDir']) as
    unknown as ListPackagesFromGlobalConfigOptions;
}

function snapshotReadPackageOptions(options: unknown): ReadPackageInfoFromGlobalConfigOptions {
  return snapshotExactOptions(options, [
    'globalConfigDir',
    'repertoireDir',
    'packageDir',
    'scope',
  ]) as unknown as ReadPackageInfoFromGlobalConfigOptions;
}

function snapshotExactOptions(options: unknown, expectedKeys: readonly string[]): Record<string, string> {
  if (
    typeof options !== 'object'
    || options === null
    || safeIsProxy(options)
    || safeObjectGetPrototypeOf(options) !== localObjectPrototype
  ) throw unsafeState();
  const keys = safeReflectOwnKeys(options);
  if (keys.length !== expectedKeys.length) throw unsafeState();
  const snapshot: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const expectedKey of expectedKeys) {
    const descriptor = safeObjectGetOwnPropertyDescriptor(options, expectedKey);
    if (
      descriptor === undefined
      || !safeObjectHasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string'
    ) throw unsafeState();
    snapshot[expectedKey] = descriptor.value;
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !safeObjectHasOwn(snapshot, key)) throw unsafeState();
  }
  return snapshot;
}

function assertContext(context: TrustedReadContext): void {
  assertActiveRepertoireReadPermit(context.permit, context.globalConfigDir);
}

function assertNormalizedAbsolutePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw unsafeState();
}

function lstatOptional(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw unsafeState();
  }
}

function lstatRequired(path: string): Stats {
  const stat = lstatOptional(path);
  if (stat === undefined) throw unsafeState();
  return stat;
}

function isDirectory(stat: Stats): boolean {
  return safeReflectApply(safeStatsIsDirectoryMethod, stat, []) as boolean;
}

function isSymbolicLink(stat: Stats): boolean {
  return safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, []) as boolean;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT';
}

function unsafeState(): RepertoireCoordinationError {
  return new RepertoireCoordinationError('UNSAFE_STATE');
}
