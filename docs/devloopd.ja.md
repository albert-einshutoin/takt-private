# devloopd

[English](./devloopd.md)

`devloopd` は TAKT に同梱される sidecar CLI です。TAKT をサブスク/ログイン済み CLI provider だけで運用するチーム向けに、ローカル環境チェックと有限の supervisor utility を提供します。

## Doctor

長い workflow 実行や CI 的なローカル自動化の前に実行します。

```bash
devloopd doctor --subscription-only
```

すべての必須チェックが通れば終了コード `0`、subscription-only の必須ガードに違反すれば終了コード `1` で終了します。

### チェック内容

`devloopd doctor --subscription-only` は次を確認します。

- `--subscription-only` が明示されていること
- 任意の devloop policy YAML が `mode: subscription_only` であること
- `OPENAI_API_KEY` や `TAKT_OPENAI_API_KEY` のような API key 課金系の環境変数が存在しないこと
- 必須 CLI が `PATH` 上にあること: `takt`, `gh`, `codex`, `opencode`, `agy`
- Cursor CLI が `cursor-agent` または `agent` として利用できること
- `--skip-auth` を付けない限り、`gh auth status` が成功すること
- 解決後の TAKT 設定で `subscription_only: true` が有効であること
- global / project の TAKT config に API key config キーが含まれていないこと
- `.takt/workflows/` 配下の project workflow が TAKT workflow doctor に通り、subscription-only provider チェックにも通ること
- `opencode` が明示的に allowlist されている場合、`opencode auth list` で OpenCode credential store を読めること
- `opencode` が明示的に allowlist されている場合、直近の OpenCode log に既知の local SQLite storage error が出ていないこと

doctor は禁止された環境変数名と config キー名だけを表示します。secret 値は出力しません。

`npm link` や global install 前の source checkout から `devloopd` を実行する場合、
`takt` コマンドのチェックは検査対象 repository 隣接の `bin/takt` wrapper を許容します。
その他の provider CLI は引き続き `PATH` 上にインストールされている必要があります。

デフォルトの `doctor` は local config、command discovery、認証状態だけを検査します。
`codex-cli`、`cursor-cli`、`opencode-cli`、`agy-cli` の bounded な実 CLI 生成チェックまで行う場合は、
明示的に `--smoke-cli` を付けます。

```bash
devloopd doctor --subscription-only --smoke-cli --smoke-timeout-ms 60000
```

smoke check は prerequisite の doctor check が通った場合だけ実行されます。subscription-only
環境 sanitizer を使い、CLI が timeout を超えた場合は hang せず failure として扱います。

### Smoke failure の切り分け

`smoke:opencode-cli` は、TAKT の設定、command discovery、subscription-only guard が正しくても、
OpenCode 側の `UnknownError`（例: `Unexpected server error`）で失敗することがあります。
その場合は、まず OpenCode を直接実行して切り分けます。

```bash
opencode run "Reply with exactly: Done"
```

直接実行でも同じ失敗になる場合は、OpenCode の account / service 状態を確認してください。
`devloopd doctor` が `OpenCode storage` を報告する場合、OpenCode credential store は読めていますが、
直近 log に `session_message.seq` など local SQLite storage 問題の兆候があります。CLI / SDK smoke
を通す前に、OpenCode の local database をバックアップまたは修復してください。global OpenCode MCP 設定の影響を
除外したい場合は、inline の OpenCode config override で疑わしい MCP server を一時的に無効化して再試行できます。

```bash
OPENCODE_CONFIG_CONTENT='{"mcp":{"pencil":{"enabled":false}}}' \
  opencode run "Reply with exactly: Done"
```

TAKT は smoke check 中も subscription-only mode を維持します。ログイン済み CLI が失敗しても、
SDK/API provider や API key credential へフォールバックしません。

### オプション

| オプション | 説明 |
|-----------|------|
| `--subscription-only` | TAKT の subscription-only policy チェックを必須にします |
| `--repo <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--policy <path>` | 任意の devloop policy YAML パス。`.takt/devloopd.yaml` が存在する場合は自動検出します |
| `--verbose` | warning / failure だけでなく pass したチェックも表示します |
| `--skip-auth` | `gh auth status` をスキップします |
| `--smoke-cli` | subscription-only provider の bounded な実 CLI smoke check を実行します |
| `--smoke-timeout-ms <ms>` | provider ごとの CLI smoke timeout。デフォルトは 60000 |

