# private-takt Structured Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typed What/Why/Risk/Options/How decision requests, append-only answers, stale-safe resume, and optional GitHub synchronization to private-takt.

**Architecture:** `.devloop/ledger.jsonl` remains the canonical append-only store. New focused modules validate immutable requests, fold decision events, enforce idempotent answer/apply transitions, and route only registered resume strategies; devloopd producers and CLI commands use those modules instead of writing ad-hoc stop strings.

**Tech Stack:** TypeScript ESM, Node.js `fs`/`crypto`, Commander, Vitest, existing devloopd ledger/command-runner/GitHub CLI adapters.

---

## File map

- Create `src/devloopd/decisionRequest.ts`: domain types, normalization, validation, context hashing.
- Create `src/devloopd/decisionEvents.ts`: typed events and pure event folding.
- Create `src/devloopd/decisionStore.ts`: locked append, query, answer idempotency.
- Create `src/devloopd/decisionGeneration.ts`: convert human-policy stops into requests.
- Create `src/devloopd/decisionResume.ts`: guard revalidation and registered resume strategies.
- Create `src/devloopd/decisionGithubSync.ts`: preview, redact, marker dedupe, optional comment sync.
- Create `src/app/devloopd/decisionsCommand.ts`: isolated Commander registration.
- Modify `src/devloopd/issueScout.ts`: emit request IDs for risky candidates.
- Modify `src/devloopd/prAutomation.ts`: emit requests for product-policy/human-review stops.
- Modify `src/features/tasks/execute/workflowExecutionEvents.ts`: translate structured human blockers.
- Modify `src/features/tasks/execute/workflowExecution.ts`: provide run/issue context to the bridge.
- Modify `src/features/tasks/resume/index.ts`, `src/features/tasks/resume/directRunFinder.ts`: exact noninteractive resume.
- Modify `src/app/devloopd/index.ts`: `decisions list/show/answer/apply/sync-github`.
- Modify `src/index.ts`: export the OSS decision contract.
- Modify `docs/devloopd.md`, `docs/devloopd.ja.md`, `docs/cli-reference.md`, `docs/cli-reference.ja.md`.
- Create focused Vitest files named below; do not add generated `dist/`.

### Task 1: Decision request types, validation, and context hash

**Files:**
- Create: `src/devloopd/decisionRequest.ts`
- Test: `src/__tests__/devloopd-decision-request.test.ts`

- [ ] **Step 1: Write failing tests for all three answer kinds**

