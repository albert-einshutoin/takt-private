import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { canonicalizeTaktpackJson } from './canonical-json.js';
import { DEFAULT_TAKTPACK_LIMITS } from './archive-types.js';
import { ProjectTemplateValidationError } from './errors.js';
import { portablePathKey } from './filesystem-scan.js';
import { parseTemplateLock } from './lock.js';
import { parseProjectTemplateManifest } from './manifest.js';
import { classifyProjectTemplateEntry } from './classifier-core.js';
import type {
  ProjectTemplateApplyAction,
  ProjectTemplateApplyPlan,
  ProjectTemplateApplyPlanEntry,
  ProjectTemplateApplyPlanInput,
  ProjectTemplateApplyReasonCode,
  ProjectTemplateEntryDiff,
  ProjectTemplateLocalSnapshotEntry,
  ProjectTemplateRollbackImpact,
} from './apply-plan-types.js';
import type {
  TemplateEntry,
  TemplateEntryPolicy,
  TemplateLockEntry,
} from './types.js';
import {
  assertAllowedKeys,
  MAX_TEMPLATE_ENTRIES,
  parsePortablePath,
  parsePosixMode,
  parseSha256,
  requireArray,
  requireRecord,
} from './validation.js';

const MAX_DIFF_INPUT_BYTES = 64 * 1024;
const MAX_DIFF_LINES = 1_000;
const MAX_DIFF_OUTPUT_CHARS = 16 * 1024;
const MAX_LOCAL_TOTAL_BYTES = 32 * 1024 * 1024;
const TRACKING_STATUSES = new Set<ProjectTemplateLocalSnapshotEntry['gitTrackingStatus']>([
  'tracked-clean',
  'tracked-modified',
  'staged',
  'untracked',
  'ignored',
  'unmerged',
  'not-repository',
  'unavailable',
]);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (
    typeof value !== 'object'
    || value === null
    || Object.isFrozen(value)
    || ArrayBuffer.isView(value)
  ) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function invalidInput(message: string, field: string): never {
  throw new ProjectTemplateValidationError('INVALID_ENTRY', message, field);
}