### 任意の policy ファイル

project 側の devloop policy は `.takt/devloopd.yaml` に置けます。

```yaml
mode: subscription_only
```

doctor はこのファイルを自動検出します。policy が別の場所にある場合だけ `--policy` を使います。

```bash
devloopd doctor --subscription-only --policy .takt/devloopd.yaml
```

policy ファイルを指定せず、`.takt/devloopd.yaml` も存在しない場合、doctor は warning を出して続行します。TAKT config と workflow の検査はそのまま実行されます。

## Run

`devloopd run` は、subscription-only doctor が通った場合だけ TAKT の Issue pipeline を開始します。

```bash
devloopd run --issue 123 --repo owner/repo
```

このコマンドは `devloopd doctor --subscription-only` と同じチェックを実行します。必須ガードに違反した場合、TAKT は起動しません。

チェックが通ると、`devloopd run` は次と同等の argv で TAKT を実行します。

```bash
takt --pipeline \
  --issue 123 \
  --workflow .takt/workflows/subscription-devloop.yaml \
  --auto-pr \
  --quiet \
  --repo owner/repo
```

### Run オプション

| オプション | 説明 |
|-----------|------|
| `--issue <number>` | TAKT で実行する GitHub Issue 番号 |
| `--repo <owner/repo>` | TAKT の PR 操作用リポジトリ |
| `--workflow <path>` | TAKT workflow 名またはパス。デフォルトは `.takt/workflows/subscription-devloop.yaml` |
| `--policy <path>` | doctor に渡す任意の devloop policy YAML パス |
| `--cwd <path>` | 実行対象リポジトリパス。省略時はカレントディレクトリ |
| `--skip-auth` | `gh auth status` をスキップします |
| `--no-auto-pr` | TAKT に `--auto-pr` を渡しません |
| `--no-quiet` | TAKT に `--quiet` を渡しません |

## Import And Timeline

TAKT は workflow engine として `.takt/runs/` に run metadata を出力します。`devloopd import-takt-run` はその metadata を `.devloop/ledger.jsonl` に取り込み、log / report file の artifact path、byte size、SHA-256 hash を保存します。

```bash
devloopd import-takt-run --latest --issue 123
devloopd reconcile-runs
devloopd export-ledger --output .devloop/backup/ledger.jsonl
devloopd timeline --issue 123
devloopd memory --write
```

JSONL ledger は portable な MVP event log です。`.devloop/` は Git から無視され、将来の SQLite backend に移しても TAKT run output 側を変えずに済む境界です。

`devloopd reconcile-runs` は `.takt/runs/` を scan し、未取り込みかつ running ではない run を ledger に取り込みます。すでに取り込み済みの run と実行中 run は skip するため、daemon crash、import 中断、backup restore の後に安全に使えます。

`devloopd export-ledger` は ledger event を JSONL backup file に書き出します。相対出力パスはリポジトリ内に限定され、既存ファイルは `--force` を指定しない限り保護されます。

`devloopd memory` は imported run metadata から compact project memory snapshot を生成します。raw log content は読みません。追跡用に report artifact path は含めますが、memory text には log artifact を含めません。

### Import オプション

| オプション | 説明 |
|-----------|------|
| `--latest` | `.takt/runs/` から最新 TAKT run を取り込みます |
| `--run <slug>` | 指定した TAKT run slug を取り込みます |
| `--issue <number>` | 取り込む run に GitHub Issue 番号を関連付けます |
| `--cwd <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--ledger <path>` | ledger パス。デフォルトは `.devloop/ledger.jsonl` |

### Timeline オプション

| オプション | 説明 |
|-----------|------|
| `--issue <number>` | GitHub Issue 番号で imported run を絞り込みます |
| `--run <slug>` | TAKT run slug で imported run を絞り込みます |
| `--cwd <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--ledger <path>` | ledger パス。デフォルトは `.devloop/ledger.jsonl` |

### Reconcile オプション

| オプション | 説明 |
|-----------|------|
| `--issue <number>` | 取り込む run に GitHub Issue 番号を関連付けます |
| `--cwd <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--ledger <path>` | ledger パス。デフォルトは `.devloop/ledger.jsonl` |

### Export オプション

