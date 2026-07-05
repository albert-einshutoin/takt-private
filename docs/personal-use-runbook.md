# Personal Use Quickstart and Operations Runbook

This guide is for one developer running TAKT automation on a local workstation.
The default path favors bounded automation, explicit recovery, and human review
for product-policy decisions.

## Prerequisites

- Node.js and npm compatible with `package.json` (`node >=20.6.0`).
- `git` and GitHub CLI (`gh`) on `PATH`.
- `gh auth status` passes for the target repository.
- The target repository allows branch creation, issue/PR reads, PR comments, and labels.
- Optional provider CLIs are installed and authenticated if you want live provider smoke checks.
- Target repositories ignore local automation state:
  - `.devloop/`
  - `.takt/runs/`

Do not commit provider credentials, `.devloop/` ledgers, scheduler snippets, raw logs, or local run directories.

## Install or Update TAKT

From a private checkout:

```bash
git fetch origin main --tags
git switch main
git pull --ff-only origin main
npm ci
npm run release:personal:check
npm link
devloopd release-info
```

`release:personal:check` runs `check:personal`, `npm pack --dry-run`, and release provenance. It does not publish to npm.

## Onboard a Target Repository

Run a dry-run first:

```bash
cd /path/to/target-repo
devloopd onboard-repo --cwd . --repo owner/repo
```

Apply only after the dry-run looks correct:

```bash
devloopd onboard-repo --cwd . --repo owner/repo --apply
```

Onboarding creates subscription-only TAKT config, devloop policy, default workflow wrapper, ignore rules, and required `agent:*` labels. It preserves existing `.takt` files unless `--force` is explicitly used.

## Readiness

Before running automation:

```bash
devloopd ready --cwd . --repo owner/repo
devloopd provider-smoke --cwd .
npm run check:personal
```

`check:personal` runs build, lint, focused devloopd soak, full unit tests, mock E2E, product-policy replay, high-severity audit, whitespace checks, and optional provider smoke. Optional provider failures are visible but do not require every paid/live provider credential by default.

## Safe Default Automation

For a bounded manual run:

```bash
devloopd staged loop --cwd . --repo owner/repo --safety-profile safe-default --max-cycles 1
devloopd status --cwd .
```

For a short foreground supervisor smoke:

```bash
devloopd start --cwd . --repo owner/repo --max-cycles 1
devloopd status --cwd .
```

For a scheduler, generate templates instead of hand-writing launchd/cron entries:

```bash
devloopd schedule-template --kind launchd --cwd . --repo owner/repo
devloopd schedule-template --kind cron --cwd . --repo owner/repo
```

The scheduler templates run `check:personal`, then stale-state recovery, then a bounded `staged loop --max-cycles 1 --safety-profile safe-default`.

## Inspect, Stop, and Reset

Use status first:

```bash
devloopd status --cwd .
devloopd automation-state --cwd .
devloopd timeline --issue 123
```

Stop a foreground personal loop before the next cycle:

```bash
devloopd stop --cwd . --reason "maintenance window"
devloopd status --cwd .
```

Reset only daemon lifecycle metadata and stop-request state:

```bash
devloopd reset --cwd .
```

`reset` does not delete TAKT run artifacts, `.devloop/ledger.jsonl`, reports, or logs.

## Recovery

Always dry-run first:

```bash
devloopd recover-stale --cwd .
devloopd recover-stale --cwd . --apply
devloopd status --cwd .
```

What recovery may change:

- mark stale active run metadata as aborted
- remove stale lock files
- clear dead daemon metadata
- prune abandoned non-git worktree directories

What recovery preserves:

- `.devloop/ledger.jsonl`
- `.takt/runs/`
- reports, logs, and Git worktrees
- provider credentials and local auth stores

## Human Review Boundaries

Automation must stop for human review when a change touches:

- product direction, roadmap, pricing, plans, or entitlement behavior
- public API or CLI compatibility contracts
- authentication, authorization, billing, retention, privacy, compliance, or security posture
- migrations or irreversible operational behavior
- package/license/dependency risk that the automated policy cannot classify confidently
- the auto-merge, human-review, lane taxonomy, classifier categories, or threshold policy itself

Routine feature improvements, performance work, dependency patches, security hardening, language-idiomatic refactors, tests, docs, and local tooling can stay automated when they preserve accepted product behavior and pass the gates.

## Troubleshooting Decision Tree

1. Is a loop still running?
   - Run `devloopd status --cwd .`.
   - If the process is live, use `devloopd stop --cwd . --reason "<why>"`.
   - If metadata is stale, run `devloopd recover-stale --cwd .` before `--apply`.

2. Is it waiting repeatedly?
   - Run `devloopd automation-state --cwd .`.
   - Check retry/backoff reasons and `retryAfter` windows.
   - If the same reason repeats after the window, run `npm run test:devloopd:soak` and inspect the relevant stage.

3. Did provider smoke fail?
   - Run `devloopd provider-smoke --cwd .`.
   - Fix missing CLI/auth, or keep the provider gate optional for local readiness.
   - Do not paste provider tokens into issue bodies, fixtures, or logs.

4. Did GitHub auth expire?
   - Run `gh auth status`.
   - Re-authenticate with `gh auth login`.
   - Re-run `devloopd ready --cwd . --repo owner/repo`.

5. Did CI repair stop?
   - Check the PR, ledger, and CI logs.
   - Auth/permission failures are human/operator actions.
   - Flaky, infrastructure, and timeout classifications may retry with bounded backoff.

6. Was a PR evicted from the merge queue?
   - Inspect conflict files and merge-tree output in the automation state.
   - Non-product implementation conflicts can be repaired by a follow-up worktree.
   - Product-policy, public contract, or security posture conflicts require human review.

7. Is product-policy replay failing?
   - Run `devloopd product-policy replay --cwd . --json`.
   - False negatives block release/readiness.
   - Relabeling fixtures or lowering thresholds requires human review.

## Update and Rollback

Use the release runbook for versioned update and rollback:

```bash
devloopd release-info
npm run release:personal:check
```

See [Personal Release Workflow](./personal-release.md). Rollback changes installed code, not local state. Preserve `.devloop/`, `.takt/runs/`, provider auth stores, and ledgers.
