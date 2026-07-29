import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { canonicalizeTaktpackJson } from './canonical-json.js';
import { calculateProjectTemplateManifestSha256 } from './binding.js';
import {
  inspectProjectTemplateApplyGuard,
  readProjectTemplateJsonStrict,
  resolveProjectTemplateRecoveryRequiredPath,
} from './apply-guard.js';
import {
  acquireProjectTemplateApplyLease,
  clearProjectTemplateRecoveryRequiredMarker,
  reclaimStaleProjectTemplateApplyLeaseForRecovery,
  writeProjectTemplateRecoveryRequiredMarker,
} from './apply-lease.js';
import type {
  ProjectTemplateApplyPlan,
  ProjectTemplateApplyPlanEntry,
  ProjectTemplateIncomingContent,
  ProjectTemplateIncomingInspectionEvidence,
} from './apply-plan-types.js';
import { createProjectTemplateApplyPlan } from './apply-plan.js';
import { runProjectTemplateDoctor } from './apply-doctor.js';
import {
  captureProjectTemplateBackupFile,
  initializeProjectTemplateApplyStorage,
  pruneProjectTemplateBackupGenerations,
  reclaimProjectTemplatePreparationOrphans,
  parseProjectTemplateApplyJournal,
  readProjectTemplateBackupManifest,
  removeProjectTemplateBackupGeneration,
  removeProjectTemplateStagingTransaction,
  resolveProjectTemplateApplyTarget,
  writeProjectTemplateApplyJournal,
  writeProjectTemplateBackupManifest,
  writeProjectTemplateStagingFile,
  type ProjectTemplateApplyJournal,
  type ProjectTemplateApplyStorage,
  type ProjectTemplateApplyStorageIo,
  type ProjectTemplateApplyTarget,
  type ProjectTemplateBackupEntryState,
  type ProjectTemplateBackupManifest,
  type ProjectTemplateBackupManifestEntry,
  type ProjectTemplateStagingFile,
} from './apply-storage.js';
import { parseProjectTemplateManifest } from './manifest.js';
import { parseTemplateLock } from './lock.js';
import { invalidateResolvedConfigCache } from '../../infra/config/resolutionCache.js';
import {
  calculateProjectTemplateTargetPreconditionToken,
  captureProjectTemplateTargetSnapshot,
} from './target-snapshot.js';
import type { ProjectTemplateManifestV1, TemplateLockV1 } from './types.js';

export const PROJECT_TEMPLATE_LOCK_PATH = '.takt-template-lock.json';

export type ProjectTemplateApplyNotStartedCode =
  | 'INVALID_APPLY_INPUT'
  | 'APPLY_GUARD_BLOCKED'
  | 'APPLY_LEASE_UNAVAILABLE'
  | 'TARGET_DRIFT'
  | 'BASE_LOCK_DRIFT'
  | 'APPLY_FAILED_ROLLED_BACK';

export type ProjectTemplateRollbackNotStartedCode =
  | 'APPLY_GUARD_BLOCKED'
  | 'APPLY_LEASE_UNAVAILABLE'
  | 'BACKUP_UNAVAILABLE'
  | 'ROLLBACK_DRIFT';

export type ProjectTemplateApplyResult =
  | { status: 'not_started'; code: ProjectTemplateApplyNotStartedCode; message: string }
  | { status: 'committed'; backupId: string; planId: string }
  | { status: 'recovery_required'; code: 'RECOVERY_REQUIRED'; backupId: string; message: string };

export type ProjectTemplateRollbackResult =
  | { status: 'not_started'; code: ProjectTemplateRollbackNotStartedCode; message: string }
  | { status: 'rolled_back'; backupId: string }
  | { status: 'recovery_required'; code: 'RECOVERY_REQUIRED'; backupId: string; message: string };

export type ProjectTemplateRecoveryResult =
  | { status: 'not_started'; code: 'NO_RECOVERY_STATE'; message: string }
  | { status: 'committed'; backupId: string; planId: string }
  | { status: 'rolled_back'; backupId: string }
  | { status: 'recovery_required'; code: 'RECOVERY_REQUIRED'; backupId: string; message: string };

interface ApplyOperationBase {
  target: ProjectTemplateApplyTarget;
  before: ProjectTemplateBackupEntryState;
  after: ProjectTemplateBackupEntryState;
}

interface ApplyWriteOperation extends ApplyOperationBase {
  action: 'add' | 'update';
  staged: ProjectTemplateStagingFile;
  after: Extract<ProjectTemplateBackupEntryState, { kind: 'file' }>;
}

interface ApplyDeleteOperation extends ApplyOperationBase {
  action: 'delete';
  after: Extract<ProjectTemplateBackupEntryState, { kind: 'absent' }>;
}

type ApplyOperation = ApplyWriteOperation | ApplyDeleteOperation;

type ChangedPlanEntry = ProjectTemplateApplyPlanEntry & {
  action: 'add' | 'update' | 'delete';
};

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mode(value: number): string {
  return `0${(value & 0o777).toString(8).padStart(3, '0')}`;
}

function planSeal(plan: ProjectTemplateApplyPlan): string {
  const body: Partial<ProjectTemplateApplyPlan> = { ...plan };
  delete body.planId;
  return hash(canonicalizeTaktpackJson(body));
}

function notStarted(
  code: ProjectTemplateApplyNotStartedCode,
  message: string,
): ProjectTemplateApplyResult {
  return { status: 'not_started', code, message };
}

function rollbackNotStarted(
  code: ProjectTemplateRollbackNotStartedCode,
  message: string,
): ProjectTemplateRollbackResult {
  return { status: 'not_started', code, message };
}

