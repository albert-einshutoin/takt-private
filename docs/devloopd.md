# devloopd

[日本語](./devloopd.ja.md)

`devloopd` is a sidecar CLI packaged with TAKT. Its first supported command is a local readiness doctor for teams that run TAKT only through subscription/login-session CLI providers.

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

The doctor reports forbidden environment variables and config keys by name only. It does not print secret values.

### Options

| Option | Description |
|--------|-------------|
| `--subscription-only` | Require TAKT subscription-only policy checks |
| `--repo <path>` | Repository path to inspect. Defaults to the current working directory |
| `--policy <path>` | Optional devloop policy YAML path |
| `--verbose` | Show passing checks as well as warnings and failures |
| `--skip-auth` | Skip `gh auth status` |

### Optional Policy File

Use `--policy` when a project keeps devloop policy beside its TAKT config:

```yaml
mode: subscription_only
```

Then run:

```bash
devloopd doctor --subscription-only --policy .takt/devloopd.yaml
```

If no policy file is provided, the doctor emits a warning and continues. TAKT config and workflow checks still run.

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

## Subscription-Only TAKT Config

Use CLI-only providers in global or project config:

```yaml
subscription_only: true
provider: codex-cli
allowed_providers: [codex-cli, cursor-cli, opencode-cli, agy-cli]
```

With `subscription_only: true`, TAKT rejects SDK/API providers such as `codex` or `opencode`, API key config such as `openai_api_key`, workflow step provider overrides outside the allowlist, and execution-time `--provider` overrides outside the allowlist.
