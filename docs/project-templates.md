# Project template pack contract (v1)

Project template packs make a `.takt/` setup portable between repositories and
between clients such as TAKT and TaktDesk. Version 1 defines the data contract
only: it can be parsed, inspected, and locked without applying files or running
commands.

## Manifest

Use a JSON manifest with this shape:

```json
{
  "schemaVersion": "1.0",
  "packVersion": "1.2.3",
  "takt": { "minVersion": "0.48.0", "maxVersion": "0.49.0" },
  "source": {
    "kind": "github",
    "uri": "https://github.com/example/project-template",
    "ref": "v1.2.3",
    "commit": "0123456789abcdef0123456789abcdef01234567"
  },
  "capabilities": ["executable"],
  "entries": [
    {
      "path": "hooks/prepare.sh",
      "policy": "managed",
      "mode": "0755",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "capabilities": ["executable"]
    }
  ]
}
```

`managed` replaces a tracked file, `merge` is reserved for a later three-way
merge, `scaffold` creates only absent files, and `excluded` records an
intentionally skipped entry. All entries still carry a digest so preview and
lock data are reproducible.

`path` is relative to the `.takt/` root. For example, `.takt/hooks/prepare.sh`
is represented as `hooks/prepare.sh`; a `.takt/` prefix is rejected. Absolute
paths, `..`, empty segments, Windows separators and reserved device names,
alternate data stream (`:`) syntax, control characters, and trailing dot or
space are rejected. Version 1 limits every path segment to ASCII letters,
digits, `.`, `_`, and `-` for deterministic behavior across file systems.
Unicode remains fully supported inside file content; only portable path names
are restricted. NFC validation and NFKC plus locale-aware lowercase collision
keys remain as defense in depth. Windows `CONIN$` and `CONOUT$` are reserved as
well. Each segment is limited to 255 ASCII characters while the full path keeps
its 512-character limit. These rules keep validation consistent on every
supported file system.
`mode` is a four-digit POSIX mode and `sha256` is a lowercase SHA-256 digest.

`source` is a discriminated union. `github` uses a canonical
`https://github.com/owner/repository` URL without `.git`; `git` uses a
credential-free HTTPS URL; `local` uses `.` or a portable ASCII relative POSIX path
(including `.takt/templates/...`) and the literal ref `workspace`. Query
strings, fragments, control characters, and absolute local workstation paths
are forbidden. Every source pins an exact 40- or 64-character lowercase
hexadecimal commit.
Git and GitHub URLs are also parsed with the WHATWG URL implementation and must
round-trip to the exact input. User information, query, fragment, dot segments,
encoded slash/backslash, default-port and host-case aliases, and other
non-canonical forms are rejected. GitHub owner/repository `.` and `..` aliases
are invalid.

`source.ref` follows the portable subset of `git check-ref-format`. `HEAD` and
ordinary refs such as `feature/review-152` are valid. The parser rejects `..`,
segments beginning with `.`, a trailing `.`, segments ending in `.lock`, `@{`,
backslash, controls, spaces, and Git-invalid `~ ^ : ? * [` characters. The
existing 256-character total limit remains in force.

A lock keeps `packVersion`, `source`, top-level capabilities, and each entry's
path, policy, mode, digest, and capabilities. It additionally stores
`manifestSha256`, calculated from the canonical parsed manifest. This prevents a
lock from being reused with a different pack or with changed apply semantics.

## Capabilities

Packs are declarative. An entry capability must be declared both by the entry
and by top-level `capabilities`. Executable mode bits additionally require the
`executable` capability. The available capability names are `executable`,
`github-write`, and `external-command`.

This double declaration exists so a UI can show a pack's complete privilege
request before users choose to apply it. Parsing never runs these capabilities.

## API and schema