```ts
import { describe, expect, it } from 'vitest';
import { createDecisionRequest } from '../devloopd/decisionRequest.js';

const subject = {
  repoPath: '/repo',
  title: 'Choose compatibility policy',
  issueNumber: 42,
};
const why = {
  summary: 'The change modifies a public API.',
  riskCategory: 'product_policy' as const,
  reasons: ['Existing consumers may break.'],
  evidence: [{ kind: 'policy' as const, reference: 'api-compat', summary: 'Public API compatibility policy' }],
};
const how = {
  summary: 'Replan issue #42 with the selected policy.',
  strategy: 'replan' as const,
  checkpoint: 'issue-plan',
  expectedEffects: ['Create a new scoped plan.'],
  verification: ['Confirm the selected policy appears in the new task context.'],
};

describe('createDecisionRequest', () => {
  it('accepts explicit yes/no options and computes a stable context hash', () => {
    const input = {
      subject, why, how, kind: 'yes_no' as const,
      what: 'May the public API change?',
      options: [
        { id: 'yes', title: 'Yes — allow the API change', description: 'Proceed with a breaking change.', consequences: ['Requires migration notes.'], recommended: false },
        { id: 'no', title: 'No — preserve compatibility', description: 'Re-scope the implementation.', consequences: ['May take longer.'], recommended: true, recommendationReason: 'Preserves existing consumers.' },
      ],
      answerRequirements: { rationaleRequired: true, minimumTextLength: 0, maximumTextLength: 0 },
      resumeGuard: { expectedDecisionVersion: 1, expectedIssueUpdatedAt: '2026-07-27T00:00:00.000Z' },
    };
    const first = createDecisionRequest(input, { decisionId: 'dec_1', now: new Date('2026-07-27T01:00:00Z') });
    const second = createDecisionRequest(input, { decisionId: 'dec_2', now: new Date('2026-07-27T02:00:00Z') });
    expect(first.contextHash).toBe(second.contextHash);
    expect(first.options.map((option) => option.id)).toEqual(['yes', 'no']);
  });

  it('rejects multiple recommended A/B options', () => {
    expect(() => createDecisionRequest({
      subject, why, how, kind: 'single_choice', what: 'Choose A or B',
      options: [
        { id: 'a', title: 'A', description: 'A', consequences: [], recommended: true },
        { id: 'b', title: 'B', description: 'B', consequences: [], recommended: true },
      ],
      answerRequirements: { rationaleRequired: true, minimumTextLength: 0, maximumTextLength: 0 },
      resumeGuard: { expectedDecisionVersion: 1 },
    })).toThrow(/recommended/i);
  });

  it('accepts text only with no options and bounded requirements', () => {
    const request = createDecisionRequest({
      subject, why, how, kind: 'text', what: 'Describe the intended policy.',
      options: [],
      answerRequirements: { rationaleRequired: true, minimumTextLength: 3, maximumTextLength: 2_000 },
      resumeGuard: { expectedDecisionVersion: 1 },
    });
    expect(request.kind).toBe('text');
  });
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run: `npx vitest run src/__tests__/devloopd-decision-request.test.ts`

Expected: FAIL because `decisionRequest.ts` does not exist.

- [ ] **Step 3: Implement discriminated request types and validation**

Implement exported `DecisionKind`, `DecisionSubject`, `DecisionWhy`, `DecisionHow`,
`DecisionOption`, `AnswerRequirements`, `ResumeGuard`, `DecisionRequest`, and:

```ts
export function createDecisionRequest(
  input: CreateDecisionRequestInput,
  options: { decisionId?: string; now?: Date } = {},
): DecisionRequest {
  const normalized = normalizeInput(input);
  validateInput(normalized);
  const decisionVersion = normalized.resumeGuard.expectedDecisionVersion;
  return {
    schemaVersion: 1,
    decisionId: options.decisionId ?? `dec_${randomUUID()}`,
    decisionVersion,
    ...normalized,
    contextHash: hashDecisionContext(normalized),
    createdAt: (options.now ?? new Date()).toISOString(),
  };
}
```

Hash canonical JSON containing subject identifiers, kind, What, Why, How, options, and
guard expectations. Exclude `decisionId`, `createdAt`, and local `repoPath`. Validate:
YES/NO IDs exactly `yes` and `no`; choices 2–8; at most one recommendation; text has no
options; all user-facing strings are nonempty and sanitized; unknown strategies fail closed.
Use the repository's `zod/v4` pattern so runtime schema and inferred TypeScript types cannot
drift. Export the types and schema from `src/index.ts`.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run src/__tests__/devloopd-decision-request.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/devloopd/decisionRequest.ts src/__tests__/devloopd-decision-request.test.ts src/index.ts
git commit -m "feat(decisions): define structured decision requests"
```

### Task 2: Append-only events and pure state folding

**Files:**
- Create: `src/devloopd/decisionEvents.ts`
- Test: `src/__tests__/devloopd-decision-events.test.ts`

- [ ] **Step 1: Write a failing state-transition test**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildDecisionAnsweredEvent,
  buildDecisionRequestedEvent,
  foldDecisionEvents,
} from '../devloopd/decisionEvents.js';
import { createDecisionRequest } from '../devloopd/decisionRequest.js';

