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
    "uri": "github:example/project-template",
    "ref": "v1.2.3",
    "commit": "0123456789abcdef0123456789abcdef01234567"
  },
  "capabilities": ["executable"],
  "entries": [
    {
      "path": ".takt/hooks/prepare.sh",
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

`path` is always a relative POSIX path. Absolute paths, `..`, empty segments,
and Windows separators are rejected so validation has the same meaning on every
client. `mode` is a four-digit POSIX mode and `sha256` is a lowercase SHA-256
digest.

The `source` records the selected ref and immutable commit. A lock file uses
the same `schemaVersion`, `packVersion`, `source`, and a path/mode/digest entry
list; it pins an inspected pack before a later apply operation.

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
`projectTemplateManifestV1JsonSchema` for editor and integration tooling.
Validation errors are `ProjectTemplateValidationError` values with a stable
`code`; callers should branch on the code rather than matching error text.

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
