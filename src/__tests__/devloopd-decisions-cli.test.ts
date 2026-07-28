import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDecisionJsonFromStream } from '../app/devloopd/decisionsCommand.js';
import { createDecisionRequest, type DecisionRequest } from '../devloopd/decisionRequest.js';
import { DecisionStore } from '../devloopd/decisionStore.js';

const CLI_PATH = resolve('dist/app/devloopd/index.js');

function makeRequest(
  repoPath: string,
  decisionId = 'dec_cli',
  kind: 'text' | 'yes_no' | 'choice' = 'text',
): DecisionRequest {
  const common = {
    subject: {
      repoPath,
      runSlug: decisionId,
      step: 'approval',
      title: '実装方針を決定する',
    },
    question: 'どの方針で進めますか？',
    why: {
      summary: '自動化だけでは方針を決定できません。',
      riskCategory: 'requirements_ambiguity',
      reasons: ['複数の妥当な方針があります。'],
      evidence: [],
    },
    how: {
      summary: '回答された方針で再開します。',
      expectedEffects: ['選択した方針だけを適用します。'],
      verification: ['再開前にコンテキストを再検証します。'],
    },
    answerRequirements: {
      rationaleRequired: true,
      minimumTextLength: 3,
      maximumTextLength: 100,
    },
    resumeGuard: {
      strategy: 'direct_run',
      expectedDecisionVersion: 1,
      runSlug: decisionId,
      expectedRunStatus: 'aborted',
      expectedAbortKind: 'blocked',
      expectedBlockedStep: 'approval',
    },
  };
  const input = kind === 'text'
    ? { ...common, kind }
    : kind === 'yes_no'
      ? {
        ...common,
        kind,
        options: [
          {
            id: 'yes',
            title: 'はい',
            description: 'この方針で進めます。',
            consequences: [],
            recommended: true,
          },
          {
            id: 'no',
            title: 'いいえ',
            description: 'この方針では進めません。',
            consequences: [],
            recommended: false,
          },
        ] as const,
      }
      : {
        ...common,
        kind,
        options: [
          {
            id: 'plan_a',
            title: '方針A',
            description: '安全性を優先します。',
            consequences: [],
            recommended: true,
          },
          {
            id: 'plan_b',
            title: '方針B',
            description: '速度を優先します。',
            consequences: [],
            recommended: false,
          },
        ],
      };
  return createDecisionRequest(input, {
    decisionId,
    now: new Date('2026-07-28T00:00:00.000Z'),
  });
}

function runCli(
  args: readonly string[],
  input?: string | Uint8Array,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: resolve('.'),
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });
}