| オプション | 説明 |
|-----------|------|
| `--output <path>` | JSONL 出力パス。相対パスはリポジトリ内に限定されます |
| `--force` | 既存の出力ファイルを上書きします |
| `--issue <number>` | GitHub Issue 番号で exported run を絞り込みます |
| `--run <slug>` | TAKT run slug で exported run を絞り込みます |
| `--cwd <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--ledger <path>` | ledger パス。デフォルトは `.devloop/ledger.jsonl` |

### Memory オプション

| オプション | 説明 |
|-----------|------|
| `--issue <number>` | GitHub Issue 番号で imported run を絞り込みます |
| `--limit <count>` | 含める imported run の最大数。デフォルトは 20 |
| `--cwd <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--ledger <path>` | ledger パス。デフォルトは `.devloop/ledger.jsonl` |
| `--output <path>` | project 内の memory 出力パス。デフォルトは `.devloop/memory.md` |
| `--write` | 表示だけでなく memory file を書き出します |

## Merge Gate

`devloopd merge-if-safe` は機械的な merge 実行者です。LLM output だけで PR を merge しません。このコマンドは `gh pr view` で PR metadata、`gh pr diff --name-only` で変更ファイル、`gh pr checks --watch` で GitHub checks を確認し、通過した場合だけ auto-merge を有効化します。

```bash
devloopd merge-if-safe --pr 456 --expected-head <sha>
```

すべての gate が通ると、devloopd は次を実行します。

```bash
gh pr merge 456 --auto --squash --delete-branch --match-head-commit <head-sha>
```

MVP gate は次の場合、merge 前に拒否または停止します。

- 必須 label `agent:auto-merge` がない
- PR が draft
- GitHub checks が通っていない
- review decision が `APPROVED` ではない
- `--expected-head` が現在の PR head SHA と一致しない
- `.github/**`, `infra/**`, `terraform/**`, `migrations/**`, `auth/**`, `billing/**`, `payments/**`, `.env*`, `*secret*`, `*credential*` のような forbidden path に触れている
- lockfile, `Dockerfile`, `src/middleware*`, `src/routes*`, `src/config*` のような human-review path に触れている
- diff がデフォルト policy の 12 files または 500 changed lines を超える

### Merge オプション

| オプション | 説明 |
|-----------|------|
| `--pr <number-or-url>` | Pull Request 番号または URL |
| `--repo <owner/repo>` | GitHub リポジトリ |
| `--expected-head <sha>` | 期待する PR head SHA。現在の head と異なる場合は merge を拒否します |
| `--cwd <path>` | `gh` を実行するリポジトリパス |

## Issue Scanner

`devloopd scan-issues` は daemon mode のための機械的 backlog scanner です。`gh issue list` を呼び、Issue metadata を正規化し、LLM selector に渡す前に候補を分類します。

```bash
devloopd scan-issues --repo owner/repo
devloopd select-issue --repo owner/repo
```

Issue body と comments は untrusted input です。scanner はそれらを requirements / logs として扱い、指示としては扱いません。Issue text が secret、credential access、CI bypass、admin merge、force push、危険な shell command を要求している場合、自動候補にはせず `human_required` に分類します。

`gh issue list` が GitHub API rate limit または secondary rate limit を返した場合、`scan-issues` は `rate_limited` として失敗し、parse できた retry-after hint を表示します。rate-limited scan の後に supervisor が TAKT を起動することはありません。

デフォルトの候補分類:

- `agent:ready`, `bug`, `tests`, `docs` label がある Issue は機械的検討対象になる
- `human-required`, `security-sensitive`, `blocked`, `do-not-touch`, `billing`, `payments`, `infra` のような forbidden label がある Issue は skip する
- `docs` や `tests` のような低リスク label は `auto_merge_candidate` になり得る
- その他の eligible Issue は `auto_pr_only` になる。merge には引き続き `devloopd merge-if-safe` が必要

`devloopd select-issue` は scan 結果を再利用し、最も安全な候補を決定的に選びます。`auto_pr_only` より `auto_merge_candidate` を優先し、同じ risk bucket 内では scanner order を維持します。低リスク候補だけを選びたい場合は `--no-auto-pr-only` を使います。

### Scan オプション

| オプション | 説明 |
|-----------|------|
| `--repo <owner/repo>` | GitHub リポジトリ |
| `--cwd <path>` | `gh issue list` を実行するリポジトリパス |

