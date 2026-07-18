# Independent Pipeline Branches Design

## Problem

`devloopd` starts TAKT with `--pipeline` but without worktree isolation. The
direct pipeline path resolves `base_branch`, then creates a branch with
`git checkout -b <branch>` from the current `HEAD`. When several independent
issues run sequentially, issue B can therefore inherit issue A and issue C can
inherit A+B even though every pull request targets `main`.

This makes reviews misleading, couples merge order, increases conflict risk,
and can cause one issue's pull request to ship unrelated work.

## Goals

- Make every new issue pipeline branch start from its resolved base branch.
- Make `devloopd` issue execution use worktree isolation by default.
- Fail before agent work starts if TAKT cannot prove that a newly created
  direct branch started at the resolved base commit.
- Preserve intentional PR repair behavior, where TAKT checks out an existing
  pull-request head and works against that pull request's recorded base.
- Cover the regression with tests that model execution while the repository is
  currently on another feature branch.

## Non-goals

- Automatically rewrite or force-push existing contaminated pull requests.
- Prohibit intentional stacked pull requests created outside issue pipeline
  automation.
- Change copy-workspace or `--skip-git` behavior.
- Introduce GitHub API calls for enumerating every open pull-request head.

## Considered Approaches

### 1. Add `--isolation worktree` only to `devloopd`

This is the smallest change and prevents the observed automated path from
sharing the current checkout. It does not protect users invoking direct
`--pipeline`, so the underlying branch-creation defect remains.

### 2. Create direct branches from the resolved base only

Passing an explicit start point to `git checkout -b` fixes the core defect for
all pipeline callers. It still leaves `devloopd` operating in the user's main
checkout, where dirty files and parallel executions are undesirable.

### 3. Worktree-by-default automation plus a direct-path invariant

This combines both protections: `devloopd` requests worktree isolation, while
direct pipeline creation explicitly starts from the resolved base commit and
verifies the resulting `HEAD`. This is the recommended approach because it
fixes the root cause and gives automation a separate filesystem boundary.

## Design

### Devloop issue execution

`buildTaktIssueArgs` will always add `--isolation worktree` for issue
automation. Worktree creation already resolves `base_branch` and creates new
branches from that base. If worktree setup is unavailable, the existing
pipeline behavior avoids committing or pushing from the fallback directory.

The argument is deliberately not configurable through `devloopd`: guarded
automation must not silently opt back into shared-checkout branch creation.

### Direct pipeline branch creation

The pipeline will retain both values returned by base resolution:

- the logical base branch name used as the pull-request base;
- the concrete fetched commit when automatic fetching is enabled.

For a new direct branch, TAKT will choose the start point in this order:

1. the fetched base commit returned by base resolution;
2. `origin/<baseBranch>` when that remote-tracking branch exists;
3. the local `<baseBranch>`.

TAKT will run `git checkout -b <branch> <startPoint>`, then resolve `HEAD` and
the start point to commit IDs. A mismatch aborts the pipeline before workflow
execution. This invariant documents and mechanically enforces why an
independent issue branch cannot inherit the previously checked-out feature.

The existing PR-repair path remains unchanged because it intentionally checks
out the PR head rather than creating a new independent branch.

### Boundaries

Start-point selection belongs in the git/task infrastructure rather than the
CLI layer, so synchronous and future callers share one policy. Pipeline
orchestration remains responsible for selecting the base and asking the git
layer to create the branch.

No shell command will be constructed as a string. Git arguments continue to be
passed as arrays to `execFileSync`, avoiding command injection through branch
names.

## Error Handling

- Missing configured base branches continue to fail during base resolution.
- If neither a local nor an `origin/` base ref can be resolved, branch creation
  fails before the agent runs.
- If the created branch `HEAD` does not equal the resolved start commit, the
  branch-origin invariant fails with an actionable error naming the branch and
  base.
- Worktree preparation failures keep the current no-commit/no-push fallback.

## Test Strategy

TDD will add failing tests before production changes:

1. `devloopd-run.test.ts` must expect `--isolation worktree` in every issue
   pipeline invocation, including when optional flags are disabled.
2. Pipeline tests must assert that new direct branches call
   `git checkout -b <branch> <resolved-base-start>`, not the two-argument form.
3. A focused git-level test will model a repository currently checked out on
   feature A and verify feature B starts at `origin/main`, excluding A's commit.
4. Existing worktree, PR repair, copy workspace, and skip-git tests must remain
   green.

Validation will include focused Vitest tests, TypeScript build, ESLint, the full
unit suite, `git diff --check`, and a security-oriented review of git argument
handling and failure behavior.

## Rollout and Compatibility

The change is backward-compatible for independent issue automation. A caller
that relied on the accidental behavior of direct pipeline branches inheriting
the current feature branch must now express that dependency through an
explicit base branch or an existing PR repair workflow.

Existing pull requests are not modified. They require a separate, explicit
cleanup operation after this prevention is merged.