The public API exports `parseProjectTemplateManifest`,
`serializeProjectTemplateManifest`, `parseTemplateLock`, and
`serializeTemplateLock`. It also exports
`calculateProjectTemplateManifestSha256`, `validateManifestLockPair`, and
`validateDetectedTemplateCapabilities`, plus
`projectTemplateManifestV1JsonSchema` and
`projectTemplateLockV1JsonSchema` for editor and integration tooling. Both
schemas use JSON Schema draft-07 so they work with the repository's Ajv 6
runtime.
Validation errors are `ProjectTemplateValidationError` values with a stable
`code` and `field`; callers should branch on the code rather than matching error
text.

Package consumers must import these documented APIs from the `takt` package
root. Internal `dist/**` modules are intentionally not exported because a deep
import can bypass review and storage trust boundaries. The `exports` boundary
does not change the `takt`, `takt-dev`, `takt-cli`, or `devloopd` commands, but
it is intentionally semver-visible for consumers that relied on unsupported
deep imports.

The schemas cover structural and single-field constraints. Rules that compare
multiple values remain runtime-only: minimum/maximum TAKT ordering, duplicate,
case and Unicode-normalization path collisions, executable/top-level capability
relationships, policy conflicts, plain-object checks, and manifest/lock
binding. Consumers must call the parsers and `validateManifestLockPair` even
after JSON Schema validation.

Classifiers and archive inspectors pass `{ path, capabilities }` evidence to
`validateDetectedTemplateCapabilities`. Every detected capability must be
declared by both the matching entry and the manifest, and an unknown path is
rejected. An omitted entry or an inspection that was never run is **not**
evidence that the entry is trusted; callers must track inspection completeness
and refuse apply when their policy requires evidence that is missing.

WHATWG URL round-trip checks, the ASCII path boundary, NFC enforcement, conservative NFKC collision
keys, and capability detection completeness are runtime-only. The draft-07
schemas remain suitable for editor feedback, but they do not replace runtime
validation.

Inputs are bounded to 4,096 entries, 512 ASCII characters per path/source URI,
255 characters per path segment, 256 code points per ref, and three
capabilities. Parsers accept only plain,
own-property JSON-style objects and dense arrays; accessors, class instances,
inherited values, sparse arrays, and extended arrays are rejected before entry
processing.

## Classifying a local project

`scanProjectTemplateDirectory(projectRoot)` inspects `projectRoot/.takt` and
returns a redacted preview. Paths in `entries` are relative to `.takt`; a
sibling `.devloop` directory is represented only by the fixed `.devloop`
excluded sentinel and is never traversed. `classifyProjectTemplateEntry` is the
side-effect-free core for integrations that already hold bounded content.

Only shared `workflows/`, `facets/`, and `provider-options/` entries are
portable candidates. Project configuration, automation, and quality gates are
`project-owned` and require an explicit policy review. Unknown paths are
excluded by default. Runtime state, logs, caches, and sensitive filenames are
never read as candidate content. This includes generated roots such as
`sessions/`, `worktree-sessions/`, `clone-meta/`, `findings/`,
`language-cache/`, `runs/`, and `worktrees/`, plus generated files such as
`input_history`, `persona_sessions.json`, `session-state.json`, `tasks.yaml`,
and `staged-devloop-state.json`. Runtime
directories are represented by their verified relative root only and are not
traversed. The scanner blocks secrets, workstation
absolute paths (POSIX, home-relative, drive-letter, and UNC forms), binary
content, symlinks, hard links, special files, path
escapes, portable-name collisions, and independently bounded resource
overruns.

The classifier reuses the manifest's `parsePortablePath` validator. Invalid or
sensitive input names are reported as fixed redacted sentinels instead of
echoing the source name. Its public input is also bounded: content is at most
1 MiB, byte counts must be exact safe integers, mode and digest use the manifest
formats, and trusted absolute-path hints have independent count and length
limits. The core computes SHA-256 whenever content is supplied and rejects a
different caller-supplied digest. Metadata-only calls never return a supplied
digest as evidence and report incomplete inspection.