function parseLocalEntries(value: unknown): ProjectTemplateLocalSnapshotEntry[] {
  const values = requireArray(
    value,
    'localEntries',
    MAX_TEMPLATE_ENTRIES * 2,
    'INVALID_ENTRY',
  );
  const paths = new Set<string>();
  const portableKeys = new Set<string>();
  let totalBytes = 0;
  return values.map((raw, index) => {
    const field = `localEntries[${index}]`;
    const entry = requireRecord(raw, field);
    assertAllowedKeys(
      entry,
      ['path', 'mode', 'sha256', 'bytes', 'content', 'gitTrackingStatus'],
      field,
    );
    const path = parsePortablePath(entry['path'], `${field}.path`);
    const key = portablePathKey(path);
    if (paths.has(path) || portableKeys.has(key)) {
      invalidInput('local entries contain a duplicate portable destination', `${field}.path`);
    }
    paths.add(path);
    portableKeys.add(key);
    const mode = parsePosixMode(entry['mode'], `${field}.mode`);
    const digest = parseSha256(entry['sha256'], `${field}.sha256`);
    if (!Number.isSafeInteger(entry['bytes']) || (entry['bytes'] as number) < 0) {
      invalidInput('local entry bytes must be a nonnegative safe integer', `${field}.bytes`);
    }
    const bytes = entry['bytes'] as number;
    if (bytes > MAX_LOCAL_TOTAL_BYTES) {
      throw new ProjectTemplateValidationError(
        'LIMIT_EXCEEDED',
        'local entry exceeds the snapshot byte limit',
        `${field}.bytes`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_LOCAL_TOTAL_BYTES) {
      throw new ProjectTemplateValidationError(
        'LIMIT_EXCEEDED',
        'local entries exceed the snapshot byte budget',
        'localEntries',
      );
    }
    if (!TRACKING_STATUSES.has(
      entry['gitTrackingStatus'] as ProjectTemplateLocalSnapshotEntry['gitTrackingStatus'],
    )) {
      invalidInput('local entry Git tracking status is invalid', `${field}.gitTrackingStatus`);
    }
    const content = entry['content'];
    if (content !== undefined && !(content instanceof Uint8Array)) {
      invalidInput('local entry content must be bytes', `${field}.content`);
    }
    const copiedContent = content === undefined ? undefined : Buffer.from(content);
    if (
      copiedContent !== undefined
      && (
        copiedContent.byteLength !== entry['bytes']
        || sha256(copiedContent) !== digest
      )
    ) {
      invalidInput('local entry content does not match its snapshot', `${field}.content`);
    }
    return {
      path,
      mode,
      sha256: digest,
      bytes,
      ...(copiedContent === undefined ? {} : { content: copiedContent }),
      gitTrackingStatus:
        entry['gitTrackingStatus'] as ProjectTemplateLocalSnapshotEntry['gitTrackingStatus'],
    };
  });
}

function parseIncomingContents(
  value: unknown,
  incomingByPath: ReadonlyMap<string, TemplateEntry>,
): {
  contents: Map<string, Buffer>;
  reviewRequiredPaths: Set<string>;
} {
  const values = requireArray(
    value ?? [],
    'incomingContents',
    MAX_TEMPLATE_ENTRIES,
    'INVALID_ENTRY',
  );
  const contents = new Map<string, Buffer>();
  const reviewRequiredPaths = new Set<string>();
  let totalBytes = 0;
  for (const [index, raw] of values.entries()) {
    const field = `incomingContents[${index}]`;
    const item = requireRecord(raw, field);
    assertAllowedKeys(item, ['path', 'content'], field);
    const path = parsePortablePath(item['path'], `${field}.path`);
    if (contents.has(path)) {
      invalidInput('incoming content path is duplicated', `${field}.path`);
    }
    if (!(item['content'] instanceof Uint8Array)) {
      invalidInput('incoming content must be bytes', `${field}.content`);
    }
    if (item['content'].byteLength > DEFAULT_TAKTPACK_LIMITS.maxBlobBytes) {
      throw new ProjectTemplateValidationError(
        'LIMIT_EXCEEDED',
        'incoming content exceeds the blob byte limit',
        `${field}.content`,
      );
    }
    totalBytes += item['content'].byteLength;
    if (totalBytes > DEFAULT_TAKTPACK_LIMITS.maxTotalBytes) {
      throw new ProjectTemplateValidationError(
        'LIMIT_EXCEEDED',
        'incoming contents exceed the total byte limit',
        'incomingContents',
      );
    }
    const manifestEntry = incomingByPath.get(path);
    if (manifestEntry === undefined) {
      invalidInput('incoming content has no manifest entry', `${field}.path`);
    }
    const content = Buffer.from(item['content']);
    if (sha256(content) !== manifestEntry.sha256) {
      invalidInput('incoming content does not match the manifest', `${field}.content`);
    }
    if (content.byteLength > MAX_DIFF_INPUT_BYTES || content.includes(0)) {
      // Full portability inspection belongs to the validated archive boundary.
      // Raw large/binary inputs remain plannable, but never default-applicable.
      reviewRequiredPaths.add(path);
    } else {
      const classification = classifyProjectTemplateEntry({
        relativePath: path,
        mode: manifestEntry.mode,
        sha256: manifestEntry.sha256,
        bytes: content.byteLength,
        content,
      });
      if (classification.classification === 'blocked') {
        invalidInput('incoming content is blocked by portability policy', `${field}.content`);
      }
    }
    contents.set(path, content);
  }
  return { contents, reviewRequiredPaths };
}

function parseMissingPathTracking(
  value: unknown,
  knownPaths: ReadonlySet<string>,
): Record<string, ProjectTemplateLocalSnapshotEntry['gitTrackingStatus']> {
  if (value === undefined) return {};
  const record = requireRecord(value, 'missingPathTracking');
  if (Object.keys(record).length > MAX_TEMPLATE_ENTRIES * 2) {
    throw new ProjectTemplateValidationError(
      'LIMIT_EXCEEDED',
      'missing path tracking exceeds the entry limit',
      'missingPathTracking',
    );
  }
  const pairs: Array<[
    string,
    ProjectTemplateLocalSnapshotEntry['gitTrackingStatus'],
  ]> = [];
  for (const [rawPath, status] of Object.entries(record)) {
    const path = parsePortablePath(rawPath, 'missingPathTracking');
    if (!knownPaths.has(path)) {
      invalidInput('missing path tracking has no candidate entry', 'missingPathTracking');
    }
    if (!TRACKING_STATUSES.has(
      status as ProjectTemplateLocalSnapshotEntry['gitTrackingStatus'],
    )) {
      invalidInput('missing path Git tracking status is invalid', 'missingPathTracking');
    }
    pairs.push([
      path,
      status as ProjectTemplateLocalSnapshotEntry['gitTrackingStatus'],
    ]);
  }
  // Object.fromEntries creates an own data property for "__proto__", unlike
  // assignment on {}, so adversarial but portable filenames remain witnessed.
  return Object.fromEntries(pairs);
}

function sameState(
  left: Pick<TemplateLockEntry, 'sha256' | 'mode'> | ProjectTemplateLocalSnapshotEntry,
  right: Pick<TemplateEntry, 'sha256' | 'mode'> | TemplateLockEntry,
): boolean {
  return left.sha256 === right.sha256 && left.mode === right.mode;
}

function rollbackFor(action: ProjectTemplateApplyAction): ProjectTemplateRollbackImpact {
  switch (action) {
    case 'add': return 'remove-created';
    case 'update': return 'restore-existing';
    case 'delete': return 'restore-deleted';
    case 'conflict': return 'manual-conflict';
    case 'keep':
    case 'excluded':
      return 'none';
  }
}

function buildTextDiff(local: Buffer, incoming: Buffer): ProjectTemplateEntryDiff {
  if (
    local.byteLength > MAX_DIFF_INPUT_BYTES
    || incoming.byteLength > MAX_DIFF_INPUT_BYTES
  ) {
    return { kind: 'too-large' };
  }
  if (local.includes(0) || incoming.includes(0)) return { kind: 'binary' };
  let before: string;
  let after: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    before = decoder.decode(local);
    after = decoder.decode(incoming);
  } catch {
    return { kind: 'binary' };
  }
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  if (beforeLines.length > MAX_DIFF_LINES || afterLines.length > MAX_DIFF_LINES) {
    return { kind: 'too-large' };
  }

  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let beforeSuffix = beforeLines.length;
  let afterSuffix = afterLines.length;
  while (
    beforeSuffix > prefix
    && afterSuffix > prefix
    && beforeLines[beforeSuffix - 1] === afterLines[afterSuffix - 1]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }
  const lines = [
    '--- local',
    '+++ incoming',
    ...beforeLines.slice(Math.max(0, prefix - 2), prefix).map((line) => ` ${line}`),
    ...beforeLines.slice(prefix, beforeSuffix).map((line) => `-${line}`),
    ...afterLines.slice(prefix, afterSuffix).map((line) => `+${line}`),
    ...afterLines.slice(afterSuffix, Math.min(afterLines.length, afterSuffix + 2))
      .map((line) => ` ${line}`),
  ];
  const text = `${lines.join('\n')}\n`;
  if (text.length <= MAX_DIFF_OUTPUT_CHARS) {
    return { kind: 'text', text, truncated: false };
  }
  return {
    kind: 'text',
    text: `${text.slice(0, MAX_DIFF_OUTPUT_CHARS)}\n[diff truncated]\n`,
    truncated: true,
  };
}

