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
- `opencode` が明示的に allowlist されている場合、読み取り可能な最新 OpenCode log に既知の local SQLite storage error が出ていないこと

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
読み取り可能な最新 log に `session_message.seq` など local SQLite storage 問題の兆候があります。CLI / SDK smoke
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

## 自動化レビュー境界

`devloopd` は、人間が判断すべきプロダクト方針と、再帰的に進めてよい機械的な作業を分けます。
machine-readable な policy category は次の 4 つです。

| Category | merge 時の扱い |
|----------|----------------|
| `product_policy` | 必ず human review で止めます。dual-LLM approval だけでは上書きできません |
| `human_policy` | 自動化ポリシー自体の変更なので human owner が確認します |
| `auto_recursive` | agent による再帰的な作業、dual-LLM review、quality gate、auto-merge の対象です |
| `mechanical` | checks と review marker が通れば最短の mechanical path に乗せます |

人間が確認する対象は、product direction、user-facing commitment、pricing、billing、
authentication、authorization、security posture、data retention、migration、
public compatibility contract、deployment policy、不可逆な operational behavior です。
この taxonomy や recursive lane 定義の変更も `human_policy` として扱います。

必ず human review で止める例:

- pricing / billing behavior の変更
- public API contract や migration
- auth、permission、privacy、retention、security posture の変更
- release、deployment、不可逆な operations policy の変更
- auto-merge、human-review、lane taxonomy 自体の変更

コード変更であっても、それだけでは止めない例:

- 受け入れ済みの product behavior を保つ feature maintenance
- benchmark に基づく performance / memory optimization
- lockfile と verification evidence がある安全な dependency update
- public posture を変えない security hardening
- 言語特性を活かした refactor、type-safety 改善
- docs、tests、fixtures、lint、formatting、local tooling

recursive automation lane:

| Lane | 自動化できる範囲 | escalate 条件 |
|------|------------------|----------------|
| `feature_improvement` | 受け入れ済み behavior の scoped improvement | public behavior や product direction が変わる |
| `performance` | benchmark-backed optimization | resource policy や observable behavior が変わる |
| `dependencies` | library / lockfile の安全な更新 | major migration、license、privileged runtime risk が出る |
| `security_hardening` | より安全な implementation detail | security posture、privacy、compliance policy が変わる |
| `idiomatic_refactor` | maintainability / type-safety の refactor | public API や architecture direction が変わる |
| `docs_tests_tooling` | docs、tests、fixtures、lint、tooling | docs が product promise を変える、または CI/release policy が変わる |

product-policy classifier は changed path だけでなく diff hunk も読みます。
public API / CLI compatibility、auth、billing、retention、migration、不可逆な運用変更、
security posture、user-facing commitment は sticky evidence として残り、LLM 承認だけでは
上書きできません。redaction、sanitization、より安全な validation のような security
hardening は、public posture を変えない限り自動化対象のままです。classifier eval fixture は
mechanical、implementation、product-policy の例を持ち、false positive / false negative が
threshold を超えた場合に regression として落ちます。

## Issue Scout

`devloopd issue-scout` は backlog discovery、maintenance issue generation、
dedupe、priority scoring、retry/backoff 記録を devloopd 側に移します。

```bash
devloopd issue-scout --repo owner/repo --dry-run
devloopd issue-scout --repo owner/repo --source local_backlog todo_scan
devloopd stage issue-scout --repo owner/repo --dry-run
```

typed source は `github_issues`、`local_backlog`、`todo_scan`、
`dependency_report`、`security_report`、`benchmark_report`、`lint_type_debt`、
`ledger_events` です。各 source は status、summary、candidate work item、
next action、artifact を持つ deterministic observation を返します。source が
存在しない場合も shell retry loop にはせず warning observation にします。

生成される maintenance issue には acceptance criteria、verification command、
product-policy escalation criteria、lane evidence、expected changed surfaces が入ります。
JSON report source は benchmark baseline / target、dependency version、changelog / advisory URL、
security threat evidence、custom verification command を渡せます。major / breaking dependency
update は `human_policy` になり、patch / minor update は quality gate を通れば recursive のままです。
issue scout は open issue、open PR、branch name、過去の ledger decision と dedupe し、残った candidate を
risk bucket、lane priority、verification cost、expected changed surfaces で score します。
`Duplicate or already covered`、`active run limit`、`Unsafe or too broad` は別の stop rule として
残すため、あとから「なぜ work が選ばれなかったか」を説明できます。