`scanStatus` distinguishes `complete`, `incomplete`, and `blocked` scans.
`canExport` is true only for a complete scan without blocked or project-owned
entries; `reviewRequired` identifies the project-owned case. Each file preview
contains bytes, mode, SHA-256, a stable reason code, a redacted summary,
suggested policy, warnings, and capability evidence suitable for
`validateDetectedTemplateCapabilities`.
Capability evidence includes `inspectionStatus`. An empty capability list is
authoritative only with `complete`; skipped metadata is `incomplete` and blocked
inspection is `blocked`. Detected executable, GitHub-write, external, or
ambiguous command behavior sets `reviewRequired`.
All `gh` commands and `curl` calls to the GitHub API are conservatively reported
as both GitHub-write and external-command capabilities. An unknown command
leaves inspection incomplete and requires review, including command keys inside
YAML block sequences such as `- run:`. YAML capability inspection walks the
bounded syntax tree without expanding aliases. Parse errors, duplicate keys,
multiple documents, aliases, non-scalar execution values, and inspection
depth/node overruns remain incomplete and review-required.

`README.md`, `automation/**`, and `quality-gates/**` are project-owned
`scaffold` candidates: they are created only when missing and never replace a
local file. `quality-gates/logs/**` remains excluded runtime state. A scaffolded
shared wrapper must delegate to the project-local gate and must not turn a
missing or failing gate into success through a weaker fallback.

## Three-way merging config YAML

Merge entries for `config.yaml` and `devloopd.yaml` use the base referenced by
the formal lock, the current local file, and the incoming template.
Provider routing, allowed and forbidden providers, the base branch, and
workflow command gates are project-owned. Safe defaults such as language are
template-managed, logging and CLI paths are global-only, and credential paths
such as API keys, tokens, and passwords are forbidden. Splitting a credential
name across mappings, for example `api.key`, does not bypass that rule.

Mappings merge at leaf granularity. Different local and incoming changes to the
same leaf produce a conflict with its exact path. Every known sequence declares
an `atomic`, `unordered-set`, non-removing `monotonic-set`, or `ordered-keyed`
policy; unknown sequences are never concatenated implicitly. Quality-gate
identity is shared with runtime deduplication, so omitted default timeouts do
not create duplicate commands.

The local YAML document is the edit source. Unchanged nodes, mapping order,
local comments, sequence-item presentation, BOM, a uniform line-ending style,
and final-newline state are retained. Semantic no-ops return the exact local
bytes. Aliases, anchors, merge keys, custom tags, multiple documents,
directives, and edits to mixed-EOL input fail closed. Unknown keys are retained
rather than silently deleted, then passed through the same project schema
validator and reported with a path when unsupported. The apply plan seals the
merged digest and diagnostics; the executor re-derives them from the stored
base and rejects mismatched resolved bytes.

Directory enumeration uses a bounded `opendir` stream and stops after
`maxNodes + 1`, so a directory with an attacker-controlled number of children
cannot be materialized in memory. Reaching that global witness stops all
remaining recursion and siblings. A name that fails inode/realpath verification
is represented only as `[unverified-entry]`; raw enumerated names are not
returned as error evidence. Directories are checked by type, device,
inode, link count, timestamps, and realpath before and after enumeration.
The scanner uses open-file stat snapshots to detect changes during inspection,
but a successful snapshot is neither permanent proof nor proof of the later
archive bytes. Issue #138 archive creation and apply must reopen and revalidate
type, containment, link count, size, mode, digest, and capability evidence
before trusting the bytes.

## `.taktpack` export and inspection

`.taktpack` v1 is an uncompressed, content-addressed USTAR archive. Its entry
order is fixed: `pack.json`, `manifest.json`, `export-report.json`, then
`blobs/sha256/<SHA-256>` sorted by digest. Destination paths exist only in the
manifest. Fixed uid, gid, mtime, and mode metadata plus canonical JSON make the
same input byte-for-byte deterministic.

