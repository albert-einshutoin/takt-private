# ADR 0002: Cross-platform repertoire coordination authority

- Status: Accepted
- Date: 2026-08-01

## Context

TaktDesk instances on different machines must be able to copy a `.takt` tree
and then safely coordinate repertoire reads and mutations on the destination.
Persisting host device/inode evidence would make that tree non-portable. Using
POSIX mode bits or opening directories with `O_RDONLY` on Windows would not
prove Windows ownership, DACL, or reparse-point safety and is not a portable
filesystem contract.

## Decision

The lease protocol consumes validated semantic filesystem operations; it does
not consume raw descriptors, `Stats`, flags, or platform branches. The protocol
continues to own ordering, state transitions, filenames, and public errors.

- POSIX retains descriptor-backed root identity, `0700`/`0600` owner checks,
  no-follow opens, stable snapshots, hard-link no-replace publication, and
  directory fsync.
- Windows accepts only the exact `.takt` directory below the profile captured
  from the OS, rejects non-local/canonical aliases and reparse points, and
  validates every coordination child on the same volume.
- Windows opens no directory descriptor. A canonical, bounded
  `.root.identity` regular file is published from an exclusive staging file by
  hard-link no-replace and retained open for the authority lifetime.
- In-flight sentinel staging is retried within the caller timeout. Stable
  malformed staging fails unsafe; valid staging times out without automatic
  cleanup.
- Windows file contents are fsynced before publication. Node has no portable
  Windows directory-fsync contract, so identity and sentinel evidence are
  re-proved around each atomic link or rename.

Only the random sentinel token persists. Device, inode, timestamps, canonical
paths, and other host evidence remain process-local. Copying `.takt` to another
machine therefore does not copy an authorization decision; the destination
establishes fresh root and file evidence before it uses the data.

## Consequences

The same lease state machine and errors apply on POSIX and Windows, while each
platform keeps its own proof primitives. A dedicated Windows CI lane exercises
the production default root and independent-process writer/read exclusion.
Unfinished or malformed publication is preserved for diagnosis and never
silently reclaimed.
