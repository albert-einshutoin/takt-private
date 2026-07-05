# Personal Use Quickstart and Operations Runbook

この guide は、1 人の開発者が local workstation で TAKT automation を安全に動かすためのものです。
default path は bounded automation、明示的な recovery、product-policy decision の human review を優先します。

## Prerequisites

- `package.json` と互換の Node.js / npm (`node >=20.6.0`)。
- `git` と GitHub CLI (`gh`) が `PATH` にあること。
- target repository に対して `gh auth status` が通ること。
- target repository で branch 作成、Issue/PR 読み取り、PR comment、label 操作ができること。
- live provider smoke を使う場合は、任意の provider CLI が install / auth 済みであること。
- target repository で local automation state を ignore すること。
  - `.devloop/`
  - `.takt/runs/`

provider credential、`.devloop/` ledger、scheduler snippet、raw log、local run directory は commit しません。

## Install or Update TAKT

private checkout の場合:

```bash
git fetch origin main --tags
git switch main
git pull --ff-only origin main
npm ci
npm run release:personal:check
npm link
devloopd release-info
```

`release:personal:check` は `check:personal`、`npm pack --dry-run`、release provenance を実行します。npm publish は行いません。

## Onboard a Target Repository

最初は dry-run します。

```bash
cd /path/to/target-repo
devloopd onboard-repo --cwd . --repo owner/repo
```

dry-run の内容が正しい場合だけ apply します。

```bash
devloopd onboard-repo --cwd . --repo owner/repo --apply
```

onboarding は subscription-only TAKT config、devloop policy、default workflow wrapper、ignore rule、必須 `agent:*` label を作ります。`--force` を明示しない限り、既存 `.takt` file は保持します。

## Readiness

automation の前に確認します。

```bash
devloopd ready --cwd . --repo owner/repo
devloopd provider-smoke --cwd .
npm run check:personal
```

`check:personal` は build、lint、focused devloopd soak、full unit tests、mock E2E、product-policy replay、高 severity audit、whitespace check、optional provider smoke を実行します。optional provider failure は見える形で報告されますが、default ではすべての paid/live provider credential を要求しません。

## Safe Default Automation

bounded manual run:

```bash
devloopd staged loop --cwd . --repo owner/repo --safety-profile safe-default --max-cycles 1
devloopd status --cwd .
```

短い foreground supervisor smoke:

```bash
devloopd start --cwd . --repo owner/repo --max-cycles 1
devloopd status --cwd .
```

scheduler は launchd/cron を手書きせず、template を生成します。

```bash
devloopd schedule-template --kind launchd --cwd . --repo owner/repo
devloopd schedule-template --kind cron --cwd . --repo owner/repo
```

scheduler template は `check:personal`、stale-state recovery、bounded な `staged loop --max-cycles 1 --safety-profile safe-default` の順に実行します。

## Inspect, Stop, and Reset

まず status を見ます。

```bash
devloopd status --cwd .
devloopd automation-state --cwd .
devloopd timeline --issue 123
```

foreground personal loop は次 cycle 前に止められます。

```bash
devloopd stop --cwd . --reason "maintenance window"
devloopd status --cwd .
```

daemon lifecycle metadata と stop-request state だけを reset します。

```bash
devloopd reset --cwd .
```

`reset` は TAKT run artifact、`.devloop/ledger.jsonl`、report、log を削除しません。

## Recovery

必ず dry-run から始めます。

```bash
devloopd recover-stale --cwd .
devloopd recover-stale --cwd . --apply
devloopd status --cwd .
```

recovery が変更し得るもの:

- stale active run metadata を aborted にする
- stale lock file を削除する
- dead daemon metadata を消す
- abandoned non-git worktree directory を prune する

recovery が保持するもの:

- `.devloop/ledger.jsonl`
- `.takt/runs/`
- report、log、Git worktree
- provider credential と local auth store

## Human Review Boundaries

次を触る change は human review で止めます。

- product direction、roadmap、pricing、plan、entitlement behavior
- public API / CLI compatibility contract
- authentication、authorization、billing、retention、privacy、compliance、security posture
- migration または不可逆な operational behavior
- automated policy が自信を持って分類できない package/license/dependency risk
- auto-merge、human-review、lane taxonomy、classifier category、threshold policy そのもの

受け入れ済み product behavior を保ち、gate を通る routine feature improvement、performance work、dependency patch、security hardening、language-idiomatic refactor、test、docs、local tooling は automated lane に残せます。

## Troubleshooting Decision Tree

1. loop がまだ動いているか？
   - `devloopd status --cwd .` を実行します。
   - process が live なら `devloopd stop --cwd . --reason "<why>"` を使います。
   - metadata が stale なら `devloopd recover-stale --cwd .` を見てから `--apply` します。

2. 同じ理由で待ち続けているか？
   - `devloopd automation-state --cwd .` を実行します。
   - retry/backoff reason と `retryAfter` window を確認します。
   - window 後も同じ理由なら `npm run test:devloopd:soak` を実行し、該当 stage を見ます。

3. provider smoke が失敗したか？
   - `devloopd provider-smoke --cwd .` を実行します。
   - missing CLI/auth を直すか、local readiness では provider gate を optional のままにします。
   - provider token を Issue body、fixture、log に貼りません。

4. GitHub auth が切れたか？
   - `gh auth status` を実行します。
   - `gh auth login` で再認証します。
   - `devloopd ready --cwd . --repo owner/repo` を再実行します。

5. CI repair が止まったか？
   - PR、ledger、CI log を確認します。
   - auth/permission failure は human/operator action です。
   - flaky、infrastructure、timeout classification は bounded backoff で retry できます。

6. PR が merge queue から evict されたか？
   - automation state の conflict file と merge-tree output を見ます。
   - product-policy でない implementation conflict は follow-up worktree で修復できます。
   - product-policy、public contract、security posture conflict は human review です。

7. product-policy replay が失敗しているか？
   - `devloopd product-policy replay --cwd . --json` を実行します。
   - false negative は release/readiness blocker です。
   - fixture relabel や threshold 低下には human review が必要です。

## Personal Readiness Roadmap Closeout

personal-use roadmap は、次の merged PR が `main` にある場合に local single-developer automation として完了です。

| Area | Issue | Merged PR |
| --- | --- | --- |
| Target repository onboarding | #82 | #96 |
| Readiness, lifecycle, and status controls | #83, #84, #87 | #95 |
| Stale-state recovery | #86 | #97 |
| No-wait-loop soak coverage | #88 | #98 |
| Provider smoke matrix | #90 | #99 |
| Personal readiness release gate | #89 | #100 |
| Safe scheduler templates | #85 | #101 |
| Release provenance and update check | #91 | #102 |
| Product-policy replay corpus | #92 | #103 |
| Personal-use operations runbook | #93 | #104 |

#94 は roadmap closeout checkpoint として扱います。tracker 自体は runtime behavior を追加しないため、上記すべてが merge 済みで、`main` 上の `npm run check:personal` が pass し、personal-use readiness slice に未処理 PR / branch が残っていない場合に完了です。

## Update and Rollback

versioned update / rollback は release runbook を使います。

```bash
devloopd release-info
npm run release:personal:check
```

[Personal Release Workflow](./personal-release.ja.md) を参照してください。rollback で変更するのは installed code だけです。`.devloop/`、`.takt/runs/`、provider auth store、ledger は保持します。