function mustRedactDiff(
  path: string,
  mode: string,
  digest: string,
  content: Buffer,
): boolean {
  const classification = classifyProjectTemplateEntry({
    relativePath: path,
    mode,
    sha256: digest,
    bytes: content.byteLength,
    content,
  });
  return classification.classification === 'blocked'
    && (
      classification.reasonCode === 'SECRET_CONTENT'
      || classification.reasonCode === 'ABSOLUTE_PATH_CONTENT'
      || classification.reasonCode === 'SENSITIVE_FILENAME'
    );
}

function capabilitiesChanged(
  before: readonly string[],
  after: readonly string[],
): boolean {
  return before.length !== after.length
    || before.some((capability, index) => capability !== after[index]);
}

function decideAction(options: {
  base: TemplateLockEntry | undefined;
  local: ProjectTemplateLocalSnapshotEntry | undefined;
  incoming: TemplateEntry | undefined;
  policy: TemplateEntryPolicy;
  hasFormalBaseline: boolean;
  baselineStrategy: ProjectTemplateApplyPlanInput['baselineStrategy'];
}): { action: ProjectTemplateApplyAction; reasonCode: ProjectTemplateApplyReasonCode } {
  const {
    base,
    local,
    incoming,
    policy,
    hasFormalBaseline,
    baselineStrategy,
  } = options;
  if (base !== undefined && incoming !== undefined && base.policy !== incoming.policy) {
    return { action: 'conflict', reasonCode: 'POLICY_CHANGED' };
  }
  if (policy === 'excluded') {
    return { action: 'excluded', reasonCode: 'POLICY_EXCLUDED' };
  }
  if (policy === 'scaffold') {
    if (incoming !== undefined) {
      return local === undefined
        ? { action: 'add', reasonCode: 'SCAFFOLD_MISSING' }
        : { action: 'keep', reasonCode: 'SCAFFOLD_PRESERVED' };
    }
    return local === undefined
      ? { action: 'keep', reasonCode: 'ALREADY_ABSENT' }
      : { action: 'keep', reasonCode: 'SCAFFOLD_PRESERVED' };
  }
  if (base === undefined && incoming !== undefined) {
    if (local === undefined) return { action: 'add', reasonCode: 'NEW_ENTRY' };
    if (!hasFormalBaseline) {
      return baselineStrategy === 'adopt-identical' && sameState(local, incoming)
        ? { action: 'keep', reasonCode: 'BASELINE_ADOPTED' }
        : { action: 'conflict', reasonCode: 'LEGACY_BASELINE_REQUIRED' };
    }
    return sameState(local, incoming)
      ? { action: 'keep', reasonCode: 'ALREADY_CURRENT' }
      : { action: 'conflict', reasonCode: 'DESTINATION_EXISTS' };
  }
  if (base !== undefined && incoming === undefined) {
    if (local === undefined) return { action: 'keep', reasonCode: 'ALREADY_ABSENT' };
    return sameState(local, base)
      ? { action: 'delete', reasonCode: 'LOCAL_UNCHANGED_TEMPLATE_DELETED' }
      : { action: 'conflict', reasonCode: 'LOCAL_CHANGED_TEMPLATE_DELETED' };
  }
  if (base === undefined || incoming === undefined) {
    return { action: 'keep', reasonCode: 'ALREADY_ABSENT' };
  }
  if (local === undefined) {
    return sameState(base, incoming)
      ? { action: 'keep', reasonCode: 'LOCAL_DELETED' }
      : { action: 'conflict', reasonCode: 'LOCAL_DELETED_UPSTREAM_CHANGED' };
  }
  const localMatchesBase = sameState(local, base);
  const incomingMatchesBase = sameState(incoming, base);
  const localMatchesIncoming = sameState(local, incoming);
  if (localMatchesIncoming) {
    return incomingMatchesBase
      ? { action: 'keep', reasonCode: 'UNCHANGED' }
      : { action: 'keep', reasonCode: 'ALREADY_CURRENT' };
  }
  if (localMatchesBase) {
    return { action: 'update', reasonCode: 'UPSTREAM_CHANGED' };
  }
  if (incomingMatchesBase) {
    return { action: 'keep', reasonCode: 'LOCAL_CHANGED' };
  }
  return policy === 'merge'
    ? { action: 'conflict', reasonCode: 'SEMANTIC_MERGE_REQUIRED' }
    : { action: 'conflict', reasonCode: 'BOTH_CHANGED' };
}

