/**
 * Repertoire package listing.
 *
 * Scans the repertoire directory for installed packages and reads their
 * metadata (description, ref, truncated commit SHA) for display.
 */

import {
  Stats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { types as utilTypes } from 'node:util';
import { parseTaktRepertoireConfig } from './takt-repertoire-config.js';
import { parseLockFile } from './lock-file.js';
import { TAKT_REPERTOIRE_MANIFEST_FILENAME, TAKT_REPERTOIRE_LOCK_FILENAME } from './constants.js';
import {
  assertActiveRepertoireReadPermit,
  withImmediateRepertoireReadPermit,
  type RepertoireReadPermit,
} from './read-permit.js';
import { RepertoireCoordinationError } from './coordination-lease.js';
import { getGlobalConfigDir, getRepertoireDir } from '../../infra/config/paths.js';

const MAX_METADATA_BYTES = 1024 * 1024;
const safeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const safeObjectGetPrototypeOf = Object.getPrototypeOf.bind(Object);
const safeObjectHasOwn = Object.hasOwn.bind(Object);
const safeObjectCreate = Object.create.bind(Object);
const safeObjectFreeze = Object.freeze.bind(Object);
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeReflectOwnKeys = Reflect.ownKeys.bind(Reflect);
const safeIsProxy = utilTypes.isProxy.bind(utilTypes);
const safeStatsIsDirectoryMethod = Stats.prototype.isDirectory;
const safeStatsIsFileMethod = Stats.prototype.isFile;
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const localObjectPrototype = Object.prototype;
const safeBufferAlloc = Buffer.alloc.bind(Buffer);
const safeGetUid = typeof process.getuid === 'function' ? process.getuid.bind(process) : undefined;

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

  const configYaml = readApprovedTextOptional(packConfigPath, packageDir, context);
  const config = parseTaktRepertoireConfig(configYaml);

  const lockYaml = readApprovedTextOptional(lockPath, packageDir, context);
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
  const root = validateDirectory(context.repertoireDir, context.repertoireRealPath, context);
  if (root === undefined) return [];

  const packages: PackageInfo[] = [];
  const rootSnapshot = captureDirectorySnapshot(context.repertoireDir, root, context);
  for (const ownerEntry of rootSnapshot.entries) {
    if (!ownerEntry.startsWith('@')) continue;
    const ownerDir = join(context.repertoireDir, ownerEntry);
    const owner = validateDirectory(ownerDir, join(context.repertoireRealPath, ownerEntry), context);
    if (owner === undefined) throw unsafeState();

    const ownerSnapshot = captureDirectorySnapshot(ownerDir, owner, context);
    for (const repoEntry of ownerSnapshot.entries) {
      const packageDir = join(ownerDir, repoEntry);
      const packageStat = validateDirectory(
        packageDir,
        join(context.repertoireRealPath, ownerEntry, repoEntry),
        context,
      );
      if (packageStat === undefined) throw unsafeState();
      const scope = `${ownerEntry}/${repoEntry}`;
      packages.push(readPackageInfoWithPermit(packageDir, scope, context));
    }
    assertDirectorySnapshot(ownerDir, ownerSnapshot, context);
  }
  assertDirectorySnapshot(context.repertoireDir, rootSnapshot, context);

  return packages;
}

