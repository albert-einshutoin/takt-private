# Independent Pipeline Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure devloopd and direct TAKT issue pipelines create independent branches from the configured base instead of inheriting the currently checked-out feature branch.

**Architecture:** Devloopd will always request worktree isolation. The direct pipeline fallback will resolve a concrete base start point, create the branch with that explicit Git ref, and verify the resulting HEAD before workflow execution. Existing PR repair, copy workspace, and skip-git paths remain unchanged.

**Tech Stack:** TypeScript ESM, Node.js `execFileSync`, Vitest, Git CLI, ESLint

---

## File Map

- `src/devloopd/run.ts`: constructs the guarded TAKT command used by devloopd issue automation.
- `src/__tests__/devloopd-run.test.ts`: locks worktree isolation into every devloopd issue invocation.
- `src/features/pipeline/steps.ts`: resolves the base start point and creates/verifies direct pipeline branches.
- `src/__tests__/pipelineExecution.test.ts`: unit coverage for explicit branch start points and invariant failure.
- `src/__tests__/it-independent-pipeline-branch.test.ts`: real-Git regression proving branch B excludes branch A.
- `docs/superpowers/specs/2026-07-18-independent-pipeline-branches-design.md`: approved behavior and compatibility contract.

### Task 1: Force worktree isolation in devloopd

**Files:**
- Modify: `src/__tests__/devloopd-run.test.ts:97-185`
- Modify: `src/devloopd/run.ts:56-82`

- [ ] **Step 1: Write the failing command-contract tests**

Update both expected argument lists so `--isolation`, `worktree` immediately follow `--pipeline`:

```ts
args: [
  '--pipeline',
  '--isolation',
  'worktree',
  '--issue',
  '123',
  // existing workflow and optional arguments
]
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/__tests__/devloopd-run.test.ts
```

Expected: the two command-argument assertions fail because `run.ts` omits `--isolation worktree`.

- [ ] **Step 3: Add the minimal guarded argument**

Change the start of `buildTaktIssueArgs` to:

```ts
const args = [
  '--pipeline',
  '--isolation',
  'worktree',
  '--issue',
  options.issue,
  '--workflow',
  options.workflow,
];
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run src/__tests__/devloopd-run.test.ts
```

Expected: all `devloopd run` tests pass.

- [ ] **Step 5: Commit the isolated automation change**

```bash
git add src/devloopd/run.ts src/__tests__/devloopd-run.test.ts
git commit -m "fix(devloopd): isolate issue pipelines in worktrees"
```

### Task 2: Create direct pipeline branches from the resolved base

**Files:**
- Modify: `src/__tests__/pipelineExecution.test.ts:120-245,570-601`
- Modify: `src/features/pipeline/steps.ts:1-90,258-282`

- [ ] **Step 1: Write failing explicit-start-point tests**

Add assertions for the direct task pipeline:

```ts
const checkoutCall = mockExecFileSync.mock.calls.find(
  (call: unknown[]) => call[0] === 'git'
    && (call[1] as string[]).slice(0, 2).join(' ') === 'checkout -b',
);
expect(checkoutCall?.[1]).toEqual([
  'checkout',
  '-b',
  expect.stringMatching(/^takt\/pipeline-/),
  'origin/main',
]);
```

Add an invariant test that returns different commit IDs for the chosen start
point and the created `HEAD`, then expects pipeline setup to fail with exit code
`4` and no workflow execution.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/__tests__/pipelineExecution.test.ts
```

Expected: the checkout assertion reports the missing fourth argument, and the invariant test observes workflow execution instead of setup failure.

- [ ] **Step 3: Preserve the logical base and concrete start point**

Import `remoteBranchExists` and replace the string-only resolver with:

```ts
interface ExecutionBase {
  branch: string;
  startPoint: string;
}

function resolveExecutionBase(cwd: string, preferredBaseBranch?: string): ExecutionBase {
  const resolved = resolveBaseBranch(cwd, preferredBaseBranch);
  const branch = requireBaseBranch(resolved.branch, 'execution context');
  const startPoint = resolved.fetchedCommit
    ?? (remoteBranchExists(cwd, branch) ? `origin/${branch}` : branch);
  return { branch, startPoint };
}
```

Keep read-only and PR-repair resolution based on the logical branch name.

- [ ] **Step 4: Create and verify the new branch before agent work**

Use the explicit start point and compare resolved commit IDs:

```ts
execFileSync('git', ['checkout', '-b', branch, base.startPoint], { cwd, stdio: 'pipe' });
const expectedHead = execFileSync('git', ['rev-parse', `${base.startPoint}^{commit}`], {
  cwd,
  encoding: 'utf-8',
  stdio: 'pipe',
}).trim();
const actualHead = execFileSync('git', ['rev-parse', 'HEAD^{commit}'], {
  cwd,
  encoding: 'utf-8',
  stdio: 'pipe',
}).trim();
if (actualHead !== expectedHead) {
  throw new Error(`Branch ${branch} did not start from base ${base.branch}.`);
}
```

Return `base.branch` as the pull-request base.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run src/__tests__/pipelineExecution.test.ts
```

