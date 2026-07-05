# devloopd

[日本語](./devloopd.ja.md)

`devloopd` is a sidecar CLI packaged with TAKT. It provides local readiness checks and finite supervisor utilities for teams that run TAKT only through subscription/login-session CLI providers.

## Doctor

Run the doctor before long workflow runs or CI-like local automation:

```bash
devloopd doctor --subscription-only
```

The command exits with status `0` when every required check passes. It exits with status `1` when a required subscription-only guard fails.

### Checks

`devloopd doctor --subscription-only` verifies:

- `--subscription-only` was explicitly requested
- optional devloop policy YAML has `mode: subscription_only`
- API-key billing environment variables such as `OPENAI_API_KEY` or `TAKT_OPENAI_API_KEY` are absent
- required CLIs are on `PATH`: `takt`, `gh`, `codex`, `opencode`, and `agy`
- Cursor CLI is available as `cursor-agent` or `agent`
- `gh auth status` succeeds, unless `--skip-auth` is passed
- resolved TAKT config has `subscription_only: true`
- global and project TAKT config files do not contain API key config keys
- project workflows under `.takt/workflows/` pass TAKT workflow doctor validation, including subscription-only provider checks
- OpenCode credential store is readable with `opencode auth list` when `opencode` is explicitly allowlisted
- the latest readable OpenCode log does not show known local SQLite storage errors when `opencode` is explicitly allowlisted

The doctor reports forbidden environment variables and config keys by name only. It does not print secret values.

When `devloopd` is run from a source checkout before `npm link` or global installation,
the `takt` command check accepts the adjacent `bin/takt` wrapper under the inspected
repository. Other provider CLIs must still be installed and discoverable on `PATH`.

By default, `doctor` only verifies local configuration, command discovery, and authentication
state. Add `--smoke-cli` when you want bounded real CLI generation checks for `codex-cli`,
`cursor-cli`, `opencode-cli`, and `agy-cli`:

```bash
devloopd doctor --subscription-only --smoke-cli --smoke-timeout-ms 60000
```

Smoke checks run only after prerequisite doctor checks pass. They use the subscription-only
environment sanitizer and fail instead of hanging when a CLI exceeds the timeout.

### Troubleshooting Smoke Failures

`smoke:opencode-cli` may fail with an OpenCode `UnknownError` such as
`Unexpected server error` even when TAKT configuration, command discovery, and
subscription-only guards are correct. In that case, first run OpenCode directly:

```bash
opencode run "Reply with exactly: Done"
```

If the direct command fails the same way, check the OpenCode account and service
state. If `devloopd doctor` reports `OpenCode storage`, the OpenCode credential
store is readable but the latest readable log indicates a local SQLite storage problem such as
`session_message.seq`; back up or repair the local OpenCode database before
expecting CLI or SDK smoke runs to pass. To rule out global OpenCode MCP
configuration, temporarily disable a suspect MCP server with an inline OpenCode
config override:

```bash
OPENCODE_CONFIG_CONTENT='{"mcp":{"pencil":{"enabled":false}}}' \
  opencode run "Reply with exactly: Done"
```

TAKT keeps subscription-only mode strict during smoke checks. It does not fall
back to SDK/API providers or API-key credentials when a login-session CLI fails.

### Options

| Option | Description |
|--------|-------------|
| `--subscription-only` | Require TAKT subscription-only policy checks |
| `--repo <path>` | Repository path to inspect. Defaults to the current working directory |
| `--policy <path>` | Optional devloop policy YAML path. Defaults to `.takt/devloopd.yaml` when that file exists |
| `--verbose` | Show passing checks as well as warnings and failures |
| `--skip-auth` | Skip `gh auth status` |
| `--smoke-cli` | Run bounded real CLI smoke checks for subscription-only providers |
| `--smoke-timeout-ms <ms>` | Per-provider CLI smoke timeout. Defaults to 60000 |

### Optional Policy File

Projects can keep devloop policy beside TAKT config at `.takt/devloopd.yaml`:

```yaml
mode: subscription_only
```

The doctor discovers that file automatically. Use `--policy` only when the policy lives elsewhere:

```bash
devloopd doctor --subscription-only --policy .takt/devloopd.yaml
```

If no policy file is provided and `.takt/devloopd.yaml` does not exist, the doctor emits a warning and continues. TAKT config and workflow checks still run.

## Run

