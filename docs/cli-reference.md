# CLI Reference

[日本語](./cli-reference.ja.md)

This document provides a complete reference for all TAKT CLI commands and options.

## Global Options

| Option | Description |
|--------|-------------|
| `--pipeline` | Enable pipeline (non-interactive) mode -- required for CI/automation |
| `-t, --task <text>` | Task content (alternative to GitHub Issue) |
| `-i, --issue <N>` | GitHub issue number (same as `#N` in interactive mode) |
| `-w, --workflow <name or path>` | Workflow name or path to workflow YAML file |
| `-b, --branch <name>` | Specify branch name (auto-generated if omitted) |
| `--pr <number>` | PR number to fetch review comments and fix |
| `--auto-pr` | Create PR after execution (pipeline mode only) |
| `--draft` | Create PR as draft (requires `--auto-pr` or `auto_pr` config) |
| `--isolation <none|worktree|copy>` | Choose pipeline execution isolation |
| `--copy-workspace` | Run pipeline in a copied workspace (alias for `--isolation copy`) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode, workflow-only) |
| `--repo <owner/repo>` | Specify repository (for PR creation) |
| `-q, --quiet` | Minimal output mode: suppress AI output (for CI) |
| `--provider <name>` | Override agent provider (claude\|claude-sdk\|claude-terminal\|codex\|codex-cli\|opencode\|opencode-cli\|cursor\|cursor-cli\|copilot\|kiro\|agy-cli\|mock) |
| `--model <name>` | Override agent model |
| `--config <path>` | Path to global config file (default: `~/.takt/config.yaml`) |

`--workflow` is the canonical option.

When `--pr` builds a task from review context, the generated order file starts with fix-focused triage: `Current Fix Requirements`, `Needs Current-Code Recheck`, `Triage Notes`, and `Reference Context`. Active review threads and non-bot conversation comments are promoted as current work; outdated unresolved threads and legacy inline comments require latest-code verification; resolved, bot/generated, summary, and archival PR context remain available below as reference only.

## devloopd

`devloopd` is a separate sidecar binary installed with TAKT. Use it to verify subscription/login-session-only readiness before running long workflows.

```bash
devloopd doctor --subscription-only
devloopd doctor --subscription-only --repo /path/to/repo --policy .takt/devloopd.yaml
devloopd doctor --subscription-only --smoke-cli --smoke-timeout-ms 60000
devloopd provider-smoke --cwd /path/to/repo
devloopd provider-smoke --cwd /path/to/repo --workflow subscription-devloop
devloopd provider-smoke --cwd /path/to/repo --provider codex-cli opencode-cli
devloopd provider-smoke --cwd /path/to/repo --provider opencode-cli --prompt-smoke
devloopd onboard-repo --cwd /path/to/repo --repo owner/repo
devloopd onboard-repo --cwd /path/to/repo --repo owner/repo --apply
devloopd ready --cwd /path/to/repo --repo owner/repo
devloopd recover-stale --cwd /path/to/repo
devloopd recover-stale --cwd /path/to/repo --apply
devloopd status --cwd /path/to/repo
devloopd stop --cwd /path/to/repo --reason "maintenance window"
devloopd reset --cwd /path/to/repo
npm run check:personal
devloopd check-personal --cwd /path/to/repo
devloopd check-personal --cwd /path/to/repo --require-provider-smoke
devloopd release-info
devloopd release-info --json
devloopd product-policy collect-replay-cases --cwd /path/to/repo
devloopd product-policy replay --cwd /path/to/repo
devloopd product-policy replay --cwd /path/to/repo --json
devloopd schedule-template --kind launchd --cwd /path/to/repo --repo owner/repo
devloopd schedule-template --kind cron --cwd /path/to/repo --repo owner/repo --template-only
devloopd soak --cwd /path/to/repo --cycles 5
npm run test:devloopd:soak
devloopd run --issue 123 --repo owner/repo
devloopd import-takt-run --latest --issue 123
devloopd reconcile-runs
devloopd export-ledger --output .devloop/backup/ledger.jsonl
devloopd timeline --issue 123
devloopd automation-state --cwd /path/to/repo
devloopd memory --write
devloopd merge-if-safe --pr 456 --expected-head <sha>
devloopd staged once --repo owner/repo
devloopd staged loop --repo owner/repo --max-cycles 3
devloopd stage pr-merge --repo owner/repo
devloopd scan-issues --repo owner/repo
devloopd select-issue --repo owner/repo
devloopd active-runs
devloopd start --repo owner/repo
```

