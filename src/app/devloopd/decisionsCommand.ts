import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder, types as utilTypes } from 'node:util';
import { Command } from 'commander';
import { z } from 'zod/v4';
import {
  DecisionAnswerValueSchema,
  type DecisionProjection,
} from '../../devloopd/decisionEvents.js';
import {
  DecisionStore,
  type DecisionStoreErrorCode,
} from '../../devloopd/decisionStore.js';
import { applyDecision } from '../../devloopd/decisionResume.js';
import { syncDecisionToGithub } from '../../devloopd/decisionGithubSync.js';

const MAX_STDIN_JSON_BYTES = 1024 * 1024;
const CONTEXT_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const DECISION_STATUSES = [
  'open',
  'answered',
  'applying',
  'applied',
  'revalidation_required',
] as const satisfies readonly DecisionProjection['status'][];

const DecisionAnswerInputSchema = z.object({
  decisionId: z.string().min(1).max(200).regex(IDENTIFIER_PATTERN),
  expectedDecisionVersion: z.number().int().positive(),
  expectedContextHash: z.string().regex(CONTEXT_HASH_PATTERN),
  value: DecisionAnswerValueSchema,
  rationale: z.string().max(4_000),
  idempotencyKey: z.string().min(1).max(200).regex(IDENTIFIER_PATTERN),
}).strict();

type DecisionCliLocalErrorCode =
  | 'decision_not_found'
  | 'empty_stdin'
  | 'invalid_answer_input'
  | 'invalid_apply_input'
  | 'invalid_sync_input'
  | 'invalid_status'
  | 'invalid_stdin_json'
  | 'missing_decision_id'
  | 'repository_unavailable'
  | 'stdin_json_required'
  | 'stdin_unavailable'
  | 'stdin_too_large';
type DecisionCliErrorCode = DecisionCliLocalErrorCode | DecisionStoreErrorCode;

const CLI_ERROR_MESSAGES: Readonly<Record<DecisionCliLocalErrorCode, string>> = {
  decision_not_found: '指定された判断待ちは見つかりません。',
  empty_stdin: '標準入力に回答JSONがありません。',
  invalid_answer_input: '回答JSONの形式が正しくありません。',
  invalid_apply_input: '適用条件の形式が正しくありません。',
  invalid_sync_input: 'GitHub同期対象の形式が正しくありません。',
  invalid_status: '指定された状態は利用できません。',
  invalid_stdin_json: '標準入力をJSONとして解析できません。',
  missing_decision_id: '判断IDを指定してください。',
  repository_unavailable: '対象リポジトリを利用できません。',
  stdin_json_required: '回答は--stdin-jsonで標準入力から渡してください。',
  stdin_unavailable: '標準入力を安全に読み取れません。',
  stdin_too_large: '回答JSONが許容サイズを超えています。',
};

const STORE_ERROR_MESSAGES: Readonly<Record<DecisionStoreErrorCode, string>> = {
  ledger_malformed: '判断台帳の形式が壊れています。',
  ledger_incompatible: '判断台帳に互換性のないイベントがあります。',
  ledger_unavailable: '判断台帳を利用できません。',
  ledger_capacity_exceeded: '判断台帳の容量上限を超えました。',
  decision_not_found: '指定された判断待ちは見つかりません。',
  decision_quarantined: '指定された判断待ちは隔離されています。',
  repository_mismatch: '判断待ちのリポジトリが一致しません。',
  stale_version: '判断待ちのバージョンが更新されています。',
  stale_context: '判断待ちの前提条件が更新されています。',
  decision_not_open: '指定された判断待ちは回答可能な状態ではありません。',
  invalid_answer: '回答が判断待ちの要件を満たしていません。',
  rationale_required: 'この判断には回答理由が必要です。',
  idempotency_conflict: '同じ再送キーに異なる回答が記録されています。',
  request_conflict: '判断待ちの識別子が既存の依頼と競合しています。',
  invalid_identifier: '判断待ちの識別子が正しくありません。',
};

