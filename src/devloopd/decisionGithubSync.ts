import { createHash, randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import {
  createDefaultDevloopCommandRunner,
  githubMetadataExecOptions,
  type DevloopCommandRunner,
} from './commandRunner.js';
import {
  createDecisionGithubSyncEvent,
  type DecisionGithubTarget,
  type DecisionProjection,
} from './decisionEvents.js';
import { DecisionStore } from './decisionStore.js';
import { withLockedDevloopLedgerTransaction } from './ledger.js';
import { withRepoKernelAdvisoryLock } from './repoExecutionClaim.js';

const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024;
const MAX_GITHUB_COMMENTS = 1_000;
const MAX_GITHUB_COMMENT_BODY_BYTES = 128 * 1024;
const MAX_RECONCILE_ATTEMPTS = 4;
const SYNC_LOCK_TIMEOUT_MS = 60_000;
const FIXED_SYNC_ERROR = 'GitHub同期に失敗しました。';
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export interface DecisionGithubPreview {
  readonly target: DecisionGithubTarget;
  readonly marker: string;
  readonly body: string;
  readonly sha256: string;
}

export type DecisionGithubSyncResult =
  | {
    readonly status: 'synced';
    readonly decisionId: string;
    readonly existing: boolean;
    readonly commentId: string;
    readonly commentUrl: string;
  }
  | {
    readonly status: 'failed';
    readonly decisionId: string;
    readonly errorCode:
      | 'decision_not_answered'
      | 'github_target_unavailable'
      | 'github_unavailable'
      | 'ledger_unavailable'
      | 'preview_binding_mismatch'
      | 'sync_state_changed'
      | 'sync_visibility_unconfirmed'
      | 'untrusted_github_response';
    readonly sanitizedError: string;
  };

type DecisionGithubSyncErrorCode = Extract<
  DecisionGithubSyncResult,
  { status: 'failed' }
>['errorCode'];

export interface SyncDecisionToGithubOptions {
  readonly store: DecisionStore;
  readonly decisionId: string;
  readonly expectedDecisionVersion: number;
  readonly expectedContextHash: string;
  readonly expectedPreviewSha256: string;
  readonly runner?: DevloopCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  /** Test-only boundary used to prove crash safety after posting intent is durable. */
  readonly afterPostingPersisted?: () => void;
  /** Test-only boundary used to prove an explicit 404 is durable before replacement. */
  readonly afterMissingPersisted?: () => void;
  /** Test-only boundary used to prove recovery after the external side effect. */
  readonly afterCommentCreated?: () => void;
}

interface GithubComment {
  readonly body: string;
  readonly commentId: string;
  readonly commentUrl: string;
  readonly viewerDidAuthor: boolean;
}

interface GithubView {
  readonly comments: readonly GithubComment[];
}

interface SafeCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface DecisionSyncSnapshot {
  readonly projection: DecisionProjection;
  readonly preview: DecisionGithubPreview;
  readonly fingerprint: string;
}

function targetFromProjection(projection: DecisionProjection): DecisionGithubTarget | undefined {
  const { repository, issueNumber, prNumber } = projection.request.subject;
  if (
    repository === undefined
    || (issueNumber === undefined) === (prNumber === undefined)
  ) {
    return undefined;
  }
  return Object.freeze(issueNumber === undefined
    ? { kind: 'pr' as const, repository, number: prNumber! }
    : { kind: 'issue' as const, repository, number: issueNumber });
}

function publicStatus(status: DecisionProjection['status']): string {
  switch (status) {
    case 'open': return '判断待ち';
    case 'answered': return '回答済み';
    case 'applying': return '適用中';
    case 'applied': return '適用済み';
    case 'revalidation_required': return '再確認が必要';
  }
}

function renderPreviewBody(
  projection: DecisionProjection,
  marker: string,
  status: DecisionProjection['status'],
): string {
  const { decisionId, decisionVersion } = projection.request;
  return [
    marker,
    '### Takt 判断ステータス',
    '',
    `- 判断ID: \`${decisionId}\``,
    `- バージョン: ${decisionVersion}`,
    `- 状態: ${publicStatus(status)}`,
    `- 種別: ${projection.request.kind}`,
    '',
    '回答内容・理由・証跡はローカル判断台帳にのみ保存されています。',
    '',
  ].join('\n');
}

export function buildDecisionGithubPreview(
  projection: DecisionProjection,
): DecisionGithubPreview {
  const target = targetFromProjection(projection);
  if (target === undefined) {
    throw new Error('decision GitHub target is unavailable');
  }
  const { decisionId, decisionVersion } = projection.request;
  const marker = `<!-- takt-decision:v1 id=${decisionId} version=${decisionVersion} -->`;
  // GitHub is an optional notification surface, not the source of truth. Keep
  // this body intentionally fixed: user answers, rationale, evidence, local
  // paths, and private task prose must remain only in the local ledger.
  const body = renderPreviewBody(projection, marker, projection.status);
  // The canonical envelope is the sole digest input so preview generation and
  // write authorization cannot silently drift into separate representations.
  // Keep keys in lexicographic order to match Swift JSONEncoder.sortedKeys;
  // JSON.stringify leaves slashes unescaped, matching withoutEscapingSlashes.
  const envelope = JSON.stringify({
    body,
    marker,
    target: {
      kind: target.kind,
      number: target.number,
      repository: target.repository,
    },
  });
  const sha256 = createHash('sha256').update(envelope, 'utf8').digest('hex');
  return Object.freeze({ target, marker, body, sha256 });
}

function sameTarget(left: DecisionGithubTarget, right: DecisionGithubTarget): boolean {
  return left.kind === right.kind
    && left.repository === right.repository
    && left.number === right.number;
}

function transitionIdentity(projection: DecisionProjection): {
  decisionId: string;
  decisionVersion: number;
  contextHash: string;
} {
  return {
    decisionId: projection.request.decisionId,
    decisionVersion: projection.request.decisionVersion,
    contextHash: projection.request.contextHash,
  };
}

function failed(
  decisionId: string,
  errorCode: DecisionGithubSyncErrorCode,
): DecisionGithubSyncResult {
  return Object.freeze({
    status: 'failed',
    decisionId,
    errorCode,
    sanitizedError: FIXED_SYNC_ERROR,
  });
}

function appendSyncEvent(
  store: DecisionStore,
  decisionId: string,
  target: DecisionGithubTarget,
  state:
    | {
      status: 'pending';
      phase?: 'inspecting' | 'posting';
      attemptId?: string;
    }
    | { status: 'synced'; commentId: string; commentUrl: string }
    | { status: 'verified'; commentId: string; commentUrl: string }
    | {
      status: 'missing';
      missingCommentId: string;
      missingCommentUrl: string;
      attemptId: string;
    }
    | {
      status: 'failed';
      sanitizedError: string;
      phase?: 'inspecting' | 'posting';
      attemptId?: string;
      outcome?: 'definitely_not_posted' | 'may_have_posted';
    },
): DecisionProjection {
  return withLockedDevloopLedgerTransaction(store.ledgerPath, (transaction) => {
    const projection = store.get(decisionId);
    if (projection === undefined) throw new Error('decision not found');
    const currentTarget = targetFromProjection(projection);
    if (currentTarget === undefined || !sameTarget(currentTarget, target)) {
      throw new Error('decision target changed');
    }
    transaction.append(createDecisionGithubSyncEvent({
      ...transitionIdentity(projection),
      target,
      ...state,
    }));
    return projection;
  });
}

function appendVerifiedComment(
  store: DecisionStore,
  decisionId: string,
  target: DecisionGithubTarget,
  comment: { readonly commentId: string; readonly commentUrl: string },
): void {
  withLockedDevloopLedgerTransaction(store.ledgerPath, (transaction) => {
    const projection = store.get(decisionId);
    if (projection === undefined) throw new Error('decision not found');
    const currentTarget = targetFromProjection(projection);
    if (currentTarget === undefined || !sameTarget(currentTarget, target)) {
      throw new Error('decision target changed');
    }
    transaction.append(createDecisionGithubSyncEvent({
      ...transitionIdentity(projection),
      target,
      status: 'verified',
      commentId: comment.commentId,
      commentUrl: comment.commentUrl,
    }));
  });
}

function appendMissingComment(
  store: DecisionStore,
  decisionId: string,
  target: DecisionGithubTarget,
  comment: { readonly commentId: string; readonly commentUrl: string },
  attemptId: string,
): void {
  withLockedDevloopLedgerTransaction(store.ledgerPath, (transaction) => {
    const projection = store.get(decisionId);
    if (projection === undefined) throw new Error('decision not found');
    const currentTarget = targetFromProjection(projection);
    if (
      currentTarget === undefined
      || !sameTarget(currentTarget, target)
      || projection.githubSync?.knownCommentId !== comment.commentId
      || projection.githubSync.knownCommentUrl !== comment.commentUrl
    ) {
      throw new Error('known GitHub comment changed');
    }
    transaction.append(createDecisionGithubSyncEvent({
      ...transitionIdentity(projection),
      target,
      status: 'missing',
      missingCommentId: comment.commentId,
      missingCommentUrl: comment.commentUrl,
      attemptId,
    }));
  });
}

function appendFailure(
  store: DecisionStore,
  decisionId: string,
  target: DecisionGithubTarget,
  errorCode:
    | 'github_unavailable'
    | 'sync_state_changed'
    | 'sync_visibility_unconfirmed'
    | 'untrusted_github_response',
  state: {
    readonly phase: 'inspecting' | 'posting';
    readonly attemptId: string;
    readonly outcome: 'definitely_not_posted' | 'may_have_posted';
  },
): DecisionGithubSyncResult {
  try {
    appendSyncEvent(store, decisionId, target, {
      status: 'failed',
      sanitizedError: FIXED_SYNC_ERROR,
      ...state,
    });
    return failed(decisionId, errorCode);
  } catch {
    return failed(decisionId, 'ledger_unavailable');
  }
}

function appendPendingIfCurrent(
  store: DecisionStore,
  decisionId: string,
  target: DecisionGithubTarget,
  fingerprint: string,
  phase: 'inspecting' | 'posting',
  attemptId: string,
): boolean {
  return withLockedDevloopLedgerTransaction(store.ledgerPath, (transaction) => {
    const projection = store.get(decisionId);
    if (projection === undefined) return false;
    const currentTarget = targetFromProjection(projection);
    const snapshot = snapshotFromProjection(projection);
    if (
      currentTarget === undefined
      || !sameTarget(currentTarget, target)
      || snapshot?.fingerprint !== fingerprint
    ) {
      return false;
    }
    transaction.append(createDecisionGithubSyncEvent({
      ...transitionIdentity(projection),
      target,
      status: 'pending',
      phase,
      attemptId,
    }));
    return true;
  });
}

function snapshotFromProjection(
  projection: DecisionProjection,
): DecisionSyncSnapshot | undefined {
  if (projection.answer === undefined) return undefined;
  try {
    const preview = buildDecisionGithubPreview(projection);
    return Object.freeze({
      projection,
      preview,
      fingerprint: preview.sha256,
    });
  } catch {
    return undefined;
  }
}

function currentSnapshotState(
  options: SyncDecisionToGithubOptions,
  expectedFingerprint: string,
  requireWriteSafe: boolean,
): 'current' | 'changed' | 'unavailable' {
  try {
    const projection = options.store.get(options.decisionId);
    if (projection === undefined) return 'changed';
    const snapshot = snapshotFromProjection(projection);
    if (
      snapshot === undefined
      || snapshot.projection.request.decisionVersion !== options.expectedDecisionVersion
      || snapshot.projection.request.contextHash !== options.expectedContextHash
      || snapshot.preview.sha256 !== options.expectedPreviewSha256
      || snapshot.fingerprint !== expectedFingerprint
      || (requireWriteSafe && snapshot.projection.githubSync?.postUncertain === true)
    ) {
      return 'changed';
    }
    return 'current';
  } catch {
    return 'unavailable';
  }
}

function appendSyncedIfCurrent(
  store: DecisionStore,
  decisionId: string,
  target: DecisionGithubTarget,
  fingerprint: string,
  comment: { readonly commentId: string; readonly commentUrl: string },
): boolean {
  return withLockedDevloopLedgerTransaction(store.ledgerPath, (transaction) => {
    const projection = store.get(decisionId);
    if (projection === undefined) return false;
    const currentTarget = targetFromProjection(projection);
    const snapshot = snapshotFromProjection(projection);
    if (
      currentTarget === undefined
      || !sameTarget(currentTarget, target)
      || snapshot?.fingerprint !== fingerprint
    ) {
      return false;
    }
    transaction.append(createDecisionGithubSyncEvent({
      ...transitionIdentity(projection),
      target,
      status: 'synced',
      commentId: comment.commentId,
      commentUrl: comment.commentUrl,
    }));
    return true;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function expectedTargetUrl(target: DecisionGithubTarget): string {
  const collection = target.kind === 'issue' ? 'issues' : 'pull';
  return `https://github.com/${target.repository}/${collection}/${target.number}`;
}

function parseCommentUrl(value: unknown, target: DecisionGithubTarget): {
  commentId: string;
  commentUrl: string;
} | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined;
  const match = /#issuecomment-([1-9][0-9]*)$/u.exec(value);
  if (match?.[1] === undefined || !IDENTIFIER_PATTERN.test(match[1])) return undefined;
  if (value !== `${expectedTargetUrl(target)}#issuecomment-${match[1]}`) return undefined;
  return { commentId: match[1], commentUrl: value };
}

function parseGithubView(stdout: string, target: DecisionGithubTarget): GithubView | undefined {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_GITHUB_RESPONSE_BYTES) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(raw)) return undefined;
  if (
    Reflect.get(raw, 'number') !== target.number
    || Reflect.get(raw, 'url') !== expectedTargetUrl(target)
  ) {
    return undefined;
  }
  const rawComments = Reflect.get(raw, 'comments');
  if (!Array.isArray(rawComments) || rawComments.length > MAX_GITHUB_COMMENTS) return undefined;
  const comments: GithubComment[] = [];
  for (const rawComment of rawComments) {
    if (!isPlainRecord(rawComment)) return undefined;
    const body = Reflect.get(rawComment, 'body');
    const viewerDidAuthor = Reflect.get(rawComment, 'viewerDidAuthor');
    const parsedUrl = parseCommentUrl(Reflect.get(rawComment, 'url'), target);
    if (
      typeof body !== 'string'
      || typeof viewerDidAuthor !== 'boolean'
      || Buffer.byteLength(body, 'utf8') > MAX_GITHUB_COMMENT_BODY_BYTES
      || parsedUrl === undefined
    ) {
      return undefined;
    }
    comments.push(Object.freeze({ body, viewerDidAuthor, ...parsedUrl }));
  }
  return Object.freeze({ comments: Object.freeze(comments) });
}

function findManagedComment(
  view: GithubView,
  preview: DecisionGithubPreview,
  projection: DecisionProjection,
): { readonly comment: GithubComment; readonly current: boolean } | 'collision' | undefined {
  let managed: GithubComment | undefined;
  const allowedBodies = new Set<DecisionProjection['status']>([
    'open',
    'answered',
    'applying',
    'applied',
    'revalidation_required',
  ]);
  const validGeneratedBodies = new Set(
    [...allowedBodies].map((status) => renderPreviewBody(projection, preview.marker, status)),
  );
  for (const comment of view.comments) {
    const referencesCurrentDecision =
      comment.body.includes(`id=${projection.request.decisionId} `);
    const containsCurrentMarker = comment.body.includes(preview.marker);
    if (containsCurrentMarker || (
      referencesCurrentDecision
      && comment.body.includes('takt-decision:')
    )) {
      if (
        managed !== undefined
        || !comment.viewerDidAuthor
        || !comment.body.startsWith(`${preview.marker}\n`)
        || !validGeneratedBodies.has(comment.body)
      ) {
        return 'collision';
      }
      managed = comment;
    }
  }
  return managed === undefined
    ? undefined
    : Object.freeze({ comment: managed, current: managed.body === preview.body });
}

function parseUpdatedComment(
  stdout: string,
  target: DecisionGithubTarget,
  expected: GithubComment,
  expectedBody: string,
): GithubComment | undefined {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_GITHUB_RESPONSE_BYTES) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(raw)) return undefined;
  const parsedUrl = parseCommentUrl(Reflect.get(raw, 'html_url'), target);
  const rawId = Reflect.get(raw, 'id');
  const id = typeof rawId === 'number' && Number.isSafeInteger(rawId)
    ? String(rawId)
    : typeof rawId === 'string' ? rawId : undefined;
  if (
    parsedUrl === undefined
    || parsedUrl.commentId !== expected.commentId
    || parsedUrl.commentUrl !== expected.commentUrl
    || id !== expected.commentId
    || Reflect.get(raw, 'body') !== expectedBody
  ) {
    return undefined;
  }
  return Object.freeze({
    body: expectedBody,
    commentId: parsedUrl.commentId,
    commentUrl: parsedUrl.commentUrl,
    viewerDidAuthor: true,
  });
}