各 run は `.devloop/ledger.jsonl` に `devloop_issue_scout` event を追記します。
no-op scan が続いても ledger payload から理由を追跡でき、retry/backoff timestamp は
将来 SQLite backend へ移せる JSONL shape で保存します。

### Issue Scout オプション

| オプション | 説明 |
|-----------|------|
| `--repo <owner/repo>` | issue / PR dedupe に使う GitHub repository |
| `--cwd <path>` | 検査する repository path。省略時は current working directory |
| `--ledger <path>` | ledger path。デフォルトは `.devloop/ledger.jsonl` |
| `--source <id...>` | scan 対象を指定した typed source ID に限定します |
| `--max-selections <count>` | 選択する generated issue candidate の最大数 |
| `--dry-run` | GitHub を変更せず would-create issue を表示します |
| `--create` | dry-run でない場合に selected issue を GitHub に作成します |

## Review-Fix と CI Repair

`review-fix` は detection-only ではなくなりました。同一 repository の automation PR に
current-head の `Mergeable: NO` review marker がある場合、devloopd は isolated worktree を作成し、
scoped fixer を実行し、quality gate を通し、commit して PR branch に push できます。fixer には
review body、PR metadata、current diff paths、issue context、strict scope limits を渡します。

push 前に devloopd が確認する内容:

- same-repository automation branch であること
- PR head SHA と blocker fingerprint ごとの attempt budget
- `.takt/quality-gates/*` が存在する場合はその quality gate
- `git diff --check`
- forbidden path を変更していないこと
- human approval label がない限り product-policy / human-policy surface を変更していないこと
- original PR scope 外のファイルを変更していないこと
- `git push --force-with-lease` 前の expected-head verification

GitHub checks が失敗した場合、CI repair loop は failed check run を集め、`gh run view --log` で
bounded log を取得し、secret を sanitize して、summary を ledger に保存します。そのうえで failure を
`deterministic`、`flaky`、`infra`、`auth_permission`、`timeout`、`unknown` に分類します。
`deterministic` と `unknown` は repair worktree に入ります。`flaky`、`infra`、`timeout` は
code change の前に bounded backoff で retry します。`auth_permission` は human/operator action で止めます。

## Staged Automation

`devloopd staged` は、これまで shell にあった portable devloop scheduler を
devloopd 側で実行します。stage ごとに独立した interval を持ち、last-run
timestamp は JSON state として保存されます。`.takt/automation/*.sh` は互換
wrapper として `devloopd` に委譲できます。

```bash
devloopd staged once --repo owner/repo
devloopd staged loop --repo owner/repo --max-cycles 3
devloopd staged pr-review --repo owner/repo
devloopd stage pr-merge --repo owner/repo
```

stage は次の順で評価されます。

- `issue-scout`
- `issue-to-pr`
- `pr-review`
- `review-fix`
- `pr-merge`

state のデフォルトは `.takt/staged-devloop-state.json` です。
`TAKT_LOOP_STAGE_STATE` または `--state <path>` で変更できます。既存の
interval 環境変数も引き続き使えます。

| 環境変数 | 対象 |
|---------|------|
| `TAKT_LOOP_TICK_SECONDS` | loop tick |
| `TAKT_LOOP_ISSUE_SCOUT_INTERVAL` | `issue-scout` |
| `TAKT_LOOP_ISSUE_TO_PR_INTERVAL` | `issue-to-pr` |
| `TAKT_LOOP_PR_REVIEW_INTERVAL` | `pr-review` |
| `TAKT_LOOP_REVIEW_FIX_INTERVAL` | `review-fix` |
| `TAKT_LOOP_PR_MERGE_INTERVAL` | `pr-merge` |

同じ state file には recursive safety counter も保存されます。デフォルトでは
3 回連続の no-op cycle、3 回の classifier disagreement、5 回の CI flake loop、
3 回の review-fix failure、5 回の product-policy escalation で止まります。
必要に応じて次の環境変数で上書きできます。

| 環境変数 | safety budget |
|---------|---------------|
| `TAKT_LOOP_MAX_RUNS` | stage execution 数 |
| `TAKT_LOOP_MAX_PULL_REQUESTS` | PR touch 数 |
| `TAKT_LOOP_MAX_RETRIES` | repair attempt 数 |
| `TAKT_LOOP_MAX_COST_PROXY` | external cost proxy |
| `TAKT_LOOP_MAX_DURATION_SECONDS` | loop 経過時間 |
| `TAKT_LOOP_MAX_CHANGED_FILES` | changed file budget |
| `TAKT_LOOP_MAX_CHANGED_LINES` | changed line budget |
| `TAKT_LOOP_MAX_CONSECUTIVE_NOOP_SIGNALS` | completion no-op cycle |
| `TAKT_LOOP_MAX_CLASSIFIER_DISAGREEMENTS` | classifier circuit breaker |
| `TAKT_LOOP_MAX_CI_FLAKES` | CI flake circuit breaker |
| `TAKT_LOOP_MAX_REVIEW_FIX_FAILURES` | review-fix circuit breaker |
| `TAKT_LOOP_MAX_PRODUCT_POLICY_ESCALATIONS` | human escalation circuit breaker |