Use `devloopd run` to start a TAKT issue pipeline only after the subscription-only doctor passes:

```bash
devloopd run --issue 123 --repo owner/repo
```

The command runs the same checks as `devloopd doctor --subscription-only`. If any required guard fails, TAKT is not started.

When checks pass, `devloopd run` invokes TAKT with argv equivalent to:

```bash
takt --pipeline \
  --issue 123 \
  --workflow .takt/workflows/subscription-devloop.yaml \
  --auto-pr \
  --quiet \
  --repo owner/repo
```

### Run Options

| Option | Description |
|--------|-------------|
| `--issue <number>` | GitHub Issue number to run through TAKT |
| `--repo <owner/repo>` | Repository used by TAKT for PR operations |
| `--workflow <path>` | TAKT workflow name or path. Defaults to `.takt/workflows/subscription-devloop.yaml` |
| `--policy <path>` | Optional devloop policy YAML path passed to the doctor |
| `--cwd <path>` | Repository path to run in. Defaults to the current working directory |
| `--skip-auth` | Skip `gh auth status` |
| `--no-auto-pr` | Do not pass `--auto-pr` to TAKT |
| `--no-quiet` | Do not pass `--quiet` to TAKT |

## Import And Timeline

TAKT remains the workflow engine and writes run metadata under `.takt/runs/`. `devloopd import-takt-run` imports that metadata into `.devloop/ledger.jsonl`, including artifact paths, byte sizes, and SHA-256 hashes for log and report files.

```bash
devloopd import-takt-run --latest --issue 123
devloopd reconcile-runs
devloopd export-ledger --output .devloop/backup/ledger.jsonl
devloopd timeline --issue 123
devloopd memory --write
```

The JSONL ledger is the portable MVP event log. It is ignored by Git via `.devloop/` and can be copied into a future SQLite backend without changing TAKT run outputs.

`devloopd reconcile-runs` scans `.takt/runs/` and imports missing non-running runs into the ledger. It skips already imported runs and running runs, so it is safe to use after a daemon crash, interrupted import, or backup restore.

`devloopd export-ledger` writes filtered ledger events to a JSONL backup file. Relative output paths must stay inside the repository, and existing files are protected unless `--force` is passed.

`devloopd memory` renders a compact project memory snapshot from imported run metadata. It does not read raw log content. Report artifact paths are included for follow-up inspection, while log artifacts are omitted from the memory text.

### Import Options

| Option | Description |
|--------|-------------|
| `--latest` | Import the latest TAKT run from `.takt/runs/` |
| `--run <slug>` | Import a specific TAKT run slug |
| `--issue <number>` | Associate the imported run with a GitHub Issue number |
| `--cwd <path>` | Repository path to inspect. Defaults to the current working directory |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |

### Timeline Options

| Option | Description |
|--------|-------------|
| `--issue <number>` | Filter imported runs by GitHub Issue number |
| `--run <slug>` | Filter imported runs by TAKT run slug |
| `--cwd <path>` | Repository path to inspect. Defaults to the current working directory |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |

### Reconcile Options

| Option | Description |
|--------|-------------|
| `--issue <number>` | Associate imported runs with a GitHub Issue number |
| `--cwd <path>` | Repository path to inspect. Defaults to the current working directory |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |

### Export Options

| Option | Description |
|--------|-------------|
| `--output <path>` | Output JSONL path. Relative paths must stay inside the repository |
| `--force` | Overwrite an existing output file |
| `--issue <number>` | Filter exported runs by GitHub Issue number |
| `--run <slug>` | Filter exported runs by TAKT run slug |
| `--cwd <path>` | Repository path to inspect. Defaults to the current working directory |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |

### Memory Options

| Option | Description |
|--------|-------------|
| `--issue <number>` | Filter imported runs by GitHub Issue number |
| `--limit <count>` | Maximum imported runs to include. Defaults to 20 |
| `--cwd <path>` | Repository path to inspect. Defaults to the current working directory |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |
| `--output <path>` | Project-local memory output path. Defaults to `.devloop/memory.md` |
| `--write` | Write the memory file instead of rendering only |

## Staged Automation

`devloopd staged` owns the portable devloop scheduler that used to live in shell.
It runs independent stages, persists last-run timestamps as JSON, and can be
used by thin `.takt/automation/*.sh` compatibility wrappers.