interface DecisionCliFailure {
  readonly code: DecisionCliErrorCode;
  readonly message: string;
}

function failure(code: DecisionCliLocalErrorCode): DecisionCliFailure {
  return Object.freeze({ code, message: CLI_ERROR_MESSAGES[code] });
}

function localActor(): string {
  // 回答者はstdinから受け取らず、偽装できないローカル実行コンテキストだけから導出する。
  return typeof process.getuid === 'function'
    ? `local:uid-${process.getuid()}`
    : 'local:process';
}

function storeFailure(error: unknown): DecisionCliFailure {
  // Proxyのtrapを起動して秘密や内部例外を露出しないよう、既知のown data propertyだけを読む。
  if (error === null || typeof error !== 'object' || utilTypes.isProxy(error)) {
    return { code: 'ledger_unavailable', message: STORE_ERROR_MESSAGES.ledger_unavailable };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    const code = descriptor?.value;
    if (
      typeof code === 'string'
      && Object.hasOwn(STORE_ERROR_MESSAGES, code)
    ) {
      const knownCode = code as DecisionStoreErrorCode;
      return { code: knownCode, message: STORE_ERROR_MESSAGES[knownCode] };
    }
  } catch {
    // Public errors remain fixed even if an unexpected object resists inspection.
  }
  return { code: 'ledger_unavailable', message: STORE_ERROR_MESSAGES.ledger_unavailable };
}

type DecisionJsonReadResult =
  { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: DecisionCliFailure };

export async function readDecisionJsonFromStream(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<DecisionJsonReadResult> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_STDIN_JSON_BYTES) {
        return { ok: false, error: failure('stdin_too_large') };
      }
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: failure('stdin_unavailable') };
  }
  if (totalBytes === 0) return { ok: false, error: failure('empty_stdin') };

  try {
    // Buffer.toString() replaces malformed bytes. Fatal decoding prevents an invalid
    // byte sequence from being accepted as a different human answer.
    const decoded = new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.concat(chunks, totalBytes));
    return { ok: true, value: JSON.parse(decoded) };
  } catch {
    return { ok: false, error: failure('invalid_stdin_json') };
  }
}

function resolveExistingRepository(cwd: string): string | undefined {
  try {
    const repoPath = resolve(cwd);
    return statSync(repoPath).isDirectory() ? repoPath : undefined;
  } catch {
    return undefined;
  }
}