`createProjectTemplateExportPlan` fails closed for blocked or incomplete scans,
unapproved capabilities, and project-owned entries without an explicit policy.
Runtime and sensitive paths are not opened just to hash them; only redacted
reason counts enter the export report. Absolute source paths and inode snapshots
are process-local state and are omitted from serialized plans. The returned plan
is deeply read-only/frozen and bound to a process-local canonical seal; the
writer rebuilds control documents from the sealed snapshot and rejects copied
or mutated plans before creating a temporary file. Report `warnings` is an
empty closed field in v1. `excludedReasons` accepts classifier reason codes
only, with bounded counts whose sum must equal `counts.excluded`.

`writeTaktpack` reopens every source with `O_NOFOLLOW` and revalidates root
containment, type, inode, link count, size, mode, timestamps, and SHA-256. It
checks every source path even when several paths share one digest, and streams
only one blob after all duplicate sources pass verification. It
streams to a same-directory `wx` temporary file, fsyncs it, and then publishes
atomically. Non-force publication uses a hard-link no-clobber operation.
Forced publication accepts only an unchanged, regular, single-link target and
keeps the completed old file until the new pack is ready to rename. Windows
records directory fsync as unsupported after the completed file is fsynced,
instead of reporting a successfully published artifact as failed.

All writer and inspector filesystem failures are normalized to stable,
path-redacted `TaktpackError` codes. The writer attaches a pipeline rejection
handler immediately, before awaiting archive entries. `ARCHIVE_WRITE_FAILED`,
`ARCHIVE_READ_FAILED`, `DURABILITY_FAILED`, and `CLEANUP_FAILED` never include
raw source or temporary paths. Writer I/O errors include `artifactState`:
`not-published` means no destination was published, while `published` on a
durability error means the complete artifact exists but directory durability
could not be confirmed. A cleanup failure never replaces the primary failure.

`inspectTaktpack` neither extracts files nor invokes an external `tar`. It
validates USTAR blocks sequentially and rejects directories, PAX/GNU extensions,
sparse files, links, devices, FIFOs, unknown names, ordering errors, duplicates,
truncation, trailing data, and independent resource overruns before any write.
The pack index binds the manifest, export report, and each blob's digest and
size. Inspection also validates the manifest/lock seed pair and reruns secret,
absolute-path, binary, and capability classification. Omitting
`currentTaktVersion` yields `status: "unknown"` rather than assuming
compatibility. Inspection returns a structurally distinct
`{ kind: "project-template-lock-seed", ... }` value, not an approved
`TemplateLockV1`; approval and formal lock creation remain a later apply step.

## Apply-preview review surface

The public apply-preview runtime surface is intentionally limited to
`renderProjectTemplateApplyPreviewHuman` and
`renderProjectTemplateApplyPreviewJson`. Its public types are
`ProjectTemplateApplyPreview`, `ProjectTemplateApplyPreviewBindings`,
`ProjectTemplateApplyPreviewCompositionConflictCode`,
`ProjectTemplateApplyPreviewContentHardConflict`, and
`ProjectTemplateApplyPreviewApprovalEvidence`. Preview composition, seal
assertion and hashing, trusted approval issue/consume/revoke operations, raw
G2/G3/G4 composition surfaces, and approval storage remain private.

A preview is a sealed process-local value. A clone or deserialized lookalike is
not accepted by either renderer. Both renderers omit precondition tokens; their
human or JSON output is a review display, not authority. Approval evidence is
also process-local and opaque. A durable approval record alone is audit state,
not authority, and copying or reconstructing the evidence object does not grant
authority.

Private approvals expire after five minutes, are single-use, and may be
irreversibly revoked before use. A hard-conflicted preview cannot be approved.
A legacy content-only approval authorizes neither the repertoire-dependency
plan nor its companion lock. The H integration that will deliver trusted
previews and confirmation to public clients is not complete; there is currently
no public approval issuance or consumption route, and consumers must not rely
on internal deep imports.