```bash
devloopd staged once --repo owner/repo
devloopd staged loop --repo owner/repo --max-cycles 3
devloopd staged pr-review --repo owner/repo
devloopd stage pr-merge --repo owner/repo
```

Stages run in this order:

- `issue-scout`
- `issue-to-pr`
- `pr-review`
- `review-fix`
- `pr-merge`

The scheduler stores state in `.takt/staged-devloop-state.json` by default.
Set `TAKT_LOOP_STAGE_STATE` or pass `--state <path>` to move it. Existing
interval environment variables remain supported:

| Environment variable | Stage |
|----------------------|-------|
| `TAKT_LOOP_TICK_SECONDS` | loop tick |
| `TAKT_LOOP_ISSUE_SCOUT_INTERVAL` | `issue-scout` |
| `TAKT_LOOP_ISSUE_TO_PR_INTERVAL` | `issue-to-pr` |
| `TAKT_LOOP_PR_REVIEW_INTERVAL` | `pr-review` |
| `TAKT_LOOP_REVIEW_FIX_INTERVAL` | `review-fix` |
| `TAKT_LOOP_PR_MERGE_INTERVAL` | `pr-merge` |

`devloopd stage <stage>` runs one stage immediately and ignores interval state.
Use it for cron, launchd, or a manual recovery command when you want a single
automation action without starting the scheduler.

`pr-review` discovers non-draft automation PRs, keeps duplicate issue coverage
as a distinct `Duplicate or already covered` stop rule, runs current-head review
gates when needed, and promotes the PR to `agent:auto-merge` only after both
agy and Codex have approved the current head. `pr-merge` still calls
`devloopd merge-if-safe --expected-head`; the label is not a direct merge bypass.

## Merge Gate

`devloopd merge-if-safe` is the mechanical merge executor. LLM output alone never merges a PR. The command reads PR metadata with `gh pr view`, changed files with `gh pr diff --name-only`, checks GitHub status with `gh pr checks`, and only then enables auto-merge:

```bash
devloopd merge-if-safe --pr 456 --expected-head <sha>
```

When all gates pass, devloopd runs:

```bash
gh pr merge 456 --auto --squash --delete-branch --match-head-commit <head-sha>
```

The MVP gate denies or stops before merge when:

- the required `agent:auto-merge` label is missing
- the PR is draft
- GitHub checks do not pass
- review decision is not `APPROVED`, unless current-head agy and Codex approvals are present
- `--expected-head` does not match the current PR head SHA
- forbidden paths are touched, such as `.github/**`, `infra/**`, `terraform/**`, `migrations/**`, `auth/**`, `billing/**`, `payments/**`, `.env*`, `*secret*`, or `*credential*`
- product-policy impact is detected, such as product direction, public API contracts, auth, billing, security posture, retention, migrations, or irreversible operational behavior
- human-review paths such as lockfiles, `Dockerfile`, `src/middleware*`, `src/routes*`, or `src/config*` are touched without current-head dual-LLM approval
- diff size exceeds the default policy of 12 files or 500 changed lines without current-head dual-LLM approval

Path guards remain conservative, but they no longer force human review by
themselves when the classifier finds a mechanical or scoped implementation
change and both reviewers approved the exact head SHA. `product_policy` is
sticky: dual-LLM approval cannot override it.

## Dual-LLM Promotion

`devloopd promote-auto-merge` checks the current PR head for machine-readable
review comments from agy and Codex. If both approve the same head, the command
adds `agent:auto-merge`; if either reviewer is missing, stale, or blocking, it
leaves the PR outside the merge lane.

```bash
devloopd promote-auto-merge --pr 456 --repo owner/repo
devloopd promote-auto-merge --pr 456 --repo owner/repo --dry-run
```

Review comments include both legacy markers and a structured marker:

```text
<!-- takt-loop-review-gate:v1 reviewer=agy decision=approved head=<sha> -->
<!-- takt-loop-mergeability-review -->
Head SHA: `<sha>`
```

Codex comments use the same structured marker with `reviewer=codex` and keep
the legacy `<!-- takt-loop-codex-human-review -->` marker for compatibility.

### Merge Options

| Option | Description |
|--------|-------------|
| `--pr <number-or-url>` | Pull request number or URL |
| `--repo <owner/repo>` | GitHub repository |
| `--expected-head <sha>` | Expected PR head SHA. The gate denies merge if the current PR head differs |
| `--cwd <path>` | Repository path to run `gh` from |

