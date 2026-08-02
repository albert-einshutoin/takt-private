import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { join } from 'node:path';
import { canonicalizeTaktpackJson } from './canonical-json.js';
import {
  readProjectTemplateBackupManifest,
  resolveProjectTemplateApplyTarget,
  type ProjectTemplateApplyStorage,
  type ProjectTemplateApplyTarget,
  type ProjectTemplateBackupEntryState,
  type ProjectTemplateBackupManifest,
} from './apply-storage.js';
import { readProjectTemplateCompanionLockState } from './companion-lock-state-reader.js';
import {
  PROJECT_TEMPLATE_TRANSACTION_LIMITS,
  projectTemplateTransactionTargetByteLimit,
} from './transaction-limits.js';

const ROLLBACK_PLAN_DOMAIN = 'takt.project-template.rollback-plan.v1\u0000';
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_REGEXP_TEST = RegExp.prototype.test;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;

export interface ProjectTemplateRollbackPlan {
  readonly schemaVersion: '1.0';
  readonly backupId: string;
  readonly backupManifestSha256: string;
  readonly currentTargetSha256: string;
  readonly currentCompanionLocksSha256: string;
  readonly planId: string;
}

export interface CreateProjectTemplateRollbackPlanOptions {
  readonly backupId: string;
  readonly backupManifestSha256: string;
  readonly currentTargetSha256: string;
  readonly currentCompanionLocksSha256: string;
}

interface ActiveRollbackPlanAuthority {
  readonly storage: ProjectTemplateApplyStorage;
  readonly repoRoot: string;
  readonly manifest: ProjectTemplateBackupManifest;
  readonly backupBytes: ReadonlyMap<string, Buffer>;
  state: 'active' | 'consumed';
}

export interface ProjectTemplateRollbackPlanAuthority {
  readonly manifest: ProjectTemplateBackupManifest;
  readonly backupBytes: ReadonlyMap<string, Buffer>;
}

export class ProjectTemplateRollbackBackupUnavailableError extends Error {
  constructor() {
    super('rollback backup is unavailable');
    this.name = 'ProjectTemplateRollbackBackupUnavailableError';
  }
}

const ROLLBACK_PLAN_AUTHORITIES =
  new WeakMap<object, ActiveRollbackPlanAuthority>();

function requirePattern(value: unknown, pattern: RegExp): string {
  if (
    typeof value !== 'string'
    || !CAPTURED_REFLECT_APPLY(CAPTURED_REGEXP_TEST, pattern, [value])
  ) {
    throw new TypeError('rollback plan witness is invalid');
  }
  return value;
}

function snapshotExact(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      Object,
      [value],
    ) !== CAPTURED_OBJECT_PROTOTYPE
  ) throw new TypeError('rollback plan options are invalid');
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    Object,
    [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    Reflect,
    [descriptors],
  ) as PropertyKey[];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) throw new TypeError('rollback plan options are invalid');
  const snapshot: Record<string, unknown> = Object.create(null) as
    Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('rollback plan options are invalid');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function targetMode(value: number): string {
  return `0${(value & 0o777).toString(8).padStart(3, '0')}`;
}

async function currentState(
  storage: ProjectTemplateApplyStorage,
  target: ProjectTemplateApplyTarget,
): Promise<ProjectTemplateBackupEntryState> {
  const resolved = resolveProjectTemplateApplyTarget(storage, target);
  let before;
  try {
    before = await storage.io.lstat(resolved.absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  const maxBytes = projectTemplateTransactionTargetByteLimit(target.kind);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || before.dev !== storage.device
    || before.size > maxBytes
  ) throw new Error('rollback target is unsafe');
  const content = await storage.io.readFile(resolved.absolutePath, maxBytes);
  const after = await storage.io.lstat(resolved.absolutePath);
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.mode !== after.mode
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || before.nlink !== after.nlink
  ) throw new Error('rollback target changed during inspection');
  const digest = sha256(content);
  return {
    kind: 'file',
    sha256: digest,
    bytes: content.byteLength,
    mode: targetMode(after.mode),
    blobRelativePath: `blobs/${digest}`,
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
      && (platform === 'win32' || actual.mode === expected.mode);
}

function companionTargetKinds(
  targets: readonly ProjectTemplateApplyTarget[],
): string[] {
  return targets
    .filter((target) => target.kind === 'content-lock'
      || target.kind === 'repertoire-lock'
      || target.kind === 'source-provenance')
    .map((target) => target.kind)
    .sort();
}

function requireActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('rollback preview aborted', 'AbortError');
  }
}

