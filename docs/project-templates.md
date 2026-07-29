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