function parseKnownComment(
  stdout: string,
  target: DecisionGithubTarget,
  expected: { readonly commentId: string; readonly commentUrl: string },
  preview: DecisionGithubPreview,
  projection: DecisionProjection,
): GithubComment | undefined {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_GITHUB_RESPONSE_BYTES) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(raw)) return undefined;
  const body = Reflect.get(raw, 'body');
  const parsedUrl = parseCommentUrl(Reflect.get(raw, 'html_url'), target);
  const rawId = Reflect.get(raw, 'id');
  const id = typeof rawId === 'number' && Number.isSafeInteger(rawId)
    ? String(rawId)
    : typeof rawId === 'string' ? rawId : undefined;
  if (
    typeof body !== 'string'
    || Buffer.byteLength(body, 'utf8') > MAX_GITHUB_COMMENT_BODY_BYTES
    || parsedUrl === undefined
    || parsedUrl.commentId !== expected.commentId
    || parsedUrl.commentUrl !== expected.commentUrl
    || id !== expected.commentId
  ) {
    return undefined;
  }
  const comment = Object.freeze({
    body,
    commentId: parsedUrl.commentId,
    commentUrl: parsedUrl.commentUrl,
    // The local synced event records a comment previously verified as owned.
    // The REST endpoint establishes that the same immutable comment ID remains.
    viewerDidAuthor: true,
  });
  const managed = findManagedComment(
    Object.freeze({ comments: Object.freeze([comment]) }),
    preview,
    projection,
  );
  return managed === 'collision' || managed === undefined ? undefined : managed.comment;
}