Expected: all pipeline unit tests pass.

- [ ] **Step 6: Commit the direct pipeline invariant**

```bash
git add src/features/pipeline/steps.ts src/__tests__/pipelineExecution.test.ts
git commit -m "fix(pipeline): branch from resolved base commit"
```

### Task 3: Prove branch independence with real Git

**Files:**
- Create: `src/__tests__/it-independent-pipeline-branch.test.ts`
- Modify: `src/features/pipeline/steps.ts` only if the integration test exposes a defect

- [ ] **Step 1: Write the real-repository regression test**

Create a temporary Git repository with `main`, add a remote-tracking
`origin/main`, create `feature/a` with an A-only commit, then invoke
`resolveExecutionContext` for a new named `feature/b` branch. Assert:

```ts
expect(runGit(repo, ['rev-parse', 'feature/b'])).toBe(
  runGit(repo, ['rev-parse', 'origin/main']),
);
expect(runGit(repo, ['merge-base', '--is-ancestor', 'feature/a', 'feature/b'], false).status)
  .not.toBe(0);
```

The helper must configure a local Git identity and clean up the temporary
repository in `afterEach`.

- [ ] **Step 2: Run the integration test and verify its result**

Run:

```bash
npx vitest run src/__tests__/it-independent-pipeline-branch.test.ts
```

Expected before Task 2 implementation: FAIL because `feature/b` equals the current `feature/a` HEAD. Expected after Task 2: PASS.

- [ ] **Step 3: Run the direct and worktree regression family**

Run:

```bash
npx vitest run \
  src/__tests__/it-independent-pipeline-branch.test.ts \
  src/__tests__/pipelineExecution.test.ts \
  src/__tests__/devloopd-run.test.ts \
  src/__tests__/clone.test.ts \
  src/__tests__/clone-base-branch.test.ts
```

Expected: all selected suites pass.

- [ ] **Step 4: Commit the executable regression evidence**

```bash
git add src/__tests__/it-independent-pipeline-branch.test.ts
git commit -m "test: prove independent pipeline branch ancestry"
```

### Task 4: Validate and prepare TaktDesk consumption

**Files:**
- Modify: `docs/superpowers/plans/2026-07-18-independent-pipeline-branches.md` only to mark completed checkboxes
- Read-only validation: `/Volumes/Satechi/Developer/agent-scrum/TaktDesk/script/package_private_runtime.sh`

- [ ] **Step 1: Run static and unit verification**

```bash
npm run build
npm run lint
npm test
git diff --check
```

Expected: TypeScript build, ESLint, and all Vitest unit tests pass with no whitespace errors.

- [ ] **Step 2: Run security checks**

```bash
npm audit --audit-level=high
git diff --check
git grep -nE '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})' -- . ':!package-lock.json'
```

Expected: no high-severity audit finding introduced by this change and no committed credential material.

- [ ] **Step 3: Self-review branch and failure behavior**

Confirm from the final diff that:

- devloopd cannot omit worktree isolation;
- direct branch creation passes Git arguments as an array;
- a setup invariant failure occurs before `runWorkflow`;
- PR repair, copy workspace, and skip-git branches are unchanged;
- no generated `dist/` or temporary test files are committed.

- [ ] **Step 4: Push the implementation branch**

```bash
git push origin feature/staged-loop-stop-request
```

Expected: local and remote HEAD match.

- [ ] **Step 5: Rebuild TaktDesk with the new private runtime**

From `/Volumes/Satechi/Developer/agent-scrum/TaktDesk`:

```bash
TAKTDESK_PRIVATE_TAKT_SOURCE=/Volumes/Satechi/Developer/agent-scrum/takt \
  ./script/build_and_run.sh --verify
```

Expected: `dist/TaktDesk.app/Contents/Resources/runtime/manifest.json` records the final private-takt implementation commit, and bundled `devloopd` reports the updated command behavior.
