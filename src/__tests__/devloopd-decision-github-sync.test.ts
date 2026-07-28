import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { createDefaultDevloopCommandRunner } from '../devloopd/commandRunner.js';
import {
  createDecisionAppliedEvent,
  createDecisionApplyStartedEvent,
} from '../devloopd/decisionEvents.js';
import { createDecisionRequest, type DecisionRequest } from '../devloopd/decisionRequest.js';
import { DecisionStore } from '../devloopd/decisionStore.js';
import { appendDevloopLedgerEvent } from '../devloopd/ledger.js';

class FakeRunner implements DevloopCommandRunner {
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: Parameters<DevloopCommandRunner['exec']>[2];
  }> = [];
  readonly results: DevloopCommandResult[] = [];
  thrown: unknown;

  resolveCommand(command: string): string | undefined {
    return command === 'gh' ? '/usr/bin/gh' : undefined;
  }

  async exec(
    command: string,
    args: readonly string[],
    options?: Parameters<DevloopCommandRunner['exec']>[2],
  ): Promise<DevloopCommandResult> {
    this.calls.push({ command, args, options });
    if (this.thrown !== undefined) throw this.thrown;
    return this.results.shift() ?? { exitCode: 1, stdout: '', stderr: 'unexpected command' };
  }
}