function buildLock(manifest: ProjectTemplateManifestV1): TemplateLockV1 {
  return {
    schemaVersion: '1.0',
    manifestSha256: calculateProjectTemplateManifestSha256(manifest),
    packVersion: manifest.packVersion,
    source: manifest.source,
    capabilities: [...(manifest.capabilities ?? [])],
    entries: manifest.entries.map((entry) => ({
      path: entry.path,
      policy: entry.policy,
      mode: entry.mode,
      sha256: entry.sha256,
      capabilities: [...(entry.capabilities ?? [])],
    })),
  };
}

function changedEntries(plan: ProjectTemplateApplyPlan): ChangedPlanEntry[] {
  return plan.entries
    .filter((entry): entry is ChangedPlanEntry =>
      entry.action === 'add'
      || entry.action === 'update'
      || entry.action === 'delete')
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function currentState(
  storage: ProjectTemplateApplyStorage,
  target: ProjectTemplateApplyTarget,
  maxBytes = 64 * 1024 * 1024,
): Promise<ProjectTemplateBackupEntryState> {
  const resolved = resolveProjectTemplateApplyTarget(storage, target);
  const stat = await safeLstat(resolved.absolutePath);
  if (stat === undefined) return { kind: 'absent' };
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.nlink !== 1
    || stat.dev !== storage.device
    || stat.size > maxBytes
  ) {
    throw new Error('target is not a safe bounded regular file');
  }
  const content = await storage.io.readFile(resolved.absolutePath, maxBytes);
  const after = await storage.io.lstat(resolved.absolutePath);
  // Hashing is only useful as a transaction witness if the inode and its
  // metadata stayed stable for the complete bounded read.
  if (
    stat.dev !== after.dev
    || stat.ino !== after.ino
    || stat.size !== after.size
    || stat.mode !== after.mode
    || stat.mtimeMs !== after.mtimeMs
    || stat.ctimeMs !== after.ctimeMs
    || stat.nlink !== after.nlink
  ) {
    throw new Error('target changed while it was read');
  }
  return {
    kind: 'file',
    sha256: hash(content),
    bytes: content.byteLength,
    mode: mode(after.mode),
    blobRelativePath: `blobs/${hash(content)}`,
    modifiedAt: after.mtime.toISOString(),
  };
}

function stateMatches(
  actual: ProjectTemplateBackupEntryState,
  expected: ProjectTemplateBackupEntryState,
  platform: NodeJS.Platform,
): boolean {
  return actual.kind === 'absent'
    ? expected.kind === 'absent'
    : expected.kind === 'file'
      && actual.sha256 === expected.sha256
      && actual.bytes === expected.bytes
      // Windows exposes only a subset of POSIX chmod semantics, so content
      // identity remains the transaction witness while mode is advisory.
      && (platform === 'win32' || actual.mode === expected.mode);
}

function operationKey(
  storage: ProjectTemplateApplyStorage,
  target: ProjectTemplateApplyTarget,
): string {
  return resolveProjectTemplateApplyTarget(storage, target).key;
}

function writeRecoveryMarker(options: {
  storage: ProjectTemplateApplyStorage;
  transactionId: string;
}): void {
  writeProjectTemplateRecoveryRequiredMarker(options.storage.repoRoot, {
    token: options.transactionId,
    transactionId: options.transactionId,
  });
}

function clearRecoveryMarker(
  storage: ProjectTemplateApplyStorage,
  transactionId: string,
): void {
  const marker = readProjectTemplateJsonStrict(
    resolveProjectTemplateRecoveryRequiredPath(storage.repoRoot),
  );
  if (marker.kind === 'missing') return;
  if (marker.kind !== 'value') {
    throw new Error('recovery marker cannot be proven safe');
  }
  clearProjectTemplateRecoveryRequiredMarker(storage.repoRoot, {
    token: transactionId,
    transactionId,
  });
}

async function readApplyJournal(
  storage: ProjectTemplateApplyStorage,
): Promise<ProjectTemplateApplyJournal | undefined> {
  if (await safeLstat(storage.journalPath) === undefined) return undefined;
  const content = await storage.io.readFile(storage.journalPath, 4 * 1024 * 1024);
  return parseProjectTemplateApplyJournal(
    JSON.parse(content.toString('utf8')) as unknown,
  );
}

async function ensureTargetParent(
  storage: ProjectTemplateApplyStorage,
  target: ProjectTemplateApplyTarget,
): Promise<void> {
  const resolved = resolveProjectTemplateApplyTarget(storage, target);
  if (target.kind === 'lock') return;
  const relativeParent = relative(storage.targetRoot, dirname(resolved.absolutePath))
    .split(sep).join('/');
  const directories = relativeParent === '' ? [] : relativeParent.split('/');
  let current = storage.targetRoot;
  for (const segment of ['', ...directories]) {
    if (segment !== '') current = join(current, segment);
    let stat = await safeLstat(current);
    if (stat === undefined) {
      await storage.io.mkdir(current, 0o700);
      // A directory is part of the transaction's visible state. Persist its
      // parent entry before publishing a file beneath it so recovery can
      // converge after a crash between mkdir and rename.
      await storage.io.fsyncDirectory(dirname(current));
      stat = await storage.io.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== storage.device) {
      throw new Error('target parent is unsafe');
    }
  }
}

function targetParentDirectories(
  storage: ProjectTemplateApplyStorage,
  target: ProjectTemplateApplyTarget,
): string[] {
  if (target.kind === 'lock') return [];
  const resolved = resolveProjectTemplateApplyTarget(storage, target);
  const relativeParent = relative(storage.targetRoot, dirname(resolved.absolutePath))
    .split(sep).join('/');
  const segments = relativeParent === '' ? [] : relativeParent.split('/');
  const directories = [''];
  let current = '';
  for (const segment of segments) {
    current = current === '' ? segment : `${current}/${segment}`;
    directories.push(current);
  }
  return directories;
}