it('folds requested and answered events without mutating the request', () => {
  const request = createDecisionRequest({
    subject: { repoPath: '/repo', title: 'Choose compatibility policy', issueNumber: 42 },
    kind: 'yes_no',
    what: 'May the public API change?',
    why: {
      summary: 'The change modifies a public API.',
      riskCategory: 'product_policy',
      reasons: ['Existing consumers may break.'],
      evidence: [{ kind: 'policy', reference: 'api-compat', summary: 'Public API compatibility policy' }],
    },
    how: {
      summary: 'Replan issue #42 with the selected policy.',
      strategy: 'replan',
      checkpoint: 'issue-plan',
      expectedEffects: ['Create a new scoped plan.'],
      verification: ['Confirm the selected policy appears in the new task context.'],
    },
    options: [
      { id: 'yes', title: 'Yes — allow the API change', description: 'Proceed.', consequences: ['Migration required.'], recommended: false },
      { id: 'no', title: 'No — preserve compatibility', description: 'Re-scope.', consequences: ['More implementation work.'], recommended: true, recommendationReason: 'Preserves consumers.' },
    ],
    answerRequirements: { rationaleRequired: true, minimumTextLength: 0, maximumTextLength: 0 },
    resumeGuard: { expectedDecisionVersion: 1 },
  }, { decisionId: 'dec_1' });
  const events = [
    buildDecisionRequestedEvent(request, new Date('2026-07-27T01:00:00Z')),
    buildDecisionAnsweredEvent({
      decisionId: 'dec_1',
      decisionVersion: 1,
      contextHash: request.contextHash,
      value: { optionId: 'no' },
      rationale: 'Compatibility is required.',
      answeredBy: 'local:maintainer',
      idempotencyKey: 'answer-1',
    }, new Date('2026-07-27T01:05:00Z')),
  ];
  const state = foldDecisionEvents(events).get('dec_1');
  expect(state?.status).toBe('answered');
  expect(state?.answer?.value).toEqual({ optionId: 'no' });
  expect(state?.request).toEqual(request);
});
```

Also test `apply_started -> applied`, `apply_failed -> answered`,
`revalidation_required`, `answer_superseded`, unknown event versions, and duplicate event IDs.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run src/__tests__/devloopd-decision-events.test.ts`

Expected: FAIL because event builders/fold do not exist.

- [ ] **Step 3: Implement typed events and fold**

Use a discriminated `eventType` union. Export `DecisionProjection` with
`request`, `status`, `answer`, `applyResult`, and `githubSync`. Reject transition events
whose version/context do not match the active request; surface invalid events in a
`DecisionFoldIssue[]` rather than silently treating them as valid.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run src/__tests__/devloopd-decision-events.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/devloopd/decisionEvents.ts src/__tests__/devloopd-decision-events.test.ts
git commit -m "feat(decisions): add append-only decision events"
```

### Task 3: Locked decision store and idempotent answers

**Files:**
- Create: `src/devloopd/decisionStore.ts`
- Modify: `src/devloopd/ledger.ts`
- Test: `src/__tests__/devloopd-decision-store.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Create a temporary repository, call `requestDecision`, answer through
`answerDecision`, reload a new store, and assert:

```ts
expect(reloaded.get('dec_1')?.status).toBe('answered');
expect((statSync(ledgerPath).mode & 0o777)).toBe(0o600);
expect(secondAnswer.eventId).toBe(firstAnswer.eventId);
```

Also prove wrong option ID, stale version/hash, second idempotency key, malformed ledger tail,
and a Decision ID from another repository fail without appending an answer.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run src/__tests__/devloopd-decision-store.test.ts`

Expected: FAIL because `DecisionStore` does not exist.

- [ ] **Step 3: Implement `DecisionStore`**

```ts
export class DecisionStore {
  constructor(readonly repoPath: string, readonly ledgerPath = resolveDevloopLedgerPath(repoPath, undefined)) {}

  list(): DecisionProjection[] {
    return [...foldDecisionEvents(readDecisionEvents(this.ledgerPath)).values()];
  }