`devloopd doctor` options:

| Option | Description |
|--------|-------------|
| `--subscription-only` | Require subscription-only TAKT config and provider checks |
| `--repo <path>` | Repository path to inspect |
| `--policy <path>` | Optional devloop policy YAML path; defaults to `.takt/devloopd.yaml` when present and `mode` must be `subscription_only` |
| `--verbose` | Show passing checks |
| `--skip-auth` | Skip `gh auth status` |
| `--smoke-cli` | Run bounded real CLI smoke checks for subscription-only providers |
| `--smoke-timeout-ms <ms>` | Per-provider CLI smoke timeout. Defaults to 60000 |

`devloopd provider-smoke` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect |
| `--workflow <name-or-path>` | Selected workflow used to resolve provider config before project/global config |
| `--provider <name...>` | Provider(s) to smoke-check instead of auto-detecting the configured provider |
| `--prompt-smoke` | Run a minimal non-mutating prompt. Disabled by default to avoid paid or network work |
| `--timeout-ms <ms>` | Per-probe timeout in milliseconds. Defaults to 15000 |

The provider smoke matrix always prints `pass`, `fail`, or `skip` for every provider. Configured CLI providers fail on missing commands, incompatible version/help commands, or failed auth status probes. Unconfigured providers are skipped with an explicit reason. Live prompt smoke is opt-in; adding repository content, private PR/comment fixtures, or live mutation to this gate requires human review.

`devloopd onboard-repo` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to prepare |
| `--repo <owner/repo>` | GitHub repository used to verify or create automation labels |
| `--apply` | Apply file and label changes. Without this, only print a dry-run report |
| `--force` | Allow onboarding outside a detected Git repository and overwrite template files |

`devloopd onboard-repo` preserves existing `.takt` files unless `--force` is provided. It creates the personal subscription-only config, devloop policy, default workflow wrapper, ignore rules, and required automation labels (`agent:ready`, `agent:auto-merge`, `agent:blocked`, `human:review`) only in `--apply` mode.

`devloopd ready` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect |
| `--repo <owner/repo>` | GitHub repository used to verify required automation labels |
| `--workflow <path>` | TAKT workflow path required before starting. Defaults to `.takt/workflows/subscription-devloop.yaml` |
| `--skip-auth` | Skip `gh auth status` |

`devloopd status` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |
| `--stale-after-minutes <count>` | Minutes without metadata update before active-runs marks a run stale. Defaults to 180 |

`devloopd recover-stale` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |
| `--apply` | Apply conservative cleanup. Without this, only print a dry-run report |
| `--stale-after-minutes <count>` | Minutes without metadata update before active runs are stale. Defaults to 180 |
| `--lock-stale-minutes <count>` | Minutes before lock files are stale. Defaults to 10 |
| `--worktree-stale-minutes <count>` | Minutes before non-git worktree directories are stale. Defaults to 1440 |

`devloopd recover-stale --apply` marks stale running metadata as aborted, removes stale lock files, clears dead daemon metadata, and prunes stale non-git worktree directories. It preserves ledgers, reports, logs, and Git worktrees.

`devloopd stop` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect |
| `--reason <text>` | Operator-visible reason stored with the stop request |

`devloopd stop` writes a stop-request file that foreground `devloopd start` and `devloopd staged loop` processes read before the next cycle. `devloopd reset` clears only personal daemon metadata and stop-request state; it does not delete TAKT run artifacts or the devloop ledger.

`devloopd reset` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect |

`devloopd check-personal` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect |
| `--summary <path>` | Machine-readable JSON summary path. Defaults to `.devloop/check-personal-summary.json` |
| `--workflow <name-or-path>` | Selected workflow used by provider smoke |
| `--skip-build` | Skip build because an outer wrapper already ran it |
| `--skip-mock-e2e` | Skip mock E2E. This keeps the required gate red unless the caller accepts failure |
| `--skip-provider-smoke` | Do not run the optional provider smoke matrix |
| `--require-provider-smoke` | Make provider smoke failures block the personal gate |
| `--json` | Print the machine-readable summary JSON to stdout |

Use `npm run check:personal` for daily local automation readiness. It runs build, lint, focused devloopd soak, full unit tests, mock E2E, high-severity audit, whitespace checks, and the provider smoke matrix. `check:personal` is stricter than a quick edit loop but does not require every live external provider E2E credential by default. Use `check:release` when preparing a broader release gate that includes all provider E2E checks. The personal gate writes a JSON summary under `.devloop/` for auditability.