function entryWithDecision(options: {
  path: string;
  base: TemplateLockEntry | undefined;
  local: ProjectTemplateLocalSnapshotEntry | undefined;
  incoming: TemplateEntry | undefined;
  policy: TemplateEntryPolicy;
  action: ProjectTemplateApplyAction;
  reasonCode: ProjectTemplateApplyReasonCode;
  incomingContent: Buffer | undefined;
  contentReviewRequired: boolean;
  gitTrackingStatus: ProjectTemplateApplyPlanEntry['gitTrackingStatus'];
}): ProjectTemplateApplyPlanEntry {
  const {
    path,
    base,
    local,
    incoming,
    policy,
    action,
    reasonCode,
    incomingContent,
    contentReviewRequired,
    gitTrackingStatus,
  } = options;
  let diff: ProjectTemplateEntryDiff | undefined;
  if (
    local !== undefined
    && incoming !== undefined
    && !sameState(local, incoming)
  ) {
    diff = local.bytes > MAX_DIFF_INPUT_BYTES
      || (incomingContent?.byteLength ?? 0) > MAX_DIFF_INPUT_BYTES
      ? { kind: 'too-large' }
      : local.content === undefined || incomingContent === undefined
        ? { kind: 'unavailable' }
        : mustRedactDiff(path, local.mode, local.sha256, Buffer.from(local.content))
          || mustRedactDiff(path, incoming.mode, incoming.sha256, incomingContent)
          ? { kind: 'redacted' }
          : buildTextDiff(Buffer.from(local.content), incomingContent);
  }
  const capabilitiesBefore = [...(base?.capabilities ?? [])];
  const capabilitiesAfter = [...(incoming?.capabilities ?? [])];
  const reviewRequired = contentReviewRequired
    || capabilitiesChanged(capabilitiesBefore, capabilitiesAfter)
    || gitTrackingStatus === 'staged'
    || gitTrackingStatus === 'unavailable'
    || gitTrackingStatus === 'unmerged';
  const common = {
    path,
    reasonCode,
    ...(local === undefined ? {} : {
      beforeSha256: local.sha256,
      beforeMode: local.mode,
    }),
    ...(base === undefined ? {} : { baseSha256: base.sha256 }),
    ...(incoming === undefined ? {} : {
      incomingSha256: incoming.sha256,
      incomingMode: incoming.mode,
    }),
    ...(action === 'add' || action === 'update'
      ? { afterSha256: incoming!.sha256, afterMode: incoming!.mode }
      : action === 'keep' || action === 'excluded'
        ? local === undefined
          ? {}
          : { afterSha256: local.sha256, afterMode: local.mode }
        : {}),
    capabilitiesBefore,
    capabilitiesAfter,
    gitTrackingStatus,
    rollbackImpact: rollbackFor(action),
    reviewRequired,
    ...(diff === undefined ? {} : { diff }),
  };
  switch (policy) {
    case 'managed':
      if (action === 'excluded') {
        invalidInput('managed policy produced an invalid action', 'action');
      }
      return { ...common, policy, action: action as Extract<ProjectTemplateApplyPlanEntry, { policy: 'managed' }>['action'] };
    case 'merge':
      if (action === 'excluded') {
        invalidInput('merge policy produced an invalid action', 'action');
      }
      return { ...common, policy, action: action as Extract<ProjectTemplateApplyPlanEntry, { policy: 'merge' }>['action'] };
    case 'scaffold':
      if (action !== 'add' && action !== 'keep' && action !== 'conflict') {
        invalidInput('scaffold policy produced an invalid action', 'action');
      }
      return { ...common, policy, action: action as Extract<ProjectTemplateApplyPlanEntry, { policy: 'scaffold' }>['action'] };
    case 'excluded':
      return { ...common, policy, action: 'excluded' };
  }
}