  answer(input: DecisionAnswerInput, actor: string, now = new Date()): DecisionAnsweredEvent {
    return withDevloopFileLock(this.ledgerPath, () => {
      const current = this.requireOpenOrAnswered(input.decisionId);
      validateAnswerAgainstRequest(input, current.request);
      const duplicate = findAnswerByIdempotencyKey(current, input.idempotencyKey);
      if (duplicate !== undefined) return duplicate;
      const event = buildDecisionAnsweredEvent({ ...input, answeredBy: actor }, now);
      appendDevloopLedgerEventUnlocked(this.ledgerPath, event);
      return event;
    });
  }
}
```

Refactor `ledger.ts` only enough to expose one unlocked append helper for callers already holding
the same lock. Preserve directory `0700`, ledger `0600`, and existing public behavior.

- [ ] **Step 4: Run store and ledger regressions**

Run:
`npx vitest run src/__tests__/devloopd-decision-store.test.ts src/__tests__/devloopd-ledger.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/devloopd/decisionStore.ts src/devloopd/ledger.ts src/__tests__/devloopd-decision-store.test.ts
git commit -m "feat(decisions): persist answers idempotently"
```

### Task 4: Generate actionable requests from devloop stops

**Files:**
- Create: `src/devloopd/decisionGeneration.ts`
- Modify: `src/devloopd/issueScout.ts`
- Modify: `src/devloopd/prAutomation.ts`
- Modify: `src/features/tasks/execute/workflowExecutionEvents.ts`
- Modify: `src/features/tasks/execute/workflowExecution.ts`
- Test: `src/__tests__/devloopd-decision-generation.test.ts`
- Test: `src/__tests__/devloopd-issue-scout.test.ts`
- Test: `src/__tests__/devloopd-pr-automation.test.ts`
- Test: `src/__tests__/workflowExecutionEvents.test.ts`

- [ ] **Step 1: Add failing issue-scout and PR-stop tests**

For a `product_policy` candidate, assert the report contains one `decisionId` and the stored
request contains candidate title, acceptance criteria evidence, concrete risk reasons, choices
`approve_scope`, `revise_scope`, and `skip`, plus `replan`.

For a PR action with `human review required`, assert the request subject fixes repository,
PR number, current head, and uses `continue_pr_stage`.

For `step:blocked`, assert only structured requirements ambiguity, permission, or external
dependency output creates a request; plain blocked text and provider errors must not.

- [ ] **Step 2: Verify failure**

Run:
`npx vitest run src/__tests__/devloopd-decision-generation.test.ts src/__tests__/devloopd-issue-scout.test.ts src/__tests__/devloopd-pr-automation.test.ts`

Expected: FAIL because skipped/action records do not contain Decision IDs.

- [ ] **Step 3: Implement deterministic request generation**

Export:

```ts
export function ensureDecisionForIssueScoutCandidate(
  store: DecisionStore,
  candidate: IssueScoutCandidate,
  now: Date,
): DecisionProjection;

export function ensureDecisionForAutomationAction(
  store: DecisionStore,
  action: DevloopAutomationAction,
  context: { repoPath: string; repository?: string; headSha?: string; stage: DevloopAutomationStage },
): DecisionProjection;
```

Dedupe by active `contextHash`; never create one request per scheduler tick. Keep mechanical
CI failures, rate limits, and backoff out of Decision Requests. Add `decisionId` to the relevant
skipped/action report and automation-state artifact without deleting existing `stopRule`.
Add a `step:blocked` listener at the feature bridge, passing `runSlug` and current issue number
from `workflowExecution.ts`; do not couple `WorkflowRunLoop` core to the devloop decision store.

- [ ] **Step 4: Run generation regressions**

Run:
`npx vitest run src/__tests__/devloopd-decision-generation.test.ts src/__tests__/devloopd-issue-scout.test.ts src/__tests__/devloopd-pr-automation.test.ts src/__tests__/workflowExecutionEvents.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/devloopd/decisionGeneration.ts src/devloopd/issueScout.ts src/devloopd/prAutomation.ts src/features/tasks/execute/workflowExecutionEvents.ts src/features/tasks/execute/workflowExecution.ts src/__tests__/devloopd-decision-generation.test.ts src/__tests__/devloopd-issue-scout.test.ts src/__tests__/devloopd-pr-automation.test.ts src/__tests__/workflowExecutionEvents.test.ts
git commit -m "feat(decisions): escalate actionable devloop stops"
```

### Task 5: CLI list, show, and stdin answer

**Files:**
- Create: `src/app/devloopd/decisionsCommand.ts`
- Modify: `src/app/devloopd/index.ts`
- Test: `src/__tests__/devloopd-decisions-cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Spawn built `dist/app/devloopd/index.js` against a temporary ledger. Assert:

- `decisions list --json` returns projections.
- `decisions show --id dec_1 --json` returns one projection.
- `decisions answer --stdin-json` consumes JSON from stdin.
- free-text answers do not appear in argv or formatted success output.
- invalid JSON exits nonzero with a machine-readable error when `--json` is present.

- [ ] **Step 2: Verify failure**

Run: `npm run build && npx vitest run src/__tests__/devloopd-decisions-cli.test.ts`

Expected: FAIL because `decisions` is unknown.

- [ ] **Step 3: Register a parent `decisions` command**

Implement and export `registerDecisionsCommand(program: Command)` so the main CLI only invokes
the registrar. Add `list`, `show`, and `answer` subcommands. Implement:

```ts
async function readJsonFromStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
```

Resolve `--cwd`, construct `DecisionStore`, validate input before append, derive actor from the
local execution context, and provide both Japanese human output and stable JSON.

- [ ] **Step 4: Run build and CLI tests**

Run:
`npm run build && npx vitest run src/__tests__/devloopd-decisions-cli.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/devloopd/decisionsCommand.ts src/app/devloopd/index.ts src/__tests__/devloopd-decisions-cli.test.ts
git commit -m "feat(cli): answer structured decisions"
```

### Task 6: Guarded apply and registered resume strategies

**Files:**
- Create: `src/devloopd/decisionResume.ts`
- Modify: `src/features/tasks/resume/index.ts`
- Modify: `src/features/tasks/resume/directRunFinder.ts`
- Modify: `src/devloopd/prAutomation.ts`
- Modify: `src/app/devloopd/index.ts`
- Test: `src/__tests__/devloopd-decision-resume.test.ts`
- Test: `src/__tests__/commands-resume.test.ts`
- Test: `src/__tests__/devloopd-pr-automation.test.ts`

- [ ] **Step 1: Write failing stale and idempotency tests**

Inject fake `ResumeAdapter`s and assert:

```ts
expect(await applyDecision(validContext)).toMatchObject({ status: 'applied' });
expect(adapter.calls).toHaveLength(1);
expect(await applyDecision(validContext)).toMatchObject({ status: 'applied' });
expect(adapter.calls).toHaveLength(1);
```

Change head SHA, run status, dirty state, active-run result, decision version, and context hash
one at a time; each must append `revalidation_required` and never call the adapter.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run src/__tests__/devloopd-decision-resume.test.ts`

Expected: FAIL because apply/resume registry does not exist.

- [ ] **Step 3: Implement guard-first apply**

Define:

```ts
export interface ResumeAdapter {
  strategy: ResumeStrategy;
  revalidate(context: ResumeContext): Promise<RevalidationResult>;
  resume(context: ResumeContext): Promise<ResumeResult>;
}
```

Register explicit adapters for `rerun_issue`, `resume_direct_run`, `continue_pr_stage`,
`replan`, and `manual_only`. Reuse existing `runDevloopIssue`. Refactor direct resume into
`resumeDirectRunBySlug(projectDir, runSlug, ...)` so apply never opens an interactive picker.
Add `continuePullRequestAutomationStage({ pr, stage, expectedHeadSha, ... })`; calling the
existing all-PR stage API is forbidden because it can mutate unrelated PRs. Keep existing
review/check/label/merge gates in both paths. Do not persist or execute arbitrary commands.
Append `apply_started` before side effects and terminal applied/failed/revalidation events afterward.

- [ ] **Step 4: Add CLI `decisions apply` and run tests**

Run:
`npm run build && npx vitest run src/__tests__/devloopd-decision-resume.test.ts src/__tests__/devloopd-decisions-cli.test.ts src/__tests__/commands-resume.test.ts src/__tests__/devloopd-pr-automation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/devloopd/decisionResume.ts src/features/tasks/resume/index.ts src/features/tasks/resume/directRunFinder.ts src/devloopd/prAutomation.ts src/app/devloopd/decisionsCommand.ts src/__tests__/devloopd-decision-resume.test.ts src/__tests__/devloopd-decisions-cli.test.ts src/__tests__/commands-resume.test.ts src/__tests__/devloopd-pr-automation.test.ts
git commit -m "feat(decisions): resume work after fresh answers"
```

### Task 7: Optional and idempotent GitHub synchronization

**Files:**
- Create: `src/devloopd/decisionGithubSync.ts`
- Modify: `src/app/devloopd/index.ts`
- Test: `src/__tests__/devloopd-decision-github-sync.test.ts`

- [ ] **Step 1: Write failing preview and sync tests**

Use a fake `DevloopCommandRunner`. Assert preview excludes local paths, raw evidence, tokens,
and private task bodies; marker includes ID/version; an existing marker does not create a
second comment; auth/network failure appends failed sync while leaving the answer/applied
projection unchanged.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run src/__tests__/devloopd-decision-github-sync.test.ts`