`devloopd release-info` / `takt release-info` options:

| Option | Description |
|--------|-------------|
| `--json` | Print package version, commit SHA, metadata source, package root, dirty state, runtime, and artifact boundary as JSON |

Use `npm run release:personal:check` before installing or tagging a personal release. It runs `check:personal`, `npm pack --dry-run`, and `devloopd release-info --json` without publishing to npm. See [Personal Release Workflow](./personal-release.md) for update, rollback, and release notes guidance.

`devloopd product-policy collect-replay-cases` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` under `--cwd` |
| `--output <path>` | Candidate JSON output path. Defaults to `.devloop/product-policy-replay-candidates.json` |
| `--limit <count>` | Maximum recent candidate cases to collect |
| `--json` | Print the candidate file JSON |

Candidate files are intentionally written under `.devloop/` by default. They keep `expectedImpact: null` so they cannot become active CI fixtures until a human reviews the sanitized case and sets an explicit label.

`devloopd product-policy replay` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect |
| `--fixtures <path>` | Active replay fixture directory. Defaults to `fixtures/product-policy/replay` |
| `--max-false-positives <count>` | Allowed false positives. Defaults to `0` |
| `--max-false-negatives <count>` | Allowed false negatives. Defaults to `0` |
| `--json` | Print the machine-readable replay report |

`npm run check:personal` runs the replay gate and fails on fixture validation errors or classifier false negatives. Add a replay case after a manual override, incident, unexpected `human:review`, unexpected auto-mergeable decision, or classifier threshold change. Do not store raw private diffs, credentials, customer data, local filesystem paths, or proprietary issue bodies in fixtures.

`devloopd schedule-template` options:

| Option | Description |
|--------|-------------|
| `--kind <kind>` | Template kind: `launchd`, `cron`, or `all`. Defaults to `all` |
| `--cwd <path>` | Repository path to schedule |
| `--repo <owner/repo>` | GitHub repository passed to staged automation |
| `--workflow <name-or-path>` | TAKT workflow name or path. Defaults to `.takt/workflows/subscription-devloop.yaml` |
| `--log-dir <path>` | Log directory. Defaults to `.devloop/logs` under `--cwd` |
| `--label <label>` | launchd label / cron marker. Defaults to `com.takt.devloopd.<repo>` |
| `--interval-seconds <count>` | launchd `StartInterval` seconds. Defaults to `3600` |
| `--cron-schedule <expr>` | Cron schedule expression. Defaults to `17 * * * *` |
| `--safety-profile <profile>` | Safety profile: `smoke`, `safe-default`, or `daemon`. Defaults to `safe-default` |
| `--max-cycles <count>` | Maximum staged loop cycles per scheduled run. Defaults to `1` |
| `--gh-timeout-ms <count>` | Bounded GitHub metadata timeout. Defaults to `60000` |
| `--path-env <value>` | Explicit `PATH` used by launchd/cron |
| `--shell <path>` | Shell path used by scheduler templates. Defaults to `/bin/zsh` |
| `--devloopd-command <path>` | `devloopd` command or absolute binary path |
| `--npm-command <path>` | `npm` command or absolute binary path |
| `--template-only` | Print only the selected template content. Requires `--kind launchd` or `--kind cron` |

The rendered command runs `npm run check:personal`, then `devloopd recover-stale --apply`, then `devloopd staged loop --max-cycles 1 --safety-profile safe-default`. This keeps scheduled automation bounded by default while still writing predictable logs under `.devloop/logs`. The formatted output includes install, status, uninstall, and dry-run commands. Keep generated plist/cron snippets under `.devloop/schedules` so they stay repo-local and ignored by Git.

`devloopd soak` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to exercise. No live GitHub or provider calls are made |
| `--cycles <count>` | Deterministic scheduler cycles to run. Defaults to 5 |
| `--state <path>` | Structured staged scheduler state file |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` under `--cwd` |
| `--report <path>` | JSON soak report path. Defaults next to the generated state file |
| `--repeated-wait-limit <count>` | Consecutive identical wait/error reasons allowed before failing. Defaults to 3 |

Use `npm run test:devloopd:soak` for the short local regression gate. It runs the deterministic harness plus focused scheduler, CI retry, and merge queue tests. Increase `--cycles` only for local extended soak. Adding live GitHub mutation or real private PR/comment fixtures to soak tests requires human review because it changes the safety and data-handling boundary.