async function collectMissingTargetDirectories(
  storage: ProjectTemplateApplyStorage,
  operations: readonly ApplyOperation[],
): Promise<string[]> {
  const candidates = new Set(
    operations.flatMap((operation) => targetParentDirectories(storage, operation.target)),
  );
  const missing: string[] = [];
  for (const relativePath of [...candidates].sort(
    (left, right) => left.split('/').length - right.split('/').length
      || left.localeCompare(right),
  )) {
    const absolutePath = relativePath === ''
      ? storage.targetRoot
      : join(storage.targetRoot, relativePath);
    const stat = await safeLstat(absolutePath);
    if (stat === undefined) {
      missing.push(relativePath);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== storage.device) {
      throw new Error('target parent is unsafe');
    }
  }
  return missing;
}

async function removeCreatedTargetDirectories(
  storage: ProjectTemplateApplyStorage,
  createdTargetDirectories: readonly string[],
): Promise<void> {
  const deepestFirst = [...createdTargetDirectories].sort(
    (left, right) => right.split('/').length - left.split('/').length
      || right.localeCompare(left),
  );
  for (const relativePath of deepestFirst) {
    const absolutePath = relativePath === ''
      ? storage.targetRoot
      : join(storage.targetRoot, relativePath);
    const before = await safeLstat(absolutePath);
    if (before === undefined) continue;
    if (before.isSymbolicLink() || !before.isDirectory() || before.dev !== storage.device) {
      throw new Error('created target directory is unsafe');
    }
    try {
      // rmdir performs the emptiness check atomically in the filesystem. Avoid
      // an unbounded pre-scan and preserve any directory that gained content.
      await storage.io.rmdir(absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') continue;
      throw error;
    }
    await storage.io.fsyncDirectory(dirname(absolutePath));
  }
}

async function publishStaged(
  storage: ProjectTemplateApplyStorage,
  staged: ProjectTemplateStagingFile,
): Promise<void> {
  const resolved = resolveProjectTemplateApplyTarget(storage, staged.target);
  await ensureTargetParent(storage, staged.target);
  // Publish only after the staged inode has its final mode and durable bytes,
  // so readers can never observe a committed path with temporary permissions.
  await storage.io.chmod(staged.absolutePath, Number.parseInt(staged.targetMode, 8));
  await storage.io.fsyncFile(staged.absolutePath);
  await storage.io.rename(staged.absolutePath, resolved.absolutePath);
  await storage.io.fsyncDirectory(dirname(resolved.absolutePath));
}

async function deleteTarget(
  storage: ProjectTemplateApplyStorage,
  target: ProjectTemplateApplyTarget,
): Promise<void> {
  const resolved = resolveProjectTemplateApplyTarget(storage, target);
  const stat = await storage.io.lstat(resolved.absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error('delete target is unsafe');
  }
  await storage.io.unlink(resolved.absolutePath);
  await storage.io.fsyncDirectory(dirname(resolved.absolutePath));
}

async function writeJournal(
  storage: ProjectTemplateApplyStorage,
  value: Omit<ProjectTemplateApplyJournal, 'schemaVersion'>,
): Promise<void> {
  await writeProjectTemplateApplyJournal({
    storage,
    journal: { schemaVersion: '1.0', ...value },
  });
}

async function verifyPlanTarget(
  projectRoot: string,
  plan: ProjectTemplateApplyPlan,
): Promise<boolean> {
  const snapshot = await captureProjectTemplateTargetSnapshot(
    projectRoot,
    plan.entries.map((entry) => entry.path),
  );
  return calculateProjectTemplateTargetPreconditionToken(snapshot) === plan.preconditionToken;
}

async function verifyBaseLock(
  storage: ProjectTemplateApplyStorage,
  plan: ProjectTemplateApplyPlan,
): Promise<
  | { matched: true; baseLock?: TemplateLockV1 }
  | { matched: false }
> {
  const state = await currentState(storage, { kind: 'lock' }, 4 * 1024 * 1024);
  if (plan.baseLockSha256 === undefined) {
    return state.kind === 'absent' ? { matched: true } : { matched: false };
  }
  if (state.kind !== 'file') return { matched: false };
  const content = await storage.io.readFile(storage.lockTargetPath, state.bytes);
  let parsed: TemplateLockV1;
  try {
    parsed = parseTemplateLock(JSON.parse(content.toString('utf8')) as unknown);
  } catch {
    return { matched: false };
  }
  return hash(canonicalizeTaktpackJson(parsed)) === plan.baseLockSha256
    ? { matched: true, baseLock: parsed }
    : { matched: false };
}

async function verifyCompletePlanSemantics(options: {
  projectRoot: string;
  plan: ProjectTemplateApplyPlan;
  manifest: ProjectTemplateManifestV1;
  contents: ReadonlyMap<string, Buffer>;
  incomingInspection: ProjectTemplateIncomingInspectionEvidence;
  baselineStrategy: 'conflict' | 'adopt-identical';
  baseLock?: TemplateLockV1;
}): Promise<boolean> {
  const candidatePaths = [
    ...new Set([
      ...(options.baseLock?.entries.map((entry) => entry.path) ?? []),
      ...options.manifest.entries.map((entry) => entry.path),
    ]),
  ];
  const snapshot = await captureProjectTemplateTargetSnapshot(
    options.projectRoot,
    candidatePaths,
  );
  let expected: ProjectTemplateApplyPlan;
  try {
    expected = createProjectTemplateApplyPlan({
      ...(options.baseLock === undefined ? {} : { baseLock: options.baseLock }),
      incomingManifest: options.manifest,
      localEntries: snapshot.entries,
      targetRootState: snapshot.rootState,
      missingPathTracking: snapshot.missingPathTracking,
      incomingContents: [...options.contents].map(([path, content]) => ({
        path,
        content,
      })),
      // This receipt comes from the archive inspection boundary, not from the
      // persisted plan. It independently seals archive/manifest compatibility
      // and prevents global plan fields from validating themselves.
      incomingInspection: options.incomingInspection,
      // Baseline adoption is an approval decision, not a fact that can be
      // inferred from a persisted plan. Keep it independent so a caller cannot
      // re-seal a conflict preview as an automatically adopted first install.
      baselineStrategy: options.baselineStrategy,
    });
  } catch {
    return false;
  }
  // The plan ID seals every entry field (path, action, policy, incoming/base/
  // current witnesses, mode, capabilities), summary, precondition and lock
  // intent metadata. Re-derivation prevents an attacker from changing a field
  // and merely recomputing the self-referential checksum.
  return expected.planId === options.plan.planId;
}

function validateApplyInput(options: {
  plan: ProjectTemplateApplyPlan;
  incomingManifest: ProjectTemplateManifestV1;
  incomingContents: readonly ProjectTemplateIncomingContent[];
}): {
  manifest: ProjectTemplateManifestV1;
  contents: Map<string, Buffer>;
} {
  const manifest = parseProjectTemplateManifest(options.incomingManifest);
  if (options.plan.schemaVersion !== '1.0') throw new Error('apply plan schema is invalid');
  if (options.plan.planId !== planSeal(options.plan)) throw new Error('apply plan seal is invalid');
  if (!options.plan.defaultApplyPossible || options.plan.reviewRequired) {
    throw new Error('apply plan requires explicit review');
  }
  if (
    options.plan.incomingManifestSha256
    !== calculateProjectTemplateManifestSha256(manifest)
  ) throw new Error('incoming manifest does not match the apply plan');
  const manifestByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const planByPath = new Map<string, ProjectTemplateApplyPlanEntry>();
  for (const entry of options.plan.entries) {
    if (planByPath.has(entry.path)) throw new Error('apply plan contains duplicate paths');
    planByPath.set(entry.path, entry);
  }
  for (const incoming of manifest.entries) {
    const planned = planByPath.get(incoming.path);
    if (
      planned === undefined
      || planned.incomingSha256 !== incoming.sha256
      || planned.incomingMode !== incoming.mode
      || canonicalizeTaktpackJson(planned.capabilitiesAfter)
        !== canonicalizeTaktpackJson(incoming.capabilities ?? [])
    ) {
      throw new Error('apply plan entries do not match the incoming manifest');
    }
  }
  for (const planned of options.plan.entries) {
    if (
      !manifestByPath.has(planned.path)
      && (
        planned.incomingSha256 !== undefined
        || planned.incomingMode !== undefined
        || planned.capabilitiesAfter.length !== 0
      )
    ) {
      throw new Error('apply plan contains an entry absent from the incoming manifest');
    }
  }
  const contents = new Map<string, Buffer>();
  for (const item of options.incomingContents) {
    const entry = manifestByPath.get(item.path);
    const content = Buffer.from(item.content);
    if (
      entry === undefined
      || contents.has(item.path)
      || hash(content) !== entry.sha256
    ) {
      throw new Error('incoming content is not sealed by the manifest');
    }
    contents.set(item.path, content);
  }
  for (const entry of changedEntries(options.plan)) {
    if (
      (entry.action === 'add' || entry.action === 'update')
      && (
        entry.afterSha256 === undefined
        || entry.afterMode === undefined
        || contents.get(entry.path) === undefined
        || hash(contents.get(entry.path)!) !== entry.afterSha256
      )
    ) {
      throw new Error('apply plan content evidence is incomplete');
    }
  }
  return { manifest, contents };
}

async function captureBefore(
  storage: ProjectTemplateApplyStorage,
  backupId: string,
  target: ProjectTemplateApplyTarget,
  expected: ProjectTemplateBackupEntryState,
): Promise<ProjectTemplateBackupEntryState> {
  if (expected.kind === 'absent') return expected;
  const stored = await captureProjectTemplateBackupFile({
    storage,
    backupId,
    target,
    expectedSha256: expected.sha256,
    expectedMode: expected.mode,
    maxBytes: expected.bytes,
  });
  return {
    kind: 'file',
    sha256: stored.sha256,
    bytes: stored.bytes,
    mode: stored.targetMode,
    blobRelativePath: stored.relativePath,
    modifiedAt: expected.modifiedAt,
  };
}

async function verifyManifestState(
  storage: ProjectTemplateApplyStorage,
  manifest: ProjectTemplateBackupManifest,
  side: 'before' | 'after',
): Promise<boolean> {
  for (const entry of manifest.entries) {
    if (!stateMatches(
      await currentState(storage, entry.target),
      entry[side],
      storage.platform,
    )) {
      return false;
    }
  }
  return true;
}

async function restoreOperations(
  storage: ProjectTemplateApplyStorage,
  manifest: ProjectTemplateBackupManifest,
  transactionId: string,
  operationKeys: ReadonlySet<string>,
): Promise<void> {
  const selected = manifest.entries.filter(
    (entry) => operationKeys.has(operationKey(storage, entry.target)),
  );
  for (const entry of [...selected].reverse()) {
    // The whole-set precheck is not enough: an editor can race between two
    // restores, so every target is witnessed again immediately before mutation.
    if (!stateMatches(
      await currentState(storage, entry.target),
      entry.after,
      storage.platform,
    )) {
      throw new Error('restore target drifted');
    }
    if (entry.before.kind === 'absent') {
      await deleteTarget(storage, entry.target);
      continue;
    }
    const blobPath = join(
      storage.backupsRoot,
      manifest.backupId,
      entry.before.blobRelativePath,
    );
    const content = await storage.io.readFile(blobPath, entry.before.bytes);
    if (hash(content) !== entry.before.sha256) {
      throw new Error('backup blob failed integrity validation');
    }
    const staged = await writeProjectTemplateStagingFile({
      storage,
      transactionId,
      target: entry.target,
      content,
      expectedSha256: entry.before.sha256,
      targetMode: entry.before.mode,
    });
    await publishStaged(storage, staged);
  }
}

export async function applyProjectTemplatePlan(options: {
  projectRoot: string;
  plan: ProjectTemplateApplyPlan;
  incomingManifest: ProjectTemplateManifestV1;
  incomingContents: readonly ProjectTemplateIncomingContent[];
  incomingInspection: ProjectTemplateIncomingInspectionEvidence;
  baselineStrategy: 'conflict' | 'adopt-identical';
  now?: Date;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<ProjectTemplateApplyResult> {
  let validated: ReturnType<typeof validateApplyInput>;
  try {
    validated = validateApplyInput(options);
  } catch {
    return notStarted('INVALID_APPLY_INPUT', 'project template apply input is invalid');
  }
  const initialGuard = inspectProjectTemplateApplyGuard({
    repoPath: options.projectRoot,
    now: options.now,
  });
  if (!initialGuard.passed) return notStarted('APPLY_GUARD_BLOCKED', initialGuard.blocks[0]!.message);
  let lease;
  try {
    lease = acquireProjectTemplateApplyLease(options.projectRoot);
  } catch {
    return notStarted('APPLY_LEASE_UNAVAILABLE', 'exclusive apply lease is unavailable');
  }

  let storage: ProjectTemplateApplyStorage | undefined;
  let backupId: string | undefined;
  let transactionId: string | undefined;
  let manifest: ProjectTemplateBackupManifest | undefined;
  let backupManifestPublished = false;
  let createdTargetDirectories: string[] = [];
  const completedOperations: string[] = [];
  let intentOperationKey: string | undefined;
  try {
    const ownedGuard = inspectProjectTemplateApplyGuard({
      repoPath: options.projectRoot,
      now: options.now,
      ownedLease: lease,
    });
    if (!ownedGuard.passed) {
      return notStarted('APPLY_GUARD_BLOCKED', ownedGuard.blocks[0]!.message);
    }
    if (!await verifyPlanTarget(options.projectRoot, options.plan)) {
      return notStarted('TARGET_DRIFT', 'project template target changed after preview');
    }
    storage = await initializeProjectTemplateApplyStorage({
      repoPath: options.projectRoot,
      ...(options.io === undefined ? {} : { io: options.io }),
    });
    await reclaimProjectTemplatePreparationOrphans({ storage });
    const baseLockVerification = await verifyBaseLock(storage, options.plan);
    if (!baseLockVerification.matched) {
      return notStarted('BASE_LOCK_DRIFT', 'formal template lock changed after preview');
    }
    if (!await verifyCompletePlanSemantics({
      projectRoot: options.projectRoot,
      plan: options.plan,
      manifest: validated.manifest,
      contents: validated.contents,
      incomingInspection: options.incomingInspection,
      baselineStrategy: options.baselineStrategy,
      ...(baseLockVerification.baseLock === undefined
        ? {}
        : { baseLock: baseLockVerification.baseLock }),
    })) {
      return notStarted(
        'INVALID_APPLY_INPUT',
        'apply plan semantics do not match current target and incoming manifest',
      );
    }
    backupId = `backup-${randomUUID()}`;
    transactionId = `apply-${randomUUID()}`;
    const operations: ApplyOperation[] = [];
    for (const entry of changedEntries(options.plan)) {
      const target = { kind: 'template-entry' as const, path: entry.path };
      const observedBefore = await currentState(storage, target);
      const before = entry.beforeSha256 === undefined
        ? { kind: 'absent' as const }
        : observedBefore.kind === 'file'
          ? {
            kind: 'file' as const,
            sha256: entry.beforeSha256,
            bytes: observedBefore.bytes,
            mode: entry.beforeMode!,
            blobRelativePath: `blobs/${entry.beforeSha256}`,
            modifiedAt: observedBefore.modifiedAt,
          }
          : (() => {
              throw new Error('planned backup source is absent');
            })();
      const capturedBefore = await captureBefore(storage, backupId, target, before);
      if (entry.action === 'delete') {
        operations.push({
          target,
          action: 'delete',
          before: capturedBefore,
          after: { kind: 'absent' },
        });
      } else {
        const content = validated.contents.get(entry.path)!;
        const staged = await writeProjectTemplateStagingFile({
          storage,
          transactionId,
          target,
          content,
          expectedSha256: entry.afterSha256!,
          targetMode: entry.afterMode!,
        });
        operations.push({
          target,
          action: entry.action,
          before: capturedBefore,
          after: {
            kind: 'file',
            sha256: staged.sha256,
            bytes: staged.bytes,
            mode: staged.targetMode,
            blobRelativePath: `blobs/${staged.sha256}`,
          },
          staged,
        });
      }
    }

    const lock = buildLock(validated.manifest);
    const lockContent = Buffer.from(canonicalizeTaktpackJson(lock));
    const lockTarget = { kind: 'lock' as const };
    const lockBeforeState = await currentState(storage, lockTarget);
    const capturedLockBefore = await captureBefore(storage, backupId, lockTarget, lockBeforeState);
    const stagedLock = await writeProjectTemplateStagingFile({
      storage,
      transactionId,
      target: lockTarget,
      content: lockContent,
      expectedSha256: hash(lockContent),
      targetMode: '0644',
    });
    operations.push({
      target: lockTarget,
      action: lockBeforeState.kind === 'absent' ? 'add' : 'update',
      before: capturedLockBefore,
      after: {
        kind: 'file',
        sha256: stagedLock.sha256,
        bytes: stagedLock.bytes,
        mode: stagedLock.targetMode,
        blobRelativePath: `blobs/${stagedLock.sha256}`,
      },
      staged: stagedLock,
    });

    createdTargetDirectories = await collectMissingTargetDirectories(storage, operations);
    manifest = {
      schemaVersion: '1.0',
      backupId,
      planId: options.plan.planId,
      preconditionToken: options.plan.preconditionToken,
      createdAt: (options.now ?? new Date()).toISOString(),
      createdTargetDirectories,
      entries: operations.map<ProjectTemplateBackupManifestEntry>((operation) => ({
        target: operation.target,
        action: operation.action,
        before: operation.before,
        after: operation.after,
      })),
    };
    await writeProjectTemplateBackupManifest({ storage, manifest });
    backupManifestPublished = true;
    await writeJournal(storage, {
      transactionId,
      planId: options.plan.planId,
      backupId,
      state: 'prepared',
      completedOperations,
      createdTargetDirectories,
      updatedAt: (options.now ?? new Date()).toISOString(),
    });
    for (const operation of operations) {
      intentOperationKey = operationKey(storage, operation.target);
      // The durable intent precedes the final witness and mutation. A crash can
      // therefore infer the sole uncertain operation from manifest order.
      await writeJournal(storage, {
        transactionId,
        planId: options.plan.planId,
        backupId,
        state: 'committing',
        completedOperations,
        createdTargetDirectories,
        updatedAt: new Date().toISOString(),
      });
      if (!stateMatches(
        await currentState(storage, operation.target),
        operation.before,
        storage.platform,
      )) {
        throw new Error('target drifted immediately before commit');
      }
      if (operation.action === 'delete') await deleteTarget(storage, operation.target);
      else await publishStaged(storage, operation.staged);
      completedOperations.push(intentOperationKey);
      await writeJournal(storage, {
        transactionId,
        planId: options.plan.planId,
        backupId,
        state: 'committing',
        completedOperations,
        createdTargetDirectories,
        updatedAt: new Date().toISOString(),
      });
      intentOperationKey = undefined;
    }
    await writeJournal(storage, {
      transactionId,
      planId: options.plan.planId,
      backupId,
      state: 'verifying',
      completedOperations,
      createdTargetDirectories,
      updatedAt: new Date().toISOString(),
    });
    if (!runProjectTemplateDoctor(options.projectRoot).passed) {
      throw new Error('post-apply doctor failed');
    }
    await writeJournal(storage, {
      transactionId,
      planId: options.plan.planId,
      backupId,
      state: 'committed',
      completedOperations,
      createdTargetDirectories,
      updatedAt: new Date().toISOString(),
    });
    await removeProjectTemplateStagingTransaction({ storage, transactionId });
    await pruneProjectTemplateBackupGenerations({
      storage,
      protectedBackupIds: [backupId],
    });
    return { status: 'committed', backupId, planId: options.plan.planId };
  } catch {
    if (
      storage !== undefined
      && !backupManifestPublished
      && backupId !== undefined
      && transactionId !== undefined
    ) {
      try {
        await removeProjectTemplateStagingTransaction({ storage, transactionId });
        await removeProjectTemplateBackupGeneration({ storage, backupId });
        return notStarted(
          'APPLY_FAILED_ROLLED_BACK',
          'apply preparation failed and partial artifacts were removed',
        );
      } catch {
        // No manifest/journal exists yet, so a recovery marker would be
        // impossible to clear through the recovery protocol. Leave the bounded
        // orphan for the next lease holder's preparation sweep instead.
        return notStarted(
          'APPLY_FAILED_ROLLED_BACK',
          'apply preparation failed; partial artifacts will be reclaimed on retry',
        );
      }
    }
    if (storage !== undefined && manifest !== undefined && transactionId !== undefined) {
      try {
        if (
          intentOperationKey !== undefined
          && !completedOperations.includes(intentOperationKey)
        ) {
          const pending = manifest.entries.find(
            (entry) => operationKey(storage!, entry.target) === intentOperationKey,
          );
          if (
            pending !== undefined
            && stateMatches(
              await currentState(storage, pending.target),
              pending.after,
              storage.platform,
            )
          ) {
            completedOperations.push(intentOperationKey);
          } else if (
            pending !== undefined
            && !stateMatches(
              await currentState(storage, pending.target),
              pending.before,
              storage.platform,
            )
          ) {
            throw new Error('pending operation state is indeterminate');
          }
        }
        if (completedOperations.length === 0) {
          await removeCreatedTargetDirectories(storage, manifest.createdTargetDirectories);
          if (!await verifyManifestState(storage, manifest, 'before')) {
            throw new Error('pre-mutation state cannot be verified');
          }
          await writeJournal(storage, {
            transactionId,
            planId: options.plan.planId,
            backupId: manifest.backupId,
            state: 'rolled-back',
            completedOperations,
            createdTargetDirectories,
            updatedAt: new Date().toISOString(),
          });
          await removeProjectTemplateStagingTransaction({ storage, transactionId });
          return notStarted(
            'APPLY_FAILED_ROLLED_BACK',
            'apply stopped before any target mutation',
          );
        }
        await writeJournal(storage, {
          transactionId,
          planId: options.plan.planId,
          backupId: manifest.backupId,
          state: 'rolling-back',
          completedOperations,
          createdTargetDirectories,
          updatedAt: new Date().toISOString(),
        });
        await restoreOperations(
          storage,
          manifest,
          `restore-${randomUUID()}`,
          new Set(completedOperations),
        );
        await removeCreatedTargetDirectories(storage, manifest.createdTargetDirectories);
        if (!await verifyManifestState(storage, manifest, 'before')) {
          throw new Error('compensation verification failed');
        }
        invalidateResolvedConfigCache(options.projectRoot);
        await writeJournal(storage, {
          transactionId,
          planId: options.plan.planId,
          backupId: manifest.backupId,
          state: 'rolled-back',
          completedOperations,
          createdTargetDirectories,
          updatedAt: new Date().toISOString(),
        });
        return notStarted('APPLY_FAILED_ROLLED_BACK', 'apply failed and was rolled back');
      } catch {
        try {
          writeRecoveryMarker({
            storage,
            transactionId,
          });
          await writeJournal(storage, {
            transactionId,
            planId: options.plan.planId,
            backupId: manifest.backupId,
            state: 'restore-failed',
            completedOperations,
            createdTargetDirectories,
            updatedAt: new Date().toISOString(),
          });
        } catch {
          // A recovery-required result remains fail-closed even if the storage
          // device cannot durably accept additional diagnostic evidence.
        }
        return {
          status: 'recovery_required',
          code: 'RECOVERY_REQUIRED',
          backupId: manifest.backupId,
          message: 'project template recovery is required',
        };
      }
    }
    return notStarted('APPLY_FAILED_ROLLED_BACK', 'apply stopped before target mutation');
  } finally {
    lease.release();
  }
}

export async function rollbackProjectTemplateApply(options: {
  projectRoot: string;
  backupId: string;
  now?: Date;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<ProjectTemplateRollbackResult> {
  const guard = inspectProjectTemplateApplyGuard({
    repoPath: options.projectRoot,
    now: options.now,
  });
  if (!guard.passed) return rollbackNotStarted('APPLY_GUARD_BLOCKED', guard.blocks[0]!.message);
  let lease;
  try {
    lease = acquireProjectTemplateApplyLease(options.projectRoot);
  } catch {
    return rollbackNotStarted('APPLY_LEASE_UNAVAILABLE', 'exclusive apply lease is unavailable');
  }
  let rollbackMutationStarted = false;
  try {
    const ownedGuard = inspectProjectTemplateApplyGuard({
      repoPath: options.projectRoot,
      now: options.now,
      ownedLease: lease,
    });
    if (!ownedGuard.passed) {
      return rollbackNotStarted(
        'APPLY_GUARD_BLOCKED',
        ownedGuard.blocks[0]!.message,
      );
    }
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: options.projectRoot,
      ...(options.io === undefined ? {} : { io: options.io }),
    });
    const manifest = await readProjectTemplateBackupManifest({
      storage,
      backupId: options.backupId,
    });
    for (const entry of manifest.entries) {
      if (!stateMatches(
        await currentState(storage, entry.target),
        entry.after,
        storage.platform,
      )) {
        return rollbackNotStarted('ROLLBACK_DRIFT', 'an applied target changed after apply');
      }
    }
    const transactionId = `rollback-${randomUUID()}`;
    const restoredOperations: string[] = [];
    // Everything above is read-only validation. Once this phase begins, even
    // a failed first journal write has uncertain durability and must retain
    // the recovery-required classification.
    rollbackMutationStarted = true;
    try {
      for (const entry of [...manifest.entries].reverse()) {
        const key = operationKey(storage, entry.target);
        await writeJournal(storage, {
          transactionId,
          planId: manifest.planId,
          backupId: manifest.backupId,
          state: 'rolling-back',
          completedOperations: restoredOperations,
          createdTargetDirectories: manifest.createdTargetDirectories,
          updatedAt: new Date().toISOString(),
        });
        await restoreOperations(
          storage,
          manifest,
          transactionId,
          new Set([key]),
        );
        restoredOperations.push(key);
        await writeJournal(storage, {
          transactionId,
          planId: manifest.planId,
          backupId: manifest.backupId,
          state: 'rolling-back',
          completedOperations: restoredOperations,
          createdTargetDirectories: manifest.createdTargetDirectories,
          updatedAt: new Date().toISOString(),
        });
      }
      await removeCreatedTargetDirectories(storage, manifest.createdTargetDirectories);
      if (!await verifyManifestState(storage, manifest, 'before')) {
        throw new Error('rollback verification failed');
      }
      invalidateResolvedConfigCache(options.projectRoot);
      await writeJournal(storage, {
        transactionId,
        planId: manifest.planId,
        backupId: manifest.backupId,
        state: 'rolled-back',
        completedOperations: restoredOperations,
        createdTargetDirectories: manifest.createdTargetDirectories,
        updatedAt: new Date().toISOString(),
      });
      await removeProjectTemplateStagingTransaction({ storage, transactionId });
      return { status: 'rolled_back', backupId: manifest.backupId };
    } catch {
      try {
        writeRecoveryMarker({
          storage,
          transactionId,
        });
        await writeJournal(storage, {
          transactionId,
          planId: manifest.planId,
          backupId: manifest.backupId,
          state: 'restore-failed',
          completedOperations: restoredOperations,
          createdTargetDirectories: manifest.createdTargetDirectories,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // Preserve the recovery-required outcome when durable storage is itself failing.
      }
      return {
        status: 'recovery_required',
        code: 'RECOVERY_REQUIRED',
        backupId: manifest.backupId,
        message: 'project template recovery is required',
      };
    }
  } catch {
    if (!rollbackMutationStarted) {
      return rollbackNotStarted(
        'BACKUP_UNAVAILABLE',
        'backup generation or rollback preconditions are unavailable',
      );
    }
    return {
      status: 'recovery_required',
      code: 'RECOVERY_REQUIRED',
      backupId: options.backupId,
      message: 'project template recovery is required',
    };
  } finally {
    lease.release();
  }
}

export async function recoverProjectTemplateApply(options: {
  projectRoot: string;
  now?: Date;
  io?: ProjectTemplateApplyStorageIo;
}): Promise<ProjectTemplateRecoveryResult> {
  let initialGuard = inspectProjectTemplateApplyGuard({
    repoPath: options.projectRoot,
    now: options.now,
  });
  if (initialGuard.blocks.some((block) => block.code === 'APPLY_LEASE_PRESENT')) {
    try {
      reclaimStaleProjectTemplateApplyLeaseForRecovery(options.projectRoot);
    } catch {
      return {
        status: 'recovery_required',
        code: 'RECOVERY_REQUIRED',
        backupId: 'unknown',
        message: 'project template recovery is blocked by coordination state',
      };
    }
    initialGuard = inspectProjectTemplateApplyGuard({
      repoPath: options.projectRoot,
      now: options.now,
    });
  }
  const nonRecoveryBlocks = initialGuard.blocks.filter(
    (block) => (block.code as string) !== 'RECOVERY_REQUIRED',
  );
  if (nonRecoveryBlocks.length > 0) {
    return {
      status: 'recovery_required',
      code: 'RECOVERY_REQUIRED',
      backupId: 'unknown',
      message: 'project template recovery is blocked by active runtime state',
    };
  }
  let lease;
  try {
    lease = acquireProjectTemplateApplyLease(options.projectRoot);
  } catch {
    return {
      status: 'recovery_required',
      code: 'RECOVERY_REQUIRED',
      backupId: 'unknown',
      message: 'project template recovery is blocked by coordination state',
    };
  }
  let storage: ProjectTemplateApplyStorage | undefined;
  let journal: ProjectTemplateApplyJournal | undefined;
  try {
    const ownedGuard = inspectProjectTemplateApplyGuard({
      repoPath: options.projectRoot,
      now: options.now,
      ownedLease: lease,
    });
    const ownedNonRecoveryBlocks = ownedGuard.blocks.filter(
      (block) => block.code !== 'RECOVERY_REQUIRED',
    );
    if (ownedNonRecoveryBlocks.length > 0) {
      return {
        status: 'recovery_required',
        code: 'RECOVERY_REQUIRED',
        backupId: 'unknown',
        message: 'project template recovery is blocked by active runtime state',
      };
    }
    storage = await initializeProjectTemplateApplyStorage({
      repoPath: options.projectRoot,
      ...(options.io === undefined ? {} : { io: options.io }),
    });
    journal = await readApplyJournal(storage);
    if (journal === undefined) {
      return {
        status: 'not_started',
        code: 'NO_RECOVERY_STATE',
        message: 'no project template recovery state exists',
      };
    }
    const manifest = await readProjectTemplateBackupManifest({
      storage,
      backupId: journal.backupId,
    });
    if (manifest.planId !== journal.planId) throw new Error('journal plan mismatch');
    if (
      manifest.createdTargetDirectories.length !== journal.createdTargetDirectories.length
      || manifest.createdTargetDirectories.some(
        (path, index) => path !== journal!.createdTargetDirectories[index],
      )
    ) {
      throw new Error('journal created-directory evidence mismatch');
    }

    if (journal.state === 'committed') {
      if (!await verifyManifestState(storage, manifest, 'after')) {
        throw new Error('committed state verification failed');
      }
      await removeProjectTemplateStagingTransaction({
        storage,
        transactionId: journal.transactionId,
      });
      clearRecoveryMarker(storage, journal.transactionId);
      return {
        status: 'committed',
        backupId: manifest.backupId,
        planId: manifest.planId,
      };
    }
    if (journal.state === 'rolled-back') {
      if (!await verifyManifestState(storage, manifest, 'before')) {
        throw new Error('rolled back state verification failed');
      }
      invalidateResolvedConfigCache(options.projectRoot);
      await removeProjectTemplateStagingTransaction({
        storage,
        transactionId: journal.transactionId,
      });
      clearRecoveryMarker(storage, journal.transactionId);
      return { status: 'rolled_back', backupId: manifest.backupId };
    }

    const mustRestore = new Set<string>();
    for (const entry of manifest.entries) {
      const actual = await currentState(storage, entry.target);
      if (stateMatches(actual, entry.before, storage.platform)) continue;
      if (stateMatches(actual, entry.after, storage.platform)) {
        mustRestore.add(operationKey(storage, entry.target));
        continue;
      }
      throw new Error('recovery target state is indeterminate');
    }
    const restored: string[] = [];
    const recoveryStagingId = `recover-${journal.transactionId}`;
    for (const entry of [...manifest.entries].reverse()) {
      const key = operationKey(storage, entry.target);
      if (!mustRestore.has(key)) continue;
      await writeJournal(storage, {
        transactionId: journal.transactionId,
        planId: journal.planId,
        backupId: journal.backupId,
        state: 'rolling-back',
        completedOperations: restored,
        createdTargetDirectories: manifest.createdTargetDirectories,
        updatedAt: new Date().toISOString(),
      });
      await restoreOperations(
        storage,
        manifest,
        recoveryStagingId,
        new Set([key]),
      );
      restored.push(key);
    }
    await removeCreatedTargetDirectories(storage, manifest.createdTargetDirectories);
    if (!await verifyManifestState(storage, manifest, 'before')) {
      throw new Error('recovery verification failed');
    }
    invalidateResolvedConfigCache(options.projectRoot);
    await writeJournal(storage, {
      transactionId: journal.transactionId,
      planId: journal.planId,
      backupId: journal.backupId,
      state: 'rolled-back',
      completedOperations: restored,
      createdTargetDirectories: manifest.createdTargetDirectories,
      updatedAt: new Date().toISOString(),
    });
    await removeProjectTemplateStagingTransaction({
      storage,
      transactionId: recoveryStagingId,
    });
    await removeProjectTemplateStagingTransaction({
      storage,
      transactionId: journal.transactionId,
    });
    clearRecoveryMarker(storage, journal.transactionId);
    return { status: 'rolled_back', backupId: manifest.backupId };
  } catch {
    if (storage !== undefined && journal !== undefined) {
      try {
        writeRecoveryMarker({
          storage,
          transactionId: journal.transactionId,
        });
      } catch {
        // The stable public result intentionally excludes filesystem details.
      }
    }
    return {
      status: 'recovery_required',
      code: 'RECOVERY_REQUIRED',
      backupId: journal?.backupId ?? 'unknown',
      message: 'project template recovery is required',
    };
  } finally {
    lease.release();
  }
}