## Atomic apply and rollback boundary

Only a sealed, conflict-free apply plan may enter the mutation boundary.
The plan seal is an integrity checksum for preview transport, not an authority
to mutate. Before apply, the executor re-derives the complete canonical plan
from an independent archive-inspection receipt, the parsed current formal lock,
a fresh target snapshot, the incoming manifest, its verified contents, and an
independent baseline-adoption decision.
Re-sealing a modified action, digest, mode, capability, entry set, or global
decision therefore fails before target mutation.
Before downloading or writing content, apply inspects active and stale runs,
malformed run evidence, personal daemon state, stop requests, and persistent
automation. Unknown evidence blocks the operation. Run and daemon startup use
the same short coordination mutex as apply, so a new runner cannot start in
the gap between preflight and lease acquisition. A task run holds that mutex
while it reads project-owned workflow, provider, and runtime configuration and
until its `running` metadata is durably published. Worktree runs publish the
normal metadata in the worktree and a collision-resistant coordination mirror
under the main project root. The mirror remains fail-closed if either initial
or terminal publication fails, so apply cannot miss an active worktree run or
race a run that loaded an older template generation.

Every template-dependent execution entry point publishes a durable preparation
record before it reads project configuration or mutates runtime task state.
This includes queued and resumed tasks, direct selection, pipelines, run-all
dispatch, and the watch lifecycle. The record blocks apply while TAKT resolves
retry state, creates or copies a workspace, stages attachments, claims another
task, or waits for watched work. Consequently, an active watch intentionally
blocks template apply even while it is idle; stop the watcher before applying
a pack.

The record is written through an owner-only same-directory temporary file,
file-fsynced, renamed, and followed by parent-directory fsync on POSIX. After
the canonical run metadata and any coordination mirror are durable, TAKT
terminalizes the preparation record, so there is no unprotected hand-off gap.
Terminal preparation records remain in ordinary run history for audit and use
the same retention policy as other runs. If preparation stops unexpectedly,
its running record becomes stale and requires the existing explicit recovery
flow; TAKT does not expire it by time alone or guess that a long copy is
abandoned.

Remote GitHub previews reopen a signed receipt by `receiptKey` and work
offline: the receipt HMAC, cache path identity, archive digest, canonical USTAR
layout, manifest, and dependency-ref verification evidence are checked again.
Only manifest-addressed blobs are retained in bounded memory. Receipt file
authority is consumed before target or installed-repertoire inspection, and a
preview carries no cache path, credential, receipt key, timestamp, or apply
authority. Apply must therefore perform a fresh receipt/cache read.

Portable installs commit three companion locks as one cohort:
`.takt-template-lock.json`, `.takt-template-repertoire-lock.json`, and
`.takt-template-source-lock.json`. Preview accepts only all-absent first install
or all-present update state. Mixed, noncanonical, unreadable, symlinked,
hardlinked, or special-file state is blocked. The source lock records canonical
repository/ref/tag/commit, archive/manifest/descriptor hashes, version, and
dependency-verification digest only. Repository changes, version downgrades,
and a tag resolving to a different commit are hard conflicts. One
domain-separated `transactionPlanId` binds the content, dependency, and source
plans; current and next three-lock hashes; target preconditions; baseline
strategy; and authenticated receipt provenance. Approval explicitly binds both
`previewId` and `transactionPlanId` and remains TTL-limited and single-use.