function overrideConflict(
  entry: ProjectTemplateApplyPlanEntry,
  reasonCode: ProjectTemplateApplyReasonCode,
): ProjectTemplateApplyPlanEntry {
  if (entry.policy === 'excluded') return entry;
  return {
    ...entry,
    action: 'conflict',
    reasonCode,
    rollbackImpact: 'manual-conflict',
  } as ProjectTemplateApplyPlanEntry;
}

function markRenameConflicts(
  entries: ProjectTemplateApplyPlanEntry[],
  baseByPath: ReadonlyMap<string, TemplateLockEntry>,
  incomingByPath: ReadonlyMap<string, TemplateEntry>,
): void {
  const removed = [...baseByPath.values()].filter((entry) => !incomingByPath.has(entry.path));
  const added = [...incomingByPath.values()].filter((entry) => !baseByPath.has(entry.path));
  const addedByPortableKey = new Map<string, TemplateEntry[]>();
  const addedByHash = new Map<string, TemplateEntry[]>();
  for (const entry of added) {
    const key = portablePathKey(entry.path);
    const portableBucket = addedByPortableKey.get(key);
    if (portableBucket === undefined) addedByPortableKey.set(key, [entry]);
    else portableBucket.push(entry);
    const hashBucket = addedByHash.get(entry.sha256);
    if (hashBucket === undefined) addedByHash.set(entry.sha256, [entry]);
    else hashBucket.push(entry);
  }
  const groups = new Map<string, {
    caseOnly: boolean;
    oldPaths: string[];
    newEntries: readonly TemplateEntry[];
  }>();
  for (const oldEntry of removed) {
    const caseMatches = addedByPortableKey.get(portablePathKey(oldEntry.path)) ?? [];
    const contentMatches = addedByHash.get(oldEntry.sha256) ?? [];
    const matches = caseMatches.length > 0 ? caseMatches : contentMatches;
    if (matches.length === 0) continue;
    const caseOnly = caseMatches.length > 0;
    const groupKey = caseOnly
      ? `case:${portablePathKey(oldEntry.path)}`
      : `hash:${oldEntry.sha256}`;
    const group = groups.get(groupKey);
    if (group === undefined) {
      groups.set(groupKey, {
        caseOnly,
        oldPaths: [oldEntry.path],
        newEntries: matches,
      });
    } else {
      group.oldPaths.push(oldEntry.path);
    }
  }
  const affected = new Map<string, ProjectTemplateApplyReasonCode>();
  for (const group of groups.values()) {
    const reasonCode: ProjectTemplateApplyReasonCode =
      group.oldPaths.length > 1 || group.newEntries.length > 1
        ? 'AMBIGUOUS_RENAME'
        : group.caseOnly
          ? 'CASE_ONLY_RENAME'
          : 'RENAME_DETECTED';
    for (const oldPath of group.oldPaths) affected.set(oldPath, reasonCode);
    for (const newEntry of group.newEntries) affected.set(newEntry.path, reasonCode);
  }
  for (const [index, entry] of entries.entries()) {
    const reasonCode = affected.get(entry.path);
    if (reasonCode !== undefined) entries[index] = overrideConflict(entry, reasonCode);
  }
}

