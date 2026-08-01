import { randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createCoordinationPlatformPolicy,
  type CoordinationRootAuthority,
} from './coordination-platform-policy.js';
import { posixCoordinationFilesystemPolicy } from './coordination-posix-filesystem-policy.js';
import { win32CoordinationFilesystemPolicy } from './coordination-win32-filesystem-policy.js';
import {
  CoordinationFilesystemChangedError,
  CoordinationFilesystemPendingError,
  type CoordinationIdentity,
  type CoordinationFileObservation,
  type CoordinationStableDirectory,
  type CoordinationStableFile,
} from './coordination-filesystem-types.js';

const COORDINATION_DIRECTORY_NAME = '.takt-repertoire-coordination';
const READERS_DIRECTORY_NAME = 'readers';
const RELEASED_DIRECTORY_NAME = 'released';
const RELEASED_ARTIFACT_FILENAME = 'lease.released';
const RELEASE_PUBLISHING_SUFFIX = '.publishing';
const CLAIM_PUBLISHING_SUFFIX = '.publishing';
const WRITER_INTENT_FILENAME = 'writer.intent';
const WRITER_INTENT_PUBLISHING_FILENAME = `${WRITER_INTENT_FILENAME}${CLAIM_PUBLISHING_SUFFIX}`;
const LEASE_VERSION = 1;
const MAX_LEASE_BYTES = 4_096;
const MAX_READER_CLAIMS = 4_096;
const TOMBSTONE_SOFT_LIMIT = 2_048;
const TOMBSTONE_HARD_LIMIT = 4_096;
const RETRY_DELAY_MS = 10;
const MAX_SNAPSHOT_ATTEMPTS = 8;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`);
const HEX_256_REGEX = /^[0-9a-f]{64}$/;
const READER_FILENAME_PATTERN = new RegExp(`^(\\d+)\\.(${UUID_PATTERN})\\.lease$`);
const RELEASED_CONTAINER_PATTERN = new RegExp(
  `^([0-9a-f]{64})\\.(\\d+)\\.(${UUID_PATTERN})\\.(read|write)\\.released$`,
);

// Filesystem coordination is security-sensitive and may run beside plugins.
// Capture security-critical mutable intrinsics before post-initialization
// monkey-patching can redirect validation or leak filesystem details.
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeArrayIsArray = Array.isArray.bind(Array);
const safeArrayFindMethod = Array.prototype.find;
const safeArrayIncludesMethod = Array.prototype.includes;
const safeArrayJoinMethod = Array.prototype.join;
const safeArrayPushMethod = Array.prototype.push;
const safeArraySomeMethod = Array.prototype.some;
const safeArraySortMethod = Array.prototype.sort;
const safeArrayFind = <T>(value: T[], predicate: (item: T) => boolean): T | undefined => (
  safeReflectApply(safeArrayFindMethod, value, [predicate]) as T | undefined
);
const safeArrayIncludes = <T>(value: readonly T[], item: T): boolean => (
  safeReflectApply(safeArrayIncludesMethod, value, [item]) as boolean
);
const safeArrayJoin = (value: readonly unknown[], separator: string): string => (
  safeReflectApply(safeArrayJoinMethod, value, [separator]) as string
);
const safeArrayPush = <T>(value: T[], item: T): number => (
  safeReflectApply(safeArrayPushMethod, value, [item]) as number
);
const safeArraySome = <T>(value: T[], predicate: (item: T, index: number) => boolean): boolean => (
  safeReflectApply(safeArraySomeMethod, value, [predicate]) as boolean
);
const safeArraySort = <T>(value: T[]): T[] => (
  safeReflectApply(safeArraySortMethod, value, []) as T[]
);
const safeBufferFrom = Buffer.from.bind(Buffer);
const safeBufferFromUtf8 = (value: string): Buffer => safeBufferFrom(value, 'utf8');
const safeBufferToStringMethod = Buffer.prototype.toString;
const safeBufferToString = (value: Buffer, encoding: BufferEncoding): string => (
  safeReflectApply(safeBufferToStringMethod, value, [encoding]) as string
);
const safeDateNow = Date.now.bind(Date);
const SafeDate = Date;
const safeDateToISOStringMethod = Date.prototype.toISOString;
const safeDateToISOString = (value: Date): string => (
  safeReflectApply(safeDateToISOStringMethod, value, []) as string
);
const safeJsonParse = JSON.parse.bind(JSON);
const safeJsonStringify = JSON.stringify.bind(JSON);
const safeMathMin = Math.min.bind(Math);
const safeNumberIsSafeInteger = Number.isSafeInteger.bind(Number);
const safeObjectDefineProperty = Object.defineProperty.bind(Object);
const safeObjectFreeze = Object.freeze.bind(Object);
const safeObjectKeys = Object.keys.bind(Object);
const safeRegExpExecMethod = RegExp.prototype.exec;
const safeRegExpExec = (
  expression: RegExp,
  value: string,
): RegExpExecArray | null => safeReflectApply(safeRegExpExecMethod, expression, [value]);
const safeRegExpTestMethod = RegExp.prototype.test;
const safeRegExpTest = (
  expression: RegExp,
  value: string,
): boolean => safeReflectApply(safeRegExpTestMethod, expression, [value]);
const safeRandomBytes = randomBytes;
const safeRandomUUID = randomUUID;
const safeGetUid = typeof process.getuid === 'function'
  ? process.getuid.bind(process)
  : undefined;
const safePid = process.pid;
const safePlatform = process.platform;
const coordinationFilesystemPolicy = safePlatform === 'win32'
  ? win32CoordinationFilesystemPolicy
  : posixCoordinationFilesystemPolicy;

export const REPERTOIRE_COORDINATION_LOCK_ORDER = safeObjectFreeze([
  'global-repertoire',
  'project-template',
] as const);

export type RepertoireCoordinationMode = 'read' | 'write';

export type RepertoireCoordinationErrorCode =
  | 'ABORTED'
  | 'MAINTENANCE_REQUIRED'
  | 'RECOVERY_REQUIRED'
  | 'TIMEOUT'
  | 'UNSAFE_STATE'
  | 'WRITER_PENDING';

export class RepertoireCoordinationError extends Error {
  readonly code: RepertoireCoordinationErrorCode;

  constructor(code: RepertoireCoordinationErrorCode) {
    super(messageForCode(code));
    safeObjectDefineProperty(this, 'name', {
      configurable: true,
      value: 'RepertoireCoordinationError',
    });
    this.code = code;
  }
}

export type RepertoireCoordinationLease = {
  readonly mode: RepertoireCoordinationMode;
  release(): void;
};

export type AcquireRepertoireCoordinationLeaseOptions = {
  globalConfigDir: string;
  mode: RepertoireCoordinationMode;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type AcquireImmediateRepertoireReadLeaseOptions = Omit<
  AcquireRepertoireCoordinationLeaseOptions,
  'mode' | 'timeoutMs'
>;

type LeaseRecord = {
  version: 1;
  mode: RepertoireCoordinationMode;
  token: string;
  pid: number;
  uid: number | null;
  createdAt: string;
};

type FileIdentity = CoordinationIdentity;

type LeaseEvidence = {
  record: LeaseRecord;
  identity: FileIdentity;
  digest: string;
};

type PublishedClaimState = 'published' | 'retired' | 'uncertain';

type CoordinationPaths = {
  root: string;
  readers: string;
  released: string;
  writerIntent: string;
  trustedRoot: TrustedConfigRoot;
};

type TrustedConfigRoot = CoordinationRootAuthority;

type CoordinationSnapshot = {
  digest: string;
  claimPublishing: boolean;
  readers: LeaseEvidence[];
  released: LeaseEvidence[];
  writer: LeaseEvidence | undefined;
  releasedCount: number;
};

const SNAPSHOT_CHANGED = Symbol('repertoire-coordination-snapshot-changed');
const coordinationPlatformPolicy = createCoordinationPlatformPolicy({
  platform: safePlatform,
  openPosixRootAuthority: coordinationFilesystemPolicy.preflightRoot,
  loadWindowsBridge: () => ({
    openRootAuthority: win32CoordinationFilesystemPolicy.preflightRoot,
  }),
});

/**
 * Acquires a process-wide lease for the global repertoire.
 *
 * The filesystem is the arbitration authority because TaktDesk instances can
 * run in unrelated processes. Dead or old-looking claims and release
 * tombstones are deliberately never reclaimed here: PID reuse, clock drift,
 * and check-then-delete races make automatic recovery unsafe.
 */
export async function acquireRepertoireCoordinationLease(
  options: AcquireRepertoireCoordinationLeaseOptions,
): Promise<RepertoireCoordinationLease> {
  let paths: CoordinationPaths | undefined;
  try {
    validateOptions(options);
    throwIfAborted(options.signal);
    const deadline = safeDateNow() + (options.timeoutMs ?? 5_000);
    paths = await prepareCoordinationPathsBounded(
      options.globalConfigDir,
      deadline,
      options.signal,
    );
    return options.mode === 'read'
      ? await acquireReadLeaseBounded(paths, deadline, options.signal)
      : await acquireWriteLease(paths, deadline, options.signal);
  } catch (error) {
    return throwAfterClosingTrustedRoot(paths, error);
  }
}

/** Acquires a read lease synchronously and never waits behind a writer. */
export function acquireRepertoireCoordinationReadLeaseImmediate(
  options: AcquireImmediateRepertoireReadLeaseOptions,
): RepertoireCoordinationLease {
  let paths: CoordinationPaths | undefined;
  try {
    const validated = { ...options, mode: 'read' as const };
    validateOptions(validated);
    throwIfAborted(validated.signal);
    paths = prepareCoordinationPaths(validated.globalConfigDir);
    return acquireReadLease(paths, validated.signal);
  } catch (error) {
    return throwAfterClosingTrustedRoot(paths, error);
  }
}

async function acquireReadLeaseBounded(
  paths: CoordinationPaths,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<RepertoireCoordinationLease> {
  while (true) {
    try {
      return acquireReadLease(paths, signal);
    } catch (error) {
      if (!isWriterPending(error)) throw error;
      await waitForRetry(paths, deadline, signal);
    }
  }
}

function acquireReadLease(
  paths: CoordinationPaths,
  signal: AbortSignal | undefined,
): RepertoireCoordinationLease {
  const before = scanStableState(paths);
  enforceTombstoneLimits(before.releasedCount, 'read');
  if (before.writer !== undefined || before.claimPublishing) {
    throw new RepertoireCoordinationError('WRITER_PENDING');
  }

  throwIfAborted(signal);
  const record = createLeaseRecord('read');
  const claimPath = join(paths.readers, `${record.pid}.${record.token}.lease`);
  const identity = createLeaseFile(paths, claimPath, record, paths.readers);
  let claimState: PublishedClaimState = 'published';

  try {
    throwIfAborted(signal);
    const after = scanStableState(paths);
    enforceTombstoneLimits(after.releasedCount, 'read');
    assertPublishedLease(after.readers, record, identity);
    if (after.writer !== undefined || after.claimPublishing) {
      claimState = retireAfterFailedAcquire(paths, claimPath, record, identity, paths.readers);
      if (claimState !== 'retired') throw new RepertoireCoordinationError('UNSAFE_STATE');
      throw new RepertoireCoordinationError('WRITER_PENDING');
    }
  } catch (error) {
    if (claimState === 'published') {
      claimState = retireAfterFailedAcquire(paths, claimPath, record, identity, paths.readers);
    }
    if (claimState === 'uncertain') throw new RepertoireCoordinationError('UNSAFE_STATE');
    throw error;
  }

  return leaseHandle(paths, 'read', claimPath, record, identity, paths.readers);
}

async function acquireWriteLease(
  paths: CoordinationPaths,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<RepertoireCoordinationLease> {
  const record = createLeaseRecord('write');
  let identity: FileIdentity;
  let claimState: PublishedClaimState = 'uncertain';

  while (true) {
    throwIfAborted(signal);
    let state: CoordinationSnapshot;
    try {
      state = scanStableState(paths);
    } catch (error) {
      if (isWriterPending(error)) {
        await waitForRetry(paths, deadline, signal);
        continue;
      }
      throw error;
    }
    enforceTombstoneLimits(state.releasedCount, 'write');
    if (state.writer !== undefined || state.claimPublishing) {
      await waitForRetry(paths, deadline, signal);
      continue;
    }
    try {
      identity = createLeaseFile(paths, paths.writerIntent, record, paths.root);
      claimState = 'published';
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      await waitForRetry(paths, deadline, signal);
    }
  }

  try {
    while (true) {
      let state: CoordinationSnapshot;
      try {
        state = scanStableState(paths);
      } catch (error) {
        if (isWriterPending(error)) {
          await waitForRetry(paths, deadline, signal);
          continue;
        }
        throw error;
      }
      enforceTombstoneLimits(state.releasedCount, 'write');
      assertPublishedLease(
        state.writer === undefined ? [] : [state.writer],
        record,
        identity,
      );
      if (state.readers.length === 0) break;
      await waitForRetry(paths, deadline, signal);
    }
  } catch (error) {
    if (claimState === 'published') {
      claimState = retireAfterFailedAcquire(paths, paths.writerIntent, record, identity, paths.root);
    }
    if (claimState === 'uncertain') throw new RepertoireCoordinationError('UNSAFE_STATE');
    throw error;
  }

  return leaseHandle(paths, 'write', paths.writerIntent, record, identity, paths.root);
}

function leaseHandle(
  paths: CoordinationPaths,
  mode: RepertoireCoordinationMode,
  path: string,
  record: LeaseRecord,
  identity: FileIdentity,
  parentDirectory: string,
): RepertoireCoordinationLease {
  let released = false;
  return safeObjectFreeze({
    mode,
    release(): void {
      if (released) return;
      released = true;
      let primaryFailure: unknown;
      try {
        paths.trustedRoot.assertUnchanged();
        releaseOwnedLease(paths, path, record, identity, parentDirectory);
        paths.trustedRoot.assertUnchanged();
      } catch (error) {
        primaryFailure = error;
      }
      try {
        paths.trustedRoot.close();
      } catch (error) {
        if (primaryFailure !== undefined) {
          throw new RepertoireCoordinationError('UNSAFE_STATE');
        }
        throw normalizeCoordinationError(error);
      }
      if (primaryFailure !== undefined) throw normalizeCoordinationError(primaryFailure);
    },
  });
}

function throwAfterClosingTrustedRoot(paths: CoordinationPaths | undefined, error: unknown): never {
  if (paths !== undefined) {
    try {
      paths.trustedRoot.close();
    } catch {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
  }
  throw normalizeCoordinationError(error);
}

function prepareCoordinationPaths(globalConfigDir: string): CoordinationPaths {
  const trustedRoot = coordinationPlatformPolicy.openRootAuthority(globalConfigDir);
  try {
    // Child paths are based on the proven canonical leaf. Ancestor aliases
    // such as macOS /tmp remain valid, while a symlink at the .takt leaf does not.
    const root = join(trustedRoot.canonicalRoot, COORDINATION_DIRECTORY_NAME);
    const readers = join(root, READERS_DIRECTORY_NAME);
    const released = join(root, RELEASED_DIRECTORY_NAME);
    ensurePrivateDirectory(root);
    ensurePrivateDirectory(readers);
    ensurePrivateDirectory(released);
    coordinationFilesystemPolicy.sealRoot(trustedRoot);
    const paths = {
      root,
      readers,
      released,
      writerIntent: join(root, WRITER_INTENT_FILENAME),
      trustedRoot,
    };
    assertCoordinationDirectories(paths);
    // Creating the private subtree is observable filesystem work. Re-prove
    // the opened root afterwards so replacement cannot redirect later leases.
    trustedRoot.assertUnchanged();
    return paths;
  } catch (error) {
    trustedRoot.close();
    throw error;
  }
}

async function prepareCoordinationPathsBounded(
  globalConfigDir: string,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<CoordinationPaths> {
  let malformedSentinelPublication = false;
  while (true) {
    throwIfAborted(signal);
    try {
      return prepareCoordinationPaths(globalConfigDir);
    } catch (error) {
      if (!(error instanceof CoordinationFilesystemPendingError)) throw error;
      malformedSentinelPublication ||= error.malformed;
      const remaining = deadline - safeDateNow();
      if (remaining <= 0) {
        throw new RepertoireCoordinationError(
          malformedSentinelPublication ? 'UNSAFE_STATE' : 'TIMEOUT',
        );
      }
      try {
        await delay(safeMathMin(RETRY_DELAY_MS, remaining), undefined, { signal });
      } catch {
        if (signal?.aborted) throw new RepertoireCoordinationError('ABORTED');
        throw new RepertoireCoordinationError('UNSAFE_STATE');
      }
    }
  }
}

function assertCoordinationDirectories(paths: CoordinationPaths): void {
  assertPrivateDirectory(paths.root);
  assertPrivateDirectory(paths.readers);
  assertPrivateDirectory(paths.released);
}

function ensurePrivateDirectory(path: string): void {
  coordinationFilesystemPolicy.ensurePrivateDirectory(path);
}

function assertPrivateDirectory(path: string): void {
  coordinationFilesystemPolicy.assertDirectory(path);
}

function createLeaseRecord(mode: RepertoireCoordinationMode): LeaseRecord {
  return {
    version: LEASE_VERSION,
    mode,
    token: safeRandomUUID(),
    pid: safePid,
    uid: currentUid(),
    createdAt: safeDateToISOString(new SafeDate(safeDateNow())),
  };
}

function createLeaseFile(
  paths: CoordinationPaths,
  path: string,
  record: LeaseRecord,
  parentDirectory: string,
): FileIdentity {
  paths.trustedRoot.assertUnchanged();
  assertPrivateDirectory(parentDirectory);
  const publishingPath = `${path}${CLAIM_PUBLISHING_SUFFIX}`;
  const bytes = safeBufferFromUtf8(`${safeJsonStringify(record)}\n`);
  const stagedFile = coordinationFilesystemPolicy.createStagedExclusiveFile(
    publishingPath,
    bytes,
  );
  syncDirectory(parentDirectory);
  paths.trustedRoot.assertUnchanged();
  const staged = leaseEvidenceFromStableFile(stagedFile, record.mode);
  assertSameOwner(staged.record, record);
  // Claims become visible only after complete, fsynced bytes have been
  // validated. A crashed staging file remains explicit blocking evidence.
  paths.trustedRoot.assertUnchanged();
  try {
    // Hard-link publication preserves O_EXCL/no-replace semantics. rename(2)
    // could overwrite an already-published writer intent after staging.
    coordinationFilesystemPolicy.linkNoReplace(publishingPath, path);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      const owned = readExactPrivateLease(publishingPath, record.mode);
      if (!sameOwnerAndIdentity(owned, record, staged.identity)) {
        throw new RepertoireCoordinationError('UNSAFE_STATE');
      }
      coordinationFilesystemPolicy.unlinkOwned(publishingPath, staged.identity);
      syncDirectory(parentDirectory);
      paths.trustedRoot.assertUnchanged();
    }
    throw error;
  }
  paths.trustedRoot.assertUnchanged();
  coordinationFilesystemPolicy.unlinkOwned(publishingPath, staged.identity);
  syncDirectory(parentDirectory);
  paths.trustedRoot.assertUnchanged();
  const published = readExactPrivateLease(path, record.mode);
  if (!sameOwnerAndIdentity(published, record, staged.identity)) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  return published.identity;
}

function readExactPrivateLease(
  path: string,
  expectedMode?: RepertoireCoordinationMode,
): LeaseEvidence {
  return leaseEvidenceFromStableFile(
    coordinationFilesystemPolicy.readStableFile(path, MAX_LEASE_BYTES),
    expectedMode,
  );
}

function leaseEvidenceFromStableFile(
  file: CoordinationStableFile,
  expectedMode?: RepertoireCoordinationMode,
): LeaseEvidence {
  const raw = safeBufferToString(file.bytes, 'utf8');
  return { record: parseLeaseRecord(raw, expectedMode), identity: file.identity, digest: file.digest };
}

function parseLeaseRecord(raw: string, expectedMode?: RepertoireCoordinationMode): LeaseRecord {
  let value: unknown;
  try {
    value = safeJsonParse(raw);
  } catch {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  if (!isRecord(value)) throw new RepertoireCoordinationError('UNSAFE_STATE');

  const keys = safeArraySort(safeObjectKeys(value));
  const expectedKeys = ['createdAt', 'mode', 'pid', 'token', 'uid', 'version'];
  const createdAt = value['createdAt'];
  const token = value['token'];
  const uid = value['uid'];
  if (
    keys.length !== expectedKeys.length
    || safeArraySome(keys, (key, index) => key !== expectedKeys[index])
    || value['version'] !== LEASE_VERSION
    || (value['mode'] !== 'read' && value['mode'] !== 'write')
    || (expectedMode !== undefined && value['mode'] !== expectedMode)
    || !safeNumberIsSafeInteger(value['pid'])
    || (value['pid'] as number) <= 0
    || typeof token !== 'string'
    || !safeRegExpTest(UUID_REGEX, token)
    || (uid !== null && (!safeNumberIsSafeInteger(uid) || (uid as number) < 0))
    || uid !== currentUid()
    || typeof createdAt !== 'string'
    || !isCanonicalTimestamp(createdAt)
  ) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }

  return value as LeaseRecord;
}

function scanStableState(
  paths: CoordinationPaths,
  enforceHardLimit = true,
): CoordinationSnapshot {
  paths.trustedRoot.assertUnchanged();
  let previous: CoordinationSnapshot | undefined;
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const current = scanStateOnce(paths, enforceHardLimit);
      if (previous?.digest === current.digest) {
        paths.trustedRoot.assertUnchanged();
        return current;
      }
      previous = current;
    } catch (error) {
      if (error !== SNAPSHOT_CHANGED) throw error;
      previous = undefined;
    }
  }
  throw new RepertoireCoordinationError('UNSAFE_STATE');
}

function scanStateOnce(
  paths: CoordinationPaths,
  enforceHardLimit: boolean,
): CoordinationSnapshot {
  const rootSnapshot = listStableDirectory(paths.root);
  const rootBefore = rootSnapshot.digest;
  const rootEntries = rootSnapshot.entries;
  for (const entry of rootEntries) {
    if (
      entry !== READERS_DIRECTORY_NAME
      && entry !== RELEASED_DIRECTORY_NAME
      && entry !== WRITER_INTENT_FILENAME
      && entry !== WRITER_INTENT_PUBLISHING_FILENAME
      && !coordinationFilesystemPolicy.isReservedRootEntry(entry)
    ) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
  }
  if (
    !safeArrayIncludes(rootEntries, READERS_DIRECTORY_NAME)
    || !safeArrayIncludes(rootEntries, RELEASED_DIRECTORY_NAME)
  ) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }

  const readers = scanReaders(paths.readers);
  const released = scanReleased(paths.released, enforceHardLimit);
  const writerPublishing = safeArrayIncludes(rootEntries, WRITER_INTENT_PUBLISHING_FILENAME);
  let writerDuringPublishing: LeaseEvidence | undefined;
  if (writerPublishing && safeArrayIncludes(rootEntries, WRITER_INTENT_FILENAME)) {
    const pairState = classifyPublishingPair(
      paths.writerIntent,
      `${paths.writerIntent}${CLAIM_PUBLISHING_SUFFIX}`,
    );
    if (pairState === 'contender') {
      writerDuringPublishing = readListedLease(paths.writerIntent, 'write');
    }
  } else if (writerPublishing) {
    assertPublishingOnly(`${paths.writerIntent}${CLAIM_PUBLISHING_SUFFIX}`);
  }
  const writer = safeArrayIncludes(rootEntries, WRITER_INTENT_FILENAME)
    ? writerDuringPublishing ?? (
      !writerPublishing ? readListedLease(paths.writerIntent, 'write') : undefined
    )
    : undefined;
  assertDirectorySnapshotUnchanged(rootSnapshot);

  const digest = safeArrayJoin([
    rootBefore,
    safeArrayJoin(rootEntries, ','),
    readers.digest,
    released.digest,
    writerPublishing ? 'writer-publishing' : '-',
    writer?.digest ?? '-',
  ], '|');
  return {
    digest,
    claimPublishing: readers.publishing || writerPublishing,
    readers: readers.evidence,
    released: released.evidence,
    writer,
    releasedCount: released.count,
  };
}

function scanReaders(directory: string): {
  digest: string;
  evidence: LeaseEvidence[];
  publishing: boolean;
} {
  const snapshot = listStableDirectory(directory);
  const before = snapshot.digest;
  const entries = snapshot.entries;
  if (entries.length > MAX_READER_CLAIMS) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  const evidence: LeaseEvidence[] = [];
  const digests: string[] = [];
  let publishing = false;
  for (const filename of entries) {
    if (!filename.endsWith(CLAIM_PUBLISHING_SUFFIX)) continue;
    const activeFilename = filename.slice(0, -CLAIM_PUBLISHING_SUFFIX.length);
    if (!safeRegExpTest(READER_FILENAME_PATTERN, activeFilename)) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
    if (!safeArrayIncludes(entries, activeFilename)) {
      assertPublishingOnly(join(directory, filename));
    }
    publishing = true;
  }
  for (const filename of entries) {
    if (filename.endsWith(CLAIM_PUBLISHING_SUFFIX)) {
      safeArrayPush(digests, `${filename}:publishing`);
      continue;
    }
    const match = safeRegExpExec(READER_FILENAME_PATTERN, filename);
    if (!match) throw new RepertoireCoordinationError('UNSAFE_STATE');
    if (safeArrayIncludes(entries, `${filename}${CLAIM_PUBLISHING_SUFFIX}`)) {
      // linkSync briefly exposes the complete inode with nlink=2. The paired
      // staging name proves this is still a known publication transition;
      // never parse or grant it until only the active nlink=1 name remains.
      const pairState = classifyPublishingPair(
        join(directory, filename),
        join(directory, `${filename}${CLAIM_PUBLISHING_SUFFIX}`),
      );
      let activeDigest = '-';
      if (pairState === 'contender') {
        const lease = readListedLease(join(directory, filename), 'read');
        if (`${lease.record.pid}` !== match[1] || lease.record.token !== match[2]) {
          throw new RepertoireCoordinationError('UNSAFE_STATE');
        }
        safeArrayPush(evidence, lease);
        activeDigest = lease.digest;
      }
      safeArrayPush(digests, `${filename}:paired-publishing:${activeDigest}`);
      continue;
    }
    const lease = readListedLease(join(directory, filename), 'read');
    if (`${lease.record.pid}` !== match[1] || lease.record.token !== match[2]) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
    safeArrayPush(evidence, lease);
    safeArrayPush(digests, `${filename}:${lease.digest}`);
  }
  assertDirectorySnapshotUnchanged(snapshot);
  return { digest: `${before}:${safeArrayJoin(digests, ',')}`, evidence, publishing };
}

function classifyPublishingPair(
  activePath: string,
  publishingPath: string,
): 'linked' | 'contender' {
  const active = statPublishingPath(activePath);
  const publishing = statPublishingPath(publishingPath);
  if (coordinationFilesystemPolicy.sameObject(active, publishing)) {
    if (active.linkCount !== 2 || publishing.linkCount !== 2) throw SNAPSHOT_CHANGED;
    return 'linked';
  }
  if (active.linkCount !== 1 || publishing.linkCount !== 1) throw SNAPSHOT_CHANGED;
  return 'contender';
}

function assertPublishingOnly(path: string): void {
  const stat = statPublishingPath(path);
  if (stat.linkCount === 1) return;
  if (stat.linkCount === 2) {
    const activePath = path.slice(0, -CLAIM_PUBLISHING_SUFFIX.length);
    statPublishingPath(activePath);
    // The directory listing can race across the publisher's nlink=2 window.
    // The active name may therefore be the same inode at nlink 2, already be
    // the remaining nlink=1 publication, or have been released. Restarting is
    // bounded, so a stable external hard link with no derived active name still
    // terminates as unsafe rather than authorizing progress.
    throw SNAPSHOT_CHANGED;
  }
  throw SNAPSHOT_CHANGED;
}

function statPublishingPath(path: string): CoordinationFileObservation {
  const stat = coordinationFilesystemPolicy.statPath(path, MAX_LEASE_BYTES);
  if (stat === undefined) throw SNAPSHOT_CHANGED;
  return stat;
}

function scanReleased(
  directory: string,
  enforceHardLimit: boolean,
): { digest: string; count: number; evidence: LeaseEvidence[] } {
  const snapshot = listStableDirectory(directory);
  const before = snapshot.digest;
  const entries = snapshot.entries;
  if (enforceHardLimit && entries.length > TOMBSTONE_HARD_LIMIT) {
    throw new RepertoireCoordinationError('RECOVERY_REQUIRED');
  }
  const digests: string[] = [];
  const evidence: LeaseEvidence[] = [];
  let releasePublishing = false;
  for (const containerName of entries) {
    // Release is published by an atomic directory rename. A visible staging
    // container is therefore a bounded in-flight transition, never evidence
    // that can authorize another lease from a partial tombstone snapshot.
    if (containerName.endsWith(RELEASE_PUBLISHING_SUFFIX)) {
      const baseName = containerName.slice(0, -RELEASE_PUBLISHING_SUFFIX.length);
      if (!safeRegExpTest(RELEASED_CONTAINER_PATTERN, baseName)) {
        throw new RepertoireCoordinationError('UNSAFE_STATE');
      }
      const publishingContainer = join(directory, containerName);
      const publishingSnapshot = listStableDirectory(publishingContainer);
      const publishingBefore = publishingSnapshot.digest;
      assertDirectorySnapshotUnchanged(publishingSnapshot);
      releasePublishing = true;
      safeArrayPush(digests, `${containerName}:${publishingBefore}`);
      continue;
    }
    const match = safeRegExpExec(RELEASED_CONTAINER_PATTERN, containerName);
    if (!match) throw new RepertoireCoordinationError('UNSAFE_STATE');
    const container = join(directory, containerName);
    const containerSnapshot = listStableDirectory(container);
    const containerBefore = containerSnapshot.digest;
    const artifacts = containerSnapshot.entries;
    if (
      artifacts.length !== 1
      || artifacts[0] !== RELEASED_ARTIFACT_FILENAME
    ) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
    const lease = readListedLease(join(container, RELEASED_ARTIFACT_FILENAME));
    if (
      `${lease.record.pid}` !== match[2]
      || lease.record.token !== match[3]
      || lease.record.mode !== match[4]
    ) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
    assertDirectorySnapshotUnchanged(containerSnapshot);
    safeArrayPush(evidence, lease);
    safeArrayPush(digests, `${containerName}:${containerBefore}:${lease.digest}`);
  }
  assertDirectorySnapshotUnchanged(snapshot);
  if (releasePublishing) throw new RepertoireCoordinationError('WRITER_PENDING');
  return {
    digest: `${before}:${safeArrayJoin(digests, ',')}`,
    count: entries.length,
    evidence,
  };
}

function listStableDirectory(path: string): CoordinationStableDirectory {
  try {
    return coordinationFilesystemPolicy.listStable(path);
  } catch (error) {
    if (error instanceof CoordinationFilesystemChangedError || isMissingError(error)) {
      throw SNAPSHOT_CHANGED;
    }
    throw error;
  }
}

function assertDirectorySnapshotUnchanged(snapshot: CoordinationStableDirectory): void {
  try {
    snapshot.assertUnchanged();
  } catch (error) {
    if (error instanceof CoordinationFilesystemChangedError || isMissingError(error)) {
      throw SNAPSHOT_CHANGED;
    }
    throw error;
  }
}

function readListedLease(path: string, mode?: RepertoireCoordinationMode): LeaseEvidence {
  try {
    return readExactPrivateLease(path, mode);
  } catch (error) {
    if (isMissingError(error)) throw SNAPSHOT_CHANGED;
    throw error;
  }
}


function assertPublishedLease(
  leases: LeaseEvidence[],
  record: LeaseRecord,
  identity: FileIdentity,
): void {
  const own = safeArrayFind(leases, (lease) => sameOwnerAndIdentity(lease, record, identity));
  if (own === undefined) throw new RepertoireCoordinationError('UNSAFE_STATE');
}

function retireAfterFailedAcquire(
  paths: CoordinationPaths,
  path: string,
  record: LeaseRecord,
  identity: FileIdentity,
  parentDirectory: string,
): PublishedClaimState {
  try {
    // Never attempt pathname cleanup after losing the descriptor-backed root
    // proof; it could retire a foreign claim through a replacement path.
    paths.trustedRoot.assertUnchanged();
    releaseOwnedLease(paths, path, record, identity, parentDirectory);
    return 'retired';
  } catch {
    return 'uncertain';
  }
}

function releaseOwnedLease(
  paths: CoordinationPaths,
  path: string,
  expected: LeaseRecord,
  identity: FileIdentity,
  parentDirectory: string,
): void {
  paths.trustedRoot.assertUnchanged();
  const nonce = safeBufferToString(safeRandomBytes(32), 'hex');
  if (!safeRegExpTest(HEX_256_REGEX, nonce)) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  const containerName = `${nonce}.${expected.pid}.${expected.token}.${expected.mode}.released`;
  const container = join(paths.released, containerName);
  const publishingContainer = `${container}${RELEASE_PUBLISHING_SUFFIX}`;
  let containerIdentity: CoordinationIdentity;
  try {
    containerIdentity = coordinationFilesystemPolicy.createPrivateDirectoryExclusive(
      publishingContainer,
    );
  } catch (error) {
    // A nonce collision is never retried: preserving the existing container is
    // more important than making release appear successful under a compromised
    // entropy source.
    if (isAlreadyExistsError(error)) {
      throw new RepertoireCoordinationError('UNSAFE_STATE');
    }
    throw error;
  }
  paths.trustedRoot.assertUnchanged();
  enforcePrivateDirectoryMode(publishingContainer);
  assertPrivateDirectory(publishingContainer);
  syncDirectory(paths.released);
  const publishingPath = join(publishingContainer, RELEASED_ARTIFACT_FILENAME);

  // The first rename retires the active claim into a private staging
  // container. The second publishes a complete tombstone atomically, so a
  // waiter can never mistake an empty container for permanent unsafe state.
  // There is intentionally no
  // ownership check before it: a check-then-unlink sequence can delete a
  // foreign claim installed between those operations. The 256-bit container
  // is created immediately beforehand with O_EXCL-like mkdir semantics, so
  // ordinary protocol participants cannot pre-publish its fixed artifact.
  // A malicious same-UID process can still mutate a 0700 directory after it is
  // published; the post-rename identity check and full scan fail closed but
  // cannot provide a stronger OS isolation boundary than the shared UID.
  paths.trustedRoot.assertUnchanged();
  coordinationFilesystemPolicy.renameOwned(path, publishingPath, identity);
  paths.trustedRoot.assertUnchanged();
  syncDirectory(parentDirectory);
  syncDirectory(publishingContainer);
  paths.trustedRoot.assertUnchanged();
  coordinationFilesystemPolicy.renameOwned(
    publishingContainer,
    container,
    containerIdentity,
  );
  paths.trustedRoot.assertUnchanged();
  syncDirectory(paths.released);
  const releasedPath = join(container, RELEASED_ARTIFACT_FILENAME);

  const released = readExactPrivateLease(releasedPath, expected.mode);
  if (!sameOwnerAndIdentity(released, expected, identity)) {
    // A mismatching tombstone is permanent evidence of an unsafe race. Never
    // delete it here; all future acquisitions will fail closed while scanning.
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  paths.trustedRoot.assertUnchanged();
  const published = scanStableState(paths, false);
  assertPublishedLease(published.released, expected, identity);
  paths.trustedRoot.assertUnchanged();
}

function sameOwnerAndIdentity(
  evidence: LeaseEvidence,
  expected: LeaseRecord,
  identity: FileIdentity,
): boolean {
  return coordinationFilesystemPolicy.sameIdentity(evidence.identity, identity)
    && sameOwner(evidence.record, expected);
}

function assertSameOwner(actual: LeaseRecord, expected: LeaseRecord): void {
  if (!sameOwner(actual, expected)) throw new RepertoireCoordinationError('UNSAFE_STATE');
}

function sameOwner(actual: LeaseRecord, expected: LeaseRecord): boolean {
  return actual.mode === expected.mode
    && actual.token === expected.token
    && actual.pid === expected.pid
    && actual.uid === expected.uid
    && actual.createdAt === expected.createdAt;
}

function isWriterPending(error: unknown): boolean {
  return error instanceof RepertoireCoordinationError && error.code === 'WRITER_PENDING';
}

function enforceTombstoneLimits(
  count: number,
  mode: RepertoireCoordinationMode,
): void {
  if (count > TOMBSTONE_HARD_LIMIT) {
    throw new RepertoireCoordinationError('RECOVERY_REQUIRED');
  }
  if (mode === 'read' && count >= TOMBSTONE_SOFT_LIMIT) {
    throw new RepertoireCoordinationError('MAINTENANCE_REQUIRED');
  }
}

async function waitForRetry(
  paths: CoordinationPaths,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  paths.trustedRoot.assertUnchanged();
  throwIfAborted(signal);
  const remaining = deadline - safeDateNow();
  if (remaining <= 0) throw new RepertoireCoordinationError('TIMEOUT');
  try {
    await delay(safeMathMin(RETRY_DELAY_MS, remaining), undefined, { signal });
  } catch {
    if (signal?.aborted) throw new RepertoireCoordinationError('ABORTED');
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  // A same-UID process may replace a root below a writable parent while this
  // process is suspended, so no pathname is reused until the fd proof matches.
  paths.trustedRoot.assertUnchanged();
  throwIfAborted(signal);
  if (safeDateNow() >= deadline) throw new RepertoireCoordinationError('TIMEOUT');
}

function syncDirectory(path: string): void {
  coordinationFilesystemPolicy.syncDirectory(path);
}

function enforcePrivateDirectoryMode(path: string): void {
  coordinationFilesystemPolicy.sealPrivateDirectory(path);
}

function validateOptions(options: AcquireRepertoireCoordinationLeaseOptions): void {
  if (!isAbsolute(options.globalConfigDir)) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  if (options.mode !== 'read' && options.mode !== 'write') {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
  if (
    options.timeoutMs !== undefined
    && (!safeNumberIsSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
  ) {
    throw new RepertoireCoordinationError('UNSAFE_STATE');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RepertoireCoordinationError('ABORTED');
}

function currentUid(): number | null {
  return safeGetUid?.() ?? null;
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return safeDateToISOString(new SafeDate(value)) === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !safeArrayIsArray(value);
}

function isAlreadyExistsError(error: unknown): boolean {
  return errnoCode(error) === 'EEXIST';
}

function isMissingError(error: unknown): boolean {
  return errnoCode(error) === 'ENOENT';
}

function errnoCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    return (error as { code?: unknown }).code;
  } catch {
    return undefined;
  }
}

function normalizeCoordinationError(error: unknown): RepertoireCoordinationError {
  if (error instanceof CoordinationFilesystemPendingError) {
    return new RepertoireCoordinationError(error.malformed ? 'UNSAFE_STATE' : 'WRITER_PENDING');
  }
  return error instanceof RepertoireCoordinationError
    ? error
    : new RepertoireCoordinationError('UNSAFE_STATE');
}

function messageForCode(code: RepertoireCoordinationErrorCode): string {
  switch (code) {
    case 'ABORTED':
      return 'repertoire coordination was aborted';
    case 'MAINTENANCE_REQUIRED':
      return 'repertoire coordination maintenance is required before new readers can acquire';
    case 'RECOVERY_REQUIRED':
      return 'repertoire coordination requires operator recovery before acquisition can continue';
    case 'TIMEOUT':
      return 'repertoire coordination timed out';
    case 'UNSAFE_STATE':
      return 'repertoire coordination state cannot be proven safe';
    case 'WRITER_PENDING':
      return 'repertoire writer intent is pending';
  }
}