`devloopd run` options:

| Option | Description |
|--------|-------------|
| `--issue <number>` | GitHub Issue number to run through TAKT |
| `--repo <owner/repo>` | Repository used by TAKT for PR operations |
| `--workflow <path>` | TAKT workflow name or path. Defaults to `.takt/workflows/subscription-devloop.yaml` |
| `--policy <path>` | Optional devloop policy YAML path passed to the subscription-only doctor. Defaults to `.takt/devloopd.yaml` when present |
| `--cwd <path>` | Repository path to run in. Defaults to the current working directory |
| `--skip-auth` | Skip `gh auth status` |
| `--no-auto-pr` | Do not pass `--auto-pr` to TAKT |
| `--no-quiet` | Do not pass `--quiet` to TAKT |

`devloopd import-takt-run` options:

| Option | Description |
|--------|-------------|
| `--latest` | Import the latest TAKT run from `.takt/runs/` |
| `--run <slug>` | Import a specific TAKT run slug |
| `--issue <number>` | Associate the imported run with a GitHub Issue number |
| `--cwd <path>` | Repository path to inspect |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |

`devloopd reconcile-runs` options:

| Option | Description |
|--------|-------------|
| `--issue <number>` | Associate imported runs with a GitHub Issue number |
| `--cwd <path>` | Repository path to inspect |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |

`devloopd export-ledger` options:

| Option | Description |
|--------|-------------|
| `--output <path>` | Output JSONL path. Relative paths must stay inside the repository |
| `--force` | Overwrite an existing output file |
| `--issue <number>` | Filter exported runs by GitHub Issue number |
| `--run <slug>` | Filter exported runs by TAKT run slug |
| `--cwd <path>` | Repository path to inspect |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |

`devloopd timeline` options:

| Option | Description |
|--------|-------------|
| `--issue <number>` | Filter imported runs by GitHub Issue number |
| `--run <slug>` | Filter imported runs by TAKT run slug |
| `--cwd <path>` | Repository path to inspect |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |

`devloopd memory` options:

| Option | Description |
|--------|-------------|
| `--issue <number>` | Filter imported runs by GitHub Issue number |
| `--limit <count>` | Maximum imported runs to include. Defaults to 20 |
| `--cwd <path>` | Repository path to inspect |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |
| `--output <path>` | Project-local memory output path. Defaults to `.devloop/memory.md` |
| `--write` | Write the memory file instead of rendering only |

`devloopd merge-if-safe` options:

| Option | Description |
|--------|-------------|
| `--pr <number-or-url>` | Pull request number or URL |
| `--repo <owner/repo>` | GitHub repository |
| `--expected-head <sha>` | Expected PR head SHA. The gate denies merge if the current PR head differs |
| `--cwd <path>` | Repository path to run `gh` from |

`devloopd scan-issues` options:

| Option | Description |
|--------|-------------|
| `--repo <owner/repo>` | GitHub repository |
| `--cwd <path>` | Repository path to run `gh issue list` from |

`devloopd select-issue` options:

| Option | Description |
|--------|-------------|
| `--repo <owner/repo>` | GitHub repository |
| `--cwd <path>` | Repository path to run `gh issue list` from |
| `--max-selections <count>` | Maximum issue candidates to select. Defaults to 1 |
| `--no-auto-pr-only` | Do not select medium-risk `auto_pr_only` candidates |

`devloopd active-runs` options:

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect |
| `--stale-after-minutes <count>` | Minutes without metadata update before a run is stale. Defaults to 180 |

`devloopd start` options:

| Option | Description |
|--------|-------------|
| `--repo <owner/repo>` | GitHub repository |
| `--once` | Run one finite scan/run/import cycle and exit |
| `--max-cycles <count>` | Stop after a finite number of daemon cycles |
| `--interval-seconds <count>` | Seconds to wait between daemon cycles. Defaults to 60 |
| `--workflow <path>` | TAKT workflow name or path. Defaults to `.takt/workflows/subscription-devloop.yaml` |
| `--policy <path>` | Optional devloop policy YAML path passed to the subscription-only doctor. Defaults to `.takt/devloopd.yaml` when present |
| `--cwd <path>` | Repository path to run in. Defaults to the current working directory |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |
| `--max-active-runs <count>` | Maximum active TAKT runs allowed before start refuses to scan. Defaults to 1 |
| `--stale-after-minutes <count>` | Minutes without metadata update before active-runs marks a run stale. Defaults to 180 |
| `--skip-auth` | Skip `gh auth status` |
| `--no-auto-pr` | Do not pass `--auto-pr` to TAKT |
| `--no-quiet` | Do not pass `--quiet` to TAKT |

