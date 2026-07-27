import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDecisionGithubPreview,
  syncDecisionToGithub,
} from '../devloopd/decisionGithubSync.js';
import type {
  DevloopCommandResult,
  DevloopCommandRunner,
} from '../devloopd/commandRunner.js';
import { createDecisionRequest, type DecisionRequest } from '../devloopd/decisionRequest.js';
import { DecisionStore } from '../devloopd/decisionStore.js';

class FakeRunner implements DevloopCommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  readonly results: DevloopCommandResult[] = [];
  thrown: unknown;

  resolveCommand(command: string): string | undefined {
    return command === 'gh' ? '/usr/bin/gh' : undefined;
  }

  async exec(command: string, args: readonly string[]): Promise<DevloopCommandResult> {
    this.calls.push({ command, args });
    if (this.thrown !== undefined) throw this.thrown;
    return this.results.shift() ?? { exitCode: 1, stdout: '', stderr: 'unexpected command' };
  }
}

function makeRequest(repoPath: string, decisionId = 'dec_github'): DecisionRequest {
  return createDecisionRequest({
    kind: 'text',
    subject: {
      repoPath,
      repository: 'octo/project',
      issueNumber: 42,
      runSlug: 'private-task-body',
      step: 'approval',
      title: 'private task body /Users/alice/work token=title-secret',
    },
    question: 'Private roadmap? token=question-secret',
    why: {
      summary: 'Why /Users/alice/evidence token=why-secret',
      riskCategory: 'requirements_ambiguity',
      reasons: ['raw evidence ghp_1234567890'],
      evidence: [{
        kind: 'report',
        reference: '/Users/alice/private/report.md',
        summary: 'private customer name',
      }],
    },
    how: {
      summary: 'Apply private roadmap',
      expectedEffects: ['private effect'],
      verification: ['private check'],
    },
    answerRequirements: {
      rationaleRequired: true,
      minimumTextLength: 3,
      maximumTextLength: 100,
    },
    resumeGuard: {
      strategy: 'direct_run',
      expectedDecisionVersion: 1,
      runSlug: 'private-task-body',
      expectedRunStatus: 'aborted',
      expectedAbortKind: 'blocked',
      expectedBlockedStep: 'approval',
    },
  }, {
    decisionId,
    now: new Date('2026-07-28T00:00:00.000Z'),
  });
}

function answer(store: DecisionStore, request: DecisionRequest): void {
  store.answer({
    decisionId: request.decisionId,
    expectedDecisionVersion: request.decisionVersion,
    expectedContextHash: request.contextHash,
    value: { text: 'private answer free text' },
    rationale: 'private rationale token=rationale-secret',
    idempotencyKey: `answer-${request.decisionId}`,
  }, 'local:test', { eventId: `evt_answer_${request.decisionId}` });
}

