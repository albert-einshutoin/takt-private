# Personal Release Workflow

これは private / personal な TAKT automation のための軽量 release lane です。
public registry へ publish せず、local artifact boundary と provenance を確認します。

## Artifact Boundary

personal release は、この repository から build された npm package artifact です。

- `npm run build` で生成された `dist/`
- `bin/` の CLI wrapper
- `builtins/` の built-in workflow、facet、prompt、preset
- `docs/` の runbook snapshot と release notes evidence

`.devloop/`、`.takt/runs/`、local credential、provider auth store、生成済み scheduler
snippet は release artifact に含めません。

## Release Checklist

tag 付けや personal install の前に、実行可能な checklist を走らせます。

```bash
npm run release:personal:check
```

これは `npm run check:personal`、`npm pack --dry-run`、
`devloopd release-info --json` を実行します。npm への publish は行いません。

手動で確認する場合も、同じ evidence を残します。

```bash
npm run check:personal
npm audit --audit-level=high
npm pack --dry-run
devloopd release-info
devloopd release-info --json > .devloop/personal-release-provenance.json
```

public な `Release v...` PR flow を使う場合、package distribution を変える場合、
private repository 外へ publish する場合は human review が必要です。

## Release Notes

GitHub Release、private issue comment、local release note では次の template を使います。

```markdown
## Personal Release vX.Y.Z

Commit: <commit-sha>
Package: takt@<version>

### Changes
- PR #<number>: <title> (closes #<issue>)

### Verification
- npm run check:personal
- npm audit --audit-level=high
- npm pack --dry-run
- devloopd release-info --json

### Safety Notes
- public publish は行っていません。
- `.devloop/` ledger や local credential data は含めていません。
- rollback では `.devloop/` と `.takt/runs/` の state を保持します。
```

前回 tag 以降に merge された PR を集めるには次を使います。

```bash
gh pr list --state merged --base main --search "merged:>YYYY-MM-DD" --json number,title,url,mergedAt
```

## Installed Version

installed build はどちらの CLI からでも確認できます。

```bash
takt release-info
takt release-info --json
devloopd release-info
devloopd release-info --json
```

report には package version、commit SHA、metadata source、package root、dirty state、
runtime、personal artifact boundary が含まれます。`TAKT_BUILD_COMMIT` がある場合は
それを優先し、なければ installed package root の git commit に fallback します。

## Update

private Git checkout の場合:

```bash
git fetch origin main --tags
git switch main
git pull --ff-only origin main
npm ci
npm run release:personal:check
npm link
devloopd release-info
```

local package artifact の場合:

```bash
npm pack --dry-run
npm pack
npm install -g ./takt-<version>.tgz
devloopd release-info
```

## Rollback

rollback で変えるのは installed code だけです。`.devloop/`、`.takt/runs/`、provider
auth store、local ledger は保持してください。

Git checkout の場合:

```bash
git fetch origin --tags
git switch main
git checkout <known-good-tag-or-commit>
npm ci
npm run release:personal:check
npm link
devloopd release-info
```

packed artifact の場合は、最後に安全確認済みの tarball を再 install します。

```bash
npm install -g ./takt-<known-good-version>.tgz
devloopd release-info
```

scheduler を install 済みの場合、rollback 前に停止し、`release:personal:check` が通ってから
再開します。

```bash
devloopd stop --cwd /path/to/repo --reason "personal release rollback"
devloopd status --cwd /path/to/repo
```