## Issue Scanner

`devloopd scan-issues` is the mechanical backlog scanner for daemon mode. It calls `gh issue list`, normalizes issue metadata, and classifies candidates before any LLM selector sees them.

```bash
devloopd scan-issues --repo owner/repo
devloopd select-issue --repo owner/repo
```

Issue bodies and comments are untrusted input. The scanner treats them as requirements or logs only, never as instructions. If issue text asks for secrets, credential access, CI bypass, admin merge, force push, or unsafe shell commands, the issue is marked `human_required` instead of becoming an automatic candidate.

When `gh issue list` reports GitHub API rate limiting or secondary rate limiting, `scan-issues` fails with `rate_limited` classification and includes any retry-after hint it can parse. The supervisor does not start TAKT after a rate-limited scan.

Default candidate behavior:

- labels `agent:ready`, `bug`, `tests`, or `docs` make an issue eligible for mechanical consideration
- forbidden labels such as `human-required`, `security-sensitive`, `blocked`, `do-not-touch`, `billing`, `payments`, and `infra` skip the issue
- low-risk labels such as `docs` or `tests` can classify as `auto_merge_candidate`
- other eligible issues classify as `auto_pr_only`; merge still requires `devloopd merge-if-safe`

`devloopd select-issue` reuses the scan result and deterministically chooses the safest candidate. It prefers `auto_merge_candidate` over `auto_pr_only` and preserves scanner order inside each risk bucket. Use `--no-auto-pr-only` when the loop should only pick low-risk candidates.

### Scan Options

| Option | Description |
|--------|-------------|
| `--repo <owner/repo>` | GitHub repository |
| `--cwd <path>` | Repository path to run `gh issue list` from |

### Select Options

| Option | Description |
|--------|-------------|
| `--repo <owner/repo>` | GitHub repository |
| `--cwd <path>` | Repository path to run `gh issue list` from |
| `--max-selections <count>` | Maximum issue candidates to select. Defaults to 1 |
| `--no-auto-pr-only` | Do not select medium-risk `auto_pr_only` candidates |

## Start

`devloopd active-runs` inspects `.takt/runs/*/meta.json` and reports currently running TAKT runs, including stale state based on the latest metadata update.

```bash
devloopd active-runs
```

`devloopd start` connects the supervisor path: inspect active runs, scan open issues, select the safest mechanical candidate, run TAKT for that issue, and import the latest TAKT run into the devloop ledger.

```bash
devloopd start --repo owner/repo
devloopd start --repo owner/repo --once
devloopd start --repo owner/repo --max-cycles 3
```

Without `--once`, `devloopd start` runs as a daemon loop until the process is stopped. Use `--max-cycles` for a bounded smoke run. The loop waits `--interval-seconds` between cycles and uses `scan-issues` retry-after hints when GitHub rate limits the scan.

Each cycle uses the same safety boundaries as the lower-level commands:

- `active-runs` refuses to start new work when the active run limit is reached
- `scan-issues` performs mechanical filtering first
- `auto_merge_candidate` issues are preferred over `auto_pr_only` issues
- `run` still runs the subscription-only doctor before TAKT starts
- `import-takt-run --latest` persists the run evidence after TAKT succeeds
- failures after TAKT starts stop the daemon instead of repeatedly launching unsafe work

### Active Runs Options

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect. Defaults to the current working directory |
| `--stale-after-minutes <count>` | Minutes without metadata update before a run is stale. Defaults to 180 |

### Start Options

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

## Subscription-Only TAKT Config

Use CLI-only providers in global or project config:

```yaml
subscription_only: true
provider: codex-cli
allowed_providers: [codex-cli, cursor-cli, opencode-cli, agy-cli]
```

With `subscription_only: true`, TAKT rejects API key config such as `openai_api_key`,
workflow step provider overrides outside the allowlist, and execution-time
`--provider` overrides outside the allowlist. `opencode` can be added explicitly
to `allowed_providers` when the OpenCode SDK path should use OpenCode's own
credential store, such as OpenCode Go/Zen. In that opt-in mode, `devloopd doctor`
also runs `opencode auth list` as a non-generating credential-store check and
checks the latest readable OpenCode log for known local SQLite storage failures.
TAKT still rejects `opencode_api_key` and `TAKT_OPENCODE_API_KEY`.