Expected: FAIL because GitHub decision sync does not exist.

- [ ] **Step 3: Implement preview and explicit sync**

Resolve repository and Issue/PR strictly from `DecisionSubject`. Use `gh issue view` or
`gh pr view` comments to detect:

```html
<!-- takt-decision:v1 id=dec_1 version=1 -->
```

Then call the corresponding typed `gh ... comment --body <sanitized>` arguments. Never accept
repository or number overrides from the sync command. Append success/failure sync events and
make retry safe.

- [ ] **Step 4: Register `sync-github` and run tests**

Run:
`npm run build && npx vitest run src/__tests__/devloopd-decision-github-sync.test.ts src/__tests__/devloopd-decisions-cli.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/devloopd/decisionGithubSync.ts src/app/devloopd/index.ts src/__tests__/devloopd-decision-github-sync.test.ts src/__tests__/devloopd-decisions-cli.test.ts
git commit -m "feat(decisions): optionally sync answers to GitHub"
```

### Task 8: Documentation, contract fixtures, and full verification

**Files:**
- Create: `builtins/schemas/decision-request-v1.json`
- Create: `fixtures/decisions/v1/yes-no.json`
- Create: `fixtures/decisions/v1/single-choice.json`
- Create: `fixtures/decisions/v1/text.json`
- Modify: `docs/devloopd.md`
- Modify: `docs/devloopd.ja.md`
- Modify: `docs/cli-reference.md`
- Modify: `docs/cli-reference.ja.md`
- Modify: `.gitignore` only if new generated local state is introduced

- [ ] **Step 1: Add sanitized public fixtures**

Fixtures must use `/example/repo`, fictional issue/PR IDs, no credentials, no private text, and
cover all schema fields. Validate them from `devloopd-decision-request.test.ts`.

- [ ] **Step 2: Document the operator workflow**

Document list/show, stdin answer, apply, optional sync, stale revalidation, old unstructured
stops, ledger permissions, and examples in English/Japanese. State that an answer never bypasses
tests, review, clean-worktree, or head-match gates.

- [ ] **Step 3: Run the complete private-takt gate**

Run:

```bash
npm run build
npm run lint
npm test
npm run test:e2e:mock
npm run check:personal
git diff --check
```

Expected: all commands exit 0; replay gate has no false negatives; no secret/path appears in
fixtures or GitHub preview snapshots.

- [ ] **Step 4: Perform security and self-review**

Review event transitions, lock nesting, stale checks, argv/stdout leakage, path containment,
GitHub target fixation, redaction, and duplicate side effects. Fix every P0/P1/P2 finding and
rerun the affected gate.

- [ ] **Step 5: Commit**

```bash
git add builtins/schemas/decision-request-v1.json fixtures/decisions docs/devloopd.md docs/devloopd.ja.md docs/cli-reference.md docs/cli-reference.ja.md .gitignore
git commit -m "docs(decisions): document answer and resume workflow"
```