function readApprovedTextOptional(
  path: string,
  packageDir: string,
  context: TrustedReadContext,
): string {
  const before = lstatOptionalWithContext(path, context);
  if (before === undefined) return '';
  assertApprovedRegularFile(before, context);
  assertContext(context);
  let resolvedBefore: string;
  let packageRealPath: string;
  try {
    assertContext(context);
    packageRealPath = realpathSync(packageDir);
    assertContext(context);
    resolvedBefore = realpathSync(path);
  } catch {
    throw unsafeState();
  }
  if (resolvedBefore !== join(packageRealPath, basename(path))) throw unsafeState();
  let fd: number | undefined;
  try {
    assertContext(context);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertContext(context);
    const opened = fstatSync(fd);
    assertApprovedRegularFile(opened, context);
    if (!sameStableIdentity(before, opened) || opened.size > MAX_METADATA_BYTES) throw unsafeState();
    const bytes = readBounded(fd, opened.size, context);
    assertContext(context);
    const openedAfter = fstatSync(fd);
    const after = lstatRequiredWithContext(path, context);
    assertContext(context);
    const resolvedAfter = realpathSync(path);
    if (
      bytes.length !== opened.size
      || resolvedAfter !== resolvedBefore
      || !sameStableIdentity(opened, openedAfter)
      || !sameStableIdentity(opened, after)
    ) throw unsafeState();
    return bytes.toString('utf-8');
  } catch (error) {
    if (error instanceof RepertoireCoordinationError) throw error;
    throw unsafeState();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
  const ownerDir = join(context.repertoireDir, segments[0]!);
  if (validateDirectory(ownerDir, join(context.repertoireRealPath, segments[0]!), context) === undefined) {
    throw unsafeState();
  }
  if (validateDirectory(packageDir, join(context.repertoireRealPath, ...segments), context) === undefined) {
    throw unsafeState();
  }
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
  const snapshot = safeObjectCreate(null) as Record<string, string>;
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
  return safeObjectFreeze(snapshot);
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

function lstatOptionalWithContext(path: string, context: TrustedReadContext): Stats | undefined {
  assertContext(context);
  return lstatOptional(path);
}

function lstatRequiredWithContext(path: string, context: TrustedReadContext): Stats {
  const stat = lstatOptionalWithContext(path, context);
  if (stat === undefined) throw unsafeState();
  return stat;
}

function isDirectory(stat: Stats): boolean {
  return safeReflectApply(safeStatsIsDirectoryMethod, stat, []) as boolean;
}

function isSymbolicLink(stat: Stats): boolean {
  return safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, []) as boolean;
}

function isFile(stat: Stats): boolean {
  return safeReflectApply(safeStatsIsFileMethod, stat, []) as boolean;
}

function validateDirectory(
  path: string,
  expectedRealPath: string,
  context: TrustedReadContext,
): Stats | undefined {
  const before = lstatOptionalWithContext(path, context);
  if (before === undefined) return undefined;
  assertApprovedDirectory(before, context);
  assertContext(context);
  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch {
    throw unsafeState();
  }
  const after = lstatRequiredWithContext(realPath, context);
  if (realPath !== expectedRealPath || !sameStableIdentity(before, after)) throw unsafeState();
  return after;
}

type DirectorySnapshot = { entries: string[]; stat: Stats };

function captureDirectorySnapshot(
  path: string,
  expected: Stats,
  context: TrustedReadContext,
): DirectorySnapshot {
  assertContext(context);
  let entries: string[];
  try {
    entries = readdirSync(path).sort();
  } catch {
    throw unsafeState();
  }
  const fresh = lstatRequiredWithContext(path, context);
  if (!sameStableIdentity(expected, fresh)) throw unsafeState();
  return { entries, stat: fresh };
}

function assertDirectorySnapshot(
  path: string,
  snapshot: DirectorySnapshot,
  context: TrustedReadContext,
): void {
  assertContext(context);
  let entries: string[];
  try {
    entries = readdirSync(path).sort();
  } catch {
    throw unsafeState();
  }
  const fresh = lstatRequiredWithContext(path, context);
  if (
    !sameStableIdentity(snapshot.stat, fresh)
    || snapshot.entries.join('\0') !== entries.join('\0')
  ) throw unsafeState();
}

function assertApprovedDirectory(stat: Stats, context: TrustedReadContext): void {
  if (
    !isDirectory(stat)
    || isSymbolicLink(stat)
    || stat.dev !== lstatRequiredWithContext(context.repertoireDir, context).dev
    || (safeGetUid !== undefined && stat.uid !== safeGetUid())
    || (stat.mode & 0o022) !== 0
    || stat.nlink < 1
  ) throw unsafeState();
}

function assertApprovedRegularFile(stat: Stats, context: TrustedReadContext): void {
  if (
    !isFile(stat)
    || isSymbolicLink(stat)
    || stat.dev !== lstatRequiredWithContext(context.repertoireDir, context).dev
    || (safeGetUid !== undefined && stat.uid !== safeGetUid())
    || (stat.mode & 0o022) !== 0
    || stat.nlink !== 1
    || !Number.isSafeInteger(stat.size)
    || stat.size < 0
  ) throw unsafeState();
}

function sameStableIdentity(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readBounded(fd: number, expectedSize: number, context: TrustedReadContext): Buffer {
  if (expectedSize > MAX_METADATA_BYTES) throw unsafeState();
  const result = safeBufferAlloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    assertContext(context);
    const count = readSync(fd, result, offset, expectedSize - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  assertContext(context);
  const probe = safeBufferAlloc(1);
  if (readSync(fd, probe, 0, 1, expectedSize) !== 0) throw unsafeState();
  return offset === expectedSize ? result : result.subarray(0, offset);
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