/** @internal Reads every rollback blob before mutation authority is issued. */
export async function preflightProjectTemplateRollbackBackupBytes(options: {
  readonly storage: ProjectTemplateApplyStorage;
  readonly manifest: ProjectTemplateBackupManifest;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyMap<string, Buffer>> {
  const result = new Map<string, Buffer>();
  let totalBytes = 0;
  try {
    for (const entry of options.manifest.entries) {
      requireActive(options.signal);
      if (entry.before.kind === 'absent') continue;
      const target = resolveProjectTemplateApplyTarget(options.storage, entry.target);
      const maxBytes = projectTemplateTransactionTargetByteLimit(entry.target.kind);
      if (entry.before.bytes > maxBytes) {
        throw new ProjectTemplateRollbackBackupUnavailableError();
      }
      totalBytes += entry.before.bytes;
      if (
        !Number.isSafeInteger(totalBytes)
        || totalBytes > PROJECT_TEMPLATE_TRANSACTION_LIMITS.maxRecoveryBytes
      ) throw new ProjectTemplateRollbackBackupUnavailableError();
      const content = await options.storage.io.readPrivateFile(
        join(
          options.storage.backupsRoot,
          options.manifest.backupId,
          entry.before.blobRelativePath,
        ),
        entry.before.bytes,
        options.storage.device,
      );
      requireActive(options.signal);
      if (
        content.byteLength !== entry.before.bytes
        || sha256(content) !== entry.before.sha256
      ) throw new ProjectTemplateRollbackBackupUnavailableError();
      result.set(target.key, content);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (error instanceof ProjectTemplateRollbackBackupUnavailableError) throw error;
    throw new ProjectTemplateRollbackBackupUnavailableError();
  }
  return result;
}

/** Seals every read-only witness that must remain exact at rollback admission. */
export function createProjectTemplateRollbackPlan(
  options: CreateProjectTemplateRollbackPlanOptions,
): ProjectTemplateRollbackPlan {
  const captured = snapshotExact(options, [
    'backupId',
    'backupManifestSha256',
    'currentTargetSha256',
    'currentCompanionLocksSha256',
  ]);
  const backupId = requirePattern(captured['backupId'], SAFE_ID_PATTERN);
  const backupManifestSha256 = requirePattern(
    captured['backupManifestSha256'],
    SHA256_PATTERN,
  );
  const currentTargetSha256 = requirePattern(
    captured['currentTargetSha256'],
    SHA256_PATTERN,
  );
  const currentCompanionLocksSha256 = requirePattern(
    captured['currentCompanionLocksSha256'],
    SHA256_PATTERN,
  );
  const sealed = {
    schemaVersion: '1.0' as const,
    backupId,
    backupManifestSha256,
    currentTargetSha256,
    currentCompanionLocksSha256,
  };
  const planId = createHash('sha256').update(
    ROLLBACK_PLAN_DOMAIN + canonicalizeTaktpackJson(sealed),
    'utf8',
  ).digest('hex');
  return Object.freeze({ ...sealed, planId });
}

/** Reads and validates the exact durable backup and currently applied state. */
export async function deriveProjectTemplateRollbackPlan(options: {
  readonly storage: ProjectTemplateApplyStorage;
  readonly backupId: string;
  readonly signal?: AbortSignal;
}): Promise<ProjectTemplateRollbackPlan> {
  let captured: Record<string, unknown>;
  try {
    captured = snapshotExact(options, ['storage', 'backupId']);
  } catch {
    captured = snapshotExact(options, ['storage', 'backupId', 'signal']);
  }
  const storage = captured['storage'] as ProjectTemplateApplyStorage;
  const backupId = requirePattern(captured['backupId'], SAFE_ID_PATTERN);
  const signal = captured['signal'] as AbortSignal | undefined;
  requireActive(signal);
  const manifest = await readProjectTemplateBackupManifest({
    storage,
    backupId,
  });
  requireActive(signal);
  if (manifest.schemaVersion !== '1.1' || companionTargetKinds(
    manifest.entries.map((entry) => entry.target),
  ).join(',') !== 'content-lock,repertoire-lock,source-provenance') {
    throw new Error('rollback backup does not contain an exact companion cohort');
  }
  const backupBytes = await preflightProjectTemplateRollbackBackupBytes({
    storage,
    manifest,
    ...(signal === undefined ? {} : { signal }),
  });
  requireActive(signal);
  const states = [];
  for (const entry of manifest.entries) {
    requireActive(signal);
    const state = await currentState(storage, entry.target);
    requireActive(signal);
    if (!stateMatches(state, entry.after, storage.platform)) {
      throw new Error('rollback target drifted from the selected backup');
    }
    states.push({
      target: entry.target,
      state: state.kind === 'absent'
        ? { kind: 'absent' as const }
        : {
          kind: 'file' as const,
          sha256: state.sha256,
          bytes: state.bytes,
          mode: state.mode,
        },
    });
  }
  requireActive(signal);
  const companion = readProjectTemplateCompanionLockState(
    storage.repoRoot,
  );
  requireActive(signal);
  if (companion.state !== 'update') {
    throw new Error('rollback requires an exact installed companion cohort');
  }
  const plan = createProjectTemplateRollbackPlan({
    backupId: manifest.backupId,
    backupManifestSha256: sha256(canonicalizeTaktpackJson(manifest)),
    currentTargetSha256: sha256(canonicalizeTaktpackJson(states)),
    currentCompanionLocksSha256: companion.previousLocksSha256,
  });
  requireActive(signal);
  ROLLBACK_PLAN_AUTHORITIES.set(plan, {
    storage,
    repoRoot: storage.repoRoot,
    manifest,
    // Keep the validated bytes process-local so rollback never re-opens a
    // replaceable path after its durable journal has admitted mutation.
    backupBytes,
    state: 'active',
  });
  return plan;
}

/** @internal Consumes one process-local rollback derivation authority. */
export function consumeProjectTemplateRollbackPlanAuthority(options: {
  readonly plan: ProjectTemplateRollbackPlan;
  readonly storage: ProjectTemplateApplyStorage;
}): ProjectTemplateRollbackPlanAuthority | undefined {
  const authority = ROLLBACK_PLAN_AUTHORITIES.get(options.plan);
  if (
    authority === undefined
    || authority.state !== 'active'
    || authority.storage !== options.storage
    || authority.repoRoot !== options.storage.repoRoot
  ) return undefined;
  authority.state = 'consumed';
  return {
    manifest: authority.manifest,
    backupBytes: authority.backupBytes,
  };
}