function createSummary(entries: readonly ProjectTemplateApplyPlanEntry[]): {
  counts: Record<ProjectTemplateApplyAction, number>;
  human: string;
  json: string;
} {
  const counts: Record<ProjectTemplateApplyAction, number> = {
    add: 0,
    update: 0,
    keep: 0,
    delete: 0,
    conflict: 0,
    excluded: 0,
  };
  for (const entry of entries) counts[entry.action] += 1;
  const human = [
    `追加 ${counts.add}`,
    `更新 ${counts.update}`,
    `保持 ${counts.keep}`,
    `削除 ${counts.delete}`,
    `競合 ${counts.conflict}`,
    `除外 ${counts.excluded}`,
  ].join(' / ');
  return {
    counts,
    human,
    json: canonicalizeTaktpackJson({ counts }),
  };
}

/**
 * Produces a read-only decision artifact. All filesystem and Git observation
 * happens before this boundary so preview and apply can share exactly one
 * deterministic resolution table without this function mutating the target.
 */
export function createProjectTemplateApplyPlan(
  inputValue: ProjectTemplateApplyPlanInput,
): ProjectTemplateApplyPlan {
  const input = requireRecord(inputValue, 'applyPlan');
  assertAllowedKeys(
    input,
    [
      'baseLock',
      'incomingManifest',
      'localEntries',
      'targetRootState',
      'missingPathTracking',
      'incomingContents',
      'baselineStrategy',
    ],
    'applyPlan',
  );
  if (
    input['baselineStrategy'] !== undefined
    && input['baselineStrategy'] !== 'conflict'
    && input['baselineStrategy'] !== 'adopt-identical'
  ) {
    invalidInput('baseline strategy is invalid', 'baselineStrategy');
  }
  const baseLock = input['baseLock'] === undefined
    ? undefined
    : parseTemplateLock(input['baseLock']);
  const incomingManifest = parseProjectTemplateManifest(input['incomingManifest']);
  const localEntries = parseLocalEntries(input['localEntries']);
  const baseByPath = new Map(baseLock?.entries.map((entry) => [entry.path, entry]) ?? []);
  const incomingByPath = new Map(
    incomingManifest.entries.map((entry) => [entry.path, entry]),
  );
  const localByPath = new Map(localEntries.map((entry) => [entry.path, entry]));
  if (
    input['targetRootState'] !== undefined
    && input['targetRootState'] !== 'missing'
    && input['targetRootState'] !== 'directory'
  ) {
    invalidInput('target root state is invalid', 'targetRootState');
  }
  const {
    contents: incomingContents,
    reviewRequiredPaths: contentReviewRequiredPaths,
  } = parseIncomingContents(input['incomingContents'], incomingByPath);

  const paths = [...new Set([...baseByPath.keys(), ...incomingByPath.keys()])]
    .sort(compareAscii);
  const missingPathTracking = parseMissingPathTracking(
    input['missingPathTracking'],
    new Set(paths),
  );
  for (const path of Object.keys(missingPathTracking)) {
    if (localByPath.has(path)) {
      invalidInput('a path cannot be both present and missing', 'missingPathTracking');
    }
  }
  if (input['targetRootState'] === 'missing' && localEntries.length > 0) {
    invalidInput('a missing target root cannot contain local entries', 'localEntries');
  }
  const localPortableKeys = new Set(localEntries.map((entry) => portablePathKey(entry.path)));
  const targetEvidenceComplete = input['targetRootState'] !== undefined
    && paths.every((path) => (
      localByPath.has(path)
      || Object.hasOwn(missingPathTracking, path)
      || localPortableKeys.has(portablePathKey(path))
    ));
  const incomingEvidenceComplete = incomingManifest.entries.every(
    (entry) => entry.policy === 'excluded' || incomingContents.has(entry.path),
  );
  const entries = paths.map((path): ProjectTemplateApplyPlanEntry => {
    const base = baseByPath.get(path);
    const incoming = incomingByPath.get(path);
    const local = localByPath.get(path);
    // An unresolved policy transition still belongs to the previously applied
    // policy; this keeps the union honest instead of representing a conflict
    // as an already-excluded destination.
    const policy = base !== undefined
      && incoming !== undefined
      && base.policy !== incoming.policy
      ? base.policy
      : incoming?.policy ?? base!.policy;
    const decision = decideAction({
      base,
      local,
      incoming,
      policy,
      hasFormalBaseline: baseLock !== undefined,
      baselineStrategy:
        input['baselineStrategy'] as ProjectTemplateApplyPlanInput['baselineStrategy'],
    });
    return entryWithDecision({
      path,
      base,
      local,
      incoming,
      policy,
      ...decision,
      incomingContent: incomingContents.get(path),
      contentReviewRequired: contentReviewRequiredPaths.has(path),
      gitTrackingStatus: local?.gitTrackingStatus
        ?? missingPathTracking[path]
        ?? 'absent',
    });
  });
  markRenameConflicts(entries, baseByPath, incomingByPath);

  const plannedPortableKeys = new Map<string, string>();
  const entryIndexByPath = new Map(entries.map((entry, index) => [entry.path, index]));
  const localByPortableKey = new Map(
    localEntries.map((entry) => [portablePathKey(entry.path), entry.path]),
  );
  for (const [index, entry] of entries.entries()) {
    const key = portablePathKey(entry.path);
    const existing = plannedPortableKeys.get(key);
    if (existing !== undefined && existing !== entry.path) {
      entries[index] = overrideConflict(entry, 'DESTINATION_CASE_COLLISION');
      const existingIndex = entryIndexByPath.get(existing);
      if (existingIndex === undefined) {
        invalidInput('planned collision entry is missing', 'entries');
      }
      entries[existingIndex] = overrideConflict(
        entries[existingIndex]!,
        'DESTINATION_CASE_COLLISION',
      );
    } else {
      plannedPortableKeys.set(key, entry.path);
    }
    const localCollision = localByPortableKey.get(key);
    if (
      localCollision !== undefined
      && localCollision !== entry.path
      && entry.policy !== 'excluded'
    ) {
      entries[index] = overrideConflict(
        entries[index]!,
        'DESTINATION_CASE_COLLISION',
      );
    }
  }

  // Each path has at most the validated segment count, so ancestor lookup is
  // linear in total path length and cannot be confused by lexical siblings.
  const indexByPortableKey = new Map(
    entries.map((entry, index) => [portablePathKey(entry.path), index]),
  );
  for (const [index, entry] of entries.entries()) {
    const segments = portablePathKey(entry.path).split('/');
    let ancestorKey = '';
    for (const segment of segments.slice(0, -1)) {
      ancestorKey = ancestorKey === '' ? segment : `${ancestorKey}/${segment}`;
      const ancestorIndex = indexByPortableKey.get(ancestorKey);
      if (ancestorIndex === undefined) continue;
      entries[ancestorIndex] = overrideConflict(
        entries[ancestorIndex]!,
        'DESTINATION_PATH_COLLISION',
      );
      entries[index] = overrideConflict(
        entries[index]!,
        'DESTINATION_PATH_COLLISION',
      );
    }
  }

  const preconditionToken = sha256(canonicalizeTaktpackJson({
    candidatePaths: paths,
    targetRootState: input['targetRootState'] ?? 'directory',
    missingPathTracking,
    entries: localEntries
      .map(({ path, mode, sha256: digest, bytes, gitTrackingStatus }) => ({
        path,
        mode,
        sha256: digest,
        bytes,
        gitTrackingStatus,
      }))
      .sort((left, right) => compareAscii(left.path, right.path)),
  }));
  const incomingManifestSha256 = sha256(canonicalizeTaktpackJson(incomingManifest));
  const baseLockSha256 = baseLock === undefined
    ? undefined
    : sha256(canonicalizeTaktpackJson(baseLock));
  const capabilitiesBefore = [...(baseLock?.capabilities ?? [])];
  const capabilitiesAfter = [...(incomingManifest.capabilities ?? [])];
  const reviewRequired = capabilitiesChanged(capabilitiesBefore, capabilitiesAfter)
    || !targetEvidenceComplete
    || !incomingEvidenceComplete
    || Object.values(missingPathTracking).some(
      (status) => status === 'staged'
        || status === 'tracked-modified'
        || status === 'unmerged'
        || status === 'unavailable',
    )
    || entries.some(
      (entry) => entry.action === 'conflict' || entry.reviewRequired,
    );
  const defaultApplyPossible = !reviewRequired;
  const summary = createSummary(entries);
  const planBody = {
    schemaVersion: '1.0' as const,
    preconditionToken,
    ...(baseLockSha256 === undefined ? {} : { baseLockSha256 }),
    incomingManifestSha256,
    capabilitiesBefore,
    capabilitiesAfter,
    ...(baseLock === undefined ? {} : { basePackVersion: baseLock.packVersion }),
    incomingPackVersion: incomingManifest.packVersion,
    reviewRequired,
    defaultApplyPossible,
    entries,
    summary,
  };
  const planId = sha256(canonicalizeTaktpackJson(planBody));
  return deepFreeze({ ...planBody, planId });
}