function writeError(error: DecisionCliFailure, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error,
    })}\n`);
  } else {
    process.stderr.write(`エラー: ${error.message} (${error.code})\n`);
  }
  process.exitCode = 1;
}

function formatDecisionSummary(projection: DecisionProjection): string {
  return [
    `判断ID: ${projection.request.decisionId}`,
    `状態: ${projection.status}`,
    `質問: ${projection.request.question}`,
  ].join('\n');
}

function formatAnswerConstraints(projection: DecisionProjection): readonly string[] {
  const { request } = projection;
  const rationale = `回答理由: ${request.answerRequirements.rationaleRequired ? '必須' : '任意'}`;
  if (request.kind === 'text') {
    return [
      `回答形式: 自由記述（${request.answerRequirements.minimumTextLength}〜${request.answerRequirements.maximumTextLength}文字）`,
      rationale,
    ];
  }

  const answerKind = request.kind === 'yes_no' ? 'YES / NO' : '方針選択';
  return [
    `回答形式: ${answerKind}`,
    rationale,
    '選択肢:',
    ...request.options.map(
      (option) => `- ${option.id}: ${option.title}${option.recommended ? '（推奨）' : ''}`,
    ),
  ];
}

function formatDecisionDetail(projection: DecisionProjection): string {
  return [
    formatDecisionSummary(projection),
    `理由: ${projection.request.why.summary}`,
    `進め方: ${projection.request.how.summary}`,
    ...formatAnswerConstraints(projection),
  ].join('\n');
}

function parseStatus(value: string | undefined): DecisionProjection['status'] | undefined {
  if (value === undefined) return undefined;
  return (DECISION_STATUSES as readonly string[]).includes(value)
    ? value as DecisionProjection['status']
    : undefined;
}

export function registerDecisionsCommand(program: Command): void {
  const decisions = program
    .command('decisions')
    .description('ローカル判断台帳を確認・回答する');

  decisions
    .command('list')
    .description('判断待ちの一覧を表示する')
    .option('--cwd <path>', '対象リポジトリ', process.cwd())
    .option('--status <status>', '指定状態だけを表示する')
    .option('--json', '機械可読JSONを表示する')
    .action((options: { cwd: string; status?: string; json?: boolean }) => {
      const status = parseStatus(options.status);
      if (options.status !== undefined && status === undefined) {
        writeError(failure('invalid_status'), options.json === true);
        return;
      }
      const repoPath = resolveExistingRepository(options.cwd);
      if (repoPath === undefined) {
        writeError(failure('repository_unavailable'), options.json === true);
        return;
      }
      try {
        const projections = new DecisionStore(repoPath)
          .list()
          .filter((projection) => status === undefined || projection.status === status);
        if (options.json === true) {
          console.log(JSON.stringify({ schemaVersion: 1, decisions: projections }, null, 2));
          return;
        }
        console.log(
          projections.length === 0
            ? '判断待ちはありません。'
            : projections.map(formatDecisionSummary).join('\n\n'),
        );
      } catch (error) {
        writeError(storeFailure(error), options.json === true);
      }
    });

  decisions
    .command('show')
    .description('判断待ちの詳細を表示する')
    .option('--cwd <path>', '対象リポジトリ', process.cwd())
    .option('--id <decision-id>', '判断ID')
    .option('--json', '機械可読JSONを表示する')
    .action((options: { cwd: string; id?: string; json?: boolean }) => {
      if (options.id === undefined) {
        writeError(failure('missing_decision_id'), options.json === true);
        return;
      }
      const repoPath = resolveExistingRepository(options.cwd);
      if (repoPath === undefined) {
        writeError(failure('repository_unavailable'), options.json === true);
        return;
      }
      try {
        const projection = new DecisionStore(repoPath).get(options.id);
        if (projection === undefined) {
          writeError(failure('decision_not_found'), options.json === true);
          return;
        }
        console.log(
          options.json === true
            ? JSON.stringify({ schemaVersion: 1, decision: projection }, null, 2)
            : formatDecisionDetail(projection),
        );
      } catch (error) {
        writeError(storeFailure(error), options.json === true);
      }
    });

  decisions
    .command('answer')
    .description('標準入力のJSONから判断待ちへ回答する')
    .option('--cwd <path>', '対象リポジトリ', process.cwd())
    .option('--stdin-json', '回答JSONを標準入力から読み取る')
    .option('--json', '機械可読JSONを表示する')
    .action(async (options: { cwd: string; stdinJson?: boolean; json?: boolean }) => {
      if (options.stdinJson !== true) {
        writeError(failure('stdin_json_required'), options.json === true);
        return;
      }
      const repoPath = resolveExistingRepository(options.cwd);
      if (repoPath === undefined) {
        writeError(failure('repository_unavailable'), options.json === true);
        return;
      }

      try {
        const input = await readDecisionJsonFromStream(process.stdin);
        if (!input.ok) {
          writeError(input.error, options.json === true);
          return;
        }
        const parsed = DecisionAnswerInputSchema.safeParse(input.value);
        if (!parsed.success) {
          writeError(failure('invalid_answer_input'), options.json === true);
          return;
        }
        const event = new DecisionStore(repoPath).answer(parsed.data, localActor());
        if (options.json === true) {
          // 回答本文と理由は成功応答へ含めず、端末履歴や上位プロセスのログへの拡散を防ぐ。
          console.log(JSON.stringify({
            schemaVersion: 1,
            ok: true,
            decisionId: event.decisionId,
            status: 'answered',
            answerEventId: event.eventId,
          }, null, 2));
          return;
        }
        console.log(`判断 ${event.decisionId} の回答を記録しました。`);
      } catch (error) {
        writeError(storeFailure(error), options.json === true);
      }
    });

  decisions
    .command('apply')
    .description('回答済みの判断を再検証して安全に適用する')
    .option('--cwd <path>', '対象リポジトリ', process.cwd())
    .requiredOption('--id <decision-id>', '判断ID')
    .requiredOption('--expected-version <version>', '期待する判断version')
    .requiredOption('--expected-context-hash <hash>', '期待するcontext hash')
    .option('--json', '機械可読JSONを表示する')
    .action(async (options: {
      cwd: string;
      id: string;
      expectedVersion: string;
      expectedContextHash: string;
      json?: boolean;
    }) => {
      const expectedDecisionVersion = Number(options.expectedVersion);
      if (
        !IDENTIFIER_PATTERN.test(options.id)
        || !Number.isInteger(expectedDecisionVersion)
        || expectedDecisionVersion <= 0
        || !CONTEXT_HASH_PATTERN.test(options.expectedContextHash)
      ) {
        writeError(failure('invalid_apply_input'), options.json === true);
        return;
      }
      const repoPath = resolveExistingRepository(options.cwd);
      if (repoPath === undefined) {
        writeError(failure('repository_unavailable'), options.json === true);
        return;
      }
      try {
        const result = await applyDecision({
          store: new DecisionStore(repoPath),
          decisionId: options.id,
          expectedDecisionVersion,
          expectedContextHash: options.expectedContextHash,
        });
        if (options.json === true) {
          // The answer body and rationale never appear in apply output. Only
          // fixed adapter summaries and stable identifiers cross the CLI.
          console.log(JSON.stringify({ schemaVersion: 1, ok: result.status === 'applied', ...result }, null, 2));
        } else if (result.status === 'applied') {
          console.log(`判断 ${result.decisionId} を適用しました。`);
        } else {
          console.error(`判断 ${result.decisionId} は適用されませんでした（${result.status}）。`);
        }
        if (result.status !== 'applied') process.exitCode = 1;
      } catch (error) {
        writeError(storeFailure(error), options.json === true);
      }
    });

  decisions
    .command('sync-github')
    .description('判断状態の安全な要約を任意でGitHubへ同期する')
    .option('--cwd <path>', '対象リポジトリ', process.cwd())
    .option('--id <decision-id>', '判断ID')
    .option('--json', '機械可読JSONを表示する')
    .action(async (options: { cwd: string; id?: string; json?: boolean }) => {
      if (
        options.id === undefined
        || options.id.length > 200
        || !IDENTIFIER_PATTERN.test(options.id)
      ) {
        writeError(failure('invalid_sync_input'), options.json === true);
        return;
      }
      const repoPath = resolveExistingRepository(options.cwd);
      if (repoPath === undefined) {
        writeError(failure('repository_unavailable'), options.json === true);
        return;
      }

      let result;
      try {
        result = await syncDecisionToGithub({
          store: new DecisionStore(repoPath),
          decisionId: options.id,
        });
      } catch (error) {
        writeError(storeFailure(error), options.json === true);
        return;
      }
      if (options.json === true) {
        // GitHub output and private ledger fields are never reflected. Stable
        // identifiers and fixed status/error codes are sufficient for TaktDesk.
        console.log(JSON.stringify(result.status === 'synced'
          ? {
            schemaVersion: 1,
            ok: true,
            decisionId: result.decisionId,
            status: result.status,
            existing: result.existing,
            commentId: result.commentId,
          }
          : {
            schemaVersion: 1,
            ok: false,
            decisionId: result.decisionId,
            status: result.status,
            errorCode: result.errorCode,
            sanitizedError: result.sanitizedError,
          }, null, 2));
      } else if (result.status === 'synced') {
        console.log(`判断 ${result.decisionId} の状態をGitHubへ同期しました。`);
      } else {
        console.error(`判断 ${result.decisionId} のGitHub同期に失敗しました。`);
      }
      if (result.status !== 'synced') process.exitCode = 1;
    });
}