See the [devloopd Guide](./devloopd.md) for the full check list.

## Interactive Mode

A mode where you refine task content through conversation with AI before execution. Useful when task requirements are ambiguous or when you want to clarify content while consulting with AI.

```bash
# Start interactive mode (no arguments)
takt

# Specify initial message (short word only)
takt hello
```

**Note:** `--task` option skips interactive mode and executes the task directly. Issue references (`#6`, `--issue`) are used as initial input in interactive mode.

### Flow

1. Select workflow
2. Select interactive mode (assistant / persona / quiet / passthrough)
3. Refine task content through conversation with AI
4. Finalize task instructions with `/go` (you can also add additional instructions like `/go additional instructions`), or use `/play <task>` to execute a task immediately
5. Execute (run workflow, create PR)

### Interactive Mode Variants

| Mode | Description |
|------|-------------|
| `assistant` | Default. AI asks clarifying questions before generating task instructions. |
| `persona` | Conversation with the first step's persona (uses its system prompt and tools). |
| `quiet` | Generates task instructions without asking questions (best-effort). |
| `passthrough` | Passes user input directly as task text without AI processing. |

Workflows can set a default mode via the `interactive_mode` field in YAML.

### Execution Example

```
$ takt

Select workflow:
  > default (current)
    Development/
    Research/
    Cancel

Interactive mode - Enter task content. Commands: /go (execute), /cancel (exit)

> I want to add user authentication feature

[AI confirms and organizes requirements]

> /go

Proposed task instructions:
---
Implement user authentication feature.

Requirements:
- Login with email address and password
- JWT token-based authentication
- Password hashing (bcrypt)
- Login/logout API endpoints
---

Proceed with these task instructions? (Y/n) y

[Workflow execution starts...]
```

## Direct Task Execution

Use the `--task` option to skip interactive mode and execute directly.

```bash
# Specify task content with --task option
takt --task "Fix bug"

# Specify workflow
takt --task "Add authentication" --workflow dual
```

**Note:** Passing a string as an argument (e.g., `takt "Add login feature"`) enters interactive mode with it as the initial message.

## GitHub Issue Tasks

You can execute GitHub Issues directly as tasks. Issue title, body, labels, and comments are automatically incorporated as task content.

```bash
# Execute by specifying issue number
takt #6
takt --issue 6

# Issue + workflow specification
takt #6 --workflow dual
```

