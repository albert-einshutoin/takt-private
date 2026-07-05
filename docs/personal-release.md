# Personal Release Workflow

This is the lightweight release lane for private or personal TAKT automation.
It verifies the local artifact boundary and records provenance without
publishing anything to a public registry.

## Artifact Boundary

A personal release is the npm package artifact built from this repository:

- `dist/` from `npm run build`
- CLI wrappers from `bin/`
- built-in workflows, facets, prompts, and presets from `builtins/`
- docs/runbook snapshot and release notes evidence from `docs/`

Do not include `.devloop/`, `.takt/runs/`, local credentials, provider auth
stores, or generated scheduler snippets in the release artifact.

## Release Checklist

Run the executable checklist before tagging or installing a personal release:

```bash
npm run release:personal:check
```

This runs `npm run check:personal`, `npm pack --dry-run`, and
`devloopd release-info --json`. It does not publish to npm.

For a manual checklist, capture the same evidence:

```bash
npm run check:personal
npm audit --audit-level=high
npm pack --dry-run
devloopd release-info
devloopd release-info --json > .devloop/personal-release-provenance.json
```

Human review is required before using the public `Release v...` PR flow,
changing package distribution, or publishing outside the private repository.

## Release Notes

Use this template in a GitHub Release, private issue comment, or local release
note:

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
- No public publish was performed.
- No `.devloop/` ledger or local credential data is included.
- Rollback preserves `.devloop/` and `.takt/runs/` state.
```

To gather merged PRs since the previous tag:

```bash
gh pr list --state merged --base main --search "merged:>YYYY-MM-DD" --json number,title,url,mergedAt
```

## Installed Version

Use either CLI to inspect the installed build:

```bash
takt release-info
takt release-info --json
devloopd release-info
devloopd release-info --json
```

The report includes package version, commit SHA, metadata source, package root,
dirty state, runtime, and the personal artifact boundary. `TAKT_BUILD_COMMIT`
is preferred when present; otherwise the command falls back to the git commit
for the installed package root.

## Update

For a private Git checkout:

```bash
git fetch origin main --tags
git switch main
git pull --ff-only origin main
npm ci
npm run release:personal:check
npm link
devloopd release-info
```

For a packed local artifact:

```bash
npm pack --dry-run
npm pack
npm install -g ./takt-<version>.tgz
devloopd release-info
```

## Rollback

Rollback should change the installed code, not local automation state. Preserve
`.devloop/`, `.takt/runs/`, provider auth stores, and local ledgers.

For a Git checkout:

```bash
git fetch origin --tags
git switch main
git checkout <known-good-tag-or-commit>
npm ci
npm run release:personal:check
npm link
devloopd release-info
```

For a packed artifact, reinstall the last known good tarball:

```bash
npm install -g ./takt-<known-good-version>.tgz
devloopd release-info
```

If a scheduler is installed, stop it before rollback and start it again only
after `release:personal:check` passes:

```bash
devloopd stop --cwd /path/to/repo --reason "personal release rollback"
devloopd status --cwd /path/to/repo
```