describe('devloopd decisions CLI', () => {
  let repoPath: string;
  let request: DecisionRequest;

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-decisions-cli-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
    request = makeRequest(repoPath);
    new DecisionStore(repoPath).request(request, {
      eventId: 'evt_cli_requested',
      now: new Date('2026-07-28T00:01:00.000Z'),
    });
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('lists and shows stable JSON projections', () => {
    const listed = runCli(['decisions', 'list', '--cwd', repoPath, '--json']);
    expect(listed.status).toBe(0);
    expect(listed.stderr).toBe('');
    expect(JSON.parse(listed.stdout)).toEqual({
      schemaVersion: 1,
      decisions: [
        expect.objectContaining({
          request: expect.objectContaining({ decisionId: request.decisionId }),
          status: 'open',
        }),
      ],
    });

    const shown = runCli([
      'decisions',
      'show',
      '--cwd',
      repoPath,
      '--id',
      request.decisionId,
      '--json',
    ]);
    expect(shown.status).toBe(0);
    expect(shown.stderr).toBe('');
    expect(JSON.parse(shown.stdout)).toEqual({
      schemaVersion: 1,
      decision: expect.objectContaining({
        request: expect.objectContaining({ decisionId: request.decisionId }),
        status: 'open',
      }),
    });
  });

  it('answers from stdin without exposing free text in argv or success output', () => {
    const answerText = 'private roadmap choice';
    const rationale = 'private customer evidence';
    const stdin = JSON.stringify({
      decisionId: request.decisionId,
      expectedDecisionVersion: request.decisionVersion,
      expectedContextHash: request.contextHash,
      value: { text: answerText },
      rationale,
      idempotencyKey: 'cli-answer-1',
    });
    const args = ['decisions', 'answer', '--cwd', repoPath, '--stdin-json', '--json'];

    expect(args.join(' ')).not.toContain(answerText);
    expect(args.join(' ')).not.toContain(rationale);
    const result = runCli(args, stdin);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(answerText);
    expect(result.stdout).not.toContain(rationale);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      decisionId: request.decisionId,
      status: 'answered',
      answerEventId: expect.any(String),
    });
    expect(new DecisionStore(repoPath).get(request.decisionId)).toMatchObject({
      status: 'answered',
      answer: {
        value: { text: answerText },
        rationale,
        answeredBy: expect.stringMatching(/^local:/u),
      },
    });
  });

  it('fails GitHub sync with fixed output when no typed subject target exists', () => {
    const syncStore = new DecisionStore(repoPath);
    syncStore.answer({
      decisionId: request.decisionId,
      expectedDecisionVersion: request.decisionVersion,
      expectedContextHash: request.contextHash,
      value: { text: 'private sync answer' },
      rationale: 'private sync rationale',
      idempotencyKey: 'cli-sync-answer',
    }, 'local:test', { eventId: 'evt_cli_sync_answered' });

    const result = runCli([
      'decisions',
      'sync-github',
      '--cwd',
      repoPath,
      '--id',
      request.decisionId,
      '--expected-version',
      String(request.decisionVersion),
      '--expected-context-hash',
      request.contextHash,
      '--expected-preview-sha256',
      '0'.repeat(64),
      '--json',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('private sync answer');
    expect(result.stdout).not.toContain('private sync rationale');
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      decisionId: request.decisionId,
      status: 'failed',
      errorCode: 'github_target_unavailable',
      sanitizedError: 'GitHub同期に失敗しました。',
    });
  });

  it('requires every immutable GitHub preview binding input', () => {
    const result = runCli([
      'decisions',
      'sync-github',
      '--cwd',
      repoPath,
      '--id',
      request.decisionId,
      '--json',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'invalid_sync_input',
        message: 'GitHub同期対象の形式が正しくありません。',
      },
    });
  });

  it('applies a manual-only answer without reflecting the answer body', () => {
    const yesNoRequest = makeRequest(repoPath, 'dec_cli_apply', 'yes_no');
    const applyStore = new DecisionStore(repoPath);
    applyStore.request(yesNoRequest, { eventId: 'evt_cli_apply_requested' });
    applyStore.answer({
      decisionId: yesNoRequest.decisionId,
      expectedDecisionVersion: yesNoRequest.decisionVersion,
      expectedContextHash: yesNoRequest.contextHash,
      value: { optionId: 'no' },
      rationale: 'private stop rationale',
      idempotencyKey: 'cli-apply-answer',
    }, 'local:test', { eventId: 'evt_cli_apply_answered' });

    const result = runCli([
      'decisions',
      'apply',
      '--cwd',
      repoPath,
      '--id',
      yesNoRequest.decisionId,
      '--expected-version',
      String(yesNoRequest.decisionVersion),
      '--expected-context-hash',
      yesNoRequest.contextHash,
      '--json',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('private stop rationale');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      decisionId: yesNoRequest.decisionId,
      status: 'applied',
    });
    expect(applyStore.get(yesNoRequest.decisionId)?.status).toBe('applied');
  });

  it('returns a machine-readable error for invalid JSON without reflecting input', () => {
    const sensitiveInvalidJson = '{"value":"do-not-reflect",';
    const result = runCli(
      ['decisions', 'answer', '--cwd', repoPath, '--stdin-json', '--json'],
      sensitiveInvalidJson,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('do-not-reflect');
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'invalid_stdin_json',
        message: expect.any(String),
      },
    });
  });

  it('rejects malformed UTF-8 without reflecting raw input', () => {
    const result = runCli(
      ['decisions', 'answer', '--cwd', repoPath, '--stdin-json', '--json'],
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).error.code).toBe('invalid_stdin_json');
  });

  it('rejects empty and oversized stdin without writing an answer or reflecting it', () => {
    const empty = runCli(
      ['decisions', 'answer', '--cwd', repoPath, '--stdin-json', '--json'],
      '',
    );
    expect(empty.status).not.toBe(0);
    expect(JSON.parse(empty.stdout).error.code).toBe('empty_stdin');

    const secret = 'oversized-secret';
    const oversized = JSON.stringify({ value: secret.repeat(80_000) });
    const tooLarge = runCli(
      ['decisions', 'answer', '--cwd', repoPath, '--stdin-json', '--json'],
      oversized,
    );
    expect(tooLarge.status).not.toBe(0);
    expect(tooLarge.stdout).not.toContain(secret);
    expect(tooLarge.stderr).not.toContain(secret);
    expect(JSON.parse(tooLarge.stdout).error.code).toBe('stdin_too_large');
    expect(new DecisionStore(repoPath).get(request.decisionId)?.status).toBe('open');
  });

  it('returns stable JSON when required command options are missing', () => {
    const show = runCli(['decisions', 'show', '--json', '--cwd', repoPath]);
    expect(show.status).not.toBe(0);
    expect(show.stderr).toBe('');
    expect(JSON.parse(show.stdout).error.code).toBe('missing_decision_id');

    const answer = runCli(['decisions', 'answer', '--json', '--cwd', repoPath]);
    expect(answer.status).not.toBe(0);
    expect(answer.stderr).toBe('');
    expect(JSON.parse(answer.stdout).error.code).toBe('stdin_json_required');

    const human = runCli(['decisions', 'show', '--cwd', repoPath]);
    expect(human.status).not.toBe(0);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('判断ID');
    expect(human.stderr).not.toContain('required option');
  });

  it('converts stdin stream failures to a fixed non-reflecting error', async () => {
    const secret = 'stream-secret-that-must-not-leak';
    const throwingStream = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        throw new Error(secret);
      },
    };

    const result = await readDecisionJsonFromStream(throwingStream);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'stdin_unavailable',
        message: expect.any(String),
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('shows answer constraints and option labels for every decision kind', () => {
    const yesNo = makeRequest(repoPath, 'dec_cli_yes_no', 'yes_no');
    const choice = makeRequest(repoPath, 'dec_cli_choice', 'choice');
    const store = new DecisionStore(repoPath);
    store.request(yesNo, { eventId: 'evt_cli_yes_no' });
    store.request(choice, { eventId: 'evt_cli_choice' });

    const textOutput = runCli([
      'decisions', 'show', '--cwd', repoPath, '--id', request.decisionId,
    ]).stdout;
    expect(textOutput).toContain('回答形式: 自由記述（3〜100文字）');
    expect(textOutput).toContain('回答理由: 必須');

    const yesNoOutput = runCli([
      'decisions', 'show', '--cwd', repoPath, '--id', yesNo.decisionId,
    ]).stdout;
    expect(yesNoOutput).toContain('回答形式: YES / NO');
    expect(yesNoOutput).toContain('yes: はい');
    expect(yesNoOutput).toContain('no: いいえ');

    const choiceOutput = runCli([
      'decisions', 'show', '--cwd', repoPath, '--id', choice.decisionId,
    ]).stdout;
    expect(choiceOutput).toContain('回答形式: 方針選択');
    expect(choiceOutput).toContain('plan_a: 方針A');
    expect(choiceOutput).toContain('plan_b: 方針B');
  });

  it('rejects a nonexistent repository for list, show, and answer', () => {
    const missingRepo = join(repoPath, 'does-not-exist');
    const answerInput = JSON.stringify({
      decisionId: request.decisionId,
      expectedDecisionVersion: request.decisionVersion,
      expectedContextHash: request.contextHash,
      value: { text: 'safe answer' },
      rationale: 'safe reason',
      idempotencyKey: 'missing-repo-answer',
    });
    const cases = [
      runCli(['decisions', 'list', '--cwd', missingRepo, '--json']),
      runCli([
        'decisions', 'show', '--cwd', missingRepo, '--id', request.decisionId, '--json',
      ]),
      runCli(
        ['decisions', 'answer', '--cwd', missingRepo, '--stdin-json', '--json'],
        answerInput,
      ),
    ];

    for (const result of cases) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).error.code).toBe('repository_unavailable');
      expect(result.stdout).not.toContain(missingRepo);
    }
  });
});
