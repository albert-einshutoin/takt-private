import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDecisionRequest, type DecisionRequest } from '../devloopd/decisionRequest.js';
import { DecisionStore } from '../devloopd/decisionStore.js';

const CLI_PATH = resolve('dist/app/devloopd/index.js');

function makeRequest(repoPath: string, decisionId = 'dec_cli'): DecisionRequest {
  return createDecisionRequest({
    kind: 'text',
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
  }, {
    decisionId,
    now: new Date('2026-07-28T00:00:00.000Z'),
  });
}

function runCli(
  args: readonly string[],
  input?: string,
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
});
