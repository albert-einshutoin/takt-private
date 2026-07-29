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
are process-local state and are omitted from serialized plans.

`writeTaktpack` reopens every source with `O_NOFOLLOW` and revalidates root
containment, type, inode, link count, size, mode, timestamps, and SHA-256. It
streams to a same-directory `wx` temporary file, fsyncs it, and then publishes
atomically. Non-force publication uses a hard-link no-clobber operation.
Forced publication accepts only an unchanged, regular, single-link target and
keeps the completed old file until the new pack is ready to rename.

`inspectTaktpack` neither extracts files nor invokes an external `tar`. It
validates USTAR blocks sequentially and rejects directories, PAX/GNU extensions,
sparse files, links, devices, FIFOs, unknown names, ordering errors, duplicates,
truncation, trailing data, and independent resource overruns before any write.
The pack index binds the manifest, export report, and each blob's digest and
size. Inspection also validates the manifest/lock seed pair and reruns secret,
absolute-path, binary, and capability classification. Omitting
`currentTaktVersion` yields `status: "unknown"` rather than assuming
compatibility.

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