### Select オプション

| オプション | 説明 |
|-----------|------|
| `--repo <owner/repo>` | GitHub リポジトリ |
| `--cwd <path>` | `gh issue list` を実行するリポジトリパス |
| `--max-selections <count>` | 選択する Issue 候補の最大数。デフォルトは 1 |
| `--no-auto-pr-only` | 中リスクの `auto_pr_only` 候補を選択しません |

## Start

`devloopd active-runs` は `.takt/runs/*/meta.json` を検査し、現在実行中の TAKT run と、metadata の最終更新時刻に基づく stale state を表示します。

```bash
devloopd active-runs
```

`devloopd start` は supervisor path をつなぎます。active run を検査し、open Issue を scan し、機械的に最も安全な候補を選び、その Issue で TAKT を実行し、最後に最新 TAKT run を devloop ledger に取り込みます。

```bash
devloopd start --repo owner/repo
devloopd start --repo owner/repo --once
devloopd start --repo owner/repo --max-cycles 3
```

`--once` がない場合、`devloopd start` は process が停止されるまで daemon loop として動きます。bounded な smoke run には `--max-cycles` を使います。cycle 間は `--interval-seconds` だけ待機し、GitHub rate limit 時は `scan-issues` の retry-after hint を使います。

各 cycle は下位コマンドと同じ安全境界を使います。

- `active-runs` が active run 上限に達している場合、新しい作業を開始しない
- `scan-issues` が先に機械的 filter を実行する
- `auto_pr_only` Issue より `auto_merge_candidate` Issue を優先する
- `run` は TAKT 起動前に subscription-only doctor を実行する
- TAKT が成功した後に `import-takt-run --latest` で run evidence を保存する
- TAKT 起動後の失敗は、危険な再起動を避けるため daemon を停止する

### Active Runs オプション

| オプション | 説明 |
|-----------|------|
| `--cwd <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--stale-after-minutes <count>` | metadata 更新がない run を stale とみなすまでの分数。デフォルトは 180 |

### Start オプション

| オプション | 説明 |
|-----------|------|
| `--repo <owner/repo>` | GitHub リポジトリ |
| `--once` | scan/run/import cycle を 1 回だけ実行して終了します |
| `--max-cycles <count>` | 指定した daemon cycle 数で停止します |
| `--interval-seconds <count>` | daemon cycle 間の待機秒数。デフォルトは 60 |
| `--workflow <path>` | TAKT workflow 名またはパス。デフォルトは `.takt/workflows/subscription-devloop.yaml` |
| `--policy <path>` | subscription-only doctor に渡す任意の devloop policy YAML パス。`.takt/devloopd.yaml` が存在する場合は自動検出します |
| `--cwd <path>` | 実行対象リポジトリパス。省略時はカレントディレクトリ |
| `--ledger <path>` | ledger パス。デフォルトは `.devloop/ledger.jsonl` |
| `--max-active-runs <count>` | scan を拒否する active TAKT run 数の上限。デフォルトは 1 |
| `--stale-after-minutes <count>` | active-runs が run を stale とみなすまでの分数。デフォルトは 180 |
| `--skip-auth` | `gh auth status` をスキップします |
| `--no-auto-pr` | TAKT に `--auto-pr` を渡しません |
| `--no-quiet` | TAKT に `--quiet` を渡しません |

## Subscription-Only TAKT Config

global または project config では CLI-only provider を使います。

```yaml
subscription_only: true
provider: codex-cli
allowed_providers: [codex-cli, cursor-cli, opencode-cli, agy-cli]
```

`subscription_only: true` が有効な場合、TAKT は `openai_api_key` のような API key 設定、
allowlist 外の workflow step provider 上書き、allowlist 外の実行時 `--provider` 上書きを拒否します。
OpenCode Go/Zen など OpenCode 側の credential store を使って SDK 経路を使いたい場合は、
`allowed_providers` に `opencode` を明示追加できます。この opt-in mode では、
`devloopd doctor` も生成を伴わない credential-store check として `opencode auth list` を実行し、
直近の OpenCode log に既知の local SQLite storage failure が出ていないか確認します。
TAKT は引き続き `opencode_api_key` と `TAKT_OPENCODE_API_KEY` を拒否します。
