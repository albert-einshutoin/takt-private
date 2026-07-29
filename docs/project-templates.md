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
space are rejected. NFC/NFD and case-only collisions are also rejected so
validation has the same meaning on every supported file system. `mode` is a
four-digit POSIX mode and `sha256` is a lowercase SHA-256 digest.

`source` is a discriminated union. `github` uses a canonical
`https://github.com/owner/repository` URL without `.git`; `git` uses a
credential-free HTTPS URL; `local` uses `.` or a portable relative POSIX path
(including `.takt/templates/...`) and the literal ref `workspace`. Query strings, fragments, control characters, and
absolute local workstation paths are forbidden. Every source pins an exact
40- or 64-character lowercase hexadecimal commit.

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
`calculateProjectTemplateManifestSha256`, and `validateManifestLockPair`. It
also exports `projectTemplateManifestV1JsonSchema` and
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

Inputs are bounded to 4,096 entries, 512 code points per path/source URI, 256
code points per ref, and three capabilities. Parsers accept only plain,
own-property JSON-style objects and dense arrays; accessors, class instances,
inherited values, sparse arrays, and extended arrays are rejected before entry
processing.

## Compatibility and v2 migration

Clients must reject an unknown schema major. A compatible v1 client may accept
new *minor* behavior only when the schema version remains `1.0` and no unknown
keys are present; v1 deliberately fails closed on unknown keys to avoid silently
discarding security-relevant data.

A future v2 must use `schemaVersion: "2.0"` and ship an explicit migration
command or adapter. The adapter should parse v1 first, write a new v2 manifest
and lock, preserve source commit and every entry digest, then require users to
review the generated apply plan. Do not rewrite a v1 manifest in place or guess
new capabilities from file contents.