`devloopd stage <stage>` は interval state を見ずに単一 stage を即時実行します。
cron、launchd、手動復旧など、scheduler を起動せず 1 action だけ走らせたい場合に使います。

`pr-review` は non-draft の automation PR を検出し、duplicate issue coverage を
`Duplicate or already covered` stop rule として扱います。必要に応じて current-head
review gate を走らせ、agy と Codex の両方が同じ head SHA を承認した場合だけ
`agent:auto-merge` に昇格します。`pr-merge` は引き続き
`devloopd merge-if-safe --expected-head` を呼ぶため、label は直接 merge bypass ではありません。

merge 前に、`pr-merge` は promote 済み automation PR から changed-file queue を作ります。
file overlap がない PR は同じ queue layer で merge 可能です。overlap がある PR は直列化し、
dirty、conflict、base drift がある PR は conflicting files、`gh pr diff --patch` で取得した
PR diff context、取得できた merge-tree output、先に landing した PR reference、repair prompt を
持つ eviction として止めます。stage action と queue decision は
`devloop_automation_state` ledger event として保存され、次のコマンドで要約できます。

```bash
devloopd automation-state --cwd /path/to/repo
```

大きい backlog slice は DAG work unit に分解できます。明示 dependency と file-overlap dependency が
layer を決め、test は implementation surface と同じ unit に残します。product-policy work unit を含む
plan は human-review-required になります。safety budget は max runs、PR 数、retry 数、cost proxy、
duration、changed files、changed lines、no-op completion signal、classifier disagreement、
CI flake loop、review-fix failure、product-policy escalation loop で recursive loop を止めます。

## Merge Gate

`devloopd merge-if-safe` は機械的な merge 実行者です。LLM output だけで PR を merge しません。このコマンドは `gh pr view` で PR metadata、`gh pr diff --name-only` で変更ファイル、`gh pr diff` で full diff hunk、`gh pr checks` で GitHub checks を確認し、通過した場合だけ auto-merge を有効化します。

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
- review decision が `APPROVED` ではない。ただし current-head の agy と Codex 承認がある場合は通過可能
- `--expected-head` が現在の PR head SHA と一致しない
- `.github/**`, `infra/**`, `terraform/**`, `migrations/**`, `auth/**`, `billing/**`, `payments/**`, `.env*`, `*secret*`, `*credential*` のような forbidden path に触れている
- product direction、public API contract、auth、billing、security posture、retention、migration、不可逆な運用変更などの product-policy impact がある
- lockfile, `Dockerfile`, `src/middleware*`, `src/routes*`, `src/config*` のような human-review path に触れていて、current-head の dual-LLM 承認がない
- diff がデフォルト policy の 12 files または 500 changed lines を超えていて、current-head の dual-LLM 承認がない

path guard は保守的に残しますが、classifier が mechanical または scoped implementation
と判定し、かつ agy / Codex の両方が同じ head SHA を承認している場合は、それだけで
human review 固定にはしません。`product_policy` 判定は sticky で、dual-LLM 承認だけでは
上書きできません。

## Dual-LLM Promotion

`devloopd promote-auto-merge` は、現在の PR head に対する agy と Codex の machine-readable
review comment を確認します。両方が同じ head を承認している場合だけ
`agent:auto-merge` label を追加し、どちらかが missing / stale / blocking の場合は merge lane に入れません。

```bash
devloopd promote-auto-merge --pr 456 --repo owner/repo
devloopd promote-auto-merge --pr 456 --repo owner/repo --dry-run
```

review comment は legacy marker と structured marker の両方を含みます。

```text
<!-- takt-loop-review-gate:v1 reviewer=agy decision=approved head=<sha> -->
<!-- takt-loop-mergeability-review -->
Head SHA: `<sha>`
```

Codex comment では `reviewer=codex` を使い、互換性のため
`<!-- takt-loop-codex-human-review -->` marker も残します。

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
読み取り可能な最新 OpenCode log に既知の local SQLite storage failure が出ていないか確認します。
TAKT は引き続き `opencode_api_key` と `TAKT_OPENCODE_API_KEY` を拒否します。