describe('decision GitHub synchronization', () => {
  let repoPath: string;
  let request: DecisionRequest;
  let store: DecisionStore;

  beforeEach(() => {
    repoPath = join(tmpdir(), `takt-decision-github-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
    store = new DecisionStore(repoPath);
    request = makeRequest(repoPath);
    store.request(request, { eventId: 'evt_requested' });
    answer(store, request);
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('builds a fixed public preview without private decision or answer text', () => {
    const projection = store.get(request.decisionId);
    expect(projection).toBeDefined();
    const preview = buildDecisionGithubPreview(projection!);

    expect(preview.marker).toBe('<!-- takt-decision:v1 id=dec_github version=1 -->');
    expect(preview.body).toContain(preview.marker);
    expect(preview.body).toContain('回答済み');
    for (const secret of [
      repoPath,
      '/Users/alice',
      'private-task-body',
      'private task body',
      'Private roadmap',
      'raw evidence',
      'private customer',
      'private answer free text',
      'private rationale',
      'title-secret',
      'question-secret',
      'why-secret',
      'rationale-secret',
      'ghp_1234567890',
    ]) {
      expect(preview.body).not.toContain(secret);
    }
  });

  it('uses only the typed subject target and posts sanitized argv once', async () => {
    const runner = new FakeRunner();
    runner.results.push(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 42,
          url: 'https://github.com/octo/project/issues/42',
          comments: [],
        }),
        stderr: '',
      },
      {
        exitCode: 0,
        stdout: 'https://github.com/octo/project/issues/42#issuecomment-123\n',
        stderr: '',
      },
    );

    const before = store.get(request.decisionId);
    const result = await syncDecisionToGithub({ store, decisionId: request.decisionId, runner });
    const after = store.get(request.decisionId);

    expect(result).toMatchObject({ status: 'synced', existing: false, commentId: '123' });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]).toEqual({
      command: '/usr/bin/gh',
      args: ['issue', 'view', '42', '--repo', 'octo/project', '--json', 'number,url,comments'],
    });
    expect(runner.calls[1]?.args.slice(0, 5)).toEqual([
      'issue', 'comment', '42', '--repo', 'octo/project',
    ]);
    expect(runner.calls[1]?.args).toContain('--body');
    expect(runner.calls.flatMap((call) => call.args).join(' ')).not.toContain(repoPath);
    expect(after?.status).toBe(before?.status);
    expect(after?.answer).toEqual(before?.answer);
    expect(after?.applyResult).toEqual(before?.applyResult);
    expect(after?.githubSync).toMatchObject({ status: 'synced', commentId: '123' });
  });

  it('treats the exact existing generated comment as idempotent and does not post', async () => {
    const preview = buildDecisionGithubPreview(store.get(request.decisionId)!);
    const runner = new FakeRunner();
    runner.results.push({
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        url: 'https://github.com/octo/project/issues/42',
        comments: [{
          id: 'IC_123',
          url: 'https://github.com/octo/project/issues/42#issuecomment-123',
          body: preview.body,
        }],
      }),
      stderr: '',
    });

    const result = await syncDecisionToGithub({ store, decisionId: request.decisionId, runner });

    expect(result).toMatchObject({ status: 'synced', existing: true, commentId: '123' });
    expect(runner.calls).toHaveLength(1);
  });

  it('serializes concurrent synchronization so only one comment is posted', async () => {
    const runner = new FakeRunner();
    runner.results.push(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 42,
          url: 'https://github.com/octo/project/issues/42',
          comments: [],
        }),
        stderr: '',
      },
      {
        exitCode: 0,
        stdout: 'https://github.com/octo/project/issues/42#issuecomment-321\n',
        stderr: '',
      },
    );

    const [first, second] = await Promise.all([
      syncDecisionToGithub({ store, decisionId: request.decisionId, runner }),
      syncDecisionToGithub({ store, decisionId: request.decisionId, runner }),
    ]);

    expect(first).toMatchObject({ status: 'synced', commentId: '321' });
    expect(second).toMatchObject({ status: 'synced', commentId: '321' });
    expect([first, second].filter(
      (result) => result.status === 'synced' && result.existing === false,
    )).toHaveLength(1);
    expect([first, second].filter(
      (result) => result.status === 'synced' && result.existing === true,
    )).toHaveLength(1);
    expect(runner.calls.filter((call) => call.args[1] === 'comment')).toHaveLength(1);
    expect(runner.calls).toHaveLength(2);
  });

  it('reconciles a POST completed before local terminal persistence without posting again', async () => {
    const firstRunner = new FakeRunner();
    firstRunner.results.push(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 42,
          url: 'https://github.com/octo/project/issues/42',
          comments: [],
        }),
        stderr: '',
      },
      {
        exitCode: 0,
        stdout: 'https://github.com/octo/project/issues/42#issuecomment-654\n',
        stderr: '',
      },
    );

    const interrupted = await syncDecisionToGithub({
      store,
      decisionId: request.decisionId,
      runner: firstRunner,
      afterCommentCreated() {
        throw new Error('simulated process interruption');
      },
    });
    expect(interrupted).toMatchObject({ status: 'failed', errorCode: 'ledger_unavailable' });
    expect(store.get(request.decisionId)?.githubSync?.status).toBe('pending');

    const preview = buildDecisionGithubPreview(store.get(request.decisionId)!);
    const retryRunner = new FakeRunner();
    retryRunner.results.push({
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        url: 'https://github.com/octo/project/issues/42',
        comments: [{
          id: 'IC_654',
          url: 'https://github.com/octo/project/issues/42#issuecomment-654',
          body: preview.body,
        }],
      }),
      stderr: '',
    });

    const recovered = await syncDecisionToGithub({
      store,
      decisionId: request.decisionId,
      runner: retryRunner,
    });

    expect(recovered).toMatchObject({
      status: 'synced',
      existing: true,
      commentId: '654',
    });
    expect(retryRunner.calls).toHaveLength(1);
    expect(retryRunner.calls[0]?.args[1]).toBe('view');
  });

  it('fails closed on marker collision and keeps answer/application projections unchanged', async () => {
    const runner = new FakeRunner();
    const marker = buildDecisionGithubPreview(store.get(request.decisionId)!).marker;
    runner.results.push({
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        url: 'https://github.com/octo/project/issues/42',
        comments: [{
          id: 'IC_collision',
          url: 'https://github.com/octo/project/issues/42#issuecomment-999',
          body: `<details>${marker}</details><script>private</script>`,
        }],
      }),
      stderr: '',
    });
    const before = store.get(request.decisionId);

    const result = await syncDecisionToGithub({ store, decisionId: request.decisionId, runner });
    const after = store.get(request.decisionId);

    expect(result).toMatchObject({ status: 'failed', errorCode: 'untrusted_github_response' });
    expect(runner.calls).toHaveLength(1);
    expect(after?.status).toBe(before?.status);
    expect(after?.answer).toEqual(before?.answer);
    expect(after?.applyResult).toEqual(before?.applyResult);
    expect(after?.githubSync).toMatchObject({
      status: 'failed',
      sanitizedError: 'GitHub同期に失敗しました。',
    });
  });

  it.each([
    ['wrong number', { number: 43, url: 'https://github.com/octo/project/issues/43', comments: [] }],
    ['wrong repository', { number: 42, url: 'https://github.com/evil/project/issues/42', comments: [] }],
    ['malformed JSON', '{not json'],
    ['huge response', 'x'.repeat(1_048_577)],
  ])('fails closed for %s without posting or reflecting GitHub output', async (_name, response) => {
    const runner = new FakeRunner();
    runner.results.push({
      exitCode: 0,
      stdout: typeof response === 'string' ? response : JSON.stringify(response),
      stderr: 'token=network-secret /Users/alice/private',
    });
    const result = await syncDecisionToGithub({ store, decisionId: request.decisionId, runner });

    expect(result).toEqual({
      status: 'failed',
      decisionId: request.decisionId,
      errorCode: 'untrusted_github_response',
      sanitizedError: 'GitHub同期に失敗しました。',
    });
    expect(runner.calls).toHaveLength(1);
  });

  it('contains runner Proxy failures without touching traps or exposing secrets', async () => {
    let traps = 0;
    const runner = new FakeRunner();
    runner.thrown = new Proxy({}, {
      get() {
        traps += 1;
        throw new Error('token=proxy-secret');
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error('token=prototype-secret');
      },
    });

    await expect(syncDecisionToGithub({
      store,
      decisionId: request.decisionId,
      runner,
    })).resolves.toEqual({
      status: 'failed',
      decisionId: request.decisionId,
      errorCode: 'github_unavailable',
      sanitizedError: 'GitHub同期に失敗しました。',
    });
    expect(traps).toBe(0);
  });

  it('rejects accessor-backed command results without evaluating accessors', async () => {
    let getterCalls = 0;
    const accessorResult = {
      get exitCode() {
        getterCalls += 1;
        throw new Error('token=result-secret');
      },
      stdout: '{}',
      stderr: '',
    } as DevloopCommandResult;
    const runner: DevloopCommandRunner = {
      resolveCommand: () => '/usr/bin/gh',
      exec: async () => accessorResult,
    };

    await expect(syncDecisionToGithub({
      store,
      decisionId: request.decisionId,
      runner,
    })).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'untrusted_github_response',
      sanitizedError: 'GitHub同期に失敗しました。',
    });
    expect(getterCalls).toBe(0);
  });
});