Apply stages and validates every output before changing `.takt/`. The formal
content lock is stored at `.takt-template-lock.json`. Private staging, journal, and
bounded backup generations live under `.takt-template-state/`, which must be
ignored by Git and is created with owner-only permissions. Every control root
contains a private `*` `.gitignore`, preventing backup data from entering
`git add -A` in arbitrary target repositories. The ignore file is durably
created and verified before any run-start mutex, apply lease, or recovery
marker is published. Newly created private staging, backup, and blob
directories are followed by parent-directory fsync on POSIX before their
contents are trusted. Backups contain only affected template entries and the
formal lock; runtime state and excluded content are never collected. The
backup manifest records each original hash,
mode, and timestamp for audit. It also records target parent directories that
were absent before the transaction. Compensation, recovery, and operator
rollback remove those parents deepest-first only while they remain empty;
pre-existing or subsequently populated directories are preserved. Because
replacement necessarily changes the filesystem timestamp, restore conformance
is defined by hash, mode, absence, and the doctor result.

The filesystem cannot atomically rename multiple independent files. The v1
contract therefore uses a durable journal, deterministic per-file replacement,
and compensation rollback under one exclusive lease. Every write, chmod,
rename, file fsync, and directory fsync failure is treated as a transaction
failure. Post-apply config/workflow doctor failure also restores the original
tree. The doctor gates only adoption of the new template. Compensation,
operator rollback, and recovery complete when the recorded historical
hash/mode/absence witnesses are restored; a historical snapshot is not
required to pass the current validator. Operator rollback first verifies every
expected post-apply hash, mode,
and absence marker; any drift stops rollback before its first mutation.
If the process stops before it can publish an explicit recovery marker, a
non-terminal durable journal still blocks later downloads, writes, and run
startup. `recoverProjectTemplateApply` converges the journal and backup
manifest to either committed or rolled-back state, and clears an
identity-owned recovery marker only after verification succeeds.
Preparation failures remove their owned staging and incomplete backup roots.
If cleanup itself is interrupted, the next exclusive apply lease performs a
bounded orphan sweep before any target mutation; generations with a valid
manifest are preserved and malformed evidence fails closed.
Coordination files left by a crash are reclaimed only when their recorded
owner PID is definitely dead; live, malformed, or indeterminate ownership
remains blocked. The v1 threat boundary covers cooperating TAKT/devloopd
writers that honor the shared lease. Node does not expose directory-fd-relative
rename, so a hostile process under the same OS user racing a parent-directory
replacement between the final witness and rename is outside that boundary.
Windows does not provide directory fsync, so directory durability after
file-level fsync is best-effort on that platform. Node exposes only a subset of
POSIX chmod semantics on Windows; apply therefore uses content and byte length
as its transaction witness there and treats the manifest mode as advisory.
POSIX platforms continue to require exact mode restoration.

Entry-kind ceilings are independent and callers may only tighten them:
`pack.json` and `manifest.json` are at most 4 MiB, `export-report.json` and each
blob are at most 1 MiB, with separate entry-count, total-payload, and archive
budgets. USTAR octal, checksum, uname/gname, device, prefix, and reserved bytes
must match the canonical v1 encoding exactly.

The writer pins `tar-stream` 3.1.7 as a direct dependency, while the security
boundary reader uses its own bounded USTAR parser. Version 3.2.0 added a
`bare-fs` dependency that the writer does not need; the pin avoids expanding
the supply-chain surface and optional non-Node runtime paths.

## Compatibility and v2 migration

Clients must reject an unknown schema major. A compatible v1 client may accept
new *minor* behavior only when the schema version remains `1.0` and no unknown
keys are present; v1 deliberately fails closed on unknown keys to avoid silently
discarding security-relevant data.
Missing, non-string, or malformed schema versions use the document-specific
`INVALID_MANIFEST` or `INVALID_LOCK` code. An unknown major uses
`UNSUPPORTED_SCHEMA_MAJOR`; a well-formed but unsupported v1 minor such as
`1.1` uses `UNSUPPORTED_SCHEMA_VERSION`.

A future v2 must use `schemaVersion: "2.0"` and ship an explicit migration
command or adapter. The adapter should parse v1 first, write a new v2 manifest
and lock, preserve source commit and every entry digest, then require users to
review the generated apply plan. Do not rewrite a v1 manifest in place or guess
new capabilities from file contents.