**Requirements:** [GitHub CLI](https://cli.github.com/) (`gh`) must be installed and authenticated.

## Task Management Commands

Batch processing using `.takt/tasks.yaml` with task directories under `.takt/tasks/{slug}/`. Useful for accumulating multiple tasks and executing them together later.

### takt add

Refine task requirements through AI conversation, then add a task to `.takt/tasks.yaml`.

```bash
# Refine task requirements through AI conversation, then add task
takt add

# Add task from GitHub Issue (issue number reflected in branch name)
takt add #28
```

### takt run

Execute all pending tasks from `.takt/tasks.yaml`.

```bash
# Execute all pending tasks in .takt/tasks.yaml
takt run

# Ignore workflow max_steps and continue until another stop condition occurs
takt run --ignore-exceed
```

Without `--ignore-exceed`, a task that reaches workflow `max_steps` stops with `exceeded` status and persists retry metadata in `.takt/tasks.yaml`. With `--ignore-exceed`, `takt run` ignores only that iteration limit, continues execution, and does not write exceeded retry metadata.

### takt watch

Monitor `.takt/tasks.yaml` and auto-execute tasks as a resident process.

```bash
# Monitor .takt/tasks.yaml and auto-execute tasks (resident process)
takt watch

# Ignore workflow max_steps and continue running tasks instead of marking them exceeded
takt watch --ignore-exceed
```

`takt watch --ignore-exceed` has the same semantics as `takt run --ignore-exceed`: it ignores the workflow `max_steps` iteration limit and does not write `exceeded` retry metadata to `.takt/tasks.yaml`.

### takt list

List task branches and perform actions (merge, delete, merge from root, etc.).

```bash
# List task branches (merge/delete)
takt list

# Non-interactive mode (for CI/scripts)
takt list --non-interactive
takt list --non-interactive --action diff --branch takt/my-branch
takt list --non-interactive --action delete --branch takt/my-branch --yes
takt list --non-interactive --format json
```

In interactive mode, **Merge from root** merges the root repository HEAD into the worktree branch with AI-assisted conflict resolution.

### Task Directory Workflow (Create / Run / Verify)

1. Run `takt add` and confirm a pending record is created in `.takt/tasks.yaml`.
2. Open the generated `.takt/tasks/{slug}/order.md` and add detailed specifications/references as needed.
3. Run `takt run` (or `takt watch`) to execute pending tasks from `tasks.yaml`.
4. Verify outputs in `.takt/runs/{slug}/reports/` using the same slug as `task_dir`.

## Pipeline Mode

Specifying `--pipeline` enables non-interactive pipeline mode. Automatically creates branch, runs the workflow, commits and pushes. Suitable for CI/CD automation.

```bash
# Execute task in pipeline mode
takt --pipeline --task "Fix bug"

# Pipeline execution + auto-create PR
takt --pipeline --task "Fix bug" --auto-pr

# Link issue information
takt --pipeline --issue 99 --auto-pr

# Specify workflow and branch
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug

# Specify repository (for PR creation)
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo

# Workflow execution only (skip branch creation, commit, push)
takt --pipeline --task "Fix bug" --skip-git

# Run in a copied workspace without requiring Git
takt --pipeline --task "Fix bug" --copy-workspace

# Minimal output mode (for CI)
takt --pipeline --task "Fix bug" --quiet
```

In pipeline mode, PRs are not created unless `--auto-pr` is specified.

**GitHub Integration:** When using TAKT in GitHub Actions, see [takt-action](https://github.com/nrslib/takt-action). You can automate PR reviews and task execution.

## Utility Commands

### Interactive workflow selection

Run `takt` without a task argument to choose a workflow interactively.

```bash
takt
```

### takt eject

Copy builtin workflows/personas to your local directory for customization.

```bash
# Copy builtin workflows/personas to project .takt/ for customization
takt eject

# Copy to ~/.takt/ (global) instead
takt eject --global

# Eject a specific facet for customization
takt eject persona coder
takt eject instruction plan --global
```

Builtin and custom workflow lookup uses `workflows/`.

### takt workflow

Initialize and validate custom workflow definitions.

```bash
# Create a minimal workflow scaffold in project .takt/workflows/
takt workflow init sample-flow

# Create a faceted scaffold in ~/.takt/workflows/
takt workflow init review-flow --template faceted --global

# Validate workflows by name or path
takt workflow doctor sample-flow
takt workflow doctor .takt/workflows/sample-flow.yaml
```

### takt resume

Resume the latest failed or aborted direct (one-shot) run. Finds the most recent direct run that did not complete and continues it from where it stopped, reusing the existing run directory instead of starting over.

```bash
takt resume
```

### takt clear

Clear agent conversation sessions (reset state).

```bash
takt clear
```

### takt export-cc

Deploy builtin workflows/personas as a Claude Code Skill.

```bash
takt export-cc
```

### takt export-codex

Deploy TAKT skill files as a Codex Skill (`~/.agents/skills/takt/`).
This command deploys `SKILL.md`, `references/`, `agents/`, `workflows/`, and `facets/`.

```bash
takt export-codex
```

### takt catalog

List available facets across layers.

```bash
takt catalog
takt catalog personas
```

### takt prompt

Preview assembled prompts for each step and phase.

```bash
takt prompt [workflow]
```

### takt reset

Reset settings to defaults.

```bash
# Reset global config to builtin template (with backup)
takt reset config

# Reset workflow categories to builtin defaults
takt reset categories
```

### takt metrics

Show analytics metrics.

```bash
# Show review quality metrics (default: last 30 days)
takt metrics review

# Specify time window
takt metrics review --since 7d
```

### takt repertoire

Manage repertoire packages (external TAKT packages from GitHub).

```bash
# Install a package from GitHub
takt repertoire add github:{owner}/{repo}@{ref}

# Install from default branch
takt repertoire add github:{owner}/{repo}

# List installed packages
takt repertoire list

# Remove a package
takt repertoire remove @{owner}/{repo}
```

Installed packages are stored in `~/.takt/repertoire/` and their workflows/facets become available in workflow selection and facet resolution.

When the same workflow name exists in multiple locations, TAKT resolves in this order: `.takt/workflows/` → `~/.takt/workflows/` → builtins.

### takt purge

Purge old analytics event files.

```bash
# Purge files older than 30 days (default)
takt purge

# Specify retention period
takt purge --retention-days 14
```