function isExplicitGithubNotFound(result: SafeCommandResult): boolean {
  return result.exitCode !== 0
    && result.stdout === ''
    && result.stderr.trim() === 'gh: Not Found (HTTP 404)';
}

function safeCommandResult(value: unknown): SafeCommandResult | undefined {
  if (!isPlainRecord(value)) return undefined;
  try {
    const exitCodeDescriptor = Object.getOwnPropertyDescriptor(value, 'exitCode');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(value, 'stdout');
    const stderrDescriptor = Object.getOwnPropertyDescriptor(value, 'stderr');
    const exitCode = exitCodeDescriptor?.value;
    const stdout = stdoutDescriptor?.value;
    const stderr = stderrDescriptor?.value;
    if (
      exitCodeDescriptor?.get !== undefined
      || stdoutDescriptor?.get !== undefined
      || stderrDescriptor?.get !== undefined
      || !Number.isInteger(exitCode)
      || typeof stdout !== 'string'
      || typeof stderr !== 'string'
      || Buffer.byteLength(stdout, 'utf8') > MAX_GITHUB_RESPONSE_BYTES
      || Buffer.byteLength(stderr, 'utf8') > MAX_GITHUB_RESPONSE_BYTES
    ) {
      return undefined;
    }
    return {
      exitCode: exitCode as number,
      stdout,
      stderr,
    };
  } catch {
    return undefined;
  }
}