function makeRequest(
  repoPath: string,
  decisionId = 'dec_github',
  target: { issueNumber: number } | { prNumber: number } = { issueNumber: 42 },
): DecisionRequest {
  return createDecisionRequest({
    kind: 'text',
    subject: {
      repoPath,
      repository: 'octo/project',
      ...target,
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

function markApplied(store: DecisionStore, request: DecisionRequest): void {
  const projection = store.get(request.decisionId);
  const answerEventId = projection?.answer?.eventId;
  if (answerEventId === undefined) throw new Error('answer missing');
  const identity = {
    decisionId: request.decisionId,
    decisionVersion: request.decisionVersion,
    contextHash: request.contextHash,
    answerEventId,
    sanitizedSummary: '固定された適用状態です。',
  };
  appendDevloopLedgerEvent(store.ledgerPath, createDecisionApplyStartedEvent(identity, {
    eventId: `evt_apply_started_${request.decisionId}`,
  }));
  appendDevloopLedgerEvent(store.ledgerPath, createDecisionAppliedEvent(identity, {
    eventId: `evt_applied_${request.decisionId}`,
  }));
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
    expect(runner.calls[0]).toMatchObject({
      command: '/usr/bin/gh',
      args: ['issue', 'view', '42', '--repo', 'octo/project', '--json', 'number,url,comments'],
      options: { maxOutputBytes: 1024 * 1024 },
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
          viewerDidAuthor: true,
          body: preview.body,
        }],
      }),
      stderr: '',
    });

    const result = await syncDecisionToGithub({ store, decisionId: request.decisionId, runner });

    expect(result).toMatchObject({ status: 'synced', existing: true, commentId: '123' });
    expect(runner.calls).toHaveLength(1);
  });

  it('updates one owned generated comment when the local projection advances', async () => {
    const initialRunner = new FakeRunner();
    initialRunner.results.push(
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
    await syncDecisionToGithub({ store, decisionId: request.decisionId, runner: initialRunner });
    const answeredPreview = buildDecisionGithubPreview(store.get(request.decisionId)!);
    markApplied(store, request);
    const appliedPreview = buildDecisionGithubPreview(store.get(request.decisionId)!);
    expect(appliedPreview.body).toContain('状態: 適用済み');

    const runner = new FakeRunner();
    runner.results.push(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 42,
          url: 'https://github.com/octo/project/issues/42',
          comments: [{
            id: 'IC_123',
            url: 'https://github.com/octo/project/issues/42#issuecomment-123',
            viewerDidAuthor: true,
            body: answeredPreview.body,
          }],
        }),
        stderr: '',
      },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          id: 123,
          html_url: 'https://github.com/octo/project/issues/42#issuecomment-123',
          body: appliedPreview.body,
        }),
        stderr: '',
      },
    );

    const result = await syncDecisionToGithub({ store, decisionId: request.decisionId, runner });

    expect(result).toMatchObject({ status: 'synced', existing: true, commentId: '123' });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.args).toEqual([
      'api',
      '--method',
      'PATCH',
      'repos/octo/project/issues/comments/123',
      '-f',
      `body=${appliedPreview.body}`,
    ]);
    expect(runner.calls.filter((call) => call.args[1] === 'comment')).toHaveLength(0);
    expect(runner.calls.every(
      (call) => call.options?.maxOutputBytes === 1024 * 1024,
    )).toBe(true);
  });

  it('recreates a locally recorded comment after verified external deletion', async () => {
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
        stdout: 'https://github.com/octo/project/issues/42#issuecomment-123\n',
        stderr: '',
      },
    );
    await syncDecisionToGithub({ store, decisionId: request.decisionId, runner: firstRunner });

    const retryRunner = new FakeRunner();
    retryRunner.results.push(
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
        stdout: 'https://github.com/octo/project/issues/42#issuecomment-456\n',
        stderr: '',
      },
    );
    const recreated = await syncDecisionToGithub({
      store,
      decisionId: request.decisionId,
      runner: retryRunner,
    });

    expect(recreated).toMatchObject({
      status: 'synced',
      existing: false,
      commentId: '456',
    });
    expect(retryRunner.calls.map((call) => call.args[1])).toEqual(['view', 'comment']);
  });

  it('does not edit a matching marker comment not owned by the authenticated viewer', async () => {
    const preview = buildDecisionGithubPreview(store.get(request.decisionId)!);
    const runner = new FakeRunner();
    runner.results.push({
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        url: 'https://github.com/octo/project/issues/42',
        comments: [{
          id: 'IC_777',
          url: 'https://github.com/octo/project/issues/42#issuecomment-777',
          viewerDidAuthor: false,
          body: preview.body,
        }],
      }),
      stderr: '',
    });

    const result = await syncDecisionToGithub({ store, decisionId: request.decisionId, runner });

    expect(result).toMatchObject({ status: 'failed', errorCode: 'untrusted_github_response' });
    expect(runner.calls).toHaveLength(1);
  });

  it('rejects duplicate matching markers instead of choosing an edit target', async () => {
    const preview = buildDecisionGithubPreview(store.get(request.decisionId)!);
    const runner = new FakeRunner();
    runner.results.push({
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        url: 'https://github.com/octo/project/issues/42',
        comments: [123, 124].map((id) => ({
          id: `IC_${id}`,
          url: `https://github.com/octo/project/issues/42#issuecomment-${id}`,
          viewerDidAuthor: true,
          body: preview.body,
        })),
      }),
      stderr: '',
    });

    const result = await syncDecisionToGithub({ store, decisionId: request.decisionId, runner });

    expect(result).toMatchObject({ status: 'failed', errorCode: 'untrusted_github_response' });
    expect(runner.calls).toHaveLength(1);
  });

  it('hashes a maximum-length decision ID before acquiring the kernel lock', async () => {
    const decisionId = `d${'a'.repeat(199)}`;
    const longRequest = makeRequest(repoPath, decisionId);
    store.request(longRequest, { eventId: 'evt_long_requested' });
    store.answer({
      decisionId,
      expectedDecisionVersion: longRequest.decisionVersion,
      expectedContextHash: longRequest.contextHash,
      value: { text: 'long id answer' },
      rationale: 'long id rationale',
      idempotencyKey: 'long-id-answer',
    }, 'local:test', { eventId: 'evt_long_answered' });
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
        stdout: 'https://github.com/octo/project/issues/42#issuecomment-888\n',
        stderr: '',
      },
    );

    const result = await syncDecisionToGithub({ store, decisionId, runner });

    expect(result).toMatchObject({ status: 'synced', commentId: '888' });
    expect(runner.calls).toHaveLength(2);
  });

  it('uses the typed pull-request route without accepting target overrides', async () => {
    const prRequest = makeRequest(repoPath, 'dec_pr_sync', { prNumber: 9 });
    store.request(prRequest, { eventId: 'evt_pr_requested' });
    answer(store, prRequest);
    const runner = new FakeRunner();
    runner.results.push(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 9,
          url: 'https://github.com/octo/project/pull/9',
          comments: [],
        }),
        stderr: '',
      },
      {
        exitCode: 0,
        stdout: 'https://github.com/octo/project/pull/9#issuecomment-909\n',
        stderr: '',
      },
    );

    const result = await syncDecisionToGithub({
      store,
      decisionId: prRequest.decisionId,
      runner,
    });

    expect(result).toMatchObject({ status: 'synced', commentId: '909' });
    expect(runner.calls[0]?.args).toEqual([
      'pr', 'view', '9', '--repo', 'octo/project', '--json', 'number,url,comments',
    ]);
    expect(runner.calls[1]?.args.slice(0, 5)).toEqual([
      'pr', 'comment', '9', '--repo', 'octo/project',
    ]);
  });

  it('keeps an applied projection unchanged after a network failure', async () => {
    markApplied(store, request);
    const before = store.get(request.decisionId);
    const runner = new FakeRunner();
    runner.results.push({
      exitCode: 1,
      stdout: 'private answer free text',
      stderr: 'token=network-secret',
    });

    const result = await syncDecisionToGithub({ store, decisionId: request.decisionId, runner });
    const after = store.get(request.decisionId);

    expect(result).toMatchObject({ status: 'failed', errorCode: 'github_unavailable' });
    expect(after?.status).toBe('applied');
    expect(after?.answer).toEqual(before?.answer);
    expect(after?.applyResult).toEqual(before?.applyResult);
  });

  it('serializes concurrent synchronization so only one comment is posted', async () => {
    const runner = new FakeRunner();
    const preview = buildDecisionGithubPreview(store.get(request.decisionId)!);
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
      {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 42,
          url: 'https://github.com/octo/project/issues/42',
          comments: [{
            id: 'IC_321',
            url: 'https://github.com/octo/project/issues/42#issuecomment-321',
            viewerDidAuthor: true,
            body: preview.body,
          }],
        }),
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
    expect(runner.calls).toHaveLength(3);
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
          viewerDidAuthor: true,
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

  it('holds the sync lock until a timed-out POST child closes before retrying', async () => {
    const scriptPath = join(repoPath, 'fake-gh.mjs');
    const statePath = join(repoPath, 'fake-gh-state.json');
    writeFileSync(statePath, JSON.stringify({ posts: 0, comments: [] }), { mode: 0o600 });
    writeFileSync(scriptPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const statePath = process.env.TAKT_TEST_GH_STATE;
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, 'utf8'));
if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 42,
    url: 'https://github.com/octo/project/issues/42',
    comments: state.comments,
  }));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'comment') {
  const body = args[args.indexOf('--body') + 1];
  process.on('SIGTERM', () => {});
  setTimeout(() => {
    const next = {
      posts: state.posts + 1,
      comments: [{
        id: 'IC_765',
        url: 'https://github.com/octo/project/issues/42#issuecomment-765',
        viewerDidAuthor: true,
        body,
      }],
    };
    writeFileSync(statePath, JSON.stringify(next));
    process.stdout.write('https://github.com/octo/project/issues/42#issuecomment-765\\n');
  }, 700);
  setTimeout(() => {}, 5000);
}
`, { mode: 0o700 });
    chmodSync(scriptPath, 0o700);
    const baseRunner = createDefaultDevloopCommandRunner();
    const runner: DevloopCommandRunner = {
      resolveCommand: () => scriptPath,
      exec: baseRunner.exec,
    };
    const env = {
      ...process.env,
      TAKT_LOOP_GH_TIMEOUT_MS: '500',
      TAKT_TEST_GH_STATE: statePath,
    };

    const firstPromise = syncDecisionToGithub({
      store,
      decisionId: request.decisionId,
      runner,
      env,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 900));
    const retryPromise = syncDecisionToGithub({
      store,
      decisionId: request.decisionId,
      runner,
      env,
    });
    const [first, retry] = await Promise.all([firstPromise, retryPromise]);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { posts: number };

    expect(first).toMatchObject({ status: 'failed', errorCode: 'github_unavailable' });
    expect(retry).toMatchObject({ status: 'synced', existing: true, commentId: '765' });
    expect(state.posts).toBe(1);
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
          viewerDidAuthor: true,
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