function commandPath(runner: DevloopCommandRunner, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const resolved = runner.resolveCommand('gh', env);
    if (
      typeof resolved !== 'string'
      || resolved.length === 0
      || resolved.length > 4_096
      || [...resolved].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (codePoint >= 0 && codePoint <= 0x1f)
          || (codePoint >= 0x7f && codePoint <= 0x9f);
      })
      || (!resolved.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(resolved))
    ) {
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}

async function performSync(
  options: SyncDecisionToGithubOptions,
  runner: DevloopCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<DecisionGithubSyncResult> {
  const { store, decisionId } = options;
  const attemptId = randomUUID();
  let lastTarget: DecisionGithubTarget | undefined;
  let createdRef: { readonly commentId: string; readonly commentUrl: string } | undefined;
  let knownRef: { readonly commentId: string; readonly commentUrl: string } | undefined;
  let recoveryRequired = false;
  let postingStarted = false;
  let managedWasObserved = false;

  let initialProjection: DecisionProjection | undefined;
  try {
    initialProjection = store.get(decisionId);
  } catch {
    return failed(decisionId, 'ledger_unavailable');
  }
  if (initialProjection === undefined || initialProjection.answer === undefined) {
    return failed(decisionId, 'decision_not_answered');
  }
  const initialSnapshot = snapshotFromProjection(initialProjection);
  if (initialSnapshot === undefined) return failed(decisionId, 'github_target_unavailable');
  lastTarget = initialSnapshot.preview.target;
  const initialBindingState = currentSnapshotState(options, initialSnapshot.fingerprint, false);
  if (initialBindingState === 'unavailable') return failed(decisionId, 'ledger_unavailable');
  if (initialBindingState === 'changed') return failed(decisionId, 'preview_binding_mismatch');

  const previousSync = initialProjection.githubSync;
  if (previousSync !== undefined) {
    if (!sameTarget(previousSync.target, initialSnapshot.preview.target)) {
      recoveryRequired = true;
    } else {
      recoveryRequired = previousSync.postUncertain;
      const parsed = parseCommentUrl(previousSync.knownCommentUrl, previousSync.target);
      if (parsed !== undefined && parsed.commentId === previousSync.knownCommentId) {
        knownRef = parsed;
      }
    }
  }

  const gh = commandPath(runner, env);
  if (gh === undefined) {
    return appendFailure(store, decisionId, initialSnapshot.preview.target, 'github_unavailable', {
      phase: recoveryRequired ? 'posting' : 'inspecting',
      attemptId,
      outcome: recoveryRequired ? 'may_have_posted' : 'definitely_not_posted',
    });
  }
  const execOptions = githubMetadataExecOptions({
    cwd: store.repoPath,
    env,
    maxOutputBytes: MAX_GITHUB_RESPONSE_BYTES,
  });

  for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
    let projection: DecisionProjection | undefined;
    try {
      projection = store.get(decisionId);
    } catch {
      return failed(decisionId, 'ledger_unavailable');
    }
    if (projection === undefined || projection.answer === undefined) {
      return failed(decisionId, 'decision_not_answered');
    }
    const snapshot = snapshotFromProjection(projection);
    if (snapshot === undefined) return failed(decisionId, 'github_target_unavailable');
    const { preview, fingerprint } = snapshot;
    lastTarget = preview.target;

    if (!recoveryRequired && knownRef === undefined && createdRef === undefined) {
      try {
        if (!appendPendingIfCurrent(
          store,
          decisionId,
          preview.target,
          fingerprint,
          'inspecting',
          attemptId,
        )) {
          continue;
        }
      } catch {
        return failed(decisionId, 'ledger_unavailable');
      }
    }

    const entity = preview.target.kind === 'issue' ? 'issue' : 'pr';
    let rawViewResult: unknown;
    try {
      rawViewResult = await runner.exec(gh, [
        entity,
        'view',
        String(preview.target.number),
        '--repo',
        preview.target.repository,
        '--json',
        'number,url,comments',
      ], execOptions);
    } catch {
      return appendFailure(store, decisionId, preview.target, 'github_unavailable', {
        phase: recoveryRequired ? 'posting' : 'inspecting',
        attemptId,
        outcome: recoveryRequired ? 'may_have_posted' : 'definitely_not_posted',
      });
    }
    const viewResult = safeCommandResult(rawViewResult);
    if (viewResult === undefined) {
      return appendFailure(store, decisionId, preview.target, 'untrusted_github_response', {
        phase: recoveryRequired ? 'posting' : 'inspecting',
        attemptId,
        outcome: recoveryRequired ? 'may_have_posted' : 'definitely_not_posted',
      });
    }
    if (viewResult.exitCode !== 0) {
      return appendFailure(store, decisionId, preview.target, 'github_unavailable', {
        phase: recoveryRequired ? 'posting' : 'inspecting',
        attemptId,
        outcome: recoveryRequired ? 'may_have_posted' : 'definitely_not_posted',
      });
    }
    const view = parseGithubView(viewResult.stdout, preview.target);
    if (view === undefined) {
      return appendFailure(store, decisionId, preview.target, 'untrusted_github_response', {
        phase: recoveryRequired ? 'posting' : 'inspecting',
        attemptId,
        outcome: recoveryRequired ? 'may_have_posted' : 'definitely_not_posted',
      });
    }
    const managed = findManagedComment(view, preview, projection);
    if (managed === 'collision') {
      return appendFailure(store, decisionId, preview.target, 'untrusted_github_response', {
        phase: recoveryRequired ? 'posting' : 'inspecting',
        attemptId,
        outcome: recoveryRequired ? 'may_have_posted' : 'definitely_not_posted',
      });
    }
    if (managed !== undefined) managedWasObserved = true;

    let directlyVerifiedComment: GithubComment | undefined;
    if (managed === undefined && createdRef === undefined && knownRef !== undefined) {
      let rawKnownResult: unknown;
      try {
        rawKnownResult = await runner.exec(gh, [
          'api',
          '--method',
          'GET',
          `repos/${preview.target.repository}/issues/comments/${knownRef.commentId}`,
        ], execOptions);
      } catch {
        return appendFailure(store, decisionId, preview.target, 'github_unavailable', {
          phase: 'posting',
          attemptId,
          outcome: 'may_have_posted',
        });
      }
      const knownResult = safeCommandResult(rawKnownResult);
      if (knownResult === undefined) {
        return appendFailure(store, decisionId, preview.target, 'untrusted_github_response', {
          phase: 'posting',
          attemptId,
          outcome: 'may_have_posted',
        });
      }
      if (isExplicitGithubNotFound(knownResult)) {
        // Only a narrowly parsed, explicit 404 proves the previously verified
        // comment was deleted. Network and malformed failures remain ambiguous.
        try {
          appendMissingComment(store, decisionId, preview.target, knownRef, attemptId);
        } catch {
          return failed(decisionId, 'ledger_unavailable');
        }
        options.afterMissingPersisted?.();
        knownRef = undefined;
      } else if (knownResult.exitCode !== 0) {
        return appendFailure(store, decisionId, preview.target, 'github_unavailable', {
          phase: 'posting',
          attemptId,
          outcome: 'may_have_posted',
        });
      } else {
        directlyVerifiedComment = parseKnownComment(
          knownResult.stdout,
          preview.target,
          knownRef,
          preview,
          projection,
        );
        if (directlyVerifiedComment === undefined) {
          return appendFailure(store, decisionId, preview.target, 'untrusted_github_response', {
            phase: 'posting',
            attemptId,
            outcome: 'may_have_posted',
          });
        }
        try {
          appendVerifiedComment(
            store,
            decisionId,
            preview.target,
            directlyVerifiedComment,
          );
        } catch {
          return failed(decisionId, 'ledger_unavailable');
        }
        knownRef = directlyVerifiedComment;
        recoveryRequired = false;
      }
    }

    let authoritativeRef = createdRef ?? knownRef;
    if (
      managed !== undefined
      && authoritativeRef !== undefined
      && managed.comment.commentId !== authoritativeRef.commentId
    ) {
      return appendFailure(store, decisionId, preview.target, 'untrusted_github_response', {
        phase: 'posting',
        attemptId,
        outcome: 'may_have_posted',
      });
    }
    if (managed !== undefined) {
      try {
        appendVerifiedComment(store, decisionId, preview.target, managed.comment);
      } catch {
        return failed(decisionId, 'ledger_unavailable');
      }
      knownRef = managed.comment;
      authoritativeRef = createdRef ?? knownRef;
      recoveryRequired = false;
    }

    const currentComment = managed !== undefined && managed.current
      ? managed.comment
      : directlyVerifiedComment?.body === preview.body ? directlyVerifiedComment : undefined;
    if (currentComment !== undefined) {
      try {
        if (!appendSyncedIfCurrent(
          store,
          decisionId,
          preview.target,
          fingerprint,
          currentComment,
        )) {
          continue;
        }
        return {
          status: 'synced',
          decisionId,
          existing: true,
          commentId: currentComment.commentId,
          commentUrl: currentComment.commentUrl,
        };
      } catch {
        return failed(decisionId, 'ledger_unavailable');
      }
    }

    if (managed === undefined && authoritativeRef === undefined && recoveryRequired) {
      // GitHub comment creation may be eventually consistent. Re-inspect a
      // bounded number of times, but never convert uncertainty into a POST.
      continue;
    }

    const stateBeforeMutation = currentSnapshotState(options, fingerprint, true);
    if (stateBeforeMutation === 'unavailable') {
      return failed(decisionId, 'ledger_unavailable');
    }
    if (stateBeforeMutation === 'changed') {
      return failed(decisionId, 'preview_binding_mismatch');
    }

    const patchTarget = managed?.comment ?? directlyVerifiedComment ?? (authoritativeRef === undefined
      ? undefined
      : Object.freeze({
        ...authoritativeRef,
        body: '',
        viewerDidAuthor: true,
      }));
    if (patchTarget !== undefined) {
      let rawUpdateResult: unknown;
      try {
        rawUpdateResult = await runner.exec(gh, [
          'api',
          '--method',
          'PATCH',
          `repos/${preview.target.repository}/issues/comments/${patchTarget.commentId}`,
          '-f',
          `body=${preview.body}`,
        ], execOptions);
      } catch {
        return appendFailure(store, decisionId, preview.target, 'github_unavailable', {
          phase: recoveryRequired ? 'posting' : 'inspecting',
          attemptId,
          outcome: recoveryRequired ? 'may_have_posted' : 'definitely_not_posted',
        });
      }
      const updateResult = safeCommandResult(rawUpdateResult);
      if (updateResult === undefined) {
        return appendFailure(store, decisionId, preview.target, 'untrusted_github_response', {
          phase: recoveryRequired ? 'posting' : 'inspecting',
          attemptId,
          outcome: recoveryRequired ? 'may_have_posted' : 'definitely_not_posted',
        });
      }
      if (updateResult.exitCode !== 0) {
        return appendFailure(store, decisionId, preview.target, 'github_unavailable', {
          phase: recoveryRequired ? 'posting' : 'inspecting',
          attemptId,
          outcome: recoveryRequired ? 'may_have_posted' : 'definitely_not_posted',
        });
      }
      const updated = parseUpdatedComment(
        updateResult.stdout,
        preview.target,
        patchTarget,
        preview.body,
      );
      if (updated === undefined) {
        return appendFailure(store, decisionId, preview.target, 'untrusted_github_response', {
          phase: recoveryRequired ? 'posting' : 'inspecting',
          attemptId,
          outcome: recoveryRequired ? 'may_have_posted' : 'definitely_not_posted',
        });
      }
      try {
        if (!appendSyncedIfCurrent(
          store,
          decisionId,
          preview.target,
          fingerprint,
          updated,
        )) {
          continue;
        }
        return {
          status: 'synced',
          decisionId,
          existing: true,
          commentId: updated.commentId,
          commentUrl: updated.commentUrl,
        };
      } catch {
        return failed(decisionId, 'ledger_unavailable');
      }
    }

    try {
      if (!appendPendingIfCurrent(
        store,
        decisionId,
        preview.target,
        fingerprint,
        'posting',
        attemptId,
      )) {
        return failed(decisionId, 'preview_binding_mismatch');
      }
    } catch {
      return failed(decisionId, 'ledger_unavailable');
    }
    // Once posting intent is durable, this invocation is structurally barred
    // from entering the POST branch again, even if projection CAS later fails.
    postingStarted = true;
    recoveryRequired = true;
    options.afterPostingPersisted?.();

    let rawCommentResult: unknown;
    try {
      rawCommentResult = await runner.exec(gh, [
        entity,
        'comment',
        String(preview.target.number),
        '--repo',
        preview.target.repository,
        '--body',
        preview.body,
      ], execOptions);
    } catch {
      return appendFailure(store, decisionId, preview.target, 'github_unavailable', {
        phase: 'posting',
        attemptId,
        outcome: 'may_have_posted',
      });
    }
    const commentResult = safeCommandResult(rawCommentResult);
    if (commentResult === undefined) {
      return appendFailure(store, decisionId, preview.target, 'untrusted_github_response', {
        phase: 'posting',
        attemptId,
        outcome: 'may_have_posted',
      });
    }
    if (commentResult.exitCode !== 0) {
      return appendFailure(store, decisionId, preview.target, 'github_unavailable', {
        phase: 'posting',
        attemptId,
        outcome: 'may_have_posted',
      });
    }
    createdRef = parseCommentUrl(commentResult.stdout.trim(), preview.target);
    if (createdRef === undefined) {
      return appendFailure(store, decisionId, preview.target, 'untrusted_github_response', {
        phase: 'posting',
        attemptId,
        outcome: 'may_have_posted',
      });
    }
    options.afterCommentCreated?.();
    try {
      appendVerifiedComment(store, decisionId, preview.target, createdRef);
    } catch {
      return failed(decisionId, 'ledger_unavailable');
    }
    recoveryRequired = false;
    try {
      if (!appendSyncedIfCurrent(
        store,
        decisionId,
        preview.target,
        fingerprint,
        createdRef,
      )) {
        continue;
      }
      return {
        status: 'synced',
        decisionId,
        existing: false,
        commentId: createdRef.commentId,
        commentUrl: createdRef.commentUrl,
      };
    } catch {
      return failed(decisionId, 'ledger_unavailable');
    }
  }

  if (lastTarget === undefined) return failed(decisionId, 'sync_state_changed');
  if (recoveryRequired && createdRef === undefined && knownRef === undefined && !managedWasObserved) {
    return appendFailure(
      store,
      decisionId,
      lastTarget,
      'sync_visibility_unconfirmed',
      { phase: 'posting', attemptId, outcome: 'may_have_posted' },
    );
  }
  return appendFailure(store, decisionId, lastTarget, 'sync_state_changed', {
    phase: postingStarted || recoveryRequired ? 'posting' : 'inspecting',
    attemptId,
    outcome: postingStarted || recoveryRequired
      ? 'may_have_posted'
      : 'definitely_not_posted',
  });
}

export async function syncDecisionToGithub(
  options: SyncDecisionToGithubOptions,
): Promise<DecisionGithubSyncResult> {
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const env = options.env ?? process.env;
  try {
    const lockDigest = createHash('sha256')
      .update(options.decisionId, 'utf8')
      .digest('hex');
    return await withRepoKernelAdvisoryLock(
      options.store.repoPath,
      `decision-github-${lockDigest}`,
      () => performSync(options, runner, env),
      SYNC_LOCK_TIMEOUT_MS,
    );
  } catch {
    return failed(options.decisionId, 'ledger_unavailable');
  }
}
